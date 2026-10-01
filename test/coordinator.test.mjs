import test from 'node:test'
import assert from 'node:assert/strict'

import { createCoordinator } from '../src/coordinator.mjs'
import { createStateStore } from '../src/state-store.mjs'
import { createTitleIndicator } from '../src/title-indicator.mjs'
import { sendKeepalive } from '../src/guarded-send.mjs'
import { createDashboardModel } from '../src/dashboard-model.mjs'
import { CACHE_HISTORY_RETENTION_MS, TIMING } from '../src/contracts.mjs'
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
      source: 'index',
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
  if (!options.store) {
    // TTL은 이제 플러그인 config(claudeCacheTtlMs)에서 온다. store.load()가 읽도록
    // 저장 상태를 미리 심는다. 기본 5분, storeConfig/ttlMs 옵션으로 조정한다.
    const seedConfig =
      options.storeConfig ?? { schemaVersion: 2, claudeCacheTtlMs: options.ttlMs ?? TTL_5M }
    if (hostCall.storage && typeof hostCall.storage.set === 'function') {
      hostCall.storage.set('state-v1', {
        schemaVersion: 1,
        revision: 0,
        config: seedConfig,
        profiles: [],
      })
    }
  }

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
  // basisAt은 마지막 working 수신 시각(t0)이므로 완료 시각(t0+1000)이 아니다.
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)

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
  // 자체 턴도 마지막 working 수신 시각(turnAt)이 basisAt이다.
  assert.equal(term.expiresAt, turnAt + TTL_5M)
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

test('구 형태 enabled:false readSettings는 전송·스케줄에 영향을 주지 않는다', async () => {
  const h = createHarness({
    settings: { known: true, profileId: 'p1', enabled: false, source: 'index', readAt: 0 },
  })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  // TTL은 config(기본 5분)에서 오고, enabled=false는 무시된다.
  assert.equal(viewTerminal(h).expiresAt, t0 + TTL_5M)
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
})

