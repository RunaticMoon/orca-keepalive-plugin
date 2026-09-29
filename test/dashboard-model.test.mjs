/**
 * Unit tests for the dashboard model (`src/dashboard-model.mjs`).
 *
 * These tests use the real `createStateStore` over an in-memory fake host and a
 * fake synchronous `getRuntimeView`, so they exercise the actual policy/gate
 * combination and the opaque targetId mapping. No RPC, HTTP or timer is used.
 *
 * Run: `node --test test/dashboard-model.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStateStore, StoreError } from '../src/state-store.mjs';
import { createDashboardModel, ActionError } from '../src/dashboard-model.mjs';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const USER = 'u'.repeat(64);
const WORKTREE = 'worktree-abc';
const PANE = 'pane-xyz';

/** 메모리 Map 기반 fake host storage. */
function createFakeHost() {
  const storage = new Map();
  async function hostCall(method, params) {
    if (method === 'storage.get') {
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined };
    }
    if (method === 'storage.set') {
      storage.set(params.key, structuredClone(params.value));
      return { ok: true };
    }
    throw new Error(`unknown method ${method}`);
  }
  return { hostCall };
}

async function newStore() {
  const host = createFakeHost();
  const store = createStateStore({ hostCall: host.hostCall });
  await store.load();
  return { store, host };
}

/**
 * @param {object} [over]
 * @returns {object}
 */
function term(over = {}) {
  return {
    worktreeId: WORKTREE,
    paneKey: PANE,
    title: 'claude #1',
    phase: 'ARMED',
    reason: null,
    dueAt: null,
    expiresAt: null,
    supported: true,
    unsupportedReason: null,
    ...over,
  };
}

/**
 * @param {object} [over]
 * @returns {object}
 */
function wt(over = {}) {
  return { worktreeId: WORKTREE, label: 'main', terminals: [term()], ...over };
}

/**
 * @param {object} [over]
 * @returns {object}
 */
function runtimeView(over = {}) {
  return {
    userDataKey: USER,
    profileId: 'p1',
    connection: { state: 'connected', reason: null },
    appTimer: { known: true, enabled: true, ttlMs: 300000, source: 'sqlite', readAt: 1111, reason: null },
    worktrees: [wt()],
    ...over,
  };
}

function makeModel({ store, runtime, diagnostics, randomId, now } = {}) {
  const calls = { policy: 0, review: [] };
  const model = createDashboardModel({
    store,
    getRuntimeView: () => runtime,
    getDiagnostics: diagnostics === undefined ? () => [] : () => diagnostics,
    onPolicyChanged: () => {
      calls.policy += 1;
    },
    onReviewCleared: (info) => {
      calls.review.push(info);
    },
    randomId,
    now,
  });
  return { model, calls };
}

