import test from 'node:test';
import assert from 'node:assert/strict';

import { REASON_CODES } from '../src/contracts.mjs';
import { projectCacheStatus } from '../src/cache-status.mjs';

const T0 = 1_700_000_000_000;
const TTL_5M = 300_000;
const EXPIRES = T0 + TTL_5M;
const DUE = EXPIRES - 15_000;

/** scheduler state 골격. */
function state(overrides = {}) {
  return {
    phase: 'UNKNOWN',
    reason: null,
    epoch: null,
    attempt: null,
    ...overrides,
  };
}

/** 표시 이력 골격. */
function history(overrides = {}) {
  return {
    epochId: 1,
    doneAt: T0 + 1000,
    basisAt: T0,
    expiresAt: EXPIRES,
    lastBlockReason: null,
    expiredAt: null,
    ...overrides,
  };
}

/** ARMED + 유효 epoch. */
function armedState(overrides = {}) {
  return state({
    phase: 'ARMED',
    reason: null,
    epoch: { id: 1, doneAt: T0 + 1000, basisAt: T0, attempted: false },
    ...overrides,
  });
}

// ── review 우선 ──────────────────────────────────────────────────────────────

test('needsReview(영속 budget)는 ARMED·이력보다 우선해 review/review', () => {
  const out = projectCacheStatus({
    state: armedState(),
    history: history(),
    now: T0 + 1000,
    needsReview: true,
    dueAt: DUE,
  });
  assert.equal(out.cacheState, 'review');
  assert.equal(out.cacheStatus, 'review');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, null);
  assert.equal(out.expireCause, null);
});

test('phase NEEDS_REVIEW는 review/review', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'NEEDS_REVIEW', reason: 'PARTIAL_OR_UNKNOWN_SEND' }),
    history: null,
    now: T0,
  });
  assert.equal(out.cacheState, 'review');
  assert.equal(out.cacheStatus, 'review');
});

// ── BUSY ─────────────────────────────────────────────────────────────────────

test('BUSY는 kept/working이며 만료 시각을 표시하지 않는다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'BUSY', reason: 'BUSY' }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'working');
  assert.equal(out.expiresAt, null);
  assert.equal(out.expiredAt, null);
  assert.equal(out.expireCause, null);
});

// ── ARMED / CHECKING ─────────────────────────────────────────────────────────

test('ARMED + 유효 epoch + 만료 전이면 kept/scheduled', () => {
  const out = projectCacheStatus({
    state: armedState(),
    history: history(),
    now: T0 + 1000,
    dueAt: DUE,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'scheduled');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, null);
  assert.equal(out.expireCause, null);
});

test('CHECKING도 ARMED처럼 kept/scheduled', () => {
  const out = projectCacheStatus({
    state: armedState({ phase: 'CHECKING' }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'scheduled');
});

test('ARMED + 이력 없음(TTL 미상)도 kept/scheduled이며 expiresAt은 null', () => {
  const out = projectCacheStatus({
    state: armedState(),
    history: null,
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'scheduled');
  assert.equal(out.expiresAt, null);
});

test('ARMED라도 epoch가 없으면 유지 중으로 보지 않는다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'ARMED', epoch: null }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.expiresAt, EXPIRES);
});

// ── 전송 중 / 응답 대기 ──────────────────────────────────────────────────────

test('PASTING/SUBMITTING + attempt + 만료 전이면 kept/sending', () => {
  for (const phase of ['PASTING', 'SUBMITTING']) {
    const out = projectCacheStatus({
      state: state({
        phase,
        epoch: { id: 1, doneAt: T0 + 1000, basisAt: T0, attempted: true },
        attempt: { id: 'att-1', epochId: 1, phase: 'reserved' },
      }),
      history: history(),
      now: T0 + 2000,
    });
    assert.equal(out.cacheState, 'kept');
    assert.equal(out.cacheStatus, 'sending');
    assert.equal(out.expiresAt, EXPIRES);
  }
});

test('AWAITING_TURN + attempt + 만료 전이면 kept/awaiting-turn', () => {
  const out = projectCacheStatus({
    state: state({
      phase: 'AWAITING_TURN',
      epoch: { id: 1, doneAt: T0 + 1000, basisAt: T0, attempted: true },
      attempt: { id: 'att-1', epochId: 1, phase: 'submitted', submittedAt: T0 + 2000 },
    }),
    history: history(),
    now: T0 + 3000,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'awaiting-turn');
});

test('attempt 없는 PASTING은 유지 중으로 보지 않는다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'PASTING', attempt: null }),
    history: history(),
    now: T0 + 2000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'no-reservation');
});

// ── 만료 ─────────────────────────────────────────────────────────────────────

test('이력 expiredAt이 확정되면 none/expired이며 원인을 전달한다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED', epoch: null }),
    history: history({ lastBlockReason: REASON_CODES.DRAFT_PRESENT, expiredAt: EXPIRES }),
    now: EXPIRES + 1000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'expired');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, EXPIRES);
  assert.equal(out.expireCause, REASON_CODES.DRAFT_PRESENT);
  assert.equal(out.blockedReason, REASON_CODES.DRAFT_PRESENT);
});

