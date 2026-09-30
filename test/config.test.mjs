import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  ValidationError,
  parseConfig,
  parseConfigPatch,
} from '../src/config.mjs';
import * as contracts from '../src/contracts.mjs';

/**
 * fn이 ValidationError(code, field)를 던지는지 검증한다.
 * @param {() => unknown} fn
 * @param {string} code
 * @param {string} [field]
 */
function assertValidation(fn, code, field) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof ValidationError, `expected ValidationError, got ${error}`);
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
      if (field !== undefined) {
        assert.equal(error.field, field, `expected field ${field}, got ${error.field}`);
      }
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// 기본값 round-trip
// ---------------------------------------------------------------------------

test('DEFAULT_CONFIG는 frozen이다', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.equal(DEFAULT_CONFIG.schemaVersion, 1);
});

test('DEFAULT_CONFIG는 JSON round-trip 후 parseConfig와 동일하다', () => {
  const roundTripped = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  assert.deepEqual(parseConfig(roundTripped), DEFAULT_CONFIG);
});

test('빈 객체는 모든 기본값으로 채워진다', () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
});

test('parseConfig는 새 객체를 반환한다(원본 비변경)', () => {
  const input = { paused: true };
  const result = parseConfig(input);
  assert.equal(result.paused, true);
  assert.deepEqual(input, { paused: true });
  assert.notEqual(result, input);
});

test('알 수 없는 최상위 key를 거절한다', () => {
  assertValidation(() => parseConfig({ bogus: 1 }), 'unknown_field', 'bogus');
});

test('plain object가 아니면 거절한다', () => {
  assertValidation(() => parseConfig(null), 'invalid_type');
  assertValidation(() => parseConfig([]), 'invalid_type');
  assertValidation(() => parseConfig('x'), 'invalid_type');
  assertValidation(() => parseConfig(42), 'invalid_type');
});

test('prototype pollution key를 거절한다', () => {
  assertValidation(() => parseConfig(JSON.parse('{"__proto__":{"polluted":true}}')), 'unknown_field', '__proto__');
  assertValidation(() => parseConfig(JSON.parse('{"constructor":{"x":1}}')), 'unknown_field', 'constructor');
  assertValidation(() => parseConfig({ prototype: {} }), 'unknown_field', 'prototype');
  assert.equal({}.polluted, undefined);
});

// ---------------------------------------------------------------------------
// schemaVersion
// ---------------------------------------------------------------------------

test('schemaVersion 1만 허용한다', () => {
  assert.equal(parseConfig({ schemaVersion: 1 }).schemaVersion, 1);
  assertValidation(() => parseConfig({ schemaVersion: 2 }), 'unsupported_schema', 'schemaVersion');
  assertValidation(() => parseConfig({ schemaVersion: '1' }), 'unsupported_schema', 'schemaVersion');
  assertValidation(() => parseConfig({ schemaVersion: 0 }), 'unsupported_schema', 'schemaVersion');
});

// ---------------------------------------------------------------------------
// runtimeUserDataPath
// ---------------------------------------------------------------------------

test('runtimeUserDataPath: null/POSIX/Windows 절대경로 허용', () => {
  assert.equal(parseConfig({ runtimeUserDataPath: null }).runtimeUserDataPath, null);
  assert.equal(parseConfig({ runtimeUserDataPath: '/tmp/orca' }).runtimeUserDataPath, '/tmp/orca');
  assert.equal(
    parseConfig({ runtimeUserDataPath: 'C:\\Users\\me\\AppData\\Roaming\\orca' }).runtimeUserDataPath,
    'C:\\Users\\me\\AppData\\Roaming\\orca',
  );
});

test('runtimeUserDataPath: 상대경로/비문자열/NUL/과길이 거절', () => {
  assertValidation(() => parseConfig({ runtimeUserDataPath: 'relative/path' }), 'out_of_range', 'runtimeUserDataPath');
  assertValidation(() => parseConfig({ runtimeUserDataPath: 7 }), 'invalid_type', 'runtimeUserDataPath');
  assertValidation(() => parseConfig({ runtimeUserDataPath: '/tmp/\u0000x' }), 'out_of_range', 'runtimeUserDataPath');
  const tooLong = `/${'a'.repeat(4096)}`; // 4097 chars
  assertValidation(() => parseConfig({ runtimeUserDataPath: tooLong }), 'out_of_range', 'runtimeUserDataPath');
  const atLimit = `/${'a'.repeat(4095)}`; // 4096 chars
  assert.equal(parseConfig({ runtimeUserDataPath: atLimit }).runtimeUserDataPath, atLimit);
});

