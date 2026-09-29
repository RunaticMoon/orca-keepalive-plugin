/**
 * Cache Keepalive dashboard front end.
 *
 * This module is served verbatim by the authenticated loopback server
 * (`src/dashboard-server.mjs`), which only exposes `/`, `/app.mjs` and
 * `/style.css`. It therefore has **no imports** and must stay a single
 * self-contained ES module.
 *
 * The pure helpers below (`formatRemaining`, `reasonText`, `toViewModel`,
 * `buildAction`, `parseTokenFromHash`) have no DOM or browser dependency and
 * are imported directly by `test/dashboard-view.test.mjs`. The DOM bootstrap at
 * the bottom of the file only runs when a `document` exists, so importing the
 * module under Node never touches browser globals.
 *
 * Security/robustness rules enforced here (DESIGN §7.3–§7.4):
 *  - the bearer token is read from the URL fragment once, stored in
 *    sessionStorage, and the fragment is erased with history.replaceState,
 *  - every dynamic value is written with `textContent`/DOM APIs, never by
 *    assigning raw markup,
 *  - the client clock never decides an actual send; it only renders elapsed
 *    time relative to the server-provided `serverNow`,
 *  - all mutations carry `expectedRevision` and a 409 triggers a refresh plus a
 *    "changed elsewhere" notice.
 *
 * @module dashboard-app
 */

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Korean one-sentence explanation for every reason code in
 * `src/contracts.mjs` `REASON_CODES` (§8). Each sentence says what the user can
 * do about the reason.
 * @type {Readonly<Record<string, string>>}
 */
export const REASON_TEXT = Object.freeze({
  APP_TIMER_OFF:
    'Orca 설정 > 에이전트 > 프롬프트 캐시 타이머가 꺼져 있습니다.',
  SETTINGS_UNKNOWN:
    '앱 타이머 설정을 읽지 못했습니다. Orca 실행 상태와 버전을 확인하세요.',
  RUNTIME_UNAVAILABLE:
    'Orca 런타임에 연결할 수 없습니다. Orca가 실행 중인지 확인하세요.',
  WRONG_RUNTIME:
    '다른 Orca 런타임에 연결되어 있습니다. 이 창에서 대시보드를 다시 여세요.',
  NO_FRESH_TURN:
    '최근에 완료된 작업이 없어 캐시 만료 시점을 알 수 없습니다.',
  UNSUPPORTED_AGENT:
    '이 터미널의 에이전트는 지원하지 않습니다.',
  UNSUPPORTED_HOST:
    '이 실행 환경은 keepalive 전송을 지원하지 않습니다.',
  NOT_CONNECTED:
    '터미널에 연결되어 있지 않습니다. Orca에서 터미널을 확인하세요.',
  BUSY:
    '에이전트가 작업 중이라 전송하지 않았습니다. 끝나면 다시 시도합니다.',
  INTERACTIVE_WAIT:
    '에이전트가 입력이나 권한 응답을 기다리고 있어 자동 전송하지 않습니다.',
  UNKNOWN_WAIT:
    '에이전트 대기 상태를 알 수 없어 전송하지 않습니다.',
  OUTPUT_ACTIVE:
    '최근 출력이 있어 조용해질 때까지 기다립니다.',
  DRAFT_PRESENT:
    '입력창에 초안이 있어 전송하지 않습니다. 초안을 지우면 다시 동작합니다.',
  SCREEN_UNKNOWN:
    '터미널 화면을 읽지 못해 전송하지 않습니다.',
  INPUT_QUIET_WINDOW:
    '최근 입력이 감지되어 조용한 시간이 지나기를 기다립니다.',
  SCOPE_DISABLED:
    '이 범위(워크트리 또는 터미널)가 꺼져 있습니다.',
  GLOBAL_PAUSED:
    '전역 일시정지 상태입니다. 재개하면 다시 동작합니다.',
  CWARM_DISABLED:
    '~/.claude/cwarm.disabled 파일 때문에 전송이 차단되었습니다.',
  LIMIT_REACHED:
    '연속 keepalive 상한에 도달했습니다. 작업을 재개하거나 횟수를 초기화하세요.',
  EXPIRED:
    '예약된 캐시가 만료되었습니다. 다음 작업 완료 후 다시 예약됩니다.',
  STALE_TARGET:
    '터미널이 더 이상 존재하지 않거나 변경되었습니다. 화면을 새로 고칩니다.',
  STORAGE_FAILED:
    '상태 저장에 실패했습니다. 로그와 디스크 상태를 확인하세요.',
  PARTIAL_OR_UNKNOWN_SEND:
    '전송 결과를 확인할 수 없습니다. 터미널 입력창을 확인하세요.',
});

