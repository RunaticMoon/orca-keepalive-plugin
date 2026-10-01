import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEpochMemory,
  EPOCH_MEMORY_KEY,
  EPOCH_MEMORY_MAX_ENTRIES,
  EPOCH_MEMORY_MAX_BYTES,
} from '../src/epoch-memory.mjs';
import { CACHE_HISTORY_RETENTION_MS, REASON_CODES } from '../src/contracts.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USER = 'u'.repeat(64);
const RETENTION = CACHE_HISTORY_RETENTION_MS;

/**
 * 유효한 v2 EpochRecord(saveAt 제외). remember 입력으로 쓴다.
 * basisAt은 doneAt 이하, expiresAt은 doneAt보다 크게 doneAt 기준으로 파생한다.
 * @param {object} [over]
 */
const rec = (over = {}) => {
  const doneAt = typeof over.doneAt === 'number' ? over.doneAt : 1000;
  return {
    kind: 'armed',
    worktreeId: 'w1',
    paneKey: 't1:l1',
    userDataKey: USER,
    profileId: 'p1',
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    doneAt,
    basisAt: doneAt - 100,
    expiresAt: doneAt + 300000,
    lastBlockReason: null,
    expiredAt: null,
    ...over,
  };
};

/** v1(구버전) 저장 레코드. kind·expiresAt 등이 없다. */
const v1rec = (over = {}) => ({
  worktreeId: 'w1',
  paneKey: 't1:l1',
  userDataKey: USER,
  profileId: 'p1',
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  doneAt: 1000,
  ...over,
});

/** v1 레코드를 로드했을 때 기대하는 v2 형태(기본값). */
const v2fromV1 = (over = {}) => ({
  kind: 'armed',
  worktreeId: 'w1',
  paneKey: 't1:l1',
  userDataKey: USER,
  profileId: 'p1',
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  doneAt: 1000,
  basisAt: 1000,
  expiresAt: null,
  lastBlockReason: null,
  expiredAt: null,
  ...over,
});

/**
 * 메모리 Map 기반 fake host storage. get/set 실패·get 지연을 주입할 수 있다.
 * @param {{initial?: unknown}} [options]
 */
function createFakeHost({ initial } = {}) {
  const storage = new Map();
  if (initial !== undefined) {
    storage.set(EPOCH_MEMORY_KEY, structuredClone(initial));
  }
  let failGet = false;
  let failSet = false;
  let getDelayMs = 0;
  const calls = [];

  async function hostCall(method, params) {
    calls.push({ method, params });
    if (method === 'storage.get') {
      if (getDelayMs > 0) {
        await delay(getDelayMs);
      }
      if (failGet) {
        throw new Error('injected get failure');
      }
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined };
    }
    if (method === 'storage.set') {
      if (failSet) {
        throw new Error('injected set failure');
      }
      storage.set(params.key, structuredClone(params.value));
      return { ok: true };
    }
    throw new Error(`unknown method ${method}`);
  }

  return {
    hostCall,
    calls,
    read(key = EPOCH_MEMORY_KEY) {
      return storage.has(key) ? structuredClone(storage.get(key)) : undefined;
    },
    has(key = EPOCH_MEMORY_KEY) {
      return storage.has(key);
    },
    setCount() {
      return calls.filter((call) => call.method === 'storage.set').length;
    },
    setFail(value) {
      failSet = value;
    },
    setGetFail(value) {
      failGet = value;
    },
    setGetDelay(ms) {
      getDelayMs = ms;
    },
  };
}

// ---------------------------------------------------------------------------
// load / 기본값
// ---------------------------------------------------------------------------

test('load: 저장값이 없으면 빈 상태', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.equal(memory.get('missing'), null);
  assert.equal(host.has(), false);
});