test('설정 unknown이면 전송하지 않는다', async () => {
  const h = createHarness({ settings: { known: false, reason: 'index_missing', readAt: 0 } })
  await startHarness(h)
  await arm(h, h.clock.now())
  await h.clock.advance(TTL_5M + 1000)
  assert.equal(h.sendCalls.length, 0)
  assert.equal(h.coordinator.getRuntimeView().profileSettings.known, false)
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
    source: 'index',
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

test('assertAllowed: 프로필 mismatch면 STALE_TARGET', async () => {
  const { gates } = await runGateProbe(
    () => createHarness(),
    (h) => {
      h.settingsBox.value = {
        known: true,
        profileId: 'p2',
        source: 'index',
        readAt: 0,
      }
    },
  )
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], { allowed: false, reason: 'STALE_TARGET' })
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
  // skipped 전송은 예약을 소진하지 않아 다음 tick에서 다시 검사할 수 있다.
  // 상한 근거: skipUntil은 실패 tick + tickMs(2000ms)에 재시도를 허용하고
  // advanceToDue의 창은 dueAt + tickMs + 100ms이므로, due tick의 검사 1회와
  // 그다음 tick의 재시도 1회만 창 안에 든다(최대 2회, 1..2).
  assert.ok(gates.length >= 1 && gates.length <= 2, `gates=${gates.length}`)
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

test('assertAllowed: 전송 시작 뒤 config TTL이 바뀌면 다음 gate에서 STALE_TARGET으로 거절한다', async () => {
  const h = createHarness()
  const gates = []
  h.setSendBehavior(async (args) => {
    // gate1(예약 전): 전송 시작 시점의 TTL(5분)로는 허용된다.
    const first = await args.assertAllowed()
    gates.push(first)
    if (first.allowed !== true) {
      // 전제가 깨졌으면 조용히 넘어가지 않고 그대로 드러낸다.
      return {
        kind: 'skipped',
        reason: first.reason ?? 'GATE1',
        attemptId: null,
        at: h.clock.now(),
        framesSent: 0,
      }
    }
    // 예약 단계(guarded-send 3단계): attempt를 만들고 상태에 반영한다.
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    // 전송이 시작된 뒤(예: 다른 tick에서 설정 변경) TTL을 1시간으로 바꾼다.
    await h.store.updateConfig({ claudeCacheTtlMs: 3600000 })
    // gate2(예약 후, paste 전): 시작 시점 TTL과 달라졌으므로 거절된다.
    const second = await args.assertAllowed()
    gates.push(second)
    if (second.allowed !== true) {
      await args.journal.refuseAttempt(attemptId)
      return {
        kind: 'refused',
        reason: second.reason ?? 'STALE_TARGET',
        attemptId,
        at: h.clock.now(),
        framesSent: 0,
      }
    }
    return { kind: 'submitted', reason: null, attemptId, at: h.clock.now(), framesSent: 0 }
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)

  // 시작 시점 TTL로 gate1은 허용되고, 진행 중 TTL 변경 뒤 같은 전송의 다음 gate는 거절된다.
  assert.equal(gates.length, 2)
  assert.deepEqual(gates[0], { allowed: true, reason: null })
  assert.deepEqual(gates[1], { allowed: false, reason: 'STALE_TARGET' })

  // 거절은 paste 전에 확정돼 attempt가 폐기되고(중복 전송 없음) 다음 턴을 기다린다.
  assert.equal(h.sendCalls.length, 1)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  assert.equal(viewTerminal(h).reason, 'STALE_TARGET')
  assert.deepEqual(h.spy.confirmAttempt, [])
  assert.equal(h.store.getBudget(SCOPE).charged, 0)
})

test('assertAllowed: config TTL이 바뀌지 않으면 모든 gate를 허용한다', async () => {
  const h = createHarness()
  const gates = []
  h.setSendBehavior(async (args) => {
    const first = await args.assertAllowed()
    gates.push(first)
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    const second = await args.assertAllowed()
    gates.push(second)
    if (second.allowed !== true) {
      await args.journal.refuseAttempt(attemptId)
      return {
        kind: 'refused',
        reason: second.reason ?? 'GATE2',
        attemptId,
        at: h.clock.now(),
        framesSent: 0,
      }
    }
    // 실제 전송처럼 paste/submitted 단계까지 진행한다.
    await args.journal.recordAttempt(attemptId, 'pasted')
    args.onPhase?.('pasted', { attemptId })
    await args.journal.recordAttempt(attemptId, 'submitted')
    const at = h.clock.now()
    args.onPhase?.('submitted', { attemptId, at })
    return { kind: 'submitted', reason: null, attemptId, at, framesSent: 2 }
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)

  assert.equal(gates.length, 2)
  assert.deepEqual(gates[0], { allowed: true, reason: null })
  assert.deepEqual(gates[1], { allowed: true, reason: null })
  assert.equal(h.sendCalls.length, 1)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
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
  h.setSendBehavior(async (args) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => h.clock.setTimeout(resolve, 50))
    active -= 1
    // 실제 전송처럼 예약 단계를 거쳐 epoch를 소진한다(재시도로 인한 중복 제거).
    const attemptId = `probe-${args.target.worktreeId}`
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    return {
      kind: 'submitted',
      reason: null,
      attemptId,
      at: h.clock.now(),
      framesSent: 2,
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
  const sentWorktrees = new Set(h.sendCalls.map((call) => call.target.worktreeId))
  assert.deepEqual([...sentWorktrees].sort(), ['w1', 'w2', 'w3'])
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
  assert.equal('appTimer' in view, false, 'appTimer는 제거됐다')
  assert.deepEqual(view.profileSettings, {
    known: true,
    source: 'index',
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
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)
  assert.equal(term.expiresAt, t0 + TTL_5M)
})

test('config에 claudeCacheTtlMs가 없으면 기본 1시간을 쓴다', async () => {
  // 저장 config에 TTL이 없으면 parseConfig가 기본 1시간(3600000)을 채운다.
  const h = createHarness({ storeConfig: {} })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, t0 + 3600000)
  assert.equal(term.dueAt, t0 + 3600000 - 120000)
})

test('config TTL을 1h→5m로 바꾸면 ARMED due/expires를 재계산하고 마감이 지났으면 만료한다', async () => {
  const h = createHarness({ storeConfig: { schemaVersion: 2, claudeCacheTtlMs: 3600000 } })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  assert.equal(viewTerminal(h).expiresAt, t0 + 3600000)

  // 1시간 기준으로는 아직 due 전이지만, 5분 기준 마감(6분 전)은 이미 지났다.
  await h.clock.advance(7 * 60000)
  await h.store.updateConfig({ claudeCacheTtlMs: TTL_5M })
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'EXPIRED')
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(h.sendCalls.length, 0, '이미 지난 마감을 catch-up 전송하지 않는다')
})

test('config TTL 1h→5m 전환이 만료 전이면 새 due/expires로 예약한다', async () => {
  const h = createHarness({ storeConfig: { schemaVersion: 2, claudeCacheTtlMs: 3600000 } })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)

  await h.clock.advance(60000)
  await h.store.updateConfig({ claudeCacheTtlMs: TTL_5M })
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)
})

test('basisAt: working→working(도구)→done이면 예약 dueAt이 마지막 working 기준이다', async () => {
  const h = createHarness()
  await startHarness(h)

  const t0 = h.clock.now()
  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()

  // 도구 호출마다 오는 working 이벤트. 다음 API 요청 시작(≈마지막 working)이다.
  await h.clock.advance(100_000)
  const t1 = h.clock.now()
  worktreeEvent(h, 'w1', 'working', t1)
  await h.clock.settle()

  await h.clock.advance(60_000)
  const t2 = h.clock.now()
  worktreeEvent(h, 'w1', 'done', t2)
  await h.clock.settle()

  const term = viewTerminal(h)
  assert.equal(term.phase, 'ARMED')
  assert.equal(term.expiresAt, t1 + TTL_5M)
  assert.equal(term.dueAt, t1 + TTL_5M - MARGIN_5M)
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
    terminals: [makeRow({ supported: false, unsupportedReason: 'NO_AGENT', agentIdentity: null })],
  })
  await startHarness(h)
  const term = viewTerminal(h)
  assert.equal(term.supported, false)
  assert.equal(term.unsupportedReason, 'NO_AGENT')

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

test('U3: 프로필 unknown 전환은 epoch를 폐기하고, 복구돼도 새 turn 전에는 전송하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.equal(viewTerminal(h).phase, 'ARMED')

  // known → unknown 전환.
  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  assert.equal(viewTerminal(h).reason, 'SETTINGS_UNKNOWN')

  // 같은 프로필로 복구돼도(만료 전) 옛 epoch가 살아나지 않는다.
  h.settingsBox.value = {
    known: true,
    profileId: 'p1',
    source: 'index',
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
// 19. 탭 제목 ⚡ 표시기 연결
// ---------------------------------------------------------------------------

test('title indicator: 옵션 off면 매 tick reconcile([])를 호출한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const indicator = h.titleIndicators[0]
  assert.ok(indicator, 'rpc 준비 후 표시기를 생성해야 한다')
  assert.equal(indicator.calls.load, 1, 'load를 1회 호출한다')

  // 기본값은 true이므로 명시적으로 끄고 off 동작을 검증한다.
  await h.store.updateConfig({ tabTitleIndicator: false })
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
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: true, cacheState: 'none' },
  ])
})

test('title indicator: paused이거나 프로필 unknown이면 on=false', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })

  await h.store.setPaused(true)
  await h.clock.advance(h.tickMs)
  let desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.deepEqual(desired, [
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: false, cacheState: 'none' },
  ])

  await h.store.setPaused(false)
  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)
  desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.equal(desired.length, 1)
  assert.equal(desired[0].on, false)
})

