import test from 'node:test'
import assert from 'node:assert/strict'

import { createCoordinator } from '../src/coordinator.mjs'
import { createStateStore } from '../src/state-store.mjs'
import { createTitleIndicator } from '../src/title-indicator.mjs'
import { sendKeepalive } from '../src/guarded-send.mjs'
import { createDashboardModel } from '../src/dashboard-model.mjs'
import { TIMING } from '../src/contracts.mjs'
import * as scheduler from '../src/scheduler.mjs'

const DEFAULT_MESSAGE =
  'Cache keepalive. Reply only OK; do not use tools or continue previous work.'
const TTL_5M = 300000
const MARGIN_5M = 60000

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/**
 * 수동으로 시간을 진행하는 fake clock. setTimeout/clearTimeout/monoNow/sleep과
 * advance/jumpWall/jumpMono를 제공한다.
 * @param {{start?:number}} [options]
 */
function createFakeClock({ start = 1_000_000 } = {}) {
  let wall = start
  let mono = start
  let seq = 0
  const timers = new Map()

  const flush = () => new Promise((resolve) => setImmediate(resolve))

  const clock = {
    now: () => wall,
    monoNow: () => mono,
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { at: wall + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async sleep(ms) {
      wall += ms
      mono += ms
    },
    async settle(times = 1) {
      for (let i = 0; i < times; i += 1) {
        await flush()
      }
    },
    jumpWall(ms) {
      wall += ms
    },
    jumpMono(ms) {
      mono += ms
    },
    /**
     * target 시각까지 timer를 순서대로 실행한다. 각 timer 뒤 microtask를 비운다.
     * @param {number} ms
     */
    async advance(ms) {
      const target = wall + ms
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at
            nextId = id
          }
        }
        if (nextId === null) {
          break
        }
        const timer = timers.get(nextId)
        timers.delete(nextId)
        if (timer.at > wall) {
          const delta = timer.at - wall
          wall += delta
          mono += delta
        }
        timer.fn()
        await flush()
      }
      if (target > wall) {
        const delta = target - wall
        wall += delta
        mono += delta
      }
      await flush()
    },
    pendingCount: () => timers.size,
  }
  return clock
}

function createHostCall() {
  const storage = new Map()
  const calls = []
  async function hostCall(method, params = {}) {
    calls.push({ method, params })
    if (method === 'storage.get') {
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined }
    }
    if (method === 'storage.set') {
      storage.set(params.key, structuredClone(params.value))
      return { ok: true }
    }
    if (method === 'workspace.readContext') {
      return { terminals: [] }
    }
    throw new Error(`unhosted ${method}`)
  }
  hostCall.calls = calls
  hostCall.storage = storage
  hostCall.count = (method) => calls.filter((call) => call.method === method).length
  return hostCall
}

function makeBinding(overrides = {}) {
  return {
    userDataPath: '/tmp/orca',
    userDataKey: 'key-p',
    runtimeId: 'rt1',
    pid: 123,
    startedAt: 1,
    endpoint: '/tmp/sock',
    transportKind: 'unix',
    authToken: 'tok',
    ...overrides,
  }
}

function makeRow(overrides = {}) {
  return {
    handle: 'h1',
    worktreeId: 'w1',
    tabId: 'tab',
    leafId: 'leaf',
    paneKey: 'tab:leaf',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    title: 'Terminal 1',
    branch: 'main',
    branchName: 'main',
    projectName: null,
    connected: true,
    writable: true,
    lastOutputAt: 0,
    agentIdentity: 'claude',
    executionHostId: 'local',
    supported: true,
    unsupportedReason: null,
    ...overrides,
  }
}

function createObserverFake({ rows = [makeRow()], repoNames, onListRepoNames } = {}) {
  const state = {
    rows: rows.slice(),
    complete: true,
    onList: null,
    currentWorktree: null,
    repoNames,
    onListRepoNames: onListRepoNames ?? null,
  }
  const listCalls = []
  const repoNamesCalls = []
  const adapter = {
    state,
    listCalls,
    repoNamesCalls,
    async list() {
      listCalls.push({ rows: state.rows.slice() })
      if (typeof state.onList === 'function') {
        const result = await state.onList(listCalls.length, state)
        if (result) {
          return result
        }
      }
      return { complete: state.complete, fetchedAt: 0, terminals: state.rows.slice() }
    },
    resolveEvent(event, catalog) {
      const payload =
        event && typeof event === 'object' && event.payload ? event.payload : event
      if (!payload || typeof payload !== 'object') {
        return null
      }
      const matches = (catalog?.terminals ?? []).filter(
        (row) => row.worktreeId === payload.worktreeId && row.paneKey === payload.paneKey,
      )
      if (matches.length !== 1) {
        return null
      }
      const row = matches[0]
      return {
        worktreeId: row.worktreeId,
        paneKey: row.paneKey,
        handle: row.handle,
        ptyId: row.ptyId,
        incarnationId: row.incarnationId,
      }
    },
    async inspect() {
      return {
        stale: false,
        identity: 'claude',
        executionHostId: 'local',
        connected: true,
        writable: true,
        agentStatus: 'idle',
        isRunningAgent: true,
        agentWait: 'none',
        screen: 'ok',
        screenTruncated: false,
        draft: null,
        lastOutputAt: 0,
      }
    },
    async currentWorktree() {
      return state.currentWorktree
    },
  }
  // listRepoNames를 요청한 경우에만 메서드를 노출한다(미제공 시 coordinator가 건너뜀).
  if (repoNames !== undefined || onListRepoNames !== undefined) {
    adapter.listRepoNames = async (options) => {
      repoNamesCalls.push({ options })
      if (typeof state.onListRepoNames === 'function') {
        return state.onListRepoNames(repoNamesCalls.length, state)
      }
      return state.repoNames
    }
  }
  return adapter
}

/**
 * 호출을 기록만 하는 가짜 탭 제목 표시기. 각 메서드는 override로 동작을 바꿀 수 있다.
 * @param {{onLoad?:Function, onReconcile?:Function, onTurnCompleted?:Function, onRestoreAll?:Function}} [overrides]
 */
function createFakeTitleIndicator(overrides = {}) {
  const calls = { load: 0, reconcile: [], reconcileOptions: [], onTurnCompleted: [], restoreAll: 0 }
  return {
    calls,
    async load() {
      calls.load += 1
      if (typeof overrides.onLoad === 'function') {
        await overrides.onLoad()
      }
    },
    reconcile(desired, options) {
      calls.reconcile.push(desired)
      calls.reconcileOptions.push(options)
      if (typeof overrides.onReconcile === 'function') {
        return overrides.onReconcile(desired, options)
      }
      return undefined
    },
    async onTurnCompleted(tabKey) {
      calls.onTurnCompleted.push(tabKey)
      if (typeof overrides.onTurnCompleted === 'function') {
        await overrides.onTurnCompleted(tabKey)
      }
    },
    async restoreAll() {
      calls.restoreAll += 1
      if (typeof overrides.onRestoreAll === 'function') {
        await overrides.onRestoreAll()
      }
    },
    snapshot() {
      return { tabs: 0, disabledTabs: 0 }
    },
  }
}

function createTitleIndicatorRpc(rows) {
  const originalTitles = new Map(rows.map((row) => [row.handle, row.title]))
  const titles = new Map(originalTitles)
  const renames = []
  return {
    titles,
    renames,
    rpc: {
      async call(method, params) {
        if (method === 'session.tabs.list') {
          const worktreeId = params.worktree.slice('id:'.length)
          return {
            tabs: rows
              .filter((row) => row.worktreeId === worktreeId)
              .map((row) => ({
                type: 'terminal',
                parentTabId: row.tabId,
                leafId: row.leafId,
                title: titles.get(row.handle),
              })),
          }
        }
        if (method === 'terminal.rename') {
          renames.push({ ...params })
          titles.set(params.terminal, params.title === null ? originalTitles.get(params.terminal) : params.title)
          return {}
        }
        throw new Error('unexpected RPC method')
      },
    },
  }
}

/**
 * coordinator의 epoch 메모리 계약(load/get/remember/forget/prune/flush)을 구현한
 * 메모리 fake. 두 coordinator 인스턴스가 같은 객체를 공유해 렐로드를 재현할 수 있다.
 * @param {Map<string, object>} [initial]
 */
function createFakeEpochMemory(initial = new Map()) {
  const store = new Map(initial)
  const calls = { load: 0, get: [], remember: [], forget: [], prune: [], flush: 0 }
  return {
    store,
    calls,
    async load() {
      calls.load += 1
    },
    get(key) {
      calls.get.push(key)
      const record = store.get(key)
      return record === undefined ? null : { ...record }
    },
    remember(key, record) {
      calls.remember.push({ key, record: { ...record } })
      store.set(key, { ...record, savedAt: 1 })
    },
    forget(key) {
      calls.forget.push(key)
      store.delete(key)
    },
    prune(maxAgeMs) {
      calls.prune.push(maxAgeMs)
    },
    async flush() {
      calls.flush += 1
    },
  }
}