test('load: 저장값이 문자열이면 JSON.parse 허용', async () => {
  const host = createFakeHost({
    initial: JSON.stringify({ version: 2, entries: { k1: { ...rec(), savedAt: 7 } } }),
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('k1'), { ...rec(), savedAt: 7 });
});

test('load: v2 형식이 잘못된 항목은 버리고 유효한 항목만 적재', async () => {
  const host = createFakeHost({
    initial: {
      version: 2,
      entries: {
        good: { ...rec(), savedAt: 7 },
        nullIncarnation: { ...rec({ incarnationId: null }), savedAt: 7 },
        emptyString: { ...rec({ ptyId: '' }), savedAt: 7 },
        emptyIncarnation: { ...rec({ incarnationId: '' }), savedAt: 7 },
        badDoneAt: { ...rec({ doneAt: 'nope' }), savedAt: 7 },
        unknownKind: { ...rec({ kind: 'bogus' }), savedAt: 7 },
        missingFields: { worktreeId: 'w1' },
        notObject: 42,
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('good'), { ...rec(), savedAt: 7 });
  assert.deepEqual(memory.get('nullIncarnation'), {
    ...rec({ incarnationId: null }),
    savedAt: 7,
  });
  assert.equal(memory.get('emptyString'), null);
  assert.equal(memory.get('emptyIncarnation'), null);
  assert.equal(memory.get('badDoneAt'), null);
  assert.equal(memory.get('unknownKind'), null);
  assert.equal(memory.get('missingFields'), null);
  assert.equal(memory.get('notObject'), null);
});

test('load: 미지원 version이면 빈 상태', async () => {
  const host = createFakeHost({ initial: { version: 3, entries: { k: { ...rec(), savedAt: 7 } } } });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.equal(memory.get('k'), null);
});

test('load: storage.get 실패 시 빈 상태(throw 금지)', async () => {
  const host = createFakeHost({ initial: { version: 2, entries: { k: { ...rec(), savedAt: 7 } } } });
  host.setGetFail(true);
  const memory = createEpochMemory({ hostCall: host.hostCall });

  await memory.load();
  assert.equal(memory.get('k'), null);
});

// ---------------------------------------------------------------------------
// v1 호환
// ---------------------------------------------------------------------------

test('v1: basisAt이 있으면 그대로, 없으면 doneAt을 basisAt으로 로드하고 expiresAt은 추정하지 않는다', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
      entries: {
        withBasis: { ...v1rec({ doneAt: 1000, basisAt: 500 }), savedAt: 7 },
        without: { ...v1rec({ doneAt: 6000 }), savedAt: 7 },
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('withBasis'), { ...v2fromV1({ basisAt: 500 }), savedAt: 7 });
  assert.deepEqual(memory.get('without'), {
    ...v2fromV1({ doneAt: 6000, basisAt: 6000 }),
    savedAt: 7,
  });
  assert.equal(memory.get('withBasis').expiresAt, null);
  assert.equal(memory.get('without').lastBlockReason, null);
  assert.equal(memory.get('without').expiredAt, null);
});

test('v1: 잘못된 basisAt(초과·비수치·null)은 doneAt으로 대체한다', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
      entries: {
        future: { ...v1rec({ doneAt: 1000, basisAt: 2000 }), savedAt: 7 },
        nonNumeric: { ...v1rec({ doneAt: 1000, basisAt: 'x' }), savedAt: 7 },
        nullish: { ...v1rec({ doneAt: 1000, basisAt: null }), savedAt: 7 },
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  for (const key of ['future', 'nonNumeric', 'nullish']) {
    const record = memory.get(key);
    assert.notEqual(record, null, key);
    assert.equal(record.kind, 'armed', key);
    assert.equal(record.basisAt, 1000, key);
    assert.equal(record.doneAt, 1000, key);
    assert.equal(record.expiresAt, null, key);
  }
});

test('v1: 비유한수 doneAt은 버린다', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
      entries: {
        nan: { ...v1rec({ doneAt: Number.NaN }), savedAt: 7 },
        inf: { ...v1rec({ doneAt: Number.POSITIVE_INFINITY }), savedAt: 7 },
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.equal(memory.get('nan'), null);
  assert.equal(memory.get('inf'), null);
});

// ---------------------------------------------------------------------------
// hold (대기 중 재시작 복원용)
// ---------------------------------------------------------------------------

test('hold: remember→get 왕복, 저장 envelope version 2·kind hold', async () => {
  const host = createFakeHost();
  const hold = rec({ kind: 'hold' });
  const first = createEpochMemory({ hostCall: host.hostCall, now: () => 111 });
  first.remember('hold', hold);
  await first.flush();

  const stored = host.read();
  assert.equal(stored.version, 2);
  assert.equal(stored.entries.hold.kind, 'hold');
  assert.deepEqual(stored.entries.hold, { ...hold, savedAt: 111 });

  const second = createEpochMemory({ hostCall: host.hostCall, now: () => 999 });
  await second.load();
  assert.deepEqual(second.get('hold'), { ...hold, savedAt: 111 });
  assert.equal(second.get('hold').kind, 'hold');
});

test('hold: expiresAt이 null이면 거부, expiredAt 값이 있으면 거부', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('noExpires', rec({ kind: 'hold', expiresAt: null }));
  memory.remember('expired', rec({ kind: 'hold', expiresAt: 300000, expiredAt: 300000 }));
  await memory.flush();

  assert.equal(memory.get('noExpires'), null);
  assert.equal(memory.get('expired'), null);
  assert.equal(host.setCount(), 0);
});

test('load: v2 envelope의 hold를 적재하고, v1 레코드는 armed로 읽는다', async () => {
  const hold = rec({ kind: 'hold', doneAt: 50000, basisAt: 49000, expiresAt: 100000 });
  const host = createFakeHost({
    initial: { version: 2, entries: { hold: { ...hold, savedAt: 7 } } },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('hold'), { ...hold, savedAt: 7 });
  assert.equal(memory.get('hold').kind, 'hold');

  const v1host = createFakeHost({
    initial: { version: 1, entries: { armed: { ...v1rec(), savedAt: 7 } } },
  });
  const v1memory = createEpochMemory({ hostCall: v1host.hostCall });
  await v1memory.load();
  assert.equal(v1memory.get('armed').kind, 'armed');
});

test('prune: 만료된 hold는 history + expiredAt=expiresAt으로 전환', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 5000 });
  memory.remember('expired', rec({ kind: 'hold', doneAt: 1000, basisAt: 1000, expiresAt: 2000 }));
  await memory.flush();

  memory.prune(3600000);
  await memory.flush();

  const record = memory.get('expired');
  assert.notEqual(record, null);
  assert.equal(record.kind, 'history');
  assert.equal(record.expiredAt, 2000);
  assert.equal(record.expiresAt, 2000);
  assert.equal(host.read().entries.expired.kind, 'history');
  assert.equal(host.read().entries.expired.expiredAt, 2000);
});