/** Em dash used for unknown numeric values. */
const PLACEHOLDER = '\u2014';

/** TTL display labels. */
const TTL_TEXT = Object.freeze({
  300000: '5분',
  3600000: '1시간',
});

/** Human labels for `connection.state`. */
const CONNECTION_TEXT = Object.freeze({
  connected: '연결됨',
  unavailable: '연결할 수 없음',
  wrong_runtime: '다른 런타임',
  starting: '시작 중',
});

/**
 * Explain a reason code in Korean. Unknown codes are returned unchanged so no
 * information is hidden.
 * @param {unknown} code
 * @returns {string}
 */
export function reasonText(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return '';
  }
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, code)
    ? REASON_TEXT[code]
    : code;
}

/**
 * Format a remaining duration as `m:ss` (minutes unpadded, seconds 2-digit).
 *  - `null`/`undefined`/non-finite → `"—"`
 *  - `ms <= 0` → `"만료됨"`
 *  - otherwise ceil to whole seconds, e.g. `299000 → "4:59"`,
 *    `3482000 → "58:02"`.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatRemaining(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return PLACEHOLDER;
  }
  if (ms <= 0) {
    return '만료됨';
  }
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format an absolute epoch as local `HH:MM:SS`.
 * @param {number} ms
 * @returns {string}
 */
function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return PLACEHOLDER;
  }
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Human text for the app timer settings read (§6 SettingsSnapshot).
 * @param {{known: boolean, enabled: boolean, ttlMs: number|null, reason: string|null}} timer
 * @returns {string}
 */
function appTimerText(timer) {
  if (!timer.known) {
    return timer.reason ? `알 수 없음 — ${reasonText(timer.reason)}` : '알 수 없음';
  }
  const ttl = timer.ttlMs === null ? '알 수 없음' : (TTL_TEXT[timer.ttlMs] ?? `${timer.ttlMs}ms`);
  return `${timer.enabled ? '켜짐' : '꺼짐'} · TTL ${ttl}`;
}

/**
 * @param {string} state
 * @returns {string}
 */
