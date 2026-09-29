#!/usr/bin/env node
/**
 * Orca Cache Keepalive 터미널 CLI.
 *
 * 이 파일은 `~/.orca-cache-keepalive/keepalive.mjs`로 복사되어 실행되므로
 * `src/`를 import하지 않고 node 내장 모듈만 사용하는 단일 파일이어야 한다.
 *
 * 제어 파일(`ORCA_KEEPALIVE_CONTROL` 또는 `~/.orca-cache-keepalive/control.json`)에서
 * 127.0.0.1 포트/토큰을 읽어 대시보드 API로 상태 확인/설정을 수행한다.
 * HTTP는 Host/Origin 헤더를 직접 지정해야 하므로 `node:http` request를 쓴다.
 *
 * 모든 출력 함수와 `main`을 export한다(테스트용). 직접 실행될 때만 main을 돌린다.
 *
 * @module keepalive-cli
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 제어 디렉터리 이름(control-file.mjs와 동일해야 한다). */
export const CONTROL_DIR_NAME = '.orca-cache-keepalive';
/** 제어 파일 이름. */
export const CONTROL_FILE_NAME = 'control.json';
/** 요청 timeout(ms). */
export const REQUEST_TIMEOUT_MS = 5000;

/** 제어 파일 최대 허용 크기(byte). 초과하면 손상으로 보고 미실행 처리한다. */
export const MAX_CONTROL_FILE_BYTES = 64 * 1024;

/** 플러그인이 실행 중이 아닐 때의 안내 문구. */
export const NOT_RUNNING_MESSAGE =
  'Cache Keepalive 플러그인이 실행 중이 아닙니다. Orca에서 플러그인이 켜져 있는지 확인하세요 (Settings > Plugins).';

/** 대시보드 주소에 토큰이 포함됨을 알리는 경고. */
export const URL_TOKEN_WARNING =
  '주의: 이 주소에는 접근 토큰이 들어 있습니다. 공유하지 마세요.';

/** Orca 터미널 밖에서 `here`를 실행했을 때의 안내 문구. */
export const NOT_IN_ORCA_MESSAGE =
  'Orca 터미널 안에서 실행해야 현재 워크트리를 알 수 있습니다.';

/** ORCA_WORKTREE_ID가 있지만 상태의 어떤 worktreeHash와도 매칭되지 않을 때의 안내. */
export const HERE_WORKTREE_UNKNOWN_MESSAGE =
  "현재 터미널의 워크트리를 keepalive 대상 목록에서 찾지 못했습니다. 'status'로 목록을 확인하고 'worktree <번호> on|off'를 사용하세요.";

/** 사용법 문구. */
export const HELP_TEXT = `Cache Keepalive 터미널 CLI

사용법: keepalive <명령> [옵션]

명령:
  status [--json]                            현재 상태 표시 (기본)
  on | off                                   전체 keepalive 켜기 / 일시정지
  here [on|off|default]                      현재 Orca 터미널의 워크트리 상태 / 설정
  worktree <번호|label> <on|off|default>     특정 워크트리 설정
  url                                        대시보드 주소 출력
  help                                       이 도움말`;

/** TTL 표시 문구(ui/app.mjs와 동일한 최소 매핑). */
const TTL_TEXT = Object.freeze({
  300000: '5분',
  3600000: '1시간',
});

/** target phase 한국어 문구(ui/app.mjs의 표시 로직을 최소한으로 복사). */
const PHASE_TEXT = Object.freeze({
  UNKNOWN: '알 수 없음',
  BUSY: '작업 중',
  ARMED: '예약됨',
  CHECKING: '확인 중',
  PASTING: '붙여넣는 중',
  SUBMITTING: '전송 중',
  AWAITING_TURN: '대기',
  SUSPENDED: '일시정지',
  NEEDS_REVIEW: '확인 필요',
  EXPIRED: '만료됨',
});

/**
 * 제어 파일 경로를 결정한다. env override가 있으면 그대로 쓴다.
 * @param {{env?: Record<string, string|undefined>, homedir?: () => string}} [options]
 * @returns {string}
 */
export function controlFilePath({ env = process.env, homedir = os.homedir } = {}) {
  const override = env.ORCA_KEEPALIVE_CONTROL;
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return path.join(homedir(), CONTROL_DIR_NAME, CONTROL_FILE_NAME);
}

