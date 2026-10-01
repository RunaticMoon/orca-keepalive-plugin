/**
 * Cache Keepalive 순수 스케줄러(epoch 상태 머신 + due 결정).
 *
 * 부작용이 없다: 시계·타이머·난수·파일·네트워크를 쓰지 않고 모든 시각을 입력으로
 * 받는다. 입력 state는 절대 변경하지 않고 매번 새 객체를 반환한다.
 * §5.4와 지휘자가 확정한 단순화 명세를 그대로 구현하며, 명세가 DESIGN과 다르면
 * 명세를 따른다.
 *
 * 시간 모델:
 * - 관측한 fresh working→done이 epoch를 연다.
 * - expiresAt = epoch.basisAt + ttlMs, dueAt = expiresAt - marginFor(ttlMs).
 *   basisAt은 턴의 마지막 working 이벤트 수신 시각(≈마지막 API 요청 시작)이며,
 *   없거나 doneAt과 TIMING.basisMaxGapMs 넘게 차이 나면 doneAt을 쓴다.
 * - dueAt..(expiresAt - TIMING.minimumRemainingMs) 사이에 keepalive를 epoch당 1회 시도한다.
 *
 * 내부 전용 입력 type(contracts.MACHINE_INPUT_TYPES에는 없지만 여기서 허용):
 * - `REVIEW_CLEARED`: NEEDS_REVIEW를 해제한다.
 * - `EXPIRE`: 'expire' 결정 뒤 epoch를 닫는다.
 * - `RESTORE_EPOCH`: 리로드 전 저장한 doneAt(및 basisAt)으로 초기 상태에 epoch를 복원한다.
 * - `RESTORE_CACHE_HISTORY`: 표시 이력 전용 복원. 초기 상태에 만료/취소 phase만 세우고
 *   예약(epoch/attempt)은 만들지 않는다.
 *
 * @module scheduler
 */

import { ALLOWED_TTLS, HOOK_STATES, TIMING } from './contracts.mjs';

/**
 * @typedef {'UNKNOWN'|'BUSY'|'ARMED'|'CHECKING'|'PASTING'|'SUBMITTING'|'AWAITING_TURN'|'SUSPENDED'|'NEEDS_REVIEW'|'EXPIRED'} SchedulerPhase
 */

/**
 * epoch. doneAt은 첫 인정 done의 receivedAt, basisAt은 캐시 TTL 기준 시각
 * (마지막 working 이벤트 수신 시각. 없거나 doneAt과 3분 넘게 차이 나면 doneAt).
 * @typedef {Object} SchedulerEpoch
 * @property {number} id 내부 단조 정수.
 * @property {number} doneAt
 * @property {number} basisAt
 * @property {boolean} attempted
 */

/**
 * 진행 중 attempt.
 * @typedef {Object} SchedulerAttempt
 * @property {string} id
 * @property {number} epochId
 * @property {'reserved'|'pasted'|'submitted'} phase
 * @property {number} startedAt
 * @property {number|null} submittedAt
 */

/**
 * 순수 reducer의 target 상태.
 * @typedef {Object} SchedulerState
 * @property {Object} target
 * @property {SchedulerPhase} phase
 * @property {'working'|'blocked'|'waiting'|'done'|null} lastHook
 * @property {number|null} lastHookAt
 * @property {number|null} lastWorkingAt 마지막 working 이벤트 receivedAt. epoch basisAt 계산에 쓴다.
 * @property {boolean} seenWorking
 * @property {number} epochSeq
 * @property {SchedulerEpoch|null} epoch
 * @property {SchedulerAttempt|null} attempt
 * @property {string|null} reason
 * @property {number} generation
 * @property {number} budgetResetSeq
 * @property {number} selfTurnSeq
 */

/**
 * scheduler 결정.
 * @typedef {Object} SchedulerDecision
 * @property {'wait'|'send'|'expire'} kind
 * @property {string|null} reason
 * @property {number} [nextAt]
 * @property {number} [dueAt]
 * @property {number} [expiresAt]
 * @property {number} [epochId]
 */

