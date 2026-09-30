/**
 * Cache Keepalive 플러그인 정책·전송 journal 영속 저장소.
 *
 * DESIGN.md §5.2(단일 `state-v1` key), §5.3(영속 상태 계약·직렬화 상한·행 제한)와
 * §6 state-store export 계약을 구현한다. host storage는 주입된 `hostCall`로만
 * 접근하고 import 시 I/O/타이머를 시작하지 않는다.
 *
 * 계약 요약:
 *  - PersistedState는 배열만 쓴다(사용자 ID를 객체 key로 쓰지 않아 prototype
 *    pollution을 피한다). `config`는 `parseConfig`로 검증한다.
 *  - 모든 mutation은 단일 직렬 queue를 지나고 성공 시 revision +1.
 *  - OFF/pause(setPaused(true), setWorktree(false), setTerminal(false))는 메모리에
 *    즉시 반영한 뒤 저장하고, 저장 실패 시에도 메모리 차단 상태를 유지한다.
 *  - ON/resume/config/reset은 저장 성공 후에만 메모리에 반영한다.
 *  - reserveAttempt는 charged 증가와 lastAttempt 저장이 성공한 뒤 attemptId를
 *    반환한다(실패 시 charged 불변 → 전송 금지).
 *
 * @module state-store
 */

import crypto from 'node:crypto';

import { parseConfig, parseConfigPatch, capFor, CONFIG_SCHEMA_VERSION } from './config.mjs';
import { STATE_LIMITS } from './contracts.mjs';

/** host storage의 단일 key. §5.2. */
export const STATE_KEY = 'state-v1';

/** 미완료(전송 결과 불확실) attempt phase. 재시작 시 needsReview로 승격한다. */
const OPEN_ATTEMPT_PHASES = new Set(['reserved', 'pasted', 'submitted']);

/** 허용 attempt phase. */
const ATTEMPT_PHASES = new Set(['reserved', 'pasted', 'submitted', 'confirmed', 'refused']);

/** recordAttempt가 받는 phase. §5.3. */
const RECORDABLE_PHASES = new Set(['pasted', 'submitted']);

/**
 * 영속 상태 계약 위반. code는 고정 enum이며 storage 계층 오류 status를 포함할 수 있다.
 */
