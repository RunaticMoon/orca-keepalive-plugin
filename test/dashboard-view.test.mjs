/**
 * Unit tests for the pure dashboard view model (`ui/app.mjs`).
 *
 * These tests never touch the DOM: the module only boots when `document`
 * exists, so importing it under Node is side-effect free. Static asset checks
 * read `ui/index.html` and `ui/app.mjs` as text to enforce the CSP/no-innerHTML
 * rules from DESIGN §7.3–§7.4.
 *
 * Run: `node --test test/dashboard-view.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DIAGNOSTIC_EVENTS, REASON_CODES, EXPIRE_CAUSE_REASONS } from '../src/contracts.mjs';
import {
  DIAGNOSTIC_EVENT_TEXT,
  EXPIRE_CAUSE_TEXT,
  cacheStatusDisplay,
  formatCacheTime,
  formatRemaining,
  reasonText,
  toViewModel,
  worktreeToggleLabel,
  buildAction,
  parseTokenFromHash,
} from '../ui/app.mjs';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SERVER_NOW = 1_000_000;

function makeSnapshot(overrides = {}) {
  const base = {
    revision: 7,
    serverNow: SERVER_NOW,
    appTimer: { known: true, enabled: true, ttlMs: 300000, source: 'sqlite', readAt: SERVER_NOW - 1000 },
    connection: { state: 'connected' },
    config: {
      paused: false,
      defaultWorktreeEnabled: true,
      message: 'keepalive',
      margin5mMs: 30000,
      margin1hMs: 60000,
      quietOutputMs: 5000,
      observedInputQuietMs: 5000,
      maxConsecutiveKeepalives5m: 8,
      maxConsecutiveKeepalives1h: 3,
      maxConsecutiveKeepalivesActive: 8,
      respectCwarmDisabled: true,
      logLevel: 'info',
      runtimeUserDataPath: null,
    },
    worktrees: [
      {
        id: 'wt-1',
        label: 'main',
        enabled: true,
        effectiveEnabled: true,
        reason: '',
        terminals: [
          {
            id: 't-1',
            title: 'claude #1',
            phase: 'ARMED',
            enabledOverride: null,
            effectiveEnabled: true,
            reason: 'BUSY',
            dueAt: SERVER_NOW + 200000,
            expiresAt: SERVER_NOW + 299000,
            charged: 1,
            confirmed: 1,
            needsReview: false,
            supported: true,
          },
          {
            id: 't-2',
            title: 'claude #2',
            phase: 'NEEDS_REVIEW',
            enabledOverride: false,
            effectiveEnabled: false,
            reason: 'PARTIAL_OR_UNKNOWN_SEND',
            dueAt: null,
            expiresAt: SERVER_NOW - 1000,
            charged: 3,
            confirmed: 2,
            needsReview: true,
            supported: true,
          },
          {
            id: 't-3',
            title: 'bash',
            phase: 'UNKNOWN',
            enabledOverride: null,
            effectiveEnabled: false,
            reason: 'UNSUPPORTED_AGENT',
            dueAt: null,
            expiresAt: null,
            charged: 0,
            confirmed: 0,
            needsReview: false,
            supported: false,
          },
        ],
      },
    ],
    diagnostics: [{ at: SERVER_NOW, level: 'info', event: 'runtime_connected' }],
  };
  return { ...base, ...overrides };
}

/* ------------------------------------------------------------------ */
/* formatRemaining                                                     */
/* ------------------------------------------------------------------ */

test('formatRemaining: boundaries', () => {
  assert.equal(formatRemaining(null), '\u2014');
  assert.equal(formatRemaining(undefined), '\u2014');
  assert.equal(formatRemaining(Number.NaN), '\u2014');
  assert.equal(formatRemaining(0), '만료됨');
  assert.equal(formatRemaining(-1), '만료됨');
  assert.equal(formatRemaining(59000), '0:59');
  assert.equal(formatRemaining(299000), '4:59');
  assert.equal(formatRemaining(300000), '5:00');
  assert.equal(formatRemaining(3482000), '58:02');
  assert.equal(formatRemaining(3600000), '60:00');
});

/* ------------------------------------------------------------------ */
/* reasonText                                                          */
/* ------------------------------------------------------------------ */

test('reasonText: every REASON_CODES value maps to a Korean sentence', () => {
  const codes = Object.keys(REASON_CODES);
  assert.equal(codes.length, 25, 'expected 25 reason codes in contracts');
  for (const code of codes) {
    const text = reasonText(code);
    assert.equal(typeof text, 'string', `${code} should map to a string`);
    assert.ok(text.length > 0, `${code} should not be empty`);
    assert.notEqual(text, code, `${code} should have a translated sentence`);
    assert.match(text, /[가-힣]/, `${code} should contain Hangul`);
    assert.ok(text.endsWith('.'), `${code} should end with a period`);
  }
});