function connectionText(state) {
  return CONNECTION_TEXT[state] ?? state;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Flatten a raw `DashboardSnapshot` into render-ready data.
 *
 * Time-relative fields (`remainingMs`, `dueInMs`) are computed from the
 * server clock plus the caller-provided elapsed time, never from the raw client
 * wall clock.
 *
 * @param {object} snapshot DashboardSnapshot (may be partial in tests).
 * @param {number} [clientElapsedMs] Milliseconds observed since the snapshot was received.
 * @returns {object}
 */
export function toViewModel(snapshot, clientElapsedMs = 0) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const elapsed =
    typeof clientElapsedMs === 'number' && Number.isFinite(clientElapsedMs) && clientElapsedMs > 0
      ? clientElapsedMs
      : 0;
  const serverNow = finiteOrNull(snap.serverNow) ?? 0;
  const now = serverNow + elapsed;

  const rawConfig = snap.config && typeof snap.config === 'object' ? snap.config : {};
  const paused = rawConfig.paused === true;

  const rawTimer = snap.appTimer && typeof snap.appTimer === 'object' ? snap.appTimer : {};
  const timer = {
    known: rawTimer.known === true,
    enabled: rawTimer.enabled === true,
    ttlMs: finiteOrNull(rawTimer.ttlMs),
    source: typeof rawTimer.source === 'string' ? rawTimer.source : null,
    readAt: finiteOrNull(rawTimer.readAt),
    reason: typeof rawTimer.reason === 'string' ? rawTimer.reason : null,
  };

  const rawConnection =
    snap.connection && typeof snap.connection === 'object' ? snap.connection : {};
  const connectionState =
    typeof rawConnection.state === 'string' ? rawConnection.state : 'unavailable';

  /**
   * @param {object} terminal
   */
  const mapTerminal = (terminal) => {
    const expiresAt = finiteOrNull(terminal.expiresAt);
    const dueAt = finiteOrNull(terminal.dueAt);
    const remainingMs = expiresAt === null ? null : expiresAt - now;
    const dueInMs = dueAt === null ? null : dueAt - now;
    const override =
      terminal.enabledOverride === true
        ? true
        : terminal.enabledOverride === false
          ? false
          : null;
    return {
      id: typeof terminal.id === 'string' ? terminal.id : '',
      title: typeof terminal.title === 'string' ? terminal.title : '',
      phase: typeof terminal.phase === 'string' ? terminal.phase : 'UNKNOWN',
      enabledOverride: override,
      scopeValue: override === null ? 'inherit' : override ? 'on' : 'off',
      effectiveEnabled: terminal.effectiveEnabled === true,
      reason: typeof terminal.reason === 'string' ? terminal.reason : null,
      reasonText: typeof terminal.reason === 'string' ? reasonText(terminal.reason) : '',
      expiresAt,
      dueAt,
      remainingMs,
      dueInMs,
      remainingText: formatRemaining(remainingMs),
      dueText: dueInMs === null ? PLACEHOLDER : dueInMs <= 0 ? '임박' : formatRemaining(dueInMs),
      expired: remainingMs !== null && remainingMs <= 0,
      charged: finiteOrNull(terminal.charged) ?? 0,
      confirmed: finiteOrNull(terminal.confirmed) ?? 0,
      needsReview: terminal.needsReview === true,
      supported: terminal.supported !== false,
    };
  };

  const worktrees = Array.isArray(snap.worktrees)
    ? snap.worktrees.map((worktree) => {
        const wt = worktree && typeof worktree === 'object' ? worktree : {};
        return {
          id: typeof wt.id === 'string' ? wt.id : '',
          label: typeof wt.label === 'string' ? wt.label : '',
          enabled: wt.enabled === true,
          effectiveEnabled: wt.effectiveEnabled === true,
          reason: typeof wt.reason === 'string' ? wt.reason : null,
          reasonText: typeof wt.reason === 'string' ? reasonText(wt.reason) : '',
          terminals: Array.isArray(wt.terminals) ? wt.terminals.map(mapTerminal) : [],
        };
      })
    : [];

  const diagnostics = Array.isArray(snap.diagnostics)
    ? snap.diagnostics.slice(-20).map((entry) => {
        const diag = entry && typeof entry === 'object' ? entry : {};
        const at = finiteOrNull(diag.at);
        return {
          at,
          timeText: at === null ? PLACEHOLDER : formatClock(at),
          level: typeof diag.level === 'string' ? diag.level : 'info',
          event:
            typeof diag.event === 'string'
              ? diag.event
              : typeof diag.code === 'string'
                ? diag.code
                : '',
          code: typeof diag.code === 'string' ? diag.code : null,
        };
      })
    : [];

  const maxConsecutive = finiteOrNull(rawConfig.maxConsecutiveKeepalives);
  return {
    revision: finiteOrNull(snap.revision),
    serverNow,
    now,
    paused,
    pauseLabel: paused ? '재개' : '일시정지',
    maxConsecutiveKeepalives: maxConsecutive,
    maxConsecutiveText:
      maxConsecutive === null ? PLACEHOLDER : maxConsecutive === 0 ? '무제한' : String(maxConsecutive),
    appTimer: {
      ...timer,
      text: appTimerText(timer),
    },
    connection: {
      state: connectionState,
      connected: connectionState === 'connected',
      text: connectionText(connectionState),
      reason: typeof rawConnection.reason === 'string' ? rawConnection.reason : null,
      reasonText:
        typeof rawConnection.reason === 'string' ? reasonText(rawConnection.reason) : '',
    },
    config: rawConfig,
    worktrees,
    diagnostics,
  };
}

