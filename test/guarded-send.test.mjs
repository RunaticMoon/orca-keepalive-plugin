import test from 'node:test'
import assert from 'node:assert/strict'

import { sendKeepalive } from '../src/guarded-send.mjs'
import { RpcError } from '../src/rpc-client.mjs'
import { REASON_CODES } from '../src/contracts.mjs'

// ---------------------------------------------------------------------------
// fixtures / fakes
// ---------------------------------------------------------------------------

const HANDLE = 'terminal:local:1'
const MESSAGE = 'Cache keepalive. Reply only OK.'
const QUIET = 2500
const CLOCK_START = 1_000_000
const CLIENT_ID = 'cache-keepalive:test'

const TARGET = Object.freeze({
  worktreeId: 'wt-1',
  paneKey: 'tab-1:leaf-1',
  handle: HANDLE,
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  runtimeId: 'rt-1',
})
const TARGET_NO_INCARNATION = Object.freeze({ ...TARGET, incarnationId: null })

/** sleep(ms)마다 virtual time을 진행하는 fake clock. */
function createClock(start = CLOCK_START) {
  let current = start
  const sleeps = []
  return {
    now: () => current,
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      if (signal?.aborted) {
        throw new RpcError('aborted', 'aborted', { phase: 'connect' })
      }
      current += ms
    },
    advance: (ms) => {
      current += ms
    },
    sleeps,
  }
}

/** 모든 preflight 조건을 통과하는 기본 Observation. */
function baseObservation(overrides = {}) {
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
    ...overrides,
  }
}

/**
 * 호출 순서대로 observation을 돌려주는 fake inspect. 배열이 짧으면 마지막 값을
 * 반복하고, 함수면 callIndex를 받아 만든다. Error를 반환하면 던진다.
 */
function createInspector(observations) {
  const calls = []
  const list = Array.isArray(observations) ? observations : [observations]
  const fn = async (target, options = {}) => {
    calls.push({ target, options })
    if (options?.signal?.aborted) {
      throw new RpcError('aborted', 'aborted', { phase: 'connect' })
    }
    const index = calls.length - 1
    const value =
      typeof observations === 'function'
        ? await observations(index, target)
        : list[Math.min(index, list.length - 1)]
    if (value instanceof Error) {
      throw value
    }
    return value
  }
  fn.calls = calls
  return fn
}

/** terminal.send 1회차=paste, 2회차=Enter 응답을 스크립트로 돌려주는 fake rpc. */
function createRpc(scripts = []) {
  const calls = []
  const rpc = {
    calls,
    async call(method, params, options = {}) {
      calls.push({ method, params, options })
      if (options?.signal?.aborted) {
        throw new RpcError('aborted', 'aborted', { phase: 'connect' })
      }
      if (method !== 'terminal.send') {
        throw new Error(`unexpected method ${method}`)
      }
      const index = calls.filter((call) => call.method === 'terminal.send').length - 1
      const script = scripts[index]
      if (script === undefined) {
        throw new Error(`unexpected terminal.send #${index + 1}`)
      }
      if (script instanceof Error) {
        throw script
      }
      if (typeof script === 'function') {
        return await script(params, options)
      }
      return script
    },
  }
  rpc.sendCalls = () => calls.filter((call) => call.method === 'terminal.send')
  rpc.pasteCalls = () => rpc.sendCalls().filter((call) => call.params.text !== undefined)
  rpc.enterCalls = () => rpc.sendCalls().filter((call) => call.params.enter === true)
  return rpc
}

/** 호출 기록을 남기는 fake journal. */
function createJournal(overrides = {}) {
  const events = []
  return {
    events,
    async reserveAttempt(target, epochId, at) {
      events.push({ type: 'reserve', target, epochId, at })
      if (overrides.reserveError) throw overrides.reserveError
      return overrides.attemptId ?? 'attempt-1'
    },
    async recordAttempt(id, phase) {
      events.push({ type: 'record', id, phase })
      if (overrides.recordError) throw overrides.recordError
    },
    async refuseAttempt(id) {
      events.push({ type: 'refuse', id })
      if (overrides.refuseError) throw overrides.refuseError
    },
    async markReview(id, reason) {
      events.push({ type: 'review', id, reason })
      if (overrides.reviewError) throw overrides.reviewError
    },
  }
}