test('reasonText: unknown and empty codes are handled safely', () => {
  assert.equal(reasonText('NOT_A_REAL_CODE'), 'NOT_A_REAL_CODE');
  assert.equal(reasonText(''), '');
  assert.equal(reasonText(null), '');
  assert.equal(reasonText(undefined), '');
  assert.equal(reasonText(42), '');
});

test('expiry cause: every allowed reason has separate past-tense Korean text', () => {
  assert.deepEqual(Object.keys(EXPIRE_CAUSE_TEXT).sort(), [...EXPIRE_CAUSE_REASONS].sort());
  for (const code of EXPIRE_CAUSE_REASONS) {
    assert.match(EXPIRE_CAUSE_TEXT[code], /[가-힣]/, code);
    assert.match(EXPIRE_CAUSE_TEXT[code], /못함$/, code);
  }
});

test('cache statuses: all user-facing states come from cacheStatus, including no reservation variants', () => {
  const now = new Date(2026, 8, 30, 12, 0).getTime();
  const future = now + 60_000;
  const base = { phase: 'ARMED', reason: 'NO_FRESH_TURN', expiresAt: future, expiredAt: null, expireCause: null };
  const cases = [
    ['working', '캐시 유지 중 · 작업 진행 중'],
    ['scheduled', `캐시 유지 중 · 만료 예정 ${formatCacheTime(future, now)}`],
    ['sending', '캐시 유지 중 · 유지 메시지 전송 중'],
    ['awaiting-turn', '캐시 유지 중 · 작업 시작 확인 중'],
    ['interactive-wait', '유지 중단 · 권한·입력 응답 대기'],
    ['suspended', `유지 중단 · ${reasonText('NO_FRESH_TURN')}`],
    ['review', '확인 필요 · 전송 결과를 확인하세요'],
  ];
  for (const [cacheStatus, expected] of cases) {
    assert.equal(cacheStatusDisplay({ ...base, cacheStatus }, now).text, expected, cacheStatus);
  }
  assert.equal(cacheStatusDisplay({ ...base, cacheStatus: 'expired', expiredAt: now, expireCause: 'DRAFT_PRESENT' }, now).text,
    `캐시 만료됨 · ${formatCacheTime(now, now)} · 입력창 초안이 감지되어 전송하지 못함`);
  assert.equal(cacheStatusDisplay({ ...base, cacheStatus: 'expired', expiredAt: now, expireCause: null }, now).text,
    `캐시 만료됨 · ${formatCacheTime(now, now)} · 전송 차단 사유 기록 없음`);
  assert.equal(cacheStatusDisplay({ ...base, cacheStatus: 'no-reservation' }, now).text,
    `예약 없음 · 안전 전송 시간이 지남 · 만료 예정 ${formatCacheTime(future, now)}`);
  assert.equal(cacheStatusDisplay({ ...base, cacheStatus: 'no-reservation', phase: 'UNKNOWN', expiresAt: null }, now).text,
    '예약 없음 · 플러그인 시작 후 아직 작업의 시작과 완료를 관측하지 못함');
  assert.equal(cacheStatusDisplay({ ...base, cacheStatus: 'no-reservation', expiresAt: null }, now).text,
    '예약 없음 · 다음 작업의 시작과 완료가 관측되면 예약합니다');
});

test('cache times: same day is compact; previous day includes date', () => {
  const now = new Date(2026, 8, 30, 1, 0).getTime();
  assert.equal(formatCacheTime(new Date(2026, 8, 30, 0, 59).getTime(), now), '00:59');
  assert.equal(formatCacheTime(new Date(2026, 8, 29, 23, 59).getTime(), now), '09/29 23:59');
});

test('toViewModel: cache fields pass through safely and missing fields become no reservation', () => {
  const snap = makeSnapshot();
  const first = snap.worktrees[0].terminals[0];
  first.cacheState = 'kept';
  first.cacheStatus = 'scheduled';
  first.indicatorOn = true;
  first.expiredAt = null;
  first.expireCause = 'DRAFT_PRESENT';
  first.blockedReason = 'DRAFT_PRESENT';
  const vm = toViewModel(snap, 0);
  assert.equal(vm.worktrees[0].terminals[0].cacheStatus, 'scheduled');
  assert.equal(vm.worktrees[0].terminals[0].indicatorOn, true);
  assert.equal(vm.worktrees[0].terminals[0].expireCause, 'DRAFT_PRESENT');
  assert.equal(vm.worktrees[0].terminals[2].cacheStatus, 'no-reservation');
  first.cacheStatus = 'not-a-status';
  first.expireCause = 'private arbitrary value';
  const invalid = toViewModel(snap, 0).worktrees[0].terminals[0];
  assert.equal(invalid.cacheStatus, 'no-reservation');
  assert.equal(invalid.expireCause, null);
});

/* ------------------------------------------------------------------ */
/* toViewModel                                                         */
/* ------------------------------------------------------------------ */