test('expiredAt이 없어도 알려진 expiresAt이 실제로 지났으면 expired', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED' }),
    history: history({ lastBlockReason: REASON_CODES.OUTPUT_ACTIVE }),
    now: EXPIRES,
  });
  assert.equal(out.cacheStatus, 'expired');
  assert.equal(out.expiredAt, EXPIRES);
  assert.equal(out.expireCause, REASON_CODES.OUTPUT_ACTIVE);
});

test('만료 전이면 blockedReason은 표시하되 expireCause는 없다', () => {
  const out = projectCacheStatus({
    state: armedState(),
    history: history({ lastBlockReason: REASON_CODES.INPUT_QUIET_WINDOW }),
    now: T0 + 1000,
  });
  assert.equal(out.cacheStatus, 'scheduled');
  assert.equal(out.blockedReason, REASON_CODES.INPUT_QUIET_WINDOW);
  assert.equal(out.expireCause, null);
});

test('허용 목록 밖 lastBlockReason은 null로 정규화한다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED' }),
    history: history({ lastBlockReason: 'NOT_A_REASON', expiredAt: EXPIRES }),
    now: EXPIRES + 1,
  });
  assert.equal(out.blockedReason, null);
  assert.equal(out.expireCause, null);
});

// ── 10초 cutoff 구간 ─────────────────────────────────────────────────────────

test('실제 만료 전 10초 cutoff(phase EXPIRED)는 no-reservation이고 expiresAt을 유지한다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED', epoch: null }),
    history: history(),
    now: EXPIRES - 5_000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, null);
});

// ── SUSPENDED ────────────────────────────────────────────────────────────────

test('SUSPENDED + INTERACTIVE_WAIT는 none/interactive-wait', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'SUSPENDED', reason: 'INTERACTIVE_WAIT' }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'interactive-wait');
  assert.equal(out.expiresAt, EXPIRES);
});

test('그 밖의 SUSPENDED는 none/suspended', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'SUSPENDED', reason: 'SCOPE_DISABLED' }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'suspended');
});

test('SUSPENDED + INTERACTIVE_WAIT + hold + 이력 미만료면 kept/interactive-wait', () => {
  const out = projectCacheStatus({
    state: state({
      phase: 'SUSPENDED',
      reason: 'INTERACTIVE_WAIT',
      hold: { id: 1, basisAt: T0, attempted: false },
    }),
    history: history(),
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'kept');
  assert.equal(out.cacheStatus, 'interactive-wait');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, null);
  assert.equal(out.expireCause, null);
});

test('SUSPENDED + INTERACTIVE_WAIT + hold여도 이력이 만료됐으면 none/expired', () => {
  const out = projectCacheStatus({
    state: state({
      phase: 'SUSPENDED',
      reason: 'INTERACTIVE_WAIT',
      hold: { id: 1, basisAt: T0, attempted: false },
    }),
    history: history({ lastBlockReason: REASON_CODES.INTERACTIVE_WAIT }),
    now: EXPIRES,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'expired');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.expiredAt, EXPIRES);
  assert.equal(out.expireCause, REASON_CODES.INTERACTIVE_WAIT);
});