/** assertAllowed 응답을 호출 순서대로 돌려주는 fake. */
function createAssertAllowed(results = [{ allowed: true, reason: null }]) {
  const calls = []
  const fn = async () => {
    calls.push(true)
    const index = calls.length - 1
    const value =
      typeof results === 'function' ? results(index) : results[Math.min(index, results.length - 1)]
    if (value instanceof Error) {
      throw value
    }
    return value
  }
  fn.calls = calls
  return fn
}

const PASTE_ACCEPTED = { send: { handle: HANDLE, accepted: true, bytesWritten: 12 } }
const ENTER_ACCEPTED = { send: { handle: HANDLE, accepted: true, bytesWritten: 0 } }

/** 기본 fake들로 sendKeepalive를 한 번 실행한다. */
async function run(overrides = {}) {
  const clock = overrides.clock ?? createClock()
  const rpc =
    overrides.rpc ?? createRpc([PASTE_ACCEPTED, ENTER_ACCEPTED])
  const journal = overrides.journal ?? createJournal()
  const phases = []
  const result = await sendKeepalive({
    target: overrides.target ?? TARGET,
    epochId: overrides.epochId ?? 7,
    message: overrides.message ?? MESSAGE,
    quietOutputMs: overrides.quietOutputMs ?? QUIET,
    clientId: overrides.clientId ?? CLIENT_ID,
    rpc,
    inspect:
      overrides.inspect ??
      overrides.inspector ??
      createInspector([
        baseObservation(),
        baseObservation({ draft: MESSAGE }),
        baseObservation({ draft: MESSAGE }),
      ]),
    assertAllowed: overrides.assertAllowed ?? createAssertAllowed(),
    journal,
    clock,
    signal: overrides.signal,
    onPhase: (phase, info) => phases.push({ phase, info }),
  })
  return { result, rpc, journal, clock, phases }
}

function journalTypes(journal) {
  return journal.events.map((event) => event.type)
}

// ---------------------------------------------------------------------------
// 정상 경로
// ---------------------------------------------------------------------------

test('정상 경로: paste 1 + Enter 1, 프레임 정확히 2, submitted', async () => {
  const { result, rpc, journal, phases } = await run()

  assert.equal(result.kind, 'submitted')
  assert.equal(result.reason, null)
  assert.equal(result.attemptId, 'attempt-1')
  assert.equal(result.framesSent, 2)

  const sends = rpc.sendCalls()
  assert.equal(sends.length, 2)
  const [paste, enter] = sends

  assert.deepEqual(paste.params, {
    terminal: HANDLE,
    text: '\u001b[200~' + MESSAGE + '\u001b[201~',
    requireAgentStatus: 'sendable',
    client: { id: CLIENT_ID, type: 'desktop' },
    expectedIncarnationId: 'inc-1',
  })
  assert.deepEqual(enter.params, {
    terminal: HANDLE,
    enter: true,
    requireAgentStatus: 'sendable',
    client: { id: CLIENT_ID, type: 'desktop' },
    expectedIncarnationId: 'inc-1',
  })

  // paste에는 enter/interrupt/agentPrompt가 없고, Enter에는 text/interrupt/agentPrompt가 없다.
  for (const forbidden of ['enter', 'interrupt', 'agentPrompt']) {
    assert.ok(!(forbidden in paste.params))
  }
  for (const forbidden of ['text', 'interrupt', 'agentPrompt']) {
    assert.ok(!(forbidden in enter.params))
  }

  assert.deepEqual(phases.map((entry) => entry.phase), ['reserved', 'pasted', 'submitted'])
  assert.deepEqual(phases[0].info, { attemptId: 'attempt-1', at: CLOCK_START })
  assert.deepEqual(phases[1].info, { attemptId: 'attempt-1' })
  assert.equal(phases[2].info.attemptId, 'attempt-1')
  assert.equal(typeof phases[2].info.at, 'number')

  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'record'])
  assert.deepEqual(
    journal.events.filter((event) => event.type === 'record').map((event) => event.phase),
    ['pasted', 'submitted'],
  )
})

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