/**
 * marginFor에 쓰는 config shape.
 * @typedef {Object} MarginConfig
 * @property {number} margin5mMs
 * @property {number} margin1hMs
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * state의 최상위와 epoch/attempt를 새 객체로 복사한다.
 * 중첩 객체를 고칠 때 원본 state를 건드리지 않기 위한 얕은 복사 + 중첩 복사다.
 * @param {SchedulerState} state
 * @returns {SchedulerState}
 */
function copyState(state) {
  return {
    ...state,
    epoch: state.epoch === null ? null : { ...state.epoch },
    attempt: state.attempt === null ? null : { ...state.attempt },
  };
}

/**
 * TTL에 대응하는 여유(ms)를 돌려준다. 허용 TTL이 아니면 null.
 * @param {number} ttlMs
 * @param {MarginConfig} config
 * @returns {number|null}
 */
export function marginFor(ttlMs, config) {
  if (ttlMs === ALLOWED_TTLS[0]) {
    return config.margin5mMs;
  }
  if (ttlMs === ALLOWED_TTLS[1]) {
    return config.margin1hMs;
  }
  return null;
}

/**
 * epoch의 캐시 TTL 기준 시각을 돌려준다.
 * lastWorkingAt이 유한수이고 doneAt 이하이며 doneAt과의 간격이 TIMING.basisMaxGapMs
 * 이하이면 그 값을, 아니면 doneAt을 쓴다(도구별 working 이벤트를 못 받은 긴 턴 보호).
 * @param {unknown} lastWorkingAt
 * @param {number} doneAt
 * @returns {number}
 */
export function cacheBasisAt(lastWorkingAt, doneAt) {
  if (
    isFiniteNumber(lastWorkingAt) &&
    lastWorkingAt <= doneAt &&
    doneAt - lastWorkingAt <= TIMING.basisMaxGapMs
  ) {
    return lastWorkingAt;
  }
  return doneAt;
}

/**
 * 새 target의 초기 상태. 첫 fresh working을 보기 전에는 예약하지 않는다.
 * @param {Object} target
 * @returns {SchedulerState}
 */
export function initialTargetState(target) {
  return {
    target,
    phase: 'UNKNOWN',
    lastHook: null,
    lastHookAt: null,
    lastWorkingAt: null,
    seenWorking: false,
    epochSeq: 0,
    epoch: null,
    attempt: null,
    reason: 'NO_FRESH_TURN',
    generation: 0,
    budgetResetSeq: 0,
    selfTurnSeq: 0,
  };
}

/**
 * HOOK 이벤트를 반영한다. agent.status.changed payload의 state/receivedAt/
 * mainAgentState/now를 쓴다.
 * @param {SchedulerState} state
 * @param {{state?:string, receivedAt?:number, mainAgentState?:string|null, now?:number}} input
 * @returns {SchedulerState}
 */