test('title indicator: 표시 on은 Orca 타이머 enabled/ttl과 무관하다', async () => {
  const h = createHarness({
    settings: {
      known: true,
      profileId: 'p1',
      enabled: false,
      ttlMs: 3600000,
      source: 'index',
      readAt: 0,
    },
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await h.clock.advance(h.tickMs)

  const desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.deepEqual(desired, [
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: true, cacheState: 'none' },
  ])
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
  assert.equal(titleRpc.titles.get('h1'), '💤 Terminal 1')

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
  assert.equal(titleRpc.titles.get('h1'), '💤 Terminal 1')
  assert.equal(titleRpc.titles.get('h2'), '💤 Terminal 1')

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

test('title indicator: 실제 턴 완료에도 onTurnCompleted를 호출하지 않는다(§2-6)', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  const indicator = h.titleIndicators[0]

  // 실제(사람) 턴 완료 → refresh rename을 위한 onTurnCompleted는 더 이상 호출하지 않는다.
  await arm(h, h.clock.now())
  assert.deepEqual(indicator.calls.onTurnCompleted, [])

  // 자체 keepalive 턴 완료도 마찬가지다.
  await advanceToDue(h)
  assert.equal(viewTerminal(h).phase, 'AWAITING_TURN')
  const turnAt = h.clock.now() + 100
  worktreeEvent(h, 'w1', 'working', turnAt)
  await h.clock.settle()
  worktreeEvent(h, 'w1', 'done', turnAt + 100)
  await h.clock.settle()
  assert.deepEqual(indicator.calls.onTurnCompleted, [])
})

test('cacheState: BUSY→ARMED 동안 같은 기호(⚡)로는 rename하지 않는다', async () => {
  const rows = [makeRow()]
  const titleRpc = createTitleIndicatorRpc(rows)
  const h = createHarness({
    terminals: rows,
    rpc: titleRpc.rpc,
    createTitleIndicator: (deps) => createTitleIndicator({ ...deps, settleMs: 0 }),
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })

  // 실제 작업 시작(BUSY) → projection cacheState는 kept(⚡).
  const t0 = h.clock.now()
  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.advance(h.tickMs)
  await h.clock.settle(5)
  assert.equal(titleRpc.titles.get('h1'), '⚡ Terminal 1')
  const renamesAfterBusy = titleRpc.renames.length

  // done → ARMED도 kept이므로 같은 기호 rename은 일어나지 않는다.
  worktreeEvent(h, 'w1', 'done', t0 + 1000)
  await h.clock.advance(h.tickMs)
  await h.clock.settle(5)
  assert.equal(viewTerminal(h).phase, 'ARMED')
  assert.equal(titleRpc.titles.get('h1'), '⚡ Terminal 1')
  assert.equal(titleRpc.renames.length, renamesAfterBusy, 'ARMED 전환은 같은 기호라 rename 0')
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
    { worktreeId: 'w1', tabId: 'tab', leafId: 'leaf', handle: 'h1', on: false, cacheState: 'none' },
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
// 21. 제목 refresh rename 제거: target 삭제·재생성과 무관하게 onTurnCompleted 없음
// ---------------------------------------------------------------------------

test('title refresh 제거: target 삭제·재생성 뒤 done에도 onTurnCompleted를 호출하지 않는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  const indicator = h.titleIndicators[0]

  const t0 = h.clock.now()
  // 실제(사람) 턴 시작만 관측하고 done은 아직 없다.
  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()

  // target 제거(worktree 삭제) 후 같은 key가 catalog로 다시 생성된다.
  h.coordinator.onWorktreeRemoved({ worktreeId: 'w1' })
  await h.clock.settle()
  assert.equal(h.coordinator.getRuntimeView().worktrees.length, 0)

  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).worktreeId, 'w1')

  // done 이후에도 onTurnCompleted는 호출되지 않는다(제목은 tick reconcile이 담당).
  worktreeEvent(h, 'w1', 'done', t0 + 1000)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, 0)

  worktreeEvent(h, 'w1', 'working', t0 + 2000)
  await h.clock.settle()
  worktreeEvent(h, 'w1', 'done', t0 + 3000)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, 0)
})

test('title refresh 제거: catalog 재구성으로 target이 삭제·재생성돼도 onTurnCompleted가 없다', async () => {
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

  worktreeEvent(h, 'w1', 'done', t0 + 1000)
  await h.clock.settle()
  assert.equal(indicator.calls.onTurnCompleted.length, 0)
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
    kind: 'armed',
    userDataKey: 'key-p',
    profileId: 'p1',
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    doneAt: t0 + 1000,
    basisAt: t0,
    expiresAt: t0 + TTL_5M,
    lastBlockReason: null,
    expiredAt: null,
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
  // 복원 시에도 basisAt(마지막 working t0)이 doneAt(t0+1000)보다 우선한다.
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)

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
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)
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
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)
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

test('epochMemory: needsReview scope는 예약을 복원하지 않고 이력으로 낮추며 clearReview 뒤에도 전송하지 않는다', async () => {
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

  // 예약은 되살리지 않지만 표시 이력은 복원한다(저장 레코드는 history로 낮춘다).
  assert.equal(viewTerminal(h2).phase, 'SUSPENDED')
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
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

// ---------------------------------------------------------------------------
// 24. cacheHistory: 표시 전용 캐시 관측 이력(§2-3, 작업 G)
// ---------------------------------------------------------------------------

test('cacheHistory: fresh working→done에서 OPEN하고 expiresAt을 계산한다', async () => {
  const h = createHarness()
  await startHarness(h)
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)

  const t0 = h.clock.now()
  await arm(h, t0)

  const hist = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  assert.equal(hist.epochId, 1)
  assert.equal(hist.doneAt, t0 + 1000)
  assert.equal(hist.basisAt, t0)
  assert.equal(hist.expiresAt, t0 + TTL_5M)
  assert.equal(hist.lastBlockReason, null)
  assert.equal(hist.expiredAt, null)
})

test('cacheHistory: due 이후 DRAFT_PRESENT 반복 skip은 유지하고 다른 이유로 교체한다', async () => {
  const h = createHarness()
  let skipReason = 'DRAFT_PRESENT'
  h.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: skipReason,
    attemptId: null,
    at: h.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)

  assert.ok(h.sendCalls.length >= 1)
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason, 'DRAFT_PRESENT')

  // 같은 reason이 반복돼도 마지막 차단 이유는 유지된다.
  await h.clock.advance(h.tickMs * 2)
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason, 'DRAFT_PRESENT')

  // 다른 이유가 오면 교체된다.
  skipReason = 'OUTPUT_ACTIVE'
  await h.clock.advance(h.tickMs)
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason, 'OUTPUT_ACTIVE')
})

test('cacheHistory: 새 턴 뒤 도착한 옛 skipped 결과는 이력을 오염시키지 않는다', async () => {
  const h = createHarness()
  let release = null
  h.setSendBehavior(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            kind: 'skipped',
            reason: 'DRAFT_PRESENT',
            attemptId: null,
            at: h.clock.now(),
            framesSent: 0,
          })
      }),
  )
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  assert.equal(h.sendCalls.length, 1)
  assert.ok(h.coordinator.__debugCacheHistory(EPOCH_KEY))

  // 전송이 진행 중인 사이 새 실제 working 턴이 관측된다 → CLEAR.
  worktreeEvent(h, 'w1', 'working', h.clock.now() + 100)
  await h.clock.settle()
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)

  // 뒤늦게 옛 skipped 결과가 도착해도 이력은 다시 생기지 않는다.
  release()
  await h.clock.settle()
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