const PREFLIGHT_CASES = [
  ['stale', { stale: true }, REASON_CODES.STALE_TARGET],
  ['identity-codex', { identity: 'codex' }, REASON_CODES.UNSUPPORTED_AGENT],
  ['identity-null', { identity: null }, REASON_CODES.UNSUPPORTED_AGENT],
  ['host-ssh', { executionHostId: 'ssh:box' }, REASON_CODES.UNSUPPORTED_HOST],
  ['not-connected', { connected: false }, REASON_CODES.NOT_CONNECTED],
  ['not-writable', { writable: false }, REASON_CODES.NOT_CONNECTED],
  ['working', { agentStatus: 'working' }, REASON_CODES.BUSY],
  ['permission', { agentStatus: 'permission' }, REASON_CODES.INTERACTIVE_WAIT],
  ['no-running-agent', { isRunningAgent: false }, REASON_CODES.UNKNOWN_WAIT],
  ['status-null', { agentStatus: 'unknown' }, REASON_CODES.UNKNOWN_WAIT],
  ['waiting', { agentWait: 'waiting' }, REASON_CODES.INTERACTIVE_WAIT],
  ['wait-unknown', { agentWait: 'unknown' }, REASON_CODES.UNKNOWN_WAIT],
  ['screen-unknown', { screen: 'unknown' }, REASON_CODES.SCREEN_UNKNOWN],
  ['screen-truncated', { screenTruncated: true }, REASON_CODES.SCREEN_UNKNOWN],
  ['draft-present', { draft: 'user typed' }, REASON_CODES.DRAFT_PRESENT],
  ['output-null', { lastOutputAt: null }, REASON_CODES.OUTPUT_ACTIVE],
  ['output-future', { lastOutputAt: CLOCK_START + 1 }, REASON_CODES.OUTPUT_ACTIVE],
]

for (const [name, overrides, expectedReason] of PREFLIGHT_CASES) {
  test(`preflight ${name}: skipped ${expectedReason}, 프레임 0, reserve 0`, async () => {
    const inspector = createInspector([baseObservation(overrides)])
    const { result, rpc, journal } = await run({ inspect: inspector })

    assert.equal(result.kind, 'skipped')
    assert.equal(result.reason, expectedReason)
    assert.equal(result.attemptId, null)
    assert.equal(result.framesSent, 0)
    assert.equal(rpc.sendCalls().length, 0)
    assert.equal(journal.events.length, 0)
  })
}

test('preflight: 마지막 위반이 아니라 첫 번째 위반 reason을 쓴다', async () => {
  const inspector = createInspector([
    baseObservation({ identity: 'codex', agentStatus: 'working', draft: 'x' }),
  ])
  const { result } = await run({ inspect: inspector })
  assert.equal(result.reason, REASON_CODES.UNSUPPORTED_AGENT)
})

test('step1 assertAllowed false: skipped, inspect/reserve/프레임 0', async () => {
  const inspector = createInspector([baseObservation()])
  const { result, rpc, journal } = await run({
    assertAllowed: createAssertAllowed([{ allowed: false, reason: 'APP_TIMER_OFF' }]),
    inspect: inspector,
  })
  assert.equal(result.kind, 'skipped')
  assert.equal(result.reason, 'APP_TIMER_OFF')
  assert.equal(result.framesSent, 0)
  assert.equal(inspector.calls.length, 0)
  assert.equal(rpc.sendCalls().length, 0)
  assert.equal(journal.events.length, 0)
})

test('signal이 이미 abort면 skipped aborted', async () => {
  const { result, rpc, journal } = await run({ signal: AbortSignal.abort() })
  assert.equal(result.kind, 'skipped')
  assert.equal(result.reason, 'aborted')
  assert.equal(result.framesSent, 0)
  assert.equal(rpc.sendCalls().length, 0)
  assert.equal(journal.events.length, 0)
})

// ---------------------------------------------------------------------------
// 예약과 단계 사이 재확인
// ---------------------------------------------------------------------------

test('reserve 실패: skipped STORAGE_FAILED, 프레임 0', async () => {
  const journal = createJournal({ reserveError: new Error('storage down') })
  const { result, rpc } = await run({ journal })
  assert.equal(result.kind, 'skipped')
  assert.equal(result.reason, REASON_CODES.STORAGE_FAILED)
  assert.equal(result.attemptId, null)
  assert.equal(result.framesSent, 0)
  assert.equal(rpc.sendCalls().length, 0)
})

