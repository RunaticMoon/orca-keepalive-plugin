import test from 'node:test'
import assert from 'node:assert/strict'

import { createCoordinator } from '../src/coordinator.mjs'
import { createStateStore } from '../src/state-store.mjs'
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

function createObserverFake({ rows = [makeRow()] } = {}) {
  const state = { rows: rows.slice(), complete: true, onList: null, currentWorktree: null }
  const listCalls = []
  return {
    state,
    listCalls,
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