test('cacheHistory: 10초 조기 EXPIRE에는 expiredAt이 없고 실제 만료 tick에서 확정한다', async () => {
  const h = createHarness()
  // 전송은 항상 안전 skip으로 두어 예약만 소진하고 phase는 ARMED로 유지한다.
  h.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: 'OUTPUT_ACTIVE',
    attemptId: null,
    at: h.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const expiresAt = t0 + TTL_5M

  // expiresAt 10초 전을 지나 다음 tick에서 조기 EXPIRE가 일어난다.
  await h.clock.advance(expiresAt - TIMING.minimumRemainingMs - h.clock.now() + h.tickMs)
  assert.equal(viewTerminal(h).phase, 'EXPIRED')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).expiredAt, null)

  // 실제 expiresAt을 지나면 tick의 ADVANCE가 expiredAt을 확정한다.
  await h.clock.advance(TIMING.minimumRemainingMs + h.tickMs * 2)
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).expiredAt, expiresAt)
})

test('cacheHistory: 새 실제 working은 이력을 CLEAR한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  assert.ok(h.coordinator.__debugCacheHistory(EPOCH_KEY))

  worktreeEvent(h, 'w1', 'working', t0 + 2000)
  await h.clock.settle()

  assert.equal(viewTerminal(h).phase, 'BUSY')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

test('cacheHistory: blocked/waiting으로 예약이 취소돼도 이력은 남기고 차단 원인을 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  worktreeEvent(h, 'w1', 'waiting', t0 + 2000)
  await h.clock.settle()

  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  // 대기 직전 ARMED 예약의 epoch id·만료 시각은 그대로 두고 차단 원인만 남긴다.
  const after = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.epochId, before.epochId)
  assert.equal(after.expiresAt, before.expiresAt)
  assert.equal(after.lastBlockReason, 'INTERACTIVE_WAIT')
})

test('cacheHistory: 정책 폐기(POLICY_INVALIDATED)는 이력을 남기고 폐기 사유를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)

  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  const after = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.epochId, before.epochId)
  assert.equal(after.lastBlockReason, 'SETTINGS_UNKNOWN')
})

test('cacheHistory: SEND_REFUSED로 예약이 취소돼도 이력은 남는다', async () => {
  const h = createHarness()
  h.setSendBehavior(async (args) => {
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    await args.journal.refuseAttempt(attemptId)
    return { kind: 'refused', reason: 'OUTPUT_ACTIVE', attemptId, at: h.clock.now(), framesSent: 0 }
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  await advanceToDue(h)

  assert.equal(viewTerminal(h).phase, 'SUSPENDED')
  assert.deepEqual(h.coordinator.__debugCacheHistory(EPOCH_KEY), before)
})

test('cacheHistory: CLOCK_GAP으로 예약이 취소돼도 이력은 남는다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  h.clock.jumpWall(20000)
  await h.clock.advance(h.tickMs)

  assert.equal(viewTerminal(h).phase, 'EXPIRED')
  assert.deepEqual(h.coordinator.__debugCacheHistory(EPOCH_KEY), before)
})

test('cacheHistory: due 이후 정책 차단 사유를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  await h.store.setWorktree({ userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1' }, false)
  await advanceToDue(h)

  assert.equal(viewTerminal(h).phase, 'ARMED')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason, 'SCOPE_DISABLED')
})

test('cacheHistory: catalog 불완전으로 due 전송이 막히면 CATALOG_INCOMPLETE를 기록한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())

  h.observer.state.complete = false
  await h.clock.advance(h.tickMs)
  await advanceToDue(h)

  assert.equal(h.sendCalls.length, 0)
  assert.equal(
    h.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason,
    'CATALOG_INCOMPLETE',
  )
})

test('cacheHistory: config TTL이 바뀌면 살아 있는 이력을 RETIME한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.equal(before.expiresAt, t0 + TTL_5M)

  await h.store.updateConfig({ claudeCacheTtlMs: 3600000 })
  await h.clock.advance(h.tickMs)

  const after = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.equal(after.epochId, before.epochId)
  assert.equal(after.expiresAt, t0 + 3600000)
})

test('cacheHistory: TTL은 readSettings가 아니라 config에서 온다', async () => {
  // config는 1시간인데 readSettings(구 형태)가 5분 ttlMs를 줘도 무시한다.
  const h = createHarness({
    ttlMs: 3600000,
    settings: { known: true, profileId: 'p1', ttlMs: TTL_5M, source: 'index', readAt: 0 },
  })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)

  const hist = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  assert.equal(hist.expiresAt, t0 + 3600000)
  assert.equal(viewTerminal(h).expiresAt, t0 + 3600000)
})

test('cacheHistory: 만료 후 24시간이 지나면 이력을 지운다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const hist = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)

  // wall/mono를 함께 점프해 clock gap으로 오인되지 않게 한 뒤 tick을 1회 진행한다.
  const jump = hist.expiresAt + CACHE_HISTORY_RETENTION_MS - h.clock.now() + h.tickMs
  h.clock.jumpWall(jump)
  h.clock.jumpMono(jump)
  await h.clock.advance(h.tickMs)

  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

test('cacheHistory: ptyId가 바뀌면 이력을 지운다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.ok(h.coordinator.__debugCacheHistory(EPOCH_KEY))

  h.observer.state.rows = [makeRow({ ptyId: 'pty2' })]
  await h.clock.advance(h.tickMs)

  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

test('cacheHistory: handle만 바뀌면 이력을 보존한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  h.observer.state.rows = [makeRow({ handle: 'h2' })]
  await h.clock.advance(h.tickMs)

  assert.deepEqual(h.coordinator.__debugCacheHistory(EPOCH_KEY), before)
})

test('cacheHistory: incarnationId만 바뀌면 이력을 보존한다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  h.observer.state.rows = [makeRow({ incarnationId: 'inc2' })]
  await h.clock.advance(h.tickMs)

  assert.deepEqual(h.coordinator.__debugCacheHistory(EPOCH_KEY), before)
})