test('prune: 만료 24시간을 넘긴 hold는 제거', async () => {
  const now = 2000 + RETENTION;
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => now });
  memory.remember('ancient', rec({ kind: 'hold', doneAt: 1000, basisAt: 1000, expiresAt: 2000 }));
  await memory.flush();

  memory.prune(3600000);
  await memory.flush();

  assert.equal(memory.get('ancient'), null);
});

test('prune: maxAge를 넘긴 미만료 hold는 제거하고 유효한 hold는 유지', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 10000 });
  memory.remember('old', rec({ kind: 'hold', doneAt: 8000, basisAt: 8000, expiresAt: 500000 }));
  memory.remember('fresh', rec({ kind: 'hold', doneAt: 9900, basisAt: 9900, expiresAt: 500000 }));
  await memory.flush();

  memory.prune(500);
  await memory.flush();

  assert.equal(memory.get('old'), null);
  assert.notEqual(memory.get('fresh'), null);
  assert.equal(memory.get('fresh').kind, 'hold');
});

// ---------------------------------------------------------------------------
// round-trip
// ---------------------------------------------------------------------------

test('round-trip: v2 armed/history(pending)/history(expired) 저장·복원, envelope version 2', async () => {
  const host = createFakeHost();
  const armed = rec({ doneAt: 42 });
  const pending = rec({ doneAt: 43, kind: 'history', expiresAt: 500000 });
  const expired = rec({ doneAt: 44, kind: 'history', expiresAt: 900000, expiredAt: 900000 });

  const first = createEpochMemory({ hostCall: host.hostCall, now: () => 111 });
  first.remember('armed', armed);
  first.remember('pending', pending);
  first.remember('expired', expired);
  await first.flush();

  const stored = host.read();
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.entries.armed, { ...armed, savedAt: 111 });
  assert.deepEqual(stored.entries.pending, { ...pending, savedAt: 111 });
  assert.deepEqual(stored.entries.expired, { ...expired, savedAt: 111 });

  const second = createEpochMemory({ hostCall: host.hostCall, now: () => 999 });
  await second.load();
  assert.deepEqual(second.get('armed'), { ...armed, savedAt: 111 });
  assert.deepEqual(second.get('pending'), { ...pending, savedAt: 111 });
  assert.deepEqual(second.get('expired'), { ...expired, savedAt: 111 });
});