test('toViewModel: base snapshot flattens worktrees, terminals and timers', () => {
  const vm = toViewModel(makeSnapshot(), 0);
  assert.equal(vm.revision, 7);
  assert.equal(vm.paused, false);
  assert.equal(vm.pauseLabel, '일시정지');
  assert.equal(vm.connection.connected, true);
  assert.equal(vm.appTimer.known, true);
  assert.equal(vm.appTimer.ttlMs, 300000);
  assert.match(vm.appTimer.text, /켜짐/);
  assert.match(vm.appTimer.text, /5분/);
  assert.equal(vm.worktrees.length, 1);
  assert.equal(vm.worktrees[0].label, 'main');
  assert.equal(vm.worktrees[0].branch, '');
  assert.equal(vm.worktrees[0].terminals.length, 3);

  const t1 = vm.worktrees[0].terminals[0];
  assert.equal(t1.scopeValue, 'inherit');
  assert.equal(t1.remainingMs, 299000);
  assert.equal(t1.remainingText, '4:59');
  assert.equal(t1.dueInMs, 200000);
  assert.equal(t1.dueText, '3:20');
  assert.equal(t1.expired, false);
  assert.equal(t1.reasonText, reasonText('BUSY'));
  assert.equal(vm.maxConsecutiveText, '8');
});

test('toViewModel: 현재 TTL의 상한을 표시하고 active 값이 우선한다', () => {
  const snap = makeSnapshot();
  delete snap.config.maxConsecutiveKeepalivesActive;
  assert.equal(toViewModel(snap).maxConsecutiveText, '8');

  snap.appTimer.ttlMs = 3600000;
  assert.equal(toViewModel(snap).maxConsecutiveText, '3');

  snap.config.maxConsecutiveKeepalivesActive = 0;
  assert.equal(toViewModel(snap).maxConsecutiveText, '무제한');

  delete snap.config.maxConsecutiveKeepalivesActive;
  snap.appTimer.ttlMs = null;
  assert.equal(toViewModel(snap).maxConsecutiveText, '3');
  snap.config.maxConsecutiveKeepalives1h = 0;
  assert.equal(toViewModel(snap).maxConsecutiveText, '8', '0은 무제한이므로 유한한 상한을 선택');
  snap.config.maxConsecutiveKeepalives5m = 0;
  assert.equal(toViewModel(snap).maxConsecutiveText, '무제한');
});

test('toViewModel: worktree branch를 보조 텍스트로 전달', () => {
  const snap = makeSnapshot();
  snap.worktrees = [{ ...snap.worktrees[0], label: 'route-dashboard', branch: 'main' }];
  const vm = toViewModel(snap, 0);
  assert.equal(vm.worktrees[0].label, 'route-dashboard');
  assert.equal(vm.worktrees[0].branch, 'main');
});

test('toViewModel: branch가 없으면 빈 문자열', () => {
  const snap = makeSnapshot();
  snap.worktrees = [{ ...snap.worktrees[0] }];
  delete snap.worktrees[0].branch;
  const vm = toViewModel(snap, 0);
  assert.equal(vm.worktrees[0].branch, '');
});

test('toViewModel: 같은 projectId의 워크트리를 한 프로젝트로 묶고 순서를 유지한다', () => {
  const source = makeSnapshot().worktrees[0];
  const snap = makeSnapshot({ worktrees: [
    { ...source, id: 'a', label: 'main', projectId: 'repo-a', projectLabel: 'mtt-claude-plugins' },
    { ...source, id: 'b', label: 'other', projectId: 'repo-b', projectLabel: 'another' },
    { ...source, id: 'c', label: 'rusalka', projectId: 'repo-a', projectLabel: 'mtt-claude-plugins' },
  ] });
  const vm = toViewModel(snap, 0);
  assert.deepEqual(vm.worktrees.map((wt) => wt.id), ['a', 'b', 'c']);
  assert.deepEqual(vm.projects.map((project) => project.key), ['repo-a', 'repo-b']);
  assert.equal(vm.projects[0].label, 'mtt-claude-plugins');
  assert.deepEqual(vm.projects[0].worktrees.map((wt) => wt.id), ['a', 'c']);
  assert.strictEqual(vm.projects[0].worktrees[1], vm.worktrees[2]);
});

test('toViewModel: projectId가 없으면 projectLabel과 label로 묶는다', () => {
  const source = makeSnapshot().worktrees[0];
  const snap = makeSnapshot({ worktrees: [
    { ...source, id: 'a', label: 'main', projectId: null, projectLabel: 'repo' },
    { ...source, id: 'b', label: 'branch', projectLabel: 'repo' },
    { ...source, id: 'c', label: 'solo' },
    { ...source, id: 'd', label: 'solo', projectLabel: '' },
  ] });
  const vm = toViewModel(snap, 0);
  assert.deepEqual(vm.projects.map((project) => project.key), ['label:repo', 'label:solo']);
  assert.deepEqual(vm.projects.map((project) => project.worktrees.map((wt) => wt.id)),
    [['a', 'b'], ['c', 'd']]);
  assert.equal(vm.worktrees[2].projectId, null);
  assert.equal(vm.worktrees[2].projectLabel, 'solo');
});

