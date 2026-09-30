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
import crypto from 'node:crypto';

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

function makeModel({ store, runtime, diagnostics, randomId, now, hashTarget } = {}) {
  const calls = { policy: 0, review: [] };
  const model = createDashboardModel({
    store,
    getRuntimeView: () => runtime,
    getDiagnostics: diagnostics === undefined ? () => [] : () => diagnostics,
    hashTarget,
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

test('snapshot: config.tabTitleIndicator는 기본 true, config patch로 끌 수 있다', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });

  let snap = model.snapshot();
  assert.equal(snap.config.tabTitleIndicator, true);

  snap = await model.dispatch({
    type: 'config',
    patch: { tabTitleIndicator: false },
    expectedRevision: snap.revision,
  });
  assert.equal(snap.config.tabTitleIndicator, false);

  snap = await model.dispatch({
    type: 'config',
    patch: { tabTitleIndicator: true },
    expectedRevision: snap.revision,
  });
  assert.equal(snap.config.tabTitleIndicator, true);
});

test('snapshot: config에 TTL별 상한과 active를 투영한다', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });

  let snap = model.snapshot();
  assert.equal(snap.config.maxConsecutiveKeepalives5m, 8);
  assert.equal(snap.config.maxConsecutiveKeepalives1h, 3);
  // appTimer.ttlMs=300000(5분)이므로 5m 상한이 active.
  assert.equal(snap.config.maxConsecutiveKeepalivesActive, 8);
  assert.equal('maxConsecutiveKeepalives' in snap.config, false);

  // TTL 미상이면 보수적으로 두 값 중 작은 값.
  const unknownTimer = runtimeView({
    appTimer: { known: false, enabled: false, ttlMs: null, source: null, readAt: null, reason: 'settings_unknown' },
  });
  const { model: unknownModel } = makeModel({ store, runtime: unknownTimer });
  snap = unknownModel.snapshot();
  assert.equal(snap.config.maxConsecutiveKeepalivesActive, 3);
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

test('snapshot: 같은 repoId는 프로젝트 해시를 공유하고 다른 repoId는 분리한다', async () => {
  const { store } = await newStore();
  const repoIdA = '/private/workspace/repository-alpha';
  const repoIdB = '/private/workspace/repository-beta';
  const { model } = makeModel({
    store,
    runtime: runtimeView({
      worktrees: [
        wt({ worktreeId: 'project-w1', repoId: repoIdA }),
        wt({ worktreeId: 'project-w2', repoId: repoIdA }),
        wt({ worktreeId: 'project-w3', repoId: repoIdB }),
      ],
    }),
  });

  const snap = model.snapshot();
  const [first, second, third] = snap.worktrees;
  const expectedProjectId = `p${crypto.createHash('sha256').update(repoIdA, 'utf8').digest('hex').slice(0, 16)}`;
  assert.equal(first.projectId, expectedProjectId);
  assert.equal(second.projectId, expectedProjectId);
  assert.notEqual(first.projectId, third.projectId);
  assert.equal(first.projectId.includes(repoIdA), false);
  assert.equal(JSON.stringify(snap).includes(repoIdA), false);
  assert.equal(JSON.stringify(snap).includes(repoIdB), false);
});

test('snapshot: repoId가 없으면 projectId는 null이고 projectLabel은 label을 사용한다', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView({ worktrees: [wt({ label: 'main' })] }) });

  const [worktree] = model.snapshot().worktrees;
  assert.equal(worktree.projectId, null);
  assert.equal(worktree.projectLabel, 'main');
});

