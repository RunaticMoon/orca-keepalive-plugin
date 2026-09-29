import test from 'node:test';
import assert from 'node:assert/strict';

import { TIMING } from '../src/contracts.mjs';
import { decide, initialTargetState, marginFor, reduceTarget } from '../src/scheduler.mjs';

const TARGET = Object.freeze({
  targetId: 't1',
  runtimeId: 'rt',
  profileId: 'p',
  worktreeId: 'w',
  paneKey: 'tab:leaf',
  ptyId: 'pty',
  incarnationId: null,
  handle: 'h',
});

const CONFIG = { margin5mMs: 60000, margin1hMs: 120000 };
const TTL_5M = 300000;
const TTL_1H = 3600000;

/**
 * HOOK 입력을 만든다. 기본 now=receivedAt.
 * @param {string} state
 * @param {number} receivedAt
 * @param {{now?:number, mainAgentState?:string|null}} [opts]
 */
function hook(state, receivedAt, opts = {}) {
  const input = { type: 'HOOK', state, receivedAt, now: opts.now ?? receivedAt };
  if ('mainAgentState' in opts) {
    input.mainAgentState = opts.mainAgentState;
  }
  return input;
}

/** @param {import('../src/scheduler.mjs').SchedulerState} state */
function reduce(state, input) {
  return reduceTarget(state, input);
}

function settings(overrides = {}) {
  return { known: true, enabled: true, ttlMs: TTL_5M, ...overrides };
}

function policy(overrides = {}) {
  return { allowed: true, reason: null, ...overrides };
}

function decideWith(state, now, settingsOverrides = {}, policyOverrides = {}) {
  return decide(state, {
    now,
    settings: settings(settingsOverrides),
    policy: policy(policyOverrides),
    config: CONFIG,
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/** working(0) → done(doneAt)로 ARMED epoch를 만든다. */
function armed(doneAt) {
  let state = reduce(initialTargetState(TARGET), hook('working', 0));
  state = reduce(state, hook('done', doneAt));
  return state;
}

/** ARMED(2000) 뒤 ATTEMPT_RESERVED까지 적용한 PASTING 상태. */
function withAttempt(attemptId = 'a1', at = 3000) {
  let state = armed(2000);
  state = reduce(state, { type: 'ATTEMPT_RESERVED', attemptId, epochId: 1, at, generation: 0 });
  return state;
}

/** PASTING→SUBMITTING→AWAITING_TURN을 거친 상태. */
function awaitingTurn(submitAt = 3100) {
  let state = withAttempt('a1', 3000);
  state = reduce(state, { type: 'PASTE_ACCEPTED', attemptId: 'a1', generation: 0 });
  state = reduce(state, { type: 'SUBMIT_ACCEPTED', attemptId: 'a1', at: submitAt, generation: 0 });
  return state;
}

// ---------------------------------------------------------------------------
// marginFor / initialTargetState
// ---------------------------------------------------------------------------

test('marginFor: 허용 TTL만 여유를 돌려준다', () => {
  assert.equal(marginFor(TTL_5M, CONFIG), 60000);
  assert.equal(marginFor(TTL_1H, CONFIG), 120000);
  assert.equal(marginFor(600000, CONFIG), null);
  assert.equal(marginFor(0, CONFIG), null);
});

test('initialTargetState는 계약 shape을 만든다', () => {
  assert.deepEqual(initialTargetState(TARGET), {
    target: TARGET,
    phase: 'UNKNOWN',
    lastHook: null,
    lastHookAt: null,
    seenWorking: false,
    epochSeq: 0,
    epoch: null,
    attempt: null,
    reason: 'NO_FRESH_TURN',
    generation: 0,
    budgetResetSeq: 0,
    selfTurnSeq: 0,
  });
});

// ---------------------------------------------------------------------------
// HOOK / epoch 예약
// ---------------------------------------------------------------------------

test('첫 done은 예약하지 않는다', () => {
  const state = reduce(initialTargetState(TARGET), hook('done', 1000));
  assert.equal(state.phase, 'UNKNOWN');
  assert.equal(state.epoch, null);
  assert.equal(state.reason, 'NO_FRESH_TURN');
  assert.equal(state.lastHook, 'done');
});

test('fresh working→done이 ARMED epoch를 연다', () => {
  let state = reduce(initialTargetState(TARGET), hook('working', 1000));
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.seenWorking, true);
  state = reduce(state, hook('done', 2000));
  assert.equal(state.phase, 'ARMED');
  assert.deepEqual(state.epoch, { id: 1, doneAt: 2000, attempted: false });
  assert.equal(state.epochSeq, 1);
  assert.equal(state.reason, null);
});

test('중복 done은 doneAt을 늦추지 않는다', () => {
  let state = armed(2000);
  state = reduce(state, hook('done', 9000));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.doneAt, 2000);
  assert.equal(state.lastHookAt, 9000);
});

test('늦게 온(receivedAt 과거) 이벤트는 무시한다', () => {
  const state = armed(5000);
  const before = JSON.stringify(state);
  const after = reduce(state, hook('working', 4000));
  assert.equal(JSON.stringify(after), before);
});

test('미래 skew를 넘는 이벤트는 무시하고 경계값은 허용한다', () => {
  const base = initialTargetState(TARGET);
  const skewed = reduce(
    base,
    hook('working', 20000, { now: 20000 - TIMING.clockSkewMs - 1 }),
  );
  assert.equal(skewed.phase, 'UNKNOWN');
  assert.equal(skewed.lastHook, null);

  const boundary = reduce(base, hook('working', 20000, { now: 20000 - TIMING.clockSkewMs }));
  assert.equal(boundary.phase, 'BUSY');
});

test('combined done + mainAgent working이면 BUSY(예약 없음)', () => {
  let state = reduce(initialTargetState(TARGET), hook('working', 1000));
  state = reduce(state, hook('done', 2000, { mainAgentState: 'working' }));
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.epoch, null);
  assert.equal(state.reason, 'BUSY');
});

