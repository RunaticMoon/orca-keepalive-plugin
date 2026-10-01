import test from 'node:test';
import assert from 'node:assert/strict';

import { createStateStore, StoreError, STATE_KEY } from '../src/state-store.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 메모리 Map 기반 fake host storage. 지연·실패를 주입할 수 있다.
 * @param {{initial?: unknown}} [options]
 */
function createFakeHost({ initial } = {}) {
  const storage = new Map();
  if (initial !== undefined) {
    storage.set(STATE_KEY, structuredClone(initial));
  }
  let failSet = false;
  let failGet = false;
  let setDelayMs = 0;
  const calls = [];

  async function hostCall(method, params) {
    calls.push({ method, params });
    if (method === 'storage.get') {
      if (failGet) throw new Error('injected get failure');
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined };
    }
    if (method === 'storage.set') {
      if (failSet) throw new Error('injected set failure');
      if (setDelayMs > 0) await delay(setDelayMs);
      storage.set(params.key, structuredClone(params.value));
      return { ok: true };
    }
    throw new Error(`unknown method ${method}`);
  }

  return {
    hostCall,
    calls,
    read(key = STATE_KEY) {
      return storage.has(key) ? structuredClone(storage.get(key)) : undefined;
    },
    has(key = STATE_KEY) {
      return storage.has(key);
    },
    setFail(value) {
      failSet = value;
    },
    setGetFail(value) {
      failGet = value;
    },
    setDelay(ms) {
      setDelayMs = ms;
    },
  };
}

const USER = 'u'.repeat(64);
/** 워크트리 scope. */
const W = (over = {}) => ({ userDataKey: USER, profileId: 'p1', worktreeId: 'w1', ...over });
/** 터미널 scope. */
const T = (over = {}) => ({ userDataKey: USER, profileId: 'p1', worktreeId: 'w1', paneKey: 't1:l1', ...over });

async function newStore(host) {
  const store = createStateStore({ hostCall: host.hostCall });
  await store.load();
  return store;
}

// ---------------------------------------------------------------------------
// load / 기본값
// ---------------------------------------------------------------------------

test('load: 저장값이 없으면 revision 0 기본 상태', async () => {
  const host = createFakeHost();
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.revision, 0);
  assert.equal(snap.memoryPaused, false);
  assert.equal(snap.lastSaveError, null);
  assert.equal(snap.config.paused, false);
  assert.equal(snap.config.maxConsecutiveKeepalives5m, 8);
  assert.equal(snap.config.maxConsecutiveKeepalives1h, 3);
  assert.equal(snap.config.tabTitleIndicator, true);
  assert.deepEqual(snap.profiles, []);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.config));
});

test('load: 유효한 저장 상태를 round-trip한다', async () => {
  const host = createFakeHost();
  const s1 = await newStore(host);
  await s1.updateConfig({ message: 'hello keepalive' });
  await s1.setWorktree(W({ worktreeId: 'w1' }), false);
  await s1.setTerminal(T({ worktreeId: 'w1', paneKey: 't1:l1' }), false);
  const id = await s1.reserveAttempt(
    T({ worktreeId: 'w1', paneKey: 't1:l1', runtimeId: 'rt-1', ptyId: 'pty-1' }),
    7,
    111,
  );
  assert.equal(typeof id, 'string');

  const s2 = createStateStore({ hostCall: host.hostCall });
  const snap = await s2.load();
  assert.equal(snap.config.message, 'hello keepalive');
  const profile = snap.profiles.find((p) => p.profileId === 'p1');
  assert.equal(profile.worktrees.find((w) => w.worktreeId === 'w1').enabled, false);
  assert.equal(profile.terminals.find((t) => t.paneKey === 't1:l1').enabled, false);
  const budget = s2.getBudget(T({ worktreeId: 'w1', paneKey: 't1:l1' }));
  assert.equal(budget.charged, 1);
  assert.equal(budget.lastAttempt.epochId, 7);
  assert.equal(budget.lastAttempt.runtimeId, 'rt-1');
  assert.equal(budget.lastAttempt.ptyId, 'pty-1');
  assert.equal(budget.needsReview, true, '미완료 attempt는 재시작 시 review로 승격');
});