// ---------------------------------------------------------------------------
// boolean 필드
// ---------------------------------------------------------------------------

for (const field of ['paused', 'defaultWorktreeEnabled', 'respectCwarmDisabled', 'tabTitleIndicator']) {
  test(`${field}: boolean만 허용`, () => {
    assert.equal(parseConfig({ [field]: true })[field], true);
    assert.equal(parseConfig({ [field]: false })[field], false);
    assertValidation(() => parseConfig({ [field]: 'true' }), 'invalid_type', field);
    assertValidation(() => parseConfig({ [field]: 1 }), 'invalid_type', field);
  });
}

test('tabTitleIndicator: 기본값은 false(실험 옵션)', () => {
  assert.equal(DEFAULT_CONFIG.tabTitleIndicator, false);
  assert.equal(parseConfig({}).tabTitleIndicator, false);
  assert.equal(parseConfig({ tabTitleIndicator: true }).tabTitleIndicator, true);
  assert.equal(parseConfig({ tabTitleIndicator: false }).tabTitleIndicator, false);
});

test('patch: tabTitleIndicator를 patch할 수 있다', () => {
  const merged = parseConfigPatch({ tabTitleIndicator: true }, DEFAULT_CONFIG);
  assert.equal(merged.tabTitleIndicator, true);
  assert.equal(DEFAULT_CONFIG.tabTitleIndicator, false, 'patch는 원본을 변경하지 않는다');
  assertValidation(() => parseConfigPatch({ tabTitleIndicator: 'yes' }, DEFAULT_CONFIG), 'invalid_type', 'tabTitleIndicator');
  assertValidation(() => parseConfigPatch({ tabTitleIndicator: 1 }, DEFAULT_CONFIG), 'invalid_type', 'tabTitleIndicator');
});

// ---------------------------------------------------------------------------
// 정수 경계값
// ---------------------------------------------------------------------------

const integerCases = [
  ['margin5mMs', 30000, 120000],
  ['margin1hMs', 60000, 600000],
  ['quietOutputMs', 2500, 60000],
  ['observedInputQuietMs', 10000, 300000],
  ['maxConsecutiveKeepalives', 0, 1000],
];

for (const [field, min, max] of integerCases) {
  test(`${field}: 경계값 ${min}..${max} 허용, 밖은 거절`, () => {
    assert.equal(parseConfig({ [field]: min })[field], min);
    assert.equal(parseConfig({ [field]: max })[field], max);
    assertValidation(() => parseConfig({ [field]: min - 1 }), 'out_of_range', field);
    assertValidation(() => parseConfig({ [field]: max + 1 }), 'out_of_range', field);
  });

  test(`${field}: 비정수/비숫자 거절`, () => {
    assertValidation(() => parseConfig({ [field]: min + 0.5 }), 'invalid_type', field);
    assertValidation(() => parseConfig({ [field]: Number.NaN }), 'invalid_type', field);
    assertValidation(() => parseConfig({ [field]: Infinity }), 'invalid_type', field);
    assertValidation(() => parseConfig({ [field]: String(min) }), 'invalid_type', field);
    assertValidation(() => parseConfig({ [field]: null }), 'invalid_type', field);
  });
}

// ---------------------------------------------------------------------------
// logLevel
// ---------------------------------------------------------------------------

test('logLevel: 허용 enum만', () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(parseConfig({ logLevel: level }).logLevel, level);
  }
  assertValidation(() => parseConfig({ logLevel: 'verbose' }), 'out_of_range', 'logLevel');
  assertValidation(() => parseConfig({ logLevel: 5 }), 'invalid_type', 'logLevel');
});

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

test('message: 유효 문자열을 trim해 저장한다', () => {
  assert.equal(parseConfig({ message: '  hello  ' }).message, 'hello');
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  base.message = DEFAULT_CONFIG.message;
  assert.equal(parseConfig(base).message, DEFAULT_CONFIG.message);
});

test('message: 빈문자열/공백만 거절', () => {
  assertValidation(() => parseConfig({ message: '' }), 'invalid_message', 'message');
  assertValidation(() => parseConfig({ message: '   ' }), 'invalid_message', 'message');
});