test('combined done + mainAgent done이면 ARMED', () => {
  let state = reduce(initialTargetState(TARGET), hook('working', 1000));
  state = reduce(state, hook('done', 2000, { mainAgentState: 'done' }));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.id, 1);
});

// ---------------------------------------------------------------------------
// decide: due/expire 경계
// ---------------------------------------------------------------------------

test('decide: TTL 5m/margin 60s 경계(t+239999 wait, t+240000 send, t+290000 expire)', () => {
  const done = 1_000_000;
  const state = armed(done);
  const expiresAt = done + TTL_5M;
  const dueAt = expiresAt - 60000; // done + 240000

  const wait = decideWith(state, dueAt - 1);
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.reason, null);
  assert.equal(wait.nextAt, dueAt);
  assert.equal(wait.dueAt, dueAt);
  assert.equal(wait.expiresAt, expiresAt);

  const send = decideWith(state, dueAt);
  assert.equal(send.kind, 'send');
  assert.equal(send.reason, null);
  assert.equal(send.epochId, 1);
  assert.equal(send.dueAt, dueAt);
  assert.equal(send.expiresAt, expiresAt);

  const expire = decideWith(state, expiresAt - TIMING.minimumRemainingMs);
  assert.equal(expire.kind, 'expire');
  assert.equal(expire.reason, 'EXPIRED');
  assert.equal(expire.expiresAt, expiresAt);
});

test('decide: TTL 1h/margin 120s dueAt', () => {
  const done = 1_000_000;
  const state = armed(done);
  const result = decideWith(state, 0, { ttlMs: TTL_1H });
  assert.equal(result.kind, 'wait');
  assert.equal(result.dueAt, done + TTL_1H - 120000); // t + 3480000
  assert.equal(result.expiresAt, done + TTL_1H);
});

test('decide: ARMED가 아니면 state.reason으로 wait', () => {
  const state = initialTargetState(TARGET);
  assert.deepEqual(decideWith(state, 0), { kind: 'wait', reason: 'NO_FRESH_TURN' });
});