export class StoreError extends Error {
  /**
   * @param {'state_too_large'|'row_limit'|'storage_failed'|'revision_conflict'|'invalid_scope'|'invalid_phase'} code
   * @param {{status?: number, cause?: unknown, message?: string}} [options]
   */
  constructor(code, options = {}) {
    super(options.message ?? code);
    this.name = 'StoreError';
    /** @type {string} */
    this.code = code;
    if (options.status !== undefined) {
      /** @type {number} */
      this.status = options.status;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** @typedef {{userDataKey: string, profileId: string, worktreeId: string, paneKey: string|null}} Scope */
/** @typedef {{attemptId: string, runtimeId?: string, ptyId?: string, epochId: number, phase: string, at: number}} LastAttempt */
/** @typedef {{worktreeId: string, paneKey: string|null, charged: number, confirmed: number, lastAttempt: LastAttempt|null, needsReview: boolean}} BudgetRow */
/** @typedef {{revision: number, config: import('./config.mjs').Config, profiles: Array<object>, memoryPaused: boolean, lastSaveError: string|null}} Snapshot */
/** @typedef {{charged: number, confirmed: number, needsReview: boolean, lastAttempt: LastAttempt|null}} BudgetView */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 객체 그래프를 재귀적으로 동결한다. 순환은 없다.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/**
 * 새 기본 상태. 저장값이 없을 때 사용한다. revision 0.
 * @returns {Record<string, unknown>}
 */
function defaultState() {
  return { schemaVersion: 1, revision: 0, config: parseConfig({}), profiles: [] };
}

/**
 * `paneKey`가 없거나 null이면 워크트리 scope로 정규화한다.
 * @param {unknown} scope
 * @returns {Scope}
 */
function normalizeScope(scope) {
  if (!isPlainObject(scope)) {
    throw new StoreError('invalid_scope', { message: 'scope must be a plain object' });
  }
  const { userDataKey, profileId, worktreeId } = scope;
  if (!isNonEmptyString(userDataKey) || !isNonEmptyString(profileId) || !isNonEmptyString(worktreeId)) {
    throw new StoreError('invalid_scope', {
      message: 'userDataKey, profileId and worktreeId must be non-empty strings',
    });
  }
  const rawPaneKey = /** @type {Record<string, unknown>} */ (scope).paneKey;
  let paneKey = null;
  if (rawPaneKey !== undefined && rawPaneKey !== null) {
    if (!isNonEmptyString(rawPaneKey)) {
      throw new StoreError('invalid_scope', { message: 'paneKey must be null or a non-empty string' });
    }
    paneKey = rawPaneKey;
  }
  return { userDataKey, profileId, worktreeId, paneKey };
}

/**
 * @param {Record<string, unknown>} state
 * @param {Scope} scope
 * @returns {Record<string, unknown>|null}
 */
function findProfile(state, scope) {
  const profiles = /** @type {Array<Record<string, unknown>>} */ (state.profiles);
  return (
    profiles.find((p) => p.userDataKey === scope.userDataKey && p.profileId === scope.profileId) ?? null
  );
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string} worktreeId
 * @returns {Record<string, unknown>|null}
 */
function findWorktree(profile, worktreeId) {
  const worktrees = /** @type {Array<Record<string, unknown>>} */ (profile.worktrees);
  return worktrees.find((w) => w.worktreeId === worktreeId) ?? null;
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string} worktreeId
 * @param {string|null} paneKey
 * @returns {Record<string, unknown>|null}
 */
function findTerminal(profile, worktreeId, paneKey) {
  if (paneKey === null) {
    return null;
  }
  const terminals = /** @type {Array<Record<string, unknown>>} */ (profile.terminals);
  return terminals.find((t) => t.worktreeId === worktreeId && t.paneKey === paneKey) ?? null;
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string} worktreeId
 * @param {string|null} paneKey
 * @returns {BudgetRow|null}
 */
function findBudget(profile, worktreeId, paneKey) {
  const budgets = /** @type {BudgetRow[]} */ (profile.budgets);
  return budgets.find((b) => b.worktreeId === worktreeId && b.paneKey === paneKey) ?? null;
}

/**
 * @param {Record<string, unknown>} state
 * @param {Scope} scope
 * @returns {BudgetRow|null}
 */
function locateBudget(state, scope) {
  const profile = findProfile(state, scope);
  if (profile === null) {
    return null;
  }
  return findBudget(profile, scope.worktreeId, scope.paneKey);
}

/**
 * @param {Record<string, unknown>} state
 * @param {string} attemptId
 * @returns {BudgetRow|null}
 */
function locateBudgetByAttempt(state, attemptId) {
  const profiles = /** @type {Array<Record<string, unknown>>} */ (state.profiles);
  for (const profile of profiles) {
    const budgets = /** @type {BudgetRow[]} */ (profile.budgets);
    for (const budget of budgets) {
      if (budget.lastAttempt !== null && budget.lastAttempt.attemptId === attemptId) {
        return budget;
      }
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} state
 * @param {Scope} scope
 * @returns {Record<string, unknown>}
 */
function ensureProfile(state, scope) {
  let profile = findProfile(state, scope);
  if (profile === null) {
    profile = {
      userDataKey: scope.userDataKey,
      profileId: scope.profileId,
      worktrees: [],
      terminals: [],
      budgets: [],
    };
    /** @type {Array<Record<string, unknown>>} */ (state.profiles).push(profile);
  }
  return profile;
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string} worktreeId
 * @param {string|null} paneKey
 * @returns {BudgetRow}
 */
function ensureBudget(profile, worktreeId, paneKey) {
  let budget = findBudget(profile, worktreeId, paneKey);
  if (budget === null) {
    budget = { worktreeId, paneKey, charged: 0, confirmed: 0, lastAttempt: null, needsReview: false };
    /** @type {BudgetRow[]} */ (profile.budgets).push(budget);
  }
  return budget;
}

/**
 * 직렬화한 UTF-8 byte 수. §5.3 전체 상한 검사에 쓴다.
 * @param {Record<string, unknown>} state
 * @returns {number}
 */
function serializedBytes(state) {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

/**
 * 행 제한과 전체 직렬화 상한을 검사한다. 초과 시 StoreError를 던진다.
 * @param {Record<string, unknown>} state
 * @returns {void}
 */
function assertLimits(state) {
  const profiles = /** @type {Array<Record<string, unknown>>} */ (state.profiles);
  if (profiles.length > STATE_LIMITS.profiles) {
    throw new StoreError('row_limit', { message: `profiles > ${STATE_LIMITS.profiles}` });
  }
  for (const profile of profiles) {
    const worktrees = /** @type {Array<unknown>} */ (profile.worktrees);
    const terminals = /** @type {Array<unknown>} */ (profile.terminals);
    const budgets = /** @type {Array<unknown>} */ (profile.budgets);
    if (
      worktrees.length > STATE_LIMITS.worktrees ||
      terminals.length > STATE_LIMITS.terminals ||
      budgets.length > STATE_LIMITS.budgets
    ) {
      throw new StoreError('row_limit', { message: 'profile rows exceed limit' });
    }
  }
  if (serializedBytes(state) > STATE_LIMITS.maxSerializedBytes) {
    throw new StoreError('state_too_large', {
      message: `serialized state > ${STATE_LIMITS.maxSerializedBytes} bytes`,
    });
  }
}

/**
 * 저장된(또는 저장할) raw state를 검증·정규화한다. 실패 시 일반 Error를 던진다.
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function validatePersistedState(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('state is not a plain object');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error('unsupported schemaVersion');
  }
  if (!Number.isSafeInteger(raw.revision) || /** @type {number} */ (raw.revision) < 0) {
    throw new Error('invalid revision');
  }
  const config = parseConfig(raw.config);
  if (!Array.isArray(raw.profiles)) {
    throw new Error('profiles must be an array');
  }
  if (raw.profiles.length > STATE_LIMITS.profiles) {
    throw new Error('too many profiles');
  }
  const profiles = raw.profiles.map(validateProfile);
  return { schemaVersion: 1, revision: raw.revision, config, profiles };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function validateProfile(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('profile is not a plain object');
  }
  if (!isNonEmptyString(raw.userDataKey) || !isNonEmptyString(raw.profileId)) {
    throw new Error('profile identity invalid');
  }
  if (!Array.isArray(raw.worktrees) || raw.worktrees.length > STATE_LIMITS.worktrees) {
    throw new Error('worktrees invalid');
  }
  if (!Array.isArray(raw.terminals) || raw.terminals.length > STATE_LIMITS.terminals) {
    throw new Error('terminals invalid');
  }
  if (!Array.isArray(raw.budgets) || raw.budgets.length > STATE_LIMITS.budgets) {
    throw new Error('budgets invalid');
  }
  const worktrees = raw.worktrees.map((entry) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.worktreeId) || typeof entry.enabled !== 'boolean') {
      throw new Error('worktree row invalid');
    }
    return { worktreeId: entry.worktreeId, enabled: entry.enabled };
  });
  const terminals = raw.terminals.map((entry) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.worktreeId) || !isNonEmptyString(entry.paneKey)) {
      throw new Error('terminal row invalid');
    }
    if (typeof entry.enabled !== 'boolean') {
      throw new Error('terminal row invalid');
    }
    return { worktreeId: entry.worktreeId, paneKey: entry.paneKey, enabled: entry.enabled };
  });
  const budgets = raw.budgets.map(validateBudget);
  return {
    userDataKey: raw.userDataKey,
    profileId: raw.profileId,
    worktrees,
    terminals,
    budgets,
  };
}

