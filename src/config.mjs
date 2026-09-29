/**
 * Cache Keepalive 설정 기본값과 validator.
 *
 * DESIGN.md §5.2의 JSON을 그대로 기본값으로 쓰고, parseConfig/parseConfigPatch로
 * 완전한 Config를 검증·정규화한다. I/O·타이머가 없으며 ./contracts.mjs 외에는
 * 아무것도 import하지 않는다.
 *
 * @module config
 */

/** @typedef {import('./contracts.mjs').Config} Config */

const ALLOWED_SCHEMA_VERSION = 1;
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
  schemaVersion: 1,
  runtimeUserDataPath: null,
  paused: false,
  defaultWorktreeEnabled: true,
  message: 'Cache keepalive. Reply only OK; do not use tools or continue previous work.',
  margin5mMs: 60000,
  margin1hMs: 120000,
  quietOutputMs: 2500,
  observedInputQuietMs: 30000,
  maxConsecutiveKeepalives: 3,
  respectCwarmDisabled: true,
  logLevel: 'info',
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
  'maxConsecutiveKeepalives',
  'respectCwarmDisabled',
  'logLevel',
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
 * schemaVersion은 1만 허용한다. (§5.2)
 * @param {unknown} value
 * @returns {1}
 */
function expectSchemaVersion(value) {
  if (value !== ALLOWED_SCHEMA_VERSION) {
    throw new ValidationError('unsupported_schema', 'schemaVersion', `schemaVersion ${String(value)} is not supported`);
  }
  return 1;
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
  maxConsecutiveKeepalives: (value) => expectInteger(value, 'maxConsecutiveKeepalives', 0, 1000),
  respectCwarmDisabled: (value) => expectBoolean(value, 'respectCwarmDisabled'),
  logLevel: (value) => expectLogLevel(value, 'logLevel'),
};

/**
 * 객체의 알 수 없는 key를 거절한다.
 * @param {Record<string, unknown>} value
 * @param {string} field
 * @returns {void}
 */
function assertKnownFields(value, field) {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_VALIDATORS, key)) {
      throw new ValidationError('unknown_field', key, `${field} has unknown field ${key}`);
    }
  }
}

/**
 * 완전한 Config를 검증해 새 객체로 반환한다. 누락 필드는 DEFAULT_CONFIG로 채우고
 * 알 수 없는 key는 거절한다.
 * @param {unknown} value
 * @returns {Config}
 */
export function parseConfig(value) {
  assertPlainObject(value, 'config');
  assertKnownFields(/** @type {Record<string, unknown>} */ (value), 'config');
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of FIELD_ORDER) {
    const raw = Object.prototype.hasOwnProperty.call(source, field) ? source[field] : DEFAULT_CONFIG[field];
    result[field] = FIELD_VALIDATORS[field](raw);
  }
  return /** @type {Config} */ (result);
}

/**
 * patch의 key만 검증해 current에 병합한 새 Config를 반환한다.
 * schemaVersion은 1 외의 값으로 변경할 수 없다. 원본 current/patch는 변경하지 않는다.
 * @param {unknown} patch
 * @param {unknown} current
 * @returns {Config}
 */
export function parseConfigPatch(patch, current) {
  const base = parseConfig(current);
  assertPlainObject(patch, 'patch');
  assertKnownFields(/** @type {Record<string, unknown>} */ (patch), 'patch');
  const source = /** @type {Record<string, unknown>} */ (patch);
  /** @type {Record<string, unknown>} */
  const result = { ...base };
  for (const key of Object.keys(source)) {
    result[key] = FIELD_VALIDATORS[/** @type {keyof Config} */ (key)](source[key]);
  }
  return /** @type {Config} */ (result);
}