test('load: v1 상태는 v2로 마이그레이션한다(레거시 매핑 + tabTitleIndicator 강제)', async () => {
  const legacy = {
    schemaVersion: 1,
    revision: 3,
    config: { schemaVersion: 1, paused: false, defaultWorktreeEnabled: true, message: 'legacy', maxConsecutiveKeepalives: 2 },
    profiles: [],
  };
  const host = createFakeHost({ initial: legacy });
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.memoryPaused, false);
  assert.equal(snap.lastSaveError, null);
  assert.equal(snap.revision, 3);
  // L1: 로드 시 v1→v2 마이그레이션이 즉시 1회 저장된다.
  assert.equal(
    host.calls.filter((call) => call.method === 'storage.set').length,
    1,
    'v1 로드는 마이그레이션 결과를 1회 저장한다',
  );
  const savedAfterMigration = host.read();
  assert.equal(savedAfterMigration.config.schemaVersion, 2);
  assert.equal('maxConsecutiveKeepalives' in savedAfterMigration.config, false);
  assert.equal(savedAfterMigration.config.tabTitleIndicator, true);
  assert.equal(savedAfterMigration.revision, 3, '마이그레이션 저장은 revision을 올리지 않는다');
  // 옛 기본값 3이 아닌 레거시 2는 새 키 두 개에 적용된다.
  assert.equal(snap.config.maxConsecutiveKeepalives5m, 2);
  assert.equal(snap.config.maxConsecutiveKeepalives1h, 2);
  assert.equal('maxConsecutiveKeepalives' in snap.config, false);
  assert.equal(snap.config.message, 'legacy');
  assert.equal(snap.config.tabTitleIndicator, true, 'v1은 false를 구분할 수 없어 true로 켠다');

  // patch로 끄면 스냅숏/저장소 양쪽에 반영되고 재로드해도 유지된다.
  await store.updateConfig({ tabTitleIndicator: false });
  assert.equal(store.snapshot().config.tabTitleIndicator, false);
  assert.equal(host.read().config.tabTitleIndicator, false);

  const reloaded = createStateStore({ hostCall: host.hostCall });
  const reloadedSnap = await reloaded.load();
  assert.equal(reloadedSnap.config.tabTitleIndicator, false);
});

test('load: 이미 v2인 저장값은 로드만으로 저장하지 않는다', async () => {
  const host = createFakeHost();
  const s1 = await newStore(host);
  await s1.updateConfig({ message: 'v2 stored' });
  const setsBefore = host.calls.filter((call) => call.method === 'storage.set').length;
  assert.equal(setsBefore, 1);

  const s2 = createStateStore({ hostCall: host.hostCall });
  await s2.load();
  const setsAfter = host.calls.filter((call) => call.method === 'storage.set').length;
  assert.equal(setsAfter, setsBefore, '이미 v2인 저장값은 로드만으로 쓰지 않는다');
});

test('load: v1 마이그레이션 저장이 실패해도 메모리 값은 유지된다', async () => {
  const legacy = {
    schemaVersion: 1,
    revision: 1,
    config: { schemaVersion: 1, maxConsecutiveKeepalives: 2 },
    profiles: [],
  };
  const host = createFakeHost({ initial: legacy });
  host.setFail(true);
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.memoryPaused, false);
  assert.equal(snap.lastSaveError, 'storage_failed');
  // 저장은 실패했지만 메모리의 마이그레이션 결과는 그대로다.
  assert.equal(snap.config.schemaVersion, 2);
  assert.equal(snap.config.maxConsecutiveKeepalives5m, 2);
  assert.equal(snap.config.maxConsecutiveKeepalives1h, 2);
  assert.equal(snap.config.tabTitleIndicator, true);
  assert.equal('maxConsecutiveKeepalives' in snap.config, false);
  // 저장소는 갱신되지 않아 v1 그대로다.
  assert.equal(host.read().config.schemaVersion, 1);
});

test('updateConfig: tabTitleIndicator는 boolean만 허용한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await assert.rejects(() => store.updateConfig({ tabTitleIndicator: 'yes' }));
  await assert.rejects(() => store.updateConfig({ tabTitleIndicator: 1 }));
  assert.equal(store.snapshot().config.tabTitleIndicator, true);
});

test('load: schemaVersion 불일치/손상이면 전송 금지 + 저장소 미덮어쓰기', async () => {
  const corrupt = { schemaVersion: 2, revision: 5 };
  const host = createFakeHost({ initial: corrupt });
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.memoryPaused, true);
  assert.equal(snap.lastSaveError, 'state_invalid');
  assert.equal(snap.revision, 0);
  assert.deepEqual(snap.profiles, []);
  assert.equal(store.isAllowedByPolicy(W()).allowed, false);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'STORAGE_FAILED');
  assert.deepEqual(host.read(), corrupt, '손상 상태를 덮어쓰지 않는다');
});

