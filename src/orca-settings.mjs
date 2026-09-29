/**
 * Orca 활성 프로필의 prompt cache 타이머 설정을 **읽기 전용**으로 반환한다.
 *
 * DESIGN.md §4.4, §6의 `orca-settings` 계약을 구현한다. 이 모듈은 Orca 파일에
 * 절대 쓰지 않는다: 인덱스·프로필 JSON은 읽기만 하고, SQLite는
 * `readOnly: true`로만 열며 `journal_mode`/checkpoint/VACUUM/DDL을 실행하지 않는다.
 * `readTimerSettings`는 어떤 예외도 던지지 않는다. 모든 실패는
 * `{known:false, reason, readAt}`로 접는다.
 *
 * 절차(§4.4):
 * 1. `<userData>/orca-profile-index.json`(≤1 MiB)에서 activeProfileId를 검증한다.
 * 2. `profiles/<id>/profile-state.db`가 있으면 SQLite(권위 저장소)를 읽는다.
 *    - `PRAGMA user_version === 3`, meta `profile_id` 일치, settings 문서 1행,
 *      `domain_version === 1`, revision 양의 안전정수, SHA-256(payload)=content_hash.
 *    - DB가 있으면 JSON으로 fallback하지 않는다. main 파일이 없어도 같은 경로의
 *      `-wal`/`-shm`/`-journal` 형제 파일이 하나라도 있으면 `db_error`로 접는다.
 * 3. DB family 파일이 전혀 없을 때만 `profiles/<id>/orca-data.json`(≤32 MiB)의
 *    `.settings`를 읽는다. 루트 legacy `orca-data.json`이나 `.bak`는 자동 채택하지 않는다.
 * 4. 읽기 전후 index를 다시 읽어 activeProfileId가 바뀌면 `profile_changed`로 폐기한다.
 * 5. `promptCacheTimerEnabled`는 boolean만 수락(키 없음→false),
 *    `promptCacheTtlMs`는 키 없음→300000, 300000/3600000 외 값은 `payload_invalid`.
 *
 * settings payload의 다른 값은 반환·로그하지 않는다.
 *
 * @module orca-settings
 */

import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { ALLOWED_TTLS } from './contracts.mjs';

/** @typedef {import('./contracts.mjs').SettingsSnapshot} SettingsSnapshot */

/** 활성 프로필 index 파일 이름. `profile-storage-paths.ts:11`. */
const INDEX_FILE_NAME = 'orca-profile-index.json';
/** 프로필 디렉터리 이름. `profile-storage-paths.ts:13`. */
const PROFILES_DIRECTORY_NAME = 'profiles';
/** 프로필 SQLite 파일 이름. `profile-state-storage-paths.ts:3`. */
const PROFILE_STATE_DATABASE_FILE_NAME = 'profile-state.db';
/** 프로필 legacy JSON 파일 이름. `profile-state-storage-paths.ts:11`. */
const PROFILE_DATA_FILE_NAME = 'orca-data.json';
/**
 * DB family 접미사. 원본 `profile-state-storage-classification.ts:7`과 동일.
 * main 파일이 없어도 형제 파일이 남아 있으면 DB 권위 상태로 본다(fail-closed).
 */
const DATABASE_FAMILY_SUFFIXES = ['-wal', '-shm', '-journal'];

/** index 최대 크기(1 MiB). §4.4 */
const MAX_INDEX_BYTES = 1024 * 1024;
/** settings 문서 payload 최대 크기(4 MiB). §4.4 */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** legacy 프로필 JSON 최대 크기(32 MiB). §4.4 */
const MAX_PROFILE_JSON_BYTES = 32 * 1024 * 1024;

/** `profile-state-database-schema.ts:8` */
const PROFILE_STATE_DATABASE_SCHEMA_VERSION = 3;
/** `profile-state-database-schema.ts:9` */
const PROFILE_STATE_DOCUMENT_VERSION = 1;
/** `profile-state-database-schema.ts:11` */
const PROFILE_STATE_META_PROFILE_ID = 'profile_id';
/** `profile-state-active-location.ts:28` */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** `profile-state-document-validation.ts:80` */
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Orca 기본 TTL. `default-global-settings.ts:177` */
const DEFAULT_TTL_MS = 300000;