test('decide: settings unknown/disabled/잘못된 TTL', () => {
  const state = armed(1000);
  assert.equal(decideWith(state, 5000, { known: false }).reason, 'SETTINGS_UNKNOWN');
  assert.equal(decideWith(state, 5000, { enabled: false }).reason, 'APP_TIMER_OFF');
  assert.equal(decideWith(state, 5000, { ttlMs: 600000 }).reason, 'SETTINGS_UNKNOWN');
});

test('decide: policy false는 reason을 그대로, nextAt 없음', () => {
  const state = armed(1000);
  const result = decideWith(state, 100000, {}, { allowed: false, reason: 'SCOPE_DISABLED' });
  assert.equal(result.kind, 'wait');
  assert.equal(result.reason, 'SCOPE_DISABLED');
  assert.equal(result.nextAt, undefined);
  assert.equal(typeof result.dueAt, 'number');
  assert.equal(typeof result.expiresAt, 'number');
});

test('decide: epoch.attempted면 NO_FRESH_TURN', () => {
  const state = armed(1000);
  const attempted = { ...state, epoch: { ...state.epoch, attempted: true } };
  const result = decideWith(attempted, 1000 + 240000 + 1000);
  assert.equal(result.kind, 'wait');
  assert.equal(result.reason, 'NO_FRESH_TURN');
});

test('decide: TTL 변경 시 dueAt 재계산, 이미 지났으면 expire', () => {
  const done = 1000;
  const state = armed(done);
  const now = done + 250000;
  assert.equal(decideWith(state, now, { ttlMs: TTL_5M }).kind, 'send');
  assert.equal(decideWith(state, now, { ttlMs: TTL_1H }).kind, 'wait');
  assert.equal(
    decideWith(state, done + TTL_5M - TIMING.minimumRemainingMs, { ttlMs: TTL_5M }).kind,
    'expire',
  );
});

// ---------------------------------------------------------------------------
// 전송 순환: 자체 turn vs 실제 작업 turn
// ---------------------------------------------------------------------------

test('자체 순환: 예약→paste→submit→working(10초 후) 자체 turn→done 새 epoch', () => {
  let state = armed(2000);
  const baseBudget = state.budgetResetSeq;
  assert.equal(baseBudget, 1);
  assert.equal(state.selfTurnSeq, 0);

  state = reduce(state, { type: 'ATTEMPT_RESERVED', attemptId: 'a1', epochId: 1, at: 3000, generation: 0 });
  assert.equal(state.phase, 'PASTING');
  assert.equal(state.epoch.attempted, true);
  assert.deepEqual(state.attempt, {
    id: 'a1',
    epochId: 1,
    phase: 'reserved',
    startedAt: 3000,
    submittedAt: null,
  });

  state = reduce(state, { type: 'PASTE_ACCEPTED', attemptId: 'a1', generation: 0 });
  assert.equal(state.phase, 'SUBMITTING');
  assert.equal(state.attempt.phase, 'pasted');

  state = reduce(state, { type: 'SUBMIT_ACCEPTED', attemptId: 'a1', at: 3100, generation: 0 });
  assert.equal(state.phase, 'AWAITING_TURN');
  assert.equal(state.attempt.phase, 'submitted');
  assert.equal(state.attempt.submittedAt, 3100);

  state = reduce(state, hook('working', 3100 + 10000));
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.selfTurnSeq, 1);
  assert.equal(state.budgetResetSeq, baseBudget);
  assert.equal(state.attempt, null);
  assert.equal(state.epoch, null);
  assert.equal(state.reason, 'BUSY');

  state = reduce(state, hook('done', 3100 + 11000));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.id, 2);
});

test('SUBMITTING 중 working 관측도 자체 turn', () => {
  let state = withAttempt('a1', 3000);
  state = reduce(state, { type: 'PASTE_ACCEPTED', attemptId: 'a1', generation: 0 });
  assert.equal(state.phase, 'SUBMITTING');
  const budget = state.budgetResetSeq;
  state = reduce(state, hook('working', 3100));
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.selfTurnSeq, 1);
  assert.equal(state.budgetResetSeq, budget);
});

test('TURN_CONFIRMED는 HOOK working 자체 turn과 같다', () => {
  let state = awaitingTurn(3100);
  state = reduce(state, { type: 'TURN_CONFIRMED', at: 3200 });
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.selfTurnSeq, 1);
  assert.equal(state.epoch, null);
  assert.equal(state.attempt, null);
  assert.equal(state.reason, 'BUSY');
});