test('load: 검증 실패 상태도 state_invalid로 로드한다', async () => {
  const invalid = { schemaVersion: 1, revision: 0, config: { bogus: 1 }, profiles: [] };
  const host = createFakeHost({ initial: invalid });
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();
  assert.equal(snap.memoryPaused, true);
  assert.equal(snap.lastSaveError, 'state_invalid');
  assert.deepEqual(host.read(), invalid);
});

test('load: storage.get 실패는 보수적으로 STORAGE_FAILED 처리', async () => {
  const host = createFakeHost();
  host.setGetFail(true);
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();
  assert.equal(snap.memoryPaused, true);
  assert.equal(snap.lastSaveError, 'storage_failed');
  assert.equal(store.isAllowedByPolicy(W()).reason, 'STORAGE_FAILED');
});

// ---------------------------------------------------------------------------
// 동시 토글 / lost update
// ---------------------------------------------------------------------------

test('동시 토글 10개에도 lost update 없이 revision이 10 증가한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const pending = [];
  for (let i = 0; i < 5; i += 1) {
    pending.push(store.setWorktree(W({ worktreeId: `w${i}` }), true));
  }
  for (let i = 5; i < 10; i += 1) {
    pending.push(store.setWorktree(W({ worktreeId: `w${i}` }), false));
  }
  await Promise.all(pending);

  const snap = store.snapshot();
  assert.equal(snap.revision, 10);
  const profile = snap.profiles.find((p) => p.profileId === 'p1');
  assert.equal(profile.worktrees.length, 10);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(profile.worktrees.find((w) => w.worktreeId === `w${i}`).enabled, true);
  }
  for (let i = 5; i < 10; i += 1) {
    assert.equal(profile.worktrees.find((w) => w.worktreeId === `w${i}`).enabled, false);
  }
});

test('저장 중 동기 OFF가 끼어들어도 lost update가 없다', async () => {
  const host = createFakeHost();
  host.setDelay(20);
  const store = await newStore(host);

  const pOn = store.setWorktree(W({ worktreeId: 'a' }), true);
  await delay(1); // ON task가 storage.set을 await하도록 진입
  const pOff = store.setWorktree(W({ worktreeId: 'b' }), false); // 동기 메모리 반영
  await Promise.all([pOn, pOff]);

  const profile = store.snapshot().profiles.find((p) => p.profileId === 'p1');
  assert.equal(profile.worktrees.find((w) => w.worktreeId === 'a').enabled, true);
  assert.equal(profile.worktrees.find((w) => w.worktreeId === 'b').enabled, false);
  assert.equal(store.snapshot().revision, 2);
});

// ---------------------------------------------------------------------------
// OFF 즉시 반영 / ON 저장 후 반영
// ---------------------------------------------------------------------------

test('OFF/pause는 메모리에 즉시 반영되고 저장 실패 시에도 유지된다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  host.setFail(true);

  const pending = store.setPaused(true);
  // await 이전에 동기적으로 보인다.
  assert.equal(store.snapshot().config.paused, true);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'GLOBAL_PAUSED');

  await assert.rejects(pending, (error) => error.code === 'storage_failed');
  assert.equal(store.snapshot().config.paused, true);
  assert.equal(store.snapshot().lastSaveError, 'storage_failed');
});

test('worktree/terminal OFF 실패도 메모리 차단을 유지한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  host.setFail(true);

  const pw = store.setWorktree(W(), false);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'SCOPE_DISABLED');
  await assert.rejects(pw, (error) => error.code === 'storage_failed');

  const pt = store.setTerminal(T(), false);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'SCOPE_DISABLED');
  await assert.rejects(pt, (error) => error.code === 'storage_failed');
});

test('ON은 저장 실패 시 메모리에 반영되지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const rev0 = store.snapshot().revision;
  host.setFail(true);

  await assert.rejects(store.setWorktree(W(), true), (error) => error.code === 'storage_failed');
  const snap = store.snapshot();
  assert.equal(snap.revision, rev0);
  assert.deepEqual(snap.profiles, []);
  assert.equal(snap.lastSaveError, 'storage_failed');
});