test('round-trip: incarnationId null도 저장·복원', async () => {
  const host = createFakeHost();
  const first = createEpochMemory({ hostCall: host.hostCall, now: () => 111 });
  first.remember('k1', rec({ incarnationId: null }));
  await first.flush();

  assert.equal(host.read().entries.k1.incarnationId, null);

  const second = createEpochMemory({ hostCall: host.hostCall });
  await second.load();
  assert.deepEqual(second.get('k1'), { ...rec({ incarnationId: null }), savedAt: 111 });
});

test('remember: kind를 생략하면 armed로 저장한다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  const { kind, ...withoutKind } = rec();
  memory.remember('k1', withoutKind);
  await memory.flush();

  assert.equal(memory.get('k1').kind, 'armed');
  assert.equal(host.read().entries.k1.kind, 'armed');
});

test('remember: 허용 밖 필드(초안·화면·오류 메시지 등)는 저장하지 않는다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  memory.remember('k1', { ...rec(), draft: 'secret draft', screen: 'screen text', message: 'oops' });
  await memory.flush();

  const stored = host.read().entries.k1;
  assert.deepEqual(stored, { ...rec(), savedAt: 1000 });
  assert.equal('draft' in stored, false);
  assert.equal('screen' in stored, false);
  assert.equal('message' in stored, false);
});

// ---------------------------------------------------------------------------
// 검증: 잘못된 레코드 거부 / reason 정규화
// ---------------------------------------------------------------------------

test('remember: 잘못된 레코드는 저장하지 않는다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('unknownKind', rec({ kind: 'bogus' }));
  memory.remember('expiredArmed', rec({ kind: 'armed', expiresAt: 300000, expiredAt: 300000 }));
  memory.remember('mismatch', rec({ kind: 'history', expiresAt: 900000, expiredAt: 800000 }));
  memory.remember('historyNoExpires', rec({ kind: 'history', expiresAt: null }));
  memory.remember('badDoneAt', rec({ doneAt: Number.NaN }));
  memory.remember('infBasis', rec({ basisAt: Number.POSITIVE_INFINITY }));
  memory.remember('nanExpires', rec({ expiresAt: Number.NaN }));
  memory.remember('basisAfterDone', rec({ basisAt: 999999 }));
  memory.remember('expiresBeforeDone', rec({ expiresAt: 1000 }));
  memory.remember('emptyPty', rec({ ptyId: '' }));
  memory.remember('', rec());
  memory.remember('notObject', 42);
  await memory.flush();

  for (const key of [
    'unknownKind',
    'expiredArmed',
    'mismatch',
    'historyNoExpires',
    'badDoneAt',
    'infBasis',
    'nanExpires',
    'basisAfterDone',
    'expiresBeforeDone',
    'emptyPty',
    '',
    'notObject',
  ]) {
    assert.equal(memory.get(key), null, key);
  }
  assert.equal(host.setCount(), 0);
});