test('snapshot: projectLabel을 사용하고 200자로 제한한다', async () => {
  const { store } = await newStore();
  const projectLabel = 'Project display name';
  const longProjectLabel = 'x'.repeat(250);
  const { model } = makeModel({
    store,
    runtime: runtimeView({
      worktrees: [wt({ projectLabel }), wt({ worktreeId: 'project-long-label', projectLabel: longProjectLabel })],
    }),
  });

  const [worktree, longLabelWorktree] = model.snapshot().worktrees;
  assert.equal(worktree.projectLabel, projectLabel);
  assert.equal(longLabelWorktree.projectLabel, 'x'.repeat(200));
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

test('snapshot: worktree 객체에 repoId 키를 넣지 않는다', async () => {
  const { store } = await newStore();
  const repoId = '/private/repository/without-raw-id';
  const { model } = makeModel({ store, runtime: runtimeView({ worktrees: [wt({ repoId })] }) });

  const snap = model.snapshot();
  assert.equal('repoId' in snap.worktrees[0], false);
  assert.equal(JSON.stringify(snap).includes(repoId), false);
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
/* 캐시 표시 필드 (K, §2-1)                                            */
/* ------------------------------------------------------------------ */

test('snapshot: 캐시 표시 필드를 allowlist로 전달한다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [
          term({
            cacheState: 'kept',
            cacheStatus: 'scheduled',
            indicatorOn: true,
            expiresAt: 111_000,
            expiredAt: null,
            expireCause: 'DRAFT_PRESENT',
            blockedReason: 'OUTPUT_ACTIVE',
            dueAt: 100_000,
          }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const terminal = model.snapshot().worktrees[0].terminals[0];
  assert.equal(terminal.cacheState, 'kept');
  assert.equal(terminal.cacheStatus, 'scheduled');
  assert.equal(terminal.indicatorOn, true);
  assert.equal(terminal.expiresAt, 111_000);
  assert.equal(terminal.expiredAt, null);
  assert.equal(terminal.expireCause, 'DRAFT_PRESENT');
  assert.equal(terminal.blockedReason, 'OUTPUT_ACTIVE');
  assert.equal(terminal.dueAt, 100_000);
  // 호환용 기존 필드는 그대로 유지한다.
  assert.equal(terminal.phase, 'ARMED');
  assert.equal(terminal.effectiveEnabled, true);
});

test('snapshot: 누락·불량 캐시 필드는 none/no-reservation/null로 정규화', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [
          // 캐시 필드가 아예 없는 기본 terminal.
          term(),
          term({
            paneKey: 'p2',
            cacheState: 'BOGUS',
            cacheStatus: 'nope',
            indicatorOn: 'yes',
            expiresAt: 'not-a-number',
            expiredAt: Number.NaN,
            dueAt: Number.POSITIVE_INFINITY,
            expireCause: 'NOT_ALLOWED',
            blockedReason: 'also-not-allowed',
          }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const [missing, bad] = model.snapshot().worktrees[0].terminals;
  for (const terminal of [missing, bad]) {
    assert.equal(terminal.cacheState, 'none');
    assert.equal(terminal.cacheStatus, 'no-reservation');
    assert.equal(terminal.indicatorOn, false);
    assert.equal(terminal.expiresAt, null);
    assert.equal(terminal.expiredAt, null);
    assert.equal(terminal.dueAt, null);
    assert.equal(terminal.expireCause, null);
    assert.equal(terminal.blockedReason, null);
  }
});

test('snapshot: reservationNote 허용값만 전달하고 그 밖은 null', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [
          term({ paneKey: 'p1', cacheStatus: 'no-reservation', reservationNote: 'initial' }),
          term({ paneKey: 'p2', cacheStatus: 'no-reservation', reservationNote: 'safety-cutoff' }),
          term({ paneKey: 'p3', cacheStatus: 'no-reservation', reservationNote: 'BOGUS' }),
          term({ paneKey: 'p4', cacheStatus: 'no-reservation' }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const [initial, cutoff, bogus, missing] = model.snapshot().worktrees[0].terminals;
  assert.equal(initial.reservationNote, 'initial');
  assert.equal(cutoff.reservationNote, 'safety-cutoff');
  assert.equal(bogus.reservationNote, null);
  assert.equal(missing.reservationNote, null);
});

test('snapshot: 알 수 없는 캐시 문자열·민감정보를 노출하지 않는다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [
          term({
            cacheState: 'SECRET_STATE',
            cacheStatus: 'SECRET_STATUS',
            expireCause: 'SECRET_CAUSE',
            blockedReason: 'SECRET_BLOCK',
            draft: 'SECRET_DRAFT',
            secretTitle: 'SECRET_TITLE',
          }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const json = JSON.stringify(model.snapshot());
  for (const secret of ['SECRET_STATE', 'SECRET_STATUS', 'SECRET_CAUSE', 'SECRET_BLOCK', 'SECRET_DRAFT', 'SECRET_TITLE']) {
    assert.equal(json.includes(secret), false, `${secret} 미노출`);
  }
  const terminal = model.snapshot().worktrees[0].terminals[0];
  assert.equal(terminal.cacheState, 'none');
  assert.equal(terminal.cacheStatus, 'no-reservation');
  assert.equal(terminal.expireCause, null);
  assert.equal(terminal.blockedReason, null);
});

test('snapshot: needsReview budget은 cacheState/cacheStatus를 review로 우선한다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        terminals: [term({ cacheState: 'kept', cacheStatus: 'scheduled', indicatorOn: true })],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime });
  await store.markReview({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE, paneKey: PANE });

  const terminal = model.snapshot().worktrees[0].terminals[0];
  assert.equal(terminal.needsReview, true);
  assert.equal(terminal.cacheState, 'review');
  assert.equal(terminal.cacheStatus, 'review');
  // 표시기 활성 조건(indicatorOn)은 coordinator 계산값을 그대로 유지한다.
  assert.equal(terminal.indicatorOn, true);
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
  for (const unsupportedReason of ['NO_AGENT', 'UNSUPPORTED_AGENT']) {
    const runtime = runtimeView({
      worktrees: [
        wt({
          terminals: [term({ supported: false, unsupportedReason, reason: 'BUSY' })],
        }),
      ],
    });
    const { model } = makeModel({ store, runtime });
    const snap = model.snapshot();
    const terminal = snap.worktrees[0].terminals[0];
    assert.equal(terminal.supported, false);
    assert.equal(terminal.effectiveEnabled, false);
    assert.equal(terminal.reason, unsupportedReason);
  }
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
  await store.updateConfig({ maxConsecutiveKeepalives5m: 1, maxConsecutiveKeepalives1h: 1 });
  await store.reserveAttempt({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }, 1);
  snap = model.snapshot();
  assert.equal(store.isAllowedByPolicy({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }).reason, 'LIMIT_REACHED');
  assert.equal(snap.worktrees[0].effectiveEnabled, true);
  assert.equal(snap.worktrees[0].reason, null);
});

test('게이트: terminal scope의 budget 사유는 그대로 반영', async () => {
  const { store } = await newStore();
  const { model } = makeModel({ store, runtime: runtimeView() });
  await store.updateConfig({ maxConsecutiveKeepalives5m: 1, maxConsecutiveKeepalives1h: 1 });
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

test('statusSummary: 전역 1행 + 워크트리별 켜짐/꺼짐(기본값/직접 설정)', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-inherit', label: 'docs', terminals: [term({ worktreeId: 'w-inherit' })] }),
      wt({ worktreeId: 'w-on', label: 'feat-x', terminals: [term({ worktreeId: 'w-on' })] }),
      wt({ worktreeId: 'w-off', label: 'legacy', terminals: [term({ worktreeId: 'w-off' })] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  // 기본값 false: 상속은 꺼짐(기본값), override true/false는 직접 설정.
  await store.updateConfig({ defaultWorktreeEnabled: false });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-on' }, true);
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-off' }, false);

  const { text } = model.statusSummary();
  const lines = text.split('\n');
  assert.equal(lines[0], '켜짐 · 타이머 켜짐(5분) · 연결됨 · 워크트리 3개');
  assert.deepEqual(lines.slice(1), [
    'docs 꺼짐(기본값)',
    'feat-x 켜짐(직접 설정)',
    'legacy 꺼짐(직접 설정)',
  ]);
});

test('statusSummary: 기본값이 켜짐이면 상속 워크트리는 켜짐(기본값)으로 표시', async () => {
  const { store } = await newStore();
  await store.updateConfig({ defaultWorktreeEnabled: true });
  const runtime = runtimeView({ worktrees: [wt({ label: 'main' })] });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });

  const lines = model.statusSummary().text.split('\n');
  assert.equal(lines[1], 'main 켜짐(기본값)');
});

test('statusSummary: 프로젝트 이름을 제목으로, branch를 보조로 표시', async () => {
  const { store } = await newStore();
  await store.updateConfig({ defaultWorktreeEnabled: true });
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-proj',
        label: 'route-dashboard',
        branch: 'main',
        terminals: [term({ worktreeId: 'w-proj' })],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });

  const lines = model.statusSummary().text.split('\n');
  assert.equal(lines[1], 'route-dashboard (main) 켜짐(기본값)');
});

test('statusSummary: branch가 없거나 label과 같으면 보조 표시를 생략', async () => {
  const { store } = await newStore();
  await store.updateConfig({ defaultWorktreeEnabled: true });
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-same', label: 'main', branch: 'main', terminals: [term({ worktreeId: 'w-same' })] }),
      wt({ worktreeId: 'w-nobranch', label: 'docs', branch: null, terminals: [term({ worktreeId: 'w-nobranch' })] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });

  const lines = model.statusSummary().text.split('\n').slice(1);
  assert.equal(lines[0], 'main 켜짐(기본값)');
  assert.equal(lines[1], 'docs 켜짐(기본값)');
});

test('snapshot: worktree branch 필드를 전달하고 없으면 null', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-branch', label: 'route-dashboard', branch: 'main' }),
      wt({ worktreeId: 'w-nobranch', label: 'docs' }),
    ],
  });
  const { model } = makeModel({ store, runtime });

  const snap = model.snapshot();
  assert.equal(snap.worktrees[0].branch, 'main');
  assert.equal(snap.worktrees[1].branch, null);
});

