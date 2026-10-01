/**
 * guarded paste/Enter 2단계 전송 프로토콜. DESIGN.md §4.3 terminal.send, §5.5 전송
 * 직전·단계 사이 안전 규칙, §6(J) export 계약을 구현한다.
 *
 * 이 모듈은 캐시/스케줄 결정, HTTP, 상태 저장 정책을 하지 않는다. 부작용은
 * 주입된 `rpc`/`journal`/`clock`으로만 일으키고 import 시 I/O/타이머를 시작하지
 * 않는다. 핵심 invariant:
 *
 *  - 사용자 입력/권한 프롬프트 보호가 최우선이다. 조금이라도 불확실하면 Enter를
 *    보내지 않거나 결과를 uncertain으로 남긴다.
 *  - mutation(terminal.send)은 paste 최대 1회, Enter 최대 1회다. timeout/응답
 *    유실/abort 뒤에도 절대 재전송하지 않는다.
 *  - paste는 guarded text 한 프레임, Enter는 enter 한 프레임으로 분리한다.
 *    한 요청에 text와 enter를 함께 넣지 않는다(호스트 guard가 bytesWritten:0으로
 *    거절하는 조합).
 *  - message/draft/authToken은 reason/에러에 넣지 않는다.
 *
 * @module guarded-send
 */

import { REASON_CODES } from './contracts.mjs'
import { RpcError } from './rpc-client.mjs'

/** paste 확인 전 최소 대기. §5.5-7. */
const PASTE_SETTLE_MS = 500
/** paste 확인 polling 간격. */
const PASTE_POLL_MS = 250
/** paste 확인 최대 시간(sleep(500) 이후). §5.5-7. */
const PASTE_CONFIRM_DEADLINE_MS = 5000
/** 잘못된 clock이 무한 loop를 만들지 않도록 하는 안전 상한. */
const MAX_CONFIRM_POLLS = 200
/** send 요청 client.type. §5.5-9. */
const DESKTOP_CLIENT_TYPE = 'desktop'
/** paste framing. §4.3. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
/** terminal.send RPC 전체 deadline(ms). §4.2. rpc-client 기본값(10s)을 덮어쓴다. */
const SEND_RPC_TIMEOUT_MS = 5000

/** paste/Enter 응답 유실·형식 이상 시 공통 reason. */
const PARTIAL = REASON_CODES.PARTIAL_OR_UNKNOWN_SEND

/**
 * @typedef {Object} SendTarget
 * @property {string} worktreeId
 * @property {string} paneKey
 * @property {string} handle RPC handle.
 * @property {string} ptyId
 * @property {string|null} incarnationId
 * @property {string} [runtimeId]
 *
 * @typedef {Object} SendObservation
 * @property {boolean} stale
 * @property {string|null} identity
 * @property {string|null} executionHostId
 * @property {boolean} connected
 * @property {boolean} writable
 * @property {'idle'|'working'|'permission'|'unknown'} agentStatus
 * @property {boolean|null} isRunningAgent
 * @property {'none'|'waiting'|'unknown'} agentWait
 * @property {'ok'|'unknown'} screen
 * @property {boolean|null} screenTruncated
 * @property {string|null} draft
 * @property {number|null} lastOutputAt
 *
 * @typedef {Object} SendClock
 * @property {() => number} now
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 *
 * @typedef {Object} SendResult
 * @property {'skipped'|'refused'|'uncertain'|'submitted'} kind
 * @property {string|null} reason
 * @property {string|null} attemptId
 * @property {number} at
 * @property {number} framesSent terminal.send를 호출(시도)한 횟수(실제 write 여부와 무관).
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * signal abort로 인한 오류인지 확인한다.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  if (!isObject(error)) {
    return false
  }
  return error.code === 'aborted' || error.name === 'AbortError'
}

/**
 * assertAllowed 결과에서 거절 reason을 고른다. reason이 비어 있으면 안전한 기본값.
 * @param {unknown} gate
 * @returns {string}
 */
function denyReason(gate) {
  if (isObject(gate) && typeof gate.reason === 'string' && gate.reason.length > 0) {
    return gate.reason
  }
  return REASON_CODES.RUNTIME_UNAVAILABLE
}