test('toViewModel: 구버전 스냅숏도 label 기준 프로젝트를 만든다', () => {
  const vm = toViewModel(makeSnapshot(), 0);
  assert.equal(vm.worktrees[0].projectId, null);
  assert.equal(vm.worktrees[0].projectLabel, 'main');
  assert.deepEqual(vm.projects.map(({ key, label }) => ({ key, label })),
    [{ key: 'label:main', label: 'main' }]);
});

test('toViewModel: client elapsed time advances the countdown', () => {
  const vm = toViewModel(makeSnapshot(), 3000);
  const t1 = vm.worktrees[0].terminals[0];
  assert.equal(t1.remainingMs, 296000);
  assert.equal(t1.remainingText, '4:56');
  assert.equal(t1.dueInMs, 197000);
});

test('toViewModel: expired terminal is flagged and rendered as 만료됨', () => {
  const vm = toViewModel(makeSnapshot(), 0);
  const t2 = vm.worktrees[0].terminals[1];
  assert.equal(t2.expired, true);
  assert.equal(t2.remainingText, '만료됨');
  assert.equal(t2.dueText, '\u2014');
  assert.equal(t2.scopeValue, 'off');
});

test('toViewModel: needsReview and unsupported terminals are surfaced', () => {
  const vm = toViewModel(makeSnapshot(), 0);
  const t2 = vm.worktrees[0].terminals[1];
  const t3 = vm.worktrees[0].terminals[2];
  assert.equal(t2.needsReview, true);
  assert.equal(t2.charged, 3);
  assert.equal(t2.reasonText, reasonText('PARTIAL_OR_UNKNOWN_SEND'));
  assert.equal(t3.supported, false);
  assert.equal(t3.reasonText, reasonText('UNSUPPORTED_AGENT'));
  assert.equal(t3.expiresAt, null);
  assert.equal(t3.remainingText, '\u2014');
});

test('toViewModel: NO_AGENT 사유는 문구를 숨기되 reason 필드는 유지한다', () => {
  const snap = makeSnapshot();
  snap.worktrees[0].terminals.push({
    id: 't-4',
    title: 'bash',
    phase: 'UNKNOWN',
    enabledOverride: null,
    effectiveEnabled: false,
    reason: 'NO_AGENT',
    dueAt: null,
    expiresAt: null,
    charged: 0,
    confirmed: 0,
    needsReview: false,
    supported: false,
  });
  const vm = toViewModel(snap, 0);
  const t4 = vm.worktrees[0].terminals[3];
  assert.equal(t4.supported, false);
  assert.equal(t4.reason, 'NO_AGENT');
  assert.equal(t4.reasonText, '');
  // UNSUPPORTED_AGENT(예: codex)는 기존 문구를 그대로 유지한다.
  const t3 = vm.worktrees[0].terminals[2];
  assert.equal(t3.reasonText, reasonText('UNSUPPORTED_AGENT'));
});

test('toViewModel: paused snapshot reports resume label', () => {
  const snap = makeSnapshot();
  snap.config = { ...snap.config, paused: true };
  const vm = toViewModel(snap, 0);
  assert.equal(vm.paused, true);
  assert.equal(vm.pauseLabel, '재개');
});

test('toViewModel: unavailable connection is not connected', () => {
  const snap = makeSnapshot({
    connection: { state: 'unavailable', reason: 'RUNTIME_UNAVAILABLE' },
  });
  const vm = toViewModel(snap, 0);
  assert.equal(vm.connection.connected, false);
  assert.equal(vm.connection.text, '연결할 수 없음');
  assert.equal(vm.connection.reasonText, reasonText('RUNTIME_UNAVAILABLE'));
});

test('toViewModel: unknown app timer exposes the reason', () => {
  const snap = makeSnapshot({
    appTimer: { known: false, reason: 'SETTINGS_UNKNOWN', readAt: SERVER_NOW },
  });
  const vm = toViewModel(snap, 0);
  assert.equal(vm.appTimer.known, false);
  assert.match(vm.appTimer.text, /알 수 없음/);
  assert.match(vm.appTimer.text, /설정을 읽지 못했습니다/);
});

test('toViewModel: diagnostics keep only the most recent 20 entries', () => {
  const diagnostics = Array.from({ length: 25 }, (_, i) => ({
    at: SERVER_NOW + i,
    level: 'info',
    event: `event_${i}`,
  }));
  const vm = toViewModel(makeSnapshot({ diagnostics }), 0);
  assert.equal(vm.diagnostics.length, 20);
  assert.equal(vm.diagnostics[0].event, 'event_5');
  assert.equal(vm.diagnostics[19].event, 'event_24');
});