function createHarness(options = {}) {
  const clock = options.clock ?? createFakeClock()
  const hostCall = options.hostCall ?? createHostCall()
  const bindingBox = { value: options.binding ?? makeBinding() }
  const bindingErrorBox = { value: options.bindingError ?? null }
  const settingsBox = {
    value: options.settings ?? {
      known: true,
      profileId: 'p1',
      enabled: true,
      ttlMs: TTL_5M,
      revision: 1,
      source: 'sqlite',
      readAt: 0,
    },
  }

  let attemptCounter = 0
  const rawStore = options.store
    ? options.store
    : createStateStore({
        hostCall,
        now: () => clock.now(),
        randomId: () => `att-${(attemptCounter += 1)}`,
      })

  const spy = { resetBudget: [], confirmAttempt: [], markReview: [], flush: [] }
  const store = Object.assign({}, rawStore, {
    resetBudget: async (scope, opts) => {
      spy.resetBudget.push(scope)
      return rawStore.resetBudget(scope, opts)
    },
    confirmAttempt: async (attemptId, opts) => {
      spy.confirmAttempt.push(attemptId)
      return rawStore.confirmAttempt(attemptId, opts)
    },
    markReview: async (attemptIdOrScope, reason, opts) => {
      spy.markReview.push(attemptIdOrScope)
      return rawStore.markReview(attemptIdOrScope, reason, opts)
    },
  })
  if (typeof rawStore.flush === 'function') {
    store.flush = async (...args) => {
      spy.flush.push(args)
      return rawStore.flush(...args)
    }
  }

  const resolveCalls = []
  async function resolveBinding(override) {
    resolveCalls.push(override)
    if (bindingErrorBox.value) {
      throw bindingErrorBox.value
    }
    return bindingBox.value
  }

  let getBindingRef = null
  let rpcClosed = false
  const rpc =
    options.rpc ??
    {
      async call() {
        return { terminals: [], truncated: false }
      },
      close() {
        rpcClosed = true
      },
    }
  function createRpc({ getBinding }) {
    getBindingRef = getBinding
    return rpc
  }

  const observer = options.observer ?? createObserverFake({ rows: options.terminals ?? [makeRow()] })

  /** @type {object[]} */
  const titleIndicators = []
  const createTitleIndicatorFactory =
    options.createTitleIndicator ??
    (() => {
      const indicator = options.titleIndicator ?? createFakeTitleIndicator()
      titleIndicators.push(indicator)
      return indicator
    })

  const readSettingsCalls = []
  async function readSettings({ userDataPath }) {
    readSettingsCalls.push(userDataPath)
    return settingsBox.value
  }

  const sendCalls = []
  let sendBehavior = options.sendBehavior ?? null
  async function defaultSendBehavior(args) {
    const gate = await args.assertAllowed()
    if (!gate || gate.allowed !== true) {
      return {
        kind: 'skipped',
        reason: gate?.reason ?? 'SETTINGS_UNKNOWN',
        attemptId: null,
        at: clock.now(),
        framesSent: 0,
      }
    }
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, clock.now())
    args.onPhase?.('reserved', { attemptId, at: clock.now() })
    await args.journal.recordAttempt(attemptId, 'pasted')
    args.onPhase?.('pasted', { attemptId })
    await args.journal.recordAttempt(attemptId, 'submitted')
    const at = clock.now()
    args.onPhase?.('submitted', { attemptId, at })
    return { kind: 'submitted', reason: null, attemptId, at, framesSent: 2 }
  }
  async function sendKeepalive(args) {
    sendCalls.push(args)
    if (typeof sendBehavior === 'function') {
      return sendBehavior(args, sendCalls.length - 1)
    }
    return defaultSendBehavior(args)
  }

  const cwarmCalls = []
  async function cwarmDisabled() {
    cwarmCalls.push(true)
    const value = options.cwarmDisabled
    return typeof value === 'function' ? value() : value === true
  }

  const diagEvents = []
  const diagnostics = {
    record(entry) {
      diagEvents.push(entry)
    },
    snapshot() {
      return diagEvents.map((entry) => ({ ...entry }))
    },
  }

  const coordinator = createCoordinator({
    hostCall,
    store,
    resolveBinding,
    createRpc,
    createObserver: () => observer,
    readSettings,
    sendKeepalive: options.sendKeepalive ?? sendKeepalive,
    scheduler,
    diagnostics,
    createTitleIndicator: createTitleIndicatorFactory,
    epochMemory: options.epochMemory ?? null,
    cwarmDisabled,
    clientId: 'cache-keepalive:test',
    clock,
    tickMs: options.tickMs ?? 2000,
    heartbeatMs: options.heartbeatMs ?? 60000,
  })

  return {
    clock,
    tickMs: options.tickMs ?? 2000,
    hostCall,
    store,
    rawStore,
    spy,
    observer,
    sendCalls,
    diagEvents,
    resolveCalls,
    readSettingsCalls,
    cwarmCalls,
    rpc,
    bindingBox,
    bindingErrorBox,
    settingsBox,
    coordinator,
    titleIndicators,
    get getBinding() {
      return getBindingRef
    },
    get rpcClosed() {
      return rpcClosed
    },
    setSendBehavior(fn) {
      sendBehavior = fn
    },
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function startHarness(h) {
  h.coordinator.start()
  await h.clock.settle(2)
}

function sendEvent(h, event) {
  h.coordinator.onAgentEvent(event)
}

function worktreeEvent(h, worktreeId, state, receivedAt, extra = {}) {
  sendEvent(h, {
    worktreeId,
    paneKey: 'tab:leaf',
    state,
    receivedAt,
    ...extra,
  })
}

async function arm(h, t0, worktreeId = 'w1') {
  worktreeEvent(h, worktreeId, 'working', t0)
  await h.clock.settle()
  worktreeEvent(h, worktreeId, 'done', t0 + 1000)
  await h.clock.settle()
}

function viewTerminal(h, worktreeId = 'w1') {
  const view = h.coordinator.getRuntimeView()
  const group = view.worktrees.find((w) => w.worktreeId === worktreeId)
  return group ? group.terminals[0] : null
}

async function advanceToDue(h, worktreeId = 'w1') {
  const term = viewTerminal(h, worktreeId)
  const delta = term.dueAt - h.clock.now()
  // due를 지난 첫 tick까지 진행한다(tick 격자에 due가 걸쳐 있을 수 있음).
  await h.clock.advance(delta + h.tickMs + 100)
}

const SCOPE = { userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1', paneKey: 'tab:leaf' }

// ---------------------------------------------------------------------------
// 1. epoch lifecycle
// ---------------------------------------------------------------------------

test('working→done→due에서 정확히 1회 전송, 자체 turn은 budget 유지, 다음 done은 새 epoch', async () => {
  const h = createHarness()
  await startHarness(h)

  const t0 = h.clock.now()
  await arm(h, t0)

  let term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, t0 + 1000 + TTL_5M)
  assert.equal(term.dueAt, t0 + 1000 + TTL_5M - MARGIN_5M)

  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
  const call = h.sendCalls[0]
  assert.equal(call.target.worktreeId, 'w1')
  assert.equal(call.target.paneKey, 'tab:leaf')
  assert.equal(call.epochId, 1)
  assert.equal(call.message, DEFAULT_MESSAGE)
  assert.equal(call.quietOutputMs, 2500)
  assert.equal(call.clientId, 'cache-keepalive:test')

  // submitted 뒤 AWAITING_TURN.
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
  const attemptId = h.store.getBudget(SCOPE).lastAttempt.attemptId
  assert.equal(typeof attemptId, 'string')

  // 자체 working turn: budget 유지 + confirmAttempt.
  const turnAt = h.clock.now() + 100
  worktreeEvent(h, 'w1', 'working', turnAt)
  await h.clock.settle()
  assert.deepEqual(h.spy.confirmAttempt, [attemptId])
  assert.equal(viewTerminal(h).phase, 'BUSY')
  assert.equal(h.store.getBudget(SCOPE).charged, 1)
  assert.equal(h.store.getBudget(SCOPE).confirmed, 1)

  // 다음 done → 새 epoch(2).
  worktreeEvent(h, 'w1', 'done', turnAt + 100)
  await h.clock.settle()
  term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, turnAt + 100 + TTL_5M)
  assert.equal(h.store.getBudget(SCOPE).charged, 1)
})

// ---------------------------------------------------------------------------
// 2. 비자체 turn
// ---------------------------------------------------------------------------

test('비자체 fresh working은 store.resetBudget을 호출한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const before = h.spy.resetBudget.length

  worktreeEvent(h, 'w1', 'working', t0 + 2000)
  await h.clock.settle()
  assert.equal(h.spy.resetBudget.length, before + 1)
  assert.equal(viewTerminal(h).phase, 'BUSY')
})

// ---------------------------------------------------------------------------
// 3. 설정 disabled / unknown
// ---------------------------------------------------------------------------

test('설정 disabled면 전송하지 않는다', async () => {
  const h = createHarness({
    settings: { known: true, profileId: 'p1', enabled: false, ttlMs: TTL_5M, readAt: 0 },
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  await h.clock.advance(120000)
  assert.equal(h.sendCalls.length, 0)
})

test('설정 unknown이면 전송하지 않는다', async () => {
  const h = createHarness({ settings: { known: false, reason: 'index_missing', readAt: 0 } })
  await startHarness(h)
  await arm(h, h.clock.now())
  await h.clock.advance(TTL_5M + 1000)
  assert.equal(h.sendCalls.length, 0)
  assert.equal(h.coordinator.getRuntimeView().appTimer.known, false)
})

test('설정 unknown 동안 만든 target도 known 프로필 전환 후 전송된다', async () => {
  const h = createHarness({ settings: { known: false, reason: 'index_missing', readAt: 0 } })
  await startHarness(h)

  // unknown 동안 target은 profileId=null로 만들어진다.
  assert.equal(h.coordinator.getRuntimeView().profileId, null)
  assert.equal(viewTerminal(h).phase, 'UNKNOWN')

  // known 프로필로 전환하면 target을 재생성해야 한다(profileId null로 남으면 영구 거절).
  h.settingsBox.value = {
    known: true,
    profileId: 'p1',
    enabled: true,
    ttlMs: TTL_5M,
    revision: 1,
    source: 'sqlite',
    readAt: 0,
  }
  await h.clock.advance(h.tickMs)
  assert.equal(h.coordinator.getRuntimeView().profileId, 'p1')

  // 재생성된 target에서 새 working→done→due가 정상 전송된다.
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
  assert.equal(h.store.getBudget(SCOPE).charged, 1)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
})

// ---------------------------------------------------------------------------
// 4. 정책 off
// ---------------------------------------------------------------------------

test('워크트리 정책 off면 전송하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.setWorktree({ userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1' }, false)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 0)
  assert.equal(viewTerminal(h).phase, 'ARMED')
  assert.equal(viewTerminal(h).reason, 'SCOPE_DISABLED')
})

// ---------------------------------------------------------------------------
// 5. assertAllowed 반영
// ---------------------------------------------------------------------------

async function runGateProbe(makeHarness, prepare) {
  const h = makeHarness()
  const gates = []
  h.setSendBehavior(async (args) => {
    await prepare(h, args)
    const gate = await args.assertAllowed()
    gates.push(gate)
    return {
      kind: 'skipped',
      reason: gate?.reason ?? 'GATE',
      attemptId: null,
      at: h.clock.now(),
      framesSent: 0,
    }
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  return { h, gates }
}

test('assertAllowed: settings 재읽기 결과를 반영한다', async () => {
  const { gates } = await runGateProbe(
    () => createHarness(),
    (h) => {
      h.settingsBox.value = {
        known: true,
        profileId: 'p1',
        enabled: false,
        ttlMs: TTL_5M,
        readAt: 0,
      }
    },
  )
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], { allowed: false, reason: 'APP_TIMER_OFF' })
})