test('remember: lastBlockReason은 허용 reason만, 그 밖은 null로 정규화', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('known', rec({ lastBlockReason: REASON_CODES.DRAFT_PRESENT }));
  memory.remember('unknown', rec({ lastBlockReason: 'NOT_A_REAL_REASON' }));
  memory.remember('sentence', rec({ lastBlockReason: '입력창 초안이 감지되어 전송하지 못함' }));
  memory.remember('missing', { ...rec(), lastBlockReason: undefined });
  memory.remember('expiredCause', rec({
    kind: 'history',
    expiresAt: 300000,
    expiredAt: 300000,
    lastBlockReason: REASON_CODES.OUTPUT_ACTIVE,
  }));
  await memory.flush();

  assert.equal(memory.get('known').lastBlockReason, REASON_CODES.DRAFT_PRESENT);
  assert.equal(memory.get('unknown').lastBlockReason, null);
  assert.equal(memory.get('sentence').lastBlockReason, null);
  assert.equal(memory.get('missing').lastBlockReason, null);
  assert.equal(memory.get('expiredCause').lastBlockReason, REASON_CODES.OUTPUT_ACTIVE);
});

test('remember: incarnationId는 비어있지 않은 string 또는 null만 허용', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('empty', rec({ incarnationId: '' }));
  memory.remember('undef', { ...rec(), incarnationId: undefined });
  memory.remember('number', { ...rec(), incarnationId: 42 });
  memory.remember('nullOk', rec({ incarnationId: null }));
  await memory.flush();

  assert.equal(memory.get('empty'), null);
  assert.equal(memory.get('undef'), null);
  assert.equal(memory.get('number'), null);
  assert.equal(memory.get('nullOk').incarnationId, null);
});

// ---------------------------------------------------------------------------
// remember: 같은 내용 / 변경
// ---------------------------------------------------------------------------

test('remember: 같은 내용이면 추가 persist 없음', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec());
  await memory.flush();
  const before = host.setCount();
  assert.equal(before, 1);

  memory.remember('k1', rec());
  await memory.flush();
  assert.equal(host.setCount(), before);
  assert.notEqual(memory.get('k1'), null);
});

test('remember: 동일 내용에서 incarnationId null도 정확히 비교', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec({ incarnationId: null }));
  await memory.flush();
  const before = host.setCount();

  memory.remember('k1', rec({ incarnationId: null }));
  await memory.flush();
  assert.equal(host.setCount(), before);

  memory.remember('k1', rec({ incarnationId: 'inc-1' }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1);
});

test('remember: ptyId가 바뀌면 다시 persist', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec());
  await memory.flush();
  const before = host.setCount();

  memory.remember('k1', rec({ ptyId: 'pty-2' }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1);
  assert.equal(host.read().entries.k1.ptyId, 'pty-2');
});

test('remember: 새 필드(kind·expiresAt·reason·expiredAt·basisAt)가 바뀌면 다시 persist', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec({ doneAt: 5000, basisAt: 4000 }));
  await memory.flush();
  let before = host.setCount();

  memory.remember('k1', rec({ doneAt: 5000, basisAt: 3000 }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1, 'basisAt 변경');

  before = host.setCount();
  memory.remember('k1', rec({ doneAt: 5000, basisAt: 3000, lastBlockReason: REASON_CODES.DRAFT_PRESENT }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1, 'lastBlockReason 변경');

  before = host.setCount();
  memory.remember('k1', rec({
    doneAt: 5000,
    basisAt: 3000,
    lastBlockReason: REASON_CODES.DRAFT_PRESENT,
    kind: 'history',
    expiresAt: 300000,
    expiredAt: 300000,
  }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1, 'kind/expiredAt 변경');
});

test('get: 반환값을 바꿔도 내부에 영향 없음', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  memory.remember('k1', rec());
  await memory.flush();

  const view = memory.get('k1');
  view.doneAt = 0;
  view.ptyId = 'hacked';
  view.kind = 'history';

  const again = memory.get('k1');
  assert.equal(again.doneAt, 1000);
  assert.equal(again.ptyId, 'pty-1');
  assert.equal(again.kind, 'armed');
});

// ---------------------------------------------------------------------------
// forget / prune
// ---------------------------------------------------------------------------