test('실제 작업: ARMED에서 fresh working은 budgetResetSeq+1', () => {
  let state = armed(2000);
  const before = state.budgetResetSeq;
  state = reduce(state, hook('working', 3000));
  assert.equal(state.phase, 'BUSY');
  assert.equal(state.budgetResetSeq, before + 1);
  assert.equal(state.epoch, null);
});

// ---------------------------------------------------------------------------
// NEEDS_REVIEW / TICK
// ---------------------------------------------------------------------------

test('SUBMIT 후 working 미관측 15초 TICK → NEEDS_REVIEW', () => {
  const state = awaitingTurn(3100);
  const before = reduce(state, { type: 'TICK', now: 3100 + TIMING.turnStartConfirmMs });
  assert.equal(before.phase, 'AWAITING_TURN');
  const after = reduce(state, { type: 'TICK', now: 3100 + TIMING.turnStartConfirmMs + 1 });
  assert.equal(after.phase, 'NEEDS_REVIEW');
  assert.equal(after.reason, 'PARTIAL_OR_UNKNOWN_SEND');
});

test('NEEDS_REVIEW에서는 working/done이 새 예약을 만들지 않는다', () => {
  let state = reduce(awaitingTurn(3100), {
    type: 'TICK',
    now: 3100 + TIMING.turnStartConfirmMs + 1,
  });
  assert.equal(state.phase, 'NEEDS_REVIEW');
  const budget = state.budgetResetSeq;
  // TICK은 명세상 phase/reason만 바꾸므로 epoch 객체는 그대로 남는다.
  // 핵심은 working/done이 새 ARMED epoch를 열지 않는다는 점이다.
  assert.equal(state.epoch.id, 1);

  state = reduce(state, hook('working', 50000));
  assert.equal(state.phase, 'NEEDS_REVIEW');
  assert.equal(state.budgetResetSeq, budget + 1);
  assert.equal(state.epoch.id, 1);
  assert.notEqual(state.phase, 'ARMED');

  state = reduce(state, hook('done', 51000));
  assert.equal(state.phase, 'NEEDS_REVIEW');
  assert.equal(state.epoch.id, 1);
  assert.notEqual(state.phase, 'ARMED');
});

test('REVIEW_CLEARED 후 working→done이면 ARMED', () => {
  let state = reduce(awaitingTurn(3100), {
    type: 'TICK',
    now: 3100 + TIMING.turnStartConfirmMs + 1,
  });
  state = reduce(state, { type: 'REVIEW_CLEARED' });
  assert.equal(state.phase, 'UNKNOWN');
  assert.equal(state.seenWorking, false);
  assert.equal(state.attempt, null);
  assert.equal(state.reason, 'NO_FRESH_TURN');

  state = reduce(state, hook('working', 60000));
  state = reduce(state, hook('done', 61000));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.id, 2);
});

// ---------------------------------------------------------------------------
// generation / epoch당 1회
// ---------------------------------------------------------------------------

test('generation 불일치 ATTEMPT_RESERVED/PASTE_ACCEPTED는 무시', () => {
  const state = armed(2000);
  const before = JSON.stringify(state);
  const stale = reduce(state, {
    type: 'ATTEMPT_RESERVED',
    attemptId: 'a1',
    epochId: 1,
    at: 3000,
    generation: 5,
  });
  assert.equal(JSON.stringify(stale), before);
  assert.equal(stale.phase, 'ARMED');

  const reserved = reduce(state, {
    type: 'ATTEMPT_RESERVED',
    attemptId: 'a1',
    epochId: 1,
    at: 3000,
    generation: 0,
  });
  const stalePaste = reduce(reserved, { type: 'PASTE_ACCEPTED', attemptId: 'a1', generation: 9 });
  assert.equal(stalePaste.phase, 'PASTING');
  assert.equal(stalePaste.attempt.phase, 'reserved');
});