/**
 * @param {unknown} raw
 * @returns {BudgetRow}
 */
function validateBudget(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('budget row invalid');
  }
  if (!isNonEmptyString(raw.worktreeId)) {
    throw new Error('budget worktreeId invalid');
  }
  const paneKey = raw.paneKey === null || raw.paneKey === undefined ? null : raw.paneKey;
  if (paneKey !== null && !isNonEmptyString(paneKey)) {
    throw new Error('budget paneKey invalid');
  }
  if (!Number.isSafeInteger(raw.charged) || /** @type {number} */ (raw.charged) < 0) {
    throw new Error('budget charged invalid');
  }
  if (!Number.isSafeInteger(raw.confirmed) || /** @type {number} */ (raw.confirmed) < 0) {
    throw new Error('budget confirmed invalid');
  }
  if (typeof raw.needsReview !== 'boolean') {
    throw new Error('budget needsReview invalid');
  }
  /** @type {LastAttempt|null} */
  let lastAttempt = null;
  if (raw.lastAttempt !== null && raw.lastAttempt !== undefined) {
    lastAttempt = validateLastAttempt(raw.lastAttempt);
  }
  return {
    worktreeId: raw.worktreeId,
    paneKey,
    charged: raw.charged,
    confirmed: raw.confirmed,
    lastAttempt,
    needsReview: raw.needsReview,
  };
}

/**
 * @param {unknown} raw
 * @returns {LastAttempt}
 */