test('assertAllowed: 정책 off를 반영한다', async () => {
  const { gates } = await runGateProbe(
    () => createHarness(),
    (h) => h.store.setWorktree({ userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1' }, false),
  )
  assert.equal(gates.length, 1)
  assert.equal(gates[0].allowed, false)
  assert.equal(gates[0].reason, 'SCOPE_DISABLED')
})

test('assertAllowed: cwarm disabled 파일을 반영한다', async () => {
  const { gates } = await runGateProbe(() => createHarness({ cwarmDisabled: true }), () => {})
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], { allowed: false, reason: 'CWARM_DISABLED' })
})

test('assertAllowed: target generation 변경을 반영한다', async () => {
  const { gates } = await runGateProbe(
    () => createHarness(),
    (h) => h.coordinator.onWorktreeRemoved({ worktreeId: 'w1' }),
  )
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], { allowed: false, reason: 'STALE_TARGET' })
})

// ---------------------------------------------------------------------------
// 6. 전송 동시성 1
// ---------------------------------------------------------------------------

test('due 대상 3개여도 in-flight는 항상 1개이고 순차 실행된다', async () => {
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'w1', ptyId: 'pty1', incarnationId: 'inc1' }),
    makeRow({ handle: 'h2', worktreeId: 'w2', ptyId: 'pty2', incarnationId: 'inc2' }),
    makeRow({ handle: 'h3', worktreeId: 'w3', ptyId: 'pty3', incarnationId: 'inc3' }),
  ]
  const h = createHarness({ terminals: rows })
  let active = 0
  let maxActive = 0
  h.setSendBehavior(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => h.clock.setTimeout(resolve, 50))
    active -= 1
    return {
      kind: 'skipped',
      reason: 'PROBE',
      attemptId: null,
      at: h.clock.now(),
      framesSent: 0,
    }
  })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0, 'w1')
  await arm(h, t0, 'w2')
  await arm(h, t0, 'w3')

  const dueAt = viewTerminal(h, 'w1').dueAt
  await h.clock.advance(dueAt - h.clock.now() + 3 * 2000 + 500)
  assert.equal(maxActive, 1)
  assert.equal(h.sendCalls.length, 3)
})

// ---------------------------------------------------------------------------
// 7. tick 중첩 없음
// ---------------------------------------------------------------------------

test('느린 observer.list 중에도 tick이 겹치지 않는다', async () => {
  const h = createHarness()
  let active = 0
  let maxActive = 0
  const pending = []
  h.observer.state.onList = () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    return new Promise((resolve) => {
      pending.push(() => {
        active -= 1
        resolve({ complete: true, fetchedAt: 0, terminals: h.observer.state.rows.slice() })
      })
    })
  }

  h.coordinator.start()
  await h.clock.settle(2)
  assert.equal(maxActive, 1)
  assert.equal(pending.length, 1)

  pending.shift()()
  await h.clock.settle(3)
  assert.equal(maxActive, 1)

  await h.clock.advance(2000)
  assert.equal(maxActive, 1)
  assert.equal(pending.length, 1)

  pending.shift()()
  await h.clock.settle(3)
  await h.clock.advance(2000)
  assert.equal(maxActive, 1)
})

// ---------------------------------------------------------------------------
// 8. 이벤트 resolve 재조회
// ---------------------------------------------------------------------------

test('이벤트 target이 catalog에 없으면 list를 1회 재조회한다', async () => {
  const h = createHarness({ terminals: [] })
  await startHarness(h)
  const before = h.observer.listCalls.length

  h.observer.state.rows = [makeRow()]
  worktreeEvent(h, 'w1', 'working', h.clock.now())
  await h.clock.settle(3)

  assert.equal(h.observer.listCalls.length, before + 1)
  assert.equal(viewTerminal(h).phase, 'BUSY')
})

// ---------------------------------------------------------------------------
// 9. CLOCK_GAP
// ---------------------------------------------------------------------------

test('CLOCK_GAP: wall 시계 점프 뒤 epoch를 폐기하고 전송하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(viewTerminal(h).phase, 'ARMED')

  h.clock.jumpWall(20000)
  await h.clock.advance(2000)
  assert.equal(viewTerminal(h).phase, 'EXPIRED')

  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 0)
})

// ---------------------------------------------------------------------------
// 10. binding 변경
// ---------------------------------------------------------------------------

test('binding 변경 시 target을 초기화한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 1)

  h.bindingBox.value = makeBinding({
    runtimeId: 'rt2',
    pid: 999,
    startedAt: 2,
    endpoint: '/tmp/sock2',
  })
  await assert.rejects(
    () => h.getBinding(),
    (error) => error && error.code === 'binding_changed',
  )

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees.length, 0)
  assert.equal(view.connection.state, 'connected')
  assert.equal(view.userDataKey, 'key-p')
})

// ---------------------------------------------------------------------------
// 11. refused / uncertain
// ---------------------------------------------------------------------------

test('uncertain → NEEDS_REVIEW, 확인 해제 후 다음 turn에서 재개', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())

  h.setSendBehavior(async (args) => {
    const gate = await args.assertAllowed()
    if (!gate || gate.allowed !== true) {
      return { kind: 'skipped', reason: gate?.reason ?? 'X', attemptId: null, at: h.clock.now(), framesSent: 0 }
    }
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    await args.journal.markReview(attemptId, 'PARTIAL_OR_UNKNOWN_SEND')
    return {
      kind: 'uncertain',
      reason: 'PARTIAL_OR_UNKNOWN_SEND',
      attemptId,
      at: h.clock.now(),
      framesSent: 1,
    }
  })

  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
  assert.equal(viewTerminal(h).phase, 'NEEDS_REVIEW')

  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 1)

  await h.store.clearReview(SCOPE)
  h.coordinator.onReviewCleared({ worktreeId: 'w1', paneKey: 'tab:leaf' })
  await h.clock.settle()
  assert.equal(viewTerminal(h).phase, 'UNKNOWN')

  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 2)
})

test('refused → SUSPENDED, 새 done 전에는 다시 전송하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())

  h.setSendBehavior(async (args) => {
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    await args.journal.refuseAttempt(attemptId)
    return { kind: 'refused', reason: 'OUTPUT_ACTIVE', attemptId, at: h.clock.now(), framesSent: 0 }
  })

  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')

  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 1)

  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 2)
})

// ---------------------------------------------------------------------------
// 12. heartbeat
// ---------------------------------------------------------------------------

test('heartbeat는 5분 전에 storage.get을 호출한다', async () => {
  const h = createHarness({ heartbeatMs: 60000 })
  await startHarness(h)
  const before = h.hostCall.count('storage.get')

  await h.clock.advance(59000)
  assert.equal(h.hostCall.count('storage.get'), before)

  await h.clock.advance(2000)
  assert.equal(h.hostCall.count('storage.get'), before + 1)
})

// ---------------------------------------------------------------------------
// 13. RuntimeView
// ---------------------------------------------------------------------------

test('getRuntimeView: 계약 shape과 dueAt/expiresAt', async () => {
  const h = createHarness()
  await startHarness(h)

  let view = h.coordinator.getRuntimeView()
  assert.equal(view.userDataKey, 'key-p')
  assert.equal(view.profileId, 'p1')
  assert.deepEqual(view.connection, { state: 'connected', reason: null })
  assert.deepEqual(view.appTimer, {
    known: true,
    enabled: true,
    ttlMs: TTL_5M,
    source: 'sqlite',
    readAt: 0,
    reason: null,
  })
  assert.equal(view.worktrees.length, 1)
  let term = view.worktrees[0].terminals[0]
  assert.equal(term.worktreeId, 'w1')
  assert.equal(term.paneKey, 'tab:leaf')
  assert.equal(term.title, 'Terminal 1')
  assert.equal(term.phase, 'UNKNOWN')
  assert.equal(term.dueAt, null)
  assert.equal(term.expiresAt, null)
  assert.equal(term.supported, true)

  const t0 = h.clock.now()
  await arm(h, t0)
  term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.dueAt, t0 + 1000 + TTL_5M - MARGIN_5M)
  assert.equal(term.expiresAt, t0 + 1000 + TTL_5M)
})

test('getRuntimeView: label은 projectName, branch는 branchName을 쓴다', async () => {
  const h = createHarness({
    terminals: [
      makeRow({
        projectName: 'route-dashboard',
        branch: 'refs/heads/main',
        branchName: 'main',
      }),
    ],
  })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees.length, 1)
  assert.equal(view.worktrees[0].label, 'route-dashboard')
  assert.equal(view.worktrees[0].branch, 'main')
})

test('getRuntimeView: projectName이 없으면 branchName을 label로 쓴다', async () => {
  const h = createHarness({
    terminals: [
      makeRow({ projectName: null, branch: 'refs/heads/main', branchName: 'main' }),
    ],
  })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].label, 'main')
  assert.equal(view.worktrees[0].branch, 'main')
})

test('getRuntimeView: 둘 다 없으면 label/branch는 null', async () => {
  const h = createHarness({
    terminals: [makeRow({ projectName: null, branchName: null, branch: null })],
  })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].label, null)
  assert.equal(view.worktrees[0].branch, null)
})

test('getRuntimeView: 지원되지 않는 행도 이유와 함께 포함한다', async () => {
  const h = createHarness({
    terminals: [makeRow({ supported: false, unsupportedReason: 'UNSUPPORTED_AGENT', agentIdentity: null })],
  })
  await startHarness(h)
  const term = viewTerminal(h)
  assert.equal(term.supported, false)
  assert.equal(term.unsupportedReason, 'UNSUPPORTED_AGENT')

  await arm(h, h.clock.now())
  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 0)
})

// ---------------------------------------------------------------------------
// 13b. RuntimeView: 프로젝트(repo) 정보
// ---------------------------------------------------------------------------