test('SUSPENDED + INTERACTIVE_WAIT + hold 있어도 이력이 없으면 kept로 보지 않는다', () => {
  const out = projectCacheStatus({
    state: state({
      phase: 'SUSPENDED',
      reason: 'INTERACTIVE_WAIT',
      hold: { id: 1, basisAt: T0, attempted: false },
    }),
    history: null,
    now: T0 + 1000,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'interactive-wait');
});

test('needsReview는 hold/interactive-wait보다 우선해 review/review', () => {
  const out = projectCacheStatus({
    state: state({
      phase: 'SUSPENDED',
      reason: 'INTERACTIVE_WAIT',
      hold: { id: 1, basisAt: T0, attempted: false },
    }),
    history: history(),
    now: T0 + 1000,
    needsReview: true,
  });
  assert.equal(out.cacheState, 'review');
  assert.equal(out.cacheStatus, 'review');
});

test('SUSPENDED + INTERACTIVE_WAIT + 불완전 hold(id/basisAt 누락)는 kept로 보지 않는다', () => {
  for (const hold of [{}, { id: 1 }, { basisAt: T0 }]) {
    const out = projectCacheStatus({
      state: state({ phase: 'SUSPENDED', reason: 'INTERACTIVE_WAIT', hold }),
      history: history(),
      now: T0 + 1000,
    });
    assert.equal(out.cacheState, 'none');
    assert.equal(out.cacheStatus, 'interactive-wait');
    assert.equal(out.expiresAt, EXPIRES);
    assert.equal(out.expiredAt, null);
  }
});

// ── 초기 / 이력 없음 ─────────────────────────────────────────────────────────

test('초기 UNKNOWN + 이력 없음은 none/no-reservation, 시각은 null', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'UNKNOWN', reason: 'NO_FRESH_TURN' }),
    history: null,
    now: T0,
  });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.expiresAt, null);
  assert.equal(out.expiredAt, null);
  assert.equal(out.expireCause, null);
  assert.equal(out.blockedReason, null);
});

test('불량 입력(state/history/now)에도 throw하지 않는다', () => {
  const out = projectCacheStatus({ state: null, history: 'nope', now: Number.NaN });
  assert.equal(out.cacheState, 'none');
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.deepEqual(
    { expiresAt: out.expiresAt, expiredAt: out.expiredAt, expireCause: out.expireCause, blockedReason: out.blockedReason },
    { expiresAt: null, expiredAt: null, expireCause: null, blockedReason: null },
  );
});

// ── 순수성 ───────────────────────────────────────────────────────────────────

test('입력 state/history를 변경하지 않는다', () => {
  const st = armedState();
  const hist = history({ lastBlockReason: REASON_CODES.DRAFT_PRESENT });
  const stSnapshot = JSON.parse(JSON.stringify(st));
  const histSnapshot = JSON.parse(JSON.stringify(hist));
  projectCacheStatus({ state: st, history: hist, now: EXPIRES + 1, needsReview: false });
  assert.deepEqual(st, stSnapshot);
  assert.deepEqual(hist, histSnapshot);
});

// ── reservationNote (검토 지적 1+2) ──────────────────────────────────────────

test('reservationNote: 관측 전 초기 상태(observed=false)는 initial', () => {
  const out = projectCacheStatus({ state: state(), history: null, now: T0, observed: false });
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.reservationNote, 'initial');
});

test('reservationNote: 검토 해제·TARGET_CHANGED 뒤(observed=true)는 null', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'UNKNOWN', reason: 'NO_FRESH_TURN' }),
    history: null,
    now: T0,
    observed: true,
  });
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.reservationNote, null);
});

test('reservationNote: observed 신호가 없으면 initial을 만들지 않는다', () => {
  const out = projectCacheStatus({ state: state(), history: null, now: T0 });
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.reservationNote, null);
});

test('reservationNote: 10초 조기 EXPIRE(cutoff) 구간은 safety-cutoff', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED' }),
    history: history(),
    now: EXPIRES - 5_000,
    expiredBy: 'cutoff',
    observed: true,
  });
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.expiresAt, EXPIRES);
  assert.equal(out.reservationNote, 'safety-cutoff');
});

test('reservationNote: CLOCK_GAP으로 생긴 EXPIRED는 safety-cutoff가 아니다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED' }),
    history: history(),
    now: EXPIRES - 5_000,
    expiredBy: 'clock-gap',
    observed: true,
  });
  assert.equal(out.cacheStatus, 'no-reservation');
  assert.equal(out.reservationNote, null);
});

test('reservationNote: cutoff여도 실제 만료가 지났으면 null', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED' }),
    history: history({ expiredAt: EXPIRES }),
    now: EXPIRES + 1,
    expiredBy: 'cutoff',
    observed: true,
  });
  assert.equal(out.cacheStatus, 'expired');
  assert.equal(out.reservationNote, null);
});

test('reservationNote: cutoff여도 이력이 없으면 safety-cutoff가 아니다', () => {
  const out = projectCacheStatus({
    state: state({ phase: 'EXPIRED', reason: 'EXPIRED' }),
    history: null,
    now: EXPIRES - 5_000,
    expiredBy: 'cutoff',
    observed: true,
  });
  assert.equal(out.reservationNote, null);
});