/**
 * Build the action union member sent to `POST /api/action` (§7.4).
 * Every action carries `expectedRevision`.
 *
 * @param {'pause'|'worktree'|'terminal'|'config'|'reset-budget'|'clear-review'} kind
 * @param {object} [args]
 * @param {number} revision
 * @returns {{type: string, expectedRevision: number}}
 */
export function buildAction(kind, args = {}, revision) {
  const input = args && typeof args === 'object' ? args : {};
  const expectedRevision = revision;
  switch (kind) {
    case 'pause':
      return { type: 'pause', paused: input.paused === true, expectedRevision };
    case 'worktree':
      return {
        type: 'worktree',
        targetId: input.targetId,
        enabled: input.enabled === true,
        expectedRevision,
      };
    case 'terminal':
      return {
        type: 'terminal',
        targetId: input.targetId,
        // null means "revert to inherited".
        enabled:
          input.enabled === null ? null : input.enabled === true,
        expectedRevision,
      };
    case 'config':
      return {
        type: 'config',
        patch: input.patch && typeof input.patch === 'object' ? input.patch : {},
        expectedRevision,
      };
    case 'reset-budget':
      return { type: 'reset-budget', targetId: input.targetId, expectedRevision };
    case 'clear-review':
      return { type: 'clear-review', targetId: input.targetId, expectedRevision };
    default:
      throw new Error(`unknown action kind: ${String(kind)}`);
  }
}

/**
 * Read the dashboard bearer token from a location fragment such as
 * `#token=<base64url>`. Returns `null` when absent or empty.
 * @param {unknown} hash
 * @returns {string|null}
 */
export function parseTokenFromHash(hash) {
  if (typeof hash !== 'string') {
    return null;
  }
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) {
    return null;
  }
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const token = params.get('token');
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/* ------------------------------------------------------------------ */
/* DOM bootstrap (browser only)                                        */
/* ------------------------------------------------------------------ */

/**
 * Start the dashboard UI. Only invoked when `document` exists.
 * @returns {void}
 */