test('OFF 성공 시 저장소에 반영되고 revision이 증가한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.setPaused(true);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(host.read().config.paused, true);
});

// ---------------------------------------------------------------------------
// expectedRevision
// ---------------------------------------------------------------------------

test('expectedRevision 충돌은 409 revision_conflict', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await assert.rejects(
    store.setWorktree(W(), true, { expectedRevision: 3 }),
    (error) => error instanceof StoreError && error.code === 'revision_conflict' && error.status === 409,
  );
  await store.setWorktree(W(), true, { expectedRevision: 0 });
  assert.equal(store.snapshot().revision, 1);
});

test('즉시 반영 OFF도 expectedRevision 충돌이면 적용하지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await assert.rejects(
    store.setWorktree(W(), false, { expectedRevision: 9 }),
    (error) => error.code === 'revision_conflict',
  );
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.isAllowedByPolicy(W()).reason, null);
});

// ---------------------------------------------------------------------------
// 행/크기 제한
// ---------------------------------------------------------------------------

test('profile 행 제한(32) 초과는 row_limit', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  let success = 0;
  let error = null;
  for (let i = 0; i < 33; i += 1) {
    try {
      await store.setWorktree(W({ profileId: `p${i}` }), true);
      success += 1;
    } catch (caught) {
      error = caught;
      break;
    }
  }
  assert.equal(success, 32);
  assert.equal(error.code, 'row_limit');
});

test('직렬화 240 KiB 초과는 state_too_large', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const longId = 'w'.repeat(1000);
  let added = 0;
  let error = null;
  for (let i = 0; i < 1000; i += 1) {
    try {
      await store.setWorktree(W({ worktreeId: `${longId}${i}` }), true);
      added += 1;
    } catch (caught) {
      error = caught;
      break;
    }
  }
  assert.equal(error.code, 'state_too_large');
  assert.ok(added > 0 && added < 1000, `row limit 전에 size limit이 걸려야 한다(added=${added})`);
});

// ---------------------------------------------------------------------------
// reserve / confirm / refuse
// ---------------------------------------------------------------------------

test('reserve 저장 실패 시 charged가 변하지 않고 reject한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  host.setFail(true);
  await assert.rejects(store.reserveAttempt(T(), 1, 1000), (error) => error.code === 'storage_failed');
  assert.equal(store.getBudget(T()).charged, 0);
  assert.deepEqual(store.snapshot().profiles, []);
});

test('reserve 성공 시 charged+1, lastAttempt 저장', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const id = await store.reserveAttempt(T(), 42, 5000);
  const budget = store.getBudget(T());
  assert.equal(budget.charged, 1);
  assert.equal(budget.lastAttempt.attemptId, id);
  assert.equal(budget.lastAttempt.epochId, 42);
  assert.equal(budget.lastAttempt.phase, 'reserved');
  assert.equal(budget.lastAttempt.at, 5000);
});

test('reserve → 새 store load → needsReview', async () => {
  const host = createFakeHost();
  const s1 = await newStore(host);
  await s1.reserveAttempt(T(), 1, 1000);
  assert.equal(s1.getBudget(T()).needsReview, false);

  const s2 = createStateStore({ hostCall: host.hostCall });
  await s2.load();
  assert.equal(s2.getBudget(T()).needsReview, true);
  assert.equal(s2.getBudget(T()).lastAttempt.phase, 'reserved');
});

test('confirmAttempt는 같은 id에 idempotent', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const id = await store.reserveAttempt(T(), 1, 1);
  await store.recordAttempt(id, 'pasted');
  assert.equal(store.getBudget(T()).lastAttempt.phase, 'pasted');

  await store.confirmAttempt(id);
  assert.equal(store.getBudget(T()).confirmed, 1);
  assert.equal(store.getBudget(T()).lastAttempt.phase, 'confirmed');

  const revAfterFirst = store.snapshot().revision;
  await store.confirmAttempt(id);
  assert.equal(store.getBudget(T()).confirmed, 1, '두 번째 confirm은 증가하지 않는다');
  assert.equal(store.snapshot().revision, revAfterFirst, 'no-op은 revision을 올리지 않는다');
});