const ENABLED_KEY = 'promptCacheTimerEnabled';
const TTL_KEY = 'promptCacheTtlMs';

const SETTINGS_DOCUMENT_SQL =
  'SELECT domain, payload, domain_version, revision, updated_at, content_hash FROM profile_state_documents WHERE domain = ?';

/**
 * 값이 배열이 아닌 non-null object인지 확인한다. JSON object 판정에 쓴다.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ENOENT 여부. 다른 fs 오류와 구분해 index_missing/json_missing을 만든다.
 * @param {unknown} error
 * @returns {boolean}
 */
function isEnoent(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * readFile 결과(string|Buffer|Uint8Array)의 UTF-8 byte 길이를 구한다.
 * @param {unknown} raw
 * @returns {number} 판단 불가면 -1.
 */
function byteLengthOf(raw) {
  if (typeof raw === 'string') {
    return Buffer.byteLength(raw, 'utf8');
  }
  if (isRecord(raw) && typeof raw.byteLength === 'number') {
    return raw.byteLength;
  }
  return -1;
}

/**
 * readFile 결과를 UTF-8 텍스트로 변환한다.
 * @param {unknown} raw
 * @returns {string|null} 텍스트가 아니면 null.
 */
function textOf(raw) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('utf8');
  }
  return null;
}

/**
 * 파일을 읽어 크기 상한까지 검사한 텍스트를 만든다.
 * @param {(path: string) => Promise<unknown>} readFile
 * @param {string} path
 * @param {number} maxBytes
 * @returns {Promise<{ok:true, text:string}|{ok:false, reason:'missing'|'invalid'|'too_large'}>}
 */