test('예약 후 assertAllowed false: refused, 프레임 0, refuse 기록', async () => {
  const journal = createJournal()
  const { result, rpc } = await run({
    journal,
    assertAllowed: createAssertAllowed([
      { allowed: true, reason: null },
      { allowed: false, reason: 'GLOBAL_PAUSED' },
    ]),
  })
  assert.equal(result.kind, 'refused')
  assert.equal(result.reason, 'GLOBAL_PAUSED')
  assert.equal(result.attemptId, 'attempt-1')
  assert.equal(result.framesSent, 0)
  assert.equal(rpc.sendCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'refuse'])
})

test('예약 후 assertAllowed가 abort를 던지면 refused aborted', async () => {
  const journal = createJournal()
  const { result, rpc } = await run({
    journal,
    assertAllowed: createAssertAllowed([
      { allowed: true, reason: null },
      new RpcError('aborted', 'aborted', { phase: 'connect' }),
    ]),
  })
  assert.equal(result.kind, 'refused')
  assert.equal(result.reason, 'aborted')
  assert.equal(result.framesSent, 0)
  assert.equal(rpc.sendCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'refuse'])
})

// ---------------------------------------------------------------------------
// paste 거절/불확실
// ---------------------------------------------------------------------------

const PASTE_REFUSAL_CASES = [
  ['permission', 'permission', REASON_CODES.INTERACTIVE_WAIT],
  ['no-agent', 'no-agent', REASON_CODES.UNSUPPORTED_AGENT],
  ['unknown', undefined, REASON_CODES.NOT_CONNECTED],
  ['other', 'something-else', REASON_CODES.NOT_CONNECTED],
]

for (const [name, refusedReason, expectedReason] of PASTE_REFUSAL_CASES) {
  test(`paste accepted:false bytesWritten:0 (${name}): refused ${expectedReason}`, async () => {
    const journal = createJournal()
    const rpc = createRpc([{ send: { handle: HANDLE, accepted: false, bytesWritten: 0, refusedReason } }])
    const { result } = await run({ rpc, journal })

    assert.equal(result.kind, 'refused')
    assert.equal(result.reason, expectedReason)
    assert.equal(result.framesSent, 1)
    assert.equal(rpc.enterCalls().length, 0)
    assert.deepEqual(journalTypes(journal), ['reserve', 'refuse'])
  })
}

test('paste RpcError mayHaveWritten false: refused RUNTIME_UNAVAILABLE, 프레임 1', async () => {
  const journal = createJournal()
  const rpc = createRpc([
    new RpcError('runtime_unavailable', 'connect failed', { phase: 'connect', mayHaveWritten: false }),
  ])
  const { result } = await run({ rpc, journal })
  assert.equal(result.kind, 'refused')
  assert.equal(result.reason, REASON_CODES.RUNTIME_UNAVAILABLE)
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'refuse'])
})

test('paste 응답 유실(mayHaveWritten true): uncertain, Enter 0, review', async () => {
  const journal = createJournal()
  const rpc = createRpc([
    new RpcError('runtime_timeout', 'response lost', { phase: 'response', mayHaveWritten: true }),
  ])
  const { result } = await run({ rpc, journal })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'review'])
})

test('paste 형식 이상 응답: uncertain, Enter 0', async () => {
  const rpc = createRpc([{ unexpected: true }])
  const { result } = await run({ rpc })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.equal(rpc.enterCalls().length, 0)
})

test('paste accepted true인데 bytesWritten 없음: accepted true가 우선해 진행한다', async () => {
  const rpc = createRpc([{ send: { handle: HANDLE, accepted: true } }, ENTER_ACCEPTED])
  const { result } = await run({ rpc })
  assert.equal(result.kind, 'submitted')
  assert.equal(rpc.sendCalls().length, 2)
})

// ---------------------------------------------------------------------------
// paste 확인 단계
// ---------------------------------------------------------------------------

test('draft 불일치(사용자 추가 입력): uncertain, Enter 0', async () => {
  const journal = createJournal()
  const inspector = createInspector([
    baseObservation(),
    baseObservation({ draft: MESSAGE + ' additional' }),
  ])
  const { result, rpc, clock } = await run({ inspector, journal })

  assert.equal(result.kind, 'uncertain')
  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'review'])
  // 최소 500ms 대기 후 첫 확인을 했는지.
  assert.equal(clock.sleeps[0], 500)
})