test('refuseAttempt는 reserved에서만 charged를 복원한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const id = await store.reserveAttempt(T(), 1, 1);
  await store.refuseAttempt(id);
  assert.equal(store.getBudget(T()).charged, 0);
  assert.equal(store.getBudget(T()).lastAttempt.phase, 'refused');

  const id2 = await store.reserveAttempt(T(), 2, 2);
  assert.equal(store.getBudget(T()).charged, 1);
  await store.recordAttempt(id2, 'pasted');
  await store.refuseAttempt(id2); // pasted 이후는 무시
  assert.equal(store.getBudget(T()).charged, 1);
  assert.equal(store.getBudget(T()).lastAttempt.phase, 'pasted');

  await store.confirmAttempt(id2);
  await store.refuseAttempt(id2); // confirmed 이후도 무시
  assert.equal(store.getBudget(T()).confirmed, 1);
  assert.equal(store.getBudget(T()).charged, 1);
});

test('recordAttempt는 잘못된 phase를 거절한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const id = await store.reserveAttempt(T(), 1, 1);
  await assert.rejects(
    store.recordAttempt(id, 'confirmed'),
    (error) => error instanceof StoreError && error.code === 'invalid_phase',
  );
});

// ---------------------------------------------------------------------------
// cap / resetBudget
// ---------------------------------------------------------------------------

test('연속 상한 도달 시 LIMIT_REACHED, resetBudget 후 재허용(TTL 미상=보수적 min)', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  // ttlMs 미지정이면 5m(8)/1h(3) 중 작은 3이 적용된다.
  for (let i = 0; i < 3; i += 1) {
    await store.reserveAttempt(T(), i, i);
  }
  assert.equal(store.getBudget(T()).charged, 3);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'LIMIT_REACHED');

  await store.resetBudget(T());
  assert.equal(store.getBudget(T()).charged, 0);
  assert.equal(store.getBudget(T()).confirmed, 0);
  assert.equal(store.isAllowedByPolicy(T()).allowed, true);
});

test('연속 상한 0은 무제한', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.updateConfig({ maxConsecutiveKeepalives5m: 0, maxConsecutiveKeepalives1h: 0 });
  for (let i = 0; i < 5; i += 1) {
    await store.reserveAttempt(T(), i, i);
  }
  assert.equal(store.getBudget(T()).charged, 5);
  assert.equal(store.isAllowedByPolicy(T()).allowed, true);
});

test('isAllowedByPolicy: ttlMs별로 다른 상한을 적용한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  // 5m=8, 1h=3. charged 5까지 예약한다.
  for (let i = 0; i < 5; i += 1) {
    await store.reserveAttempt(T(), i, i);
  }
  assert.equal(store.getBudget(T()).charged, 5);
  // 5분 TTL은 상한 8이라 아직 허용.
  assert.deepEqual(store.isAllowedByPolicy(T(), { ttlMs: 300000 }), { allowed: true, reason: null });
  // 1시간 TTL은 상한 3이라 LIMIT_REACHED.
  assert.equal(store.isAllowedByPolicy(T(), { ttlMs: 3600000 }).reason, 'LIMIT_REACHED');
  // TTL 미상이면 보수적으로 min(8,3)=3 → LIMIT_REACHED.
  assert.equal(store.isAllowedByPolicy(T()).reason, 'LIMIT_REACHED');
});

test('markReview는 메모리에 즉시 반영되고 저장 실패 시에도 유지된다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.setWorktree(W(), true);
  host.setFail(true);

  const pending = store.markReview(T(), 'uncertain');
  assert.equal(store.getBudget(T()).needsReview, true);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'PARTIAL_OR_UNKNOWN_SEND');

  await assert.rejects(pending, (error) => error.code === 'storage_failed');
  assert.equal(store.getBudget(T()).needsReview, true);
});

test('resetBudget은 needsReview를 유지한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.reserveAttempt(T(), 1, 1);
  await store.markReview(T(), 'uncertain');
  await store.resetBudget(T());
  assert.equal(store.getBudget(T()).charged, 0);
  assert.equal(store.getBudget(T()).needsReview, true);
});

// ---------------------------------------------------------------------------
// isAllowedByPolicy 우선순위
// ---------------------------------------------------------------------------

