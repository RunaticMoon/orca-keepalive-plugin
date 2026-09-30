/**
 * Cache Keepalive 공통 데이터 계약.
 *
 * DESIGN.md §5.3, §6, §7.4, §8의 typedef와 enum/limit 상수를 한 곳에서 고정한다.
 * 런타임 부작용이 없다: import 시 서버/타이머/파일 접근을 하지 않고 상수만 정의한다.
 *
 * @module contracts
 */

/**
 * 사용자 설정(플러그인 자체). §5.2 JSON과 shape이 같다.
 * @typedef {Object} Config
 * @property {1} schemaVersion
 * @property {string|null} runtimeUserDataPath 같은 Orca 인스턴스를 찾기 위한 절대 경로 override. null이면 후보 경로를 쓴다.
 * @property {boolean} paused 전역 일시정지(플러그인 자체).
 * @property {boolean} defaultWorktreeEnabled worktree override가 없을 때의 기본값.
 * @property {string} message keepalive로 보낼 단일 행 메시지(trim된 값).
 * @property {number} margin5mMs 5분 TTL용 여유(정수 ms).
 * @property {number} margin1hMs 1시간 TTL용 여유(정수 ms).
 * @property {number} quietOutputMs 출력이 조용해야 하는 최소 시간(정수 ms).
 * @property {number} observedInputQuietMs 관측된 입력 변화 이후 대기 시간(정수 ms).
 * @property {number} maxConsecutiveKeepalives 연속 keepalive 상한(0=무제한).
 * @property {boolean} respectCwarmDisabled ~/.claude/cwarm.disabled 존재 시 전송 차단.
 * @property {'debug'|'info'|'warn'|'error'} logLevel
 * @property {boolean} tabTitleIndicator 실험 옵션. keepalive 적용 Claude 터미널 탭 이름 앞에 ⚡ 표시.
 */

/**
 * 같은 Orca runtime 인스턴스에 대한 바인딩. §4.1, §6.
 * @typedef {Object} Binding
 * @property {string} userDataPath userData 디렉터리 절대 경로.
 * @property {string} userDataKey realpath(userData)의 SHA-256(hex).
 * @property {string} runtimeId metadata의 runtimeId(재읽기 시 변경 감지).
 * @property {number} pid runtime 프로세스 pid(plugin worker ppid와 일치해야 함).
 * @property {number} startedAt runtime 시작 시각(ms).
 * @property {string} endpoint unix socket 경로 또는 named pipe 이름.
 * @property {'unix'|'named-pipe'} transportKind
 * @property {string} authToken RPC 인증 토큰. 메모리에만 보유하고 snapshot/로그에 내보내지 않는다.
 */

/**
 * 앱 timer 설정 읽기 결과. §4.4, §6.
 * known=false이면 enabled/ttlMs 등은 판단 불가다.
 * @typedef {Object} SettingsSnapshot
 * @property {boolean} known
 * @property {string} [profileId]
 * @property {boolean} [enabled]
 * @property {number} [ttlMs]
 * @property {number} [revision]
 * @property {'sqlite'|'json'} [source]
 * @property {string} [reason] known=false일 때의 reason 코드.
 * @property {number} readAt 읽은 시각(ms).
 */

/**
 * 전송/예약 대상. key는 [runtimeId, profileId, worktreeId, paneKey, ptyId] tuple이며 incarnationId가 있으면 함께 저장한다. §5.4.
 * @typedef {Object} Target
 * @property {string} targetId worker가 발급한 opaque random ID(대시보드 노출용).
 * @property {string} runtimeId
 * @property {string} profileId
 * @property {string} worktreeId
 * @property {string} paneKey `${tabId}:${leafId}`.
 * @property {string} ptyId
 * @property {string|null} incarnationId
 * @property {string} handle RPC handle.
 */

/**
 * 한 target에 대한 읽기 전용 관측 결과. §6.
 * inspection 사이 값이 충돌하면 unknown으로 본다.
 * @typedef {Object} Observation
 * @property {Target} target
 * @property {number} observedAt
 * @property {'working'|'permission'|'idle'|null} agentStatus
 * @property {null|Object} agentWait null=검사상 없음, object=대기, null 이외 미정은 unknown.
 * @property {boolean} connected
 * @property {boolean} writable
 * @property {string|null} identity agentIdentity(예: 'claude').
 * @property {string|null} executionHostId
 * @property {number|null} lastOutputAt null=unknown.
 * @property {'screen'|null} screenSource
 * @property {boolean} screenTruncated
 * @property {string|null} draft 메모리에서만 검사하며 공개 snapshot에 넣지 않는다.
 * @property {number} settingsGeneration
 */