test('toViewModel: diagnostics show target labels, hash fallback, and no-target state', () => {
  const diagnostics = [
    { at: SERVER_NOW, level: 'info', event: 'epoch_armed', target: 'abcdef123456', targetLabel: 'main / Claude' },
    { at: SERVER_NOW, level: 'warn', event: 'target_reset', target: '123456abcdef', targetLabel: null, code: 'pty_changed' },
    { at: SERVER_NOW, level: 'error', event: 'event_unresolved', code: 'no_target' },
  ];
  const { diagnostics: rows } = toViewModel(makeSnapshot({ diagnostics }), 0);
  assert.equal(rows[0].targetText, 'main / Claude');
  assert.equal(rows[0].eventText, '캐시 만료 전 keepalive 예약');
  assert.equal(rows[1].targetText, '#123456');
  assert.equal(rows[1].eventText, '터미널 식별 정보가 바뀌어 상태 초기화');
  assert.equal(rows[1].code, 'pty_changed');
  assert.equal(rows[2].targetText, null);
  assert.equal(rows[2].eventText, '상태 이벤트를 터미널과 연결하지 못함');
});

test('toViewModel: new and unknown diagnostic events remain understandable', () => {
  const diagnostics = [
    { event: 'first_done_ignored', code: 'NO_FRESH_TURN' },
    { event: 'epoch_restored' },
    { event: 'future_event' },
  ];
  const { diagnostics: rows } = toViewModel(makeSnapshot({ diagnostics }), 0);
  assert.equal(rows[0].eventText, '작업 시작을 보지 못해 이번 완료는 예약하지 않음');
  assert.equal(rows[0].code, 'NO_FRESH_TURN');
  assert.equal(rows[1].eventText, '리로드 전 예약을 복원');
  assert.equal(rows[2].eventText, 'future_event');
});

test('diagnostic event descriptions cover the contract and new events', () => {
  for (const event of [
    ...DIAGNOSTIC_EVENTS,
    'event_unresolved', 'target_reset', 'first_done_ignored', 'epoch_restored',
  ]) {
    assert.ok(DIAGNOSTIC_EVENT_TEXT[event], `missing description: ${event}`);
  }
});

test('toViewModel: tolerates an empty/garbage snapshot without throwing', () => {
  const vm = toViewModel({}, 0);
  assert.equal(vm.worktrees.length, 0);
  assert.deepEqual(vm.projects, []);
  assert.equal(vm.paused, false);
  assert.equal(vm.connection.connected, false);
});

/* ------------------------------------------------------------------ */
/* worktree 상속(null) 표시                                            */
/* ------------------------------------------------------------------ */

function makeWorktreeSnapshot(enabled, defaultWorktreeEnabled) {
  const snap = makeSnapshot();
  snap.config = { ...snap.config, defaultWorktreeEnabled };
  snap.worktrees = [{ ...snap.worktrees[0], enabled }];
  return snap;
}

test('toViewModel: worktree override null is preserved as inherited', () => {
  const vm = toViewModel(makeWorktreeSnapshot(null, true), 0);
  const wt = vm.worktrees[0];
  assert.equal(wt.enabled, null);
  assert.equal(wt.inherited, true);
  assert.equal(wt.scopeOn, true);
});

test('toViewModel: inherited worktree follows defaultWorktreeEnabled false', () => {
  const vm = toViewModel(makeWorktreeSnapshot(null, false), 0);
  const wt = vm.worktrees[0];
  assert.equal(wt.enabled, null);
  assert.equal(wt.inherited, true);
  assert.equal(wt.scopeOn, false);
});

test('toViewModel: explicit worktree override wins over the default', () => {
  const on = toViewModel(makeWorktreeSnapshot(true, false), 0).worktrees[0];
  assert.equal(on.enabled, true);
  assert.equal(on.inherited, false);
  assert.equal(on.scopeOn, true);

  const off = toViewModel(makeWorktreeSnapshot(false, true), 0).worktrees[0];
  assert.equal(off.enabled, false);
  assert.equal(off.inherited, false);
  assert.equal(off.scopeOn, false);
});

test('toViewModel: missing defaultWorktreeEnabled does not assume on', () => {
  const snap = makeSnapshot();
  snap.config = { paused: false };
  snap.worktrees = [{ ...snap.worktrees[0], enabled: null }];
  const wt = toViewModel(snap, 0).worktrees[0];
  assert.equal(wt.inherited, true);
  assert.equal(wt.scopeOn, false);
});

test('toViewModel: inherited + default on toggles to explicit off', () => {
  const vm = toViewModel(makeWorktreeSnapshot(null, true), 0);
  const wt = vm.worktrees[0];
  // render가 만드는 액션과 동일한 계산: enabled = !scopeOn.
  assert.deepEqual(
    buildAction('worktree', { targetId: wt.id, enabled: !wt.scopeOn }, vm.revision),
    { type: 'worktree', targetId: 'wt-1', enabled: false, expectedRevision: 7 },
  );
});

test('worktreeToggleLabel: explicit on/off vs inherited labels', () => {
  assert.equal(worktreeToggleLabel({ inherited: false, scopeOn: true }), '● 켜짐');
  assert.equal(worktreeToggleLabel({ inherited: false, scopeOn: false }), '○ 꺼짐');
  assert.equal(worktreeToggleLabel({ inherited: true, scopeOn: true }), '● 켜짐 (기본)');
  assert.equal(worktreeToggleLabel({ inherited: true, scopeOn: false }), '○ 꺼짐 (기본)');
  assert.equal(worktreeToggleLabel({}), '○ 꺼짐');
});