/**
 * 제어 파일을 읽고 필수 필드를 검증한다. 없거나 잘못됐으면 null.
 * @param {string} file
 * @param {any} [fsApi]
 * @returns {{pid: number, host: string, port: number, token: string}|null}
 */
export function readControlFile(file, fsApi = fs) {
  // control.json의 `host` 필드는 신뢰하지 않는다. CLI는 항상 127.0.0.1로 접속한다.
  // 크기를 먼저 확인하고 64 KiB를 넘으면 손상된 파일로 보고 미실행으로 처리한다.
  let size;
  try {
    size = fsApi.statSync(file).size;
  } catch {
    return null;
  }
  if (!Number.isFinite(size) || size > MAX_CONTROL_FILE_BYTES) {
    return null;
  }
  let raw;
  try {
    raw = fsApi.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const { pid, host, port, token } = parsed;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  return {
    pid,
    host: typeof host === 'string' && host.length > 0 ? host : '127.0.0.1',
    port,
    token,
  };
}

/**
 * pid가 살아 있는지 확인한다. EPERM(권한 없음)은 살아 있는 것으로 본다.
 * @param {unknown} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === 'EPERM';
  }
}

/**
 * 대시보드 API에 JSON 요청을 보낸다(Host/Origin을 정확히 지정).
 * @param {{port: number, token: string, method: 'GET'|'POST', pathname: string, body?: unknown}} options
 * @returns {Promise<{status: number, text: string}>}
 */
export function requestJson({ port, token, method, pathname, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    /** @type {Record<string, string>} */
    const headers = {
      Host: `127.0.0.1:${port}`,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (method === 'POST') {
      headers.Origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * 서버 오류 본문에서 `error.code`를 꺼낸다. 없으면 `HTTP <status>`.
 * @param {string} text
 * @param {number} status
 * @returns {string}
 */
export function errorCodeOf(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.error && typeof parsed.error.code === 'string') {
      return parsed.error.code;
    }
  } catch {
    /* ignore */
  }
  return `HTTP ${status}`;
}

/**
 * argv를 파싱한다.
 * @param {string[]} argv
 * @returns {{kind: 'status', json: boolean}|{kind: 'pause', paused: boolean, mode: 'on'|'off'}|{kind: 'here', mode: 'show'|'on'|'off'|'default'}|{kind: 'worktree', selector: string, mode: 'on'|'off'|'default'}|{kind: 'url'}|{kind: 'help'}|{kind: 'usage-error', message: string}}
 */
export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length === 0) {
    return { kind: 'status', json: false };
  }
  const [first, ...rest] = args;

  if (first === 'help' || first === '-h' || first === '--help') {
    return { kind: 'help' };
  }
  if (first === 'status') {
    const unknown = rest.filter((arg) => arg !== '--json');
    if (unknown.length > 0) {
      return { kind: 'usage-error', message: `알 수 없는 옵션: ${unknown[0]}` };
    }
    return { kind: 'status', json: rest.includes('--json') };
  }
  if (first === 'on' || first === 'off') {
    if (rest.length > 0) {
      return { kind: 'usage-error', message: `${first} 명령에는 인자가 없습니다.` };
    }
    return { kind: 'pause', paused: first === 'off', mode: first };
  }
  if (first === 'here') {
    if (rest.length === 0) {
      return { kind: 'here', mode: 'show' };
    }
    if (rest.length === 1 && (rest[0] === 'on' || rest[0] === 'off' || rest[0] === 'default')) {
      return { kind: 'here', mode: rest[0] };
    }
    return { kind: 'usage-error', message: 'here 명령 옵션은 on|off|default 중 하나입니다.' };
  }
  if (first === 'worktree') {
    if (rest.length !== 2 || (rest[1] !== 'on' && rest[1] !== 'off' && rest[1] !== 'default')) {
      return {
        kind: 'usage-error',
        message: 'worktree 명령은 <번호|label> <on|off|default> 형식입니다.',
      };
    }
    return { kind: 'worktree', selector: rest[0], mode: rest[1] };
  }
  if (first === 'url') {
    if (rest.length > 0) {
      return { kind: 'usage-error', message: 'url 명령에는 인자가 없습니다.' };
    }
    return { kind: 'url' };
  }
  return { kind: 'usage-error', message: `알 수 없는 명령: ${first}` };
}

/**
 * 남은 시간을 `N분 M초 후`로 표시한다.
 * @param {unknown} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '알 수 없음';
  }
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초 후` : `${seconds}초 후`;
}

/**
 * @param {unknown} phase
 * @returns {string}
 */
function phaseText(phase) {
  if (typeof phase !== 'string' || phase.length === 0) return '알 수 없음';
  return PHASE_TEXT[phase] ?? phase;
}

/**
 * appTimer를 한 줄 문구로 만든다.
 * @param {unknown} appTimer
 * @returns {string}
 */
export function appTimerText(appTimer) {
  const timer = appTimer && typeof appTimer === 'object' ? appTimer : {};
  if (timer.known !== true) return '알 수 없음';
  if (timer.enabled !== true) return '꺼짐';
  const ttl =
    TTL_TEXT[timer.ttlMs] ?? (Number.isFinite(timer.ttlMs) ? `${timer.ttlMs}ms` : null);
  return ttl ? `켜짐 (${ttl})` : '켜짐';
}

/**
 * ORCA_WORKTREE_ID의 스냅숏 식별 해시(sha256 앞 16 hex). 없으면 null.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function currentWorktreeHash(env) {
  const id = env ? env.ORCA_WORKTREE_ID : undefined;
  if (typeof id !== 'string' || id.length === 0) return null;
  return crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

/**
 * terminal 하나를 한 줄로 만든다.
 * @param {unknown} terminal
 * @param {number} serverNow
 * @param {number|null} maxConsecutive
 * @returns {string}
 */
function terminalLine(terminal, serverNow, maxConsecutive) {
  const t = terminal && typeof terminal === 'object' ? terminal : {};
  const title = typeof t.title === 'string' && t.title.length > 0 ? t.title : '(제목 없음)';
  const parts = [`${title}  ${phaseText(t.phase)}`];

  if (Number.isFinite(t.dueAt)) {
    const remaining = t.dueAt - serverNow;
    parts.push(`다음 전송 ${remaining <= 0 ? '임박' : formatDuration(remaining)}`);
  }
  const charged = Number.isFinite(t.charged) ? t.charged : 0;
  if (maxConsecutive === null) {
    parts.push(`연속 ${charged}`);
  } else if (maxConsecutive === 0) {
    parts.push(`연속 ${charged}/무제한`);
  } else {
    parts.push(`연속 ${charged}/${maxConsecutive}`);
  }

  let line = parts.join(' · ');
  if (t.needsReview === true) {
    line += ' · 확인 필요';
  }
  return line;
}

/**
 * status 텍스트를 만든다. 토큰은 절대 포함하지 않는다.
 * @param {object} snapshot
 * @param {{currentWorktreeHash?: string|null}} [options]
 * @returns {string}
 */
export function renderStatus(snapshot, options = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const serverNow = Number.isFinite(snap.serverNow) ? snap.serverNow : Date.now();
  const config = snap.config && typeof snap.config === 'object' ? snap.config : {};
  const connection = snap.connection && typeof snap.connection === 'object' ? snap.connection : {};
  const currentHash =
    typeof options.currentWorktreeHash === 'string' ? options.currentWorktreeHash : null;
  const maxConsecutive = Number.isFinite(config.maxConsecutiveKeepalives)
    ? config.maxConsecutiveKeepalives
    : null;

  const lines = [];
  lines.push(`Cache Keepalive: ${config.paused === true ? '꺼짐 (일시정지)' : '켜짐'}`);
  lines.push(`Orca 프롬프트 캐시 타이머: ${appTimerText(snap.appTimer)}`);
  lines.push(
    `런타임 연결: ${typeof connection.state === 'string' ? connection.state : '알 수 없음'}`,
  );

  const worktrees = Array.isArray(snap.worktrees) ? snap.worktrees : [];
  lines.push(`워크트리 ${worktrees.length}개`);
  worktrees.forEach((worktree, index) => {
    const wt = worktree && typeof worktree === 'object' ? worktree : {};
    const enabled = wt.enabled === true ? true : wt.enabled === false ? false : null;
    const scopeOn = enabled === null ? config.defaultWorktreeEnabled === true : enabled;
    const mode = enabled === null ? '기본값' : '직접 설정';
    const current = currentHash !== null && wt.worktreeHash === currentHash ? '  ← 현재 터미널' : '';
    const label = typeof wt.label === 'string' && wt.label.length > 0 ? wt.label : '(이름 없음)';
    lines.push(`  ${index + 1}. ${label}  [${scopeOn ? '켜짐' : '꺼짐'} · ${mode}]${current}`);

    const terminals = Array.isArray(wt.terminals) ? wt.terminals : [];
    if (terminals.length === 0) {
      lines.push('     - (터미널 없음)');
    } else {
      for (const terminal of terminals) {
        lines.push(`     - ${terminalLine(terminal, serverNow, maxConsecutive)}`);
      }
    }
  });
  return lines.join('\n');
}

/**
 * status --json용 요약 객체를 만든다(토큰 없음, 상대 시간).
 * @param {object} snapshot
 * @param {{currentWorktreeHash?: string|null}} [options]
 * @returns {object}
 */
export function summarizeSnapshot(snapshot, options = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const serverNow = Number.isFinite(snap.serverNow) ? snap.serverNow : Date.now();
  const config = snap.config && typeof snap.config === 'object' ? snap.config : {};
  const connection = snap.connection && typeof snap.connection === 'object' ? snap.connection : {};
  const timer = snap.appTimer && typeof snap.appTimer === 'object' ? snap.appTimer : {};
  const currentHash =
    typeof options.currentWorktreeHash === 'string' ? options.currentWorktreeHash : null;
  const maxConsecutive = Number.isFinite(config.maxConsecutiveKeepalives)
    ? config.maxConsecutiveKeepalives
    : null;

  const worktrees = (Array.isArray(snap.worktrees) ? snap.worktrees : []).map((worktree) => {
    const wt = worktree && typeof worktree === 'object' ? worktree : {};
    const enabled = wt.enabled === true ? true : wt.enabled === false ? false : null;
    const terminals = (Array.isArray(wt.terminals) ? wt.terminals : []).map((terminal) => {
      const t = terminal && typeof terminal === 'object' ? terminal : {};
      return {
        title: typeof t.title === 'string' ? t.title : '',
        phase: typeof t.phase === 'string' ? t.phase : 'UNKNOWN',
        effectiveEnabled: t.effectiveEnabled === true,
        reason: typeof t.reason === 'string' ? t.reason : null,
        dueInMs: Number.isFinite(t.dueAt) ? t.dueAt - serverNow : null,
        expiresInMs: Number.isFinite(t.expiresAt) ? t.expiresAt - serverNow : null,
        charged: Number.isFinite(t.charged) ? t.charged : 0,
        confirmed: Number.isFinite(t.confirmed) ? t.confirmed : 0,
        needsReview: t.needsReview === true,
        supported: t.supported !== false,
      };
    });
    return {
      label: typeof wt.label === 'string' ? wt.label : '',
      enabled,
      effectiveEnabled: wt.effectiveEnabled === true,
      reason: typeof wt.reason === 'string' ? wt.reason : null,
      current: currentHash !== null && wt.worktreeHash === currentHash,
      terminals,
    };
  });

  return {
    revision: Number.isSafeInteger(snap.revision) ? snap.revision : 0,
    paused: config.paused === true,
    defaultWorktreeEnabled: config.defaultWorktreeEnabled === true,
    maxConsecutiveKeepalives: maxConsecutive,
    appTimer: {
      known: timer.known === true,
      enabled: timer.enabled === true,
      ttlMs: Number.isFinite(timer.ttlMs) ? timer.ttlMs : null,
      source: typeof timer.source === 'string' ? timer.source : null,
    },
    connection: {
      state: typeof connection.state === 'string' ? connection.state : 'unavailable',
      reason: typeof connection.reason === 'string' ? connection.reason : null,
    },
    worktreeCount: worktrees.length,
    worktrees,
  };
}

/**
 * GET /api/state.
 * @param {{port: number, token: string}} control
 * @returns {Promise<object>}
 */
async function fetchState(control) {
  const res = await requestJson({
    port: control.port,
    token: control.token,
    method: 'GET',
    pathname: '/api/state',
  });
  if (res.status !== 200) {
    const err = new Error('state request failed');
    err.code = errorCodeOf(res.text, res.status);
    throw err;
  }
  return JSON.parse(res.text);
}

/**
 * POST /api/action.
 * @param {{port: number, token: string}} control
 * @param {object} action
 * @returns {Promise<{status: number, text: string}>}
 */
function postAction(control, action) {
  return requestJson({
    port: control.port,
    token: control.token,
    method: 'POST',
    pathname: '/api/action',
    body: action,
  });
}

/**
 * revision을 읽어 action을 보내고, 409면 새 revision으로 1회만 재시도한다.
 * @param {{port: number, token: string}} control
 * @param {(revision: number) => object} buildAction
 * @returns {Promise<object>} 성공 시 새 snapshot.
 */
async function performAction(control, buildAction) {
  let state = await fetchState(control);
  let res = await postAction(control, buildAction(state.revision));

  if (res.status === 409 && errorCodeOf(res.text, 409) === 'revision_conflict') {
    state = await fetchState(control);
    res = await postAction(control, buildAction(state.revision));
  }

  if (res.status !== 200) {
    const err = new Error('action request failed');
    err.code = errorCodeOf(res.text, res.status);
    throw err;
  }
  return JSON.parse(res.text);
}

/**
 * @param {unknown} snapshot
 * @param {string|null} hash
 * @returns {string|null}
 */
function labelForHash(snapshot, hash) {
  if (hash === null) return null;
  const worktrees =
    snapshot && Array.isArray(snapshot.worktrees) ? snapshot.worktrees : [];
  const found = worktrees.find((worktree) => worktree && worktree.worktreeHash === hash);
  return found && typeof found.label === 'string' && found.label.length > 0 ? found.label : null;
}

/**
 * worktree selector(1부터의 번호 또는 정확한 label)를 해석한다.
 * @param {Array<object>} worktrees
 * @param {string} selector
 * @returns {{worktree: object}|{error: string}}
 */
function resolveWorktreeSelector(worktrees, selector) {
  const trimmed = typeof selector === 'string' ? selector.trim() : '';
  if (/^[0-9]+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n < 1 || n > worktrees.length) {
      return { error: `워크트리 번호 ${trimmed}를 찾을 수 없습니다.` };
    }
    return { worktree: worktrees[n - 1] };
  }
  const matches = worktrees.filter(
    (worktree) =>
      worktree &&
      typeof worktree.label === 'string' &&
      worktree.label.trim() === trimmed,
  );
  if (matches.length === 0) {
    return { error: `워크트리 '${trimmed}'를 찾을 수 없습니다.` };
  }
  if (matches.length > 1) {
    return { error: `워크트리 '${trimmed}'가 여러 개라 모호합니다. 번호를 사용하세요.` };
  }
  return { worktree: matches[0] };
}

