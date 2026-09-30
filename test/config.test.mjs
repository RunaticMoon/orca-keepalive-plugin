import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  ValidationError,
  capFor,
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
  assert.equal(DEFAULT_CONFIG.schemaVersion, 2);
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

test('schemaVersion 1(레거시)과 2만 허용한다(결과는 항상 2)', () => {
  assert.equal(parseConfig({ schemaVersion: 1 }).schemaVersion, 2);
  assert.equal(parseConfig({ schemaVersion: 2 }).schemaVersion, 2);
  assertValidation(() => parseConfig({ schemaVersion: '2' }), 'unsupported_schema', 'schemaVersion');
  assertValidation(() => parseConfig({ schemaVersion: 0 }), 'unsupported_schema', 'schemaVersion');
  assertValidation(() => parseConfig({ schemaVersion: 3 }), 'unsupported_schema', 'schemaVersion');
});

test('schemaVersion이 없으면 2로 간주한다', () => {
  assert.equal(parseConfig({ paused: true }).schemaVersion, 2);
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

test('tabTitleIndicator: 기본값은 true', () => {
  assert.equal(DEFAULT_CONFIG.tabTitleIndicator, true);
  assert.equal(parseConfig({}).tabTitleIndicator, true);
  assert.equal(parseConfig({ tabTitleIndicator: true }).tabTitleIndicator, true);
  assert.equal(parseConfig({ tabTitleIndicator: false }).tabTitleIndicator, false);
});

test('patch: tabTitleIndicator를 patch할 수 있다', () => {
  const merged = parseConfigPatch({ tabTitleIndicator: false }, DEFAULT_CONFIG);
  assert.equal(merged.tabTitleIndicator, false);
  assert.equal(DEFAULT_CONFIG.tabTitleIndicator, true, 'patch는 원본을 변경하지 않는다');
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
  ['maxConsecutiveKeepalives5m', 0, 1000],
  ['maxConsecutiveKeepalives1h', 0, 1000],
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
  assert.equal(merged.schemaVersion, 2);
  // 원본/입력 불변
  assert.equal(current.paused, false);
  assert.equal(DEFAULT_CONFIG.paused, false);
  assert.deepEqual(patch, { paused: true, margin5mMs: 45000 });
  assert.notEqual(merged, current);
});

test('patch: unknown key 거절', () => {
  assertValidation(() => parseConfigPatch({ bogus: 1 }, DEFAULT_CONFIG), 'unknown_field', 'bogus');
});

test('patch: schemaVersion은 2만 허용', () => {
  assert.equal(parseConfigPatch({ schemaVersion: 2 }, DEFAULT_CONFIG).schemaVersion, 2);
  assertValidation(() => parseConfigPatch({ schemaVersion: 1 }, DEFAULT_CONFIG), 'unsupported_schema', 'schemaVersion');
  assertValidation(() => parseConfigPatch({ schemaVersion: 3 }, DEFAULT_CONFIG), 'unsupported_schema', 'schemaVersion');
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
// v1 → v2 마이그레이션
// ---------------------------------------------------------------------------

test('마이그레이션: 레거시 3(옛 기본값)은 버리고 새 기본값을 쓴다', () => {
  const migrated = parseConfig({ schemaVersion: 1, maxConsecutiveKeepalives: 3 });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.maxConsecutiveKeepalives5m, 8);
  assert.equal(migrated.maxConsecutiveKeepalives1h, 3);
  assert.equal('maxConsecutiveKeepalives' in migrated, false);
});

test('마이그레이션: 레거시 5는 새 키 두 개에 적용된다', () => {
  const migrated = parseConfig({ schemaVersion: 1, maxConsecutiveKeepalives: 5 });
  assert.equal(migrated.maxConsecutiveKeepalives5m, 5);
  assert.equal(migrated.maxConsecutiveKeepalives1h, 5);
  assert.equal('maxConsecutiveKeepalives' in migrated, false);
});

test('마이그레이션: 레거시 키가 없으면 새 기본값', () => {
  const migrated = parseConfig({ schemaVersion: 1 });
  assert.equal(migrated.maxConsecutiveKeepalives5m, 8);
  assert.equal(migrated.maxConsecutiveKeepalives1h, 3);
});

test('마이그레이션: tabTitleIndicator false도 true로 강제한다', () => {
  assert.equal(parseConfig({ schemaVersion: 1, tabTitleIndicator: false }).tabTitleIndicator, true);
  assert.equal(parseConfig({ schemaVersion: 1 }).tabTitleIndicator, true);
});

test('마이그레이션: 레거시 키가 잘못되면 거절한다', () => {
  assertValidation(
    () => parseConfig({ schemaVersion: 1, maxConsecutiveKeepalives: 1001 }),
    'out_of_range',
    'maxConsecutiveKeepalives',
  );
  assertValidation(
    () => parseConfig({ schemaVersion: 1, maxConsecutiveKeepalives: '3' }),
    'invalid_type',
    'maxConsecutiveKeepalives',
  );
});

test('마이그레이션: v1 입력의 다른 unknown key는 거절한다', () => {
  assertValidation(
    () => parseConfig({ schemaVersion: 1, bogus: 1 }),
    'unknown_field',
    'bogus',
  );
});

test('v2 입력에 레거시 키가 있으면 unknown_field로 거부한다', () => {
  assertValidation(
    () => parseConfig({ schemaVersion: 2, maxConsecutiveKeepalives: 3 }),
    'unknown_field',
    'maxConsecutiveKeepalives',
  );
  // schemaVersion 없음(2로 간주)이어도 레거시는 거부.
  assertValidation(
    () => parseConfig({ maxConsecutiveKeepalives: 3 }),
    'unknown_field',
    'maxConsecutiveKeepalives',
  );
});

test('patch: 레거시 키는 새 키 두 개에 매핑된다(새 키가 있으면 우선)', () => {
  const both = parseConfigPatch({ maxConsecutiveKeepalives: 4 }, DEFAULT_CONFIG);
  assert.equal(both.maxConsecutiveKeepalives5m, 4);
  assert.equal(both.maxConsecutiveKeepalives1h, 4);

  const precedence = parseConfigPatch(
    { maxConsecutiveKeepalives: 4, maxConsecutiveKeepalives5m: 9 },
    DEFAULT_CONFIG,
  );
  assert.equal(precedence.maxConsecutiveKeepalives5m, 9);
  assert.equal(precedence.maxConsecutiveKeepalives1h, 4);

  assertValidation(
    () => parseConfigPatch({ maxConsecutiveKeepalives: -1 }, DEFAULT_CONFIG),
    'out_of_range',
    'maxConsecutiveKeepalives',
  );
});

// ---------------------------------------------------------------------------
// parseConfigPatch + v1 current (tabTitleIndicator 강제 금지)
// ---------------------------------------------------------------------------

test('patch: current가 v1이면 tabTitleIndicator를 강제로 켜지 않고 유지한다', () => {
  const v1Current = { schemaVersion: 1, tabTitleIndicator: false, maxConsecutiveKeepalives: 2 };
  const merged = parseConfigPatch({ paused: true }, v1Current);

  assert.equal(merged.schemaVersion, 2);
  assert.equal(merged.paused, true);
  assert.equal(merged.tabTitleIndicator, false, 'patch 경로는 current의 false를 유지한다');
  // 마이그레이션 자체(레거시 키 분배)는 그대로 일어난다.
  assert.equal(merged.maxConsecutiveKeepalives5m, 2);
  assert.equal(merged.maxConsecutiveKeepalives1h, 2);
  // 로드(parseConfig) 경로는 여전히 true로 강제한다.
  assert.equal(parseConfig(v1Current).tabTitleIndicator, true);
});

test('patch: current가 v1이고 tabTitleIndicator가 없으면 기본값 true', () => {
  const merged = parseConfigPatch({ paused: true }, { schemaVersion: 1 });
  assert.equal(merged.tabTitleIndicator, true);
});

test('patch: current가 v1이어도 patch의 tabTitleIndicator가 우선한다', () => {
  const merged = parseConfigPatch(
    { tabTitleIndicator: true },
    { schemaVersion: 1, tabTitleIndicator: false },
  );
  assert.equal(merged.tabTitleIndicator, true);
});

// ---------------------------------------------------------------------------
// capFor
// ---------------------------------------------------------------------------

test('capFor: TTL 5분이면 maxConsecutiveKeepalives5m', () => {
  assert.equal(capFor(300000, { maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 3 }), 8);
});

test('capFor: TTL 1시간이면 maxConsecutiveKeepalives1h', () => {
  assert.equal(capFor(3600000, { maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 3 }), 3);
});

test('capFor: TTL 미상이면 두 값 중 더 작은(보수적) 값', () => {
  assert.equal(capFor(null, { maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 3 }), 3);
  assert.equal(capFor(undefined, { maxConsecutiveKeepalives5m: 2, maxConsecutiveKeepalives1h: 9 }), 2);
  assert.equal(capFor(12345, { maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 3 }), 3);
});

test('capFor: 0은 무제한으로 보아 min 계산에서 제외된다', () => {
  assert.equal(capFor(null, { maxConsecutiveKeepalives5m: 0, maxConsecutiveKeepalives1h: 5 }), 5);
  assert.equal(capFor(null, { maxConsecutiveKeepalives5m: 8, maxConsecutiveKeepalives1h: 0 }), 8);
  assert.equal(capFor(null, { maxConsecutiveKeepalives5m: 0, maxConsecutiveKeepalives1h: 0 }), 0);
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

test('REASON_CODES는 25개이며 값이 key와 같다', () => {
  const codes = Object.keys(contracts.REASON_CODES);
  assert.equal(codes.length, 25);
  for (const code of codes) {
    assert.equal(contracts.REASON_CODES[code], code);
  }
  const expected = [
    'APP_TIMER_OFF',
    'SETTINGS_UNKNOWN',
    'RUNTIME_UNAVAILABLE',
    'WRONG_RUNTIME',
    'NO_FRESH_TURN',
    'NO_AGENT',
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
    basisMaxGapMs: 180000,
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