/**
 * target의 예약 epoch. §6.
 * @typedef {Object} TargetEpoch
 * @property {number} id 내부 단조 정수.
 * @property {number} doneAt 첫 인정 done의 receivedAt.
 * @property {number} dueAt expiresAt - margin.
 * @property {number} expiresAt doneAt + ttlMs.
 * @property {boolean} attempted 이 epoch에서 mutation을 예약했는지.
 */

/**
 * 진행 중 attempt 참조. §6.
 * @typedef {Object} AttemptRef
 * @property {string} id
 * @property {string} phase
 * @property {number} startedAt
 */

/**
 * 순수 reducer의 target 상태. §6.
 * @typedef {Object} TargetState
 * @property {Target} target
 * @property {'UNKNOWN'|'BUSY'|'ARMED'|'CHECKING'|'PASTING'|'SUBMITTING'|'AWAITING_TURN'|'SUSPENDED'|'NEEDS_REVIEW'|'EXPIRED'} phase
 * @property {'working'|'blocked'|'waiting'|'done'|null} lastHook
 * @property {number|null} lastHookAt
 * @property {boolean} seenWorking
 * @property {TargetEpoch|null} epoch
 * @property {AttemptRef|null} attempt
 * @property {number|null} lastObservedInputAt
 * @property {string|null} reason reason/진단 코드.
 * @property {number} generation
 */

/**
 * reducer 입력 이벤트. §6, §5.4.
 * @typedef {Object} MachineInput
 * @property {'HOOK'|'POLICY_INVALIDATED'|'TARGET_CHANGED'|'CLOCK_GAP'|'ATTEMPT_RESERVED'|'PASTE_ACCEPTED'|'SUBMIT_ACCEPTED'|'SEND_REFUSED'|'SEND_UNCERTAIN'|'TURN_CONFIRMED'|'TICK'} type
 * @property {number} at 이벤트 시각(ms).
 * @property {Object} [payload] 이벤트별 부가 정보(예: HOOK이면 state/worktreeId/paneKey/receivedAt).
 */

/**
 * scheduler 결정. §6.
 * @typedef {Object} Decision
 * @property {'wait'|'inspect'|'send'|'expire'} kind
 * @property {string} reason reason enum.
 * @property {number} [nextAt] kind='wait'일 때 다음 확인 시각.
 * @property {boolean} [budgetReset] 자체 attempt로 설명되지 않는 fresh working 관측 시 true(coordinator가 저장).
 */

/**
 * guarded-send 결과. §6.
 * @typedef {Object} SendResult
 * @property {'submitted'|'refused'|'uncertain'} kind
 * @property {string} attemptId
 * @property {string} [reason] kind='refused'|'uncertain'일 때 이유 코드.
 * @property {number} at
 */

/**
 * 대시보드 terminal row. §7.4.
 * @typedef {Object} DashboardTerminal
 * @property {string} id opaque targetId.
 * @property {string} title plain text(innerHTML 금지).
 * @property {string} phase target phase.
 * @property {boolean|null} enabledOverride null=inherit.
 * @property {boolean} effectiveEnabled 실제 적용 상태.
 * @property {string} reason 적용/차단 이유 코드.
 * @property {number|null} dueAt
 * @property {number|null} expiresAt
 * @property {number} charged
 * @property {number} confirmed
 * @property {boolean} needsReview
 */

/**
 * 대시보드 worktree 그룹. §7.4.
 * @typedef {Object} DashboardWorktree
 * @property {string} id opaque worktreeId.
 * @property {string} worktreeHash 원시 worktreeId의 sha256 앞 16 hex(원시 id 미노출).
 * @property {string} label 표시용 label(프로젝트 이름).
 * @property {string|null} branch 표시용 짧은 branch 이름(없으면 null).
 * @property {boolean} enabled
 * @property {boolean} effectiveEnabled
 * @property {string} reason
 * @property {DashboardTerminal[]} terminals
 */

