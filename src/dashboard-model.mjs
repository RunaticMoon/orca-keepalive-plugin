/**
 * Cache Keepalive 대시보드 모델.
 *
 * 런타임 뷰(`getRuntimeView`, coordinator 제공·동기)와 영속 정책
 * (`store`, state-store)을 결합해 공개 `DashboardSnapshot`을 만들고, 대시보드
 * `Action`을 저장소 호출로 변환한다. DESIGN.md §5.3(우선순위), §7.3–§7.4
 * (DashboardSnapshot, Action, 오류 status)를 구현한다.
 *
 * 공개 스냅숏에는 비밀·경로·draft·원문 식별자를 절대 넣지 않는다:
 *  - worktreeId/paneKey/handle/ptyId/authToken/draft는 스냅숏 JSON에 없다.
 *  - 대상은 프로세스 수명 동안 안정적인 opaque `targetId`로만 노출한다.
 *  - 예외적으로 사용자가 직접 입력한 `config.runtimeUserDataPath`만 허용한다.
 *
 * 이 모듈은 I/O·타이머를 시작하지 않는다. 모든 부작용은 주입된 store/콜백으로만
 * 수행한다.
 *
 * @module dashboard-model
 */

import crypto from 'node:crypto';

import { StoreError } from './state-store.mjs';
import { ValidationError } from './config.mjs';

/** 허용 Action type. §7.4. */
const ACTION_TYPES = new Set(['pause', 'worktree', 'terminal', 'config', 'reset-budget', 'clear-review', 'worktree-orca']);

/** 허용 connection.state. */
const CONNECTION_STATES = new Set(['connected', 'unavailable', 'wrong_runtime', 'starting']);

/** TTL 표시 문구. */
const TTL_TEXT = Object.freeze({
  300000: '5분',
  3600000: '1시간',
});

/** connection.state 한국어 문구. */
const CONNECTION_TEXT = Object.freeze({
  connected: '연결됨',
  unavailable: '연결할 수 없음',
  wrong_runtime: '다른 런타임',
  starting: '시작 중',
});

/** worktree scope에서 무시하는 budget 기반 정책 사유. */
const WORKTREE_IGNORED_POLICY_REASONS = new Set(['LIMIT_REACHED', 'PARTIAL_OR_UNKNOWN_SEND', 'STORAGE_FAILED']);

/**
 * 대시보드 Action 검증·오류 status/code.
 *
 * dashboard-server는 `err.status`와 `err.code`만 반영한다(§7.4). code는 소문자
 * 스네이크, status는 400|404|409|503이다.
 */
export class ActionError extends Error {
  /**
   * @param {400|404|409|503} status
   * @param {string} code
   * @param {string} [message]
   */
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'ActionError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
  }
}

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
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmptyStringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * targetId 조회용 내부 키. 원문 식별자는 이 Map key에만 존재한다.
 * @param {string} worktreeId
 * @returns {string}
 */
function worktreeKey(worktreeId) {
  return `wt\u0000${worktreeId}`;
}

/**
 * @param {string} worktreeId
 * @param {string} paneKey
 * @returns {string}
 */
function terminalKey(worktreeId, paneKey) {
  return `tm\u0000${worktreeId}\u0000${paneKey}`;
}

/**
 * 원시 worktreeId의 스냅숏 식별용 해시(sha256 앞 16 hex). 터미널 CLI가
 * `ORCA_WORKTREE_ID`를 같은 방식으로 해시해 "현재 워크트리"를 찾는다.
 * @param {string} worktreeId
 * @returns {string}
 */