test('getRuntimeView: listRepoNames가 없으면 같은 repo label의 사전순 최솟값을 projectLabel로 쓴다', async () => {
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1', projectName: 'zeta' }),
    makeRow({ handle: 'h2', worktreeId: 'r1::/x/b', paneKey: 'tab:leaf2', projectName: 'alpha' }),
  ]
  // listRepoNames를 노출하지 않는 observer → 폴백 경로.
  const h = createHarness({ terminals: rows })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees.length, 2)
  const byId = new Map(view.worktrees.map((w) => [w.worktreeId, w]))
  assert.equal(byId.get('r1::/x/a').repoId, 'r1')
  assert.equal(byId.get('r1::/x/b').repoId, 'r1')
  assert.equal(byId.get('r1::/x/a').projectLabel, 'alpha')
  assert.equal(byId.get('r1::/x/b').projectLabel, 'alpha')
})

test('getRuntimeView: listRepoNames가 null이면 같은 repo label 최솟값을 projectLabel로 쓴다', async () => {
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1', projectName: 'zeta' }),
    makeRow({ handle: 'h2', worktreeId: 'r1::/x/b', paneKey: 'tab:leaf2', projectName: 'alpha' }),
  ]
  const observer = createObserverFake({ rows, repoNames: null })
  const h = createHarness({ observer })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  const byId = new Map(view.worktrees.map((w) => [w.worktreeId, w]))
  assert.equal(byId.get('r1::/x/a').projectLabel, 'alpha')
  assert.equal(byId.get('r1::/x/b').projectLabel, 'alpha')
  assert.equal(observer.repoNamesCalls.length, 1)
})

test('getRuntimeView: 같은 repoId 두 워크트리는 listRepoNames 결과를 projectLabel로 공유한다', async () => {
  // row.repoId를 명시한 행과 worktreeId에서 파싱한 행이 같은 repo로 묶인다.
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'different::/x/a', repoId: 'r1', paneKey: 'tab:leaf1' }),
    makeRow({ handle: 'h2', worktreeId: 'r1::/x/b', paneKey: 'tab:leaf2' }),
  ]
  const observer = createObserverFake({
    rows,
    repoNames: new Map([['r1', 'mtt-claude-plugins']]),
  })
  const h = createHarness({ observer })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees.length, 2)
  const byId = new Map(view.worktrees.map((w) => [w.worktreeId, w]))
  assert.equal(byId.get('different::/x/a').repoId, 'r1')
  assert.equal(byId.get('r1::/x/b').repoId, 'r1')
  assert.equal(byId.get('different::/x/a').projectLabel, 'mtt-claude-plugins')
  assert.equal(byId.get('r1::/x/b').projectLabel, 'mtt-claude-plugins')
  assert.equal(observer.repoNamesCalls.length, 1)
})

test('getRuntimeView: repoId가 없으면 projectLabel은 group label을 쓴다', async () => {
  const h = createHarness({
    terminals: [makeRow({ worktreeId: 'w1', projectName: 'solo' })],
  })
  await startHarness(h)
  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].repoId, null)
  assert.equal(view.worktrees[0].projectLabel, 'solo')
})

test('repo 이름 캐시: 30초 이내 재호출하지 않고 새 repoId 등장 시에만 다시 호출한다', async () => {
  const rows = [makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1' })]
  const observer = createObserverFake({
    rows,
    repoNames: new Map([['r1', 'repo-one']]),
  })
  const h = createHarness({ observer })
  await startHarness(h)
  assert.equal(observer.repoNamesCalls.length, 1)

  // 새 repoId 등장. 마지막 시도 후 30초 이내에는 재시도하지 않는다.
  observer.state.rows.push(makeRow({ handle: 'h2', worktreeId: 'r2::/x/b', paneKey: 'tab:leaf2' }))
  await h.clock.advance(29000)
  assert.equal(observer.repoNamesCalls.length, 1)

  // 30초가 지나면 새 repoId 때문에 다시 호출한다.
  await h.clock.advance(2000)
  assert.equal(observer.repoNamesCalls.length, 2)
})

test('repo 이름 캐시: listRepoNames가 throw해도 tick과 전송이 정상 진행된다', async () => {
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1', projectName: 'zeta' }),
  ]
  const observer = createObserverFake({
    rows,
    onListRepoNames: () => {
      throw new Error('boom')
    },
  })
  const h = createHarness({ observer })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].projectLabel, 'zeta')

  const t0 = h.clock.now()
  h.coordinator.onAgentEvent({
    worktreeId: 'r1::/x/a',
    paneKey: 'tab:leaf1',
    state: 'working',
    receivedAt: t0,
  })
  await h.clock.settle()
  h.coordinator.onAgentEvent({
    worktreeId: 'r1::/x/a',
    paneKey: 'tab:leaf1',
    state: 'done',
    receivedAt: t0 + 1000,
  })
  await h.clock.settle()
  assert.equal(viewTerminal(h, 'r1::/x/a').phase, 'ARMED')

  await advanceToDue(h, 'r1::/x/a')
  assert.equal(h.sendCalls.length, 1)
})

test('repo 이름 캐시: listRepoNames가 pending이어도 tick과 전송이 진행된다', async () => {
  let resolveRepoNames
  const pending = new Promise((resolve) => {
    resolveRepoNames = resolve
  })
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1', projectName: 'zeta' }),
  ]
  const observer = createObserverFake({ rows, onListRepoNames: () => pending })
  const h = createHarness({ observer })
  await startHarness(h)
  assert.equal(observer.repoNamesCalls.length, 1)
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 1)

  const t0 = h.clock.now()
  h.coordinator.onAgentEvent({
    worktreeId: 'r1::/x/a',
    paneKey: 'tab:leaf1',
    state: 'working',
    receivedAt: t0,
  })
  await h.clock.settle()
  h.coordinator.onAgentEvent({
    worktreeId: 'r1::/x/a',
    paneKey: 'tab:leaf1',
    state: 'done',
    receivedAt: t0 + 1000,
  })
  await h.clock.settle()
  assert.equal(viewTerminal(h, 'r1::/x/a').phase, 'ARMED')

  await advanceToDue(h, 'r1::/x/a')
  assert.equal(h.sendCalls.length, 1)

  // pending을 해소해 dangling을 남기지 않는다.
  resolveRepoNames(new Map([['r1', 'repo-one']]))
  await h.clock.settle()
})

test('repo 이름 캐시: 진행 중 호출이 있으면 중복 호출하지 않고 5분 경과 시 재조회한다', async () => {
  let resolveRepoNames
  const pending = new Promise((resolve) => {
    resolveRepoNames = resolve
  })
  const rows = [makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1' })]
  const observer = createObserverFake({ rows, onListRepoNames: () => pending })
  const h = createHarness({ observer })
  await startHarness(h)
  assert.equal(observer.repoNamesCalls.length, 1)

  // pending 동안 2분이 지나도 중복 호출하지 않는다.
  await h.clock.advance(120000)
  assert.equal(observer.repoNamesCalls.length, 1)

  // 해소 후 5분 주기 갱신으로 다시 호출한다.
  resolveRepoNames(new Map([['r1', 'repo-one']]))
  await h.clock.settle()
  await h.clock.advance(300000)
  assert.ok(observer.repoNamesCalls.length >= 2)
})

test('repo 이름 캐시: 결과에 없는 repoId는 30초 후에도 재호출하지 않는다', async () => {
  const rows = [makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1' })]
  // 결과에 r1이 없는 빈 Map → missing으로 기록된다.
  const observer = createObserverFake({ rows, repoNames: new Map() })
  const h = createHarness({ observer })
  await startHarness(h)
  assert.equal(observer.repoNamesCalls.length, 1)

  await h.clock.advance(31000)
  assert.equal(observer.repoNamesCalls.length, 1)

  // 새 repoId가 등장하면 그때만 재호출한다.
  observer.state.rows.push(makeRow({ handle: 'h2', worktreeId: 'r2::/x/b', paneKey: 'tab:leaf2' }))
  await h.clock.advance(2000)
  assert.equal(observer.repoNamesCalls.length, 2)
})

test('repo 이름 캐시: 마지막 성공 후 5분이 지나면 주기 갱신한다', async () => {
  const rows = [makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1' })]
  const observer = createObserverFake({ rows, repoNames: new Map([['r1', 'repo-one']]) })
  const h = createHarness({ observer })
  await startHarness(h)
  assert.equal(observer.repoNamesCalls.length, 1)

  // 5분 직전에는 호출하지 않는다.
  await h.clock.advance(298000)
  assert.equal(observer.repoNamesCalls.length, 1)

  await h.clock.advance(4000)
  assert.equal(observer.repoNamesCalls.length, 2)
})

test('repo 이름 캐시: non-Map 결과는 무시하고 label 폴백을 유지한다', async () => {
  const rows = [
    makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1', projectName: 'zeta' }),
  ]
  const observer = createObserverFake({ rows, onListRepoNames: () => ({ r1: 'bad-shape' }) })
  const h = createHarness({ observer })
  await startHarness(h)

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].projectLabel, 'zeta')
  assert.equal(observer.repoNamesCalls.length, 1)
})

test('repo 이름 캐시: listRepoNames에 AbortSignal을 전달하고 stop 시 abort한다', async () => {
  let seenSignal = null
  const observer = createObserverFake({
    rows: [makeRow({ handle: 'h1', worktreeId: 'r1::/x/a', paneKey: 'tab:leaf1' })],
    repoNames: new Map([['r1', 'repo-one']]),
  })
  const baseList = observer.listRepoNames
  observer.listRepoNames = async (options) => {
    seenSignal = options?.signal ?? null
    return baseList(options)
  }
  const h = createHarness({ observer })
  await startHarness(h)
  assert.ok(seenSignal instanceof AbortSignal)
  assert.equal(seenSignal.aborted, false)

  await h.coordinator.stop()
  assert.equal(seenSignal.aborted, true)
})

// ---------------------------------------------------------------------------
// 14. stop / bootstrap 실패
// ---------------------------------------------------------------------------

test('stop: timer를 정리하고 2회 안전하며 이후 send/timer가 없다', async () => {
  const h = createHarness()
  await startHarness(h)
  assert.ok(h.clock.pendingCount() > 0)

  await h.coordinator.stop()
  assert.equal(h.clock.pendingCount(), 0)
  assert.equal(h.rpcClosed, true)
  // stop은 대기 중 저장을 1회 flush한다.
  assert.equal(h.spy.flush.length, 1)

  await h.coordinator.stop()
  const sentBefore = h.sendCalls.length
  await h.clock.advance(TTL_5M + 10000)
  assert.equal(h.sendCalls.length, sentBefore)
  assert.equal(h.clock.pendingCount(), 0)
  // 두 번째 stop은 같은 stopPromise라 flush를 다시 호출하지 않는다.
  assert.equal(h.spy.flush.length, 1)
})

test('Y3: tick 1회에서 store.snapshot 호출이 target 수에 비례하지 않는다', async () => {
  const rows = [
    makeRow({ handle: 'h1', paneKey: 'tab:leaf1', ptyId: 'pty1', incarnationId: 'inc1' }),
    makeRow({ handle: 'h2', paneKey: 'tab:leaf2', ptyId: 'pty2', incarnationId: 'inc2' }),
    makeRow({ handle: 'h3', paneKey: 'tab:leaf3', ptyId: 'pty3', incarnationId: 'inc3' }),
  ]
  const h = createHarness({ terminals: rows })
  await startHarness(h)

  const t0 = h.clock.now()
  for (const paneKey of ['tab:leaf1', 'tab:leaf2', 'tab:leaf3']) {
    h.coordinator.onAgentEvent({ worktreeId: 'w1', paneKey, state: 'working', receivedAt: t0 })
    await h.clock.settle()
    h.coordinator.onAgentEvent({ worktreeId: 'w1', paneKey, state: 'done', receivedAt: t0 + 1000 })
    await h.clock.settle()
  }
  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].terminals.length, 3)
  assert.ok(view.worktrees[0].terminals.every((term) => term.phase === 'ARMED'))

  // arm까지의 이벤트 경로 호출은 제외하고 다음 tick만 센다.
  const rawSnapshot = h.rawStore.snapshot
  let snapshotCalls = 0
  h.store.snapshot = (...args) => {
    snapshotCalls += 1
    return rawSnapshot.apply(h.rawStore, args)
  }

  await h.clock.advance(h.tickMs)
  assert.ok(
    snapshotCalls <= 2,
    `tick 1회 snapshot 호출은 target 수(3)가 아니라 상수여야 한다: ${snapshotCalls}`,
  )
})