/**
 * 대시보드 진단 항목. §7.4, §8.
 * @typedef {Object} DashboardDiagnostic
 * @property {number} at
 * @property {string} level
 * @property {string} code 진단 event/reason enum.
 * @property {string} [targetId] hashed/opaque target ID.
 */

/**
 * 대시보드 스냅숏. §7.4.
 * 원시 authToken/binding/draft/screen/전체 settings/경로는 포함하지 않는다.
 * @typedef {Object} DashboardSnapshot
 * @property {number} revision
 * @property {number} serverNow
 * @property {{known:boolean, enabled?:boolean, ttlMs?:number, source?:string, readAt?:number, reason?:string}} appTimer
 * @property {{state:string, reason?:string}} connection
 * @property {Config} config
 * @property {DashboardWorktree[]} worktrees
 * @property {DashboardDiagnostic[]} diagnostics
 */

/**
 * 전역 pause 토글. §7.4. expectedRevision 필수.
 * @typedef {Object} PauseAction
 * @property {'pause'} type
 * @property {boolean} paused
 * @property {number} expectedRevision
 */

/**
 * worktree scope 토글. §7.4.
 * @typedef {Object} WorktreeAction
 * @property {'worktree'} type
 * @property {string} targetId
 * @property {boolean} enabled
 * @property {number} expectedRevision
 */

/**
 * 원시 Orca worktreeId로 직접 설정. §7.4.
 * @typedef {Object} WorktreeOrcaAction
 * @property {'worktree-orca'} type
 * @property {string} worktreeId 원시 Orca worktreeId(opaque targetId가 아님).
 * @property {boolean|null} enabled true/false=override, null=override 제거(기본값 상속).
 * @property {number} expectedRevision
 */

/**
 * terminal scope 토글. §7.4.
 * @typedef {Object} TerminalAction
 * @property {'terminal'} type
 * @property {string} targetId
 * @property {boolean} enabled
 * @property {number} expectedRevision
 */

/**
 * 설정 patch. §7.4.
 * @typedef {Object} ConfigAction
 * @property {'config'} type
 * @property {Partial<Config>} patch
 * @property {number} expectedRevision
 */

/**
 * budget 초기화. §7.4.
 * @typedef {Object} ResetBudgetAction
 * @property {'reset-budget'} type
 * @property {string} targetId
 * @property {number} expectedRevision
 */

/**
 * needsReview 해제(“다음 작업부터 재개”). §7.4.
 * @typedef {Object} ClearReviewAction
 * @property {'clear-review'} type
 * @property {string} targetId
 * @property {number} expectedRevision
 */

/**
 * 인증된 대시보드 POST /api/action의 허용 union. §7.4.
 * @typedef {PauseAction|WorktreeAction|WorktreeOrcaAction|TerminalAction|ConfigAction|ResetBudgetAction|ClearReviewAction} Action
 */

/**
 * 객체 그래프 전체를 재귀적으로 동결한다.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/**
 * 중요 reason 코드. §8. 모든 값은 자기 key와 같다.
 * @type {Readonly<Record<string, string>>}
 */
export const REASON_CODES = deepFreeze({
  APP_TIMER_OFF: 'APP_TIMER_OFF',
  SETTINGS_UNKNOWN: 'SETTINGS_UNKNOWN',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  WRONG_RUNTIME: 'WRONG_RUNTIME',
  NO_FRESH_TURN: 'NO_FRESH_TURN',
  UNSUPPORTED_AGENT: 'UNSUPPORTED_AGENT',
  UNSUPPORTED_HOST: 'UNSUPPORTED_HOST',
  NOT_CONNECTED: 'NOT_CONNECTED',
  BUSY: 'BUSY',
  INTERACTIVE_WAIT: 'INTERACTIVE_WAIT',
  UNKNOWN_WAIT: 'UNKNOWN_WAIT',
  OUTPUT_ACTIVE: 'OUTPUT_ACTIVE',
  DRAFT_PRESENT: 'DRAFT_PRESENT',
  SCREEN_UNKNOWN: 'SCREEN_UNKNOWN',
  INPUT_QUIET_WINDOW: 'INPUT_QUIET_WINDOW',
  SCOPE_DISABLED: 'SCOPE_DISABLED',
  GLOBAL_PAUSED: 'GLOBAL_PAUSED',
  CWARM_DISABLED: 'CWARM_DISABLED',
  LIMIT_REACHED: 'LIMIT_REACHED',
  EXPIRED: 'EXPIRED',
  STALE_TARGET: 'STALE_TARGET',
  STORAGE_FAILED: 'STORAGE_FAILED',
  PARTIAL_OR_UNKNOWN_SEND: 'PARTIAL_OR_UNKNOWN_SEND',
  CATALOG_INCOMPLETE: 'CATALOG_INCOMPLETE',
});