test('statusSummary: 현재 워크트리를 ▶로 맨 앞에 표시하고 없으면 붙이지 않는다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-feat', label: 'feat-x', terminals: [term({ worktreeId: 'w-feat' })] }),
      wt({ worktreeId: WORKTREE, label: 'main', terminals: [term()] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  await store.updateConfig({ defaultWorktreeEnabled: false });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: WORKTREE }, true);

  const current = model.statusSummary({ currentWorktreeId: WORKTREE }).text.split('\n').slice(1);
  assert.deepEqual(current, ['▶ main 켜짐(직접 설정)', 'feat-x 꺼짐(기본값)']);

  // 알 수 없는/없는 현재 워크트리면 ▶ 없이 스냅숏 순서 그대로.
  const unknown = model.statusSummary({ currentWorktreeId: 'no-such-worktree' }).text;
  assert.equal(unknown.includes('▶'), false);
  const none = model.statusSummary().text;
  assert.equal(none.includes('▶'), false);
});

test('statusSummary: 일시정지 중에는 켜둔 워크트리를 켜짐(일시정지 중)으로 표시', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-on', label: 'main', terminals: [term({ worktreeId: 'w-on' })] }),
      wt({ worktreeId: 'w-inherit', label: 'docs', terminals: [term({ worktreeId: 'w-inherit' })] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  await store.updateConfig({ defaultWorktreeEnabled: false });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-on' }, true);
  await store.setPaused(true);

  const lines = model.statusSummary({ currentWorktreeId: 'w-on' }).text.split('\n');
  assert.ok(lines[0].startsWith('꺼짐(일시정지) · '));
  assert.deepEqual(lines.slice(1), ['▶ main 켜짐(일시정지 중)', 'docs 꺼짐(기본값)']);
});

test('statusSummary: 가장 이른 dueAt을 serverNow 기준 상대 시간으로 표시', async () => {
  const { store } = await newStore();
  const nowMs = 1_000_000;
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-a',
        label: 'main',
        terminals: [
          term({ worktreeId: 'w-a', dueAt: nowMs + 3_900_000 }),
          term({ worktreeId: 'w-a', paneKey: 'p2', dueAt: nowMs + 192_000 }),
        ],
      }),
      wt({ worktreeId: 'w-b', label: 'docs', terminals: [term({ worktreeId: 'w-b', dueAt: nowMs + 3_900_000 })] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => nowMs });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-b' }, true);

  const lines = model.statusSummary().text.split('\n').slice(1);
  assert.equal(lines[0], 'main 켜짐(직접 설정) · 다음 전송 3분 12초 후');
  assert.equal(lines[1], 'docs 켜짐(직접 설정) · 다음 전송 1시간 5분 후');
});

