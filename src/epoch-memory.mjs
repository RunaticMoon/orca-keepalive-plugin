/**
 * Keepalive epoch 완료시각 메모리 영속 모듈.
 *
 * 플러그인을 리로드하면 메모리의 keepalive 예약(epoch: 마지막 작업 완료 시각
 * doneAt)이 사라진다. 이 모듈은 그 epoch 정보를 Orca 플러그인 storage의 단일 key에
 * 저장하고 복원하기 위한 독립 모듈이다. coordinator 연결은 하지 않으며, host
 * storage는 주입된 `hostCall`로만 접근하고 import 시 I/O/타이머를 시작하지 않는다.
 *
 * 계약 요약(§2-4):
 *  - 저장 형식: `{ version: 2, entries: { [key]: EpochMemoryRecordV2 } }`.
 *    storage key는 기존 'epochs-v1'을 유지하고 envelope version만 2로 올린다.
 *  - 읽기는 version 1과 2를 모두 지원한다. version 1 레코드는 기존 규칙으로 읽어
 *    kind='armed'로 취급하고 basisAt이 없으면 doneAt을 쓴다. v1에는 TTL 정보가
 *    없으므로 expiresAt을 null로 두고 만료 시각·원인을 추정하지 않는다.
 *  - kind='armed'는 복원 가능한 예약, kind='history'는 표시 전용이다. history는
 *    전송 예약으로 복원하지 않는다. kind='hold'는 대기(waiting/blocked) 중 재시작
 *    복원용 예약으로 expiresAt이 필수이며 expiredAt은 null이어야 한다. expiredAt !==
 *    null이면 반드시 history이며 expiresAt과 같은 값이어야 한다.
 *  - load는 없음/형식 오류/호출 실패 시 빈 상태로 시작한다(throw 금지).
 *  - remember/forget/prune은 동기이며 throw하지 않는다. 변경 시 persist를 예약한다.
 *  - persist는 직렬화·coalesce되며 storage.set 실패는 삼키고 다음 변경 때 재시도한다.
 *  - load는 storage 결과 위에 현재 메모리를 덮어쓴다(메모리 우선). 단 load가 끝나기
 *    전 forget된 key는 제외하고, 병합 결과가 storage와 다르면 다시 persist한다.
 *
 * @module epoch-memory
 */

import {
  EPOCH_MEMORY_VERSION,
  CACHE_HISTORY_RETENTION_MS,
  EXPIRE_CAUSE_REASONS,
} from './contracts.mjs';

/** host storage의 단일 key. 형식 호환을 위해 유지한다. */
export const EPOCH_MEMORY_KEY = 'epochs-v1';

/** 저장 가능한 최대 항목 수. 초과 시 doneAt이 가장 오래된 것부터 제거한다. */
export const EPOCH_MEMORY_MAX_ENTRIES = 200;

/** 직렬화 결과의 최대 크기(byte). 초과 시 doneAt이 오래된 것부터 레코드 단위로 제거한다. */
export const EPOCH_MEMORY_MAX_BYTES = 256 * 1024;

/**
 * 영속되는 epoch 한 건(§2-4 EpochMemoryRecordV2).
 * @typedef {Object} EpochRecord
 * @property {'armed'|'history'|'hold'} kind armed=복원 가능한 예약, history=표시 전용,
 *   hold=대기 중 재시작 복원용 예약(expiresAt 필수, expiredAt은 null).
 * @property {string} userDataKey
 * @property {string} profileId
 * @property {string} worktreeId
 * @property {string} paneKey
 * @property {string} ptyId
 * @property {string|null} incarnationId 재시작에 따른 변경은 허용한다.
 * @property {number} doneAt
 * @property {number|null} basisAt 없으면 doneAt을 쓴다.
 * @property {number|null} expiresAt 예상 만료 시각(ms). TTL 정보가 없으면 null.
 * @property {string|null} lastBlockReason EXPIRE_CAUSE_REASONS 중 하나 또는 null.
 * @property {number|null} expiredAt null이 아니면 expiresAt과 같은 값이다.
 * @property {number} savedAt 저장 시각(ms). 갱신으로 보존 기간을 연장하지 않는다.
 */

