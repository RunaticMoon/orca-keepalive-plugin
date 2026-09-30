/**
 * Keepalive epoch 완료시각 메모리 영속 모듈.
 *
 * 플러그인을 리로드하면 메모리의 keepalive 예약(epoch: 마지막 작업 완료 시각
 * doneAt)이 사라진다. 이 모듈은 그 epoch 정보를 Orca 플러그인 storage의 단일 key에
 * 저장하고 복원하기 위한 독립 모듈이다. coordinator 연결은 하지 않으며, host
 * storage는 주입된 `hostCall`로만 접근하고 import 시 I/O/타이머를 시작하지 않는다.
 *
 * 계약 요약:
 *  - 저장 형식: `{ version: 1, entries: { [key]: EpochRecord } }`.
 *  - load는 없음/형식 오류/호출 실패 시 빈 상태로 시작한다(throw 금지).
 *  - remember/forget/prune은 동기이며 throw하지 않는다. 변경 시 persist를 예약한다.
 *  - persist는 직렬화·coalesce되며 storage.set 실패는 삼키고 다음 변경 때 재시도한다.
 *  - load는 storage 결과 위에 현재 메모리를 덮어쓴다(메모리 우선). 단 load가 끝나기
 *    전 forget된 key는 제외하고, 병합 결과가 storage와 다르면 다시 persist한다.
 *
 * @module epoch-memory
 */

/** host storage의 단일 key. */
export const EPOCH_MEMORY_KEY = 'epochs-v1';

/** 저장 가능한 최대 항목 수. 초과 시 doneAt이 가장 오래된 것부터 제거한다. */
export const EPOCH_MEMORY_MAX_ENTRIES = 200;

/**
 * 영속되는 epoch 한 건.
 * @typedef {Object} EpochRecord
 * @property {string} worktreeId
 * @property {string} paneKey
 * @property {string} userDataKey
 * @property {string} profileId
 * @property {string} ptyId
 * @property {string|null} incarnationId
 * @property {number} doneAt
 * @property {number} savedAt
 */

/** 항상 비어있지 않은 string이어야 하는 필드. */
const REQUIRED_STRING_FIELDS = ['worktreeId', 'paneKey', 'userDataKey', 'profileId', 'ptyId'];

/** 비교 시 사용하는 전체 record 필드. incarnationId는 null을 허용한다. */
const RECORD_FIELDS = [...REQUIRED_STRING_FIELDS, 'incarnationId', 'doneAt', 'savedAt'];

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
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * raw 값을 EpochRecord로 검증·정규화한다. 실패 시 null.
 * 알려진 필드만 남겨 storage에 불필요한 필드가 섞이지 않게 한다.
 * @param {unknown} raw
 * @param {number} [savedAt] remember 경로에서 강제할 savedAt.
 * @returns {EpochRecord|null}
 */
function normalizeRecord(raw, savedAt) {
  if (!isPlainObject(raw)) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = raw[field];
    if (!isNonEmptyString(value)) {
      return null;
    }
    out[field] = value;
  }
  // incarnationId는 비어있지 않은 string 또는 null만 허용한다(undefined·''·그 외 거부).
  const incarnationId = raw.incarnationId;
  if (incarnationId !== null && !isNonEmptyString(incarnationId)) {
    return null;
  }
  out.incarnationId = incarnationId === null ? null : incarnationId;
  if (!isFiniteNumber(raw.doneAt)) {
    return null;
  }
  out.doneAt = raw.doneAt;
  const effectiveSavedAt = savedAt !== undefined ? savedAt : raw.savedAt;
  if (!isFiniteNumber(effectiveSavedAt)) {
    return null;
  }
  out.savedAt = effectiveSavedAt;
  return /** @type {EpochRecord} */ (out);
}

/**
 * 두 record가 모든 필드에서 같은지 비교한다(load 병합 diff용). null도 정확히 비교한다.
 * @param {EpochRecord} a
 * @param {EpochRecord} b
 * @returns {boolean}
 */
function sameRecord(a, b) {
  for (const field of RECORD_FIELDS) {
    if (a[field] !== b[field]) {
      return false;
    }
  }
  return true;
}

/**
 * 같은 내용(remember persist 생략 판단)인지 비교한다.
 * @param {EpochRecord} a
 * @param {EpochRecord} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  return a.doneAt === b.doneAt && a.ptyId === b.ptyId && a.incarnationId === b.incarnationId;
}

/**
 * @param {EpochRecord} record
 * @returns {EpochRecord}
 */
function copyRecord(record) {
  return { ...record };
}