test('statusSummary: 꺼진 워크트리와 일시정지 중에는 다음 전송을 표시하지 않는다', async () => {
  const { store } = await newStore();
  const nowMs = 1_000_000;
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-a', label: 'main', terminals: [term({ worktreeId: 'w-a', dueAt: nowMs + 192_000 })] }),
      wt({ worktreeId: 'w-b', label: 'docs', terminals: [term({ worktreeId: 'w-b', dueAt: nowMs + 192_000 })] }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => nowMs });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-b' }, false);

  const lines = model.statusSummary().text.split('\n').slice(1);
  assert.equal(lines[0], 'main 켜짐(직접 설정) · 다음 전송 3분 12초 후');
  assert.equal(lines[1], 'docs 꺼짐(직접 설정)');

  await store.setPaused(true);
  const pausedLines = model.statusSummary().text.split('\n').slice(1);
  assert.equal(pausedLines[0], 'main 켜짐(일시정지 중)');
});

test('statusSummary: needsReview budget은 ⚠️ 확인 필요로 우선 표시', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-a',
        label: 'main',
        terminals: [
          term({ worktreeId: 'w-a', indicatorOn: true, cacheState: 'none', cacheStatus: 'no-reservation' }),
          term({ worktreeId: 'w-a', paneKey: 'p2', indicatorOn: true, cacheState: 'kept', cacheStatus: 'scheduled' }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);
  await store.markReview({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a', paneKey: PANE });

  const line = model.statusSummary().text.split('\n')[1];
  // review가 kept보다 우선한다(§2-2). kept 1개는 개수로만 남는다.
  assert.equal(line, 'main 켜짐(직접 설정) · ⚠️ 유지 중 1 · 만료 0 · 확인 필요 1');
});

test('statusSummary: 설정만 켜짐이고 예약이 없으면 💤 유지 중 아님으로 표시', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-a',
        label: 'main',
        terminals: [term({ worktreeId: 'w-a', indicatorOn: true, cacheState: 'none', cacheStatus: 'no-reservation' })],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);

  const line = model.statusSummary().text.split('\n')[1];
  assert.equal(line, 'main 켜짐(직접 설정) · 💤 유지 중 아님 · 만료 0 · 확인 필요 0');
  assert.equal(line.includes('⚡'), false, '설정만 켜짐으로는 ⚡를 붙이지 않는다');
});

