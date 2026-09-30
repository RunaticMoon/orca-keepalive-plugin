import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEpochMemory,
  EPOCH_MEMORY_KEY,
  EPOCH_MEMORY_MAX_ENTRIES,
} from '../src/epoch-memory.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USER = 'u'.repeat(64);

/**
 * 유효한 EpochRecord(saveAt 제외). remember 입력으로 쓴다.
 * @param {object} [over]
 */
const rec = (over = {}) => ({
  worktreeId: 'w1',
  paneKey: 't1:l1',
  userDataKey: USER,
  profileId: 'p1',
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  doneAt: 1000,
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
    initial: JSON.stringify({ version: 1, entries: { k1: { ...rec(), savedAt: 7 } } }),
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('k1'), { ...rec(), savedAt: 7 });
});

test('load: 형식이 잘못된 항목은 버리고 유효한 항목만 적재', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
      entries: {
        good: { ...rec(), savedAt: 7 },
        nullIncarnation: { ...rec({ incarnationId: null }), savedAt: 7 },
        emptyString: { ...rec({ ptyId: '' }), savedAt: 7 },
        emptyIncarnation: { ...rec({ incarnationId: '' }), savedAt: 7 },
        badDoneAt: { ...rec({ doneAt: 'nope' }), savedAt: 7 },
        missingFields: { worktreeId: 'w1' },
        notObject: 42,
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.deepEqual(memory.get('good'), { ...rec(), savedAt: 7 });
  assert.deepEqual(memory.get('nullIncarnation'), { ...rec({ incarnationId: null }), savedAt: 7 });
  assert.equal(memory.get('emptyString'), null);
  assert.equal(memory.get('emptyIncarnation'), null);
  assert.equal(memory.get('badDoneAt'), null);
  assert.equal(memory.get('missingFields'), null);
  assert.equal(memory.get('notObject'), null);
});

test('load: 최상위 형식이 잘못되면 빈 상태', async () => {
  const host = createFakeHost({ initial: { version: 2, entries: { k: { ...rec(), savedAt: 7 } } } });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  assert.equal(memory.get('k'), null);
});

test('load: storage.get 실패 시 빈 상태(throw 금지)', async () => {
  const host = createFakeHost({ initial: { version: 1, entries: { k: { ...rec(), savedAt: 7 } } } });
  host.setGetFail(true);
  const memory = createEpochMemory({ hostCall: host.hostCall });

  await memory.load();
  assert.equal(memory.get('k'), null);
});

// ---------------------------------------------------------------------------
// round-trip
// ---------------------------------------------------------------------------

test('round-trip: remember → flush → 새 인스턴스 load → get', async () => {
  const host = createFakeHost();
  const first = createEpochMemory({ hostCall: host.hostCall, now: () => 111 });
  first.remember('k1', rec({ doneAt: 42 }));
  await first.flush();

  const stored = host.read();
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.entries.k1, { ...rec({ doneAt: 42 }), savedAt: 111 });

  const second = createEpochMemory({ hostCall: host.hostCall, now: () => 999 });
  await second.load();
  assert.deepEqual(second.get('k1'), { ...rec({ doneAt: 42 }), savedAt: 111 });
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

// ---------------------------------------------------------------------------
// remember
// ---------------------------------------------------------------------------

test('remember: 검증 실패 항목은 저장하지 않는다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall });

  memory.remember('bad', { ...rec(), ptyId: '' });
  memory.remember('bad2', { ...rec(), doneAt: Number.NaN });
  memory.remember('', rec());
  memory.remember('bad3', 42);
  await memory.flush();

  assert.equal(memory.get('bad'), null);
  assert.equal(memory.get('bad2'), null);
  assert.equal(memory.get('bad3'), null);
  assert.equal(host.setCount(), 0);
});

test('remember: 같은 내용(doneAt·ptyId·incarnationId)이면 추가 persist 없음', async () => {
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

test('get: 반환값을 바꿔도 내부에 영향 없음', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });
  memory.remember('k1', rec());
  await memory.flush();

  const view = memory.get('k1');
  view.doneAt = 0;
  view.ptyId = 'hacked';

  const again = memory.get('k1');
  assert.equal(again.doneAt, 1000);
  assert.equal(again.ptyId, 'pty-1');
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

test('prune: now() - doneAt >= maxAgeMs 인 항목 제거', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 10000 });
  memory.remember('old', rec({ doneAt: 8000 }));
  memory.remember('exact', rec({ doneAt: 9500 }));
  memory.remember('new', rec({ doneAt: 9900 }));
  await memory.flush();

  memory.prune(500);
  await memory.flush();

  assert.equal(memory.get('old'), null);
  assert.equal(memory.get('exact'), null);
  assert.notEqual(memory.get('new'), null);
  assert.equal(host.read().entries.old, undefined);
  assert.notEqual(host.read().entries.new, undefined);
});