test('cacheHistory: catalog에서 target이 사라지면 이력도 함께 사라진다', async () => {
  const h = createHarness()
  await startHarness(h)
  await arm(h, h.clock.now())
  assert.ok(h.coordinator.__debugCacheHistory(EPOCH_KEY))

  h.observer.state.rows = []
  await h.clock.advance(h.tickMs)

  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

// ---------------------------------------------------------------------------
// 25. epochMemory: 만료 이력 영속·복원(작업 I)
// ---------------------------------------------------------------------------

test('epochMemoryI: 플러그인 재시작 후 만료 이력(EXPIRED·원인·시각)을 그대로 복원한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  h1.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: 'DRAFT_PRESENT',
    attemptId: null,
    at: h1.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const expiresAt = t0 + TTL_5M
  await advanceToDue(h1)
  assert.ok(h1.sendCalls.length >= 1)
  assert.equal(h1.coordinator.__debugCacheHistory(EPOCH_KEY).lastBlockReason, 'DRAFT_PRESENT')

  // 실제 expiresAt을 지나 ADVANCE가 expiredAt을 확정한다.
  await h1.clock.advance(expiresAt - h1.clock.now() + h1.tickMs)
  const before = h1.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.equal(before.expiredAt, expiresAt)
  assert.equal(before.lastBlockReason, 'DRAFT_PRESENT')
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'EXPIRED')
  const after = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.expiresAt, expiresAt)
  assert.equal(after.expiredAt, expiresAt)
  assert.equal(after.lastBlockReason, 'DRAFT_PRESENT')
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)
})

test('epochMemoryI: 같은 ptyId·새 incarnationId(Orca 재시작)에서도 만료 이력을 복원한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  h1.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: 'OUTPUT_ACTIVE',
    attemptId: null,
    at: h1.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const expiresAt = t0 + TTL_5M
  await advanceToDue(h1)
  await h1.clock.advance(expiresAt - h1.clock.now() + h1.tickMs)
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory, terminals: [makeRow({ incarnationId: 'inc2' })] })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'EXPIRED')
  const after = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.expiredAt, expiresAt)
  assert.equal(after.lastBlockReason, 'OUTPUT_ACTIVE')
})

test('epochMemoryI: 오프라인 중 만료(재시작 전 expiresAt 경과)는 EXPIRED로 낮추고 전송하지 않는다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  const expiresAt = t0 + TTL_5M
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'armed')
  await h1.coordinator.stop()

  // 재시작 전에 expiresAt이 지나도록 시각을 진행한다.
  const h2 = createHarness({
    epochMemory,
    clock: createFakeClock({ start: expiresAt + 1000 }),
  })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'EXPIRED')
  const after = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.expiredAt, expiresAt)
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)

  await h2.clock.advance(TTL_5M * 2)
  assert.equal(h2.sendCalls.length, 0)
})

test('epochMemoryI: 저장된 history와 ptyId가 다르면 복원을 거절하고 forget한다', async () => {
  const epochMemory = createFakeEpochMemory()
  epochMemory.store.set(EPOCH_KEY, {
    kind: 'history',
    userDataKey: 'key-p',
    profileId: 'p1',
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    doneAt: 1000000,
    basisAt: 1000000,
    expiresAt: 1000000 + TTL_5M,
    lastBlockReason: 'DRAFT_PRESENT',
    expiredAt: null,
    savedAt: 1,
  })
  const h = createHarness({ epochMemory, terminals: [makeRow({ ptyId: 'pty2' })] })
  await startHarness(h)

  assert.equal(viewTerminal(h).phase, 'UNKNOWN')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
  assert.ok(epochMemory.calls.forget.includes(EPOCH_KEY))
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
})

test('epochMemoryI: 열린 attempt는 예약 복원만 차단하고 이력으로 낮춘다', async () => {
  const epochMemory = createFakeEpochMemory()
  const hostCall = createHostCall()
  const h1 = createHarness({ epochMemory, hostCall })
  await startHarness(h1)
  await arm(h1, h1.clock.now())
  await h1.coordinator.stop()

  const attemptId = await h1.rawStore.reserveAttempt(
    {
      userDataKey: 'key-p',
      profileId: 'p1',
      worktreeId: 'w1',
      paneKey: 'tab:leaf',
      ptyId: 'pty1',
      runtimeId: 'rt1',
    },
    1,
    h1.clock.now(),
  )
  await h1.rawStore.recordAttempt(attemptId, 'pasted')
  assert.equal(h1.rawStore.getBudget(SCOPE).lastAttempt.phase, 'pasted')

  const h2 = createHarness({ epochMemory, hostCall, store: h1.rawStore })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'SUSPENDED')
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
  assert.equal(h2.diagEvents.filter((entry) => entry.event === 'epoch_restored').length, 0)

  await h2.clock.advance(TTL_5M)
  assert.equal(h2.sendCalls.length, 0)
})

test('epochMemoryI: history 레코드는 재시작 후 due가 지나도 전송 예약을 만들지 않는다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  // 만료 전 예약 취소(blocked/waiting): phase SUSPENDED, 이력은 남는다.
  worktreeEvent(h1, 'w1', 'waiting', t0 + 2000)
  await h1.clock.settle()
  assert.equal(viewTerminal(h1).phase, 'SUSPENDED')
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')
  assert.equal(epochMemory.store.get(EPOCH_KEY).expiredAt, null)
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory })
  await startHarness(h2)

  assert.equal(viewTerminal(h2).phase, 'SUSPENDED')
  assert.equal(viewTerminal(h2).dueAt, null)
  const hist = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  // 대기(hold) 중 기록한 INTERACTIVE_WAIT 차단 원인도 함께 복원된다.
  assert.equal(hist.lastBlockReason, 'INTERACTIVE_WAIT')

  await h2.clock.advance(t0 + TTL_5M - h2.clock.now() + h2.tickMs * 2)
  assert.equal(h2.sendCalls.length, 0)
})

test('epochMemoryI: 복원된 history 뒤 fresh working→done은 새 ARMED와 새 이력을 만든다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  worktreeEvent(h1, 'w1', 'waiting', t0 + 2000)
  await h1.clock.settle()
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory })
  await startHarness(h2)
  assert.equal(viewTerminal(h2).phase, 'SUSPENDED')
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')

  const t1 = h2.clock.now()
  await arm(h2, t1)

  assert.equal(viewTerminal(h2).phase, 'ARMED')
  const hist = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  assert.equal(hist.doneAt, t1 + 1000)
  assert.equal(hist.expiresAt, t1 + TTL_5M)
  assert.equal(hist.lastBlockReason, null)
  assert.equal(hist.expiredAt, null)
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'armed')
})

test('epochMemoryI: 만료 후 24시간이 지나면 이력과 저장 레코드를 함께 지운다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h = createHarness({ epochMemory })
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const expiresAt = t0 + TTL_5M
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)

  // wall/mono를 함께 점프해 clock gap으로 오인되지 않게 한 뒤 tick을 1회 진행한다.
  const jump = expiresAt + CACHE_HISTORY_RETENTION_MS - h.clock.now() + h.tickMs
  h.clock.jumpWall(jump)
  h.clock.jumpMono(jump)
  await h.clock.advance(h.tickMs)

  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
  assert.equal(epochMemory.store.has(EPOCH_KEY), false)
})