test('statusSummary: kept·expired·review 개수를 캐시 상태 기호와 함께 표시', async () => {
  const { store } = await newStore();
  const nowMs = 1_000_000;
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-a',
        label: 'main',
        terminals: [
          term({ worktreeId: 'w-a', indicatorOn: true, cacheState: 'kept', cacheStatus: 'scheduled', expiresAt: nowMs + 60_000 }),
          term({ worktreeId: 'w-a', paneKey: 'p2', indicatorOn: true, cacheState: 'kept', cacheStatus: 'scheduled' }),
          term({ worktreeId: 'w-a', paneKey: 'p3', indicatorOn: true, cacheState: 'none', cacheStatus: 'expired', expiredAt: nowMs - 1 }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => nowMs });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);

  const line = model.statusSummary().text.split('\n')[1];
  assert.equal(line, 'main 켜짐(직접 설정) · ⚡ 유지 중 2 · 만료 1 · 확인 필요 0');
});

test('statusSummary: indicatorOn이 아닌 터미널은 캐시 문구에 합산하지 않는다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({
        worktreeId: 'w-a',
        label: 'main',
        terminals: [
          term({ worktreeId: 'w-a', indicatorOn: false, cacheState: 'kept', cacheStatus: 'scheduled' }),
          term({ worktreeId: 'w-a', paneKey: 'p2', cacheState: 'kept', cacheStatus: 'scheduled' }),
        ],
      }),
    ],
  });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });
  await store.setWorktree({ userDataKey: USER, profileId: 'p1', worktreeId: 'w-a' }, true);

  const line = model.statusSummary().text.split('\n')[1];
  assert.equal(line, 'main 켜짐(직접 설정)');
});

test('statusSummary: 워크트리가 없으면 대상 워크트리 없음', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({ worktrees: [] });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });

  const { text } = model.statusSummary();
  assert.equal(text, '켜짐 · 타이머 켜짐(5분) · 연결됨 · 워크트리 0개\n대상 워크트리 없음');
});