test('isAllowedByPolicy 우선순위 전 케이스', async () => {
  const host = createFakeHost();
  const store = await newStore(host);

  // 기본 허용
  assert.deepEqual(store.isAllowedByPolicy(W()), { allowed: true, reason: null });

  // GLOBAL_PAUSED가 최우선
  await store.setWorktree(W(), false);
  await store.setPaused(true);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'GLOBAL_PAUSED');
  await store.setPaused(false);

  // worktree override false
  assert.equal(store.isAllowedByPolicy(W()).reason, 'SCOPE_DISABLED');

  // default false이지만 worktree override true면 허용
  await store.updateConfig({ defaultWorktreeEnabled: false });
  await store.setWorktree(W({ worktreeId: 'w2' }), true);
  assert.equal(store.isAllowedByPolicy(W({ worktreeId: 'w2' })).allowed, true);
  // override 없는 다른 worktree는 기본 false
  assert.equal(store.isAllowedByPolicy(W({ worktreeId: 'w9' })).reason, 'SCOPE_DISABLED');

  // terminal override false
  await store.setTerminal(T({ worktreeId: 'w2' }), false);
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w2' })).reason, 'SCOPE_DISABLED');
  // terminal on은 worktree off를 덮어쓰지 않음
  await store.setWorktree(W({ worktreeId: 'w3' }), false);
  await store.setTerminal(T({ worktreeId: 'w3' }), true);
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w3' })).reason, 'SCOPE_DISABLED');

  // needsReview
  await store.setWorktree(W({ worktreeId: 'w4' }), true);
  await store.markReview(T({ worktreeId: 'w4' }), 'uncertain');
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w4' })).reason, 'PARTIAL_OR_UNKNOWN_SEND');
  await store.clearReview(T({ worktreeId: 'w4' }));
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w4' })).allowed, true);

  // LIMIT_REACHED (TTL 미상이면 min(8,3)=3)
  await store.setWorktree(W({ worktreeId: 'w5' }), true);
  for (let i = 0; i < 3; i += 1) {
    await store.reserveAttempt(T({ worktreeId: 'w5' }), i, i);
  }
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w5' })).reason, 'LIMIT_REACHED');
  // cap 0이면 무제한
  await store.updateConfig({ maxConsecutiveKeepalives5m: 0, maxConsecutiveKeepalives1h: 0 });
  assert.equal(store.isAllowedByPolicy(T({ worktreeId: 'w5' })).allowed, true);
  await store.updateConfig({ maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 3 });

  // memoryPaused/state_invalid → STORAGE_FAILED
  const badHost = createFakeHost({ initial: { schemaVersion: 99 } });
  const badStore = createStateStore({ hostCall: badHost.hostCall });
  await badStore.load();
  assert.equal(badStore.isAllowedByPolicy(W()).reason, 'STORAGE_FAILED');
});

// ---------------------------------------------------------------------------
// override 상속(null=삭제) / getOverrides
// ---------------------------------------------------------------------------

test('setWorktree(null)은 override를 삭제해 defaultWorktreeEnabled를 상속한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.updateConfig({ defaultWorktreeEnabled: false });
  await store.setWorktree(W(), true);
  assert.equal(store.getOverrides(W()).worktree, true);
  assert.equal(store.isAllowedByPolicy(W()).allowed, true);

  await store.setWorktree(W(), null);
  assert.equal(store.getOverrides(W()).worktree, null);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'SCOPE_DISABLED');
  assert.equal(host.read().profiles[0].worktrees.length, 0, '삭제가 저장소에 반영된다');

  const reloaded = createStateStore({ hostCall: host.hostCall });
  await reloaded.load();
  assert.equal(reloaded.getOverrides(W()).worktree, null);
  assert.equal(reloaded.isAllowedByPolicy(W()).reason, 'SCOPE_DISABLED');
});

test('setTerminal(null)은 override를 삭제해 워크트리 설정을 상속한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.setWorktree(W(), true);
  await store.setTerminal(T(), false);
  assert.equal(store.getOverrides(T()).terminal, false);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'SCOPE_DISABLED');

  await store.setTerminal(T(), null);
  assert.equal(store.getOverrides(T()).terminal, null);
  assert.equal(store.isAllowedByPolicy(T()).allowed, true, '워크트리 on을 상속한다');
  assert.equal(host.read().profiles[0].terminals.length, 0);

  await store.setWorktree(W(), false);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'SCOPE_DISABLED');
});

test('존재하지 않는 override 삭제는 no-op이며 revision을 올리지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  const revision = store.snapshot().revision;
  await store.setWorktree(W({ worktreeId: 'nope' }), null);
  assert.equal(store.snapshot().revision, revision);
  await store.setTerminal(T({ worktreeId: 'nope', paneKey: 'x:y' }), null);
  assert.equal(store.snapshot().revision, revision);
  assert.deepEqual(store.snapshot().profiles, []);
});