function reduceHook(state, input) {
  const hookState = input.state;
  const receivedAt = input.receivedAt;

  if (!HOOK_STATES.includes(hookState)) {
    return copyState(state);
  }
  if (!isFiniteNumber(receivedAt)) {
    return copyState(state);
  }
  // 같은 pane에서 단조 증가하는 이벤트만 적용한다.
  if (state.lastHookAt !== null && receivedAt < state.lastHookAt) {
    return copyState(state);
  }
  // 미래 시각은 unknown으로 보고 무시한다.
  if (isFiniteNumber(input.now) && receivedAt > input.now + TIMING.clockSkewMs) {
    return copyState(state);
  }

  const next = copyState(state);
  next.lastHookAt = receivedAt;

  if (hookState === 'working') {
    // 첫 working과 중복 working 모두 마지막 working 시각을 갱신한다.
    next.lastWorkingAt = receivedAt;
    if (state.lastHook === 'working') {
      // 중복 working: lastHookAt만 갱신한다.
      return next;
    }
    next.lastHook = 'working';
    next.seenWorking = true;

    const attempt = state.attempt;
    const confirmedAt =
      attempt !== null && isFiniteNumber(attempt.submittedAt) ? attempt.submittedAt : receivedAt;
    const selfTurn =
      (state.phase === 'AWAITING_TURN' || state.phase === 'SUBMITTING') &&
      attempt !== null &&
      confirmedAt + TIMING.turnStartConfirmMs >= receivedAt;

    if (selfTurn) {
      // 자체 keepalive가 연 turn: budget을 유지한다.
      next.phase = 'BUSY';
      next.selfTurnSeq = state.selfTurnSeq + 1;
      next.attempt = null;
      next.epoch = null;
      next.reason = 'BUSY';
      return next;
    }

    // 실제 작업 turn.
    next.budgetResetSeq = state.budgetResetSeq + 1;
    if (state.phase === 'NEEDS_REVIEW') {
      // 사용자가 확인하기 전까지 phase/epoch/attempt/reason을 유지하고
      // budgetResetSeq만 올린다.
      return next;
    }
    if (state.phase === 'PASTING') {
      // 진행 중 전송의 완료 콜백을 무효화한다.
      next.generation = state.generation + 1;
    }
    next.phase = 'BUSY';
    next.epoch = null;
    next.attempt = null;
    next.reason = 'BUSY';
    return next;
  }

  if (hookState === 'blocked' || hookState === 'waiting') {
    next.lastHook = hookState;
    next.epoch = null;
    if (state.phase !== 'NEEDS_REVIEW') {
      next.phase = 'SUSPENDED';
    }
    next.reason = 'INTERACTIVE_WAIT';
    if (state.phase === 'PASTING' || state.phase === 'SUBMITTING') {
      next.generation = state.generation + 1;
    }
    return next;
  }

  // hookState === 'done'
  if (state.lastHook === 'done') {
    // 중복 done: lastHookAt만 갱신하고 deadline을 늦추지 않는다.
    return next;
  }
  next.lastHook = 'done';

  if (state.seenWorking === false) {
    // 첫 done은 예약하지 않는다. 초기 관측 부재(UNKNOWN)에서만 안내 문구를 갱신하고,
    // 복원된 만료/중단 이력(EXPIRED/SUSPENDED)의 phase·reason은 덮지 않는다.
    if (state.phase === 'UNKNOWN') {
      next.reason = 'NO_FRESH_TURN';
    }
    return next;
  }
  if (
    input.mainAgentState !== undefined &&
    input.mainAgentState !== null &&
    input.mainAgentState !== 'done'
  ) {
    // combined가 done이어도 mainAgent가 아직 끝나지 않았다.
    next.phase = 'BUSY';
    next.reason = 'BUSY';
    next.epoch = null;
    return next;
  }
  if (state.phase === 'NEEDS_REVIEW') {
    // 검토 전에는 예약하지 않는다.
    next.phase = 'NEEDS_REVIEW';
    return next;
  }

  const epochSeq = state.epochSeq + 1;
  next.epochSeq = epochSeq;
  next.epoch = {
    id: epochSeq,
    doneAt: receivedAt,
    basisAt: cacheBasisAt(state.lastWorkingAt, receivedAt),
    attempted: false,
  };
  next.lastWorkingAt = null;
  next.phase = 'ARMED';
  next.reason = null;
  return next;
}

/**
 * 정책 무효화: 진행 중 예약/attempt를 폐기하고 SUSPENDED로 둔다.
 * seenWorking은 유지하므로 다음 working→done에서 다시 예약한다.
 * @param {SchedulerState} state
 * @param {{reason?:string}} input
 * @returns {SchedulerState}
 */
function reducePolicyInvalidated(state, input) {
  const next = copyState(state);
  next.generation = state.generation + 1;
  next.epoch = null;
  next.attempt = null;
  next.phase = state.phase === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'SUSPENDED';
  next.reason = input.reason;
  return next;
}

/**
 * 대상 교체: 상태를 초기화하되 단조 카운터는 이어받는다.
 * @param {SchedulerState} state
 * @param {{target?:Object}} input
 * @returns {SchedulerState}
 */
function reduceTargetChanged(state, input) {
  const base = initialTargetState(input.target);
  return {
    ...base,
    epochSeq: state.epochSeq,
    generation: state.generation + 1,
    budgetResetSeq: state.budgetResetSeq,
    selfTurnSeq: state.selfTurnSeq,
  };
}

