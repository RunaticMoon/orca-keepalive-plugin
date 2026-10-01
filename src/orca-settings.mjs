/**
 * Orca 활성 프로필 index에서 **활성 프로필 ID만** 읽기 전용으로 반환한다.
 *
 * prompt cache 타이머 설정(TTL/enabled)은 더 이상 Orca 저장소에서 읽지 않는다.
 * TTL은 플러그인 자체 config가 담당하므로(다른 작업), 이 모듈은 scope 키·복원 키로
 * 쓰는 활성 프로필 ID만 제공한다. Orca 파일에는 절대 쓰지 않고 index JSON만 읽는다.
 * `readActiveProfile`은 어떤 예외도 던지지 않는다. 모든 실패는
 * `{known:false, reason, readAt}`로 접는다.
 *
 * 절차:
 * 1. `<userData>/orca-profile-index.json`(≤1 MiB)에서 activeProfileId를 검증한다.
 *    JSON object 여부, `profiles` 배열 존재, `activeProfileId` 형식(PROFILE_ID_PATTERN),
 *    `profiles` 목록에 해당 id 존재를 확인한다.
 * 2. 읽기 전후 index를 다시 읽어 activeProfileId가 바뀌면 `profile_changed`로 폐기한다.
 *    재읽기 실패도 전환으로 본다.
 *
 * profile-state.db·orca-data.json 등 타이머 저장소는 읽지 않는다(결과에 영향 없음).
 *
 * @module orca-settings
 */

import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

/**
 * 활성 프로필 조회 결과.
 * @typedef {Object} ActiveProfileSnapshot
 * @property {boolean} known
 * @property {string} [profileId] known=true일 때의 활성 프로필 ID.
 * @property {'index'} [source] known=true일 때의 출처.
 * @property {string} [reason] known=false일 때의 reason 코드.
 * @property {number} readAt 읽은 시각(ms).
 */

/** 활성 프로필 index 파일 이름. `profile-storage-paths.ts:11`. */
const INDEX_FILE_NAME = 'orca-profile-index.json';

/** index 최대 크기(1 MiB). */
const MAX_INDEX_BYTES = 1024 * 1024;

/** `profile-state-active-location.ts:28` */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * 값이 배열이 아닌 non-null object인지 확인한다. JSON object 판정에 쓴다.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ENOENT 여부. 다른 fs 오류와 구분해 index_missing을 만든다.
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
 * Orca 활성 프로필 ID를 읽는다. 절대 throw하지 않는다.
 *
 * @param {Object} [options]
 * @param {string} options.userDataPath Orca userData 디렉터리 절대 경로.
 * @param {typeof fsPromises.readFile} [options.readFile]
 * @param {() => number} [options.now]
 * @returns {Promise<ActiveProfileSnapshot>}
 */
export async function readActiveProfile({
  userDataPath,
  readFile = fsPromises.readFile,
  now = Date.now,
} = /** @type {any} */ ({})) {
  const readAt = now();
  /** @param {string} reason @returns {ActiveProfileSnapshot} */
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

    // 읽는 사이 active 프로필이 바뀌었으면 결과를 폐기한다. 재읽기 실패도 전환으로 본다.
    const indexAgain = await readText(readFile, indexPath, MAX_INDEX_BYTES);
    if (!indexAgain.ok) {
      return fail('profile_changed');
    }
    const profileAgain = parseActiveProfileId(indexAgain.text);
    if (!profileAgain.ok || profileAgain.activeProfileId !== profileId) {
      return fail('profile_changed');
    }

    return { known: true, profileId, source: 'index', readAt };
  } catch {
    // 예상 못한 오류도 throw하지 않고 fail-closed로 접는다.
    return fail('index_invalid');
  }
}