/** 항상 비어있지 않은 string이어야 하는 필드. */
const REQUIRED_STRING_FIELDS = ['userDataKey', 'profileId', 'worktreeId', 'paneKey', 'ptyId'];

/** 비교 시 사용하는 전체 record 필드. incarnationId 등 null을 허용한다. */
const RECORD_FIELDS = [
  'kind',
  ...REQUIRED_STRING_FIELDS,
  'incarnationId',
  'doneAt',
  'basisAt',
  'expiresAt',
  'lastBlockReason',
  'expiredAt',
  'savedAt',
];

const ALLOWED_KINDS = ['armed', 'history', 'hold'];

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
 * UTF-8 byte 길이. Buffer가 없는 환경에서는 문자열 길이로 대체한다.
 * @param {string} text
 * @returns {number}
 */
function utf8ByteLength(text) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(text, 'utf8');
  }
  return text.length;
}

/**
 * 공통 identity 필드(문자열·incarnationId·doneAt)를 검증해 복사한다. 실패 시 null.
 * @param {Record<string, unknown>} raw
 * @returns {{userDataKey:string,profileId:string,worktreeId:string,paneKey:string,ptyId:string,incarnationId:string|null,doneAt:number}|null}
 */
function normalizeIdentity(raw) {
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
  return /** @type {any} */ (out);
}

/**
 * version 2 raw 값을 EpochRecord로 검증·정규화한다. 실패 시 null.
 * 잘못된 kind는 armed로 추정하지 않고 레코드 전체를 버린다.
 * kind='hold'는 expiresAt이 필수이고 expiredAt은 null이어야 한다.
 * @param {unknown} raw
 * @param {number} [savedAt] remember 경로에서 강제할 savedAt.
 * @returns {EpochRecord|null}
 */
function normalizeV2Record(raw, savedAt) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const kind = raw.kind;
  if (!ALLOWED_KINDS.includes(/** @type {string} */ (kind))) {
    return null;
  }
  const identity = normalizeIdentity(raw);
  if (identity === null) {
    return null;
  }
  const doneAt = identity.doneAt;

  // basisAt: null/undefined 또는 유한수이면서 doneAt 이하만 허용한다.
  let basisAt = null;
  if (raw.basisAt !== null && raw.basisAt !== undefined) {
    if (!isFiniteNumber(raw.basisAt) || raw.basisAt > doneAt) {
      return null;
    }
    basisAt = raw.basisAt;
  }

  // expiresAt: null/undefined 또는 유한수이면서 doneAt보다 커야 한다.
  let expiresAt = null;
  if (raw.expiresAt !== null && raw.expiresAt !== undefined) {
    if (!isFiniteNumber(raw.expiresAt) || raw.expiresAt <= doneAt) {
      return null;
    }
    expiresAt = raw.expiresAt;
  }
  // history는 만료 시각이 있어야 24시간 보존 경계를 계산할 수 있다.
  if (kind === 'history' && expiresAt === null) {
    return null;
  }
  // hold는 대기 중 재시작 복원에 만료 시각이 필수다(전환·보존 경계 계산).
  if (kind === 'hold' && expiresAt === null) {
    return null;
  }

  // expiredAt: null 또는 expiresAt과 같은 유한수. 값이 있으면 kind는 반드시 history다.
  // (armed/hold는 값이 있으면 거부된다.)
  let expiredAt = null;
  if (raw.expiredAt !== null && raw.expiredAt !== undefined) {
    if (
      kind !== 'history' ||
      expiresAt === null ||
      !isFiniteNumber(raw.expiredAt) ||
      raw.expiredAt !== expiresAt
    ) {
      return null;
    }
    expiredAt = raw.expiredAt;
  }

  // 허용 밖 reason은 null로 정규화한다(레코드는 유지).
  const lastBlockReason =
    typeof raw.lastBlockReason === 'string' && EXPIRE_CAUSE_REASONS.includes(raw.lastBlockReason)
      ? raw.lastBlockReason
      : null;

  const effectiveSavedAt = savedAt !== undefined ? savedAt : raw.savedAt;
  if (!isFiniteNumber(effectiveSavedAt)) {
    return null;
  }

  return {
    kind: /** @type {'armed'|'history'|'hold'} */ (kind),
    userDataKey: identity.userDataKey,
    profileId: identity.profileId,
    worktreeId: identity.worktreeId,
    paneKey: identity.paneKey,
    ptyId: identity.ptyId,
    incarnationId: identity.incarnationId,
    doneAt,
    basisAt,
    expiresAt,
    lastBlockReason,
    expiredAt,
    savedAt: effectiveSavedAt,
  };
}