/**
 * @param {Map<string, EpochRecord>} a
 * @param {Map<string, EpochRecord>} b
 * @returns {boolean} 두 entry 집합이 완전히 같은지.
 */
function sameEntrySet(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, record] of a) {
    const other = b.get(key);
    if (other === undefined || !sameRecord(record, other)) {
      return false;
    }
  }
  return true;
}

/**
 * keepalive epoch 완료시각 저장소를 만든다.
 *
 * @param {object} [options]
 * @param {(method: string, params: object) => Promise<any>} options.hostCall
 *   `hostCall('storage.get', {key})`는 `{value}` 또는 null/undefined를,
 *   `hostCall('storage.set', {key, value})`는 임의 결과를 반환한다.
 * @param {() => number} [options.now]
 * @returns {{
 *   load: () => Promise<void>,
 *   get: (key: string) => EpochRecord|null,
 *   remember: (key: string, record: Omit<EpochRecord, 'savedAt'>) => void,
 *   forget: (key: string) => void,
 *   prune: (maxAgeMs: number) => void,
 *   flush: () => Promise<void>,
 * }}
 */
export function createEpochMemory({ hostCall, now = Date.now } = {}) {
  if (typeof hostCall !== 'function') {
    throw new TypeError('createEpochMemory requires a hostCall function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  /** @type {Map<string, EpochRecord>} */
  let entries = new Map();
  let queueTail = Promise.resolve();
  let persistScheduled = false;
  let dirty = false;
  /** 미완료 load 수. 0보다 크면 load가 끝나기 전 변경으로 본다. */
  let outstandingLoads = 0;
  /**
   * load가 끝나기 전 삭제(forget/prune)된 key. load 결과가 삭제를 되살리지 않게 한다.
   * load 시작 전에 삭제했지만 저장에 실패한 key는 추적하지 않는다. coordinator는 빈
   * 메모리에서 bootstrap 때 1회만 load하므로 이 경로에 도달하지 않는다.
   */
  let deletedKeys = new Set();

  /**
   * task를 단일 직렬 queue에 넣는다. 이전 task 실패는 다음 task를 막지 않는다.
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
   * 현재 메모리 상태를 storage value로 복사한다.
   * `__proto__` 같은 key가 prototype을 건드리지 않도록 null-prototype 객체를 쓴다.
   * @returns {{version: number, entries: Record<string, EpochRecord>}}
   */
  function buildValue() {
    /** @type {Record<string, EpochRecord>} */
    const out = Object.create(null);
    for (const [key, record] of entries) {
      out[key] = copyRecord(record);
    }
    return { version: 1, entries: out };
  }

  /**
   * persist를 예약한다. 이미 예약된 작업이 있으면 그 작업이 최신 상태를 쓰도록 합쳐진다.
   * @returns {void}
   */
  function schedulePersist() {
    dirty = true;
    if (persistScheduled) {
      return;
    }
    persistScheduled = true;
    enqueue(async () => {
      while (dirty) {
        dirty = false;
        const value = buildValue();
        try {
          await hostCall('storage.set', { key: EPOCH_MEMORY_KEY, value });
        } catch {
          // 저장 실패는 삼킨다. 다음 변경 때 재시도한다.
          dirty = true;
          break;
        }
      }
      persistScheduled = false;
    });
  }

  /**
   * MAX_ENTRIES를 넘으면 doneAt이 가장 오래된 항목부터 제거한다.
   * @returns {boolean} 제거가 있었는지.
   */
  function enforceMaxEntries() {
    if (entries.size <= EPOCH_MEMORY_MAX_ENTRIES) {
      return false;
    }
    const rows = [...entries.entries()].sort((a, b) => a[1].doneAt - b[1].doneAt);
    const removeCount = rows.length - EPOCH_MEMORY_MAX_ENTRIES;
    for (let index = 0; index < removeCount; index += 1) {
      entries.delete(rows[index][0]);
      if (outstandingLoads > 0) {
        deletedKeys.add(rows[index][0]);
      }
    }
    return true;
  }

  /**
   * 저장 value에서 유효한 항목만 적재한다. 형식 오류는 버린다.
   * @param {unknown} value
   * @returns {Map<string, EpochRecord>}
   */
  function parseLoadedValue(value) {
    /** @type {Map<string, EpochRecord>} */
    const loaded = new Map();
    if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.entries)) {
      return loaded;
    }
    const rawEntries = /** @type {Record<string, unknown>} */ (value.entries);
    for (const key of Object.keys(rawEntries)) {
      if (!isNonEmptyString(key)) {
        continue;
      }
      const record = normalizeRecord(rawEntries[key]);
      if (record !== null) {
        loaded.set(key, record);
      }
    }
    return loaded;
  }

  /**
   * host storage에서 epoch 메모리를 읽어 적재한다.
   * 없음/형식 오류/호출 실패는 빈 상태로 처리하며 throw하지 않는다.
   * storage 결과 위에 현재 메모리를 덮어쓰고(메모리 우선), load가 끝나기 전
   * forget된 key는 storage에서 왔더라도 제외한다. 병합 결과가 storage와 다르면
   * (또는 상한 초과로 잘라냈으면) persist를 예약한다.
   * @returns {Promise<void>}
   */
  function load() {
    outstandingLoads += 1;
    return enqueue(async () => {
      /** @type {Map<string, EpochRecord>} */
      let loaded = new Map();
      try {
        const result = await hostCall('storage.get', { key: EPOCH_MEMORY_KEY });
        const raw = result === null || result === undefined ? undefined : result.value;
        if (raw !== undefined && raw !== null) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          loaded = parseLoadedValue(parsed);
        }
      } catch {
        loaded = new Map();
      }

      // 메모리 우선: storage 결과 위에 현재 메모리 항목을 덮어쓴다.
      const merged = new Map(loaded);
      for (const [key, record] of entries) {
        merged.set(key, copyRecord(record));
      }
      // load가 끝나기 전 forget된 key는 storage에서 왔더라도 제외한다.
      for (const key of deletedKeys) {
        merged.delete(key);
      }

      const changedVsStorage = !sameEntrySet(loaded, merged);
      entries = merged;
      outstandingLoads -= 1;
      if (outstandingLoads === 0) {
        deletedKeys = new Set();
      }
      if (changedVsStorage) {
        schedulePersist();
      }
      if (enforceMaxEntries()) {
        // 병합 뒤 상한 초과로 잘라낸 경우도 storage와 달라졌으므로 저장한다.
        schedulePersist();
      }
    });
  }

  /**
   * key의 epoch 복사본을 반환한다. 없으면 null.
   * @param {string} key
   * @returns {EpochRecord|null}
   */
  function get(key) {
    if (!isNonEmptyString(key)) {
      return null;
    }
    const record = entries.get(key);
    return record === undefined ? null : copyRecord(record);
  }

  /**
   * epoch를 저장한다. 검증 실패·잘못된 key는 조용히 무시한다(throw 금지).
   * 같은 내용(doneAt·ptyId·incarnationId 동일)이면 persist를 예약하지 않는다.
   * @param {string} key
   * @param {Omit<EpochRecord, 'savedAt'>} record
   * @returns {void}
   */
  function remember(key, record) {
    if (!isNonEmptyString(key)) {
      return;
    }
    const normalized = normalizeRecord(record, now());
    if (normalized === null) {
      return;
    }
    const existing = entries.get(key);
    if (existing !== undefined && sameContent(existing, normalized)) {
      // savedAt만 갱신하고 persist는 생략한다.
      entries.set(key, normalized);
      return;
    }
    entries.set(key, normalized);
    enforceMaxEntries();
    schedulePersist();
  }

  /**
   * key의 epoch를 삭제한다. 없으면 no-op.
   * @param {string} key
   * @returns {void}
   */
  function forget(key) {
    if (!isNonEmptyString(key)) {
      return;
    }
    const existed = entries.delete(key);
    if (outstandingLoads > 0) {
      // load가 끝나기 전이면 아직 메모리에 없던 key라도 load 결과가 되살리지 않게 한다.
      deletedKeys.add(key);
    }
    if (!existed) {
      return;
    }
    schedulePersist();
  }

  /**
   * `now() - doneAt >= maxAgeMs`인 항목을 제거한다. 변경이 있으면 persist를 예약한다.
   * @param {number} maxAgeMs
   * @returns {void}
   */
  function prune(maxAgeMs) {
    const at = now();
    let changed = false;
    for (const [key, record] of [...entries]) {
      if (at - record.doneAt >= maxAgeMs) {
        entries.delete(key);
        if (outstandingLoads > 0) {
          deletedKeys.add(key);
        }
        changed = true;
      }
    }
    if (changed) {
      schedulePersist();
    }
  }

  /**
   * 대기 중인 persist가 모두 끝날 때까지 기다린다. 실패해도 throw하지 않는다.
   * @returns {Promise<void>}
   */
  async function flush() {
    await queueTail;
  }

  return { load, get, remember, forget, prune, flush };
}