/**
 * @param {'on'|'off'} mode
 * @returns {string}
 */
function pauseMessage(mode) {
  return mode === 'off'
    ? 'Cache Keepalive를 일시정지했습니다.'
    : 'Cache Keepalive를 켰습니다.';
}

/**
 * @param {string} label
 * @param {'on'|'off'|'default'} mode
 * @returns {string}
 */
function worktreeMessage(label, mode) {
  if (mode === 'default') {
    return `워크트리 '${label}' keepalive를 기본값으로 되돌렸습니다.`;
  }
  return `워크트리 '${label}' keepalive를 ${mode === 'on' ? '켰습니다' : '껐습니다'}.`;
}

/**
 * @param {'on'|'off'|'default'} mode
 * @param {string|null} label
 * @returns {string}
 */
function hereMessage(mode, label) {
  const who = label ? `현재 워크트리 '${label}'` : '현재 워크트리';
  if (mode === 'default') {
    return `${who} keepalive를 기본값으로 되돌렸습니다.`;
  }
  return `${who} keepalive를 ${mode === 'on' ? '켰습니다' : '껐습니다'}.`;
}

/**
 * CLI 본체.
 * @param {{argv?: string[], env?: Record<string, string|undefined>, stdout?: any, stderr?: any}} [options]
 * @returns {Promise<number>} 종료 코드.
 */
