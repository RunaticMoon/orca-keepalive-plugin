/**
 * Cache Keepalive 설정 기본값과 validator.
 *
 * DESIGN.md §5.2의 JSON을 그대로 기본값으로 쓰고, parseConfig/parseConfigPatch로
 * 완전한 Config를 검증·정규화한다. I/O·타이머가 없으며 ./contracts.mjs 외에는
 * 아무것도 import하지 않는다.
 *
 * @module config
 */

import { ALLOWED_TTLS } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').Config} Config */

/** 현재 config schema. v1 저장값은 parseConfig가 v2로 마이그레이션한다. */
export const CONFIG_SCHEMA_VERSION = 2;
/** v1→v2 마이그레이션 대상 schema. */
const LEGACY_SCHEMA_VERSION = 1;
/** v2에서 제거된 레거시 키. v1 입력/구버전 patch에서만 허용한다. */
export const LEGACY_CONSECUTIVE_KEY = 'maxConsecutiveKeepalives';
const CONSECUTIVE_5M_KEY = 'maxConsecutiveKeepalives5m';
const CONSECUTIVE_1H_KEY = 'maxConsecutiveKeepalives1h';
/** 레거시 기본값. v1 입력에서 이 값이면 새 기본값을 쓴다. */
const LEGACY_DEFAULT_CONSECUTIVE = 3;
const MAX_PATH_LENGTH = 4096;
const MESSAGE_MIN_BYTES = 1;
const MESSAGE_MAX_BYTES = 512;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** prototype pollution 방지를 위해 거절하는 key. */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * 제어문자(U+0000–U+001F, U+007F). 개행/캐리지리턴 포함.
 * 전역 플래그 없이 사용한다.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/** @typedef {'unknown_field'|'invalid_type'|'out_of_range'|'invalid_message'|'unsupported_schema'} ValidationErrorCode */

/**
 * 설정 검증 실패. code는 고정 enum, field는 문제가 된 설정 key(또는 'config'/'patch').
 */
export class ValidationError extends Error {
  /**
   * @param {ValidationErrorCode} code
   * @param {string} field
   * @param {string} [message]
   */
  constructor(code, field, message) {
    super(message ?? `${code}: ${field}`);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
  }
}

/**
 * §5.2 JSON과 동일한 기본 설정.
 * @type {Readonly<Config>}
 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 2,
  runtimeUserDataPath: null,
  paused: false,
  defaultWorktreeEnabled: true,
  message: 'Cache keepalive. Reply only OK; do not use tools or continue previous work.',
  margin5mMs: 60000,
  margin1hMs: 120000,
  quietOutputMs: 2500,
  observedInputQuietMs: 30000,
  maxConsecutiveKeepalives5m: 8,
  maxConsecutiveKeepalives1h: 3,
  respectCwarmDisabled: true,
  logLevel: 'info',
  tabTitleIndicator: true,
});

/**
 * 필드를 채우고 검증하는 순서. §5.2 JSON 순서와 동일.
 * @type {ReadonlyArray<keyof Config>}
 */
const FIELD_ORDER = [
  'schemaVersion',
  'runtimeUserDataPath',
  'paused',
  'defaultWorktreeEnabled',
  'message',
  'margin5mMs',
  'margin1hMs',
  'quietOutputMs',
  'observedInputQuietMs',
  'maxConsecutiveKeepalives5m',
  'maxConsecutiveKeepalives1h',
  'respectCwarmDisabled',
  'logLevel',
  'tabTitleIndicator',
];

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {void}
 */