test('setTerminal(null)도 paneKey가 필요하다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await assert.rejects(store.setTerminal(W(), null), (error) => error.code === 'invalid_scope');
});

test('getOverrides는 override 값을 복사해 반환한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  assert.deepEqual(store.getOverrides(W()), { worktree: null, terminal: null });
  assert.deepEqual(store.getOverrides(T()), { worktree: null, terminal: null });

  await store.setWorktree(W(), false);
  await store.setTerminal(T(), true);
  assert.deepEqual(store.getOverrides(W()), { worktree: false, terminal: null });
  assert.deepEqual(store.getOverrides(T()), { worktree: false, terminal: true });
});

// ---------------------------------------------------------------------------
// prototype pollution / 불변성 / subscribe
// ---------------------------------------------------------------------------

test('__proto__/constructor 같은 worktreeId도 안전하다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.setWorktree(W({ worktreeId: '__proto__' }), false);
  await store.reserveAttempt(
    { userDataKey: USER, profileId: 'p1', worktreeId: 'constructor', paneKey: 'a:b' },
    1,
    1,
  );

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const profile = store.snapshot().profiles.find((p) => p.profileId === 'p1');
  assert.equal(profile.worktrees.find((w) => w.worktreeId === '__proto__').enabled, false);
  assert.equal(store.isAllowedByPolicy(W({ worktreeId: '__proto__' })).reason, 'SCOPE_DISABLED');

  // JSON round-trip에서도 안전
  const persisted = JSON.parse(JSON.stringify(host.read()));
  assert.equal(persisted.profiles[0].worktrees[0].worktreeId, '__proto__');
  assert.equal({}.polluted, undefined);
});

test('snapshot을 변형해도 내부 상태가 변하지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.setWorktree(W(), true);

  const snap = store.snapshot();
  assert.throws(() => {
    snap.config.paused = true;
  }, TypeError);
  assert.throws(() => {
    snap.profiles.push({});
  }, TypeError);
  assert.throws(() => {
    snap.memoryPaused = true;
  }, TypeError);
  assert.throws(() => {
    snap.profiles[0].worktrees.push({});
  }, TypeError);

  const fresh = store.snapshot();
  assert.equal(fresh.config.paused, false);
  assert.equal(fresh.profiles[0].worktrees.length, 1);
  assert.equal(fresh.memoryPaused, false);
});

test('subscribe는 mutation 후 알리고 unsubscribe 후에는 호출하지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  let calls = 0;
  let last = null;
  const unsubscribe = store.subscribe((snap) => {
    calls += 1;
    last = snap;
  });

  await store.setWorktree(W(), true);
  assert.ok(calls >= 1);
  assert.equal(last.profiles[0].worktrees[0].enabled, true);

  unsubscribe();
  const before = calls;
  await store.setWorktree(W({ worktreeId: 'w2' }), true);
  assert.equal(calls, before);
});

test('getBudget은 복사본이라 외부 변형이 내부에 영향 없다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.reserveAttempt(T(), 1, 1);
  const view = store.getBudget(T());
  view.charged = 999;
  view.lastAttempt.phase = 'confirmed';
  assert.equal(store.getBudget(T()).charged, 1);
  assert.equal(store.getBudget(T()).lastAttempt.phase, 'reserved');
});

test('flush는 대기 중 저장을 비운다', async () => {
  const host = createFakeHost();
  host.setDelay(10);
  const store = await newStore(host);
  store.setWorktree(W(), true).catch(() => {});
  await store.flush();
  assert.equal(host.read().profiles.length, 1);
});

// ---------------------------------------------------------------------------
// claudeCacheTtlMs 저장/로드 + 정책 TTL 기본값
// ---------------------------------------------------------------------------

test('load: claudeCacheTtlMs 없는 v2 저장값은 기본 1시간으로 채우되 재저장하지 않는다', async () => {
  const stored = {
    schemaVersion: 1,
    revision: 4,
    config: { schemaVersion: 2, message: 'no ttl field' },
    profiles: [],
  };
  const host = createFakeHost({ initial: stored });
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.memoryPaused, false);
  assert.equal(snap.lastSaveError, null);
  assert.equal(snap.revision, 4);
  assert.equal(snap.config.claudeCacheTtlMs, 3600000);
  assert.equal(
    host.calls.filter((call) => call.method === 'storage.set').length,
    0,
    '키 누락 보정으로 재저장하지 않는다',
  );
  assert.deepEqual(host.read(), stored, '저장소 원본을 덮어쓰지 않는다');
});