// ---------------------------------------------------------------------------
// 26. 캐시 상태 projection·표시 gate (작업 J)
// ---------------------------------------------------------------------------

test('getRuntimeView: 캐시 표시 필드와 dueAt(실행 가능한 예약일 때만)', async () => {
  const h = createHarness()
  await startHarness(h)

  // 관측 전(초기 UNKNOWN): 유지 예약 없음.
  let term = viewTerminal(h)
  assert.equal(term.cacheState, 'none')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.indicatorOn, true)
  assert.equal(term.dueAt, null)
  assert.equal(term.expiresAt, null)
  assert.equal(term.expiredAt, null)
  assert.equal(term.expireCause, null)
  assert.equal(term.blockedReason, null)

  // fresh working→done: 유지 중(예약 실행 가능).
  const t0 = h.clock.now()
  await arm(h, t0)
  term = viewTerminal(h)
  assert.equal(term.cacheState, 'kept')
  assert.equal(term.cacheStatus, 'scheduled')
  assert.equal(term.dueAt, t0 + TTL_5M - MARGIN_5M)
  assert.equal(term.expiresAt, t0 + TTL_5M)
  assert.equal(term.expiredAt, null)

  // due 전송 뒤(AWAITING_TURN): 유지 중이지만 dueAt은 더 이상 실행 예약이 아니다.
  await advanceToDue(h)
  term = viewTerminal(h)
  assert.equal(term.cacheState, 'kept')
  assert.equal(term.cacheStatus, 'awaiting-turn')
  assert.equal(term.dueAt, null)
  assert.equal(term.expiresAt, t0 + TTL_5M)
})

test('getRuntimeView: 10초 cutoff는 no-reservation+expiresAt, 실제 만료 뒤에는 expired+expireCause', async () => {
  const h = createHarness()
  h.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: 'DRAFT_PRESENT',
    attemptId: null,
    at: h.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const expiresAt = t0 + TTL_5M
  await advanceToDue(h)

  // 10초 조기 EXPIRE 구간: 아직 실제 만료 전이므로 예약 없음 · 만료 예정(expiresAt 유지).
  await h.clock.advance(expiresAt - TIMING.minimumRemainingMs - h.clock.now() + h.tickMs)
  let term = viewTerminal(h)
  assert.equal(term.phase, 'EXPIRED')
  assert.equal(term.cacheState, 'none')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.expiresAt, expiresAt)
  assert.equal(term.expiredAt, null)
  assert.equal(term.blockedReason, 'DRAFT_PRESENT')
  assert.equal(term.expireCause, null)

  // 실제 expiresAt 경과: 만료 확정, 원인 노출.
  await h.clock.advance(TIMING.minimumRemainingMs + h.tickMs * 2)
  term = viewTerminal(h)
  assert.equal(term.cacheState, 'none')
  assert.equal(term.cacheStatus, 'expired')
  assert.equal(term.expiresAt, expiresAt)
  assert.equal(term.expiredAt, expiresAt)
  assert.equal(term.expireCause, 'DRAFT_PRESENT')

  // 제목 표시기에도 같은 none이 공급된다.
  const desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.equal(desired[0].cacheState, 'none')
})

test('getRuntimeView: ARMED→waiting은 원래 예약을 승계해 kept/interactive-wait', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  worktreeEvent(h, 'w1', 'waiting', t0 + 2000)
  await h.clock.settle()

  // 대기 전송은 금지되지만, 대기 직전 관측한 예약은 아직 만료 전이므로 유지 중이다.
  const term = viewTerminal(h)
  assert.equal(term.phase, 'SUSPENDED')
  assert.equal(term.cacheState, 'kept')
  assert.equal(term.cacheStatus, 'interactive-wait')
  assert.equal(term.expiresAt, t0 + TTL_5M)

  // hold는 기존 epoch의 id·기준 시각을 승계하므로 이력은 다시 OPEN되지 않는다.
  const after = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.epochId, before.epochId)
  assert.equal(after.expiresAt, before.expiresAt)
  assert.equal(after.lastBlockReason, 'INTERACTIVE_WAIT')
})

test('getRuntimeView: hold 근거 없는 waiting은 none/interactive-wait', async () => {
  const h = createHarness()
  await startHarness(h)

  // seenWorking 없이 곧바로 대기: 승계할 캐시 기준이 없다.
  worktreeEvent(h, 'w1', 'waiting', h.clock.now() + 1000)
  await h.clock.settle()

  const term = viewTerminal(h)
  assert.equal(term.phase, 'SUSPENDED')
  assert.equal(term.cacheState, 'none')
  assert.equal(term.cacheStatus, 'interactive-wait')
  assert.equal(term.expiresAt, null)
})

test('getRuntimeView: BUSY→waiting은 대기 수신 시각 기준 만료를 유지한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()

  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()
  const waitingAt = t0 + 2000
  worktreeEvent(h, 'w1', 'waiting', waitingAt)
  await h.clock.settle()

  const term = viewTerminal(h)
  assert.equal(term.phase, 'SUSPENDED')
  assert.equal(term.cacheState, 'kept')
  assert.equal(term.cacheStatus, 'interactive-wait')
  assert.equal(term.expiresAt, waitingAt + TTL_5M)

  const hist = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  assert.equal(hist.epochId, 1)
  assert.equal(hist.basisAt, waitingAt)
  assert.equal(hist.expiresAt, waitingAt + TTL_5M)
  assert.equal(hist.lastBlockReason, 'INTERACTIVE_WAIT')
})

test('getRuntimeView: 대기(hold) 뒤 TTL이 지나면 expired/expireCause INTERACTIVE_WAIT', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  worktreeEvent(h, 'w1', 'waiting', t0 + 2000)
  await h.clock.settle()

  const expiresAt = t0 + TTL_5M
  await h.clock.advance(expiresAt - h.clock.now() + h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.cacheState, 'none')
  assert.equal(term.cacheStatus, 'expired')
  assert.equal(term.expiresAt, expiresAt)
  assert.equal(term.expiredAt, expiresAt)
  assert.equal(term.expireCause, 'INTERACTIVE_WAIT')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY).expiredAt, expiresAt)
})