test('bootstrap 실패: start는 throw하지 않고 connection을 unavailable로 표시한다', async () => {
  const h = createHarness({
    bindingError: Object.assign(new Error('metadata missing'), { code: 'metadata_missing' }),
  })
  assert.doesNotThrow(() => h.coordinator.start())
  await h.clock.settle(3)

  let view = h.coordinator.getRuntimeView()
  assert.equal(view.connection.state, 'unavailable')
  assert.equal(view.connection.reason, 'metadata_missing')
  assert.equal(view.worktrees.length, 0)

  // 재시도(backoff 1s)에서 성공하면 connected로 전환한다.
  h.bindingErrorBox.value = null
  await h.clock.advance(1000)
  await h.clock.settle(2)
  view = h.coordinator.getRuntimeView()
  assert.equal(view.connection.state, 'connected')
  await h.coordinator.stop()
})

test('bootstrap 실패: wrong_runtime은 wrong_runtime으로 표시한다', async () => {
  const h = createHarness({
    bindingError: Object.assign(new Error('wrong runtime'), { code: 'wrong_runtime' }),
  })
  h.coordinator.start()
  await h.clock.settle(3)
  assert.equal(h.coordinator.getRuntimeView().connection.state, 'wrong_runtime')
  await h.coordinator.stop()
})

// ---------------------------------------------------------------------------
// 15. U1: 예약 후 LIMIT_REACHED 경계(off-by-one) 회귀
//
// 기존 테스트의 fake sendKeepalive는 gate2(예약 후 재확인)를 재현하지 않아
// maxConsecutiveKeepalives 경계에서 guarded-send가 refused 되는 버그를 가렸다.
// 여기서는 실제 sendKeepalive + 실제 createStateStore를 사용한다.
// ---------------------------------------------------------------------------

/** terminal.send를 실제 guarded-send 흐름처럼 응답하는 fake rpc. */
function createRealSendRpc({ onPaste, onEnter } = {}) {
  const calls = []
  const rpc = {
    calls,
    async call(method, params) {
      calls.push({ method, params })
      if (method !== 'terminal.send') {
        throw new Error(`unexpected method ${method}`)
      }
      if (typeof params.text === 'string') {
        if (typeof onPaste === 'function') {
          onPaste(params)
        }
        return {
          send: { handle: params.terminal, accepted: true, bytesWritten: params.text.length },
        }
      }
      if (params.enter === true) {
        if (typeof onEnter === 'function') {
          onEnter(params)
        }
        return { send: { handle: params.terminal, accepted: true, bytesWritten: 0 } }
      }
      throw new Error('unexpected terminal.send params')
    },
    close() {},
  }
  rpc.pasteCalls = () => calls.filter((call) => typeof call.params.text === 'string')
  rpc.enterCalls = () => calls.filter((call) => call.params.enter === true)
  return rpc
}

/**
 * paste 전/Enter 후에는 draft=null, paste 후 Enter 전에는 draft=config.message를
 * 돌려주는 observer. guarded-send의 preflight와 paste 확인 단계를 실제와 같게 만든다.
 */
function createRealSendObserver() {
  let draft = null
  return {
    setDraft(value) {
      draft = value
    },
    async list() {
      return { complete: true, fetchedAt: 0, terminals: [makeRow()] }
    },
    resolveEvent(event, catalog) {
      const payload = event && typeof event === 'object' && event.payload ? event.payload : event
      if (!payload || typeof payload !== 'object') {
        return null
      }
      const matches = (catalog?.terminals ?? []).filter(
        (row) => row.worktreeId === payload.worktreeId && row.paneKey === payload.paneKey,
      )
      if (matches.length !== 1) {
        return null
      }
      const row = matches[0]
      return {
        worktreeId: row.worktreeId,
        paneKey: row.paneKey,
        handle: row.handle,
        ptyId: row.ptyId,
        incarnationId: row.incarnationId,
      }
    },
    async inspect() {
      return {
        stale: false,
        identity: 'claude',
        executionHostId: 'local',
        connected: true,
        writable: true,
        agentStatus: 'idle',
        isRunningAgent: true,
        agentWait: 'none',
        screen: 'ok',
        screenTruncated: false,
        draft,
        lastOutputAt: 0,
      }
    },
    async currentWorktree() {
      return null
    },
  }
}

/** 실제 sendKeepalive/store를 쓰는 harness. 호출별 SendResult는 sendAttempts에 쌓인다. */
function createRealSendHarness() {
  const observer = createRealSendObserver()
  const rpc = createRealSendRpc({
    onPaste: () => observer.setDraft(DEFAULT_MESSAGE),
    onEnter: () => observer.setDraft(null),
  })
  const sendAttempts = []
  async function realSend(args) {
    const result = await sendKeepalive(args)
    sendAttempts.push(result)
    return result
  }
  const h = createHarness({ observer, rpc, sendKeepalive: realSend })
  h.sendAttempts = sendAttempts
  return h
}

/** AWAITING_TURN까지 끝난 자체 turn을 다음 working→done→due로 이어 새 epoch를 만든다. */
async function cycleRealSend(h) {
  await arm(h, h.clock.now())
  await advanceToDue(h)
}

test('U1: max=1에서도 예약 후 LIMIT_REACHED 경계를 통과해 첫 keepalive가 submitted', async () => {
  const h = createRealSendHarness()
  await startHarness(h)
  await h.store.updateConfig({ maxConsecutiveKeepalives: 1 })

  await cycleRealSend(h)

  assert.equal(h.sendAttempts.length, 1)
  assert.equal(h.sendAttempts[0].kind, 'submitted')
  assert.equal(h.store.getBudget(SCOPE).charged, 1)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')

  // 두 번째 epoch는 예약 전(decide/assertAllowed gate1)에서 LIMIT_REACHED로 막힌다.
  await cycleRealSend(h)
  assert.equal(h.sendAttempts.length, 1)
  assert.equal(h.store.getBudget(SCOPE).charged, 1)
  assert.equal(viewTerminal(h).phase, 'ARMED')
  assert.equal(viewTerminal(h).reason, 'LIMIT_REACHED')
})

test('U1: max=3에서 연속 3회 submitted, 4번째는 예약 전 LIMIT_REACHED로 차단', async () => {
  const h = createRealSendHarness()
  await startHarness(h)
  await h.store.updateConfig({ maxConsecutiveKeepalives: 3 })

  for (let i = 0; i < 3; i += 1) {
    await cycleRealSend(h)
  }

  assert.equal(h.sendAttempts.length, 3)
  assert.deepEqual(
    h.sendAttempts.map((result) => result.kind),
    ['submitted', 'submitted', 'submitted'],
  )
  assert.equal(h.store.getBudget(SCOPE).charged, 3)
  // 실제 guarded-send가 paste 1 + Enter 1을 3회, 프레임 6을 보냈다.
  assert.equal(h.rpc.pasteCalls().length, 3)
  assert.equal(h.rpc.enterCalls().length, 3)

  // 4번째: charged>=max이므로 decide가 예약 전에 막는다(charged 불변, 새 시도 없음).
  await cycleRealSend(h)
  assert.equal(h.sendAttempts.length, 3)
  assert.equal(h.store.getBudget(SCOPE).charged, 3)
  assert.equal(viewTerminal(h).phase, 'ARMED')
  assert.equal(viewTerminal(h).reason, 'LIMIT_REACHED')
})

// ---------------------------------------------------------------------------
// 16. U2: 불완전 catalog에서는 새 전송을 시작하지 않는다
// ---------------------------------------------------------------------------

test('U2: catalog가 불완전하면 due여도 전송 0, complete 복귀 후 재개', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const dueAt = viewTerminal(h).dueAt

  const incomplete = () =>
    h.diagEvents.filter(
      (entry) => entry.event === 'safety_skipped' && entry.code === 'CATALOG_INCOMPLETE',
    )

  // 불완전 전환: 다음 tick에서 1회 진단.
  h.observer.state.complete = false
  await h.clock.advance(h.tickMs)
  assert.equal(incomplete().length, 1)

  // due를 지나도 새 전송을 시작하지 않는다.
  await h.clock.advance(dueAt - h.clock.now() + h.tickMs + 100)
  assert.equal(h.sendCalls.length, 0)

  // 진단은 전환 시 1회만 남는다.
  assert.equal(incomplete().length, 1)

  // complete로 복귀하면 다음 tick에서 전송을 재개한다.
  h.observer.state.complete = true
  await h.clock.advance(h.tickMs)
  assert.equal(h.sendCalls.length, 1)
})

