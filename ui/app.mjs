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
    '과거 Orca 타이머 설정으로 전송이 차단되었습니다.',
  SETTINGS_UNKNOWN:
    'Orca 활성 프로필을 확인할 수 없습니다. Orca 실행 상태를 확인하세요.',
  RUNTIME_UNAVAILABLE:
    'Orca 런타임에 연결할 수 없습니다. Orca가 실행 중인지 확인하세요.',
  WRONG_RUNTIME:
    '다른 Orca 런타임에 연결되어 있습니다. 이 창에서 대시보드를 다시 여세요.',
  NO_FRESH_TURN:
    '현재 유효한 예약이 없습니다. 새 작업의 시작과 완료가 관측되면 예약합니다.',
  NO_AGENT:
    '에이전트가 실행되지 않은 일반 터미널입니다.',
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
    '입력창 초안이 감지되어 전송하지 않았습니다. 입력창을 확인하세요.',
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
  CATALOG_INCOMPLETE:
    'Orca 터미널 목록이 불완전해 자동 전송을 멈췄습니다. 목록이 복구되면 다시 동작합니다.',
});

/** Last recorded send block, rather than a claim about why expiry occurred. */
export const EXPIRE_CAUSE_TEXT = Object.freeze({
  DRAFT_PRESENT: '입력창 초안이 감지되어 전송하지 못함',
  INPUT_QUIET_WINDOW: '최근 입력 후 대기 시간 때문에 전송하지 못함',
  OUTPUT_ACTIVE: '최근 출력이 계속되어 전송하지 못함',
  INTERACTIVE_WAIT: '권한·입력 응답 대기로 전송하지 못함',
  BUSY: '에이전트 작업 중으로 판단되어 전송하지 못함',
  UNKNOWN_WAIT: '대기 상태를 확인하지 못해 전송하지 못함',
  SCREEN_UNKNOWN: '화면을 확인하지 못해 전송하지 못함',
  GLOBAL_PAUSED: '전체 일시정지로 전송하지 못함',
  SCOPE_DISABLED: '대상 설정이 꺼져 전송하지 못함',
  APP_TIMER_OFF: '과거 Orca 타이머 설정으로 전송하지 못함',
  SETTINGS_UNKNOWN: 'Orca 활성 프로필을 확인하지 못해 전송하지 못함',
  CWARM_DISABLED: 'cwarm 중지 설정으로 전송하지 못함',
  LIMIT_REACHED: '연속 전송 상한에 도달해 전송하지 못함',
  STORAGE_FAILED: '상태 저장 실패로 전송하지 못함',
  CATALOG_INCOMPLETE: '대상 목록을 확인하지 못해 전송하지 못함',
  RUNTIME_UNAVAILABLE: 'Orca 런타임에 연결하지 못해 전송하지 못함',
  WRONG_RUNTIME: '다른 Orca 런타임에 연결되어 전송하지 못함',
  NO_AGENT: '에이전트가 없어 전송하지 못함',
  UNSUPPORTED_AGENT: '지원하지 않는 에이전트라 전송하지 못함',
  UNSUPPORTED_HOST: '지원하지 않는 실행 환경이라 전송하지 못함',
  NOT_CONNECTED: '터미널 연결이 끊겨 전송하지 못함',
  STALE_TARGET: '대상 터미널이 변경되어 전송하지 못함',
});

const CACHE_STATUSES = new Set(['working', 'scheduled', 'sending', 'awaiting-turn', 'expired', 'no-reservation', 'interactive-wait', 'suspended', 'review']);

