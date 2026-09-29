/**
 * Cache Keepalive 터미널 제어 파일.
 *
 * 플러그인 worker가 대시보드 서버를 띄운 뒤 사용자가 Orca 터미널에서 CLI로
 * 상태를 확인/변경할 수 있도록, 127.0.0.1 임의 포트/토큰과 pid를
 * `~/.orca-cache-keepalive/control.json`에 원자적으로 기록한다. CLI 실행 파일도
 * 같은 디렉터리에 복사한다.
 *
 * 보안 규칙:
 *  - 제어 디렉터리는 0o700, 제어 파일/CLI는 0o600/0o700(POSIX)로 만든다.
 *  - 제어 디렉터리가 심볼릭 링크/비디렉터리면 `unsafe_control_dir`로 거부한다.
 *  - 쓰기는 `<file>.<pid>.tmp`를 제거한 뒤 O_EXCL로 새로 만들어 rename한다(원자적).
 *  - 어떤 함수도 token을 로그/예외 메시지에 넣지 않는다.
 *
 * 모든 I/O는 주입 가능하다(fs/pathJoin/home/platform/now). 기본값은 실제
 * `node:fs`/`node:os`/`node:path`다.
 *
 * @module control-file
 */

import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 제어 디렉터리 이름. */
export const CONTROL_DIR_NAME = '.orca-cache-keepalive';

/** 제어 파일 이름. */
export const CONTROL_FILE_NAME = 'control.json';

/** 복사해 두는 CLI 파일 이름. */
export const CLI_FILE_NAME = 'keepalive.mjs';

/** 제어 파일 schema 버전. */
export const CONTROL_SCHEMA = 1;

/**
 * 주입된 fs에서 promises API를 고른다. `node:fs`(fs.promises 보유)와
 * `node:fs/promises`(직접 노출) 둘 다 허용한다.
 * @param {any} fsApi
 * @returns {any}
 */
function promisesOf(fsApi) {
  if (fsApi && fsApi.promises && typeof fsApi.promises.writeFile === 'function') {
    return fsApi.promises;
  }
  return fsApi;
}

/**
 * 제어 파일 경로들을 만든다.
 * @param {{home?: string, pathJoin?: (...parts: string[]) => string}} [options]
 * @returns {{dir: string, file: string, cli: string}}
 */
export function controlPaths({ home = os.homedir(), pathJoin = path.join } = {}) {
  const dir = pathJoin(home, CONTROL_DIR_NAME);
  return {
    dir,
    file: pathJoin(dir, CONTROL_FILE_NAME),
    cli: pathJoin(dir, CLI_FILE_NAME),
  };
}

/**
 * 제어 디렉터리를 생성하고 POSIX에서 0o700으로 맞춘다. 생성한 경로가
 * 심볼릭 링크이거나 디렉터리가 아니면 `unsafe_control_dir` 오류로 거부한다.
 * @param {any} p fs.promises API.
 * @param {string} dir
 * @param {string} platform
 * @returns {Promise<void>}
 */
async function ensureDir(p, dir, platform) {
  await p.mkdir(dir, { recursive: true, mode: 0o700 });
  // chmod로 권한을 바꾸기 전에 심볼릭 링크/비디렉터리를 먼저 걸러낸다.
  const info = await p.lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    const error = new Error('unsafe control dir');
    error.code = 'unsafe_control_dir';
    throw error;
  }
  if (platform !== 'win32') {
    await p.chmod(dir, 0o700);
  }
}

/**
 * tmp 경로를 새로 만들기 전에 기존 항목(남은 파일/심볼릭 링크)을 제거한다.
 * O_EXCL(`flag: 'wx'`)로 생성하므로 심볼릭 링크 대상을 덮어쓰지 않는다.
 * @param {any} p fs.promises API.
 * @param {string} tmp
 * @returns {Promise<void>}
 */
async function removeStaleTmp(p, tmp) {
  await p.rm(tmp, { force: true });
}

/**
 * tmp 정리를 best-effort로 시도한다(오류는 삼킨다).
 * @param {any} p fs.promises API.
 * @param {string} tmp
 * @returns {Promise<void>}
 */
async function cleanupTmp(p, tmp) {
  try {
    await p.rm(tmp, { force: true });
  } catch {
    /* tmp 정리 실패는 무시한다. */
  }
}