function boot() {
  const TOKEN_KEY = 'cache-keepalive-token';
  const POLL_MS = 2000;
  const TICK_MS = 250;

  const byId = (id) => document.getElementById(id);

  const nodes = {
    tokenMissing: byId('token-missing'),
    appTimer: byId('app-timer'),
    connection: byId('connection-state'),
    pauseState: byId('pause-state'),
    pauseToggle: byId('pause-toggle'),
    disconnect: byId('disconnect-banner'),
    notice: byId('notice'),
    error: byId('error-live'),
    worktrees: byId('worktrees'),
    diagnostics: byId('diagnostics'),
    form: byId('config-form'),
    save: byId('config-save'),
    cfg: {
      message: byId('cfg-message'),
      margin5m: byId('cfg-margin5m'),
      margin1h: byId('cfg-margin1h'),
      quietOutput: byId('cfg-quiet-output'),
      maxConsecutive: byId('cfg-max-consecutive'),
      defaultWorktree: byId('cfg-default-worktree'),
      respectCwarm: byId('cfg-respect-cwarm'),
      runtimePath: byId('cfg-runtime-path'),
    },
  };

  /** @type {string|null} */
  let token = readToken();
  /** @type {object|null} */
  let snapshot = null;
  let receivedAt = 0;
  let connected = false;
  let dirty = false;
  /** @type {Array<{expiryEl: HTMLElement, dueEl: HTMLElement, expiresAt: number|null, dueAt: number|null}>} */
  let countdowns = [];

  /**
   * Read the token from sessionStorage or the fragment, persist it, and erase
   * the fragment so it cannot leak through history/Referer.
   * @returns {string|null}
   */
  function readToken() {
    let found = null;
    try {
      found = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      found = null;
    }
    if (!found) {
      const fromHash = parseTokenFromHash(window.location.hash);
      if (fromHash) {
        found = fromHash;
        try {
          sessionStorage.setItem(TOKEN_KEY, fromHash);
        } catch {
          /* private mode: keep the in-memory token */
        }
      }
    }
    if (window.location.hash) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {string} message */
  function showNotice(message) {
    if (!nodes.notice) return;
    nodes.notice.textContent = message || '';
    nodes.notice.classList.toggle('hidden', !message);
  }

  /** @param {string} message */
  function showError(message) {
    if (!nodes.error) return;
    nodes.error.textContent = message || '';
  }

  /** @param {boolean} offline */
  function setDisconnected(offline) {
    connected = !offline;
    if (nodes.disconnect) nodes.disconnect.classList.toggle('hidden', !offline);
    if (snapshot) {
      renderAll();
    } else if (offline) {
      disableEverything();
    }
  }

  /** Disable every interactive control (used before the first snapshot). */
  function disableEverything() {
    for (const node of document.querySelectorAll('button, select, input')) {
      node.disabled = true;
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<Response>}
   */
  function authedFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  /**
   * @param {Response} res
   * @returns {Promise<string>}
   */
  async function errorCode(res) {
    try {
      const body = await res.json();
      if (body && body.error && typeof body.error.code === 'string') {
        return body.error.code;
      }
    } catch {
      /* fall through */
    }
    return `HTTP ${res.status}`;
  }

  /** GET /api/state */
  async function refreshState() {
    if (!token) return;
    try {
      const res = await authedFetch('/api/state');
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        throw new Error(`state ${res.status}`);
      }
      const next = await res.json();
      snapshot = next;
      receivedAt = Date.now();
      connected = true;
      if (nodes.disconnect) nodes.disconnect.classList.add('hidden');
      renderAll();
    } catch {
      setDisconnected(true);
    }
  }

  function handleUnauthorized() {
    setDisconnected(true);
    showError('인증이 만료되었습니다. Orca에서 Cache Keepalive: Open Dashboard 명령으로 다시 여세요.');
  }

  /**
   * POST /api/action
   * @param {object} action
   */
  async function postAction(action) {
    if (!token) return;
    try {
      const res = await authedFetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (res.status === 409) {
        showNotice('다른 곳에서 변경됨, 다시 시도');
        await refreshState();
        return;
      }
      if (!res.ok) {
        showError(`요청 실패: ${await errorCode(res)}`);
        await refreshState();
        return;
      }
      const next = await res.json();
      snapshot = next;
      receivedAt = Date.now();
      connected = true;
      showError('');
      showNotice('');
      if (nodes.disconnect) nodes.disconnect.classList.add('hidden');
      renderAll();
    } catch {
      setDisconnected(true);
    }
  }

  function renderAll() {
    if (!snapshot) return;
    const vm = toViewModel(snapshot, Date.now() - receivedAt);
    renderHeader(vm);
    renderWorktrees(vm);
    renderDiagnostics(vm);
    populateConfig(snapshot.config || {});
  }

  /** @param {ReturnType<typeof toViewModel>} vm */
  function renderHeader(vm) {
    if (nodes.appTimer) {
      nodes.appTimer.textContent = vm.appTimer.text;
    }
    if (nodes.connection) {
      nodes.connection.textContent = vm.connection.reasonText
        ? `${vm.connection.text} — ${vm.connection.reasonText}`
        : vm.connection.text;
    }
    if (nodes.pauseState) {
      nodes.pauseState.textContent = vm.paused ? '일시정지됨' : '동작 중';
    }
    if (nodes.pauseToggle) {
      nodes.pauseToggle.textContent = vm.pauseLabel;
      nodes.pauseToggle.setAttribute('aria-pressed', String(vm.paused));
      nodes.pauseToggle.disabled = !connected;
    }
    if (nodes.save) {
      nodes.save.disabled = !connected;
    }
  }

  /** @param {ReturnType<typeof toViewModel>} vm */
  function renderWorktrees(vm) {
    if (!nodes.worktrees) return;
    nodes.worktrees.textContent = '';
    countdowns = [];

    if (vm.worktrees.length === 0) {
      nodes.worktrees.appendChild(el('p', 'worktree-effective', '표시할 워크트리가 없습니다.'));
      return;
    }

    for (const worktree of vm.worktrees) {
      const section = el('section', 'worktree');

      const head = el('div', 'worktree-head');
      head.appendChild(el('h3', null, worktree.label || '워크트리'));
      const toggle = el(
        'button',
        'btn',
        (worktree.enabled ? '● 켜짐' : '○ 꺼짐'),
      );
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(worktree.enabled));
      toggle.setAttribute('aria-label', `워크트리 keepalive 토글: ${worktree.label || worktree.id}`);
      toggle.disabled = !connected;
      toggle.addEventListener('click', () => {
        postAction(
          buildAction('worktree', { targetId: worktree.id, enabled: !worktree.enabled }, snapshot.revision),
        );
      });
      head.appendChild(toggle);
      section.appendChild(head);

      const effective = el(
        'p',
        'worktree-effective',
        `실제 적용: ${worktree.effectiveEnabled ? '켜짐' : '꺼짐'}`,
      );
      if (worktree.reasonText) {
        effective.textContent += ` — ${worktree.reasonText}`;
      }
      section.appendChild(effective);

      const list = el('div', 'terminals');
      for (const terminal of worktree.terminals) {
        list.appendChild(renderTerminal(terminal, vm));
      }
      section.appendChild(list);
      nodes.worktrees.appendChild(section);
    }
  }

  /**
   * @param {object} terminal
   * @param {ReturnType<typeof toViewModel>} vm
   * @returns {HTMLElement}
   */
  function renderTerminal(terminal, vm) {
    const row = el('div', 'terminal');
    if (terminal.needsReview) row.classList.add('terminal-review');
    if (!terminal.supported) row.classList.add('terminal-unsupported');

    const head = el('div', 'terminal-head');
    head.appendChild(el('span', 'terminal-title', terminal.title || '(제목 없음)'));
    head.appendChild(el('span', 'badge badge-phase', terminal.phase));
    head.appendChild(
      el(
        'span',
        terminal.effectiveEnabled ? 'badge badge-on' : 'badge badge-off',
        `${terminal.effectiveEnabled ? '●' : '○'} 적용 ${terminal.effectiveEnabled ? '켜짐' : '꺼짐'}`,
      ),
    );
    row.appendChild(head);

    if (terminal.reasonText) {
      row.appendChild(el('p', 'terminal-reason', `이유: ${terminal.reasonText}`));
    }

    const actions = el('div', 'terminal-actions');

    const scopeLabel = el('label', 'field-inline');
    scopeLabel.appendChild(el('span', 'field-label', '범위'));
    const select = document.createElement('select');
    for (const [value, label] of [
      ['inherit', '상속'],
      ['on', '켜기'],
      ['off', '끄기'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = terminal.scopeValue;
    select.disabled = !connected || !terminal.supported;
    select.setAttribute('aria-label', `터미널 keepalive 범위: ${terminal.title || terminal.id}`);
    select.addEventListener('change', () => {
      const enabled = select.value === 'inherit' ? null : select.value === 'on';
      postAction(buildAction('terminal', { targetId: terminal.id, enabled }, snapshot.revision));
    });
    scopeLabel.appendChild(select);
    actions.appendChild(scopeLabel);

    const reset = el('button', 'btn', '횟수 초기화');
    reset.type = 'button';
    reset.disabled = !connected || !terminal.supported;
    reset.addEventListener('click', () => {
      postAction(buildAction('reset-budget', { targetId: terminal.id }, snapshot.revision));
    });
    actions.appendChild(reset);
    row.appendChild(actions);

    const meta = el('div', 'terminal-meta');
    const expiry = el(
      'span',
      terminal.expired ? 'terminal-expiry is-expired' : 'terminal-expiry',
      `예상 캐시 만료: ${terminal.remainingText}`,
    );
    meta.appendChild(expiry);
    const due = el('span', 'terminal-due', `다음 keepalive: ${terminal.dueText}`);
    meta.appendChild(due);
    const budget = el(
      'span',
      'terminal-budget',
      `연속 keepalive: ${terminal.charged}회 / 상한 ${vm.maxConsecutiveText} · 확인 ${terminal.confirmed}회`,
    );
    meta.appendChild(budget);
    row.appendChild(meta);
    countdowns.push({
      expiryEl: expiry,
      dueEl: due,
      expiresAt: terminal.expiresAt,
      dueAt: terminal.dueAt,
    });

    if (terminal.needsReview) {
      const review = el('div', 'review');
      review.appendChild(el('span', 'review-warning', '⚠ 전송 결과 확인 필요: 터미널 입력창을 확인하세요.'));
      const clear = el('button', 'btn', '다음 작업부터 재개');
      clear.type = 'button';
      clear.disabled = !connected || !terminal.supported;
      clear.addEventListener('click', () => {
        postAction(buildAction('clear-review', { targetId: terminal.id }, snapshot.revision));
      });
      review.appendChild(clear);
      row.appendChild(review);
    }

    if (!terminal.supported) {
      row.appendChild(
        el('p', 'readonly-note', `지원하지 않는 대상이라 읽기 전용입니다.${terminal.reasonText ? ` ${terminal.reasonText}` : ''}`),
      );
    }

    return row;
  }

  /** @param {ReturnType<typeof toViewModel>} vm */
  function renderDiagnostics(vm) {
    if (!nodes.diagnostics) return;
    nodes.diagnostics.textContent = '';
    if (vm.diagnostics.length === 0) {
      nodes.diagnostics.appendChild(el('li', 'diag', '기록된 진단이 없습니다.'));
      return;
    }
    for (const entry of vm.diagnostics) {
      const li = el('li', 'diag');
      li.appendChild(el('span', 'diag-time', entry.timeText));
      li.appendChild(el('span', `diag-level diag-${entry.level}`, entry.level));
      li.appendChild(el('span', 'diag-event', entry.event));
      nodes.diagnostics.appendChild(li);
    }
  }

  /**
   * Populate the config form unless the user has edited it (dirty).
   * @param {object} config
   */
  function populateConfig(config) {
    if (dirty) return;
    const setValue = (node, value) => {
      if (node) node.value = value === null || value === undefined ? '' : String(value);
    };
    const setChecked = (node, value) => {
      if (node) node.checked = value === true;
    };
    setValue(nodes.cfg.message, config.message ?? '');
    setValue(nodes.cfg.margin5m, msToSeconds(config.margin5mMs));
    setValue(nodes.cfg.margin1h, msToSeconds(config.margin1hMs));
    setValue(nodes.cfg.quietOutput, config.quietOutputMs ?? '');
    setValue(nodes.cfg.maxConsecutive, config.maxConsecutiveKeepalives ?? '');
    setChecked(nodes.cfg.defaultWorktree, config.defaultWorktreeEnabled);
    setChecked(nodes.cfg.respectCwarm, config.respectCwarmDisabled);
    setValue(nodes.cfg.runtimePath, config.runtimeUserDataPath ?? '');
  }

  /**
   * @param {unknown} ms
   * @returns {string}
   */
  function msToSeconds(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) ? String(ms / 1000) : '';
  }

  /**
   * Read and validate the form into a Config patch.
   * @returns {object|Error}
   */
  function collectPatch() {
    const message = nodes.cfg.message ? nodes.cfg.message.value.trim() : '';
    if (message.length === 0) {
      return new Error('keepalive 메시지를 입력하세요.');
    }
    const seconds = (node, label) => {
      const raw = node && node.value !== '' ? Number(node.value) : NaN;
      if (!Number.isFinite(raw) || raw < 0) {
        return new Error(`${label} 값을 0 이상의 숫자로 입력하세요.`);
      }
      return Math.round(raw * 1000);
    };
    const margin5mMs = seconds(nodes.cfg.margin5m, '5분 TTL 여유');
    if (margin5mMs instanceof Error) return margin5mMs;
    const margin1hMs = seconds(nodes.cfg.margin1h, '1시간 TTL 여유');
    if (margin1hMs instanceof Error) return margin1hMs;

    const integer = (node, label) => {
      const raw = node && node.value !== '' ? Number(node.value) : NaN;
      if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
        return new Error(`${label} 값을 0 이상의 정수로 입력하세요.`);
      }
      return raw;
    };
    const quietOutputMs = integer(nodes.cfg.quietOutput, '출력 조용 기준');
    if (quietOutputMs instanceof Error) return quietOutputMs;
    const maxConsecutiveKeepalives = integer(nodes.cfg.maxConsecutive, '연속 keepalive 상한');
    if (maxConsecutiveKeepalives instanceof Error) return maxConsecutiveKeepalives;

    const runtimeRaw = nodes.cfg.runtimePath ? nodes.cfg.runtimePath.value.trim() : '';
    return {
      message,
      margin5mMs,
      margin1hMs,
      quietOutputMs,
      maxConsecutiveKeepalives,
      defaultWorktreeEnabled: nodes.cfg.defaultWorktree ? nodes.cfg.defaultWorktree.checked : false,
      respectCwarmDisabled: nodes.cfg.respectCwarm ? nodes.cfg.respectCwarm.checked : false,
      runtimeUserDataPath: runtimeRaw.length === 0 ? null : runtimeRaw,
    };
  }

  // --- event wiring ---

  if (nodes.pauseToggle) {
    nodes.pauseToggle.addEventListener('click', () => {
      if (!snapshot) return;
      const vm = toViewModel(snapshot, 0);
      postAction(buildAction('pause', { paused: !vm.paused }, snapshot.revision));
    });
  }

  if (nodes.form) {
    nodes.form.addEventListener('input', () => {
      dirty = true;
    });
    nodes.form.addEventListener('change', () => {
      dirty = true;
    });
    nodes.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!snapshot) return;
      const patch = collectPatch();
      if (patch instanceof Error) {
        showError(patch.message);
        return;
      }
      showError('');
      dirty = false;
      postAction(buildAction('config', { patch }, snapshot.revision));
    });
  }

  /**
   * Lightweight countdown refresh that never rebuilds the DOM (so focus and
   * form edits survive).
   */
  function renderCountdowns() {
    if (!snapshot) return;
    const elapsed = Date.now() - receivedAt;
    for (const item of countdowns) {
      const remaining =
        item.expiresAt === null ? null : item.expiresAt - (snapshot.serverNow + elapsed);
      item.expiryEl.textContent = `예상 캐시 만료: ${formatRemaining(remaining)}`;
      item.expiryEl.classList.toggle('is-expired', remaining !== null && remaining <= 0);
      const due = item.dueAt === null ? null : item.dueAt - (snapshot.serverNow + elapsed);
      item.dueEl.textContent = `다음 keepalive: ${
        due !== null && due <= 0 ? '임박' : formatRemaining(due)
      }`;
    }
  }

  // --- start ---

  if (!token) {
    if (nodes.tokenMissing) nodes.tokenMissing.classList.remove('hidden');
    disableEverything();
    return;
  }

  void refreshState();
  window.setInterval(() => {
    void refreshState();
  }, POLL_MS);
  window.setInterval(renderCountdowns, TICK_MS);
}

if (typeof document !== 'undefined') {
  boot();
}