/**
 * preflight 조건을 순서대로 검사하고 첫 위반 reason을 반환한다. 통과면 null.
 * §5.5-2~5.
 * @param {SendObservation} obs
 * @param {number} quietOutputMs
 * @param {number} now
 * @returns {string|null}
 */
function preflightReason(obs, quietOutputMs, now) {
  if (obs.stale !== false) {
    return REASON_CODES.STALE_TARGET
  }
  if (obs.identity !== 'claude') {
    return REASON_CODES.UNSUPPORTED_AGENT
  }
  if (obs.executionHostId !== 'local') {
    return REASON_CODES.UNSUPPORTED_HOST
  }
  if (obs.connected !== true || obs.writable !== true) {
    return REASON_CODES.NOT_CONNECTED
  }
  if (obs.agentStatus !== 'idle' || obs.isRunningAgent !== true) {
    if (obs.agentStatus === 'working') {
      return REASON_CODES.BUSY
    }
    if (obs.agentStatus === 'permission') {
      return REASON_CODES.INTERACTIVE_WAIT
    }
    return REASON_CODES.UNKNOWN_WAIT
  }
  if (obs.agentWait !== 'none') {
    if (obs.agentWait === 'waiting') {
      return REASON_CODES.INTERACTIVE_WAIT
    }
    return REASON_CODES.UNKNOWN_WAIT
  }
  if (obs.screen !== 'ok' || obs.screenTruncated !== false) {
    return REASON_CODES.SCREEN_UNKNOWN
  }
  if (obs.draft !== null) {
    return REASON_CODES.DRAFT_PRESENT
  }
  const lastOutputAt = obs.lastOutputAt
  if (typeof lastOutputAt !== 'number' || !Number.isFinite(lastOutputAt)) {
    return REASON_CODES.OUTPUT_ACTIVE
  }
  if (lastOutputAt > now || now - lastOutputAt < quietOutputMs) {
    return REASON_CODES.OUTPUT_ACTIVE
  }
  return null
}

/**
 * paste 확인 통과 조건: draft가 message와 정확히 일치하고 화면도 확정적이다.
 * 공백 normalization을 하지 않는다. §5.5-7.
 * @param {unknown} obs
 * @param {string} message
 * @returns {boolean}
 */
function pasteVisible(obs, message) {
  return (
    isObject(obs) &&
    obs.stale !== true &&
    obs.screen === 'ok' &&
    obs.screenTruncated === false &&
    obs.draft === message
  )
}

/**
 * Enter 직전 재확인 조건. paste가 출력을 만들었으므로 quietOutput은 검사하지 않는다.
 * §5.5-8.
 * @param {unknown} obs
 * @param {string} message
 * @returns {boolean}
 */
function recheckOk(obs, message) {
  return (
    isObject(obs) &&
    obs.stale !== true &&
    obs.identity === 'claude' &&
    obs.agentStatus === 'idle' &&
    obs.isRunningAgent === true &&
    obs.agentWait === 'none' &&
    obs.draft === message
  )
}

/**
 * terminal.send 결과 wrapper에서 send 객체를 꺼낸다.
 * @param {unknown} result
 * @returns {Record<string, unknown>|null}
 */
function extractSend(result) {
  if (isObject(result) && isObject(result.send)) {
    return result.send
  }
  return null
}

/**
 * 호스트 guard의 refusedReason을 reason 코드로 대표화한다.
 * @param {unknown} refusedReason
 * @returns {string}
 */
function refusedReasonToCode(refusedReason) {
  if (refusedReason === 'permission') {
    return REASON_CODES.INTERACTIVE_WAIT
  }
  if (refusedReason === 'no-agent') {
    return REASON_CODES.UNSUPPORTED_AGENT
  }
  return REASON_CODES.NOT_CONNECTED
}

/**
 * guarded keepalive 1회를 수행한다.
 *
 * @param {Object} options
 * @param {SendTarget} options.target
 * @param {number} options.epochId
 * @param {string} options.message
 * @param {number} options.quietOutputMs
 * @param {string} options.clientId
 * @param {{ call: (method: string, params: unknown, options?: {signal?: AbortSignal}) => Promise<unknown> }} options.rpc
 * @param {(target: SendTarget, options?: {signal?: AbortSignal}) => Promise<SendObservation>} options.inspect
 * @param {() => Promise<{allowed: boolean, reason: string|null}>} options.assertAllowed 프로필 설정/정책/pause/세대를 합성한 최신 허용 판정.
 * @param {{ reserveAttempt: Function, recordAttempt: Function, refuseAttempt: Function, markReview: Function }} options.journal
 * @param {SendClock} options.clock
 * @param {AbortSignal} [options.signal]
 * @param {(phase: 'reserved'|'pasted'|'submitted', info: Object) => void} [options.onPhase] 호출자 상태머신 갱신용(오류가 전송을 막지 않는다).
 * @returns {Promise<SendResult>}
 */