test('statusSummary: 480자를 넘으면 뒤 워크트리를 잘라 … 외 N개로 끝낸다', async () => {
  const { store } = await newStore();
  const worktrees = Array.from({ length: 40 }, (_, i) =>
    wt({ worktreeId: `w-${i}`, label: `worktree-${i}-${'x'.repeat(20)}`, terminals: [] }),
  );
  const { model } = makeModel({ store, runtime: runtimeView({ worktrees }), now: () => 1_000_000 });

  const { text } = model.statusSummary({ currentWorktreeId: 'w-0' });
  const lines = text.split('\n');
  assert.ok(text.length <= 480, `text length ${text.length} <= 480`);
  assert.match(lines.at(-1), /^… 외 \d+개$/);
  assert.ok(lines[1].startsWith('▶ '), '현재 워크트리는 맨 앞에 유지된다');
});

test('statusSummary: 원시 worktreeId·비밀·경로를 넣지 않는다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({ worktrees: [wt({ worktreeId: 'raw-secret-wt', label: 'main' })] });
  const { model } = makeModel({ store, runtime, now: () => 1_000_000 });

  const { text } = model.statusSummary({ currentWorktreeId: 'raw-secret-wt' });
  assert.equal(text.includes('raw-secret-wt'), false);
  assert.equal(text.includes(USER), false);
  assert.equal(text.includes(PANE), false);
});

/* ------------------------------------------------------------------ */
/* diagnostics — target/targetLabel                                    */
/* ------------------------------------------------------------------ */

