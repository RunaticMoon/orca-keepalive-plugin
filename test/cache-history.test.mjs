import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_HISTORY_RETENTION_MS,
  REASON_CODES,
} from '../src/contracts.mjs';
import {
  isCacheHistoryExpired,
  normalizeBlockReason,
  reduceCacheHistory,
} from '../src/cache-history.mjs';

const T0 = 1_700_000_000_000;
const TTL_1H = 3_600_000;
const EXPIRES = T0 + TTL_1H;

/** 유한수까지 모두 채운 OPEN 이벤트. */
function openEvent(overrides = {}) {
  return {
    type: 'OPEN',
    epochId: 1,
    doneAt: T0,
    basisAt: T0,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

/** freeze한 OPEN 이력을 만든다. */
function openHistory(overrides = {}) {
  return Object.freeze(reduceCacheHistory(null, openEvent(overrides)));
}

// ── OPEN ────────────────────────────────────────────────────────────────────

test('OPEN은 이전 이력을 교체하고 원인·만료를 초기화한다', () => {
  const prev = Object.freeze({
    epochId: 1,
    doneAt: T0,
    basisAt: T0,
    expiresAt: EXPIRES,
    lastBlockReason: REASON_CODES.DRAFT_PRESENT,
    expiredAt: EXPIRES,
  });
  const next = reduceCacheHistory(prev, openEvent({ epochId: 2, expiresAt: EXPIRES + 1000 }));
  assert.notEqual(next, prev);
  assert.deepEqual(next, {
    epochId: 2,
    doneAt: T0,
    basisAt: T0,
    expiresAt: EXPIRES + 1000,
    lastBlockReason: null,
    expiredAt: null,
  });
  assert.equal(prev.lastBlockReason, REASON_CODES.DRAFT_PRESENT);
});

test('OPEN은 비유한수 값이면 기존 이력을 그대로 돌려준다', () => {
  const history = openHistory();
  for (const bad of [
    openEvent({ epochId: Number.NaN }),
    openEvent({ doneAt: Infinity }),
    openEvent({ basisAt: Number.NaN }),
    openEvent({ expiresAt: Number.NEGATIVE_INFINITY }),
    openEvent({ expiresAt: 'x' }),
  ]) {
    assert.equal(reduceCacheHistory(history, bad), history);
  }
});

// ── BLOCK ───────────────────────────────────────────────────────────────────

test('BLOCK 같은 reason 반복은 같은 참조, 다른 reason은 교체한다', () => {
  const history = openHistory();
  const block = { type: 'BLOCK', epochId: 1, reason: REASON_CODES.DRAFT_PRESENT, at: T0 + 10 };

  const once = reduceCacheHistory(history, block);
  assert.notEqual(once, history);
  assert.equal(once.lastBlockReason, REASON_CODES.DRAFT_PRESENT);

  const repeat = reduceCacheHistory(once, block);
  assert.equal(repeat, once, '같은 reason 반복은 저장 변경이 없어야 한다');

  const other = reduceCacheHistory(once, { ...block, reason: REASON_CODES.INPUT_QUIET_WINDOW });
  assert.notEqual(other, once);
  assert.equal(other.lastBlockReason, REASON_CODES.INPUT_QUIET_WINDOW);
});

test('BLOCK 다른 epochId는 무시한다', () => {
  const history = openHistory();
  const next = reduceCacheHistory(history, {
    type: 'BLOCK',
    epochId: 99,
    reason: REASON_CODES.DRAFT_PRESENT,
    at: T0 + 10,
  });
  assert.equal(next, history);
});

test('BLOCK 허용 밖 reason(EXPIRED/NO_FRESH_TURN/임의 문자열)은 무시한다', () => {
  const history = openHistory();
  for (const reason of [REASON_CODES.EXPIRED, REASON_CODES.NO_FRESH_TURN, 'NOT_A_REASON', null]) {
    const next = reduceCacheHistory(history, {
      type: 'BLOCK',
      epochId: 1,
      reason,
      at: T0 + 10,
    });
    assert.equal(next, history, `${String(reason)} 은(는) 기록하지 않아야 한다`);
  }
});

test('BLOCK 만료 시각 이후(at >= expiresAt)는 무시한다', () => {
  const history = openHistory();
  assert.equal(
    reduceCacheHistory(history, {
      type: 'BLOCK',
      epochId: 1,
      reason: REASON_CODES.DRAFT_PRESENT,
      at: EXPIRES,
    }),
    history,
  );
});

test('BLOCK 만료 확정 후에는 무시한다', () => {
  const expired = reduceCacheHistory(openHistory(), { type: 'ADVANCE', now: EXPIRES });
  assert.equal(expired.expiredAt, EXPIRES);
  assert.equal(
    reduceCacheHistory(expired, {
      type: 'BLOCK',
      epochId: 1,
      reason: REASON_CODES.DRAFT_PRESENT,
      at: EXPIRES - 1,
    }),
    expired,
  );
});

// ── RETIME ──────────────────────────────────────────────────────────────────

test('RETIME 같은 epoch는 만료 전 갱신하고 만료 후 연장하지 않는다', () => {
  const history = openHistory();
  const retimed = reduceCacheHistory(history, {
    type: 'RETIME',
    epochId: 1,
    expiresAt: EXPIRES + 60_000,
  });
  assert.notEqual(retimed, history);
  assert.equal(retimed.expiresAt, EXPIRES + 60_000);

  const expired = reduceCacheHistory(history, { type: 'ADVANCE', now: EXPIRES });
  assert.equal(
    reduceCacheHistory(expired, { type: 'RETIME', epochId: 1, expiresAt: EXPIRES + 60_000 }),
    expired,
    '만료된 이력은 연장하지 않아야 한다',
  );
});

test('RETIME 다른 epochId와 비유한수는 무시한다', () => {
  const history = openHistory();
  assert.equal(
    reduceCacheHistory(history, { type: 'RETIME', epochId: 2, expiresAt: EXPIRES + 5 }),
    history,
  );
  assert.equal(
    reduceCacheHistory(history, { type: 'RETIME', epochId: 1, expiresAt: Number.NaN }),
    history,
  );
});

// ── ADVANCE ─────────────────────────────────────────────────────────────────

test('ADVANCE 만료 경계: 직전 무변화, 정각 확정, 24시간 정각 삭제', () => {
  const history = openHistory();

  const before = reduceCacheHistory(history, { type: 'ADVANCE', now: EXPIRES - 1 });
  assert.equal(before, history, '만료 직전에는 변화가 없어야 한다');
  assert.equal(before.expiredAt, null);

  const onTime = reduceCacheHistory(history, { type: 'ADVANCE', now: EXPIRES });
  assert.notEqual(onTime, history);
  assert.equal(onTime.expiredAt, EXPIRES, 'expiredAt은 tick 시각이 아니라 expiresAt');
  assert.equal(onTime.expiresAt, EXPIRES);

  const justBeforeRetention = reduceCacheHistory(onTime, {
    type: 'ADVANCE',
    now: EXPIRES + CACHE_HISTORY_RETENTION_MS - 1,
  });
  assert.equal(justBeforeRetention, onTime, '보존 직전에는 유지');

  const atRetention = reduceCacheHistory(onTime, {
    type: 'ADVANCE',
    now: EXPIRES + CACHE_HISTORY_RETENTION_MS,
  });
  assert.equal(atRetention, null, '24시간 정각에는 정리');
});

test('ADVANCE는 null 이력과 비유한수 now를 그대로 돌려준다', () => {
  assert.equal(reduceCacheHistory(null, { type: 'ADVANCE', now: EXPIRES }), null);
  const history = openHistory();
  assert.equal(reduceCacheHistory(history, { type: 'ADVANCE', now: Number.NaN }), history);
});

// ── RESTORE / CLEAR ─────────────────────────────────────────────────────────

test('RESTORE는 정상 레코드를 epochId=null 이력으로 복원한다', () => {
  const restored = reduceCacheHistory(null, {
    type: 'RESTORE',
    record: {
      doneAt: T0,
      basisAt: T0 + 1000,
      expiresAt: EXPIRES,
      lastBlockReason: REASON_CODES.OUTPUT_ACTIVE,
      expiredAt: null,
    },
  });
  assert.deepEqual(restored, {
    epochId: null,
    doneAt: T0,
    basisAt: T0 + 1000,
    expiresAt: EXPIRES,
    lastBlockReason: REASON_CODES.OUTPUT_ACTIVE,
    expiredAt: null,
  });
});

test('RESTORE는 basisAt 누락 시 doneAt을 쓰고 reason은 정규화한다', () => {
  const restored = reduceCacheHistory(null, {
    type: 'RESTORE',
    record: {
      doneAt: T0,
      basisAt: null,
      expiresAt: EXPIRES,
      lastBlockReason: 'NOT_ALLOWED',
      expiredAt: null,
    },
  });
  assert.equal(restored.basisAt, T0);
  assert.equal(restored.lastBlockReason, null);

  const expired = reduceCacheHistory(null, {
    type: 'RESTORE',
    record: {
      doneAt: T0,
      basisAt: T0,
      expiresAt: EXPIRES,
      lastBlockReason: REASON_CODES.BUSY,
      expiredAt: EXPIRES,
    },
  });
  assert.equal(expired.expiredAt, EXPIRES);
  assert.equal(isCacheHistoryExpired(expired), true);
});

test('RESTORE는 불량 레코드(expiredAt≠expiresAt, 비유한수)를 거부한다', () => {
  const base = {
    doneAt: T0,
    basisAt: T0,
    expiresAt: EXPIRES,
    lastBlockReason: null,
    expiredAt: null,
  };
  assert.equal(
    reduceCacheHistory(null, { type: 'RESTORE', record: { ...base, expiredAt: EXPIRES - 1 } }),
    null,
  );
  assert.equal(
    reduceCacheHistory(null, { type: 'RESTORE', record: { ...base, doneAt: Number.NaN } }),
    null,
  );
  assert.equal(
    reduceCacheHistory(null, { type: 'RESTORE', record: { ...base, expiresAt: Infinity } }),
    null,
  );
  assert.equal(reduceCacheHistory(null, { type: 'RESTORE', record: null }), null);
});

test('CLEAR는 null을 돌려준다', () => {
  assert.equal(reduceCacheHistory(openHistory(), { type: 'CLEAR' }), null);
  assert.equal(reduceCacheHistory(null, { type: 'CLEAR' }), null);
});

test('알 수 없는 event는 기존 이력을 그대로 돌려준다', () => {
  const history = openHistory();
  assert.equal(reduceCacheHistory(history, { type: 'NOPE' }), history);
  assert.equal(reduceCacheHistory(history, null), history);
});

// ── 입력 불변성·헬퍼 ────────────────────────────────────────────────────────

test('freeze한 입력 이력은 어떤 이벤트에도 변경되지 않는다', () => {
  const history = openHistory();
  const snapshot = { ...history };
  reduceCacheHistory(history, { type: 'BLOCK', epochId: 1, reason: REASON_CODES.BUSY, at: T0 + 1 });
  reduceCacheHistory(history, { type: 'RETIME', epochId: 1, expiresAt: EXPIRES + 1 });
  reduceCacheHistory(history, { type: 'ADVANCE', now: EXPIRES });
  reduceCacheHistory(history, { type: 'CLEAR' });
  assert.deepEqual(history, snapshot);
});

test('normalizeBlockReason와 isCacheHistoryExpired', () => {
  assert.equal(normalizeBlockReason(REASON_CODES.DRAFT_PRESENT), REASON_CODES.DRAFT_PRESENT);
  assert.equal(normalizeBlockReason('x'), null);
  assert.equal(normalizeBlockReason(null), null);
  assert.equal(isCacheHistoryExpired(null), false);
  assert.equal(isCacheHistoryExpired(openHistory()), false);
  assert.equal(
    isCacheHistoryExpired(reduceCacheHistory(openHistory(), { type: 'ADVANCE', now: EXPIRES })),
    true,
  );
});