test('한 epoch에 두 번째 ATTEMPT_RESERVED는 무시', () => {
  const first = withAttempt('a1', 3000);
  const second = reduce(first, {
    type: 'ATTEMPT_RESERVED',
    attemptId: 'a2',
    epochId: 1,
    at: 3100,
    generation: 0,
  });
  assert.equal(second.attempt.id, 'a1');
  assert.equal(second.attempt.startedAt, 3000);
});

test('epochId 불일치 ATTEMPT_RESERVED는 무시', () => {
  const state = armed(2000);
  const result = reduce(state, {
    type: 'ATTEMPT_RESERVED',
    attemptId: 'a1',
    epochId: 99,
    at: 3000,
    generation: 0,
  });
  assert.equal(result.phase, 'ARMED');
  assert.equal(result.attempt, null);
});

// ---------------------------------------------------------------------------
// 정책/시계/만료
// ---------------------------------------------------------------------------

test('POLICY_INVALIDATED 후 다음 turn에서 재예약', () => {
  let state = armed(2000);
  state = reduce(state, { type: 'POLICY_INVALIDATED', reason: 'SCOPE_DISABLED' });
  assert.equal(state.phase, 'SUSPENDED');
  assert.equal(state.epoch, null);
  assert.equal(state.attempt, null);
  assert.equal(state.reason, 'SCOPE_DISABLED');
  assert.equal(state.generation, 1);
  assert.equal(state.seenWorking, true);

  state = reduce(state, hook('working', 3000));
  state = reduce(state, hook('done', 4000));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.id, 2);
});

test('CLOCK_GAP은 epoch를 폐기하고 EXPIRED', () => {
  let state = armed(2000);
  state = reduce(state, { type: 'CLOCK_GAP' });
  assert.equal(state.phase, 'EXPIRED');
  assert.equal(state.epoch, null);
  assert.equal(state.attempt, null);
  assert.equal(state.reason, 'EXPIRED');
  assert.equal(state.generation, 1);
});

test('EXPIRE는 일치하는 ARMED epoch만 닫는다', () => {
  let state = armed(2000);
  const mismatched = reduce(state, { type: 'EXPIRE', epochId: 99 });
  assert.equal(mismatched.phase, 'ARMED');
  state = reduce(state, { type: 'EXPIRE', epochId: 1 });
  assert.equal(state.phase, 'EXPIRED');
  assert.equal(state.epoch, null);
  assert.equal(state.reason, 'EXPIRED');
});

test('EXPIRED/SUSPENDED에서도 다음 fresh working→done은 ARMED', () => {
  let state = armed(2000);
  state = reduce(state, { type: 'EXPIRE', epochId: 1 });
  state = reduce(state, hook('working', 3000));
  state = reduce(state, hook('done', 4000));
  assert.equal(state.phase, 'ARMED');
  assert.equal(state.epoch.id, 2);
});

test('blocked/waiting은 SUSPENDED와 INTERACTIVE_WAIT, 전송 중이면 generation+1', () => {
  const armedState = armed(2000);
  const blocked = reduce(armedState, hook('blocked', 3000));
  assert.equal(blocked.phase, 'SUSPENDED');
  assert.equal(blocked.epoch, null);
  assert.equal(blocked.reason, 'INTERACTIVE_WAIT');

  const waiting = reduce(armedState, hook('waiting', 3000));
  assert.equal(waiting.phase, 'SUSPENDED');

  const pasting = withAttempt('a1', 3000);
  const generation = pasting.generation;
  const blockedDuringSend = reduce(pasting, hook('blocked', 4000));
  assert.equal(blockedDuringSend.generation, generation + 1);
  assert.equal(blockedDuringSend.phase, 'SUSPENDED');
});

// ---------------------------------------------------------------------------
// 전송 거절/불확실
// ---------------------------------------------------------------------------

test('SEND_REFUSED → SUSPENDED, epoch 폐기', () => {
  let state = withAttempt('a1', 3000);
  state = reduce(state, { type: 'SEND_REFUSED', attemptId: 'a1', reason: 'REFUSED' });
  assert.equal(state.phase, 'SUSPENDED');
  assert.equal(state.attempt, null);
  assert.equal(state.epoch, null);
  assert.equal(state.reason, 'REFUSED');
});