/**
 * clock gap/절전: 모든 시간 예약을 폐기한다.
 * @param {SchedulerState} state
 * @returns {SchedulerState}
 */
function reduceClockGap(state) {
  const next = copyState(state);
  next.generation = state.generation + 1;
  next.epoch = null;
  next.attempt = null;
  next.phase = state.phase === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'EXPIRED';
  next.reason = 'EXPIRED';
  return next;
}

/**
 * @param {SchedulerState} state
 * @param {{attemptId?:string, epochId?:number, at?:number, generation?:number}} input
 * @returns {SchedulerState}
 */
function reduceAttemptReserved(state, input) {
  const next = copyState(state);
  const eligible =
    input.generation === state.generation &&
    state.phase === 'ARMED' &&
    state.epoch !== null &&
    state.epoch.id === input.epochId &&
    state.epoch.attempted === false;
  if (!eligible) {
    return next;
  }
  next.phase = 'PASTING';
  next.epoch = { ...state.epoch, attempted: true };
  next.attempt = {
    id: input.attemptId,
    epochId: input.epochId,
    phase: 'reserved',
    startedAt: input.at,
    submittedAt: null,
  };
  return next;
}

/**
 * @param {SchedulerState} state
 * @param {{attemptId?:string, generation?:number}} input
 * @returns {SchedulerState}
 */
function reducePasteAccepted(state, input) {
  const next = copyState(state);
  if (
    input.generation !== state.generation ||
    state.attempt === null ||
    state.attempt.id !== input.attemptId ||
    state.phase !== 'PASTING'
  ) {
    return next;
  }
  next.phase = 'SUBMITTING';
  next.attempt = { ...state.attempt, phase: 'pasted' };
  return next;
}

/**
 * @param {SchedulerState} state
 * @param {{attemptId?:string, at?:number, generation?:number}} input
 * @returns {SchedulerState}
 */
function reduceSubmitAccepted(state, input) {
  const next = copyState(state);
  if (
    input.generation !== state.generation ||
    state.attempt === null ||
    state.attempt.id !== input.attemptId ||
    state.phase !== 'SUBMITTING'
  ) {
    return next;
  }
  next.phase = 'AWAITING_TURN';
  next.attempt = { ...state.attempt, phase: 'submitted', submittedAt: input.at };
  return next;
}

/**
 * 명확히 거절된 전송: epoch를 폐기하고 다음 turn을 기다린다.
 * @param {SchedulerState} state
 * @param {{attemptId?:string, reason?:string}} input
 * @returns {SchedulerState}
 */
function reduceSendRefused(state, input) {
  const next = copyState(state);
  if (state.attempt === null || state.attempt.id !== input.attemptId) {
    return next;
  }
  next.attempt = null;
  next.epoch = null;
  next.phase = 'SUSPENDED';
  next.reason = input.reason;
  return next;
}

/**
 * 결과가 불확실한 전송: 안전 우선으로 generation과 무관하게 NEEDS_REVIEW로 둔다.
 * @param {SchedulerState} state
 * @param {{attemptId?:string, reason?:string}} input
 * @returns {SchedulerState}
 */
function reduceSendUncertain(state, input) {
  const next = copyState(state);
  const attemptMatches = state.attempt !== null && state.attempt.id === input.attemptId;
  const phaseInFlight =
    state.phase === 'PASTING' || state.phase === 'SUBMITTING' || state.phase === 'AWAITING_TURN';
  if (!attemptMatches && !phaseInFlight) {
    return next;
  }
  next.phase = 'NEEDS_REVIEW';
  next.reason = 'PARTIAL_OR_UNKNOWN_SEND';
  next.epoch = null;
  return next;
}

/**
 * 검토 해제: 다음 fresh working→done부터 재개한다.
 * @param {SchedulerState} state
 * @returns {SchedulerState}
 */
function reduceReviewCleared(state) {
  const next = copyState(state);
  if (state.phase !== 'NEEDS_REVIEW') {
    return next;
  }
  next.phase = 'UNKNOWN';
  next.seenWorking = false;
  next.attempt = null;
  next.reason = 'NO_FRESH_TURN';
  return next;
}