test('getRuntimeView: waiting→working은 hold를 버리고 기존 새 턴 규칙으로 이력을 CLEAR한다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()

  worktreeEvent(h, 'w1', 'working', t0)
  await h.clock.settle()
  worktreeEvent(h, 'w1', 'waiting', t0 + 2000)
  await h.clock.settle()
  assert.ok(h.coordinator.__debugCacheHistory(EPOCH_KEY))

  worktreeEvent(h, 'w1', 'working', t0 + 4000)
  await h.clock.settle()

  assert.equal(viewTerminal(h).phase, 'BUSY')
  assert.equal(h.coordinator.__debugCacheHistory(EPOCH_KEY), null)
})

test('getRuntimeView: 대기 hold 중 정책 폐기는 hold id로 사유를 남긴다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  worktreeEvent(h, 'w1', 'waiting', t0 + 2000)
  await h.clock.settle()
  const before = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(before)

  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)

  const after = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(after)
  assert.equal(after.epochId, before.epochId)
  assert.equal(after.lastBlockReason, 'SETTINGS_UNKNOWN')
})

test('projection: review는 indicatorOn true(⚠️)이며 PARTIAL_OR_UNKNOWN_SEND를 표시 예외로 둔다', async () => {
  const h = createHarness()
  h.setSendBehavior(async (args) => {
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    return {
      kind: 'uncertain',
      reason: 'PARTIAL_OR_UNKNOWN_SEND',
      attemptId,
      at: h.clock.now(),
      framesSent: 0,
    }
  })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: true })
  await arm(h, h.clock.now())
  await advanceToDue(h)
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'NEEDS_REVIEW')
  assert.equal(term.cacheState, 'review')
  assert.equal(term.cacheStatus, 'review')
  assert.equal(term.indicatorOn, true)

  const desired = h.titleIndicators[0].calls.reconcile.at(-1)
  assert.equal(desired.length, 1)
  assert.equal(desired[0].cacheState, 'review')
  assert.equal(desired[0].on, true)
})

test('indicatorOn: paused·프로필 unknown·cwarm disabled면 getRuntimeView도 false', async () => {
  const h = createHarness()
  await startHarness(h)

  await h.store.setPaused(true)
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).indicatorOn, false)

  await h.store.setPaused(false)
  h.settingsBox.value = { known: false, reason: 'index_missing', readAt: 0 }
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).indicatorOn, false)

  const h2 = createHarness({ cwarmDisabled: true })
  await startHarness(h2)
  await h2.store.updateConfig({ tabTitleIndicator: true })
  await h2.clock.advance(h2.tickMs)
  assert.equal(viewTerminal(h2).indicatorOn, false)
})

test('indicatorOn: review 예외로도 검토 필요 뒤에 가려진 연속 상한은 표시를 끈다', async () => {
  const h = createHarness()
  await startHarness(h)
  await h.store.updateConfig({ maxConsecutiveKeepalives5m: 1 })

  // charged=1(상한 도달) + needsReview(검토 필요). isAllowedByPolicy는 검토 필요를 먼저
  // 반환하므로, 표시 gate는 가려진 LIMIT_REACHED를 별도로 확인해야 한다(§2-2).
  await h.rawStore.reserveAttempt(
    { userDataKey: 'key-p', profileId: 'p1', worktreeId: 'w1', paneKey: 'tab:leaf' },
    1,
    h.clock.now(),
  )
  await h.rawStore.markReview(SCOPE)
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.cacheState, 'review')
  assert.equal(term.cacheStatus, 'review')
  assert.equal(term.indicatorOn, false, '검토 필요에 가려진 연속 상한은 표시를 끈다')
})

// ---------------------------------------------------------------------------
// 27. reservationNote 문구 신호 (검토 지적 1+2)
// ---------------------------------------------------------------------------

test('reservationNote: 새 target은 initial, 관측 뒤에는 null', async () => {
  const h = createHarness()
  await startHarness(h)

  // 아직 아무 관측도 없는 초기 UNKNOWN.
  let term = viewTerminal(h)
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, 'initial')

  // 첫 done(seenWorking=false)을 관측하면 초기 상태를 벗어난다.
  worktreeEvent(h, 'w1', 'done', h.clock.now() + 1000)
  await h.clock.settle()
  term = viewTerminal(h)
  assert.equal(term.phase, 'UNKNOWN')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, null, '관측 뒤에는 initial이 아니다')
})

test('reservationNote: 검토 해제 뒤에는 initial이 아니라 null', async () => {
  const h = createHarness()
  h.setSendBehavior(async (args) => {
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h.clock.now() })
    return {
      kind: 'uncertain',
      reason: 'PARTIAL_OR_UNKNOWN_SEND',
      attemptId,
      at: h.clock.now(),
      framesSent: 0,
    }
  })
  await startHarness(h)
  await arm(h, h.clock.now())
  await advanceToDue(h)
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).phase, 'NEEDS_REVIEW')

  await h.store.clearReview(SCOPE)
  h.coordinator.onReviewCleared({ worktreeId: 'w1', paneKey: 'tab:leaf' })
  await h.clock.settle()

  const term = viewTerminal(h)
  assert.equal(term.phase, 'UNKNOWN')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, null)
})

test('reservationNote: handle만 바뀐 TARGET_CHANGED 뒤에는 initial이 아니다', async () => {
  const h = createHarness()
  await startHarness(h)
  assert.equal(viewTerminal(h).reservationNote, 'initial')

  // 같은 pty/incarnation, handle만 변경: 예약 이력은 보존하되 관측은 있었다.
  h.observer.state.rows = [makeRow({ handle: 'h2' })]
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'UNKNOWN')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, null)
})

test('reservationNote: 10초 조기 EXPIRE 구간은 safety-cutoff, 실제 만료 뒤에는 null', async () => {
  const h = createHarness()
  h.setSendBehavior(async () => ({
    kind: 'skipped',
    reason: 'DRAFT_PRESENT',
    attemptId: null,
    at: h.clock.now(),
    framesSent: 0,
  }))
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)
  const expiresAt = t0 + TTL_5M
  await advanceToDue(h)

  await h.clock.advance(expiresAt - TIMING.minimumRemainingMs - h.clock.now() + h.tickMs)
  let term = viewTerminal(h)
  assert.equal(term.phase, 'EXPIRED')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, 'safety-cutoff')

  await h.clock.advance(TIMING.minimumRemainingMs + h.tickMs * 2)
  term = viewTerminal(h)
  assert.equal(term.cacheStatus, 'expired')
  assert.equal(term.reservationNote, null, '실제 만료 뒤에는 cutoff가 아니다')
})