// ---------------------------------------------------------------------------
// 17. U3: 앱 타이머 off/unknown 전환은 예약 epoch를 폐기한다
// ---------------------------------------------------------------------------

test('U3: 앱 타이머 off 전환은 epoch를 폐기하고, 재켜도 새 turn 전에는 전송하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(viewTerminal(h).phase, 'ARMED')

  // enabled=true → false 전환.
  h.settingsBox.value = {
    known: true,
    profileId: 'p1',
    enabled: false,
    ttlMs: TTL_5M,
    readAt: 0,
  }
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  assert.equal(viewTerminal(h).reason, 'APP_TIMER_OFF')

  // 다시 켜도(만료 전) 옛 epoch가 살아나지 않는다.
  h.settingsBox.value = {
    known: true,
    profileId: 'p1',
    enabled: true,
    ttlMs: TTL_5M,
    readAt: 0,
  }
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 0)

  // 다음 fresh working→done 이후에는 정상 전송한다.
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
})

test('U3: 앱 타이머 unknown 전환도 epoch를 폐기한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(viewTerminal(h).phase, 'ARMED')

  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  assert.equal(viewTerminal(h).reason, 'SETTINGS_UNKNOWN')

  await h.clock.advance(TTL_5M)
  assert.equal(h.sendCalls.length, 0)
})

// ---------------------------------------------------------------------------
// 18. turn-start 미관측 → NEEDS_REVIEW store 기록 + 대시보드 해제 후 재개
// ---------------------------------------------------------------------------

test('turn-start 미관측 → store needsReview 기록, 대시보드 해제 후 다음 turn에서 재개', async () => {
  const h = createRealSendHarness()
  await startHarness(h)

  // 1) 정상 전송(submitted)까지 진행해 AWAITING_TURN 상태를 만든다.
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendAttempts.length, 1)
  assert.equal(h.sendAttempts[0].kind, 'submitted')
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
  assert.equal(h.store.getBudget(SCOPE).needsReview, false)

  const attemptId = h.store.getBudget(SCOPE).lastAttempt.attemptId
  assert.equal(typeof attemptId, 'string')

  // 2) working hook 없이 turn-start 확인 창(15초)을 넘기면 TICK이 NEEDS_REVIEW로 만든다.
  await h.clock.advance(TIMING.turnStartConfirmMs + h.tickMs * 2 + 100)

  // store budget에 needsReview가 기록돼 대시보드 해제 버튼이 뜬다.
  assert.equal(h.store.getBudget(SCOPE).needsReview, true)
  assert.ok(h.spy.markReview.includes(attemptId))
  // scheduler/view에도 NEEDS_REVIEW가 노출된다.
  assert.equal(viewTerminal(h).phase, 'NEEDS_REVIEW')
  assert.equal(viewTerminal(h).reason, 'PARTIAL_OR_UNKNOWN_SEND')

  // 전환 진단은 1회만 남는다.
  const uncertainDiag = h.diagEvents.filter(
    (entry) => entry.event === 'send_uncertain' && entry.code === 'PARTIAL_OR_UNKNOWN_SEND',
  )
  assert.equal(uncertainDiag.length, 1)

  // 대시보드용 view에도 needsReview가 노출된다.
  const model = createDashboardModel({
    store: h.store,
    getRuntimeView: () => h.coordinator.getRuntimeView(),
    onReviewCleared: (info) => h.coordinator.onReviewCleared(info),
  })
  let snap = model.snapshot()
  const term = snap.worktrees[0].terminals[0]
  assert.equal(term.phase, 'NEEDS_REVIEW')
  assert.equal(term.needsReview, true)

  // 3) 대시보드 "다음 작업부터 재개": clear-review → store.clearReview + onReviewCleared.
  snap = await model.dispatch({
    type: 'clear-review',
    targetId: term.id,
    expectedRevision: snap.revision,
  })
  assert.equal(h.store.getBudget(SCOPE).needsReview, false)
  assert.equal(viewTerminal(h).phase, 'UNKNOWN')
  assert.equal(snap.worktrees[0].terminals[0].needsReview, false)

  // 4) 다음 fresh working→done→due에서 다시 전송할 수 있다.
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendAttempts.length, 2)
  assert.equal(h.sendAttempts[1].kind, 'submitted')
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
})

test('turn-start 미관측: store.markReview 실패도 tick을 막지 않고 진단만 남긴다', async () => {
  const h = createRealSendHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')

  // markReview가 reject해도 tick은 NEEDS_REVIEW로 진행되고 실패 진단만 남는다.
  h.store.markReview = async () => {
    throw new Error('mark_failed')
  }
  await h.clock.advance(TIMING.turnStartConfirmMs + h.tickMs * 2 + 100)

  assert.equal(viewTerminal(h).phase, 'NEEDS_REVIEW')
  assert.equal(h.store.getBudget(SCOPE).needsReview, false)
  const failed = h.diagEvents.filter(
    (entry) => entry.event === 'safety_skipped' && entry.code === 'review_mark_failed',
  )
  assert.equal(failed.length, 1)
})

// ---------------------------------------------------------------------------
// 19. 탭 제목 ⚡ 표시기(실험 옵션) 연결
// ---------------------------------------------------------------------------

test('title indicator: 옵션 off면 매 tick reconcile([])를 호출한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const indicator = h.titleIndicators[0]
  assert.ok(indicator, 'rpc 준비 후 표시기를 생성해야 한다')
  assert.equal(indicator.calls.load, 1, 'load를 1회 호출한다')

  await h.clock.advance(h.tickMs)
  assert.ok(indicator.calls.reconcile.length >= 1)
  assert.deepEqual(indicator.calls.reconcile.at(-1), [])
})

test('title indicator: 옵션 on이면 supported target만 on=true로 원한다', async () => {
  const rows = [
    makeRow({ handle: 'h1', paneKey: 'tab:leaf', supported: true }),
    makeRow({
      handle: 'h2',
      tabId: 'tab2',
      leafId: 'leaf2',
      paneKey: 'tab2:leaf2',
      ptyId: 'pty2',
      incarnationId: 'inc2',
      supported: false,
      unsupportedReason: 'UNSUPPORTED_AGENT',
    }),
  ]
  const h = createHarness({ terminals: rows })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await h.clock.advance(h.tickMs)

  const desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.deepEqual(desired, [
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: true },
  ])
})

test('title indicator: paused이거나 앱 타이머가 off면 on=false', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })

  await h.store.setPaused(true)
  await h.clock.advance(h.tickMs)
  let desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.deepEqual(desired, [
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: false },
  ])

  await h.store.setPaused(false)
  h.settingsBox.value = {
    known: true,
    profileId: 'p1',
    enabled: false,
    ttlMs: TTL_5M,
    readAt: 0,
  }
  await h.clock.advance(h.tickMs)
  desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.equal(desired.length, 1)
  assert.equal(desired[0].on, false)
})

test('title indicator: catalog 불완전/읽기 실패 tick은 off 제거만 수행한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await h.clock.advance(h.tickMs)
  const indicator = h.titleIndicators[0]
  const before = indicator.calls.reconcile.length
  assert.ok(before >= 1, '정상 tick에서는 reconcile을 호출한다')
  assert.equal(indicator.calls.reconcile.at(-1)[0].on, true)

  // catalog가 불완전하면 명시적 off 제거 전용 reconcile을 요청한다.
  h.observer.state.complete = false
  await h.clock.advance(h.tickMs)
  assert.equal(indicator.calls.reconcile.length, before + 1)
  assert.deepEqual(indicator.calls.reconcileOptions.at(-1), { removeOnly: true })
  assert.equal(indicator.calls.reconcile.at(-1)[0].on, true)

  // catalog 읽기 실패도 제거 전용 동작을 유지한다.
  h.observer.state.onList = () => {
    throw new Error('catalog down')
  }
  await h.clock.advance(h.tickMs)
  assert.equal(indicator.calls.reconcile.length, before + 2)
  assert.deepEqual(indicator.calls.reconcileOptions.at(-1), { removeOnly: true })
})