/**
 * 진단 event allowlist. §8. 이 밖의 event는 기록하지 않는다.
 * @type {ReadonlyArray<string>}
 */
export const DIAGNOSTIC_EVENTS = deepFreeze([
  'bootstrap_started',
  'runtime_connected',
  'runtime_unavailable',
  'settings_unknown',
  'settings_changed',
  'target_unsupported',
  'epoch_armed',
  'epoch_expired',
  'safety_skipped',
  'attempt_reserved',
  'paste_accepted',
  'submit_accepted',
  'turn_observed',
  'send_uncertain',
  'policy_changed',
  'shutdown',
  'title_indicator',
  'notify_failed',
]);

/**
 * TargetState phase 허용값. §5.4.
 * @type {ReadonlyArray<string>}
 */
export const TARGET_PHASES = deepFreeze([
  'UNKNOWN',
  'BUSY',
  'ARMED',
  'CHECKING',
  'PASTING',
  'SUBMITTING',
  'AWAITING_TURN',
  'SUSPENDED',
  'NEEDS_REVIEW',
  'EXPIRED',
]);

/**
 * reducer 입력 종류. §6.
 * @type {ReadonlyArray<string>}
 */
export const MACHINE_INPUT_TYPES = deepFreeze([
  'HOOK',
  'POLICY_INVALIDATED',
  'TARGET_CHANGED',
  'CLOCK_GAP',
  'ATTEMPT_RESERVED',
  'PASTE_ACCEPTED',
  'SUBMIT_ACCEPTED',
  'SEND_REFUSED',
  'SEND_UNCERTAIN',
  'TURN_CONFIRMED',
  'TICK',
]);

/**
 * scheduler Decision kind. §6.
 * @type {ReadonlyArray<string>}
 */
export const DECISION_KINDS = deepFreeze(['wait', 'inspect', 'send', 'expire']);

/**
 * hook이 적용 가능한 agent 상태. §5.4.
 * @type {ReadonlyArray<string>}
 */
export const HOOK_STATES = deepFreeze(['working', 'blocked', 'waiting', 'done']);

/**
 * 대시보드 Action type. §7.4.
 * @type {ReadonlyArray<string>}
 */
export const ACTION_TYPES = deepFreeze([
  'pause',
  'worktree',
  'worktree-orca',
  'terminal',
  'config',
  'reset-budget',
  'clear-review',
]);

/**
 * 내부 타이밍 상수. §5.2.
 * @type {Readonly<Record<string, number>>}
 */
export const TIMING = deepFreeze({
  pollMs: 2000,
  hostHeartbeatMs: 60000,
  preflightMaxMs: 5000,
  minimumRemainingMs: 10000,
  pasteConfirmDeadlineMs: 5000,
  turnStartConfirmMs: 15000,
  sendConcurrency: 1,
  inspectConcurrency: 3,
  minSendSpacingMs: 2000,
  clockGapMs: 10000,
  clockSkewMs: 5000,
});

/**
 * 허용 TTL(ms). §4.4, §5.2.
 * @type {ReadonlyArray<number>}
 */
export const ALLOWED_TTLS = deepFreeze([300000, 3600000]);

/**
 * 영속 상태 행/용량 상한. §5.3.
 * @type {Readonly<Record<string, number>>}
 */
export const STATE_LIMITS = deepFreeze({
  profiles: 32,
  worktrees: 1000,
  terminals: 2000,
  budgets: 2000,
  maxSerializedBytes: 240 * 1024,
});

/**
 * 공개 DashboardSnapshot에 절대 포함되면 안 되는 키. §7.4. 문서화 목적.
 * @type {ReadonlyArray<string>}
 */
export const PUBLIC_SNAPSHOT_FORBIDDEN_KEYS = deepFreeze([
  'authToken',
  'draft',
  'screen',
  'tail',
  'settings',
  'worktreePath',
  'userDataPath',
  'endpoint',
]);
