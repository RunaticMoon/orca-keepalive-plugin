/**
 * 같은 Orca 인스턴스의 userData 경로 후보와 runtime binding을 해석한다.
 *
 * DESIGN.md §4.1, §6의 계약을 구현한다. 이 모듈은 socket을 열지 않고 홈 전체를
 * 탐색하지도 않는다. 파일 접근은 `readRuntimeBinding`의 `readFile`/`realpath`
 * 주입으로만 일어나며, 탐색 대상은 `${userDataPath}/orca-runtime.json` 하나뿐이다.
 *
 * metadata에 들어 있는 `authToken`은 반환 Binding에만 넣고 LocationError의
 * message/필드에는 절대 넣지 않는다.
 *
 * @module runtime-location
 */

import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** @typedef {import('./contracts.mjs').Binding} Binding */

/** runtime metadata 파일 이름. §4.2, runtime-bootstrap.ts */
const RUNTIME_METADATA_FILE = 'orca-runtime.json';

/** metadata 최대 크기(1 MiB). 초과하면 too_large. */
const MAX_METADATA_BYTES = 1024 * 1024;

/** 지원하는 transport kind. TCP/웹소켓 fallback은 없다. §4.2 */
const SUPPORTED_TRANSPORT_KINDS = ['unix', 'named-pipe'];

/**
 * runtime 위치 해석 실패. code는 고정 enum이며 message/필드에 authToken을 담지 않는다.
 */
export class LocationError extends Error {
  /**
   * @param {'metadata_missing'|'metadata_unreadable'|'metadata_invalid'|'no_transport'|'wrong_runtime'|'too_large'} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LocationError';
    this.code = code;
  }
}

/**
 * resolveBinding에서 후보별 실패 중 "가장 의미있는" 오류를 고르는 우선순위.
 * 값이 클수록 우선한다. §6 C 방향.
 * @type {Record<string, number>}
 */
const ERROR_PRIORITY = {
  metadata_missing: 1,
  metadata_unreadable: 2,
  no_transport: 3,
  too_large: 4,
  metadata_invalid: 5,
  wrong_runtime: 6,
};

/**
 * userData 경로 후보를 우선순위대로 반환한다. §4.1.1–4.1.3.
 *
 * - override(절대경로)가 있으면 그것만 쓴다.
 * - env.ORCA_USER_DATA_PATH가 있으면 후보 맨 앞에 온다.
 * - 그 외에는 플랫폼 기본 userData 경로 하나를 쓴다.
 * - 홈 전체를 탐색하지 않으며 중복을 제거한다.
 *
 * @param {Object} [options]
 * @param {string} [options.platform] 기본 process.platform.
 * @param {string} [options.home] 기본 os.homedir().
 * @param {Record<string, string|undefined>} [options.env] 기본 빈 객체(scrubbed env).
 * @param {string|null} [options.override] config.runtimeUserDataPath.
 * @returns {string[]}
 */
export function candidateUserDataPaths({
  platform = process.platform,
  home = homedir(),
  env = {},
  override = null,
} = {}) {
  if (override !== null && override !== undefined) {
    return [override];
  }

  const isWindows = platform === 'win32';
  const path = isWindows ? win32 : posix;
  /** @type {string[]} */
  const candidates = [];

  const envOverride = env.ORCA_USER_DATA_PATH;
  if (typeof envOverride === 'string' && envOverride.length > 0) {
    candidates.push(envOverride);
  }

  if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'orca'));
  } else if (isWindows) {
    const appData = env.APPDATA;
    if (typeof appData === 'string' && appData.length > 0) {
      candidates.push(path.join(appData, 'orca'));
    } else {
      candidates.push(path.join(home, 'AppData', 'Roaming', 'orca'));
    }
  } else {
    const xdg = env.XDG_CONFIG_HOME;
    const base =
      typeof xdg === 'string' && xdg.length > 0 ? xdg : path.join(home, '.config');
    candidates.push(path.join(base, 'orca'));
  }

  // 중복 제거(순서 보존).
  return [...new Set(candidates)];
}

/**
 * metadata의 transports 배열(또는 레거시 단수 transport)에서 지원 kind의 첫 항목을 찾는다.
 * @param {Record<string, unknown>} metadata
 * @returns {{ok:true, endpoint:string, transportKind:'unix'|'named-pipe'}|{ok:false, code:'no_transport'|'metadata_invalid'}}
 */
function pickTransport(metadata) {
  const list = Array.isArray(metadata.transports) ? metadata.transports : null;
  if (list) {
    const found = list.find(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        SUPPORTED_TRANSPORT_KINDS.includes(/** @type {any} */ (item).kind),
    );
    if (!found) {
      return { ok: false, code: 'no_transport' };
    }
    const { endpoint, kind } = /** @type {{endpoint?:unknown, kind?:unknown}} */ (found);
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return { ok: false, code: 'metadata_invalid' };
    }
    return { ok: true, endpoint, transportKind: /** @type {'unix'|'named-pipe'} */ (kind) };
  }

  // 레거시(pre-transports-array) metadata 호환.
  const legacy = metadata.transport;
  if (
    legacy !== null &&
    typeof legacy === 'object' &&
    SUPPORTED_TRANSPORT_KINDS.includes(/** @type {any} */ (legacy).kind)
  ) {
    const { endpoint } = /** @type {{endpoint?:unknown}} */ (legacy);
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return { ok: false, code: 'metadata_invalid' };
    }
    return {
      ok: true,
      endpoint,
      transportKind: /** @type {'unix'|'named-pipe'} */ (/** @type {any} */ (legacy).kind),
    };
  }

  return { ok: false, code: 'no_transport' };
}