test('title indicator: worktree off는 onPolicyChanged만으로 즉시 표시기를 끈다', async () => {
  const rows = [makeRow()]
  const titleRpc = createTitleIndicatorRpc(rows)
  const h = createHarness({
    terminals: rows,
    rpc: titleRpc.rpc,
    createTitleIndicator: (deps) => createTitleIndicator({ ...deps, settleMs: 0 }),
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await h.clock.advance(h.tickMs)
  await h.clock.settle(5)
  assert.equal(titleRpc.titles.get('h1'), '⚡ Terminal 1')

  const catalogCalls = h.observer.listCalls.length
  await h.store.setWorktree({ userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1' }, false)
  h.coordinator.onPolicyChanged()
  await h.clock.settle(8)

  assert.equal(h.observer.listCalls.length, catalogCalls, 'policy 변경은 tick/catalog 조회를 앞당기지 않는다')
  assert.deepEqual(titleRpc.renames.at(-1), { terminal: 'h1', title: null })
  assert.equal(titleRpc.titles.get('h1'), 'Terminal 1')
})

test('title indicator: 전역 pause는 onPolicyChanged 즉시 모든 target을 off로 보낸다', async () => {
  const rows = [
    makeRow(),
    makeRow({
      handle: 'h2',
      worktreeId: 'w2',
      tabId: 'tab2',
      leafId: 'leaf2',
      paneKey: 'tab2:leaf2',
      ptyId: 'pty2',
      incarnationId: 'inc2',
    }),
  ]
  const titleRpc = createTitleIndicatorRpc(rows)
  const h = createHarness({
    terminals: rows,
    rpc: titleRpc.rpc,
    createTitleIndicator: (deps) => createTitleIndicator({ ...deps, settleMs: 0 }),
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await h.clock.advance(h.tickMs)
  await h.clock.settle(5)
  assert.equal(titleRpc.titles.get('h1'), '⚡ Terminal 1')
  assert.equal(titleRpc.titles.get('h2'), '⚡ Terminal 1')

  await h.store.setPaused(true)
  h.coordinator.onPolicyChanged()
  await h.clock.settle(8)

  assert.deepEqual(
    titleRpc.renames.filter((rename) => rename.title === null).map((rename) => rename.terminal).sort(),
    ['h1', 'h2'],
  )
  assert.equal(titleRpc.titles.get('h1'), 'Terminal 1')
  assert.equal(titleRpc.titles.get('h2'), 'Terminal 1')
})

test('title indicator: 실제 턴 완료에 1회 호출, 자체 keepalive 턴에는 호출하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  const indicator = h.titleIndicators[0]

  // 실제(사람) 턴 완료 → tabKey 1회.
  await arm(h, h.clock.now())
  assert.deepEqual(indicator.calls.onTurnCompleted, ['w1:tab'])

  // 자체 keepalive 턴 완료 → 호출하지 않는다.
  await advanceToDue(h)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
  const before = indicator.calls.onTurnCompleted.length
  const turnAt = h.clock.now() + 100
  worktreeEvent(h, 'w1', 'working', turnAt)
  await h.clock.settle()
  worktreeEvent(h, 'w1', 'done', turnAt + 100)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, before, '자체 턴 완료는 무시한다')
})

test('title indicator: stop은 rpc close 전에 restoreAll을 기다린다', async () => {
  let resolveRestore
  const restorePromise = new Promise((resolve) => {
    resolveRestore = resolve
  })
  const indicator = createFakeTitleIndicator({ onRestoreAll: () => restorePromise })
  const h = createHarness({ titleIndicator: indicator })
  await startHarness(h)

  const stopping = h.coordinator.stop()
  await h.clock.settle()
  assert.equal(indicator.calls.restoreAll, 1)
  assert.equal(h.rpcClosed, false, 'restoreAll 완료 전에는 rpc를 닫지 않는다')

  resolveRestore()
  await stopping
  assert.equal(h.rpcClosed, true, 'restore 뒤 rpc를 닫는다')
})

test('title indicator: restoreAll이 끝나지 않아도 5초 뒤 rpc를 닫는다', async () => {
  const indicator = createFakeTitleIndicator({ onRestoreAll: () => new Promise(() => {}) })
  const h = createHarness({ titleIndicator: indicator })
  await startHarness(h)

  const stopping = h.coordinator.stop()
  await h.clock.settle()
  assert.equal(h.rpcClosed, false)

  await h.clock.advance(5000)
  await stopping
  assert.equal(h.rpcClosed, true, '5초 상한 뒤에는 닫는다')
})

test('title indicator: rpc가 준비되지 않으면(연결 실패) 생성하지 않는다', async () => {
  let created = 0
  const h = createHarness({
    bindingError: Object.assign(new Error('metadata missing'), { code: 'metadata_missing' }),
    createTitleIndicator: () => {
      created += 1
      return createFakeTitleIndicator()
    },
  })
  h.coordinator.start()
  await h.clock.settle(3)

  assert.equal(created, 0, 'rpc 없이는 팩토리를 호출하지 않는다')
  assert.equal(h.coordinator.getRuntimeView().connection.state, 'unavailable')
  await h.coordinator.stop()
})

// ---------------------------------------------------------------------------
// 20. 탭 제목 ⚡ 표시: cwarm 전송 게이트 반영
// ---------------------------------------------------------------------------

test('title indicator: cwarm 게이트를 반영하고 확인 예외는 차단하지 않는다', async () => {
  let disabled = true
  let throwOnCheck = false
  const h = createHarness({
    cwarmDisabled: () => {
      if (throwOnCheck) {
        throw new Error('cwarm read failed')
      }
      return disabled
    },
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })

  // cwarm.disabled가 있으면 이번 tick desired는 전부 on=false.
  await h.clock.advance(h.tickMs)
  assert.deepEqual(h.titleIndicators[0].calls.reconcile.at(-1), [
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: false },
  ])
  assert.ok(h.cwarmCalls.length >= 1, 'respectCwarmDisabled=true면 cwarm을 확인한다')

  // 해제되면 기존 조건대로 on=true.
  disabled = false
  await h.clock.advance(h.tickMs)
  assert.equal(h.titleIndicators[0].calls.reconcile.at(-1)[0].on, true)

  // 확인이 throw하면 차단하지 않는다(false 취급, assertAllowed와 동일).
  throwOnCheck = true
  await h.clock.advance(h.tickMs)
  assert.equal(h.titleIndicators[0].calls.reconcile.at(-1)[0].on, true)
})

test('title indicator: respectCwarmDisabled=false면 cwarm을 확인하지 않고 on=true', async () => {
  const h = createHarness({ cwarmDisabled: true })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true, respectCwarmDisabled: false })
  const before = h.cwarmCalls.length

  await h.clock.advance(h.tickMs)
  assert.equal(h.titleIndicators[0].calls.reconcile.at(-1)[0].on, true)
  assert.equal(h.cwarmCalls.length, before, '꺼져 있으면 cwarm을 읽지 않는다')
})

test('title indicator: 늦게 끝난 이전 tick의 cwarm 확인은 새 tick 결과를 덮지 않는다', async () => {
  /** @type {{promise: Promise<boolean>}|null} */
  let gate = null
  const h = createHarness({ cwarmDisabled: () => (gate === null ? false : gate.promise) })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })

  // tick N: cwarm 확인이 끝나지 않은 채 남는다.
  let release = () => {}
  gate = { promise: new Promise((resolve) => (release = resolve)) }
  await h.clock.advance(h.tickMs)
  gate = null

  // tick N+1: 옵션 off → reconcile([]).
  await h.store.updateConfig({ tabTitleIndicator: false })
  await h.clock.advance(h.tickMs)
  const calls = h.titleIndicators[0].calls.reconcile
  assert.deepEqual(calls.at(-1), [])
  const count = calls.length

  // tick N의 확인이 뒤늦게 끝나도 on=true desired를 다시 보내지 않는다.
  release(false)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, count)
  assert.deepEqual(calls.at(-1), [])
})

// ---------------------------------------------------------------------------
// 21. pendingRealTurn 누수: target 삭제 경로에서 정리
// ---------------------------------------------------------------------------

test('pendingRealTurn: onWorktreeRemoved로 target이 삭제되면 정리된다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  const indicator = h.titleIndicators[0]

  const t0 = h.clock.now()
  // 실제(사람) 턴 시작만 관측하고 done은 아직 없다 → pendingRealTurn 등록 상태.
  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()

  // target 제거(worktree 삭제) 후 같은 key가 catalog로 다시 생성된다.
  h.coordinator.onWorktreeRemoved({ worktreeId: 'w1' })
  await h.clock.settle()
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 0)

  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).worktreeId, 'w1')

  // 누수된 pending이 없으면 done만으로는 onTurnCompleted가 호출되지 않는다.
  const before = indicator.calls.onTurnCompleted.length
  worktreeEvent(h, 'w1', 'done', t0 + 1000)
  await h.clock.settle()
  assert.equal(
    indicator.calls.onTurnCompleted.length,
    before,
    '삭제된 target의 pending이 남아 done만으로 새로 고치면 안 된다',
  )

  // 대조: 재생성된 target의 실제 working→done은 여전히 1회 호출한다.
  worktreeEvent(h, 'w1', 'working', t0 + 2000)
  await h.clock.settle()
  worktreeEvent(h, 'w1', 'done', t0 + 3000)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, before + 1)
})

test('pendingRealTurn: catalog 재구성으로 target이 삭제되면 정리된다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  const indicator = h.titleIndicators[0]

  const t0 = h.clock.now()
  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()

  // catalog에서 사라지면 complete tick에서 target이 삭제된다.
  h.observer.state.rows = []
  await h.clock.advance(h.tickMs)
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 0)

  // 같은 key가 다시 나타나 재생성된다.
  h.observer.state.rows = [makeRow()]
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).worktreeId, 'w1')

  const before = indicator.calls.onTurnCompleted.length
  worktreeEvent(h, 'w1', 'done', t0 + 1000)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, before)
})

// ---------------------------------------------------------------------------
// 22. 진단 기록: event_unresolved / target_reset / first_done_ignored
// ---------------------------------------------------------------------------

const EVENT_KEY_SEP = '\u0000'
const eventKey = (worktreeId, paneKey) => `${worktreeId}${EVENT_KEY_SEP}${paneKey}`

function unresolvedEvents(h, code) {
  return h.diagEvents.filter(
    (entry) => entry.event === 'event_unresolved' && (code === undefined || entry.code === code),
  )
}

test('event_unresolved: id가 없는 payload는 invalid_payload를 targetId 없이 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  sendEvent(h, { state: 'working', receivedAt: h.clock.now() })
  await h.clock.settle()

  const recorded = unresolvedEvents(h)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'invalid_payload')
  assert.equal(recorded[0].targetId, undefined)
})

test('event_unresolved: catalog에 정확히 1개 매칭이 없으면 no_match를 기록한다', async () => {
  const h = createHarness({
    terminals: [makeRow({ worktreeId: 'other', paneKey: 'tab:other' })],
  })
  await startHarness(h)

  worktreeEvent(h, 'w1', 'working', h.clock.now())
  await h.clock.settle(3)

  const recorded = unresolvedEvents(h, 'no_match')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].targetId, eventKey('w1', 'tab:leaf'))
})

test('event_unresolved: key는 얻었지만 target이 없으면 no_target을 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)
  // catalog row(w1)와 다른 key를 돌려줘 reconcileCatalog로도 target이 만들어지지 않게 한다.
  h.observer.resolveEvent = () => ({
    worktreeId: 'ghost',
    paneKey: 'tab:leaf',
    handle: 'h1',
    ptyId: 'pty1',
    incarnationId: 'inc1',
  })

  worktreeEvent(h, 'w1', 'working', h.clock.now())
  await h.clock.settle()

  const recorded = unresolvedEvents(h, 'no_target')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].targetId, eventKey('w1', 'tab:leaf'))
  // 이벤트가 target 상태를 만들지 않았음을 확인한다.
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 1)
  assert.equal(viewTerminal(h).worktreeId, 'w1')
})

test('event_unresolved: 같은 (targetId, code)는 60초 안에 1회만 기록하고 이후 다시 기록한다', async () => {
  const h = createHarness({
    terminals: [makeRow({ worktreeId: 'other', paneKey: 'tab:other' })],
  })
  await startHarness(h)

  worktreeEvent(h, 'w1', 'working', h.clock.now())
  await h.clock.settle(3)
  assert.equal(unresolvedEvents(h, 'no_match').length, 1)

  worktreeEvent(h, 'w1', 'done', h.clock.now() + 1)
  await h.clock.settle(3)
  assert.equal(unresolvedEvents(h, 'no_match').length, 1, '60초 안 중복은 버린다')

  h.clock.jumpWall(60001)
  worktreeEvent(h, 'w1', 'working', h.clock.now())
  await h.clock.settle(3)
  assert.equal(unresolvedEvents(h, 'no_match').length, 2, '60초가 지나면 다시 기록한다')
})