test('draft 5초 내 미확인: uncertain, Enter 0, polling 반복', async () => {
  const inspector = createInspector([baseObservation(), baseObservation({ draft: null })])
  const { result, rpc, clock } = await run({ inspector })

  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.ok(clock.sleeps.length > 1)
  assert.ok(clock.sleeps.slice(1).every((ms) => ms === 250))
})

test('paste 확인 중 stale: uncertain, Enter 0', async () => {
  const inspector = createInspector([
    baseObservation(),
    baseObservation({ draft: MESSAGE, stale: true }),
  ])
  const { result, rpc } = await run({ inspector })
  assert.equal(result.kind, 'uncertain')
  assert.equal(rpc.enterCalls().length, 0)
})

test('paste 확인 중 screen unknown: 5초 후 uncertain, Enter 0', async () => {
  const inspector = createInspector([
    baseObservation(),
    baseObservation({ draft: MESSAGE, screen: 'unknown' }),
  ])
  const { result, rpc } = await run({ inspector })
  assert.equal(result.kind, 'uncertain')
  assert.equal(rpc.enterCalls().length, 0)
})

// ---------------------------------------------------------------------------
// Enter 직전 재확인
// ---------------------------------------------------------------------------

test('재확인에서 permission 등장: uncertain, Enter 0', async () => {
  const inspector = createInspector([
    baseObservation(),
    baseObservation({ draft: MESSAGE }),
    baseObservation({ draft: MESSAGE, agentStatus: 'permission' }),
  ])
  const { result, rpc, journal } = await run({ inspector })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'review'])
})

test('재확인에서 정책 off: uncertain, Enter 0', async () => {
  const assertAllowed = createAssertAllowed([
    { allowed: true, reason: null },
    { allowed: true, reason: null },
    { allowed: false, reason: 'GLOBAL_PAUSED' },
  ])
  const { result, rpc } = await run({ assertAllowed })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.equal(assertAllowed.calls.length, 3)
})

test('재확인에서 draft가 바뀜: uncertain, Enter 0', async () => {
  const inspector = createInspector([
    baseObservation(),
    baseObservation({ draft: MESSAGE }),
    baseObservation({ draft: 'changed after paste' }),
  ])
  const { result, rpc } = await run({ inspector })
  assert.equal(result.kind, 'uncertain')
  assert.equal(rpc.enterCalls().length, 0)
})

// ---------------------------------------------------------------------------
// Enter 불확실
// ---------------------------------------------------------------------------

test('Enter accepted false: uncertain, 프레임 2, review', async () => {
  const journal = createJournal()
  const rpc = createRpc([PASTE_ACCEPTED, { send: { handle: HANDLE, accepted: false, bytesWritten: 0 } }])
  const { result } = await run({ rpc, journal })

  assert.equal(result.kind, 'uncertain')
  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.equal(result.framesSent, 2)
  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'review'])
})

test('Enter 에러(mayHaveWritten true): uncertain, 프레임 2', async () => {
  const journal = createJournal()
  const rpc = createRpc([
    PASTE_ACCEPTED,
    new RpcError('runtime_timeout', 'enter response lost', { phase: 'response', mayHaveWritten: true }),
  ])
  const { result } = await run({ rpc, journal })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 2)
  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'review'])
})