export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const write = (line) => stdout.write(`${line}\n`);
  const writeErr = (line) => stderr.write(`${line}\n`);

  const parsed = parseArgv(argv);

  if (parsed.kind === 'help') {
    write(HELP_TEXT);
    return 0;
  }
  if (parsed.kind === 'usage-error') {
    writeErr(parsed.message);
    writeErr('');
    writeErr(HELP_TEXT);
    return 2;
  }

  const control = readControlFile(controlFilePath({ env }));
  if (control === null || !isProcessAlive(control.pid)) {
    writeErr(NOT_RUNNING_MESSAGE);
    return 3;
  }

  if (parsed.kind === 'url') {
    write(`http://127.0.0.1:${control.port}/#token=${control.token}`);
    writeErr(URL_TOKEN_WARNING);
    return 0;
  }

  const hash = currentWorktreeHash(env);

  try {
    switch (parsed.kind) {
      case 'status': {
        const snapshot = await fetchState(control);
        if (parsed.json) {
          write(JSON.stringify(summarizeSnapshot(snapshot, { currentWorktreeHash: hash }), null, 2));
        } else {
          write(renderStatus(snapshot, { currentWorktreeHash: hash }));
        }
        return 0;
      }
      case 'pause': {
        const snapshot = await performAction(control, (revision) => ({
          type: 'pause',
          paused: parsed.paused,
          expectedRevision: revision,
        }));
        write(pauseMessage(parsed.mode));
        write(renderStatus(snapshot, { currentWorktreeHash: hash }));
        return 0;
      }
      case 'here': {
        const rawId = env.ORCA_WORKTREE_ID;
        if (typeof rawId !== 'string' || rawId.length === 0) {
          writeErr(NOT_IN_ORCA_MESSAGE);
          return 2;
        }
        if (parsed.mode === 'show') {
          const snapshot = await fetchState(control);
          if (labelForHash(snapshot, hash) === null) {
            writeErr(HERE_WORKTREE_UNKNOWN_MESSAGE);
            return 1;
          }
          write(renderStatus(snapshot, { currentWorktreeHash: hash }));
          return 0;
        }
        const enabled =
          parsed.mode === 'on' ? true : parsed.mode === 'off' ? false : null;
        let snapshot;
        try {
          snapshot = await performAction(control, (revision) => ({
            type: 'worktree-orca',
            worktreeId: rawId,
            enabled,
            expectedRevision: revision,
          }));
        } catch (err) {
          // 플러그인이 아직 관측하지 못한 워크트리면 서버가 unknown_target을 돌려준다.
          if (err && err.code === 'unknown_target') {
            writeErr(HERE_WORKTREE_UNKNOWN_MESSAGE);
            return 1;
          }
          throw err;
        }
        write(hereMessage(parsed.mode, labelForHash(snapshot, hash)));
        write(renderStatus(snapshot, { currentWorktreeHash: hash }));
        return 0;
      }
      case 'worktree': {
        const snapshot = await fetchState(control);
        const worktrees = Array.isArray(snapshot.worktrees) ? snapshot.worktrees : [];
        const resolved = resolveWorktreeSelector(worktrees, parsed.selector);
        if ('error' in resolved) {
          writeErr(resolved.error);
          return 2;
        }
        const target = resolved.worktree;
        const enabled =
          parsed.mode === 'on' ? true : parsed.mode === 'off' ? false : null;
        const next = await performAction(control, (revision) => ({
          type: 'worktree',
          targetId: target.id,
          enabled,
          expectedRevision: revision,
        }));
        write(worktreeMessage(typeof target.label === 'string' ? target.label : '', parsed.mode));
        write(renderStatus(next, { currentWorktreeHash: hash }));
        return 0;
      }
      default: {
        writeErr('알 수 없는 명령입니다.');
        return 2;
      }
    }
  } catch (err) {
    if (err && err.code === 'ECONNREFUSED') {
      writeErr(NOT_RUNNING_MESSAGE);
      return 3;
    }
    const code = err && typeof err.code === 'string' && err.code.length > 0 ? err.code : 'internal';
    writeErr(`오류: ${code}`);
    return 1;
  }
}

/**
 * 이 모듈이 직접 실행됐는지 판별한다.
 * @returns {boolean}
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