test('target_reset: incarnationId가 바뀌면 incarnation_changed를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  h.observer.state.rows = [makeRow({ incarnationId: 'inc2' })]
  await h.clock.advance(h.tickMs)

  const recorded = h.diagEvents.filter((entry) => entry.event === 'target_reset')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'incarnation_changed')
  assert.equal(recorded[0].targetId, eventKey('w1', 'tab:leaf'))
})

test('target_reset: ptyId가 바뀌면 pty_changed를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  h.observer.state.rows = [makeRow({ ptyId: 'pty2' })]
  await h.clock.advance(h.tickMs)

  const recorded = h.diagEvents.filter((entry) => entry.event === 'target_reset')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'pty_changed')
})

test('target_reset: handle만 바뀌면 handle_changed를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  h.observer.state.rows = [makeRow({ handle: 'h2' })]
  await h.clock.advance(h.tickMs)

  const recorded = h.diagEvents.filter((entry) => entry.event === 'target_reset')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'handle_changed')
})

test('target_reset: 행이 그대로면 기록하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)

  await h.clock.advance(h.tickMs)

  assert.equal(h.diagEvents.filter((entry) => entry.event === 'target_reset').length, 0)
})

test('first_done_ignored: working 없이 도착한 첫 done은 NO_FRESH_TURN으로 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  worktreeEvent(h, 'w1', 'done', h.clock.now())
  await h.clock.settle()

  const recorded = h.diagEvents.filter((entry) => entry.event === 'first_done_ignored')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].code, 'NO_FRESH_TURN')
  assert.equal(recorded[0].targetId, eventKey('w1', 'tab:leaf'))
  assert.notEqual(viewTerminal(h).phase, 'ARMED')
})

test('first_done_ignored: working을 본 뒤의 done은 기록하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)

  await arm(h, h.clock.now())

  assert.equal(h.diagEvents.filter((entry) => entry.event === 'first_done_ignored').length, 0)
  assert.equal(viewTerminal(h).phase, 'ARMED')
})

// ---------------------------------------------------------------------------
// 23. epoch 메모리(렐로드 예약 저장·복원)
// ---------------------------------------------------------------------------

const EPOCH_KEY = eventKey('w1', 'tab:leaf')
const EPOCH_MAX_AGE = 3600000

test('epochMemory: bootstrap에서 load 뒤 1시간 prune을 호출한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h = createHarness({ epochMemory })
  await startHarness(h)

  assert.equal(epochMemory.calls.load, 1)
  assert.deepEqual(epochMemory.calls.prune, [EPOCH_MAX_AGE])
})

test('epochMemory: 첫 done 뒤 ARMED이면 remember한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h = createHarness({ epochMemory })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)

  assert.equal(viewTerminal(h).phase, 'ARMED')
  const remembered = epochMemory.calls.remember.filter((call) => call.key === EPOCH_KEY)
  assert.equal(remembered.length, 1)
  assert.deepEqual(remembered[0].record, {
    userDataKey: 'key-p',
    profileId: 'p1',
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    doneAt: t0 + 1000,
  })
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)
})

test('epochMemory: working으로 BUSY가 되면 forget한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h = createHarness({ epochMemory })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)

  const forgetBefore = epochMemory.calls.forget.length
  worktreeEvent(h, 'w1', 'working', t0 + 2000)
  await h.clock.settle()

  assert.equal(viewTerminal(h).phase, 'BUSY')
  assert.ok(epochMemory.calls.forget.length > forgetBefore)
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
})

test('epochMemory: 같은 ptyId·incarnationId target은 새 인스턴스에서 ARMED로 복원하고 진단을 남긴다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const doneAt = t0 + 1000
  assert.equal(viewTerminal(h1).phase, 'ARMED')
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory })
  await startHarness(h2)

  const term = viewTerminal(h2)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, doneAt + TTL_5M)
  assert.equal(term.dueAt, doneAt + TTL_5M - MARGIN_5M)

  const restored = h2.diagEvents.filter((entry) => entry.event === 'epoch_restored')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].targetId, EPOCH_KEY)
  assert.equal(restored[0].code, undefined)
})

test('epochMemory: incarnationId가 달라도(Orca 재시작) 같은 ptyId면 복원하고 incarnation_changed를 남긴다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const doneAt = t0 + 1000
  await h1.coordinator.stop()
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)

  const forgetBefore = epochMemory.calls.forget.length
  const h2 = createHarness({
    epochMemory,
    terminals: [makeRow({ incarnationId: 'inc2' })],
  })
  await startHarness(h2)

  const term = viewTerminal(h2)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, doneAt + TTL_5M)
  assert.equal(term.dueAt, doneAt + TTL_5M - MARGIN_5M)
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)
  assert.equal(epochMemory.calls.forget.length, forgetBefore)

  const restored = h2.diagEvents.filter((entry) => entry.event === 'epoch_restored')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].targetId, EPOCH_KEY)
  assert.equal(restored[0].code, 'incarnation_changed')

  // 복원 뒤 syncEpochMemory가 새 incarnationId로 다시 remember한다.
  const remembered = epochMemory.calls.remember.filter((call) => call.key === EPOCH_KEY)
  assert.equal(remembered[remembered.length - 1].record.incarnationId, 'inc2')
})

test('epochMemory: ptyId가 다르면 복원하지 않고 forget한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  await arm(h1, h1.clock.now())
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory, terminals: [makeRow({ ptyId: 'pty2' })] })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'UNKNOWN')
  assert.ok(epochMemory.calls.forget.includes(EPOCH_KEY))
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)
})

test('epochMemory: doneAt이 1시간 이상 지났으면 복원하지 않고 forget한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const now = 1000000
  epochMemory.store.set(EPOCH_KEY, {
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    userDataKey: 'key-p',
    profileId: 'p1',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    doneAt: now - EPOCH_MAX_AGE,
    savedAt: 1,
  })
  const h = createHarness({ epochMemory })
  await startHarness(h)

  assert.equal(viewTerminal(h).phase, 'UNKNOWN')
  assert.ok(epochMemory.calls.forget.includes(EPOCH_KEY))
  assert.equal(h.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)
})

test('epochMemory: catalog에서 사라진 target과 worktree 제거 시 forget한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h = createHarness({ epochMemory })
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)

  h.coordinator.onWorktreeRemoved({ worktreeId: 'w1' })
  await h.clock.settle()
  assert.equal(epochMemory.calls.forget.includes(EPOCH_KEY), true)
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
})

test('epochMemory 미제공 시 기존 동작(복원 없음, 오류 없음)', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())

  assert.equal(viewTerminal(h).phase, 'ARMED')
  await h.coordinator.stop()
})

test('epochMemory: incarnationId null도 remember되고 같은 ptyId·null로 복원된다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory, terminals: [makeRow({ incarnationId: null })] })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const doneAt = t0 + 1000
  assert.equal(viewTerminal(h1).phase, 'ARMED')

  const remembered = epochMemory.calls.remember.filter((call) => call.key === EPOCH_KEY)
  assert.equal(remembered.length, 1)
  assert.equal(remembered[0].record.incarnationId, null)
  assert.equal(remembered[0].record.ptyId, 'pty1')
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory, terminals: [makeRow({ incarnationId: null })] })
  await startHarness(h2)

  const term = viewTerminal(h2)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, doneAt + TTL_5M)
  assert.equal(term.dueAt, doneAt + TTL_5M - MARGIN_5M)
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 1)
})

test('epochMemory: 저장된 incarnationId null과 target inc1이 달라도 같은 ptyId면 복원하고 incarnation_changed를 남긴다', async () => {
  const epochMemory = createFakeEpochMemory()
  epochMemory.store.set(EPOCH_KEY, {
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    userDataKey: 'key-p',
    profileId: 'p1',
    ptyId: 'pty1',
    incarnationId: null,
    doneAt: 1000000,
    savedAt: 1,
  })
  // target은 incarnationId 'inc1'(기본 makeRow).
  const h = createHarness({ epochMemory })
  await startHarness(h)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, 1000000 + TTL_5M)
  assert.equal(term.dueAt, 1000000 + TTL_5M - MARGIN_5M)
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)

  const restored = h.diagEvents.filter((entry) => entry.event === 'epoch_restored')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].code, 'incarnation_changed')
})

test('epochMemory: needsReview scope는 복원하지 않고 forget하며 clearReview 뒤에도 전송하지 않는다', async () => {
  const epochMemory = createFakeEpochMemory()
  const hostCall = createHostCall()
  const h1 = createHarness({ epochMemory, hostCall })
  await startHarness(h1)
  await arm(h1, h1.clock.now())
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)
  await h1.coordinator.stop()

  // 같은 store를 공유해 검토 필요 상태를 영속시킨다.
  await h1.rawStore.markReview(SCOPE)
  assert.equal(h1.rawStore.getBudget(SCOPE).needsReview, true)

  const h2 = createHarness({ epochMemory, hostCall, store: h1.rawStore })
  await startHarness(h2)

  // needsReview이므로 복원하지 않고 저장 항목을 정리한다.
  assert.equal(viewTerminal(h2).phase, 'UNKNOWN')
  assert.ok(epochMemory.calls.forget.includes(EPOCH_KEY))
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)

  // 검토를 해제해도 새 working→done 없이는 전송하지 않는다.
  await h2.store.clearReview(SCOPE)
  h2.coordinator.onReviewCleared({ worktreeId: 'w1', paneKey: 'tab:leaf' })
  await h2.clock.advance(TTL_5M)
  assert.equal(h2.sendCalls.length, 0)
})

test('event_unresolved: catalog 재조회 실패는 catalog_failed를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)

  h.observer.state.onList = () => {
    throw new Error('catalog down')
  }
  worktreeEvent(h, 'ghost', 'working', h.clock.now())
  await h.clock.settle(3)

  const recorded = unresolvedEvents(h, 'catalog_failed')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].targetId, eventKey('ghost', 'tab:leaf'))
})