/**
 * raw metadata JSON을 검증해 Binding에 필요한 필드를 뽑아낸다.
 * @param {unknown} parsed
 * @returns {{runtimeId:string, pid:number, startedAt:number, authToken:string, endpoint:string, transportKind:'unix'|'named-pipe'}}
 */
function extractMetadataFields(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocationError('metadata_invalid', 'runtime metadata must be a JSON object');
  }
  const metadata = /** @type {Record<string, unknown>} */ (parsed);

  const { runtimeId, pid, authToken, startedAt } = metadata;
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    throw new LocationError('metadata_invalid', 'runtime metadata has invalid runtimeId');
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new LocationError('metadata_invalid', 'runtime metadata has invalid pid');
  }
  if (typeof authToken !== 'string' || authToken.length === 0) {
    throw new LocationError('metadata_invalid', 'runtime metadata has invalid authToken');
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    throw new LocationError('metadata_invalid', 'runtime metadata has invalid startedAt');
  }

  const transport = pickTransport(metadata);
  if (!transport.ok) {
    throw new LocationError(transport.code);
  }

  return {
    runtimeId,
    pid,
    authToken,
    startedAt,
    endpoint: transport.endpoint,
    transportKind: transport.transportKind,
  };
}

/**
 * `${userDataPath}/orca-runtime.json`을 읽어 Binding을 만든다. §4.1.4–4.1.5.
 *
 * @param {Object} options
 * @param {string} options.userDataPath userData 디렉터리 절대 경로.
 * @param {number} options.parentPid plugin worker의 process.ppid와 같아야 하는 runtime pid.
 * @param {typeof fsPromises.readFile} [options.readFile]
 * @param {typeof fsPromises.realpath} [options.realpath]
 * @returns {Promise<Binding>}
 */
export async function readRuntimeBinding({
  userDataPath,
  parentPid,
  readFile = fsPromises.readFile,
  realpath = fsPromises.realpath,
}) {
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE);

  /** @type {string|Buffer|Uint8Array} */
  let raw;
  try {
    raw = await readFile(metadataPath);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      throw new LocationError('metadata_missing', `runtime metadata not found at ${metadataPath}`);
    }
    throw new LocationError('metadata_unreadable', `could not read runtime metadata at ${metadataPath}`);
  }

  const byteLength =
    typeof raw === 'string'
      ? Buffer.byteLength(raw, 'utf8')
      : typeof raw?.byteLength === 'number'
        ? raw.byteLength
        : -1;
  if (byteLength > MAX_METADATA_BYTES) {
    throw new LocationError('too_large', `runtime metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }

  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    text = Buffer.from(raw).toString('utf8');
  } else {
    throw new LocationError('metadata_unreadable', `runtime metadata at ${metadataPath} is not text`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocationError('metadata_invalid', 'runtime metadata is not valid JSON');
  }

  const fields = extractMetadataFields(parsed);

  if (fields.pid !== parentPid) {
    throw new LocationError(
      'wrong_runtime',
      `runtime pid ${fields.pid} does not match worker parent pid ${parentPid}`,
    );
  }

  /** @type {string} */
  let realUserDataPath;
  try {
    realUserDataPath = /** @type {string} */ (await realpath(userDataPath));
  } catch {
    throw new LocationError('metadata_unreadable', `could not resolve userData path ${userDataPath}`);
  }

  const userDataKey = createHash('sha256').update(realUserDataPath, 'utf8').digest('hex');

  return {
    userDataPath,
    userDataKey,
    runtimeId: fields.runtimeId,
    pid: fields.pid,
    startedAt: fields.startedAt,
    endpoint: fields.endpoint,
    transportKind: fields.transportKind,
    authToken: fields.authToken,
  };
}

/**
 * 두 Binding이 같은 runtime 인스턴스를 가리키는지 비교한다.
 * authToken은 비교하지 않는다. null/undefined 입력은 false다.
 *
 * @param {Binding|null|undefined} a
 * @param {Binding|null|undefined} b
 * @returns {boolean}
 */
export function sameBinding(a, b) {
  if (!a || !b) {
    return false;
  }
  return (
    a.runtimeId === b.runtimeId &&
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    a.endpoint === b.endpoint &&
    a.userDataKey === b.userDataKey
  );
}

/**
 * 후보 userData 경로를 순서대로 시도해 첫 성공 Binding을 반환한다.
 * 모두 실패하면 오류 우선순위(wrong_runtime > metadata_invalid > too_large >
 * no_transport > metadata_unreadable > metadata_missing)가 가장 높은 오류를 던진다.
 *
 * @param {Object} options
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string|null} [options.override]
 * @param {number} options.parentPid
 * @param {typeof fsPromises.readFile} [options.readFile]
 * @param {typeof fsPromises.realpath} [options.realpath]
 * @returns {Promise<Binding>}
 */
export async function resolveBinding({
  platform = process.platform,
  home = homedir(),
  env = {},
  override = null,
  parentPid,
  readFile = fsPromises.readFile,
  realpath = fsPromises.realpath,
} = /** @type {any} */ ({})) {
  const candidates = candidateUserDataPaths({ platform, home, env, override });

  /** @type {LocationError|null} */
  let best = null;
  for (const userDataPath of candidates) {
    try {
      return await readRuntimeBinding({ userDataPath, parentPid, readFile, realpath });
    } catch (error) {
      const locationError =
        error instanceof LocationError
          ? error
          : new LocationError('metadata_unreadable', 'runtime location failed');
      if (best === null || (ERROR_PRIORITY[locationError.code] ?? 0) > (ERROR_PRIORITY[best.code] ?? 0)) {
        best = locationError;
      }
    }
  }

  throw best ?? new LocationError('metadata_missing', 'no userData candidates');
}