/* ------------------------------------------------------------------ */
/* buildAction                                                         */
/* ------------------------------------------------------------------ */

test('buildAction: every action type carries expectedRevision', () => {
  const rev = 42;

  assert.deepEqual(buildAction('pause', { paused: true }, rev), {
    type: 'pause',
    paused: true,
    expectedRevision: rev,
  });

  assert.deepEqual(buildAction('worktree', { targetId: 'wt-1', enabled: false }, rev), {
    type: 'worktree',
    targetId: 'wt-1',
    enabled: false,
    expectedRevision: rev,
  });

  assert.deepEqual(buildAction('terminal', { targetId: 't-1', enabled: null }, rev), {
    type: 'terminal',
    targetId: 't-1',
    enabled: null,
    expectedRevision: rev,
  });
  assert.deepEqual(buildAction('terminal', { targetId: 't-1', enabled: true }, rev).enabled, true);
  assert.deepEqual(buildAction('terminal', { targetId: 't-1', enabled: false }, rev).enabled, false);

  assert.deepEqual(buildAction('config', { patch: { paused: false } }, rev), {
    type: 'config',
    patch: { paused: false },
    expectedRevision: rev,
  });

  assert.deepEqual(buildAction('reset-budget', { targetId: 't-2' }, rev), {
    type: 'reset-budget',
    targetId: 't-2',
    expectedRevision: rev,
  });

  assert.deepEqual(buildAction('clear-review', { targetId: 't-2' }, rev), {
    type: 'clear-review',
    targetId: 't-2',
    expectedRevision: rev,
  });
});

test('buildAction: unknown kind throws', () => {
  assert.throws(() => buildAction('nope', {}, 1), /unknown action kind/);
});

test('buildAction worktree: null은 상속(null)으로 보존한다', () => {
  assert.deepEqual(buildAction('worktree', { targetId: 'w', enabled: null }, 3), {
    type: 'worktree',
    targetId: 'w',
    enabled: null,
    expectedRevision: 3,
  });
});

test('buildAction worktree: true/false는 그대로, undefined는 false로 뭉갠다', () => {
  assert.equal(buildAction('worktree', { targetId: 'w', enabled: true }, 3).enabled, true);
  assert.equal(buildAction('worktree', { targetId: 'w', enabled: false }, 3).enabled, false);
  assert.equal(buildAction('worktree', { targetId: 'w' }, 3).enabled, false);
  assert.equal(buildAction('worktree', { targetId: 'w', enabled: undefined }, 3).enabled, false);
});

/* ------------------------------------------------------------------ */
/* parseTokenFromHash                                                  */
/* ------------------------------------------------------------------ */

test('parseTokenFromHash: reads only the token fragment', () => {
  assert.equal(parseTokenFromHash('#token=abc'), 'abc');
  assert.equal(parseTokenFromHash('#token=a.b-c_d~e'), 'a.b-c_d~e');
  assert.equal(parseTokenFromHash('token=abc'), 'abc');
  assert.equal(parseTokenFromHash('#x=1'), null);
  assert.equal(parseTokenFromHash('#token='), null);
  assert.equal(parseTokenFromHash(''), null);
  assert.equal(parseTokenFromHash('#'), null);
  assert.equal(parseTokenFromHash(undefined), null);
  assert.equal(parseTokenFromHash(null), null);
});

/* ------------------------------------------------------------------ */
/* Static asset rules                                                  */
/* ------------------------------------------------------------------ */

const indexHtml = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../ui/app.mjs', import.meta.url), 'utf8');

test('index.html: external module script and stylesheet only', () => {
  assert.match(indexHtml, /<script\b[^>]*\bsrc="\/app\.mjs"[^>]*><\/script>/);
  assert.match(indexHtml, /<link\b[^>]*\bhref="\/style\.css"/);
});