test('forget: 있는 항목은 삭제하고 persist 예약', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  memory.remember('k1', rec());
  await memory.flush();

  memory.forget('k1');
  await memory.flush();

  assert.equal(memory.get('k1'), null);
  assert.equal(host.read().entries.k1, undefined);
});

test('forget: 없는 항목은 no-op(추가 persist 없음)', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  memory.remember('k1', rec());
  await memory.flush();
  const before = host.setCount();

  memory.forget('missing');
  await memory.flush();
  assert.equal(host.setCount(), before);
});

test('prune: 만료 전 armed는 now() - doneAt >= maxAgeMs 이면 제거', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 10000 });
  memory.remember('old', rec({ doneAt: 8000, expiresAt: 500000 }));
  memory.remember('exact', rec({ doneAt: 9500, expiresAt: 500000 }));
  memory.remember('new', rec({ doneAt: 9900, expiresAt: 500000 }));
  await memory.flush();

  memory.prune(500);
  await memory.flush();

  assert.equal(memory.get('old'), null);
  assert.equal(memory.get('exact'), null);
  assert.notEqual(memory.get('new'), null);
  assert.equal(memory.get('new').kind, 'armed');
  assert.equal(host.read().entries.old, undefined);
  assert.notEqual(host.read().entries.new, undefined);
});

test('prune: 만료된 v2 armed는 삭제 전에 history + expiredAt=expiresAt으로 전환', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 5000 });
  memory.remember('expired', rec({ doneAt: 1000, basisAt: 1000, expiresAt: 2000 }));
  await memory.flush();

  memory.prune(3600000);
  await memory.flush();

  const record = memory.get('expired');
  assert.notEqual(record, null);
  assert.equal(record.kind, 'history');
  assert.equal(record.expiredAt, 2000);
  assert.equal(record.expiresAt, 2000);
  assert.equal(host.read().entries.expired.kind, 'history');
  assert.equal(host.read().entries.expired.expiredAt, 2000);
});

test('prune: armed가 maxAge를 넘겼어도 실제 만료면 history 전환을 우선한다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 5000 });
  memory.remember('expired', rec({ doneAt: 1000, basisAt: 1000, expiresAt: 2000 }));
  await memory.flush();

  memory.prune(100); // maxAge로는 제거 대상이지만 만료 이력 보존이 우선이다.
  await memory.flush();

  assert.equal(memory.get('expired').kind, 'history');
  assert.equal(memory.get('expired').expiredAt, 2000);
});

test('prune: 만료 24시간을 넘긴 armed는 history로 남기지 않고 제거', async () => {
  const host = createFakeHost();
  const now = 2000 + RETENTION;
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => now });
  memory.remember('ancient', rec({ doneAt: 1000, basisAt: 1000, expiresAt: 2000 }));
  await memory.flush();

  memory.prune(3600000);
  await memory.flush();

  assert.equal(memory.get('ancient'), null);
});

test('prune: v1 armed(expiresAt 없음)는 기존 maxAge 규칙으로 제거', async () => {
  const host = createFakeHost({
    initial: { version: 1, entries: { old: { ...v1rec({ doneAt: 1000 }), savedAt: 1 } } },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 3601000 });
  await memory.load();

  memory.prune(3600000);
  await memory.flush();

  assert.equal(memory.get('old'), null);
  assert.equal(host.read().entries.old, undefined);
});

test('prune: history는 now >= expiresAt + 24h 정각에 제거하고 직전에는 유지', async () => {
  // 정각: 제거
  {
    const expiresAt = 100000;
    const host = createFakeHost();
    const memory = createEpochMemory({
      hostCall: host.hostCall,
      now: () => expiresAt + RETENTION,
    });
    memory.remember('h', rec({ doneAt: 50000, kind: 'history', expiresAt }));
    await memory.flush();
    memory.prune(3600000);
    await memory.flush();
    assert.equal(memory.get('h'), null, '정각 제거');
    assert.equal(host.read().entries.h, undefined);
  }
  // 직전: 유지
  {
    const expiresAt = 100000;
    const host = createFakeHost();
    const memory = createEpochMemory({
      hostCall: host.hostCall,
      now: () => expiresAt + RETENTION - 1,
    });
    memory.remember('h', rec({ doneAt: 50000, kind: 'history', expiresAt }));
    await memory.flush();
    memory.prune(3600000);
    await memory.flush();
    assert.notEqual(memory.get('h'), null, '직전 유지');
  }
});