async function expectActionError(promise, status, code) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ActionError, `expected ActionError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  assert.equal(caught.code, code);
}

/* ------------------------------------------------------------------ */
/* snapshot                                                            */
/* ------------------------------------------------------------------ */

test('snapshot: 연결 전(userDataKey/profileId null)이면 worktrees는 빈 배열', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    userDataKey: null,
    profileId: null,
    connection: { state: 'unavailable', reason: 'runtime_unavailable' },
    appTimer: { known: false, enabled: false, ttlMs: null, source: null, readAt: null, reason: 'settings_unknown' },
  });
  const { model } = makeModel({ store, runtime });

  const snap = model.snapshot();
  assert.equal(snap.revision, 0);
  assert.deepEqual(snap.worktrees, []);
  assert.equal(snap.appTimer.known, false);
  assert.equal(snap.connection.state, 'unavailable');
  assert.equal(snap.config.paused, false);
  assert.deepEqual(snap.diagnostics, []);
  assert.equal('schemaVersion' in snap.config, false);
});

test('snapshot: 같은 label 워크트리 2개와 split terminal은 각각 다른 targetId', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w1',
        label: 'main',
        terminals: [term({ worktreeId: 'w1', paneKey: 't1:l1' }), term({ worktreeId: 'w1', paneKey: 't1:l2' })],
      }),
      wt({ worktreeId: 'w2', label: 'main', terminals: [term({ worktreeId: 'w2', paneKey: 't2:l1' })] }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const snap = model.snapshot();
  assert.equal(snap.worktrees.length, 2);
  assert.equal(snap.worktrees[0].label, 'main');
  assert.equal(snap.worktrees[1].label, 'main');
  assert.notEqual(snap.worktrees[0].id, snap.worktrees[1].id);
  assert.equal(snap.worktrees[0].terminals.length, 2);
  assert.notEqual(snap.worktrees[0].terminals[0].id, snap.worktrees[0].terminals[1].id);
  assert.notEqual(snap.worktrees[0].terminals[0].id, snap.worktrees[1].terminals[0].id);
});

test('snapshot: targetId는 프로세스 수명 동안 안정적', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });

  const first = model.snapshot();
  const second = model.snapshot();
  assert.equal(first.worktrees[0].id, second.worktrees[0].id);
  assert.equal(first.worktrees[0].terminals[0].id, second.worktrees[0].terminals[0].id);
});

test('snapshot: 금지 필드(원문 식별자/비밀)가 JSON에 없다', async () => {
  const { store } = await newStore();
  const diagnostics = [{ at: 5, level: 'info', event: 'epoch_armed' }];
  const { model } = makeModel({ store, runtime: runtimeView(), diagnostics });

  await store.reserveAttempt(
    { userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE, runtimeId: 'rt-1', ptyId: 'pty-1' },
    1,
    42,
  );
  const snap = model.snapshot();
  const json = JSON.stringify(snap);

  assert.equal(json.includes(WORKTREE), false, '원문 worktreeId 노출 금지');
  assert.equal(json.includes(PANE), false, '원문 paneKey 노출 금지');
  assert.equal(json.includes('authToken'), false);
  assert.equal(json.includes('draft'), false);
  assert.equal(json.includes('handle'), false);
  assert.equal(json.includes('ptyId'), false);
  assert.equal(json.includes('term_'), false);
  assert.equal(snap.config.runtimeUserDataPath, null);
});

test('snapshot: 진단은 최근 50개만 {at,level,event,code?}로 매핑', async () => {
  const { store } = await newStore();
  const diagnostics = Array.from({ length: 60 }, (_, i) => ({
    at: i,
    level: i % 2 === 0 ? 'info' : 'warn',
    event: `event_${i}`,
    code: `code_${i}`,
    secret: 'should-not-leak',
  }));
  const { model } = makeModel({ store, runtime: runtimeView(), diagnostics });

  const snap = model.snapshot();
  assert.equal(snap.diagnostics.length, 50);
  assert.deepEqual(snap.diagnostics[0], { at: 10, level: 'info', event: 'event_10', code: 'code_10' });
  assert.equal('secret' in snap.diagnostics[0], false);
  assert.deepEqual(snap.diagnostics[49], { at: 59, level: 'warn', event: 'event_59', code: 'code_59' });
});

/* ------------------------------------------------------------------ */
/* 게이트 사유 우선순위                                                */
/* ------------------------------------------------------------------ */

test('게이트: 앱 타이머 off/unknown', async () => {
  const { store } = await newStore();

  const off = makeModel({
    store,
    runtime: runtimeView({ appTimer: { known: true, enabled: false, ttlMs: null, source: 'sqlite', readAt: 1 } }),
  });
  let snap = off.model.snapshot();
  assert.equal(snap.worktrees[0].effectiveEnabled, false);
  assert.equal(snap.worktrees[0].reason, 'APP_TIMER_OFF');
  assert.equal(snap.worktrees[0].terminals[0].effectiveEnabled, false);
  assert.equal(snap.worktrees[0].terminals[0].reason, 'APP_TIMER_OFF');

  const unknown = makeModel({
    store,
    runtime: runtimeView({ appTimer: { known: false, enabled: false, ttlMs: null, source: null, readAt: null, reason: 'settings_unknown' } }),
  });
  snap = unknown.model.snapshot();
  assert.equal(snap.worktrees[0].reason, 'SETTINGS_UNKNOWN');
  assert.equal(snap.worktrees[0].terminals[0].reason, 'SETTINGS_UNKNOWN');
  assert.equal(snap.appTimer.reason, 'settings_unknown');
});

test('게이트: 연결 끊김/wrong runtime 사유', async () => {
  const { store } = await newStore();

  const unavailable = makeModel({ store, runtime: runtimeView({ connection: { state: 'unavailable', reason: 'x' } }) });
  let snap = unavailable.model.snapshot();
  assert.equal(snap.worktrees[0].effectiveEnabled, false);
  assert.equal(snap.worktrees[0].reason, 'RUNTIME_UNAVAILABLE');
  assert.equal(snap.worktrees[0].terminals[0].reason, 'RUNTIME_UNAVAILABLE');

  const wrong = makeModel({ store, runtime: runtimeView({ connection: { state: 'wrong_runtime', reason: 'y' } }) });
  snap = wrong.model.snapshot();
  assert.equal(snap.worktrees[0].reason, 'WRONG_RUNTIME');
  assert.equal(snap.worktrees[0].terminals[0].reason, 'WRONG_RUNTIME');
});

test('게이트: unsupported terminal은 unsupportedReason을 우선 표시', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [term({ supported: false, unsupportedReason: 'UNSUPPORTED_AGENT', reason: 'BUSY' })],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });
  const snap = model.snapshot();
  const terminal = snap.worktrees[0].terminals[0];
  assert.equal(terminal.supported, false);
  assert.equal(terminal.effectiveEnabled, false);
  assert.equal(terminal.reason, 'UNSUPPORTED_AGENT');
});

test('게이트: 정책 사유(GLOBAL_PAUSED/SCOPE_DISABLED)와 worktree의 budget 사유 무시', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });

  // GLOBAL_PAUSED
  await store.setPaused(true);
  let snap = model.snapshot();
  assert.equal(snap.config.paused, true);
  assert.equal(snap.worktrees[0].effectiveEnabled, false);
  assert.equal(snap.worktrees[0].reason, 'GLOBAL_PAUSED');
  assert.equal(snap.worktrees[0].terminals[0].reason, 'GLOBAL_PAUSED');
  await store.setPaused(false);

  // SCOPE_DISABLED (worktree off)
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }, false);
  snap = model.snapshot();
  assert.equal(snap.worktrees[0].enabled, false);
  assert.equal(snap.worktrees[0].reason, 'SCOPE_DISABLED');
  assert.equal(snap.worktrees[0].terminals[0].reason, 'SCOPE_DISABLED');
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }, null);

  // worktree scope의 LIMIT_REACHED는 무시하고 effective는 유지
  await store.updateConfig({ maxConsecutiveKeepalives: 1 });
  await store.reserveAttempt({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }, 1);
  snap = model.snapshot();
  assert.equal(store.isAllowedByPolicy({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }).reason, 'LIMIT_REACHED');
  assert.equal(snap.worktrees[0].effectiveEnabled, true);
  assert.equal(snap.worktrees[0].reason, null);
});

test('게이트: terminal scope의 budget 사유는 그대로 반영', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  await store.updateConfig({ maxConsecutiveKeepalives: 1 });
  await store.reserveAttempt({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE }, 1);

  const snap = model.snapshot();
  assert.equal(snap.worktrees[0].terminals[0].effectiveEnabled, false);
  assert.equal(snap.worktrees[0].terminals[0].reason, 'LIMIT_REACHED');
  assert.equal(snap.worktrees[0].terminals[0].charged, 1);
});

/* ------------------------------------------------------------------ */
/* dispatch — 성공 경로                                                 */
/* ------------------------------------------------------------------ */

test('dispatch: 모든 action 성공 경로와 onPolicyChanged 호출', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });

  let snap = model.snapshot();
  const wtId = snap.worktrees[0].id;
  const tmId = snap.worktrees[0].terminals[0].id;

  // pause
  snap = await model.dispatch({ type: 'pause', paused: true, expectedRevision: snap.revision });
  assert.equal(snap.config.paused, true);
  assert.equal(calls.policy, 1);

  // worktree off
  snap = await model.dispatch({ type: 'worktree', targetId: wtId, enabled: false, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].enabled, false);
  assert.equal(calls.policy, 2);

  // worktree inherit
  snap = await model.dispatch({ type: 'worktree', targetId: wtId, enabled: null, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].enabled, null);

  // terminal on / inherit
  snap = await model.dispatch({ type: 'terminal', targetId: tmId, enabled: true, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].terminals[0].enabledOverride, true);
  snap = await model.dispatch({ type: 'terminal', targetId: tmId, enabled: null, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].terminals[0].enabledOverride, null);

  // config
  snap = await model.dispatch({ type: 'config', patch: { message: 'hello keepalive' }, expectedRevision: snap.revision });
  assert.equal(snap.config.message, 'hello keepalive');

  // reset-budget
  await store.reserveAttempt({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE }, 1);
  snap = model.snapshot();
  assert.equal(snap.worktrees[0].terminals[0].charged, 1);
  snap = await model.dispatch({ type: 'reset-budget', targetId: tmId, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].terminals[0].charged, 0);

  // clear-review
  await store.markReview({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE });
  snap = model.snapshot();
  assert.equal(snap.worktrees[0].terminals[0].needsReview, true);
  snap = await model.dispatch({ type: 'clear-review', targetId: tmId, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].terminals[0].needsReview, false);
  assert.deepEqual(calls.review.at(-1), { worktreeId: WORKTREE, paneKey: PANE });

  // 모든 성공 mutation마다 onPolicyChanged 1회: pause, worktree(off, null), terminal(on, null), config, reset, clear
  assert.equal(calls.policy, 8);
});

test('dispatch: clear-review는 onReviewCleared에 worktreeId/paneKey를 넘긴다', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  await store.markReview({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE });
  const snap = model.snapshot();
  const tmId = snap.worktrees[0].terminals[0].id;

  await model.dispatch({ type: 'clear-review', targetId: tmId, expectedRevision: snap.revision });
  assert.equal(calls.review.length, 1);
  assert.deepEqual(calls.review[0], { worktreeId: WORKTREE, paneKey: PANE });
});

/* ------------------------------------------------------------------ */
/* dispatch — 오류 매핑                                                */
/* ------------------------------------------------------------------ */

test('dispatch: revision 불일치는 409 revision_conflict', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  const snap = model.snapshot();
  await expectActionError(
    model.dispatch({ type: 'pause', paused: true, expectedRevision: snap.revision + 1 }),
    409,
    'revision_conflict',
  );
  assert.equal(calls.policy, 0);
});

test('dispatch: unknown target은 404', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  const snap = model.snapshot();
  await expectActionError(
    model.dispatch({ type: 'worktree', targetId: 'does-not-exist', enabled: false, expectedRevision: snap.revision }),
    404,
    'unknown_target',
  );
});

test('dispatch: 종류 불일치(worktree 액션에 terminal ID)는 404', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  const snap = model.snapshot();
  const tmId = snap.worktrees[0].terminals[0].id;
  const wtId = snap.worktrees[0].id;

  await expectActionError(
    model.dispatch({ type: 'worktree', targetId: tmId, enabled: false, expectedRevision: snap.revision }),
    404,
    'unknown_target',
  );
  await expectActionError(
    model.dispatch({ type: 'reset-budget', targetId: wtId, expectedRevision: snap.revision }),
    404,
    'unknown_target',
  );
});

test('dispatch: invalid action은 400 invalid_action', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  const rev = model.snapshot().revision;

  await expectActionError(model.dispatch(null), 400, 'invalid_action');
  await expectActionError(model.dispatch({ type: 'nope', expectedRevision: rev }), 400, 'invalid_action');
  await expectActionError(model.dispatch({ type: 'pause', paused: true }), 400, 'invalid_action');
  await expectActionError(model.dispatch({ type: 'pause', paused: true, expectedRevision: 1.5 }), 400, 'invalid_action');
  await expectActionError(
    model.dispatch({ type: 'pause', paused: 'yes', expectedRevision: rev }),
    400,
    'invalid_action',
  );
  await expectActionError(
    model.dispatch({ type: 'terminal', targetId: 'x', enabled: 'yes', expectedRevision: rev }),
    400,
    'invalid_action',
  );
});

test('dispatch: config 검증 실패는 400 invalid_config', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  const rev = model.snapshot().revision;

  await expectActionError(model.dispatch({ type: 'config', patch: { bogus: 1 }, expectedRevision: rev }), 400, 'invalid_config');
  await expectActionError(model.dispatch({ type: 'config', patch: undefined, expectedRevision: rev }), 400, 'invalid_config');
  assert.equal(calls.policy, 0);
});

/* ------------------------------------------------------------------ */
/* toggleWorktreeById / setPaused / statusSummary                       */
/* ------------------------------------------------------------------ */

test('toggleWorktreeById: effective 상태를 반전하고 label을 반환', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });

  const first = await model.toggleWorktreeById(WORKTREE);
  assert.deepEqual(first, { enabled: false, label: 'main' });
  assert.equal(model.snapshot().worktrees[0].enabled, false);
  assert.equal(calls.policy, 1);

  const second = await model.toggleWorktreeById(WORKTREE);
  assert.deepEqual(second, { enabled: true, label: 'main' });
  assert.equal(model.snapshot().worktrees[0].enabled, true);
  assert.equal(calls.policy, 2);
});

test('toggleWorktreeById: runtime 준비 전이면 503 not_ready', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView({ userDataKey: null, profileId: null }) });
  await expectActionError(model.toggleWorktreeById(WORKTREE), 503, 'not_ready');
});

/* ------------------------------------------------------------------ */
/* setWorktreeById / dispatch worktree-orca / worktreeHash              */
/* ------------------------------------------------------------------ */

test('snapshot: worktreeHash는 원시 worktreeId의 sha256 앞 16자', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({ worktrees: [wt({ worktreeId: WORKTREE, label: 'main' })] });
  const { model } = makeModel({ store, runtime });

  const snap = model.snapshot();
  assert.equal(snap.worktrees[0].worktreeHash, '19e89c042ff154fc');
  assert.equal(JSON.stringify(snap).includes(WORKTREE), false);
});

test('setWorktreeById: true/false/null override와 effective 반환', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });

  const on = await model.setWorktreeById(WORKTREE, false);
  assert.deepEqual(on, { enabled: false, override: false, label: 'main' });
  assert.equal(model.snapshot().worktrees[0].enabled, false);
  assert.equal(calls.policy, 1);

  const off = await model.setWorktreeById(WORKTREE, true);
  assert.deepEqual(off, { enabled: true, override: true, label: 'main' });
  assert.equal(model.snapshot().worktrees[0].enabled, true);

  // default를 true로 바꾼 뒤 null(상속)로 제거하면 effective는 default를 따른다.
  await store.updateConfig({ defaultWorktreeEnabled: true });
  const inherit = await model.setWorktreeById(WORKTREE, null);
  assert.deepEqual(inherit, { enabled: true, override: null, label: 'main' });
  assert.equal(model.snapshot().worktrees[0].enabled, null);
  assert.equal(model.snapshot().worktrees[0].effectiveEnabled, true);

  await store.updateConfig({ defaultWorktreeEnabled: false });
  const inheritOff = await model.setWorktreeById(WORKTREE, null);
  assert.deepEqual(inheritOff, { enabled: false, override: null, label: 'main' });
});

test('setWorktreeById: 없는 worktreeId는 404 unknown_target', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  await expectActionError(model.setWorktreeById('does-not-exist', false), 404, 'unknown_target');
  await expectActionError(model.setWorktreeById('', false), 404, 'unknown_target');
  assert.equal(calls.policy, 0);
});

test('setWorktreeById: runtime 준비 전이면 503 not_ready', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView({ userDataKey: null, profileId: null }) });
  await expectActionError(model.setWorktreeById(WORKTREE, true), 503, 'not_ready');
});

test('setWorktreeById: enabled가 boolean/null이 아니면 400 invalid_action', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  await expectActionError(model.setWorktreeById(WORKTREE, 'yes'), 400, 'invalid_action');
  await expectActionError(model.setWorktreeById(WORKTREE, 1), 400, 'invalid_action');
  await expectActionError(model.setWorktreeById(WORKTREE, undefined), 400, 'invalid_action');
});

test('dispatch: worktree-orca 성공 경로와 onPolicyChanged 1회', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });

  let snap = model.snapshot();
  snap = await model.dispatch({ type: 'worktree-orca', worktreeId: WORKTREE, enabled: false, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].enabled, false);
  assert.equal(calls.policy, 1);

  snap = await model.dispatch({ type: 'worktree-orca', worktreeId: WORKTREE, enabled: null, expectedRevision: snap.revision });
  assert.equal(snap.worktrees[0].enabled, null);
  assert.equal(calls.policy, 2);
});

test('dispatch: worktree-orca revision 불일치는 409', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  const snap = model.snapshot();
  await expectActionError(
    model.dispatch({ type: 'worktree-orca', worktreeId: WORKTREE, enabled: true, expectedRevision: snap.revision + 1 }),
    409,
    'revision_conflict',
  );
  assert.equal(calls.policy, 0);
});

test('dispatch: worktree-orca 검증 실패는 400 invalid_action', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  const rev = model.snapshot().revision;

  await expectActionError(model.dispatch({ type: 'worktree-orca', enabled: true, expectedRevision: rev }), 400, 'invalid_action');
  await expectActionError(
    model.dispatch({ type: 'worktree-orca', worktreeId: 5, enabled: true, expectedRevision: rev }),
    400,
    'invalid_action',
  );
  await expectActionError(
    model.dispatch({ type: 'worktree-orca', worktreeId: WORKTREE, enabled: 'yes', expectedRevision: rev }),
    400,
    'invalid_action',
  );
  await expectActionError(
    model.dispatch({ type: 'worktree-orca', worktreeId: WORKTREE, enabled: true, expectedRevision: 1.5 }),
    400,
    'invalid_action',
  );
  // 존재하지 않는 worktreeId는 저장 전에 404로 거부한다.
  await expectActionError(
    model.dispatch({ type: 'worktree-orca', worktreeId: 'nope', enabled: true, expectedRevision: rev }),
    404,
    'unknown_target',
  );
});

test('setPaused: 저장 후 onPolicyChanged 호출', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });
  await model.setPaused(true);
  assert.equal(model.snapshot().config.paused, true);
  assert.equal(calls.policy, 1);
});

test('togglePaused: false→true→false 연속 2회 토글하고 매번 onPolicyChanged 1회', async () => {
  const { store } = await newStore();
  const { model, calls } = makeModel({ store, runtime: runtimeView() });

  const first = await model.togglePaused();
  assert.deepEqual(first, { paused: true });
  assert.equal(model.snapshot().config.paused, true);
  assert.equal(calls.policy, 1);

  const second = await model.togglePaused();
  assert.deepEqual(second, { paused: false });
  assert.equal(model.snapshot().config.paused, false);
  assert.equal(calls.policy, 2);
});

test('togglePaused: revision_conflict 1회 후 새 snapshot으로 재시도해 성공', async () => {
  const { store } = await newStore();
  let conflicts = 1;
  const wrapped = {
    ...store,
    setPaused(paused, options) {
      if (conflicts > 0) {
        conflicts -= 1;
        return Promise.reject(new StoreError('revision_conflict', { status: 409 }));
      }
      return store.setPaused(paused, options);
    },
  };
  const { model, calls } = makeModel({ store: wrapped, runtime: runtimeView() });

  const result = await model.togglePaused();
  assert.deepEqual(result, { paused: true });
  assert.equal(model.snapshot().config.paused, true);
  assert.equal(calls.policy, 1);
});

test('togglePaused: 두 번 연속 revision_conflict이면 409 revision_conflict', async () => {
  const { store } = await newStore();
  let conflicts = 0;
  const wrapped = {
    ...store,
    setPaused() {
      conflicts += 1;
      return Promise.reject(new StoreError('revision_conflict', { status: 409 }));
    },
  };
  const { model, calls } = makeModel({ store: wrapped, runtime: runtimeView() });

  await expectActionError(model.togglePaused(), 409, 'revision_conflict');
  assert.equal(conflicts, 2, '충돌 시 정확히 한 번만 재시도한다');
  assert.equal(calls.policy, 0);
});

test('statusSummary: 문구와 200자 이하 길이', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [term({ dueAt: 123 }), term({ paneKey: 'pane-2', title: 'claude #2' })],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const enabled = model.statusSummary();
  assert.equal(
    enabled.text,
    '켜짐 · 타이머 켜짐(5분) · 연결됨 · 워크트리 1개 · 대상 2개 중 활성 2 · 예약 1 · 확인 필요 0',
  );
  assert.ok(enabled.text.length <= 200);

  await model.setPaused(true);
  const paused = model.statusSummary();
  assert.ok(paused.text.startsWith('꺼짐(일시정지) · '));
  assert.ok(paused.text.length <= 200);

  const offStore = (await newStore()).store;
  const off = makeModel({
    store: offStore,
    runtime: runtimeView({ appTimer: { known: true, enabled: false, ttlMs: null, source: 'sqlite', readAt: 1 } }),
  });
  const offText = off.model.statusSummary();
  assert.ok(offText.text.startsWith('켜짐 · Orca 프롬프트 캐시 타이머 꺼짐 · '));
  assert.ok(offText.text.length <= 200);
  assert.equal(offText.text.includes(USER), false);
});