export async function sendKeepalive({
  target,
  epochId,
  message,
  quietOutputMs,
  clientId,
  rpc,
  inspect,
  assertAllowed,
  journal,
  clock,
  signal,
  onPhase = () => {},
}) {
  /**
   * @param {SendResult['kind']} kind
   * @param {string|null} reason
   * @param {string|null} attemptId
   * @param {number} framesSent
   * @returns {SendResult}
   */
  const makeResult = (kind, reason, attemptId, framesSent) => ({
    kind,
    reason: reason ?? null,
    attemptId: attemptId ?? null,
    at: clock.now(),
    framesSent,
  })

  const emit = (phase, info) => {
    try {
      onPhase(phase, info)
    } catch {
      // 호출자 상태머신 오류가 전송 프로토콜을 막지 않는다.
    }
  }

  const safeRefuse = async (attemptId) => {
    try {
      await journal.refuseAttempt(attemptId)
    } catch {
      // 거절 기록 실패가 이미 확인된 zero-byte 거절 결과를 바꾸지 않는다.
    }
  }

  const safeReview = async (attemptId, reason) => {
    try {
      await journal.markReview(attemptId, reason)
    } catch {
      // review 기록 실패가 uncertain 반환을 막지 않는다.
    }
  }

  const callOptions = signal ? { signal } : {}
  // terminal.send(mutation)만 5초 전체 deadline을 건다. read/show 등은 기본값 유지.
  const sendCallOptions = { ...callOptions, timeoutMs: SEND_RPC_TIMEOUT_MS }

  // 1) abort 및 정책 사전검사(예약 전).
  if (signal?.aborted) {
    return makeResult('skipped', 'aborted', null, 0)
  }

  let gate
  try {
    gate = await assertAllowed()
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return makeResult('skipped', 'aborted', null, 0)
    }
    return makeResult('skipped', REASON_CODES.RUNTIME_UNAVAILABLE, null, 0)
  }
  if (!isObject(gate) || gate.allowed !== true) {
    return makeResult('skipped', denyReason(gate), null, 0)
  }

  // 2) preflight: 같은 target generation의 최신 observation.
  let observation
  try {
    observation = await inspect(target, callOptions)
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return makeResult('skipped', 'aborted', null, 0)
    }
    return makeResult('skipped', REASON_CODES.RUNTIME_UNAVAILABLE, null, 0)
  }
  const violation = preflightReason(observation, quietOutputMs, clock.now())
  if (violation !== null) {
    return makeResult('skipped', violation, null, 0)
  }

  // 3) paste 직전 attempt 예약(charged 증가 + lastAttempt 저장).
  let attemptId
  try {
    attemptId = await journal.reserveAttempt(target, epochId, clock.now())
  } catch {
    return makeResult('skipped', REASON_CODES.STORAGE_FAILED, null, 0)
  }
  emit('reserved', { attemptId, at: clock.now() })

  // 4) 예약 후 정책/abort 재확인.
  let gate2
  try {
    gate2 = await assertAllowed()
  } catch (error) {
    await safeRefuse(attemptId)
    const reason = isAbortError(error) || signal?.aborted ? 'aborted' : REASON_CODES.RUNTIME_UNAVAILABLE
    return makeResult('refused', reason, attemptId, 0)
  }
  if (!isObject(gate2) || gate2.allowed !== true) {
    await safeRefuse(attemptId)
    return makeResult('refused', denyReason(gate2), attemptId, 0)
  }
  if (signal?.aborted) {
    await safeRefuse(attemptId)
    return makeResult('refused', 'aborted', attemptId, 0)
  }

  // 5) guarded paste 1회. enter/interrupt/agentPrompt를 절대 함께 보내지 않는다.
  const pasteParams = {
    terminal: target.handle,
    text: `${PASTE_START}${message}${PASTE_END}`,
    requireAgentStatus: 'sendable',
    client: { id: clientId, type: DESKTOP_CLIENT_TYPE },
  }
  if (target.incarnationId !== null && target.incarnationId !== undefined) {
    pasteParams.expectedIncarnationId = target.incarnationId
  }

  let framesSent = 0
  let pasteResult
  try {
    framesSent = 1
    pasteResult = await rpc.call('terminal.send', pasteParams, sendCallOptions)
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    if (error instanceof RpcError && error.mayHaveWritten === false) {
      await safeRefuse(attemptId)
      return makeResult('refused', REASON_CODES.RUNTIME_UNAVAILABLE, attemptId, framesSent)
    }
    // 형식 이상/응답 유실/write 가능성 → 절대 재시도하지 않는다.
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  const pasteSend = extractSend(pasteResult)
  if (isObject(pasteSend) && pasteSend.accepted === true) {
    try {
      await journal.recordAttempt(attemptId, 'pasted')
    } catch {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    emit('pasted', { attemptId })
  } else if (isObject(pasteSend) && pasteSend.accepted === false && pasteSend.bytesWritten === 0) {
    await safeRefuse(attemptId)
    return makeResult('refused', refusedReasonToCode(pasteSend.refusedReason), attemptId, framesSent)
  } else {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  // 6) paste 확인: sleep(500) 후 최대 5초, 250ms 간격, draft 정확 일치.
  try {
    await clock.sleep(PASTE_SETTLE_MS, signal)
  } catch {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  const confirmDeadline = clock.now() + PASTE_CONFIRM_DEADLINE_MS
  let confirmed = false
  let polls = 0
  while (!confirmed) {
    if (signal?.aborted) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }

    let confirmObs = null
    try {
      confirmObs = await inspect(target, callOptions)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        await safeReview(attemptId, PARTIAL)
        return makeResult('uncertain', PARTIAL, attemptId, framesSent)
      }
      confirmObs = null
    }

    if (pasteVisible(confirmObs, message)) {
      confirmed = true
      break
    }
    // 사용자가 다른 값을 입력했거나 대상이 바뀌면 더 기다리지 않는다.
    if (isObject(confirmObs) && confirmObs.draft !== null && confirmObs.draft !== message) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    if (isObject(confirmObs) && confirmObs.stale === true) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    if (clock.now() >= confirmDeadline) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    polls += 1
    if (polls > MAX_CONFIRM_POLLS) {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
    try {
      await clock.sleep(PASTE_POLL_MS, signal)
    } catch {
      await safeReview(attemptId, PARTIAL)
      return makeResult('uncertain', PARTIAL, attemptId, framesSent)
    }
  }

  // 7) Enter 직전 정책 + 최신 관측 재확인(새 inspect, quietOutput은 검사 안 함).
  let gate3
  try {
    gate3 = await assertAllowed()
  } catch {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }
  if (!isObject(gate3) || gate3.allowed !== true) {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }
  if (signal?.aborted) {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  let recheckObs = null
  try {
    recheckObs = await inspect(target, callOptions)
  } catch {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }
  if (!recheckOk(recheckObs, message)) {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  // 8) guarded Enter 1회. text를 포함하지 않는다.
  const enterParams = {
    terminal: target.handle,
    enter: true,
    requireAgentStatus: 'sendable',
    client: { id: clientId, type: DESKTOP_CLIENT_TYPE },
  }
  if (target.incarnationId !== null && target.incarnationId !== undefined) {
    enterParams.expectedIncarnationId = target.incarnationId
  }

  let enterResult
  try {
    framesSent = 2
    enterResult = await rpc.call('terminal.send', enterParams, sendCallOptions)
  } catch {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  const enterSend = extractSend(enterResult)
  if (!isObject(enterSend) || enterSend.accepted !== true) {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  try {
    await journal.recordAttempt(attemptId, 'submitted')
  } catch {
    await safeReview(attemptId, PARTIAL)
    return makeResult('uncertain', PARTIAL, attemptId, framesSent)
  }

  const submittedAt = clock.now()
  emit('submitted', { attemptId, at: submittedAt })
  return { kind: 'submitted', reason: null, attemptId, at: submittedAt, framesSent }
}