function worktreeHashOf(worktreeId) {
  return crypto.createHash('sha256').update(worktreeId, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 서버 시각 기준 남은 시간을 `N분 M초 후`/`N시간 M분 후`로 표현한다. 이미 지난
 * 시각은 `곧`으로 표시한다.
 * @param {number} remainingMs
 * @returns {string}
 */
function relativeFutureText(remainingMs) {
  if (remainingMs <= 0) {
    return '곧';
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}시간 ${minutes}분 후`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}분 ${seconds}초 후`;
}

/**
 * 상태 알림의 워크트리 한 줄. 현재 워크트리는 `▶ `, 실제 켜짐은 `⚡ `를 앞에
 * 붙이고 다음 전송/확인 필요를 덧붙인다. 원시 worktreeId·경로는 넣지 않는다.
 *
 * @param {object} worktree 스냅숏 worktree(`label`, `branch`, `enabled`, `effectiveEnabled`, `terminals`).
 * @param {{current: boolean, paused: boolean, defaultWorktreeEnabled: boolean, serverNow: number}} context
 * @returns {string}
 */
function statusWorktreeLine(worktree, { current, paused, defaultWorktreeEnabled, serverNow }) {
  const wt = isPlainObject(worktree) ? worktree : {};
  const label = nonEmptyStringOrNull(wt.label) ?? '(이름 없음)';
  const branch = nonEmptyStringOrNull(wt.branch);
  // 제목은 프로젝트 이름(label)을 쓰고, branch가 있으면 보조로 덧붙인다.
  const displayLabel = branch !== null && branch !== label ? `${label} (${branch})` : label;
  const override = typeof wt.enabled === 'boolean' ? wt.enabled : null;
  const scopeOn = override === null ? defaultWorktreeEnabled : override;
  const effective = wt.effectiveEnabled === true;
  // 일시정지 중에는 effectiveEnabled가 모두 false가 되므로 사용자가 켜둔 상태(scope)를
  // 드러내 `켜짐(일시정지 중)`으로 표시한다.
  const displayOn = paused ? scopeOn : effective;

  /** @type {string[]} */
  const parts = [];
  let head = '';
  if (current) {
    head += '▶ ';
  }
  if (displayOn) {
    head += '⚡ ';
  }
  head += displayLabel;
  if (displayOn && paused) {
    head += ' 켜짐(일시정지 중)';
  } else {
    head += displayOn ? ' 켜짐' : ' 꺼짐';
    head += override === null ? '(기본값)' : '(직접 설정)';
  }
  parts.push(head);

  const terminals = Array.isArray(wt.terminals) ? wt.terminals : [];
  let nextDueAt = null;
  let reviewCount = 0;
  for (const terminal of terminals) {
    if (!isPlainObject(terminal)) {
      continue;
    }
    // 실제로 보내지 않을 터미널(워크트리/터미널 꺼짐, 일시정지)의 dueAt은 표시하지 않는다.
    const dueAt = !paused && terminal.effectiveEnabled === true ? finiteOrNull(terminal.dueAt) : null;
    if (dueAt !== null && (nextDueAt === null || dueAt < nextDueAt)) {
      nextDueAt = dueAt;
    }
    if (terminal.needsReview === true) {
      reviewCount += 1;
    }
  }
  if (nextDueAt !== null) {
    parts.push(`다음 전송 ${relativeFutureText(nextDueAt - serverNow)}`);
  }
  if (reviewCount > 0) {
    parts.push(`확인 필요 ${reviewCount}`);
  }

  return parts.join(' · ');
}

/**
 * 런타임 뷰 + 저장소 정책을 결합한 대시보드 모델을 만든다.
 *
 * @param {object} options
 * @param {{snapshot: () => any, setPaused: Function, setWorktree: Function, setTerminal: Function, updateConfig: Function, resetBudget: Function, clearReview: Function, getBudget: Function, getOverrides: Function, isAllowedByPolicy: Function}} options.store
 * @param {() => object} options.getRuntimeView 동기 런타임 뷰 제공자.
 * @param {() => Array<object>} [options.getDiagnostics] 최근 진단 배열(오래된 것 → 최신).
 * @param {(info: {worktreeId: string, paneKey: string}) => void} [options.onReviewCleared]
 * @param {() => void} [options.onPolicyChanged] 성공한 mutation 뒤 호출.
 * @param {() => string} [options.randomId]
 * @param {() => number} [options.now]
 * @returns {{
 *   snapshot: () => object,
 *   dispatch: (action: unknown) => Promise<object>,
 *   toggleWorktreeById: (worktreeId: string) => Promise<{enabled: boolean, label: string|null}>,
 *   setWorktreeById: (worktreeId: string, enabled: boolean|null, options?: {expectedRevision?: number}) => Promise<{enabled: boolean, override: boolean|null, label: string|null}>,
 *   setPaused: (paused: boolean) => Promise<void>,
 *   togglePaused: () => Promise<{paused: boolean}>,
 *   statusSummary: (options?: {currentWorktreeId?: string|null}) => {text: string},
 * }}
 */
export function createDashboardModel({
  store,
  getRuntimeView,
  getDiagnostics = () => [],
  onReviewCleared = () => {},
  onPolicyChanged = () => {},
  randomId = () => crypto.randomBytes(12).toString('base64url'),
  now = Date.now,
} = {}) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('createDashboardModel requires a store');
  }
  if (typeof getRuntimeView !== 'function') {
    throw new TypeError('createDashboardModel requires getRuntimeView');
  }

  /** @type {Map<string, string>} 내부 key → opaque targetId */
  const keyToId = new Map();
  /** @type {Map<string, {key: string, kind: 'worktree'|'terminal', scope: {userDataKey: string, profileId: string, worktreeId: string, paneKey: string|null}}>} */
  const idToEntry = new Map();
  /** 현재(마지막) 스냅숏에 존재하는 내부 key 집합. */
  let liveKeys = new Set();
  let mintCounter = 0;

  /**
   * opaque targetId를 발급한다. 결정적 randomId로 충돌이 나도 유일성을 보장한다.
   * @returns {string}
   */
  function mintId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomId();
      if (typeof candidate === 'string' && candidate.length > 0 && !idToEntry.has(candidate)) {
        return candidate;
      }
    }
    let fallback;
    do {
      mintCounter += 1;
      fallback = `target-${mintCounter}`;
    } while (idToEntry.has(fallback));
    return fallback;
  }

  /**
   * 내부 key에 안정적인 targetId를 부여하고 scope를 최신화한다.
   * @param {string} key
   * @param {'worktree'|'terminal'} kind
   * @param {{userDataKey: string, profileId: string, worktreeId: string, paneKey: string|null}} scope
   * @returns {string}
   */
  function ensureId(key, kind, scope) {
    const existing = keyToId.get(key);
    if (existing !== undefined) {
      const entry = idToEntry.get(existing);
      if (entry !== undefined) {
        entry.scope = scope;
      }
      return existing;
    }
    const id = mintId();
    keyToId.set(key, id);
    idToEntry.set(id, { key, kind, scope });
    return id;
  }

  /**
   * @returns {Record<string, unknown>}
   */
  function readRuntimeView() {
    const view = getRuntimeView();
    if (view === null || typeof view !== 'object' || Array.isArray(view)) {
      return {};
    }
    return /** @type {Record<string, unknown>} */ (view);
  }

  /**
   * @param {Record<string, unknown>} view
   * @returns {{userDataKey: string|null, profileId: string|null}}
   */
  function identityOf(view) {
    return {
      userDataKey: nonEmptyStringOrNull(view.userDataKey),
      profileId: nonEmptyStringOrNull(view.profileId),
    };
  }

  /**
   * @param {Record<string, unknown>} view
   * @returns {{known: boolean, enabled: boolean, ttlMs: number|null, source: 'sqlite'|'json'|null, readAt: number|null, reason?: string}}
   */
  function appTimerOf(view) {
    const raw = isPlainObject(view.appTimer) ? /** @type {Record<string, unknown>} */ (view.appTimer) : {};
    /** @type {{known: boolean, enabled: boolean, ttlMs: number|null, source: 'sqlite'|'json'|null, readAt: number|null, reason?: string}} */
    const timer = {
      known: raw.known === true,
      enabled: raw.enabled === true,
      ttlMs: finiteOrNull(raw.ttlMs),
      source: raw.source === 'sqlite' || raw.source === 'json' ? raw.source : null,
      readAt: finiteOrNull(raw.readAt),
    };
    const reason = nonEmptyStringOrNull(raw.reason);
    if (reason !== null) {
      timer.reason = reason;
    }
    return timer;
  }

  /**
   * @param {Record<string, unknown>} view
   * @returns {{state: string, reason: string|null}}
   */
  function connectionOf(view) {
    const raw = isPlainObject(view.connection) ? /** @type {Record<string, unknown>} */ (view.connection) : {};
    const state = typeof raw.state === 'string' && CONNECTION_STATES.has(raw.state) ? raw.state : 'unavailable';
    return { state, reason: nonEmptyStringOrNull(raw.reason) };
  }

  /**
   * 앱 타이머/런타임 연결 게이트 사유. 통과하면 null.
   * @param {{known: boolean, enabled: boolean}} timer
   * @param {{state: string}} connection
   * @returns {string|null}
   */
  function runtimeGateReason(timer, connection) {
    if (!timer.known) {
      return 'SETTINGS_UNKNOWN';
    }
    if (!timer.enabled) {
      return 'APP_TIMER_OFF';
    }
    if (connection.state !== 'connected') {
      return connection.state === 'wrong_runtime' ? 'WRONG_RUNTIME' : 'RUNTIME_UNAVAILABLE';
    }
    return null;
  }

  /**
   * 정책 사유를 저장소에서 읽는다. scope가 유효하지 않으면 generic 사유를 돌려준다.
   * @param {{userDataKey: string, profileId: string, worktreeId: string, paneKey?: string|null}} scope
   * @returns {{allowed: boolean, reason: string|null}}
   */
  function policyOf(scope) {
    try {
      const result = store.isAllowedByPolicy(scope);
      if (isPlainObject(result) && typeof result.allowed === 'boolean') {
        return { allowed: result.allowed, reason: nonEmptyStringOrNull(result.reason) };
      }
      return { allowed: false, reason: 'STORAGE_FAILED' };
    } catch {
      return { allowed: false, reason: 'STORAGE_FAILED' };
    }
  }

  /**
   * 워크트리 effective/reason. budget 기반 사유는 무시하고 GLOBAL_PAUSED/
   * SCOPE_DISABLED만 반영한다.
   * @param {{known: boolean, enabled: boolean}} timer
   * @param {{state: string}} connection
   * @param {{allowed: boolean, reason: string|null}} policy
   * @returns {{effectiveEnabled: boolean, reason: string|null}}
   */
  function worktreeGate(timer, connection, policy) {
    const gate = runtimeGateReason(timer, connection);
    if (gate !== null) {
      return { effectiveEnabled: false, reason: gate };
    }
    if (!policy.allowed && policy.reason !== null && !WORKTREE_IGNORED_POLICY_REASONS.has(policy.reason)) {
      return { effectiveEnabled: false, reason: policy.reason };
    }
    return { effectiveEnabled: true, reason: null };
  }

  /**
   * 터미널 effective/reason. 우선순위: !supported → app/연결 → 정책 → 런타임 reason.
   * @param {boolean} supported
   * @param {string|null} unsupportedReason
   * @param {{known: boolean, enabled: boolean}} timer
   * @param {{state: string}} connection
   * @param {{allowed: boolean, reason: string|null}} policy
   * @param {string|null} runtimeReason
   * @returns {{effectiveEnabled: boolean, reason: string|null}}
   */
  function terminalGate(supported, unsupportedReason, timer, connection, policy, runtimeReason) {
    if (!supported) {
      return { effectiveEnabled: false, reason: unsupportedReason };
    }
    const gate = runtimeGateReason(timer, connection);
    if (gate !== null) {
      return { effectiveEnabled: false, reason: gate };
    }
    if (!policy.allowed) {
      return { effectiveEnabled: false, reason: policy.reason };
    }
    return { effectiveEnabled: true, reason: runtimeReason };
  }

  /**
   * @param {Array<object>} entries
   * @returns {Array<object>}
   */
  function mapDiagnostics(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.slice(-50).map((entry) => {
      const diag = isPlainObject(entry) ? /** @type {Record<string, unknown>} */ (entry) : {};
      /** @type {{at: number, level: string, event: string, code?: string}} */
      const mapped = {
        at: finiteOrNull(diag.at) ?? 0,
        level: nonEmptyStringOrNull(diag.level) ?? 'info',
        event: nonEmptyStringOrNull(diag.event) ?? nonEmptyStringOrNull(diag.code) ?? '',
      };
      const code = nonEmptyStringOrNull(diag.code);
      if (code !== null) {
        mapped.code = code;
      }
      return mapped;
    });
  }

  /**
   * 공개 DashboardSnapshot을 만든다. 매 호출마다 live target 집합을 갱신한다.
   * @returns {object}
   */
  function snapshot() {
    const view = readRuntimeView();
    const { userDataKey, profileId } = identityOf(view);
    const timer = appTimerOf(view);
    const connection = connectionOf(view);

    const worktrees = [];
    const nextLive = new Set();

    if (userDataKey !== null && profileId !== null) {
      const rawWorktrees = Array.isArray(view.worktrees) ? view.worktrees : [];
      for (const rawWorktree of rawWorktrees) {
        if (!isPlainObject(rawWorktree)) {
          continue;
        }
        const worktreeId = nonEmptyStringOrNull(rawWorktree.worktreeId);
        if (worktreeId === null) {
          continue;
        }
        const worktreeScope = { userDataKey, profileId, worktreeId };
        const wtKey = worktreeKey(worktreeId);
        const wtId = ensureId(wtKey, 'worktree', { ...worktreeScope, paneKey: null });
        nextLive.add(wtKey);

        const override = store.getOverrides(worktreeScope);
        const enabled =
          isPlainObject(override) && (override.worktree === true || override.worktree === false)
            ? override.worktree
            : null;
        const gate = worktreeGate(timer, connection, policyOf(worktreeScope));

        const terminals = [];
        const rawTerminals = Array.isArray(rawWorktree.terminals) ? rawWorktree.terminals : [];
        for (const rawTerminal of rawTerminals) {
          if (!isPlainObject(rawTerminal)) {
            continue;
          }
          const paneKey = nonEmptyStringOrNull(rawTerminal.paneKey);
          if (paneKey === null) {
            continue;
          }
          const terminalScope = { userDataKey, profileId, worktreeId, paneKey };
          const tmKey = terminalKey(worktreeId, paneKey);
          const tmId = ensureId(tmKey, 'terminal', terminalScope);
          nextLive.add(tmKey);

          const supported = rawTerminal.supported !== false;
          const unsupportedReason = nonEmptyStringOrNull(rawTerminal.unsupportedReason);
          const runtimeReason = nonEmptyStringOrNull(rawTerminal.reason);
          const terminalGateResult = terminalGate(
            supported,
            unsupportedReason,
            timer,
            connection,
            policyOf(terminalScope),
            runtimeReason,
          );

          const terminalOverride = store.getOverrides(terminalScope);
          const enabledOverride =
            isPlainObject(terminalOverride) && (terminalOverride.terminal === true || terminalOverride.terminal === false)
              ? terminalOverride.terminal
              : null;

          const budget = store.getBudget(terminalScope);
          const title = nonEmptyStringOrNull(rawTerminal.title) ?? '(제목 없음)';

          terminals.push({
            id: tmId,
            title: title.slice(0, 200),
            phase: nonEmptyStringOrNull(rawTerminal.phase) ?? 'UNKNOWN',
            enabledOverride,
            effectiveEnabled: terminalGateResult.effectiveEnabled,
            reason: terminalGateResult.reason,
            dueAt: finiteOrNull(rawTerminal.dueAt),
            expiresAt: finiteOrNull(rawTerminal.expiresAt),
            charged: isPlainObject(budget) && typeof budget.charged === 'number' ? budget.charged : 0,
            confirmed: isPlainObject(budget) && typeof budget.confirmed === 'number' ? budget.confirmed : 0,
            needsReview: isPlainObject(budget) && budget.needsReview === true,
            supported,
          });
        }

        worktrees.push({
          id: wtId,
          worktreeHash: worktreeHashOf(worktreeId),
          label: nonEmptyStringOrNull(rawWorktree.label) ?? '(이름 없음)',
          branch: nonEmptyStringOrNull(rawWorktree.branch),
          enabled,
          effectiveEnabled: gate.effectiveEnabled,
          reason: gate.reason,
          terminals,
        });
      }
    }

    liveKeys = nextLive;

    const stored = store.snapshot();
    const config = isPlainObject(stored) && isPlainObject(stored.config) ? stored.config : {};

    return {
      revision: isPlainObject(stored) && Number.isSafeInteger(stored.revision) ? stored.revision : 0,
      serverNow: now(),
      appTimer: timer,
      connection,
      config: {
        paused: config.paused === true,
        defaultWorktreeEnabled: config.defaultWorktreeEnabled === true,
        message: typeof config.message === 'string' ? config.message : '',
        margin5mMs: finiteOrNull(config.margin5mMs),
        margin1hMs: finiteOrNull(config.margin1hMs),
        quietOutputMs: finiteOrNull(config.quietOutputMs),
        observedInputQuietMs: finiteOrNull(config.observedInputQuietMs),
        maxConsecutiveKeepalives: finiteOrNull(config.maxConsecutiveKeepalives),
        respectCwarmDisabled: config.respectCwarmDisabled === true,
        logLevel: typeof config.logLevel === 'string' ? config.logLevel : 'info',
        runtimeUserDataPath: typeof config.runtimeUserDataPath === 'string' ? config.runtimeUserDataPath : null,
        tabTitleIndicator: config.tabTitleIndicator === true,
      },
      worktrees,
      diagnostics: mapDiagnostics(getDiagnostics()),
    };
  }

  /**
   * Action을 검증한다. 위반 시 ActionError(400,'invalid_action').
   * @param {unknown} action
   * @returns {{type: string, expectedRevision: number, [key: string]: unknown}}
   */
  function validateAction(action) {
    if (!isPlainObject(action)) {
      throw new ActionError(400, 'invalid_action');
    }
    const type = action.type;
    if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
      throw new ActionError(400, 'invalid_action');
    }
    if (!Number.isSafeInteger(action.expectedRevision)) {
      throw new ActionError(400, 'invalid_action');
    }
    const expectedRevision = /** @type {number} */ (action.expectedRevision);

    if (type === 'pause') {
      if (typeof action.paused !== 'boolean') {
        throw new ActionError(400, 'invalid_action');
      }
      return { type, paused: action.paused, expectedRevision };
    }
    if (type === 'worktree' || type === 'terminal') {
      const enabled = action.enabled;
      if (enabled !== true && enabled !== false && enabled !== null) {
        throw new ActionError(400, 'invalid_action');
      }
      return { type, targetId: action.targetId, enabled, expectedRevision };
    }
    if (type === 'worktree-orca') {
      // worktreeId의 존재 여부/빈 문자열은 resolve 단계에서 404로 처리한다.
      if (typeof action.worktreeId !== 'string') {
        throw new ActionError(400, 'invalid_action');
      }
      const enabled = action.enabled;
      if (enabled !== true && enabled !== false && enabled !== null) {
        throw new ActionError(400, 'invalid_action');
      }
      return { type, worktreeId: action.worktreeId, enabled, expectedRevision };
    }
    if (type === 'config') {
      // patch 검증은 store/config가 수행한다.
      return { type, patch: action.patch, expectedRevision };
    }
    return { type, targetId: action.targetId, expectedRevision };
  }

  /**
   * targetId를 현재 live 스냅숏의 내부 scope로 해석한다.
   * @param {unknown} targetId
   * @param {'worktree'|'terminal'} expectedKind
   * @returns {{key: string, kind: 'worktree'|'terminal', scope: {userDataKey: string, profileId: string, worktreeId: string, paneKey: string|null}}}
   */
  function resolveTarget(targetId, expectedKind) {
    const id = nonEmptyStringOrNull(targetId);
    if (id === null) {
      throw new ActionError(404, 'unknown_target');
    }
    const entry = idToEntry.get(id);
    if (entry === undefined || !liveKeys.has(entry.key)) {
      throw new ActionError(404, 'unknown_target');
    }
    if (entry.kind !== expectedKind) {
      throw new ActionError(404, 'unknown_target');
    }
    const { userDataKey, profileId } = identityOf(readRuntimeView());
    if (
      userDataKey === null ||
      profileId === null ||
      entry.scope.userDataKey !== userDataKey ||
      entry.scope.profileId !== profileId
    ) {
      throw new ActionError(404, 'unknown_target');
    }
    return entry;
  }

  /**
   * 저장소/설정 오류를 ActionError로 매핑한다. 알 수 없는 오류는 그대로 던진다.
   * @param {unknown} error
   * @returns {Error}
   */
  function mapError(error) {
    if (error instanceof ActionError) {
      return error;
    }
    if (error instanceof StoreError) {
      switch (error.code) {
        case 'revision_conflict':
          return new ActionError(409, 'revision_conflict');
        case 'storage_failed':
        case 'state_too_large':
        case 'row_limit':
          return new ActionError(503, error.code);
        case 'invalid_scope':
          return new ActionError(400, 'invalid_scope');
        default:
          return /** @type {Error} */ (error);
      }
    }
    if (error instanceof ValidationError) {
      return new ActionError(400, 'invalid_config');
    }
    return /** @type {Error} */ (error);
  }

  /**
   * 대시보드 Action을 적용하고 새 snapshot을 반환한다.
   * @param {unknown} action
   * @returns {Promise<object>}
   */
  async function dispatch(action) {
    const validated = validateAction(action);
    const expectedRevision = /** @type {number} */ (validated.expectedRevision);

    try {
      switch (validated.type) {
        case 'pause': {
          await store.setPaused(validated.paused, { expectedRevision });
          break;
        }
        case 'worktree': {
          const entry = resolveTarget(validated.targetId, 'worktree');
          await store.setWorktree(entry.scope, /** @type {boolean|null} */ (validated.enabled), { expectedRevision });
          break;
        }
        case 'worktree-orca': {
          await applyWorktreeById(validated.worktreeId, validated.enabled, { expectedRevision });
          break;
        }
        case 'terminal': {
          const entry = resolveTarget(validated.targetId, 'terminal');
          await store.setTerminal(entry.scope, /** @type {boolean|null} */ (validated.enabled), { expectedRevision });
          break;
        }
        case 'config': {
          await store.updateConfig(validated.patch, { expectedRevision });
          break;
        }
        case 'reset-budget': {
          const entry = resolveTarget(validated.targetId, 'terminal');
          await store.resetBudget(entry.scope, { expectedRevision });
          break;
        }
        case 'clear-review': {
          const entry = resolveTarget(validated.targetId, 'terminal');
          await store.clearReview(entry.scope, { expectedRevision });
          onReviewCleared({ worktreeId: entry.scope.worktreeId, paneKey: entry.scope.paneKey });
          break;
        }
        default:
          throw new ActionError(400, 'invalid_action');
      }
    } catch (error) {
      throw mapError(error);
    }

    onPolicyChanged();
    return snapshot();
  }

  /**
   * 원시 worktreeId로 worktree override를 적용한다. `onPolicyChanged`는 호출하지
   * 않는다(호출자가 1회만 부른다).
   * @param {unknown} worktreeId
   * @param {unknown} enabled
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<{enabled: boolean, override: boolean|null, label: string|null}>}
   */
  async function applyWorktreeById(worktreeId, enabled, options) {
    if (enabled !== true && enabled !== false && enabled !== null) {
      throw new ActionError(400, 'invalid_action');
    }
    const view = readRuntimeView();
    const { userDataKey, profileId } = identityOf(view);
    if (userDataKey === null || profileId === null) {
      throw new ActionError(503, 'not_ready');
    }
    const id = nonEmptyStringOrNull(worktreeId);
    if (id === null) {
      throw new ActionError(404, 'unknown_target');
    }
    const rawWorktrees = Array.isArray(view.worktrees) ? view.worktrees : [];
    const match = rawWorktrees.find((w) => isPlainObject(w) && w.worktreeId === id);
    if (match === undefined) {
      throw new ActionError(404, 'unknown_target');
    }
    const scope = { userDataKey, profileId, worktreeId: id };
    await store.setWorktree(scope, /** @type {boolean|null} */ (enabled), options);

    const override = store.getOverrides(scope);
    const currentOverride =
      isPlainObject(override) && (override.worktree === true || override.worktree === false) ? override.worktree : null;
    const stored = store.snapshot();
    const defaultEnabled =
      isPlainObject(stored) && isPlainObject(stored.config) ? stored.config.defaultWorktreeEnabled === true : false;
    const applied = currentOverride === null ? defaultEnabled : currentOverride;
    const label = isPlainObject(match) ? nonEmptyStringOrNull(match.label) : null;
    return { enabled: applied, override: enabled ?? null, label };
  }

  /**
   * 원시 Orca worktreeId로 워크트리 on/off/기본값을 직접 설정한다. 존재하지 않는
   * id는 저장하지 않는다(404 unknown_target).
   * @param {string} worktreeId
   * @param {boolean|null} enabled true/false=override, null=override 제거(기본값 상속).
   * @param {{expectedRevision?: number}} [options]
   * @returns {Promise<{enabled: boolean, override: boolean|null, label: string|null}>}
   */
  async function setWorktreeById(worktreeId, enabled, options) {
    let result;
    try {
      result = await applyWorktreeById(worktreeId, enabled, options);
    } catch (error) {
      throw mapError(error);
    }
    onPolicyChanged();
    return result;
  }

  /**
   * 현재 effective 워크트리 on/off를 반전한다(override 없으면 default 상속).
   * @param {string} worktreeId
   * @returns {Promise<{enabled: boolean, label: string|null}>}
   */
  async function toggleWorktreeById(worktreeId) {
    const view = readRuntimeView();
    const { userDataKey, profileId } = identityOf(view);
    if (userDataKey === null || profileId === null) {
      throw new ActionError(503, 'not_ready');
    }
    const id = nonEmptyStringOrNull(worktreeId);
    if (id === null) {
      throw new ActionError(404, 'unknown_target');
    }
    const scope = { userDataKey, profileId, worktreeId: id };
    const override = store.getOverrides(scope);
    const currentOverride =
      isPlainObject(override) && (override.worktree === true || override.worktree === false) ? override.worktree : null;
    const storedSnapshot = store.snapshot();
    const defaultEnabled =
      isPlainObject(storedSnapshot) && isPlainObject(storedSnapshot.config)
        ? storedSnapshot.config.defaultWorktreeEnabled === true
        : false;
    const current = currentOverride === null ? defaultEnabled : currentOverride;
    const next = !current;

    await store.setWorktree(scope, next);
    onPolicyChanged();

    const rawWorktrees = Array.isArray(view.worktrees) ? view.worktrees : [];
    const match = rawWorktrees.find((w) => isPlainObject(w) && w.worktreeId === id);
    const label = isPlainObject(match) ? nonEmptyStringOrNull(match.label) : null;
    return { enabled: next, label };
  }

  /**
   * 전역 일시정지/재개. expectedRevision 없이 저장한다.
   * @param {boolean} paused
   * @returns {Promise<void>}
   */
  async function setPaused(paused) {
    await store.setPaused(paused === true);
    onPolicyChanged();
  }

  /**
   * 전역 일시정지 상태를 최신 revision 기준으로 반전한다. revision_conflict면
   * 새 snapshot으로 1회만 재시도하고, 두 번째도 충돌이면 409 ActionError로
   * 매핑해 던진다. 성공 시에만 onPolicyChanged를 1회 호출한다.
   * @returns {Promise<{paused: boolean}>} 반영된 새 paused 값.
   */
  async function togglePaused() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stored = store.snapshot();
      const revision = isPlainObject(stored) && Number.isSafeInteger(stored.revision) ? stored.revision : 0;
      const paused = isPlainObject(stored) && isPlainObject(stored.config) ? stored.config.paused === true : false;
      const next = !paused;
      try {
        await store.setPaused(next, { expectedRevision: revision });
      } catch (error) {
        // 경쟁으로 revision이 바뀌었으면 최신 snapshot으로 한 번만 재시도한다.
        if (attempt === 0 && error instanceof StoreError && error.code === 'revision_conflict') {
          continue;
        }
        throw mapError(error);
      }
      onPolicyChanged();
      return { paused: next };
    }
    // 루프는 항상 위에서 return하거나 throw하므로 도달하지 않는다.
    throw new ActionError(409, 'revision_conflict');
  }

  /** 상태 알림 본문 상한(문자). main.mjs의 알림 본문 상한 1000자보다 짧게 잡는다. */
  const STATUS_MAX_CHARS = 480;

  /**
   * 커맨드/알림용 한국어 요약(비밀·경로·원시 worktreeId 없음, 480자 이하).
   *
   * 1행은 전역 상태(켜짐/꺼짐(일시정지) · 타이머 · 연결)를, 이후에는 워크트리별
   * 켜짐/꺼짐 목록을 한 줄씩 보여준다. `options.currentWorktreeId`(원시 Orca
   * worktreeId)를 해시해 현재 워크트리를 찾으면 맨 앞에 `▶ `를 붙인다.
   *
   * @param {{currentWorktreeId?: string|null}} [options]
   * @returns {{text: string}}
   */
  function statusSummary(options) {
    const opts = isPlainObject(options) ? options : {};
    const snap = snapshot();
    const paused = snap.config.paused === true;
    const defaultWorktreeEnabled = snap.config.defaultWorktreeEnabled === true;
    const serverNow = finiteOrNull(snap.serverNow) ?? 0;
    const worktrees = Array.isArray(snap.worktrees) ? snap.worktrees : [];

    // 전역 상태 1행.
    const headerParts = [paused ? '꺼짐(일시정지)' : '켜짐'];
    if (!snap.appTimer.known) {
      headerParts.push('앱 타이머 설정 알 수 없음');
    } else if (snap.appTimer.enabled) {
      headerParts.push(`타이머 켜짐(${TTL_TEXT[snap.appTimer.ttlMs] ?? '알 수 없음'})`);
    } else {
      headerParts.push('Orca 프롬프트 캐시 타이머 꺼짐');
    }
    headerParts.push(CONNECTION_TEXT[snap.connection.state] ?? snap.connection.state);
    headerParts.push(`워크트리 ${worktrees.length}개`);
    const header = headerParts.join(' · ');

    if (worktrees.length === 0) {
      return { text: `${header}\n대상 워크트리 없음` };
    }

    // 현재 워크트리(해시 일치)를 맨 앞으로, 나머지는 스냅숏 순서 유지.
    const currentRaw = nonEmptyStringOrNull(opts.currentWorktreeId);
    const currentHash = currentRaw === null ? null : worktreeHashOf(currentRaw);
    const current =
      currentHash === null ? null : worktrees.find((worktree) => worktree.worktreeHash === currentHash) ?? null;
    const ordered = current === null ? worktrees : [current, ...worktrees.filter((worktree) => worktree !== current)];

    const lines = ordered.map((worktree) =>
      statusWorktreeLine(worktree, {
        current: worktree === current,
        paused,
        defaultWorktreeEnabled,
        serverNow,
      }),
    );

    const fullText = [header, ...lines].join('\n');
    if (fullText.length <= STATUS_MAX_CHARS) {
      return { text: fullText };
    }

    // 480자를 넘으면 뒤쪽 워크트리를 잘라 `… 외 N개`로 끝낸다.
    let kept = 0;
    for (let k = lines.length - 1; k >= 0; k -= 1) {
      const candidate = [header, ...lines.slice(0, k), `… 외 ${lines.length - k}개`].join('\n');
      if (candidate.length <= STATUS_MAX_CHARS) {
        kept = k;
        break;
      }
    }
    return { text: [header, ...lines.slice(0, kept), `… 외 ${lines.length - kept}개`].join('\n') };
  }

  return { snapshot, dispatch, toggleWorktreeById, setWorktreeById, setPaused, togglePaused, statusSummary };
}

/** @typedef {import('./contracts.mjs').DashboardSnapshot} DashboardSnapshot */
/** @typedef {import('./contracts.mjs').Action} Action */
