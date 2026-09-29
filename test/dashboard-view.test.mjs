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

import { REASON_CODES } from '../src/contracts.mjs';
import {
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
      maxConsecutiveKeepalives: 3,
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
  assert.equal(codes.length, 23, 'expected 23 reason codes in contracts');
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
  assert.equal(vm.worktrees[0].terminals.length, 3);

  const t1 = vm.worktrees[0].terminals[0];
  assert.equal(t1.scopeValue, 'inherit');
  assert.equal(t1.remainingMs, 299000);
  assert.equal(t1.remainingText, '4:59');
  assert.equal(t1.dueInMs, 200000);
  assert.equal(t1.dueText, '3:20');
  assert.equal(t1.expired, false);
  assert.equal(t1.reasonText, reasonText('BUSY'));
  assert.equal(vm.maxConsecutiveText, '3');
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

test('toViewModel: tolerates an empty/garbage snapshot without throwing', () => {
  const vm = toViewModel({}, 0);
  assert.equal(vm.worktrees.length, 0);
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

test('app.mjs: never uses innerHTML', () => {
  assert.doesNotMatch(appSource, /innerHTML/);
});