/** Local wall time relative to the snapshot clock; old dates include month/day. */
export function formatCacheTime(at, now) {
  if (at === null || !Number.isFinite(at)) return PLACEHOLDER;
  const date = new Date(at);
  const today = new Date(now);
  if (!Number.isFinite(date.getTime())) return PLACEHOLDER;
  const pad = (n) => String(n).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${clock}`;
}

function fullCacheTime(at) {
  if (at === null || !Number.isFinite(at)) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    second: '2-digit', timeZoneName: 'short',
  }).format(new Date(at));
}

/** User-facing status is selected from the cache contract, never from phase alone. */
export function cacheStatusDisplay(terminal, now) {
  if (terminal.supported === false) {
    return terminal.reason === 'NO_AGENT'
      ? { category: 'none', label: '대상 아님', text: '캐시 유지 대상 아님 · 일반 터미널' }
      : { category: 'none', label: '미지원', text: `캐시 유지 미지원 · ${Object.hasOwn(REASON_TEXT, terminal.reason) ? reasonText(terminal.reason) : '이 터미널에서는 캐시 유지를 지원하지 않습니다.'}` };
  }
  const status = terminal.needsReview === true || terminal.cacheState === 'review'
    ? 'review'
    : CACHE_STATUSES.has(terminal.cacheStatus) ? terminal.cacheStatus : 'no-reservation';
  const time = (at) => formatCacheTime(at, now);
  const expiry = terminal.expiresAt;
  const expired = terminal.expiredAt ?? expiry;
  const cause = EXPIRE_CAUSE_TEXT[terminal.expireCause] ?? '전송 차단 사유 기록 없음';
  if (status === 'working') return { category: 'kept', label: '유지 중', text: '캐시 유지 중 · 작업 진행 중' };
  if (status === 'scheduled') return { category: 'kept', label: '유지 중', text: `캐시 유지 중 · 만료 예정 ${time(expiry)}`, at: expiry };
  if (status === 'sending') return { category: 'kept', label: '유지 중', text: '캐시 유지 중 · 유지 메시지 전송 중' };
  if (status === 'awaiting-turn') return { category: 'kept', label: '유지 중', text: '캐시 유지 중 · 작업 시작 확인 중' };
  if (status === 'expired') return { category: 'expired', label: '만료', text: `캐시 만료됨 · ${time(expired)} · ${cause}`, at: expired, cause: true };
  if (status === 'interactive-wait') {
    if (terminal.cacheState === 'kept') {
      const expiryText = expiry === null ? '' : ` · 만료 예정 ${time(expiry)}`;
      return {
        category: 'kept',
        label: '유지 중',
        text: `캐시 유지 중 · 선택·권한 응답 대기(응답 전 자동 전송 안 함)${expiryText}`,
        at: expiry,
      };
    }
    return { category: 'stopped', label: '응답 대기', text: '선택·권한 응답 대기 · 캐시 상태 확인 안 됨(응답 전 자동 전송 안 함)' };
  }
  if (status === 'suspended') return { category: 'stopped', label: '유지 중단', text: `유지 중단 · ${Object.hasOwn(REASON_TEXT, terminal.reason) ? reasonText(terminal.reason) : '현재 예약이 중단되었습니다.'}` };
  if (status === 'review') return { category: 'review', label: '확인 필요', text: '확인 필요 · 전송 결과를 확인하세요' };
  if (terminal.reservationNote === 'safety-cutoff' && expiry !== null) {
    return { category: 'none', label: '예약 없음', text: `예약 없음 · 안전 전송 시간이 지남 · 만료 예정 ${time(expiry)}`, at: expiry };
  }
  return {
    category: 'none', label: '예약 없음',
    text: terminal.reservationNote === 'initial'
      ? '예약 없음 · 플러그인 시작 후 아직 작업의 시작과 완료를 관측하지 못함'
      : '예약 없음 · 다음 작업의 시작과 완료가 관측되면 예약합니다',
  };
}

/** Short labels for every diagnostic event in `src/contracts.mjs`. */
export const DIAGNOSTIC_EVENT_TEXT = Object.freeze({
  bootstrap_started: '플러그인 시작',
  runtime_connected: 'Orca 런타임에 연결됨',
  runtime_unavailable: 'Orca 런타임에 연결할 수 없음',
  settings_unknown: 'Orca 활성 프로필을 확인하지 못함',
  settings_changed: 'Orca 프로필 확인 상태가 변경됨',
  target_unsupported: '이 터미널에서는 keepalive를 지원하지 않음',
  epoch_armed: '캐시 만료 전 keepalive 예약',
  epoch_expired: '캐시 예약이 만료됨',
  safety_skipped: '안전 조건을 충족하지 않아 전송을 건너뜀',
  attempt_reserved: 'keepalive 전송 시도를 예약함',
  paste_accepted: '터미널이 keepalive 입력을 받음',
  submit_accepted: '터미널이 keepalive 전송을 받음',
  turn_observed: '전송 후 새 작업 시작을 확인함',
  send_uncertain: 'keepalive 전송 결과를 확인하지 못함',
  policy_changed: 'keepalive 동작 설정이 변경됨',
  shutdown: '플러그인이 종료됨',
  title_indicator: '터미널 제목 표시가 변경됨',
  notify_failed: '알림을 표시하지 못함',
  event_unresolved: '상태 이벤트를 터미널과 연결하지 못함',
  target_reset: '터미널 식별 정보가 바뀌어 상태 초기화',
  first_done_ignored: '작업 시작을 보지 못해 이번 완료는 예약하지 않음',
  epoch_restored: '리로드 전 예약을 복원',
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
 * @param {string} state
 * @returns {string}
 */
function connectionText(state) {
  return CONNECTION_TEXT[state] ?? state;
}

/**
 * 워크트리 토글 버튼 라벨. 명시 on/off와 상속(기본값)을 구분해 표시한다
 * (DESIGN §7.3: scope 설정과 실제 적용 상태를 따로 표시).
 * @param {{inherited: boolean, scopeOn: boolean}} worktree
 * @returns {string}
 */
export function worktreeToggleLabel(worktree) {
  const wt = worktree && typeof worktree === 'object' ? worktree : {};
  const on = wt.scopeOn === true;
  if (wt.inherited === true) {
    return on ? '● 켜짐 (기본)' : '○ 꺼짐 (기본)';
  }
  return on ? '● 켜짐' : '○ 꺼짐';
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
  // 상속(null) 워크트리의 실제 적용 기본값. 알 수 없으면 켜짐으로 단정하지 않는다.
  const defaultWorktreeEnabled = rawConfig.defaultWorktreeEnabled === true;

  const rawProfileSettings = snap.profileSettings && typeof snap.profileSettings === 'object' ? snap.profileSettings : {};
  const profileSettings = {
    known: rawProfileSettings.known === true,
    source: rawProfileSettings.source === 'index' ? 'index' : null,
    readAt: finiteOrNull(rawProfileSettings.readAt),
    reason: typeof rawProfileSettings.reason === 'string' ? rawProfileSettings.reason : null,
  };
  const cacheTtlMs = finiteOrNull(rawConfig.claudeCacheTtlMs);

  const rawConnection =
    snap.connection && typeof snap.connection === 'object' ? snap.connection : {};
  const connectionState =
    typeof rawConnection.state === 'string' ? rawConnection.state : 'unavailable';

  /**
   * @param {object} terminal
   */
  const mapTerminal = (terminal) => {
    const expiresAt = finiteOrNull(terminal.expiresAt);
    const expiredAt = finiteOrNull(terminal.expiredAt);
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
      cacheState: ['kept', 'none', 'review'].includes(terminal.cacheState) ? terminal.cacheState : 'none',
      cacheStatus: CACHE_STATUSES.has(terminal.cacheStatus) ? terminal.cacheStatus : 'no-reservation',
      reservationNote: terminal.cacheStatus === 'no-reservation' && ['initial', 'safety-cutoff'].includes(terminal.reservationNote)
        ? terminal.reservationNote : null,
      indicatorOn: terminal.indicatorOn === true,
      expiredAt,
      expireCause: typeof terminal.expireCause === 'string' && Object.hasOwn(EXPIRE_CAUSE_TEXT, terminal.expireCause) ? terminal.expireCause : null,
      blockedReason: typeof terminal.blockedReason === 'string' && Object.hasOwn(EXPIRE_CAUSE_TEXT, terminal.blockedReason) ? terminal.blockedReason : null,
      enabledOverride: override,
      scopeValue: override === null ? 'inherit' : override ? 'on' : 'off',
      effectiveEnabled: terminal.effectiveEnabled === true,
      reason: typeof terminal.reason === 'string' ? terminal.reason : null,
      reasonText:
        typeof terminal.reason === 'string' && terminal.reason !== 'NO_AGENT'
          ? reasonText(terminal.reason)
          : '',
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
        const enabled =
          wt.enabled === true ? true : wt.enabled === false ? false : null;
        const scopeOn = enabled === null ? defaultWorktreeEnabled : enabled;
        const mappedTerminals = Array.isArray(wt.terminals) ? wt.terminals.map(mapTerminal) : [];
        // 터미널에서 에이전트가 실행되지 않은 일반 터미널(NO_AGENT)은 목록에서 숨긴다.
        // 숨긴 개수는 유지해 빈 목록이 된 이유를 안내 문구로 구분한다.
        const terminals = mappedTerminals.filter(
          (terminal) => !(terminal.supported === false && terminal.reason === 'NO_AGENT'),
        );
        return {
          id: typeof wt.id === 'string' ? wt.id : '',
          label: typeof wt.label === 'string' ? wt.label : '',
          projectId: typeof wt.projectId === 'string' && wt.projectId ? wt.projectId : null,
          projectLabel: typeof wt.projectLabel === 'string' && wt.projectLabel
            ? wt.projectLabel
            : typeof wt.label === 'string' ? wt.label : '',
          branch: typeof wt.branch === 'string' ? wt.branch : '',
          enabled,
          inherited: enabled === null,
          scopeOn,
          effectiveEnabled: wt.effectiveEnabled === true,
          reason: typeof wt.reason === 'string' ? wt.reason : null,
          reasonText: typeof wt.reason === 'string' ? reasonText(wt.reason) : '',
          terminals,
          hiddenPlainTerminals: mappedTerminals.length - terminals.length,
        };
      })
    : [];

  const projectsByKey = new Map();
  for (const worktree of worktrees) {
    const key = worktree.projectId ?? `label:${worktree.projectLabel}`;
    if (!projectsByKey.has(key)) {
      projectsByKey.set(key, { key, label: worktree.projectLabel, worktrees: [] });
    }
    projectsByKey.get(key).worktrees.push(worktree);
  }
  const projects = Array.from(projectsByKey.values());

  const diagnostics = Array.isArray(snap.diagnostics)
    ? snap.diagnostics.slice(-20).map((entry) => {
        const diag = entry && typeof entry === 'object' ? entry : {};
        const at = finiteOrNull(diag.at);
        const event =
          typeof diag.event === 'string'
            ? diag.event
            : typeof diag.code === 'string'
              ? diag.code
              : '';
        return {
          at,
          timeText: at === null ? PLACEHOLDER : formatClock(at),
          level: typeof diag.level === 'string' ? diag.level : 'info',
          event,
          eventText: Object.prototype.hasOwnProperty.call(DIAGNOSTIC_EVENT_TEXT, event)
            ? DIAGNOSTIC_EVENT_TEXT[event]
            : event,
          targetText: typeof diag.targetLabel === 'string'
            ? diag.targetLabel
            : typeof diag.target === 'string' && diag.target
              ? `#${diag.target.slice(0, 6)}`
              : null,
          code: typeof diag.code === 'string' ? diag.code : null,
        };
      })
    : [];

  const maxConsecutive5m = finiteOrNull(rawConfig.maxConsecutiveKeepalives5m);
  const maxConsecutive1h = finiteOrNull(rawConfig.maxConsecutiveKeepalives1h);
  const configuredLimits = [maxConsecutive5m, maxConsecutive1h].filter((limit) => limit !== null);
  const finiteLimits = configuredLimits.filter((limit) => limit > 0);
  const fallbackLimit = finiteLimits.length > 0
    ? Math.min(...finiteLimits)
    : configuredLimits.length > 0 ? 0 : null;
  const maxConsecutive = finiteOrNull(rawConfig.maxConsecutiveKeepalivesActive)
    ?? (cacheTtlMs === 300000 ? maxConsecutive5m : cacheTtlMs === 3600000 ? maxConsecutive1h : null)
    ?? fallbackLimit;
  return {
    revision: finiteOrNull(snap.revision),
    serverNow,
    now,
    paused,
    pauseLabel: paused ? '재개' : '일시정지',
    maxConsecutiveKeepalivesActive: maxConsecutive,
    maxConsecutiveText:
      maxConsecutive === null ? PLACEHOLDER : maxConsecutive === 0 ? '무제한' : String(maxConsecutive),
    cacheTtl: { ttlMs: cacheTtlMs, text: TTL_TEXT[cacheTtlMs] ?? '알 수 없음' },
    profileSettings: {
      ...profileSettings,
      warning: profileSettings.known ? '' : 'Orca 프로필을 읽을 수 없어 전송이 중지됨',
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
    projects,
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
        // null means "revert to inherited".
        enabled:
          input.enabled === null ? null : input.enabled === true,
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
    cacheTtl: byId('cache-ttl'),
    profileWarning: byId('profile-warning'),
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
      cacheTtl: byId('cfg-cache-ttl'),
      margin5m: byId('cfg-margin5m'),
      margin1h: byId('cfg-margin1h'),
      quietOutput: byId('cfg-quiet-output'),
      maxConsecutive5m: byId('cfg-max-consecutive-5m'),
      maxConsecutive1h: byId('cfg-max-consecutive-1h'),
      defaultWorktree: byId('cfg-default-worktree'),
      respectCwarm: byId('cfg-respect-cwarm'),
      tabTitleIndicator: byId('cfg-tab-title-indicator'),
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
    if (nodes.cacheTtl) {
      nodes.cacheTtl.textContent = vm.cacheTtl.text;
    }
    if (nodes.profileWarning) {
      if (nodes.profileWarning.textContent !== vm.profileSettings.warning) {
        nodes.profileWarning.textContent = vm.profileSettings.warning;
      }
      nodes.profileWarning.classList.toggle('hidden', !vm.profileSettings.warning);
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

    for (const [projectIndex, project] of vm.projects.entries()) {
      const projectSection = el('section', 'project');
      const projectCell = el('div', 'project-cell');
      const projectName = el('h3', 'project-name', project.label || '이름 없는 프로젝트');
      projectName.id = `dashboard-project-${projectIndex}`;
      projectName.title = project.label || '이름 없는 프로젝트';
      projectSection.setAttribute('aria-labelledby', projectName.id);
      projectCell.appendChild(projectName);
      projectCell.appendChild(el('span', 'project-count', `워크트리 ${project.worktrees.length}`));
      projectSection.appendChild(projectCell);

      const worktreeList = el('div', 'project-worktrees');
      for (const worktree of project.worktrees) {
        const section = el('section', 'worktree');
        const head = el('div', 'worktree-cell');
        const identity = el('div', 'worktree-identity');
        const primary = worktree.branch || worktree.label || '워크트리';
        const titleEl = el('h4', 'worktree-name', primary);
        titleEl.title = primary;
        identity.appendChild(titleEl);
        if (worktree.label && worktree.label !== worktree.projectLabel && worktree.label !== primary) {
          const folder = el('span', 'worktree-folder', worktree.label);
          folder.title = worktree.label;
          identity.appendChild(folder);
        }
        head.appendChild(identity);
        const toggle = el(
          'button',
          'btn compact-button',
          worktreeToggleLabel(worktree),
        );
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(worktree.scopeOn));
        toggle.setAttribute('aria-label', `워크트리 keepalive 토글: ${worktree.label || worktree.id}`);
        toggle.disabled = !connected;
        toggle.addEventListener('click', () => {
          postAction(
            buildAction('worktree', { targetId: worktree.id, enabled: !worktree.scopeOn }, snapshot.revision),
          );
        });
        head.appendChild(toggle);
        if (!worktree.inherited) {
          const inherit = el('button', 'btn compact-button', '기본값으로');
          inherit.type = 'button';
          inherit.setAttribute('aria-label', `워크트리 keepalive를 기본값으로: ${worktree.label || worktree.id}`);
          inherit.disabled = !connected;
          inherit.addEventListener('click', () => {
            postAction(
              buildAction('worktree', { targetId: worktree.id, enabled: null }, snapshot.revision),
            );
          });
          head.appendChild(inherit);
        }
        const effective = el('span', 'worktree-effective',
          `유지 설정 ${worktree.effectiveEnabled ? '켜짐' : '꺼짐'}`);
        effective.title = `워크트리 유지 설정: ${worktree.effectiveEnabled ? '켜짐' : '꺼짐'}`;
        if (worktree.reasonText) {
          effective.title += ` — ${worktree.reasonText}`;
        }
        head.appendChild(effective);
        if (worktree.reasonText) {
          const reason = el('span', 'worktree-reason', worktree.reasonText);
          reason.title = worktree.reasonText;
          head.appendChild(reason);
        }
        section.appendChild(head);

        const list = el('div', 'terminals');
        if (worktree.terminals.length === 0) {
          list.appendChild(el(
            'div',
            'terminal terminal-empty',
            worktree.hiddenPlainTerminals > 0
              ? '에이전트가 실행 중인 터미널이 없습니다.'
              : '표시할 세션이 없습니다.',
          ));
        } else {
          for (const terminal of worktree.terminals) {
            list.appendChild(renderTerminal(terminal, vm));
          }
        }
        section.appendChild(list);
        worktreeList.appendChild(section);
      }
      projectSection.appendChild(worktreeList);
      nodes.worktrees.appendChild(projectSection);
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
    const title = el('span', 'terminal-title', terminal.title || '(제목 없음)');
    title.title = terminal.title || '(제목 없음)';
    head.appendChild(title);
    const display = cacheStatusDisplay(terminal, vm.now);
    const status = el('div', 'terminal-status');
    const primary = el('div', 'terminal-cache-status');
    primary.appendChild(el('span', `badge badge-cache badge-cache-${display.category}`, display.label));
    const stateText = el('span', 'terminal-cache-text', display.text);
    if (display.at !== undefined) stateText.title = fullCacheTime(display.at);
    primary.appendChild(stateText);
    status.appendChild(primary);
    if (display.cause) {
      status.appendChild(el('span', 'terminal-cause-note', '마지막으로 기록된 전송 차단 사유입니다.'));
    }
    const setting = el('div', 'terminal-setting');
    setting.appendChild(el('span', 'terminal-applied', `유지 설정 ${terminal.effectiveEnabled ? '켜짐' : '꺼짐'}`));
    if (!terminal.supported && terminal.reason !== 'NO_AGENT') {
      const readonly = el('span', 'readonly-note', '읽기 전용 · 미지원');
      readonly.title = `지원하지 않는 대상이라 읽기 전용입니다.${terminal.reasonText ? ` ${terminal.reasonText}` : ''}`;
      setting.appendChild(readonly);
    }
    if (terminal.reasonText && (terminal.cacheStatus === 'no-reservation' || !terminal.supported)) {
      const reason = el('span', 'terminal-reason', terminal.reasonText);
      reason.title = terminal.reasonText;
      setting.appendChild(reason);
    }
    status.appendChild(setting);
    row.appendChild(head);
    row.appendChild(status);

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

    const reset = el('button', 'btn compact-button', '횟수 초기화');
    reset.type = 'button';
    reset.setAttribute('aria-label', `횟수 초기화: ${terminal.title || terminal.id}`);
    reset.disabled = !connected || !terminal.supported;
    reset.addEventListener('click', () => {
      postAction(buildAction('reset-budget', { targetId: terminal.id }, snapshot.revision));
    });
    actions.appendChild(reset);

    const meta = el('div', 'terminal-meta');
    let dueEl = null;
    if (terminal.dueAt !== null) {
      dueEl = el('span', 'terminal-due', `다음 keepalive: ${terminal.dueText}`);
      meta.appendChild(dueEl);
    }
    const budget = el(
      'span',
      'terminal-budget',
      `연속 ${terminal.charged}/상한 ${vm.maxConsecutiveText} · 확인 ${terminal.confirmed}`,
    );
    meta.appendChild(budget);
    row.appendChild(meta);
    countdowns.push({ stateText, terminal, dueEl });

    if (terminal.needsReview) {
      const warning = el('span', 'review-warning', '⚠ 확인 필요');
      warning.title = '전송 결과 확인 필요: 터미널 입력창을 확인하세요.';
      setting.appendChild(warning);
      const clear = el('button', 'btn compact-button review-action', '다음 작업부터 재개');
      clear.type = 'button';
      clear.setAttribute('aria-label', `다음 작업부터 재개: ${terminal.title || terminal.id}`);
      clear.disabled = !connected || !terminal.supported;
      clear.addEventListener('click', () => {
        postAction(buildAction('clear-review', { targetId: terminal.id }, snapshot.revision));
      });
      actions.appendChild(clear);
    }

    row.appendChild(actions);

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
      const target = el('span', 'diag-target', entry.targetText ?? '대상 없음');
      if (entry.targetText !== null) target.title = entry.targetText;
      li.appendChild(target);
      const message = el('span', 'diag-message');
      message.appendChild(el('span', 'diag-event', entry.eventText));
      const detail = entry.code ? `${entry.event} · ${entry.code}` : entry.event;
      if (detail) message.appendChild(el('small', 'diag-detail', detail));
      li.appendChild(message);
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
    setValue(nodes.cfg.cacheTtl, config.claudeCacheTtlMs ?? 3600000);
    setValue(nodes.cfg.margin5m, msToSeconds(config.margin5mMs));
    setValue(nodes.cfg.margin1h, msToSeconds(config.margin1hMs));
    setValue(nodes.cfg.quietOutput, config.quietOutputMs ?? '');
    setValue(nodes.cfg.maxConsecutive5m, config.maxConsecutiveKeepalives5m ?? '');
    setValue(nodes.cfg.maxConsecutive1h, config.maxConsecutiveKeepalives1h ?? '');
    setChecked(nodes.cfg.defaultWorktree, config.defaultWorktreeEnabled);
    setChecked(nodes.cfg.respectCwarm, config.respectCwarmDisabled);
    setChecked(nodes.cfg.tabTitleIndicator, config.tabTitleIndicator);
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
    const ttlValue = nodes.cfg.cacheTtl?.value;
    if (ttlValue !== '300000' && ttlValue !== '3600000') {
      return new Error('Claude Code 캐시 TTL은 1시간 또는 5분을 선택하세요.');
    }
    const claudeCacheTtlMs = Number(ttlValue);
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

    const integer = (node, label, max = Infinity) => {
      const raw = node && node.value !== '' ? Number(node.value) : NaN;
      if (!Number.isFinite(raw) || raw < 0 || raw > max || !Number.isInteger(raw)) {
        return new Error(max === Infinity
          ? `${label} 값을 0 이상의 정수로 입력하세요.`
          : `${label} 값을 0~${max} 범위의 정수로 입력하세요.`);
      }
      return raw;
    };
    const quietOutputMs = integer(nodes.cfg.quietOutput, '출력 조용 기준');
    if (quietOutputMs instanceof Error) return quietOutputMs;
    const maxConsecutiveKeepalives5m = integer(nodes.cfg.maxConsecutive5m, '연속 keepalive 상한 (5분 TTL)', 1000);
    if (maxConsecutiveKeepalives5m instanceof Error) return maxConsecutiveKeepalives5m;
    const maxConsecutiveKeepalives1h = integer(nodes.cfg.maxConsecutive1h, '연속 keepalive 상한 (1시간 TTL)', 1000);
    if (maxConsecutiveKeepalives1h instanceof Error) return maxConsecutiveKeepalives1h;

    const runtimeRaw = nodes.cfg.runtimePath ? nodes.cfg.runtimePath.value.trim() : '';
    return {
      message,
      claudeCacheTtlMs,
      margin5mMs,
      margin1hMs,
      quietOutputMs,
      maxConsecutiveKeepalives5m,
      maxConsecutiveKeepalives1h,
      defaultWorktreeEnabled: nodes.cfg.defaultWorktree ? nodes.cfg.defaultWorktree.checked : false,
      respectCwarmDisabled: nodes.cfg.respectCwarm ? nodes.cfg.respectCwarm.checked : false,
      tabTitleIndicator: nodes.cfg.tabTitleIndicator ? nodes.cfg.tabTitleIndicator.checked : false,
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
    const now = snapshot.serverNow + elapsed;
    for (const item of countdowns) {
      const display = cacheStatusDisplay(item.terminal, now);
      item.stateText.textContent = display.text;
      item.stateText.title = display.at === undefined ? '' : fullCacheTime(display.at);
      if (item.dueEl) {
        const due = item.terminal.dueAt - now;
        item.dueEl.textContent = `다음 keepalive: ${due <= 0 ? '임박' : formatRemaining(due)}`;
      }
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