test('message: 개행/제어문자 거절', () => {
  assertValidation(() => parseConfig({ message: 'line1\nline2' }), 'invalid_message', 'message');
  assertValidation(() => parseConfig({ message: 'line1\rline2' }), 'invalid_message', 'message');
  assertValidation(() => parseConfig({ message: 'bell\u0007' }), 'invalid_message', 'message');
  assertValidation(() => parseConfig({ message: 'del\u007F' }), 'invalid_message', 'message');
  assertValidation(() => parseConfig({ message: 'nul\u0000' }), 'invalid_message', 'message');
});

test('message: UTF-8 512 bytes 허용, 513 bytes 거절', () => {
  const atLimit = `${'가'.repeat(170)}ab`; // 510 + 2 = 512 bytes
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 512);
  assert.equal(parseConfig({ message: atLimit }).message, atLimit);

  const overByOne = '가'.repeat(171); // 513 bytes
  assert.equal(Buffer.byteLength(overByOne, 'utf8'), 513);
  assertValidation(() => parseConfig({ message: overByOne }), 'invalid_message', 'message');

  assertValidation(() => parseConfig({ message: 'a'.repeat(513) }), 'invalid_message', 'message');
});

// ---------------------------------------------------------------------------
// parseConfigPatch
// ---------------------------------------------------------------------------

test('patch: 일부 key만 병합하고 원본/입력은 불변', () => {
  const current = parseConfig({});
  const patch = { paused: true, margin5mMs: 45000 };
  const merged = parseConfigPatch(patch, current);

  assert.equal(merged.paused, true);
  assert.equal(merged.margin5mMs, 45000);
  assert.equal(merged.message, DEFAULT_CONFIG.message);
  assert.equal(merged.schemaVersion, 1);
  // 원본/입력 불변
  assert.equal(current.paused, false);
  assert.equal(DEFAULT_CONFIG.paused, false);
  assert.deepEqual(patch, { paused: true, margin5mMs: 45000 });
  assert.notEqual(merged, current);
});

test('patch: unknown key 거절', () => {
  assertValidation(() => parseConfigPatch({ bogus: 1 }, DEFAULT_CONFIG), 'unknown_field', 'bogus');
});

test('patch: schemaVersion은 1로 변경 불가', () => {
  assert.equal(parseConfigPatch({ schemaVersion: 1 }, DEFAULT_CONFIG).schemaVersion, 1);
  assertValidation(() => parseConfigPatch({ schemaVersion: 2 }, DEFAULT_CONFIG), 'unsupported_schema', 'schemaVersion');
});

test('patch: 필드가 잘못되면 거절', () => {
  assertValidation(() => parseConfigPatch({ margin5mMs: 1 }, DEFAULT_CONFIG), 'out_of_range', 'margin5mMs');
  assertValidation(() => parseConfigPatch({ message: 'x\ny' }, DEFAULT_CONFIG), 'invalid_message', 'message');
  assertValidation(() => parseConfigPatch({ paused: 'yes' }, DEFAULT_CONFIG), 'invalid_type', 'paused');
});

test('patch: prototype pollution key 거절', () => {
  assertValidation(
    () => parseConfigPatch(JSON.parse('{"__proto__":{"x":1}}'), DEFAULT_CONFIG),
    'unknown_field',
    '__proto__',
  );
});

// ---------------------------------------------------------------------------
// contracts 상수
// ---------------------------------------------------------------------------

const frozenConstants = [
  'REASON_CODES',
  'DIAGNOSTIC_EVENTS',
  'TARGET_PHASES',
  'MACHINE_INPUT_TYPES',
  'DECISION_KINDS',
  'HOOK_STATES',
  'ACTION_TYPES',
  'TIMING',
  'ALLOWED_TTLS',
  'STATE_LIMITS',
  'PUBLIC_SNAPSHOT_FORBIDDEN_KEYS',
];

test('contracts 상수는 모두 frozen이다', () => {
  for (const name of frozenConstants) {
    assert.ok(name in contracts, `${name}이 export되지 않았다`);
    assert.ok(Object.isFrozen(contracts[name]), `${name}이 frozen이 아니다`);
  }
});