async function readText(readFile, path, maxBytes) {
  /** @type {unknown} */
  let raw;
  try {
    raw = await readFile(path);
  } catch (error) {
    return { ok: false, reason: isEnoent(error) ? 'missing' : 'invalid' };
  }

  const size = byteLengthOf(raw);
  if (size < 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (size > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  const text = textOf(raw);
  if (text === null) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, text };
}

/**
 * main DB 파일이 없을 때 같은 경로의 `-wal`/`-shm`/`-journal` 형제 파일 존재를 확인한다.
 * 형제 파일이 하나라도 있거나 stat 판정 자체가 불가하면 true(fail-closed)를 돌려준다.
 * @param {(path: string) => Promise<unknown>} stat
 * @param {string} databasePath
 * @returns {Promise<boolean>}
 */
async function hasDatabaseFamilyFile(stat, databasePath) {
  for (const suffix of DATABASE_FAMILY_SUFFIXES) {
    try {
      await stat(`${databasePath}${suffix}`);
      return true;
    } catch (error) {
      if (!isEnoent(error)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * index JSON에서 검증된 activeProfileId를 뽑는다.
 * @param {string} text
 * @returns {{ok:true, activeProfileId:string}|{ok:false, reason:'index_invalid'|'profile_invalid'}}
 */
function parseActiveProfileId(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'index_invalid' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) {
    return { ok: false, reason: 'index_invalid' };
  }
  const activeProfileId = parsed.activeProfileId;
  if (typeof activeProfileId !== 'string' || !PROFILE_ID_PATTERN.test(activeProfileId)) {
    return { ok: false, reason: 'profile_invalid' };
  }
  const exists = parsed.profiles.some(
    (profile) => isRecord(profile) && profile.id === activeProfileId,
  );
  if (!exists) {
    return { ok: false, reason: 'profile_invalid' };
  }
  return { ok: true, activeProfileId };
}

/**
 * settings 객체에서 timer 두 필드만 해석한다. 다른 값은 건드리지 않는다.
 * @param {unknown} settings
 * @returns {{ok:true, enabled:boolean, ttlMs:number}|{ok:false, reason:'payload_invalid'}}
 */
function interpretSettings(settings) {
  if (!isRecord(settings)) {
    return { ok: false, reason: 'payload_invalid' };
  }

  let enabled = false;
  if (Object.prototype.hasOwnProperty.call(settings, ENABLED_KEY)) {
    const value = settings[ENABLED_KEY];
    if (typeof value !== 'boolean') {
      return { ok: false, reason: 'payload_invalid' };
    }
    enabled = value;
  }

  let ttlMs = DEFAULT_TTL_MS;
  if (Object.prototype.hasOwnProperty.call(settings, TTL_KEY)) {
    const value = settings[TTL_KEY];
    if (typeof value !== 'number' || !ALLOWED_TTLS.includes(value)) {
      return { ok: false, reason: 'payload_invalid' };
    }
    ttlMs = value;
  }

  return { ok: true, enabled, ttlMs };
}

/**
 * 열린 SQLite 연결에서 settings 문서를 읽고 검증한다. 예외를 던지지 않는다.
 * `journal_mode`/checkpoint/쓰기를 하지 않고 짧은 read transaction만 연다.
 * @param {any} db 열린 DatabaseSync(또는 동형 fake).
 * @param {string} profileId
 * @returns {{ok:true, enabled:boolean, ttlMs:number, revision:number}|{ok:false, reason:string}}
 */
function readSettingsFromDatabase(db, profileId) {
  let storedVersion;
  try {
    const versionRow = db.prepare('PRAGMA user_version').get();
    storedVersion = versionRow ? Number(Object.values(versionRow)[0]) : 0;
  } catch {
    return { ok: false, reason: 'db_error' };
  }
  if (storedVersion !== PROFILE_STATE_DATABASE_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_unsupported' };
  }

  let storedProfileId;
  try {
    const metaRow = db
      .prepare('SELECT value FROM profile_state_meta WHERE key = ?')
      .get(PROFILE_STATE_META_PROFILE_ID);
    storedProfileId = isRecord(metaRow) && typeof metaRow.value === 'string' ? metaRow.value : undefined;
  } catch {
    return { ok: false, reason: 'db_error' };
  }
  if (storedProfileId === undefined || storedProfileId !== profileId) {
    return { ok: false, reason: 'profile_mismatch' };
  }

  /** @type {unknown} */
  let row;
  try {
    db.exec('BEGIN');
    try {
      row = db.prepare(SETTINGS_DOCUMENT_SQL).get('settings');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // rollback 실패는 무시하고 원래 오류를 db_error로 접는다.
      }
      throw error;
    }
  } catch {
    return { ok: false, reason: 'db_error' };
  }

  if (!isRecord(row)) {
    return { ok: false, reason: 'document_missing' };
  }
  if (row.domain !== 'settings') {
    return { ok: false, reason: 'document_missing' };
  }
  if (row.domain_version !== PROFILE_STATE_DOCUMENT_VERSION) {
    return { ok: false, reason: 'schema_unsupported' };
  }
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    return { ok: false, reason: 'db_error' };
  }

  const payload = row.payload;
  if (typeof payload !== 'string') {
    return { ok: false, reason: 'payload_invalid' };
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (typeof row.content_hash !== 'string' || !CONTENT_HASH_PATTERN.test(row.content_hash)) {
    return { ok: false, reason: 'hash_mismatch' };
  }
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (hash !== row.content_hash) {
    return { ok: false, reason: 'hash_mismatch' };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'payload_invalid' };
  }

  const settings = interpretSettings(parsed);
  if (!settings.ok) {
    return settings;
  }
  return { ok: true, enabled: settings.enabled, ttlMs: settings.ttlMs, revision: row.revision };
}

/**
 * `node:sqlite`를 dynamic import해 읽기 전용 DatabaseSync를 연다.
 * import 실패(또는 DatabaseSync 부재)는 `code='sqlite_unavailable'` 오류로 알린다.
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function defaultOpenSqlite(path) {
  /** @type {any} */
  let module;
  try {
    module = await import('node:sqlite');
  } catch {
    throw sqliteUnavailable('node:sqlite module is unavailable');
  }
  const DatabaseSync = module?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    throw sqliteUnavailable('node:sqlite DatabaseSync is unavailable');
  }
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * `sqlite_unavailable` reason을 전달하기 위한 표식 오류를 만든다.
 * @param {string} message
 * @returns {Error & {code:string}}
 */
function sqliteUnavailable(message) {
  return /** @type {Error & {code:string}} */ (Object.assign(new Error(message), { code: 'sqlite_unavailable' }));
}

/**
 * 열린 연결을 조용히 닫는다. close 자체의 실패는 무시한다.
 * @param {any} db
 */
function closeQuietly(db) {
  try {
    db?.close?.();
  } catch {
    // close 실패는 결과에 영향을 주지 않는다.
  }
}

/**
 * 활성 프로필의 prompt cache 타이머 설정을 읽는다. 절대 throw하지 않는다.
 *
 * @param {Object} [options]
 * @param {string} options.userDataPath Orca userData 디렉터리 절대 경로.
 * @param {typeof fsPromises.readFile} [options.readFile]
 * @param {typeof fsPromises.stat} [options.stat]
 * @param {(path: string) => Promise<any>} [options.openSqlite]
 * @param {() => number} [options.now]
 * @returns {Promise<SettingsSnapshot>}
 */
export async function readTimerSettings({
  userDataPath,
  readFile = fsPromises.readFile,
  stat = fsPromises.stat,
  openSqlite = defaultOpenSqlite,
  now = Date.now,
} = /** @type {any} */ ({})) {
  const readAt = now();
  /** @param {string} reason @returns {SettingsSnapshot} */
  const fail = (reason) => ({ known: false, reason, readAt });

  try {
    const indexPath = join(userDataPath, INDEX_FILE_NAME);
    const indexRead = await readText(readFile, indexPath, MAX_INDEX_BYTES);
    if (!indexRead.ok) {
      return fail(indexRead.reason === 'missing' ? 'index_missing' : 'index_invalid');
    }
    const profile = parseActiveProfileId(indexRead.text);
    if (!profile.ok) {
      return fail(profile.reason);
    }
    const profileId = profile.activeProfileId;

    const databasePath = join(
      userDataPath,
      PROFILES_DIRECTORY_NAME,
      profileId,
      PROFILE_STATE_DATABASE_FILE_NAME,
    );

    let databaseExists = false;
    try {
      await stat(databasePath);
      databaseExists = true;
    } catch (error) {
      if (!isEnoent(error)) {
        return fail('db_error');
      }
      // main 파일이 없어도 DB family 파일이 남아 있으면 권위 상태이므로 JSON으로 내려가지 않는다.
      if (await hasDatabaseFamilyFile(stat, databasePath)) {
        return fail('db_error');
      }
    }

    /** @type {SettingsSnapshot} */
    let snapshot;
    if (databaseExists) {
      /** @type {any} */
      let db;
      try {
        db = await openSqlite(databasePath);
      } catch (error) {
        return fail(isRecord(error) && error.code === 'sqlite_unavailable' ? 'sqlite_unavailable' : 'db_error');
      }
      try {
        const result = readSettingsFromDatabase(db, profileId);
        if (!result.ok) {
          return fail(result.reason);
        }
        snapshot = {
          known: true,
          profileId,
          enabled: result.enabled,
          ttlMs: result.ttlMs,
          revision: result.revision,
          source: 'sqlite',
          readAt,
        };
      } catch {
        return fail('db_error');
      } finally {
        closeQuietly(db);
      }
    } else {
      const dataPath = join(
        userDataPath,
        PROFILES_DIRECTORY_NAME,
        profileId,
        PROFILE_DATA_FILE_NAME,
      );
      const dataRead = await readText(readFile, dataPath, MAX_PROFILE_JSON_BYTES);
      if (!dataRead.ok) {
        if (dataRead.reason === 'missing') {
          return fail('json_missing');
        }
        return fail(dataRead.reason === 'too_large' ? 'too_large' : 'json_invalid');
      }

      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(dataRead.text);
      } catch {
        return fail('json_invalid');
      }
      if (!isRecord(parsed)) {
        return fail('json_invalid');
      }
      const settings = interpretSettings(parsed.settings);
      if (!settings.ok) {
        return fail(settings.reason);
      }
      snapshot = {
        known: true,
        profileId,
        enabled: settings.enabled,
        ttlMs: settings.ttlMs,
        revision: null,
        source: 'json',
        readAt,
      };
    }

    // 읽는 사이 active 프로필이 바뀌었으면 결과를 폐기한다. 재읽기 실패도 전환으로 본다.
    const indexAgain = await readText(readFile, indexPath, MAX_INDEX_BYTES);
    if (!indexAgain.ok) {
      return fail('profile_changed');
    }
    const profileAgain = parseActiveProfileId(indexAgain.text);
    if (!profileAgain.ok || profileAgain.activeProfileId !== profileId) {
      return fail('profile_changed');
    }

    return snapshot;
  } catch {
    // 예상 못한 오류도 throw하지 않고 fail-closed로 접는다.
    return fail('index_invalid');
  }
}