test('prune: pending history(expiredAt null)도 같은 24시간 상한을 쓴다', async () => {
  const expiresAt = 100000;
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => expiresAt + RETENTION });
  memory.remember('h', rec({ doneAt: 50000, kind: 'history', expiresAt }));
  await memory.flush();
  assert.equal(memory.get('h').expiredAt, null);

  memory.prune(3600000);
  await memory.flush();
  assert.equal(memory.get('h'), null);
});

test('prune: savedAt 갱신은 history 보존을 연장하지 않는다', async () => {
  const expiresAt = 100000;
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => expiresAt + RETENTION });
  memory.remember('h', rec({ doneAt: 50000, kind: 'history', expiresAt }));
  await memory.flush();
  assert.equal(memory.get('h').savedAt, expiresAt + RETENTION, 'savedAt은 방금 갱신됨');

  memory.prune(3600000);
  await memory.flush();
  assert.equal(memory.get('h'), null);
});

test('prune: 제거 대상이 없으면 persist하지 않는다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 10000 });
  memory.remember('new', rec({ doneAt: 9900, expiresAt: 500000 }));
  await memory.flush();
  const before = host.setCount();

  memory.prune(500);
  await memory.flush();
  assert.equal(host.setCount(), before);
});

// ---------------------------------------------------------------------------
// 상한
// ---------------------------------------------------------------------------

test('MAX_ENTRIES: 초과 시 doneAt이 가장 오래된 것부터 제거', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  const total = EPOCH_MEMORY_MAX_ENTRIES + 5;
  for (let index = 0; index < total; index += 1) {
    memory.remember(`k${index}`, rec({ doneAt: index }));
  }
  await memory.flush();

  const stored = host.read();
  assert.equal(stored.version, 2);
  assert.equal(Object.keys(stored.entries).length, EPOCH_MEMORY_MAX_ENTRIES);
  assert.equal(memory.get('k0'), null);
  assert.equal(memory.get('k4'), null);
  assert.notEqual(memory.get('k5'), null);
  assert.notEqual(memory.get(`k${total - 1}`), null);
  assert.equal(stored.entries.k0, undefined);
  assert.notEqual(stored.entries.k5, undefined);

  const fresh = createEpochMemory({ hostCall: host.hostCall });
  await fresh.load();
  assert.equal(fresh.get('k0'), null);
  assert.notEqual(fresh.get('k5'), null);
});

test('MAX_BYTES: 직렬화 크기 초과 시 오래된 것부터 제거', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  const bigPty = 'x'.repeat(10000);
  const total = 40;
  for (let index = 0; index < total; index += 1) {
    memory.remember(`k${index}`, rec({ doneAt: index, ptyId: bigPty }));
  }
  await memory.flush();

  const stored = host.read();
  assert.ok(Object.keys(stored.entries).length < total, '일부 제거됨');
  assert.ok(
    Buffer.byteLength(JSON.stringify(stored), 'utf8') <= EPOCH_MEMORY_MAX_BYTES,
    '직렬화 크기 상한 이하',
  );
  assert.equal(memory.get('k0'), null, '가장 오래된 항목 제거');
  assert.notEqual(memory.get(`k${total - 1}`), null, '가장 최근 항목 유지');
  // 순서 보존: 남은 항목은 연속 구간이다.
  const remaining = Object.keys(stored.entries).map((key) => Number(key.slice(1))).sort((a, b) => a - b);
  assert.equal(remaining[remaining.length - 1], total - 1);
  for (let index = 1; index < remaining.length; index += 1) {
    assert.equal(remaining[index], remaining[index - 1] + 1);
  }
});

// ---------------------------------------------------------------------------
// persist 실패 / coalesce
// ---------------------------------------------------------------------------