/**
 * turn-start 확인 성공: HOOK working과 같은 자체 turn 처리.
 * @param {SchedulerState} state
 * @returns {SchedulerState}
 */
function reduceTurnConfirmed(state) {
  const next = copyState(state);
  if (state.phase !== 'AWAITING_TURN') {
    return next;
  }
  next.phase = 'BUSY';
  next.selfTurnSeq = state.selfTurnSeq + 1;
  next.attempt = null;
  next.epoch = null;
  next.reason = 'BUSY';
  next.seenWorking = true;
  next.lastHook = 'working';
  return next;
}

/**
 * tick: turn-start 확인 창이 지나도록 working이 없으면 결과 불확실로 본다.
 * @param {SchedulerState} state
 * @param {{now?:number}} input
 * @returns {SchedulerState}
 */
function reduceTick(state, input) {
  const next = copyState(state);
  if (
    state.phase === 'AWAITING_TURN' &&
    state.attempt !== null &&
    isFiniteNumber(state.attempt.submittedAt) &&
    isFiniteNumber(input.now) &&
    input.now > state.attempt.submittedAt + TIMING.turnStartConfirmMs
  ) {
    next.phase = 'NEEDS_REVIEW';
    next.reason = 'PARTIAL_OR_UNKNOWN_SEND';
  }
  return next;
}

/**
 * 'expire' 결정 반영: epoch를 닫는다.
 * @param {SchedulerState} state
 * @param {{epochId?:number}} input
 * @returns {SchedulerState}
 */
function reduceExpire(state, input) {
  const next = copyState(state);
  if (state.phase !== 'ARMED' || state.epoch === null || state.epoch.id !== input.epochId) {
    return next;
  }
  next.phase = 'EXPIRED';
  next.epoch = null;
  next.reason = 'EXPIRED';
  return next;
}

/**
 * 리로드 복원: 저장해 둔 마지막 done 시각과 캐시 기준 시각으로 epoch를 되살린다.
 * 예약 이력이 전혀 없는 초기 상태에서만 적용하며, 조건이 맞지 않으면 그대로 반환한다.
 * @param {SchedulerState} state
 * @param {{doneAt?:number, basisAt?:number, now?:number}} input
 * @returns {SchedulerState}
 */
function reduceRestoreEpoch(state, input) {
  const { doneAt, basisAt, now } = input;
  const eligible =
    isFiniteNumber(doneAt) &&
    isFiniteNumber(now) &&
    doneAt <= now + TIMING.clockSkewMs &&
    state.phase === 'UNKNOWN' &&
    state.epoch === null &&
    state.seenWorking === false &&
    state.lastHook !== 'working' &&
    state.attempt === null;
  if (!eligible) {
    return copyState(state);
  }
  const next = copyState(state);
  next.seenWorking = true;
  next.lastHook = 'done';
  next.lastHookAt = Math.max(state.lastHookAt ?? -Infinity, doneAt);
  const epochSeq = state.epochSeq + 1;
  next.epochSeq = epochSeq;
  next.epoch = { id: epochSeq, doneAt, basisAt: cacheBasisAt(basisAt, doneAt), attempted: false };
  next.phase = 'ARMED';
  next.reason = null;
  return next;
}

/**
 * 표시 이력 전용 복원(§2-5): 예약 이력이 전혀 없는 초기 상태에서만 저장된 만료/취소
 * 상태를 되살린다. 예약(epoch/attempt)은 만들지 않고, seenWorking=false와 모든 단조
 * 카운터를 그대로 둔다. 조건이 맞지 않으면 상태를 변경하지 않고 반환한다.
 * - expired=true: 만료 이력 → EXPIRED/EXPIRED.
 * - expired=false: 만료 전 취소 이력 → SUSPENDED(입력 reason이 문자열이면 그 값,
 *   아니면 NO_FRESH_TURN).
 * @param {SchedulerState} state
 * @param {{expired?:boolean, reason?:string, at?:number}} input
 * @returns {SchedulerState}
 */