test('reservationNote: CLOCK_GAP으로 만료되면 safety-cutoff가 아니다', async () => {
  const h = createHarness()
  await startHarness(h)
  const t0 = h.clock.now()
  await arm(h, t0)

  // 실제 만료 전이지만 mono/wall이 함께 크게 점프해 clock gap으로 예약을 닫는다.
  const jump = TIMING.clockGapMs + h.tickMs + 1000
  h.clock.jumpWall(jump)
  h.clock.jumpMono(jump)
  await h.clock.advance(h.tickMs)

  const term = viewTerminal(h)
  assert.equal(term.phase, 'EXPIRED')
  assert.equal(term.cacheStatus, 'no-reservation')
  assert.equal(term.reservationNote, null)
})

// ---------------------------------------------------------------------------
// 28. 검토 해제 시 관측 이력 보존 (검토 지적 3)
// ---------------------------------------------------------------------------

test('onReviewCleared: target이 있으면 관측 이력을 지우지 않아 재시작 뒤에도 유지한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const h1 = createHarness({ epochMemory })
  h1.setSendBehavior(async (args) => {
    const attemptId = await args.journal.reserveAttempt(args.target, args.epochId, h1.clock.now())
    args.onPhase?.('reserved', { attemptId, at: h1.clock.now() })
    return {
      kind: 'uncertain',
      reason: 'PARTIAL_OR_UNKNOWN_SEND',
      attemptId,
      at: h1.clock.now(),
      framesSent: 0,
    }
  })
  await startHarness(h1)
  const t0 = h1.clock.now()
  await arm(h1, t0)
  await advanceToDue(h1)
  await h1.clock.advance(h1.tickMs)
  assert.equal(viewTerminal(h1).phase, 'NEEDS_REVIEW')
  const hist1 = h1.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist1)
  assert.equal(epochMemory.store.get(EPOCH_KEY).kind, 'history')

  await h1.store.clearReview(SCOPE)
  h1.coordinator.onReviewCleared({ worktreeId: 'w1', paneKey: 'tab:leaf' })
  await h1.clock.settle()

  assert.equal(viewTerminal(h1).phase, 'UNKNOWN')
  // 검토 해제가 저장 이력을 지우지 않는다.
  assert.equal(epochMemory.store.has(EPOCH_KEY), true)
  await h1.coordinator.stop()

  const h2 = createHarness({ epochMemory })
  await startHarness(h2)
  const hist2 = h2.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist2, '재시작 뒤에도 관측 이력이 유지된다')
  assert.equal(hist2.expiresAt, hist1.expiresAt)
  assert.equal(viewTerminal(h2).phase, 'SUSPENDED')
  await h2.clock.advance(TTL_5M)
  assert.equal(h2.sendCalls.length, 0, '이력만으로 전송 예약을 만들지 않는다')
})

// ---------------------------------------------------------------------------
// 29. cwarm gate 캐시·snapshot 성능 (검토 지적 4·5)
// ---------------------------------------------------------------------------

test('indicatorOn: 탭 표시기 옵션이 꺼져도 cwarm gate를 tick에서 갱신한다', async () => {
  let disabled = false
  const h = createHarness({ cwarmDisabled: () => disabled })
  await startHarness(h)
  await h.store.updateConfig({ tabTitleIndicator: false })
  await h.clock.advance(h.tickMs)
  assert.equal(viewTerminal(h).indicatorOn, true)

  disabled = true
  const before = h.cwarmCalls.length
  await h.clock.advance(h.tickMs)
  assert.ok(h.cwarmCalls.length > before, '옵션이 꺼져도 cwarm 상태를 확인한다')
  assert.equal(viewTerminal(h).indicatorOn, false)
})

test('indicatorOn: 검토 필요 target이 여러 개여도 getRuntimeView는 snapshot을 1회만 읽는다', async () => {
  const rows = [
    makeRow({ handle: 'h1', paneKey: 'tab:leaf1', ptyId: 'pty1', incarnationId: 'inc1' }),
    makeRow({ handle: 'h2', paneKey: 'tab:leaf2', ptyId: 'pty2', incarnationId: 'inc2' }),
    makeRow({ handle: 'h3', paneKey: 'tab:leaf3', ptyId: 'pty3', incarnationId: 'inc3' }),
  ]
  const h = createHarness({ terminals: rows })
  await startHarness(h)
  for (const row of rows) {
    await h.rawStore.markReview({
      userDataKey: 'key-p',
      profileId: 'p1',
      worktreeId: 'w1',
      paneKey: row.paneKey,
    })
  }

  const rawSnapshot = h.rawStore.snapshot
  let snapshotCalls = 0
  h.store.snapshot = (...args) => {
    snapshotCalls += 1
    return rawSnapshot.apply(h.rawStore, args)
  }

  const view = h.coordinator.getRuntimeView()
  assert.equal(view.worktrees[0].terminals.length, 3)
  assert.equal(
    snapshotCalls,
    1,
    `snapshot은 target 수와 무관하게 1회여야 한다: ${snapshotCalls}`,
  )
})

// ---------------------------------------------------------------------------
// 30. 과거 APP_TIMER_OFF 이력 복원 호환 (새로 생성하지 않음)
// ---------------------------------------------------------------------------

test('호환: 과거 APP_TIMER_OFF 이력 레코드를 복원해도 만료 원인으로 유지한다', async () => {
  const epochMemory = createFakeEpochMemory()
  const doneAt = 1_000_000
  const basisAt = doneAt
  const expiresAt = doneAt + TTL_5M
  epochMemory.store.set(EPOCH_KEY, {
    kind: 'history',
    userDataKey: 'key-p',
    profileId: 'p1',
    worktreeId: 'w1',
    paneKey: 'tab:leaf',
    ptyId: 'pty1',
    incarnationId: 'inc1',
    doneAt,
    basisAt,
    expiresAt,
    lastBlockReason: 'APP_TIMER_OFF',
    expiredAt: expiresAt,
    savedAt: 1,
  })
  // clock을 expiresAt 이후로 두면 만료 이력으로 복원된다.
  const h = createHarness({ epochMemory, clock: createFakeClock({ start: expiresAt + 1000 }) })
  await startHarness(h)

  assert.equal(viewTerminal(h).phase, 'EXPIRED')
  const hist = h.coordinator.__debugCacheHistory(EPOCH_KEY)
  assert.ok(hist)
  assert.equal(hist.lastBlockReason, 'APP_TIMER_OFF')
  assert.equal(viewTerminal(h).expireCause, 'APP_TIMER_OFF')
})