test('storage.set 실패는 삼키고 다음 변경 때 재시도', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  host.setFail(true);

  memory.remember('k1', rec({ doneAt: 100 }));
  await memory.flush();
  assert.equal(host.has(), false);

  host.setFail(false);
  memory.remember('k2', rec({ doneAt: 200 }));
  await memory.flush();

  const stored = host.read();
  assert.notEqual(stored, undefined);
  assert.equal(stored.version, 2);
  assert.notEqual(stored.entries.k1, undefined);
  assert.notEqual(stored.entries.k2, undefined);
});

test('연속 변경은 persist 1회로 coalesce', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec({ doneAt: 1, basisAt: 1, expiresAt: 100 }));
  memory.remember('k2', rec({ doneAt: 2, basisAt: 2, expiresAt: 200 }));
  memory.remember('k3', rec({ doneAt: 3, basisAt: 3, expiresAt: 300 }));
  await memory.flush();

  assert.equal(host.setCount(), 1);
  assert.equal(Object.keys(host.read().entries).length, 3);
});

// ---------------------------------------------------------------------------
// load race / tombstone
// ---------------------------------------------------------------------------

test('load 진행 중 remember한 변경은 load 결과로 덮어쓰지 않는다', async () => {
  const host = createFakeHost();
  host.setGetDelay(20);
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 5000 });

  const loading = memory.load();
  memory.remember('k1', rec({ doneAt: 2000, basisAt: 2000, expiresAt: 300000 }));
  await loading;

  assert.equal(memory.get('k1').doneAt, 2000);
  await memory.flush();
  assert.equal(host.read().entries.k1.doneAt, 2000);
});

test('load 진행 중 forget한 변경은 load 결과로 되살아나지 않는다', async () => {
  const host = createFakeHost({
    initial: {
      version: 2,
      entries: { k1: { ...rec(), savedAt: 1 }, k2: { ...rec(), savedAt: 1 } },
    },
  });
  host.setGetDelay(20);
  const memory = createEpochMemory({ hostCall: host.hostCall });

  const loading = memory.load();
  memory.forget('k1');
  await loading;

  assert.equal(memory.get('k1'), null);
  assert.notEqual(memory.get('k2'), null);
});

test('load: set 실패 후 메모리에만 있던 항목을 유지하고 다시 persist', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  host.setFail(true);
  memory.remember('k1', rec());
  await memory.flush();
  assert.equal(host.has(), false);

  host.setFail(false);
  await memory.load();
  assert.notEqual(memory.get('k1'), null);

  await memory.flush();
  assert.notEqual(host.read().entries.k1, undefined);
});

test('load: 메모리 우선 병합이 storage와 다르면 persist 예약', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  host.setFail(true);
  memory.remember('local', rec({ doneAt: 1000 }));
  await memory.flush(); // 저장 실패 → storage 비어 있고 memory에만 local
  host.setFail(false);
  const before = host.setCount();

  await memory.load(); // memory 우선 병합 결과가 storage와 달라 persist 예약
  await memory.flush();

  assert.equal(host.setCount(), before + 1);
  assert.notEqual(host.read().entries.local, undefined);
});

test('load: 상한 초과 저장값을 정리하면 persist 예약', async () => {
  /** @type {Record<string, unknown>} */
  const entries = {};
  const total = EPOCH_MEMORY_MAX_ENTRIES + 3;
  for (let index = 0; index < total; index += 1) {
    entries[`k${index}`] = { ...v1rec({ doneAt: index }), savedAt: 1 };
  }
  const host = createFakeHost({ initial: { version: 1, entries } });
  const memory = createEpochMemory({ hostCall: host.hostCall });

  await memory.load();
  await memory.flush();

  const stored = host.read();
  assert.equal(stored.version, 2);
  assert.equal(Object.keys(stored.entries).length, EPOCH_MEMORY_MAX_ENTRIES);
  assert.equal(stored.entries.k0, undefined);
  assert.notEqual(stored.entries.k3, undefined);
  assert.equal(memory.get('k0'), null);
  assert.notEqual(memory.get('k3'), null);
});