function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('invalid_type', field, `${field} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ValidationError('invalid_type', field, `${field} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new ValidationError('unknown_field', key, `forbidden key ${key}`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {boolean}
 */
function expectBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ValidationError('invalid_type', field, `${field} must be a boolean`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function expectInteger(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError('invalid_type', field, `${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ValidationError('out_of_range', field, `${field} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * POSIX(`/`로 시작) 또는 Windows(`C:\` 형태) 절대 경로인지 검사한다.
 * @param {string} value
 * @returns {boolean}
 */
function isAbsolutePath(value) {
  if (value.startsWith('/')) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function expectPath(value, field) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_type', field, `${field} must be null or a string`);
  }
  if (value.includes('\u0000')) {
    throw new ValidationError('out_of_range', field, `${field} must not contain NUL`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new ValidationError('out_of_range', field, `${field} exceeds ${MAX_PATH_LENGTH} characters`);
  }
  if (!isAbsolutePath(value)) {
    throw new ValidationError('out_of_range', field, `${field} must be an absolute path`);
  }
  return value;
}

/**
 * 단일 행 메시지를 검증하고 trim된 값을 반환한다. §3, §5.2.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function expectMessage(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_type', field, `${field} must be a string`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new ValidationError('invalid_message', field, `${field} must not contain control characters or newlines`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ValidationError('invalid_message', field, `${field} must not be empty`);
  }
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes < MESSAGE_MIN_BYTES || bytes > MESSAGE_MAX_BYTES) {
    throw new ValidationError('invalid_message', field, `${field} must be ${MESSAGE_MIN_BYTES}-${MESSAGE_MAX_BYTES} UTF-8 bytes`);
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function expectLogLevel(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_type', field, `${field} must be a string`);
  }
  if (!LOG_LEVELS.includes(value)) {
    throw new ValidationError('out_of_range', field, `${field} must be one of ${LOG_LEVELS.join(', ')}`);
  }
  return value;
}

/**
 * schemaVersion은 1(레거시 입력)과 2를 허용한다. 검증 시점에는 이미 2로
 * 정규화되어 있으므로 2를 반환한다. (§5.2)
 * @param {unknown} value
 * @returns {2}
 */
function expectSchemaVersion(value) {
  if (value !== LEGACY_SCHEMA_VERSION && value !== CONFIG_SCHEMA_VERSION) {
    throw new ValidationError('unsupported_schema', 'schemaVersion', `schemaVersion ${String(value)} is not supported`);
  }
  return 2;
}

/**
 * 필드별 validator. 각 함수는 정규화된 값을 반환하거나 ValidationError를 던진다.
 * @type {Record<keyof Config, (value: unknown) => unknown>}
 */
const FIELD_VALIDATORS = {
  schemaVersion: (value) => expectSchemaVersion(value),
  runtimeUserDataPath: (value) => expectPath(value, 'runtimeUserDataPath'),
  paused: (value) => expectBoolean(value, 'paused'),
  defaultWorktreeEnabled: (value) => expectBoolean(value, 'defaultWorktreeEnabled'),
  message: (value) => expectMessage(value, 'message'),
  margin5mMs: (value) => expectInteger(value, 'margin5mMs', 30000, 120000),
  margin1hMs: (value) => expectInteger(value, 'margin1hMs', 60000, 600000),
  quietOutputMs: (value) => expectInteger(value, 'quietOutputMs', 2500, 60000),
  observedInputQuietMs: (value) => expectInteger(value, 'observedInputQuietMs', 10000, 300000),
  maxConsecutiveKeepalives5m: (value) => expectInteger(value, 'maxConsecutiveKeepalives5m', 0, 1000),
  maxConsecutiveKeepalives1h: (value) => expectInteger(value, 'maxConsecutiveKeepalives1h', 0, 1000),
  respectCwarmDisabled: (value) => expectBoolean(value, 'respectCwarmDisabled'),
  logLevel: (value) => expectLogLevel(value, 'logLevel'),
  tabTitleIndicator: (value) => expectBoolean(value, 'tabTitleIndicator'),
};

/**
 * v1 입력에서만 허용하는 레거시 키 validator. v2 결과에는 포함하지 않는다.
 * @type {Record<string, (value: unknown) => unknown>}
 */
const LEGACY_FIELD_VALIDATORS = {
  maxConsecutiveKeepalives: (value) => expectInteger(value, 'maxConsecutiveKeepalives', 0, 1000),
};

/**
 * patch용 validator. 레거시 키를 허용하고 schemaVersion은 2만 받는다.
 * @type {Record<string, (value: unknown) => unknown>}
 */
const PATCH_VALIDATORS = {
  ...FIELD_VALIDATORS,
  schemaVersion: (value) => {
    if (value !== CONFIG_SCHEMA_VERSION) {
      throw new ValidationError('unsupported_schema', 'schemaVersion', `schemaVersion ${String(value)} is not supported`);
    }
    return CONFIG_SCHEMA_VERSION;
  },
  ...LEGACY_FIELD_VALIDATORS,
};

/**
 * TTL별 연속 keepalive 상한. 0은 무제한이며 capFor의 min 계산에서는 Infinity로 본다.
 * @param {number|null|undefined} ttlMs
 * @param {Config} config
 * @returns {number} 정수 상한(0=무제한).
 */
export function capFor(ttlMs, config) {
  if (ttlMs === ALLOWED_TTLS[0]) {
    return config.maxConsecutiveKeepalives5m;
  }
  if (ttlMs === ALLOWED_TTLS[1]) {
    return config.maxConsecutiveKeepalives1h;
  }
  // TTL 미상이면 두 제한 중 더 작은(보수적인) 값을 쓴다. 0(무제한)은 Infinity로 간주한다.
  const five = config.maxConsecutiveKeepalives5m;
  const hour = config.maxConsecutiveKeepalives1h;
  const min = Math.min(five === 0 ? Infinity : five, hour === 0 ? Infinity : hour);
  return min === Infinity ? 0 : min;
}

/**
 * 객체의 알 수 없는 key를 거절한다.
 * @param {Record<string, unknown>} value
 * @param {string} field
 * @param {Record<string, unknown>} [validators] 허용 key 집합(기본 FIELD_VALIDATORS).
 * @returns {void}
 */
function assertKnownFields(value, field, validators = FIELD_VALIDATORS) {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(validators, key)) {
      throw new ValidationError('unknown_field', key, `${field} has unknown field ${key}`);
    }
  }
}

/**
 * v1 설정을 v2로 마이그레이션한다.
 * - 레거시 `maxConsecutiveKeepalives`는 검증 후 제거한다. 값이 옛 기본값 3이면
 *   버리고 새 기본값을 쓰고, 아니면 입력에 없는 새 키에 같은 값을 적용한다.
 * - `tabTitleIndicator`는 옛 기본값(false)과 저장된 false를 구분할 수 없으므로
 *   기본적으로 true로 강제한다(1회 켜기). `forceTabTitleIndicator:false`이면
 *   입력 값을 그대로 둬 설정 patch 경로에서 current 값을 보존한다.
 * - schemaVersion은 2로 맞춘다.
 * @param {Record<string, unknown>} source
 * @param {{forceTabTitleIndicator?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
function migrateV1Config(source, { forceTabTitleIndicator = true } = {}) {
  /** @type {Record<string, unknown>} */
  const result = { ...source };
  const hasLegacy = Object.prototype.hasOwnProperty.call(result, LEGACY_CONSECUTIVE_KEY);
  if (hasLegacy) {
    const legacy = LEGACY_FIELD_VALIDATORS[LEGACY_CONSECUTIVE_KEY](result[LEGACY_CONSECUTIVE_KEY]);
    delete result[LEGACY_CONSECUTIVE_KEY];
    if (legacy !== LEGACY_DEFAULT_CONSECUTIVE) {
      if (!Object.prototype.hasOwnProperty.call(result, CONSECUTIVE_5M_KEY)) {
        result[CONSECUTIVE_5M_KEY] = legacy;
      }
      if (!Object.prototype.hasOwnProperty.call(result, CONSECUTIVE_1H_KEY)) {
        result[CONSECUTIVE_1H_KEY] = legacy;
      }
    }
  }
  result.schemaVersion = CONFIG_SCHEMA_VERSION;
  if (forceTabTitleIndicator) {
    result.tabTitleIndicator = true;
  }
  return result;
}

/**
 * 완전한 Config를 검증해 새 객체로 반환한다. 누락 필드는 DEFAULT_CONFIG로 채우고
 * 알 수 없는 key는 거절한다. schemaVersion이 1(레거시)이면 v2로 마이그레이션한 뒤
 * 검증한다. schemaVersion이 없으면 2로 간주한다.
 * @param {unknown} value
 * @returns {Config}
 */
export function parseConfig(value) {
  return parseConfigInternal(value, { forceTabTitleIndicator: true });
}

/**
 * parseConfig/parseConfigPatch가 공유하는 검증 경로. schemaVersion 1 입력이면
 * 마이그레이션한다. `forceTabTitleIndicator`가 false면 마이그레이션 시
 * `tabTitleIndicator`를 true로 덮지 않아 current 값을 유지한다.
 * @param {unknown} value
 * @param {{forceTabTitleIndicator: boolean}} options
 * @returns {Config}
 */
function parseConfigInternal(value, { forceTabTitleIndicator }) {
  assertPlainObject(value, 'config');
  const source = /** @type {Record<string, unknown>} */ (value);
  const version = Object.prototype.hasOwnProperty.call(source, 'schemaVersion')
    ? source.schemaVersion
    : CONFIG_SCHEMA_VERSION;
  if (version !== LEGACY_SCHEMA_VERSION && version !== CONFIG_SCHEMA_VERSION) {
    throw new ValidationError('unsupported_schema', 'schemaVersion', `schemaVersion ${String(version)} is not supported`);
  }
  const migrated =
    version === LEGACY_SCHEMA_VERSION ? migrateV1Config(source, { forceTabTitleIndicator }) : source;
  assertKnownFields(migrated, 'config');
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of FIELD_ORDER) {
    const raw = Object.prototype.hasOwnProperty.call(migrated, field) ? migrated[field] : DEFAULT_CONFIG[field];
    result[field] = FIELD_VALIDATORS[field](raw);
  }
  return /** @type {Config} */ (result);
}

/**
 * patch의 key만 검증해 current에 병합한 새 Config를 반환한다.
 * schemaVersion은 2만 허용한다(변경 금지). patch에 레거시 `maxConsecutiveKeepalives`가
 * 오면 CLI/구버전 UI 호환을 위해 새 키 두 개에 같은 값을 설정한다(새 키가 있으면 우선).
 * current가 v1이면 마이그레이션하되, 로드 경로와 달리 `tabTitleIndicator`는 강제로
 * 켜지 않는다(current에 저장된 값을 유지). 원본 current/patch는 변경하지 않는다.
 * @param {unknown} patch
 * @param {unknown} current
 * @returns {Config}
 */
export function parseConfigPatch(patch, current) {
  const base = parseConfigInternal(current, { forceTabTitleIndicator: false });
  assertPlainObject(patch, 'patch');
  assertKnownFields(/** @type {Record<string, unknown>} */ (patch), 'patch', PATCH_VALIDATORS);
  const source = /** @type {Record<string, unknown>} */ (patch);
  /** @type {Record<string, unknown>} */
  const result = { ...base };
  if (Object.prototype.hasOwnProperty.call(source, LEGACY_CONSECUTIVE_KEY)) {
    const legacy = LEGACY_FIELD_VALIDATORS[LEGACY_CONSECUTIVE_KEY](source[LEGACY_CONSECUTIVE_KEY]);
    if (!Object.prototype.hasOwnProperty.call(source, CONSECUTIVE_5M_KEY)) {
      result[CONSECUTIVE_5M_KEY] = legacy;
    }
    if (!Object.prototype.hasOwnProperty.call(source, CONSECUTIVE_1H_KEY)) {
      result[CONSECUTIVE_1H_KEY] = legacy;
    }
  }
  for (const key of Object.keys(source)) {
    if (key === LEGACY_CONSECUTIVE_KEY) {
      continue;
    }
    result[key] = PATCH_VALIDATORS[key](source[key]);
  }
  return /** @type {Config} */ (result);
}