function validateLastAttempt(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('lastAttempt invalid');
  }
  if (!isNonEmptyString(raw.attemptId) || !Number.isSafeInteger(raw.epochId) || typeof raw.phase !== 'string') {
    throw new Error('lastAttempt fields invalid');
  }
  if (!ATTEMPT_PHASES.has(raw.phase)) {
    throw new Error('lastAttempt phase invalid');
  }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) {
    throw new Error('lastAttempt at invalid');
  }
  /** @type {LastAttempt} */
  const lastAttempt = { attemptId: raw.attemptId, epochId: raw.epochId, phase: raw.phase, at: raw.at };
  if (raw.runtimeId !== undefined && raw.runtimeId !== null) {
    if (typeof raw.runtimeId !== 'string') {
      throw new Error('lastAttempt runtimeId invalid');
    }
    lastAttempt.runtimeId = raw.runtimeId;
  }
  if (raw.ptyId !== undefined && raw.ptyId !== null) {
    if (typeof raw.ptyId !== 'string') {
      throw new Error('lastAttempt ptyId invalid');
    }
    lastAttempt.ptyId = raw.ptyId;
  }
  return lastAttempt;
}

/**
 * @param {unknown} error
 * @returns {StoreError}
 */
function asStorageError(error) {
  if (error instanceof StoreError) {
    return error;
  }
  return new StoreError('storage_failed', { message: 'storage_failed', cause: error });
}

/**
 * 정책·전송 journal 저장소를 만든다.
 *
 * @param {object} options
 * @param {(method: string, params: object) => Promise<any>} options.hostCall
 *   `hostCall('storage.get', {key})`/`hostCall('storage.set', {key, value})`.
 * @param {() => number} [options.now]
 * @param {() => string} [options.randomId]
 * @returns {object} §6 state-store 인터페이스.
 */