test('updateConfig: claudeCacheTtlMs를 저장하고 재로드 시 유지한다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.updateConfig({ claudeCacheTtlMs: 300000 });
  assert.equal(store.snapshot().config.claudeCacheTtlMs, 300000);
  assert.equal(host.read().config.claudeCacheTtlMs, 300000);

  const reloaded = createStateStore({ hostCall: host.hostCall });
  const snap = await reloaded.load();
  assert.equal(snap.config.claudeCacheTtlMs, 300000);
});

test('updateConfig: claudeCacheTtlMs 허용 밖 값/문자열은 거절하고 상태 불변', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  await store.updateConfig({ claudeCacheTtlMs: 300000 });

  await assert.rejects(
    () => store.updateConfig({ claudeCacheTtlMs: 600000 }),
    (error) => error.name === 'ValidationError' && error.code === 'out_of_range',
  );
  await assert.rejects(
    () => store.updateConfig({ claudeCacheTtlMs: '300000' }),
    (error) => error.name === 'ValidationError' && error.code === 'invalid_type',
  );
  assert.equal(store.snapshot().config.claudeCacheTtlMs, 300000);
  assert.equal(host.read().config.claudeCacheTtlMs, 300000);
});

test('load: 저장본 claudeCacheTtlMs가 허용 밖이면 state_invalid fail-closed', async () => {
  const invalid = {
    schemaVersion: 1,
    revision: 2,
    config: { schemaVersion: 2, claudeCacheTtlMs: 600000 },
    profiles: [],
  };
  const host = createFakeHost({ initial: invalid });
  const store = createStateStore({ hostCall: host.hostCall });
  const snap = await store.load();

  assert.equal(snap.memoryPaused, true);
  assert.equal(snap.lastSaveError, 'state_invalid');
  assert.equal(snap.revision, 0);
  assert.equal(store.isAllowedByPolicy(W()).reason, 'STORAGE_FAILED');
  assert.deepEqual(host.read(), invalid, '손상 상태를 덮어쓰지 않는다');
});

test('isAllowedByPolicy: options.ttlMs 없으면 config.claudeCacheTtlMs를 쓴다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);
  // 기본 1시간 TTL → 상한 3.
  for (let i = 0; i < 3; i += 1) {
    await store.reserveAttempt(T(), i, i);
  }
  assert.equal(store.snapshot().config.claudeCacheTtlMs, 3600000);
  assert.equal(store.isAllowedByPolicy(T()).reason, 'LIMIT_REACHED');
  // 명시하면 그 값 우선: 5분 TTL 상한 8이라 아직 허용.
  assert.equal(store.isAllowedByPolicy(T(), { ttlMs: 300000 }).allowed, true);

  // config TTL을 5분으로 바꾸면 options 없이도 상한 8을 쓴다.
  await store.updateConfig({ claudeCacheTtlMs: 300000 });
  await store.resetBudget(T());
  for (let i = 0; i < 3; i += 1) {
    await store.reserveAttempt(T(), i, i);
  }
  assert.equal(store.isAllowedByPolicy(T()).allowed, true, '5분 TTL은 상한 8');
  // options.ttlMs 명시가 config보다 우선한다.
  assert.equal(store.isAllowedByPolicy(T(), { ttlMs: 3600000 }).reason, 'LIMIT_REACHED');
});

test('updateConfig: 저장 실패/리비전 충돌 시 claudeCacheTtlMs 변경이 반영되지 않는다', async () => {
  const host = createFakeHost();
  const store = await newStore(host);

  await assert.rejects(
    () => store.updateConfig({ claudeCacheTtlMs: 300000 }, { expectedRevision: 99 }),
    (error) => error.code === 'revision_conflict',
  );
  assert.equal(store.snapshot().config.claudeCacheTtlMs, 3600000);

  host.setFail(true);
  await assert.rejects(
    () => store.updateConfig({ claudeCacheTtlMs: 300000 }),
    (error) => error.code === 'storage_failed',
  );
  assert.equal(store.snapshot().config.claudeCacheTtlMs, 3600000);
  assert.equal(store.snapshot().lastSaveError, 'storage_failed');
});