test('prune: 제거 대상이 없으면 persist하지 않는다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 10000 });
  memory.remember('new', rec({ doneAt: 9900 }));
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
  assert.notEqual(stored.entries.k1, undefined);
  assert.notEqual(stored.entries.k2, undefined);
});

test('연속 변경은 persist 1회로 coalesce', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec({ doneAt: 1 }));
  memory.remember('k2', rec({ doneAt: 2 }));
  memory.remember('k3', rec({ doneAt: 3 }));
  await memory.flush();

  assert.equal(host.setCount(), 1);
  assert.equal(Object.keys(host.read().entries).length, 3);
});

// ---------------------------------------------------------------------------
// load race
// ---------------------------------------------------------------------------

test('load 진행 중 remember한 변경은 load 결과로 덮어쓰지 않는다', async () => {
  const host = createFakeHost();
  host.setGetDelay(20);
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 5000 });

  const loading = memory.load();
  memory.remember('k1', rec({ doneAt: 2000 }));
  await loading;

  assert.equal(memory.get('k1').doneAt, 2000);
  await memory.flush();
  assert.equal(host.read().entries.k1.doneAt, 2000);
});

test('load 진행 중 forget한 변경은 load 결과로 되살아나지 않는다', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
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
    entries[`k${index}`] = { ...rec({ doneAt: index }), savedAt: 1 };
  }
  const host = createFakeHost({ initial: { version: 1, entries } });
  const memory = createEpochMemory({ hostCall: host.hostCall });

  await memory.load();
  await memory.flush();

  const stored = host.read();
  assert.equal(Object.keys(stored.entries).length, EPOCH_MEMORY_MAX_ENTRIES);
  assert.equal(stored.entries.k0, undefined);
  assert.notEqual(stored.entries.k3, undefined);
  assert.equal(memory.get('k0'), null);
  assert.notEqual(memory.get('k3'), null);
});

// ---------------------------------------------------------------------------
// basisAt
// ---------------------------------------------------------------------------

test('basisAt: 유효한 값은 round-trip 되고 옛 레코드(없음)도 그대로 로드된다', async () => {
  const host = createFakeHost();
  const first = createEpochMemory({ hostCall: host.hostCall, now: () => 111 });
  first.remember('with', rec({ doneAt: 5000, basisAt: 4000 }));
  first.remember('without', rec({ doneAt: 6000 }));
  await first.flush();

  assert.equal(host.read().entries.with.basisAt, 4000);
  assert.equal('basisAt' in host.read().entries.without, false);

  const second = createEpochMemory({ hostCall: host.hostCall });
  await second.load();
  assert.equal(second.get('with').basisAt, 4000);
  assert.equal(
    Object.prototype.hasOwnProperty.call(second.get('without'), 'basisAt'),
    false,
  );
  assert.equal(second.get('without').doneAt, 6000);
});

test('basisAt: load 시 잘못된 값(doneAt 초과·비수치·null)은 생략한다', async () => {
  const host = createFakeHost({
    initial: {
      version: 1,
      entries: {
        future: { ...rec({ doneAt: 1000, basisAt: 2000 }), savedAt: 7 },
        nonNumeric: { ...rec({ doneAt: 1000, basisAt: 'x' }), savedAt: 7 },
        nullish: { ...rec({ doneAt: 1000, basisAt: null }), savedAt: 7 },
        valid: { ...rec({ doneAt: 1000, basisAt: 500 }), savedAt: 7 },
      },
    },
  });
  const memory = createEpochMemory({ hostCall: host.hostCall });
  await memory.load();

  for (const key of ['future', 'nonNumeric', 'nullish']) {
    const record = memory.get(key);
    assert.notEqual(record, null);
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'basisAt'), false);
    assert.equal(record.doneAt, 1000);
  }
  assert.equal(memory.get('valid').basisAt, 500);
});

test('remember: basisAt만 바뀌어도 다시 persist한다', async () => {
  const host = createFakeHost();
  const memory = createEpochMemory({ hostCall: host.hostCall, now: () => 1000 });

  memory.remember('k1', rec({ doneAt: 5000, basisAt: 4000 }));
  await memory.flush();
  const before = host.setCount();

  memory.remember('k1', rec({ doneAt: 5000, basisAt: 4000 }));
  await memory.flush();
  assert.equal(host.setCount(), before, '같은 내용이면 persist 없음');

  memory.remember('k1', rec({ doneAt: 5000, basisAt: 3000 }));
  await memory.flush();
  assert.equal(host.setCount(), before + 1);
  assert.equal(host.read().entries.k1.basisAt, 3000);
});