test('REASON_CODES는 24개이며 값이 key와 같다', () => {
  const codes = Object.keys(contracts.REASON_CODES);
  assert.equal(codes.length, 24);
  for (const code of codes) {
    assert.equal(contracts.REASON_CODES[code], code);
  }
  const expected = [
    'APP_TIMER_OFF',
    'SETTINGS_UNKNOWN',
    'RUNTIME_UNAVAILABLE',
    'WRONG_RUNTIME',
    'NO_FRESH_TURN',
    'UNSUPPORTED_AGENT',
    'UNSUPPORTED_HOST',
    'NOT_CONNECTED',
    'BUSY',
    'INTERACTIVE_WAIT',
    'UNKNOWN_WAIT',
    'OUTPUT_ACTIVE',
    'DRAFT_PRESENT',
    'SCREEN_UNKNOWN',
    'INPUT_QUIET_WINDOW',
    'SCOPE_DISABLED',
    'GLOBAL_PAUSED',
    'CWARM_DISABLED',
    'LIMIT_REACHED',
    'EXPIRED',
    'STALE_TARGET',
    'STORAGE_FAILED',
    'PARTIAL_OR_UNKNOWN_SEND',
    'CATALOG_INCOMPLETE',
  ];
  assert.deepEqual(codes.sort(), [...expected].sort());
});

test('contracts enum 목록이 기대값과 일치한다', () => {
  assert.deepEqual(contracts.TARGET_PHASES, [
    'UNKNOWN',
    'BUSY',
    'ARMED',
    'CHECKING',
    'PASTING',
    'SUBMITTING',
    'AWAITING_TURN',
    'SUSPENDED',
    'NEEDS_REVIEW',
    'EXPIRED',
  ]);
  assert.deepEqual(contracts.MACHINE_INPUT_TYPES, [
    'HOOK',
    'POLICY_INVALIDATED',
    'TARGET_CHANGED',
    'CLOCK_GAP',
    'ATTEMPT_RESERVED',
    'PASTE_ACCEPTED',
    'SUBMIT_ACCEPTED',
    'SEND_REFUSED',
    'SEND_UNCERTAIN',
    'TURN_CONFIRMED',
    'TICK',
    'RESTORE_EPOCH',
  ]);
  assert.deepEqual(contracts.DECISION_KINDS, ['wait', 'inspect', 'send', 'expire']);
  assert.deepEqual(contracts.HOOK_STATES, ['working', 'blocked', 'waiting', 'done']);
  assert.deepEqual(contracts.ACTION_TYPES, [
    'pause',
    'worktree',
    'worktree-orca',
    'terminal',
    'config',
    'reset-budget',
    'clear-review',
  ]);
  assert.deepEqual(contracts.ALLOWED_TTLS, [300000, 3600000]);
  assert.deepEqual(contracts.STATE_LIMITS, {
    profiles: 32,
    worktrees: 1000,
    terminals: 2000,
    budgets: 2000,
    maxSerializedBytes: 240 * 1024,
  });
  assert.deepEqual(contracts.TIMING, {
    pollMs: 2000,
    hostHeartbeatMs: 60000,
    preflightMaxMs: 5000,
    minimumRemainingMs: 10000,
    pasteConfirmDeadlineMs: 5000,
    turnStartConfirmMs: 15000,
    sendConcurrency: 1,
    inspectConcurrency: 3,
    minSendSpacingMs: 2000,
    clockGapMs: 10000,
    clockSkewMs: 5000,
  });
  assert.deepEqual(contracts.DIAGNOSTIC_EVENTS, [
    'bootstrap_started',
    'runtime_connected',
    'runtime_unavailable',
    'settings_unknown',
    'settings_changed',
    'target_unsupported',
    'epoch_armed',
    'epoch_expired',
    'safety_skipped',
    'attempt_reserved',
    'paste_accepted',
    'submit_accepted',
    'turn_observed',
    'send_uncertain',
    'policy_changed',
    'shutdown',
    'title_indicator',
    'notify_failed',
    'event_unresolved',
    'target_reset',
    'first_done_ignored',
    'epoch_restored',
  ]);
  assert.deepEqual(contracts.PUBLIC_SNAPSHOT_FORBIDDEN_KEYS, [
    'authToken',
    'draft',
    'screen',
    'tail',
    'settings',
    'repoId',
    'worktreePath',
    'userDataPath',
    'endpoint',
  ]);
});