test('SEND_REFUSED는 attempt 불일치면 무시', () => {
  const state = withAttempt('a1', 3000);
  const result = reduce(state, { type: 'SEND_REFUSED', attemptId: 'zzz', reason: 'REFUSED' });
  assert.equal(result.phase, 'PASTING');
});

test('SEND_UNCERTAIN → NEEDS_REVIEW (attempt 불일치여도 phase 기준 적용)', () => {
  let state = withAttempt('a1', 3000);
  state = reduce(state, { type: 'SEND_UNCERTAIN', attemptId: 'a1' });
  assert.equal(state.phase, 'NEEDS_REVIEW');
  assert.equal(state.reason, 'PARTIAL_OR_UNKNOWN_SEND');
  assert.equal(state.epoch, null);

  const byPhase = reduce(withAttempt('a1', 3000), { type: 'SEND_UNCERTAIN', attemptId: 'zzz' });
  assert.equal(byPhase.phase, 'NEEDS_REVIEW');
});

// ---------------------------------------------------------------------------
// TARGET_CHANGED / 알 수 없는 입력 / 불변성
// ---------------------------------------------------------------------------

test('TARGET_CHANGED는 초기화하되 단조 카운터를 이어받는다', () => {
  let state = armed(2000);
  state = reduce(state, hook('working', 3000)); // BUSY, budgetResetSeq+1
  const budget = state.budgetResetSeq;
  const generation = state.generation;
  const newTarget = { ...TARGET, ptyId: 'pty2' };

  state = reduce(state, { type: 'TARGET_CHANGED', target: newTarget });
  assert.equal(state.target, newTarget);
  assert.equal(state.phase, 'UNKNOWN');
  assert.equal(state.epoch, null);
  assert.equal(state.lastHook, null);
  assert.equal(state.budgetResetSeq, budget);
  assert.equal(state.generation, generation + 1);
  assert.equal(state.epochSeq, 1);
});

test('알 수 없는 type과 잘못된 HOOK는 변경 없음(throw 없음)', () => {
  const state = armed(2000);
  assert.deepEqual(reduce(state, { type: 'NOPE', anything: 1 }), state);
  assert.deepEqual(reduce(state, hook('idle', 3000)), state);
  assert.deepEqual(reduce(state, hook('working', NaN)), state);
  assert.deepEqual(reduce(state, hook('working', 'x')), state);
});

test('reduceTarget은 입력 state를 변경하지 않는다', () => {
  const state = armed(2000);
  const snapshot = JSON.stringify(state);
  reduce(state, { type: 'ATTEMPT_RESERVED', attemptId: 'a1', epochId: 1, at: 3000, generation: 0 });
  reduce(state, hook('blocked', 3000));
  reduce(state, { type: 'POLICY_INVALIDATED', reason: 'X' });
  assert.equal(JSON.stringify(state), snapshot);
});

test('deepFreeze한 state로 reduce/decide해도 throw하지 않는다', () => {
  const frozen = deepFreeze(withAttempt('a1', 3000));
  const inputs = [
    hook('working', 4000),
    { type: 'POLICY_INVALIDATED', reason: 'X' },
    { type: 'TARGET_CHANGED', target: TARGET },
    { type: 'CLOCK_GAP' },
    { type: 'ATTEMPT_RESERVED', attemptId: 'a2', epochId: 1, at: 4000, generation: 0 },
    { type: 'PASTE_ACCEPTED', attemptId: 'a1', generation: 0 },
    { type: 'SUBMIT_ACCEPTED', attemptId: 'a1', at: 4000, generation: 0 },
    { type: 'SEND_REFUSED', attemptId: 'a1', reason: 'X' },
    { type: 'SEND_UNCERTAIN', attemptId: 'a1' },
    { type: 'REVIEW_CLEARED' },
    { type: 'TURN_CONFIRMED', at: 4000 },
    { type: 'TICK', now: 100000 },
    { type: 'EXPIRE', epochId: 1 },
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => reduce(frozen, input));
  }
  assert.doesNotThrow(() =>
    decide(frozen, { now: 100000, settings: settings(), policy: policy(), config: CONFIG }),
  );
});