/** coordinator/diagnostics와 같은 12 hex target 해시. */
function targetHash(worktreeId, paneKey) {
  return crypto
    .createHash('sha256')
    .update(`${worktreeId}\u0000${paneKey}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

test('diagnostics: 해시가 현재 터미널과 매칭되면 target/targetLabel을 붙인다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [wt({ worktreeId: WORKTREE, label: 'main', terminals: [term({ title: 'claude #1' })] })],
  });
  const diagnostics = [{ at: 5, level: 'info', event: 'epoch_armed', target: targetHash(WORKTREE, PANE) }];
  const { model } = makeModel({ store, runtime, diagnostics, hashTarget: targetHash });

  const [diag] = model.snapshot().diagnostics;
  assert.equal(diag.target, targetHash(WORKTREE, PANE));
  assert.equal(diag.targetLabel, 'main / claude #1');
});

test('diagnostics: terminal title이 없으면 targetLabel은 "터미널"', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [wt({ worktreeId: WORKTREE, label: 'main', terminals: [term({ title: null })] })],
  });
  const diagnostics = [{ at: 1, level: 'info', event: 'e', target: targetHash(WORKTREE, PANE) }];
  const { model } = makeModel({ store, runtime, diagnostics, hashTarget: targetHash });

  assert.equal(model.snapshot().diagnostics[0].targetLabel, 'main / 터미널');
});

test('diagnostics: worktree label이 없으면 branch로, 둘 다 없으면 "워크트리"로 대체', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [
      wt({ worktreeId: 'w-branch', label: null, branch: 'feature/x', terminals: [term({ worktreeId: 'w-branch', title: 't' })] }),
      wt({ worktreeId: 'w-none', label: null, branch: null, terminals: [term({ worktreeId: 'w-none', title: 't' })] }),
    ],
  });
  const diagnostics = [
    { at: 1, level: 'info', event: 'e1', target: targetHash('w-branch', PANE) },
    { at: 2, level: 'info', event: 'e2', target: targetHash('w-none', PANE) },
  ];
  const { model } = makeModel({ store, runtime, diagnostics, hashTarget: targetHash });

  const [branchDiag, noneDiag] = model.snapshot().diagnostics;
  assert.equal(branchDiag.targetLabel, 'feature/x / t');
  assert.equal(noneDiag.targetLabel, '워크트리 / t');
});

test('diagnostics: 매칭되는 터미널이 없으면 target은 있고 targetLabel은 null', async () => {
  const { store } = await newStore();
  const { model } = makeModel({
    store,
    runtime: runtimeView(),
    diagnostics: [{ at: 1, level: 'info', event: 'e', target: '0123456789ab' }],
    hashTarget: targetHash,
  });

  const [diag] = model.snapshot().diagnostics;
  assert.equal(diag.target, '0123456789ab');
  assert.equal(diag.targetLabel, null);
});

test('diagnostics: target이 없거나 12자리 hex가 아니면 두 필드를 생략', async () => {
  const { store } = await newStore();
  const diagnostics = [
    { at: 1, level: 'info', event: 'no-target' },
    { at: 2, level: 'info', event: 'bad-target', target: 'XYZ' },
    { at: 3, level: 'info', event: 'uppercase', target: '0123456789AB' },
    { at: 4, level: 'info', event: 'too-long', target: '0123456789abcd' },
  ];
  const { model } = makeModel({ store, runtime: runtimeView(), diagnostics, hashTarget: targetHash });

  for (const diag of model.snapshot().diagnostics) {
    assert.equal('target' in diag, false, `${diag.event} target 생략`);
    assert.equal('targetLabel' in diag, false, `${diag.event} targetLabel 생략`);
  }
});

test('diagnostics: hashTarget 미제공이면 target만 붙고 targetLabel은 null', async () => {
  const { store } = await newStore();
  const diagnostics = [{ at: 1, level: 'info', event: 'e', target: targetHash(WORKTREE, PANE) }];
  const { model } = makeModel({ store, runtime: runtimeView(), diagnostics });

  const [diag] = model.snapshot().diagnostics;
  assert.equal(diag.target, targetHash(WORKTREE, PANE));
  assert.equal(diag.targetLabel, null);
});

test('diagnostics: hashTarget이 함수가 아니면 null로 취급해 targetLabel은 null', async () => {
  const { store } = await newStore();
  const diagnostics = [{ at: 1, level: 'info', event: 'e', target: targetHash(WORKTREE, PANE) }];
  const { model } = makeModel({ store, runtime: runtimeView(), diagnostics, hashTarget: 'not-a-function' });

  const [diag] = model.snapshot().diagnostics;
  assert.equal(diag.target, targetHash(WORKTREE, PANE));
  assert.equal(diag.targetLabel, null);
});

test('diagnostics: hashTarget이 던지는 터미널만 targetLabel이 null', async () => {
  const { store } = await newStore();
  const good = { worktreeId: 'w-good', paneKey: 'p-good', title: 'good', phase: 'ARMED', reason: null, dueAt: null, expiresAt: null, supported: true, unsupportedReason: null };
  const bad = { worktreeId: 'w-bad', paneKey: 'p-bad', title: 'bad', phase: 'ARMED', reason: null, dueAt: null, expiresAt: null, supported: true, unsupportedReason: null };
  const runtime = runtimeView({ worktrees: [wt({ worktreeId: 'w-good', label: 'main', terminals: [good, bad] })] });
  const throwingHash = (worktreeId, paneKey) => {
    if (paneKey === 'p-bad') {
      throw new Error('boom');
    }
    return targetHash(worktreeId, paneKey);
  };
  const diagnostics = [
    { at: 1, level: 'info', event: 'good', target: targetHash('w-good', 'p-good') },
    { at: 2, level: 'info', event: 'bad', target: targetHash('w-good', 'p-bad') },
  ];
  const { model } = makeModel({ store, runtime, diagnostics, hashTarget: throwingHash });

  const [goodDiag, badDiag] = model.snapshot().diagnostics;
  assert.equal(goodDiag.targetLabel, 'main / good');
  assert.equal(badDiag.target, targetHash('w-good', 'p-bad'));
  assert.equal(badDiag.targetLabel, null);
});

test('diagnostics: 스냅숏 JSON에 원문 worktreeId/paneKey를 노출하지 않는다', async () => {
  const { store } = await newStore();
  const runtime = runtimeView({
    worktrees: [wt({ worktreeId: WORKTREE, label: 'main', terminals: [term({ title: 'claude #1' })] })],
  });
  const diagnostics = [{ at: 1, level: 'info', event: 'e', target: targetHash(WORKTREE, PANE) }];
  const { model } = makeModel({ store, runtime, diagnostics, hashTarget: targetHash });

  const json = JSON.stringify(model.snapshot());
  assert.equal(json.includes(WORKTREE), false);
  assert.equal(json.includes(PANE), false);
});