/**
 * 제어 파일을 원자적으로 기록한다.
 *
 * @param {object} options
 * @param {any} [options.fs] `node:fs` 모양(기본값 실제 node:fs).
 * @param {string} [options.home]
 * @param {(...parts: string[]) => string} [options.pathJoin]
 * @param {number} [options.pid]
 * @param {number} [options.port]
 * @param {string} [options.token]
 * @param {string} [options.instanceId] 있으면 JSON에 기록한다(없으면 생략).
 * @param {() => number} [options.now]
 * @param {string} [options.platform]
 * @returns {Promise<{dir: string, file: string, cli: string}>}
 */
export async function writeControlFile({
  fs = fsDefault,
  home = os.homedir(),
  pathJoin = path.join,
  pid = process.pid,
  port,
  token,
  instanceId,
  now = Date.now,
  platform = process.platform,
} = {}) {
  const p = promisesOf(fs);
  const paths = controlPaths({ home, pathJoin });
  await ensureDir(p, paths.dir, platform);

  const record = {
    schema: CONTROL_SCHEMA,
    pid,
    ...(typeof instanceId === 'string' ? { instanceId } : {}),
    host: '127.0.0.1',
    port,
    token,
    startedAt: now(),
  };
  const data = JSON.stringify(record);
  const tmp = `${paths.file}.${pid}.tmp`;

  await removeStaleTmp(p, tmp);
  try {
    await p.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') {
      await p.chmod(tmp, 0o600);
    }
    await p.rename(tmp, paths.file);
  } catch (error) {
    await cleanupTmp(p, tmp);
    throw error;
  }
  return paths;
}

/**
 * 제어 파일에 기록된 pid가 현재 pid와 같을 때만 삭제한다. `instanceId`가
 * 전달되면 파일의 pid와 instanceId가 모두 같을 때만 삭제한다. 파일이 없거나
 * 파싱에 실패하면 조용히 넘어간다.
 *
 * @param {object} options
 * @param {any} [options.fs]
 * @param {string} [options.home]
 * @param {(...parts: string[]) => string} [options.pathJoin]
 * @param {number} [options.pid]
 * @param {string} [options.instanceId] 전달되면 함께 비교한다.
 * @returns {Promise<boolean>} 삭제했으면 true.
 */
export async function removeControlFile({
  fs = fsDefault,
  home = os.homedir(),
  pathJoin = path.join,
  pid = process.pid,
  instanceId,
} = {}) {
  const p = promisesOf(fs);
  const paths = controlPaths({ home, pathJoin });

  let raw;
  try {
    raw = await p.readFile(paths.file, 'utf8');
  } catch {
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.pid !== pid) {
    return false;
  }
  if (instanceId !== undefined && parsed.instanceId !== instanceId) {
    return false;
  }

  try {
    await p.unlink(paths.file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 실행 중인 CLI 파일을 제어 디렉터리로 복사한다(tmp+rename, POSIX 0o700).
 *
 * @param {object} options
 * @param {any} [options.fs]
 * @param {string} [options.home]
 * @param {(...parts: string[]) => string} [options.pathJoin]
 * @param {string} options.sourcePath
 * @param {number} [options.pid] tmp 파일 이름에 쓴다(기본 process.pid).
 * @param {string} [options.platform]
 * @returns {Promise<string>} 복사된 CLI 경로.
 */
export async function installCli({
  fs = fsDefault,
  home = os.homedir(),
  pathJoin = path.join,
  sourcePath,
  pid = process.pid,
  platform = process.platform,
} = {}) {
  const p = promisesOf(fs);
  const paths = controlPaths({ home, pathJoin });
  await ensureDir(p, paths.dir, platform);

  const data = await p.readFile(sourcePath);
  const tmp = `${paths.cli}.${pid}.tmp`;

  await removeStaleTmp(p, tmp);
  try {
    await p.writeFile(tmp, data, { mode: 0o700, flag: 'wx' });
    if (platform !== 'win32') {
      await p.chmod(tmp, 0o700);
    }
    await p.rename(tmp, paths.cli);
  } catch (error) {
    await cleanupTmp(p, tmp);
    throw error;
  }
  return paths.cli;
}