test('Enter 에러(mayHaveWritten false)도 uncertain으로 둔다', async () => {
  const rpc = createRpc([
    PASTE_ACCEPTED,
    new RpcError('runtime_unavailable', 'connect failed', { phase: 'connect', mayHaveWritten: false }),
  ])
  const { result } = await run({ rpc })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 2)
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

test('paste 후 abort: uncertain, Enter 0', async () => {
  const controller = new AbortController()
  const rpc = createRpc([
    async () => {
      controller.abort()
      return PASTE_ACCEPTED
    },
  ])
  const { result, journal } = await run({ rpc, signal: controller.signal })

  assert.equal(result.kind, 'uncertain')
  assert.equal(result.framesSent, 1)
  assert.equal(rpc.enterCalls().length, 0)
  assert.deepEqual(journalTypes(journal), ['reserve', 'record', 'review'])
})

test('paste 자체가 aborted RpcError면 uncertain, Enter 0', async () => {
  const rpc = createRpc([new RpcError('aborted', 'aborted', { phase: 'connect', mayHaveWritten: false })])
  const { result } = await run({ rpc })
  assert.equal(result.kind, 'uncertain')
  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.equal(rpc.enterCalls().length, 0)
})

// ---------------------------------------------------------------------------
// quietOutput 경계
// ---------------------------------------------------------------------------

test('lastOutputAt 경계: quiet-1ms 거절, quiet/quiet+1ms 허용', async () => {
  const reject = await run({
    inspect: createInspector([baseObservation({ lastOutputAt: CLOCK_START - (QUIET - 1) })]),
  })
  assert.equal(reject.result.kind, 'skipped')
  assert.equal(reject.result.reason, REASON_CODES.OUTPUT_ACTIVE)

  const atQuiet = await run({
    inspect: createInspector([
      baseObservation({ lastOutputAt: CLOCK_START - QUIET }),
      baseObservation({ draft: MESSAGE }),
      baseObservation({ draft: MESSAGE }),
    ]),
  })
  assert.equal(atQuiet.result.kind, 'submitted')

  const overQuiet = await run({
    inspect: createInspector([
      baseObservation({ lastOutputAt: CLOCK_START - QUIET - 1000 }),
      baseObservation({ draft: MESSAGE }),
      baseObservation({ draft: MESSAGE }),
    ]),
  })
  assert.equal(overQuiet.result.kind, 'submitted')
})

// ---------------------------------------------------------------------------
// expectedIncarnationId
// ---------------------------------------------------------------------------

test('incarnationId가 없으면 두 send params에 expectedIncarnationId를 넣지 않는다', async () => {
  const { result, rpc } = await run({ target: TARGET_NO_INCARNATION })
  assert.equal(result.kind, 'submitted')
  const sends = rpc.sendCalls()
  assert.equal(sends.length, 2)
  for (const call of sends) {
    assert.ok(!('expectedIncarnationId' in call.params))
  }
})

// ---------------------------------------------------------------------------
// secret 비노출, at-most-once
// ---------------------------------------------------------------------------

test('message/draft는 result와 journal reason에 남지 않는다', async () => {
  const secret = 'SECRET-KEEPALIVE-TEXT-42'
  const journal = createJournal()
  const rpc = createRpc([
    new RpcError('runtime_timeout', 'lost', { phase: 'response', mayHaveWritten: true }),
  ])
  const inspector = createInspector([baseObservation(), baseObservation({ draft: secret })])
  const { result } = await run({ rpc, journal, message: secret, inspect: inspector })

  assert.equal(result.reason, REASON_CODES.PARTIAL_OR_UNKNOWN_SEND)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(journal.events).includes(secret))
  for (const event of journal.events.filter((entry) => entry.type === 'review')) {
    assert.ok(!String(event.reason).includes(secret))
  }
})

test('모든 fault 시나리오에서 paste <= 1, Enter <= 1', async () => {
  const scenarios = [
    () => run({ rpc: createRpc([{ send: { handle: HANDLE, accepted: false, bytesWritten: 0 } }]) }),
    () =>
      run({
        rpc: createRpc([
          new RpcError('runtime_timeout', 'lost', { phase: 'response', mayHaveWritten: true }),
        ]),
      }),
    () =>
      run({
        inspect: createInspector([baseObservation(), baseObservation({ draft: 'other' })]),
        rpc: createRpc([PASTE_ACCEPTED]),
      }),
    () =>
      run({
        inspect: createInspector([baseObservation(), baseObservation({ draft: null })]),
        rpc: createRpc([PASTE_ACCEPTED]),
      }),
    () => run({ rpc: createRpc([PASTE_ACCEPTED, { send: { handle: HANDLE, accepted: false, bytesWritten: 0 } }]) }),
    () => run({ rpc: createRpc([PASTE_ACCEPTED, new RpcError('runtime_timeout', 'lost')]) }),
  ]

  for (const scenario of scenarios) {
    const { rpc } = await scenario()
    assert.ok(rpc.pasteCalls().length <= 1, 'paste frame must be at most one')
    assert.ok(rpc.enterCalls().length <= 1, 'enter frame must be at most one')
    assert.equal(rpc.sendCalls().length, rpc.pasteCalls().length + rpc.enterCalls().length)
  }
})