export function createStateStore({ hostCall, now = Date.now, randomId = crypto.randomUUID } = {}) {
  if (typeof hostCall !== 'function') {
    throw new TypeError('createStateStore requires a hostCall function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (typeof randomId !== 'function') {
    throw new TypeError('randomId must be a function');
  }

  /** @type {Record<string, unknown>} */
  let state = defaultState();
  let memoryPaused = false;
  /** @type {string|null} */
  let lastSaveError = null;
  let queueTail = Promise.resolve();
  /** @type {Set<(snapshot: Snapshot) => void>} */
  const listeners = new Set();

  /**
   * mutation을 단일 직렬 queue에 넣는다. 이전 task 실패는 다음 task를 막지 않는다.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queueTail.then(() => task());
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * snapshot 직전 메모리 state를 깊은 복사·동결한다.
   * @returns {Snapshot}
   */
  function createSnapshot() {
    return /** @type {Snapshot} */ (
      deepFreeze({
        revision: state.revision,
        config: structuredClone(state.config),
        profiles: structuredClone(state.profiles),
        memoryPaused,
        lastSaveError,
      })
    );
  }

  /** 구독자에게 최신 snapshot을 알린다. 동기 콜백이다. */
  function emit() {
    if (listeners.size === 0) {
      return;
    }
    const snapshot = createSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // 구독자 오류가 store 동작을 막지 않는다.
      }
    }
  }

  /**
   * expectedRevision이 주어졌고 현재 revision과 다르면 409 conflict.
   * @param {number|undefined|null} expectedRevision
   * @param {number} currentRevision
   * @returns {void}
   */
  function checkRevision(expectedRevision, currentRevision) {
    if (expectedRevision === undefined || expectedRevision === null) {
      return;
    }
    if (expectedRevision !== currentRevision) {
      throw new StoreError('revision_conflict', {
        status: 409,
        message: `expected revision ${expectedRevision}, current ${currentRevision}`,
      });
    }
  }

  /**
   * @param {Record<string, unknown>} next
   * @returns {Promise<void>}
   */
  async function persist(next) {
    await hostCall('storage.set', { key: STATE_KEY, value: next });
  }

  /**
   * 저장 성공 후에만 메모리에 반영하는 mutation.
   * @param {(draft: Record<string, unknown>) => (boolean|void)} transform draft를 제자리 수정. `false`면 no-op.
   * @param {number|undefined|null} expectedRevision
   * @returns {Promise<Snapshot>}
   */
  function applyPersisted(transform, expectedRevision) {
    return enqueue(async () => {
      const base = state;
      checkRevision(expectedRevision, base.revision);
      const next = structuredClone(base);
      if (transform(next) === false) {
        return createSnapshot();
      }
      next.revision = base.revision + 1;
      assertLimits(next);
      try {
        await persist(next);
      } catch (error) {
        lastSaveError = 'storage_failed';
        emit();
        throw asStorageError(error);
      }
      // 저장 중 동기 OFF mutation이 끼어들었으면 latest state 위에 다시 적용한다(lost update 방지).
      if (state === base) {
        state = next;
      } else {
        const committed = structuredClone(state);
        transform(committed);
        committed.revision = state.revision + 1;
        state = committed;
      }
      lastSaveError = null;
      emit();
      return createSnapshot();
    });
  }

  /**
   * 메모리에 즉시 반영한 뒤 저장하는 안전 mutation(OFF/pause).
   * 저장 실패 시에도 메모리 상태를 유지하고 reject한다.
   * @param {(draft: Record<string, unknown>) => void} transform
   * @param {number|undefined|null} expectedRevision
   * @returns {Promise<Snapshot>}
   */
  function applyImmediate(transform, expectedRevision) {
    const base = state;
    checkRevision(expectedRevision, base.revision);
    const next = structuredClone(base);
    transform(next);
    next.revision = base.revision + 1;
    assertLimits(next);
    state = next;
    emit();
    return enqueue(async () => {
      const toSave = state;
      try {
        await persist(toSave);
      } catch (error) {
        lastSaveError = 'storage_failed';
        emit();
        throw asStorageError(error);
      }
      lastSaveError = null;
      emit();
      return createSnapshot();
    });
  }

  // ---------------------------------------------------------------------------
  // 공개 API
  // ---------------------------------------------------------------------------

  /**
   * host storage에서 state-v1을 읽어 검증한다. 저장값이 없으면 기본 상태.
   * schemaVersion이 1이 아니거나 검증에 실패하면 memoryPaused=true,
   * lastSaveError='state_invalid'로 로드하고 저장소를 덮어쓰지 않는다.
   * @returns {Promise<Snapshot>}
   */
  function load() {
    return enqueue(async () => {
      let raw;
      try {
        const result = await hostCall('storage.get', { key: STATE_KEY });
        raw = result === null || result === undefined ? undefined : result.value;
      } catch (error) {
        state = defaultState();
        memoryPaused = true;
        lastSaveError = 'storage_failed';
        emit();
        return createSnapshot();
      }

      if (raw === undefined || raw === null) {
        state = defaultState();
        memoryPaused = false;
        lastSaveError = null;
        emit();
        return createSnapshot();
      }

      let parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        state = validatePersistedState(parsed);
      } catch {
        state = defaultState();
        memoryPaused = true;
        lastSaveError = 'state_invalid';
        emit();
        return createSnapshot();
      }

      memoryPaused = false;
      lastSaveError = null;

      // 저장된 원본 config가 현재 schemaVersion(CONFIG_SCHEMA_VERSION)이 아니면
      // 로드 시 v2 마이그레이션/정규화가 일어났다고 보고 아래에서 1회 저장한다.
      // 이미 현재 버전인 저장값은 로드만으로 다시 쓰지 않는다(불필요한 쓰기 금지).
      // 레거시 키가 남은 저장값은 반드시 schemaVersion 1이라 이 조건에 포함된다
      // (v2/무표기 + 레거시 키는 parseConfig가 unknown_field로 거부해 여기 도달하지 않는다).
      const rawConfig = /** @type {Record<string, unknown>|undefined} */ (parsed.config);
      const configMigrated =
        isPlainObject(rawConfig) && rawConfig.schemaVersion !== CONFIG_SCHEMA_VERSION;

      // 재시작 시 미완료 attempt는 전송 결과 확인 필요로 승격한다. §5.3.
      let changed = false;
      for (const profile of /** @type {Array<Record<string, unknown>>} */ (state.profiles)) {
        for (const budget of /** @type {BudgetRow[]} */ (profile.budgets)) {
          if (
            budget.lastAttempt !== null &&
            OPEN_ATTEMPT_PHASES.has(budget.lastAttempt.phase) &&
            budget.needsReview !== true
          ) {
            budget.needsReview = true;
            changed = true;
          }
        }
      }
      // needsReview 승격은 의미 있는 mutation이라 revision을 올린다. config
      // 마이그레이션은 로드 시 정규화일 뿐이므로 revision은 그대로 두고 같은
      // 저장 경로(persist + storage_failed 처리)를 따른다. 저장이 실패해도
      // 메모리의 마이그레이션 결과는 유지된다.
      if (changed || configMigrated) {
        if (changed) {
          state.revision = /** @type {number} */ (state.revision) + 1;
        }
        try {
          await persist(state);
        } catch {
          lastSaveError = 'storage_failed';
        }
      }
      emit();
      return createSnapshot();
    });
  }

  /**
   * @returns {Snapshot} 깊은 복사된 불변 snapshot.
   */
  function snapshot() {
    return createSnapshot();
  }

  /**
   * @param {(snapshot: Snapshot) => void} listener
   * @returns {() => void} unsubscribe.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe requires a function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * 설정 patch를 병합한다. `paused:true` patch는 안전을 위해 즉시 반영한다.
   * @param {object} patch
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function updateConfig(patch, options = {}) {
    const nextConfig = parseConfigPatch(patch, state.config);
    const transform = (/** @type {Record<string, unknown>} */ draft) => {
      draft.config = nextConfig;
    };
    if (isPlainObject(patch) && /** @type {Record<string, unknown>} */ (patch).paused === true) {
      return applyImmediate(transform, options.expectedRevision);
    }
    return applyPersisted(transform, options.expectedRevision);
  }

  /**
   * 전역 일시정지. setPaused(true)는 OFF/pause로 즉시 반영, false는 resume로 저장 후 반영.
   * @param {boolean} paused
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function setPaused(paused, options = {}) {
    return updateConfig({ paused: paused === true }, options);
  }

  /**
   * 워크트리 scope override. `paneKey`는 무시한다(워크트리 단위).
   * `enabled === null`이면 override 행을 삭제해 defaultWorktreeEnabled를 상속한다.
   * @param {object} scope
   * @param {boolean|null} enabled
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function setWorktree(scope, enabled, options = {}) {
    const norm = normalizeScope(scope);
    if (enabled === null) {
      return applyPersisted((/** @type {Record<string, unknown>} */ draft) => {
        const profile = findProfile(draft, norm);
        if (profile === null) {
          return false;
        }
        const worktrees = /** @type {Array<Record<string, unknown>>} */ (profile.worktrees);
        const index = worktrees.findIndex((w) => w.worktreeId === norm.worktreeId);
        if (index === -1) {
          return false;
        }
        worktrees.splice(index, 1);
        return true;
      }, options.expectedRevision);
    }
    const on = enabled === true;
    const transform = (/** @type {Record<string, unknown>} */ draft) => {
      const profile = ensureProfile(draft, norm);
      let row = findWorktree(profile, norm.worktreeId);
      if (row === null) {
        row = { worktreeId: norm.worktreeId, enabled: false };
        /** @type {Array<Record<string, unknown>>} */ (profile.worktrees).push(row);
      }
      row.enabled = on;
    };
    return on ? applyPersisted(transform, options.expectedRevision) : applyImmediate(transform, options.expectedRevision);
  }

  /**
   * 터미널 scope override. `paneKey`가 필요하다.
   * `enabled === null`이면 override 행을 삭제해 워크트리 설정을 상속한다.
   * @param {object} scope
   * @param {boolean|null} enabled
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function setTerminal(scope, enabled, options = {}) {
    const norm = normalizeScope(scope);
    if (norm.paneKey === null) {
      throw new StoreError('invalid_scope', { message: 'setTerminal requires paneKey' });
    }
    if (enabled === null) {
      return applyPersisted((/** @type {Record<string, unknown>} */ draft) => {
        const profile = findProfile(draft, norm);
        if (profile === null) {
          return false;
        }
        const terminals = /** @type {Array<Record<string, unknown>>} */ (profile.terminals);
        const index = terminals.findIndex(
          (t) => t.worktreeId === norm.worktreeId && t.paneKey === norm.paneKey,
        );
        if (index === -1) {
          return false;
        }
        terminals.splice(index, 1);
        return true;
      }, options.expectedRevision);
    }
    const on = enabled === true;
    const transform = (/** @type {Record<string, unknown>} */ draft) => {
      const profile = ensureProfile(draft, norm);
      let row = findTerminal(profile, norm.worktreeId, norm.paneKey);
      if (row === null) {
        row = { worktreeId: norm.worktreeId, paneKey: norm.paneKey, enabled: false };
        /** @type {Array<Record<string, unknown>>} */ (profile.terminals).push(row);
      }
      row.enabled = on;
    };
    return on ? applyPersisted(transform, options.expectedRevision) : applyImmediate(transform, options.expectedRevision);
  }

  /**
   * paste 직전 attempt 예약. charged+1과 lastAttempt 저장이 성공한 뒤 attemptId를 반환한다.
   * 저장 실패 시 charged는 변하지 않고 reject한다(전송 금지).
   * @param {object} target
   * @param {number} epochId
   * @param {number} [at]
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<string>}
   */
  async function reserveAttempt(target, epochId, at, options = {}) {
    const norm = normalizeScope(target);
    const attemptId = randomId();
    const targetAt = typeof at === 'number' ? at : now();
    const runtimeId = typeof /** @type {any} */ (target).runtimeId === 'string' ? target.runtimeId : undefined;
    const ptyId = typeof /** @type {any} */ (target).ptyId === 'string' ? target.ptyId : undefined;
    const transform = (/** @type {Record<string, unknown>} */ draft) => {
      const profile = ensureProfile(draft, norm);
      const budget = ensureBudget(profile, norm.worktreeId, norm.paneKey);
      /** @type {LastAttempt} */
      const lastAttempt = { attemptId, epochId, phase: 'reserved', at: targetAt };
      if (runtimeId !== undefined) {
        lastAttempt.runtimeId = runtimeId;
      }
      if (ptyId !== undefined) {
        lastAttempt.ptyId = ptyId;
      }
      budget.lastAttempt = lastAttempt;
      budget.charged += 1;
    };
    await applyPersisted(transform, options.expectedRevision);
    return attemptId;
  }

  /**
   * 진행 중 attempt의 phase를 갱신한다(pasted|submitted).
   * @param {string} attemptId
   * @param {'pasted'|'submitted'} phase
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function recordAttempt(attemptId, phase, options = {}) {
    if (!RECORDABLE_PHASES.has(phase)) {
      throw new StoreError('invalid_phase', { message: `recordAttempt phase must be pasted|submitted` });
    }
    return applyPersisted((draft) => {
      const budget = locateBudgetByAttempt(draft, attemptId);
      if (budget === null || budget.lastAttempt === null) {
        return false;
      }
      budget.lastAttempt.phase = phase;
      return true;
    }, options.expectedRevision);
  }

  /**
   * attempt 성공 확정. 같은 attemptId를 두 번 호출해도 confirmed는 1회만 증가한다.
   * @param {string} attemptId
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function confirmAttempt(attemptId, options = {}) {
    return applyPersisted((draft) => {
      const budget = locateBudgetByAttempt(draft, attemptId);
      if (budget === null || budget.lastAttempt === null) {
        return false;
      }
      if (budget.lastAttempt.phase === 'confirmed') {
        return false;
      }
      budget.lastAttempt.phase = 'confirmed';
      budget.confirmed += 1;
      return true;
    }, options.expectedRevision);
  }

  /**
   * 명백한 무전송 거절(accepted:false, bytesWritten:0). phase가 reserved일 때만
   * charged를 1 복원하고 refused로 기록한다. 이미 pasted 이후면 무시한다.
   * @param {string} attemptId
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function refuseAttempt(attemptId, options = {}) {
    return applyPersisted((draft) => {
      const budget = locateBudgetByAttempt(draft, attemptId);
      if (budget === null || budget.lastAttempt === null) {
        return false;
      }
      if (budget.lastAttempt.phase !== 'reserved') {
        return false;
      }
      budget.lastAttempt.phase = 'refused';
      budget.charged = Math.max(0, budget.charged - 1);
      return true;
    }, options.expectedRevision);
  }

  /**
   * 전송 결과 확인 필요 표시. attemptId 또는 scope를 받는다.
   * @param {string|object} attemptIdOrScope
   * @param {string} [reason] 진단용 reason(영속 shape에는 필드가 없어 저장하지 않는다).
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function markReview(attemptIdOrScope, reason, options = {}) {
    void reason;
    // needsReview는 전송 차단 신호이므로 OFF/pause와 같이 메모리에 즉시 반영한다.
    if (typeof attemptIdOrScope === 'string') {
      const attemptId = attemptIdOrScope;
      const existing = locateBudgetByAttempt(state, attemptId);
      if (existing === null || existing.needsReview === true) {
        return createSnapshot();
      }
      return applyImmediate((draft) => {
        const budget = locateBudgetByAttempt(draft, attemptId);
        if (budget !== null) {
          budget.needsReview = true;
        }
      }, options.expectedRevision);
    }
    const norm = normalizeScope(attemptIdOrScope);
    const existing = locateBudget(state, norm);
    if (existing !== null && existing.needsReview === true) {
      return createSnapshot();
    }
    return applyImmediate((draft) => {
      const profile = ensureProfile(draft, norm);
      const budget = ensureBudget(profile, norm.worktreeId, norm.paneKey);
      budget.needsReview = true;
    }, options.expectedRevision);
  }

  /**
   * 확인 필요 해제(“다음 작업부터 재개”). charged는 유지한다.
   * @param {object} scope
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function clearReview(scope, options = {}) {
    const norm = normalizeScope(scope);
    return applyPersisted((draft) => {
      const budget = locateBudget(draft, norm);
      if (budget === null || budget.needsReview !== true) {
        return false;
      }
      budget.needsReview = false;
      return true;
    }, options.expectedRevision);
  }

  /**
   * charged/confirmed만 0으로 되돌린다. needsReview는 유지한다.
   * @param {object} scope
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<Snapshot>}
   */
  async function resetBudget(scope, options = {}) {
    const norm = normalizeScope(scope);
    return applyPersisted((draft) => {
      const budget = locateBudget(draft, norm);
      if (budget === null || (budget.charged === 0 && budget.confirmed === 0)) {
        return false;
      }
      budget.charged = 0;
      budget.confirmed = 0;
      return true;
    }, options.expectedRevision);
  }

  /**
   * target budget을 복사해 반환한다. 없으면 0/기본값.
   * @param {object} scope
   * @returns {BudgetView}
   */
  function getBudget(scope) {
    const norm = normalizeScope(scope);
    const budget = locateBudget(state, norm);
    if (budget === null) {
      return { charged: 0, confirmed: 0, needsReview: false, lastAttempt: null };
    }
    return {
      charged: budget.charged,
      confirmed: budget.confirmed,
      needsReview: budget.needsReview,
      lastAttempt: budget.lastAttempt === null ? null : structuredClone(budget.lastAttempt),
    };
  }

  /**
   * scope의 override 값을 복사해 반환한다. 행이 없으면 null(=상속).
   * `paneKey`가 없으면 terminal은 항상 null이다.
   * @param {object} scope
   * @returns {{worktree: boolean|null, terminal: boolean|null}}
   */
  function getOverrides(scope) {
    const norm = normalizeScope(scope);
    const profile = findProfile(state, norm);
    let worktree = null;
    let terminal = null;
    if (profile !== null) {
      const worktreeRow = findWorktree(profile, norm.worktreeId);
      if (worktreeRow !== null) {
        worktree = worktreeRow.enabled === true;
      }
      if (norm.paneKey !== null) {
        const terminalRow = findTerminal(profile, norm.worktreeId, norm.paneKey);
        if (terminalRow !== null) {
          terminal = terminalRow.enabled === true;
        }
      }
    }
    return { worktree, terminal };
  }

  /**
   * 순수 동기 정책 판정. §5.3/§6 우선순위를 따른다.
   * @param {object} scope
   * @param {{ttlMs?: number|null}} [options] 연속 상한을 TTL별로 고르기 위한 현재 TTL.
   * @returns {{allowed: boolean, reason: string|null}}
   */
  function isAllowedByPolicy(scope, options) {
    const norm = normalizeScope(scope);
    if (state.config.paused === true) {
      return { allowed: false, reason: 'GLOBAL_PAUSED' };
    }
    const profile = findProfile(state, norm);
    let worktreeEnabled = state.config.defaultWorktreeEnabled === true;
    if (profile !== null) {
      const worktree = findWorktree(profile, norm.worktreeId);
      if (worktree !== null) {
        worktreeEnabled = worktree.enabled === true;
      }
    }
    if (!worktreeEnabled) {
      return { allowed: false, reason: 'SCOPE_DISABLED' };
    }
    if (profile !== null && norm.paneKey !== null) {
      const terminal = findTerminal(profile, norm.worktreeId, norm.paneKey);
      if (terminal !== null && terminal.enabled === false) {
        return { allowed: false, reason: 'SCOPE_DISABLED' };
      }
    }
    const budget = profile === null ? null : findBudget(profile, norm.worktreeId, norm.paneKey);
    if (budget !== null && budget.needsReview === true) {
      return { allowed: false, reason: 'PARTIAL_OR_UNKNOWN_SEND' };
    }
    const max = capFor(options?.ttlMs ?? null, state.config);
    const charged = budget === null ? 0 : budget.charged;
    if (max !== 0 && charged >= max) {
      return { allowed: false, reason: 'LIMIT_REACHED' };
    }
    if (memoryPaused) {
      return { allowed: false, reason: 'STORAGE_FAILED' };
    }
    return { allowed: true, reason: null };
  }

  /**
   * 대기 중인 mutation/저장을 모두 비운다.
   * @returns {Promise<void>}
   */
  async function flush() {
    await queueTail;
  }

  return {
    load,
    snapshot,
    subscribe,
    updateConfig,
    setPaused,
    setWorktree,
    setTerminal,
    reserveAttempt,
    recordAttempt,
    confirmAttempt,
    refuseAttempt,
    markReview,
    clearReview,
    resetBudget,
    getBudget,
    getOverrides,
    isAllowedByPolicy,
    flush,
  };
}

/** @typedef {import('./config.mjs').Config} Config */