/**
 * version 1 raw 값을 기존 규칙으로 검증하고 v2 레코드로 변환한다. 실패 시 null.
 * basisAt이 없거나 유효하지 않으면 doneAt을 쓰고, expiresAt은 추정하지 않고 null로 둔다.
 * @param {unknown} raw
 * @param {number} [savedAt] 강제할 savedAt(load에서는 undefined).
 * @returns {EpochRecord|null}
 */
function normalizeV1Record(raw, savedAt) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const identity = normalizeIdentity(raw);
  if (identity === null) {
    return null;
  }
  const doneAt = identity.doneAt;
  const basisAt =
    raw.basisAt !== undefined && isFiniteNumber(raw.basisAt) && raw.basisAt <= doneAt
      ? raw.basisAt
      : doneAt;
  const effectiveSavedAt = savedAt !== undefined ? savedAt : raw.savedAt;
  if (!isFiniteNumber(effectiveSavedAt)) {
    return null;
  }
  return {
    kind: 'armed',
    userDataKey: identity.userDataKey,
    profileId: identity.profileId,
    worktreeId: identity.worktreeId,
    paneKey: identity.paneKey,
    ptyId: identity.ptyId,
    incarnationId: identity.incarnationId,
    doneAt,
    basisAt,
    expiresAt: null,
    lastBlockReason: null,
    expiredAt: null,
    savedAt: effectiveSavedAt,
  };
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
 * 같은 내용(remember persist 생략 판단)인지 비교한다. kind와 새 시각·원인 필드를 포함한다.
 * savedAt은 보존 기간을 연장하지 않으므로 비교에서 제외한다.
 * @param {EpochRecord} a
 * @param {EpochRecord} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  return (
    a.kind === b.kind &&
    a.doneAt === b.doneAt &&
    a.basisAt === b.basisAt &&
    a.expiresAt === b.expiresAt &&
    a.lastBlockReason === b.lastBlockReason &&
    a.expiredAt === b.expiredAt &&
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId
  );
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
 *   remember: (key: string, record: Partial<EpochRecord>) => void,
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
   * load가 끝나기 전 삭제(forget/prune/상한)된 key. load 결과가 삭제를 되살리지 않게 한다.
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
    return { version: EPOCH_MEMORY_VERSION, entries: out };
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
   * key를 내부에서 제거하고, load 진행 중이면 tombstone으로 기록한다.
   * @param {string} key
   * @returns {void}
   */
  function deleteEntry(key) {
    entries.delete(key);
    if (outstandingLoads > 0) {
      deletedKeys.add(key);
    }
  }

  /**
   * doneAt이 가장 오래된 entry를 제거한다.
   * @returns {boolean} 제거가 있었는지.
   */
  function removeOldest() {
    let oldestKey = null;
    let oldestDoneAt = Number.POSITIVE_INFINITY;
    for (const [key, record] of entries) {
      if (record.doneAt < oldestDoneAt) {
        oldestDoneAt = record.doneAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) {
      return false;
    }
    deleteEntry(oldestKey);
    return true;
  }

  /**
   * 항목 수(EPOCH_MEMORY_MAX_ENTRIES)와 직렬화 크기(EPOCH_MEMORY_MAX_BYTES) 상한을
   * 지킨다. 초과분은 doneAt이 가장 오래된 것부터 레코드 단위로 제거한다.
   * @returns {boolean} 제거가 있었는지.
   */
  function enforceLimits() {
    let changed = false;
    while (entries.size > EPOCH_MEMORY_MAX_ENTRIES) {
      if (!removeOldest()) {
        break;
      }
      changed = true;
    }
    while (
      entries.size > 0 &&
      utf8ByteLength(JSON.stringify(buildValue())) > EPOCH_MEMORY_MAX_BYTES
    ) {
      if (!removeOldest()) {
        break;
      }
      changed = true;
    }
    return changed;
  }

  /**
   * 저장 value에서 유효한 항목만 적재한다. 형식 오류·미지원 version은 버린다.
   * @param {unknown} value
   * @returns {Map<string, EpochRecord>}
   */
  function parseLoadedValue(value) {
    /** @type {Map<string, EpochRecord>} */
    const loaded = new Map();
    if (!isPlainObject(value) || !isPlainObject(value.entries)) {
      return loaded;
    }
    /** @type {((raw: unknown, savedAt?: number) => EpochRecord|null)|null} */
    let normalize = null;
    if (value.version === 1) {
      normalize = normalizeV1Record;
    } else if (value.version === EPOCH_MEMORY_VERSION) {
      normalize = normalizeV2Record;
    }
    if (normalize === null) {
      return loaded;
    }
    const rawEntries = /** @type {Record<string, unknown>} */ (value.entries);
    for (const key of Object.keys(rawEntries)) {
      if (!isNonEmptyString(key)) {
        continue;
      }
      const record = normalize(rawEntries[key]);
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
      if (enforceLimits()) {
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
   * kind를 생략하면 'armed'로 취급한다(기존 호출 호환).
   * 같은 내용(kind·시각·원인·ptyId·incarnationId 동일)이면 persist를 예약하지 않는다.
   * @param {string} key
   * @param {Partial<EpochRecord>} record
   * @returns {void}
   */
  function remember(key, record) {
    if (!isNonEmptyString(key) || !isPlainObject(record)) {
      return;
    }
    const source = record.kind === undefined ? { ...record, kind: 'armed' } : record;
    const normalized = normalizeV2Record(source, now());
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
    enforceLimits();
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
   * 보존 기간이 지난 레코드를 제거하고, 만료된 v2 armed/hold를 history로 전환한다.
   * - armed: `now() - doneAt >= maxAgeMs`이면 제거(기존 규칙). 단 expiresAt이 이미
   *   지났으면 삭제 전에 kind='history', expiredAt=expiresAt으로 전환하며, 그 이력이
   *   24시간 보존을 이미 넘겼으면 바로 제거한다.
   * - hold: armed와 같은 분기로 처리한다. expiresAt이 지났으면 history로 전환하고
   *   24시간 보존을 넘겼으면 제거한다.
   * - history: `now() >= expiresAt + CACHE_HISTORY_RETENTION_MS`이면 제거한다.
   * savedAt 갱신은 보존 기간을 연장하지 않는다.
   * @param {number} maxAgeMs
   * @returns {void}
   */
  function prune(maxAgeMs) {
    const at = now();
    const hasMaxAge = typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs);
    let changed = false;
    for (const [key, record] of [...entries]) {
      if (record.kind === 'history') {
        if (record.expiresAt !== null && at >= record.expiresAt + CACHE_HISTORY_RETENTION_MS) {
          deleteEntry(key);
          changed = true;
        }
        continue;
      }
      // armed/hold: 실제 만료가 지났으면 삭제보다 표시 이력 전환을 우선한다.
      if (record.expiresAt !== null && at >= record.expiresAt) {
        if (at >= record.expiresAt + CACHE_HISTORY_RETENTION_MS) {
          deleteEntry(key);
        } else {
          entries.set(key, { ...record, kind: 'history', expiredAt: record.expiresAt });
        }
        changed = true;
        continue;
      }
      if (hasMaxAge && at - record.doneAt >= maxAgeMs) {
        deleteEntry(key);
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