test('index.html: no inline script body', () => {
  // Every <script> tag must carry a src; a src-less tag is an inline body.
  assert.doesNotMatch(indexHtml, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(indexHtml, /<style\b/i);
});

test('index.html: no style attributes', () => {
  assert.doesNotMatch(indexHtml, /\sstyle\s*=/i);
});

test('index.html: no inline event handler (on*) attributes', () => {
  assert.doesNotMatch(indexHtml, /\son[a-z]+\s*=/i);
});

test('index.html: tab title indicator has a checkbox, visible label, and linked description', () => {
  const input = indexHtml.match(/<input\b[^>]*\bid="cfg-tab-title-indicator"[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /\bname="tabTitleIndicator"/);
  assert.match(input, /\btype="checkbox"/);
  assert.match(input, /\baria-describedby="cfg-tab-title-indicator-description"/);
  assert.match(
    indexHtml,
    /<label\s+for="cfg-tab-title-indicator">탭 이름에 캐시 상태 표시<\/label>/,
  );
  const description = indexHtml.match(
    /<p\s+id="cfg-tab-title-indicator-description"[^>]*>([\s\S]*?)<\/p>/,
  )?.[1].trim();
  assert.equal(
    description,
    '⚡ 유지 중 · 💤 유지 중인 캐시 없음 · ⚠️ 확인 필요. Claude 탭 이름 앞에 상태를 표시합니다. 같은 기호가 유지되면 제목을 다시 쓰지 않습니다. 끄면 Orca 자동 이름으로 돌아갑니다. 직접 붙인 탭 이름은 유지되지 않을 수 있습니다.',
  );
});

test('config form: TTL별 상한 입력과 도움말이 연결되고 레거시 입력은 없다', () => {
  for (const [ttl, name] of [['5m', 'maxConsecutiveKeepalives5m'], ['1h', 'maxConsecutiveKeepalives1h']]) {
    const id = `cfg-max-consecutive-${ttl}`;
    const input = indexHtml.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${ttl} input`);
    assert.match(input, new RegExp(`\\bname="${name}"`));
    assert.match(input, /\bmax="1000"/);
    assert.match(input, new RegExp(`\\baria-describedby="${id}-description"`));
    assert.match(indexHtml, new RegExp(`<label for="${id}">연속 keepalive 상한`));
    assert.match(indexHtml, new RegExp(`<p id="${id}-description"`));
  }
  assert.doesNotMatch(indexHtml, /\bname="maxConsecutiveKeepalives"/);
});

test('config form: missing, true, and false snapshots render; Save sends changed checkbox value', async () => {
  const globals = Object.fromEntries(
    ['document', 'window', 'sessionStorage', 'fetch'].map((key) => [key, globalThis[key]]),
  );
  const nodes = new Map();
  const intervals = [];
  const actions = [];
  let state = makeSnapshot({ worktrees: [], diagnostics: [] });

  function makeNode() {
    return {
      checked: false,
      value: '',
      disabled: false,
      textContent: '',
      children: [],
      listeners: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      appendChild(child) { this.children.push(child); return child; },
    };
  }

  try {
    globalThis.document = {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeNode());
        return nodes.get(id);
      },
      createElement: makeNode,
    };
    globalThis.window = {
      location: { hash: '', pathname: '/', search: '' },
      setInterval(callback) { intervals.push(callback); },
    };
    globalThis.sessionStorage = { getItem: () => 'test-token' };
    globalThis.fetch = async (url, options = {}) => {
      if (url === '/api/action') {
        const action = JSON.parse(options.body);
        actions.push(action);
        state = { ...state, config: { ...state.config, ...action.patch } };
      }
      return { ok: true, status: 200, json: async () => state };
    };

    await import('../ui/app.mjs?tab-title-indicator-dom-test');
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();

    const checkbox = nodes.get('cfg-tab-title-indicator');
    const limit5m = nodes.get('cfg-max-consecutive-5m');
    const limit1h = nodes.get('cfg-max-consecutive-1h');
    const form = nodes.get('config-form');
    assert.equal(checkbox.checked, false, 'missing field defaults to off');
    assert.equal(limit5m.value, '8');
    assert.equal(limit1h.value, '3');

    state = { ...state, config: { ...state.config, tabTitleIndicator: true } };
    intervals[0]();
    await settle();
    assert.equal(checkbox.checked, true);

    state = { ...state, config: { ...state.config, tabTitleIndicator: false } };
    intervals[0]();
    await settle();
    assert.equal(checkbox.checked, false);

    checkbox.checked = true;
    limit5m.value = '1001';
    form.listeners.get('submit')({ preventDefault() {} });
    assert.equal(actions.length, 0, '범위 밖 상한은 제출하지 않음');
    limit5m.value = '6';
    limit1h.value = '2';
    form.listeners.get('change')();
    let prevented = false;
    form.listeners.get('submit')({ preventDefault() { prevented = true; } });
    await settle();
    assert.equal(prevented, true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'config');
    assert.equal(actions[0].expectedRevision, 7);
    assert.equal(actions[0].patch.tabTitleIndicator, true);
    assert.equal(actions[0].patch.maxConsecutiveKeepalives5m, 6);
    assert.equal(actions[0].patch.maxConsecutiveKeepalives1h, 2);
    assert.equal(Object.hasOwn(actions[0].patch, 'maxConsecutiveKeepalives'), false);
  } finally {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('renderTerminal: NO_AGENT는 이유/읽기 전용 표시를 생략하고 UNSUPPORTED_AGENT는 유지한다', async () => {
  const globals = Object.fromEntries(
    ['document', 'window', 'sessionStorage', 'fetch'].map((key) => [key, globalThis[key]]),
  );
  const nodes = new Map();
  const intervals = [];
  const terminals = [
    {
      id: 't-noagent',
      title: 'bash',
      phase: 'UNKNOWN',
      enabledOverride: null,
      effectiveEnabled: false,
      reason: 'NO_AGENT',
      unsupportedReason: 'NO_AGENT',
      dueAt: null,
      expiresAt: null,
      charged: 0,
      confirmed: 0,
      needsReview: false,
      supported: false,
    },
    {
      id: 't-codex',
      title: 'codex',
      phase: 'UNKNOWN',
      enabledOverride: null,
      effectiveEnabled: false,
      reason: 'UNSUPPORTED_AGENT',
      unsupportedReason: 'UNSUPPORTED_AGENT',
      dueAt: null,
      expiresAt: null,
      charged: 0,
      confirmed: 0,
      needsReview: false,
      supported: false,
    },
  ];
  for (const cacheStatus of ['working', 'scheduled', 'sending', 'awaiting-turn', 'expired', 'no-reservation', 'interactive-wait', 'suspended', 'review']) {
    terminals.push({
      id: `t-${cacheStatus}`, title: cacheStatus, phase: 'UNKNOWN',
      cacheState: cacheStatus === 'review' ? 'review' : 'none', cacheStatus,
      enabledOverride: null, effectiveEnabled: true, reason: 'GLOBAL_PAUSED',
      dueAt: null, expiresAt: cacheStatus === 'no-reservation' ? null : SERVER_NOW + 60_000,
      expiredAt: cacheStatus === 'expired' ? SERVER_NOW - 60_000 : null,
      expireCause: cacheStatus === 'expired' ? 'DRAFT_PRESENT' : null,
      charged: 0, confirmed: 0, needsReview: false, supported: true,
    });
  }
  const worktree = { ...makeSnapshot().worktrees[0], terminals };
  const state = makeSnapshot({ worktrees: [worktree], diagnostics: [] });

  function makeNode() {
    return {
      checked: false,
      value: '',
      disabled: false,
      textContent: '',
      children: [],
      listeners: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      appendChild(child) { this.children.push(child); return child; },
    };
  }

  const classTokens = (node) =>
    typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean) : [];
  const findAllByClass = (root, className) => {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (classTokens(node).includes(className)) found.push(node);
      for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
    };
    walk(root);
    return found;
  };

  try {
    globalThis.document = {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeNode());
        return nodes.get(id);
      },
      createElement: makeNode,
      querySelectorAll: () => [],
    };
    globalThis.window = {
      location: { hash: '', pathname: '/', search: '' },
      setInterval(callback) { intervals.push(callback); },
    };
    globalThis.sessionStorage = { getItem: () => 'test-token' };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => state });

    await import('../ui/app.mjs?terminal-reason-dom-test');
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();

    const rows = findAllByClass(nodes.get('worktrees'), 'terminal');
    assert.equal(rows.length, terminals.length, '모든 캐시 상태 행이 렌더링되어야 한다');

    const titleOf = (row) => findAllByClass(row, 'terminal-title')[0]?.textContent;
    const noAgentRow = rows.find((row) => titleOf(row) === 'bash');
    const codexRow = rows.find((row) => titleOf(row) === 'codex');
    assert.ok(noAgentRow, 'NO_AGENT 행을 찾아야 한다');
    assert.ok(codexRow, 'UNSUPPORTED_AGENT 행을 찾아야 한다');

    // NO_AGENT: 이유 문구와 '읽기 전용 · 미지원' 표시가 모두 없어야 한다.
    assert.equal(findAllByClass(noAgentRow, 'terminal-reason').length, 0);
    assert.equal(findAllByClass(noAgentRow, 'readonly-note').length, 0);

    // UNSUPPORTED_AGENT(codex 등): 둘 다 있고 문구가 그대로여야 한다.
    const reasonNode = findAllByClass(codexRow, 'terminal-reason');
    const readonlyNode = findAllByClass(codexRow, 'readonly-note');
    assert.equal(reasonNode.length, 1);
    assert.equal(readonlyNode.length, 1);
    assert.equal(readonlyNode[0].textContent, '읽기 전용 · 미지원');
    assert.equal(reasonNode[0].textContent, '이 터미널의 에이전트는 지원하지 않습니다.');
    for (const source of terminals.slice(2)) {
      const row = rows.find((candidate) => titleOf(candidate) === source.title);
      assert.ok(row, source.cacheStatus);
      const vmTerminal = toViewModel(state, 0).worktrees[0].terminals.find((item) => item.id === source.id);
      assert.equal(findAllByClass(row, 'terminal-cache-text')[0]?.textContent,
        cacheStatusDisplay(vmTerminal, SERVER_NOW).text, source.cacheStatus);
    }
    for (const row of rows) {
      assert.equal(findAllByClass(row, 'badge-phase').length, 0, '내부 phase 배지는 표시하지 않음');
      assert.equal(findAllByClass(row, 'badge-cache').length, 1);
      assert.match(findAllByClass(row, 'terminal-applied')[0]?.textContent ?? '', /^유지 설정 (켜짐|꺼짐)$/);
    }
  } finally {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('app.mjs: never uses innerHTML', () => {
  assert.doesNotMatch(appSource, /innerHTML/);
});