function reduceRestoreCacheHistory(state, input) {
  const eligible =
    typeof input.expired === 'boolean' &&
    state.phase === 'UNKNOWN' &&
    state.epoch === null &&
    state.attempt === null &&
    state.seenWorking === false &&
    state.lastHook !== 'working';
  if (!eligible) {
    return copyState(state);
  }
  const next = copyState(state);
  if (input.expired === true) {
    next.phase = 'EXPIRED';
    next.reason = 'EXPIRED';
  } else {
    next.phase = 'SUSPENDED';
    next.reason = typeof input.reason === 'string' ? input.reason : 'NO_FRESH_TURN';
  }
  return next;
}

/**
 * target 상태 머신 reducer. 알 수 없는 type은 조용히 무시한다(throw 금지).
 * 어떤 경우에도 입력 state를 변경하지 않고 새 객체를 반환한다.
 * @param {SchedulerState} state
 * @param {{type?:string} & Record<string, unknown>} input
 * @returns {SchedulerState}
 */
export function reduceTarget(state, input) {
  if (input === null || typeof input !== 'object') {
    return copyState(state);
  }
  switch (input.type) {
    case 'HOOK':
      return reduceHook(state, input);
    case 'POLICY_INVALIDATED':
      return reducePolicyInvalidated(state, input);
    case 'TARGET_CHANGED':
      return reduceTargetChanged(state, input);
    case 'CLOCK_GAP':
      return reduceClockGap(state);
    case 'ATTEMPT_RESERVED':
      return reduceAttemptReserved(state, input);
    case 'PASTE_ACCEPTED':
      return reducePasteAccepted(state, input);
    case 'SUBMIT_ACCEPTED':
      return reduceSubmitAccepted(state, input);
    case 'SEND_REFUSED':
      return reduceSendRefused(state, input);
    case 'SEND_UNCERTAIN':
      return reduceSendUncertain(state, input);
    case 'REVIEW_CLEARED':
      return reduceReviewCleared(state);
    case 'TURN_CONFIRMED':
      return reduceTurnConfirmed(state);
    case 'TICK':
      return reduceTick(state, input);
    case 'EXPIRE':
      return reduceExpire(state, input);
    case 'RESTORE_EPOCH':
      return reduceRestoreEpoch(state, input);
    case 'RESTORE_CACHE_HISTORY':
      return reduceRestoreCacheHistory(state, input);
    default:
      return copyState(state);
  }
}

/**
 * 현재 상태에서 다음 행동을 결정한다.
 * @param {SchedulerState} state
 * @param {{
 *   now: number,
 *   settings: {known:boolean, ttlMs:number},
 *   policy: {allowed:boolean, reason:string|null},
 *   config: MarginConfig,
 * }} env
 * @returns {SchedulerDecision}
 */
export function decide(state, env) {
  const { now, settings, policy, config } = env;

  if (state.phase !== 'ARMED' || state.epoch === null) {
    return { kind: 'wait', reason: state.reason };
  }
  if (settings === null || settings === undefined || settings.known !== true) {
    return { kind: 'wait', reason: 'SETTINGS_UNKNOWN' };
  }
  const margin = marginFor(settings.ttlMs, config);
  if (margin === null) {
    return { kind: 'wait', reason: 'SETTINGS_UNKNOWN' };
  }

  const expiresAt = (state.epoch.basisAt ?? state.epoch.doneAt) + settings.ttlMs;
  const dueAt = expiresAt - margin;

  if (state.epoch.attempted) {
    return { kind: 'wait', reason: 'NO_FRESH_TURN', dueAt, expiresAt };
  }
  if (now >= expiresAt - TIMING.minimumRemainingMs) {
    return { kind: 'expire', reason: 'EXPIRED', dueAt, expiresAt };
  }
  if (policy === null || policy === undefined || policy.allowed !== true) {
    return {
      kind: 'wait',
      reason: policy === null || policy === undefined ? 'SCOPE_DISABLED' : policy.reason,
      dueAt,
      expiresAt,
    };
  }
  if (now < dueAt) {
    return { kind: 'wait', reason: null, nextAt: dueAt, dueAt, expiresAt };
  }
  return { kind: 'send', reason: null, epochId: state.epoch.id, dueAt, expiresAt };
}
