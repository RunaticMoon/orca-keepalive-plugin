/**
 * Cache Keepalive 실행 조정기(coordinator). DESIGN.md §5.4–§6, §8과 작업 N 명세를
 * 구현한다. 이미 완료된 adapter(scheduler/observer/store/guarded-send/settings)를
 * 이벤트·tick lifecycle로 연결하는 glue만 담당한다. adapter를 재설계하지 않는다.
 *
 * 이 모듈은 import 시 I/O/타이머를 시작하지 않는다. 모든 부작용은 주입된
 * `hostCall`/`resolveBinding`/`createRpc`/`createObserver`/`readSettings`/
 * `sendKeepalive`/`clock`을 통해서만 일어난다. bootstrap 실패를 포함한 모든 async
 * 경로는 예외를 삼키고 diagnostics/connection 상태로만 반영한다(unhandled rejection
 * 금지).
 *
 * @module coordinator
 */

import { REASON_CODES, TIMING } from './contracts.mjs'
import { sameBinding } from './runtime-location.mjs'
import { marginFor } from './scheduler.mjs'
import { repoIdFromWorktreeId } from './terminal-observer.mjs'

/** targets Map key 구분자. worktreeId/paneKey를 tuple로 join한다. */
const KEY_SEP = '\u0000'
/** 이벤트 queue 상한. 초과 시 가장 오래된 것부터 버린다. */
const MAX_EVENT_QUEUE = 1000
/** heartbeat가 사용하는 host storage key. §5.2. */
const STATE_KEY = 'state-v1'
/** stop이 in-flight 전송을 기다리는 최대 시간. */
const STOP_TIMEOUT_MS = 10000
/** stop 시 탭 제목 복원(restoreAll)을 기다리는 최대 시간. */
const TITLE_RESTORE_TIMEOUT_MS = 5000
/** bootstrap 재연결 backoff(ms). §4.2. 마지막 값을 상한으로 반복한다. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000]
/** 전송 결과 불확실을 나타내는 reason. */
const UNKNOWN_SEND_REASON = 'PARTIAL_OR_UNKNOWN_SEND'
/** repo 이름 캐시를 강제로 갱신하는 주기(ms). 마지막 성공 후 이 시간이 지나면 다시 읽는다. */
const REPO_NAME_REFRESH_MS = 300000
/** repo 이름 조회 재시도 최소 간격(ms). 성공/실패와 무관하게 이 간격 안에는 다시 시도하지 않는다. */
const REPO_NAME_RETRY_MS = 30000
/** event_unresolved 폭주 방지: 같은 (targetId, code) 조합을 이 간격 안에는 1회만 기록한다. */
const UNRESOLVED_DEDUPE_MS = 60000
/** event_unresolved dedupe Map 상한. 넘으면 삽입이 오래된 항목부터 정리한다. */
const UNRESOLVED_DEDUPE_MAX = 256
/** epoch 메모리로 저장/복원하는 예약의 최대 수명(ms). 허용 최대 TTL인 1시간과 같다. */
const EPOCH_MEMORY_MAX_AGE_MS = 3600000

/**
 * @typedef {Object} RuntimeConnection
 * @property {'connected'|'unavailable'|'wrong_runtime'|'starting'} state
 * @property {string|null} reason
 *
 * @typedef {Object} RuntimeTerminalView
 * @property {string} worktreeId
 * @property {string} paneKey
 * @property {string|null} title
 * @property {string} phase
 * @property {string|null} reason
 * @property {number|null} dueAt
 * @property {number|null} expiresAt
 * @property {boolean} supported
 * @property {string|null} unsupportedReason
 *
 * @typedef {Object} RuntimeWorktreeView
 * @property {string} worktreeId
 * @property {string|null} repoId worktreeId의 첫 `::` 앞 저장소 식별자. 없으면 null.
 * @property {string|null} label
 * @property {string|null} branch 표시용 짧은 branch 이름.
 * @property {string|null} projectLabel 같은 저장소의 워크트리가 공유하는 프로젝트 표시 이름.
 * @property {RuntimeTerminalView[]} terminals
 *
 * @typedef {Object} RuntimeView
 * @property {string|null} userDataKey
 * @property {string|null} profileId
 * @property {RuntimeConnection} connection
 * @property {{known:boolean, enabled:boolean, ttlMs:number|null, source:string|null, readAt:number|null, reason:string|null}} appTimer
 * @property {RuntimeWorktreeView[]} worktrees
 *
 * @typedef {Object} Coordinator
 * @property {() => void} start
 * @property {() => Promise<void>} stop
 * @property {(payload: unknown) => void} onAgentEvent
 * @property {(payload: unknown) => void} onWorktreeRemoved
 * @property {() => RuntimeView} getRuntimeView
 * @property {() => Promise<string|null>} currentWorktreeId
 * @property {(payload: unknown) => void} onReviewCleared
 * @property {() => void} onPolicyChanged
 * @property {() => any} getRpc
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * AbortSignal을 존중하는 sleep. coordinator의 기본 clock에서만 쓰인다.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
      return
    }
    let settled = false
    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, ms)
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort)
    }
  })
}

/**
 * @param {string} worktreeId
 * @param {string} paneKey
 * @returns {string}
 */
function keyFor(worktreeId, paneKey) {
  return `${worktreeId}${KEY_SEP}${paneKey}`
}

/**
 * store 정책 scope. target에는 userDataKey/profileId도 들어 있다.
 * @param {Record<string, any>} target
 * @returns {{userDataKey:string, profileId:string, worktreeId:string, paneKey:string}}
 */
function scopeOf(target) {
  return {
    userDataKey: target.userDataKey,
    profileId: target.profileId,
    worktreeId: target.worktreeId,
    paneKey: target.paneKey,
  }
}

/**
 * 실행 조정기를 만든다.
 *
 * @param {Object} options
 * @param {(method:string, params?:object) => Promise<any>} options.hostCall
 * @param {object} options.store createStateStore 결과.
 * @param {(override: string|null) => Promise<object>} options.resolveBinding 실패 시 LocationError{code}.
 * @param {(options:{getBinding:()=>Promise<object>}) => {call:Function, close:Function}} options.createRpc
 * @param {(options:{rpc:object, hostCall:Function}) => object} options.createObserver
 * @param {(options:{userDataPath:string}) => Promise<object>} options.readSettings
 * @param {(options:object) => Promise<object>} options.sendKeepalive
 * @param {{initialTargetState:Function, reduceTarget:Function, decide:Function}} options.scheduler
 * @param {{record:Function}} options.diagnostics
 * @param {(options:{rpc:object, hostCall:Function, clock:object, diagnostics:object}) => object} [options.createTitleIndicator] 탭 제목 ⚡ 표시기 팩토리(선택). rpc 준비 후 1회 생성한다.
 * @param {{load:Function, get:Function, remember:Function, forget:Function, prune:Function, flush:Function}} [options.epochMemory] keepalive 예약(epoch) 영속 메모리(선택). null이면 저장/복원을 생략한다.
 * @param {() => Promise<boolean>} [options.cwarmDisabled]
 * @param {string} options.clientId
 * @param {Object} [options.clock]
 * @param {number} [options.tickMs]
 * @param {number} [options.heartbeatMs]
 * @returns {Coordinator}
 */
export function createCoordinator({
  hostCall,
  store,
  resolveBinding,
  createRpc,
  createObserver,
  readSettings,
  sendKeepalive,
  scheduler,
  diagnostics,
  createTitleIndicator = null,
  epochMemory = null,
  cwarmDisabled = async () => false,
  clientId,
  clock = { now: Date.now, monoNow: () => performance.now(), setTimeout, clearTimeout, sleep },
  tickMs = 2000,
  heartbeatMs = 60000,
}) {
  if (typeof hostCall !== 'function') {
    throw new TypeError('createCoordinator requires hostCall')
  }
  if (!store || typeof store.snapshot !== 'function') {
    throw new TypeError('createCoordinator requires store')
  }
  if (!scheduler || typeof scheduler.decide !== 'function') {
    throw new TypeError('createCoordinator requires scheduler')
  }
  if (!diagnostics || typeof diagnostics.record !== 'function') {
    throw new TypeError('createCoordinator requires diagnostics')
  }

  // -------------------------------------------------------------------------
  // 상태
  // -------------------------------------------------------------------------

  /** @type {object|null} */
  let binding = null
  /** @type {object|null} */
  let rpc = null
  /** @type {object|null} */
  let observer = null
  /** @type {object|null} 탭 제목 표시기(실험 옵션). rpc 준비 후 1회 생성한다. */
  let titleIndicator = null
  let titleIndicatorCreated = false
  /** updateTitleIndicator 호출 순번. 늦게 끝난 이전 호출의 reconcile을 버린다. */
  let titleIndicatorSeq = 0
  /** 마지막 catalog 조회 실패 여부. policy 변경 시에도 보수적 reconciliation을 유지한다. */
  let titleIndicatorCatalogFailed = true
  /** @type {object|null} */
  let latestCatalog = null
  /** 마지막 catalog가 complete가 아니면 true. true인 동안 새 전송을 시작하지 않는다. */
  let catalogIncomplete = false
  /** @type {object|null} */
  let lastSettings = null
  /** @type {string|null} */
  let currentProfileId = null
  let settingsInitialized = false
  let lastSettingsKnown = false
  let lastSettingsEnabled = false
  /** @type {RuntimeConnection} */
  let connection = { state: 'starting', reason: null }

  /**
   * key → { state: SchedulerState, decision: object|null, meta: {title,label,supported,unsupportedReason} }
   * @type {Map<string, {state:any, decision:any, meta:any}>}
   */
  const targets = new Map()
  /** key → 다음 시도 허용 시각(skipped 후 최소 tickMs 대기). @type {Map<string, number>} */
  const skipUntil = new Map()
  /** 실제(사람/기타) 턴의 working을 관측한 target key. 그 done에서 탭 제목을 새로 고친다. @type {Set<string>} */
  const pendingRealTurn = new Set()
  /** `${targetId ?? ''}\u0000${code}` → 마지막 event_unresolved 기록 시각(clock.now). @type {Map<string, number>} */
  const unresolvedRecordedAt = new Map()

  /** repoId → displayName 캐시. observer.listRepoNames 성공 결과만 반영한다. @type {Map<string, string>} */
  const repoNames = new Map()
  /** 성공한 조회 결과에 없던 repoId. 영구 미지 repoId의 반복 조회를 막는다. @type {Set<string>} */
  const repoNamesMissing = new Set()
  /** 마지막 listRepoNames 성공 시각(clock.now). 한 번도 성공하지 않았으면 null. @type {number|null} */
  let repoNamesLoadedAt = null
  /** 마지막 listRepoNames 시도 시각(성공/실패 무관). @type {number|null} */
  let repoNamesAttemptedAt = null
  /** 진행 중 listRepoNames 호출. 중복 호출 방지용. @type {Promise<void>|null} */
  let repoNamesInFlight = null
  /** stop 시 진행 중 repo 이름 조회를 중단하는 signal. */
  const repoNameAbort = new AbortController()

  /** @type {unknown[]} */
  const eventQueue = []
  let drainQueued = false

  let tickTimer = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let started = false
  let stopped = false
  /** @type {Promise<void>|null} */
  let stopPromise = null

  /** @type {Set<Promise<void>>} */
  const runningSends = new Set()
  let lastSendStartedAt = -Infinity
  let lastTickWall = null
  let lastTickMono = null

  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()

  // -------------------------------------------------------------------------
  // 직렬 실행 큐
  // -------------------------------------------------------------------------

  /**
   * tick과 event drain을 겹치지 않게 직렬화한다. 이전 task 실패가 다음을 막지 않는다.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serialize(task) {
    const run = chain.then(() => task())
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // -------------------------------------------------------------------------
  // target 상태 헬퍼
  // -------------------------------------------------------------------------

  /**
   * targets Map의 최신 state에 reduce를 적용한다(클로저에 잡힌 옛 state 금지).
   * 적용 뒤 RuntimeView용 decision을 갱신한다. config를 넘기면 그 값으로,
   * 생략하면 refreshDecision이 그 시점의 store config를 읽는다.
   * @param {string} key
   * @param {object} input
   * @param {object} [config]
   * @returns {any|null}
   */
  function applyReduce(key, input, config) {
    const entry = targets.get(key)
    if (!entry) {
      return null
    }
    entry.state = scheduler.reduceTarget(entry.state, input)
    syncEpochMemory(key, entry.state)
    refreshDecision(key, config)
    return entry.state
  }

  /**
   * epoch 메모리 연동(선택). 렐로드 대비 규칙:
   * - ARMED이고 epoch가 아직 attempted=false이며 target 식별자가 유효하면
   *   현재 예약을 remember한다. userDataKey/profileId/worktreeId/paneKey/ptyId는
   *   비어 있지 않은 문자열이어야 하고, incarnationId는 비어 있지 않은 문자열 또는
   *   null을 허용한다(epoch-memory 계약).
   * - 그 밖의 모든 phase는 forget한다(없는 key는 no-op).
   * epochMemory가 null이면 모두 생략하고, 어떤 예외도 밖으로 내보내지 않는다.
   * @param {string} key
   * @param {any} state
   * @returns {void}
   */
  function syncEpochMemory(key, state) {
    if (epochMemory === null) {
      return
    }
    try {
      if (state.phase === 'ARMED' && state.epoch !== null && state.epoch.attempted === false) {
        const target = state.target
        const record = {
          userDataKey: target.userDataKey,
          profileId: target.profileId,
          worktreeId: target.worktreeId,
          paneKey: target.paneKey,
          ptyId: target.ptyId,
          incarnationId: target.incarnationId,
          doneAt: state.epoch.doneAt,
        }
        const hasIdentifiers =
          typeof record.userDataKey === 'string' && record.userDataKey.length > 0 &&
          typeof record.profileId === 'string' && record.profileId.length > 0 &&
          typeof record.worktreeId === 'string' && record.worktreeId.length > 0 &&
          typeof record.paneKey === 'string' && record.paneKey.length > 0 &&
          typeof record.ptyId === 'string' && record.ptyId.length > 0 &&
          (record.incarnationId === null ||
            (typeof record.incarnationId === 'string' && record.incarnationId.length > 0))
        if (hasIdentifiers && typeof record.doneAt === 'number' && Number.isFinite(record.doneAt)) {
          epochMemory.remember(key, record)
          return
        }
      }
      epochMemory.forget(key)
    } catch {
      // 저장/삭제 실패는 coordinator 동작에 영향을 주지 않는다.
    }
  }

  /**
   * 새로 만든 target에 대해 저장된 예약을 복원한다(선택). target 식별자가 일치하고
   * 1시간 이내의 doneAt이며 scope에 검토 필요/열린 attempt가 없으면 RESTORE_EPOCH를
   * 적용하고, ARMED가 되면 진단을 남긴다. 조건이 맞지 않으면 저장된 항목을 정리한다.
   * @param {string} key
   * @param {Record<string, any>} target
   * @returns {void}
   */
  function restoreEpochMemory(key, target) {
    if (epochMemory === null) {
      return
    }
    let record
    try {
      record = epochMemory.get(key)
    } catch {
      record = null
    }
    if (record === null || record === undefined) {
      return
    }
    const matches =
      record.userDataKey === target.userDataKey &&
      record.profileId === target.profileId &&
      record.ptyId === target.ptyId &&
      record.incarnationId === target.incarnationId
    const fresh = clock.now() - record.doneAt < EPOCH_MEMORY_MAX_AGE_MS
    // 검토 필요/열린 attempt가 있으면 과거 예약을 되살리지 않는다(중복 전송 방지).
    if (!matches || !fresh || budgetBlocksRestore(target)) {
      try {
        epochMemory.forget(key)
      } catch {
        // 정리 실패는 무시한다.
      }
      return
    }
    const state = applyReduce(key, {
      type: 'RESTORE_EPOCH',
      doneAt: record.doneAt,
      now: clock.now(),
    })
    if (state !== null && state.phase === 'ARMED') {
      diagnostics.record({ event: 'epoch_restored', targetId: key })
    }
  }

  /**
   * scope의 store 예산이 검토 필요(needsReview)이거나 열린 attempt
   * (reserved/pasted/submitted)를 들고 있으면 true를 돌려준다. 이때는 저장된 예약을
   * 복원하지 않는다. getBudget 호출이 실패하면 보수적으로 true(복원 보류)를 돌려준다.
   * @param {Record<string, any>} target
   * @returns {boolean}
   */
  function budgetBlocksRestore(target) {
    try {
      if (typeof store.getBudget !== 'function') {
        return false
      }
      const budget = store.getBudget(scopeOf(target))
      if (!isObject(budget)) {
        return false
      }
      if (budget.needsReview === true) {
        return true
      }
      const last = budget.lastAttempt
      return (
        isObject(last) &&
        (last.phase === 'reserved' || last.phase === 'pasted' || last.phase === 'submitted')
      )
    } catch {
      return true
    }
  }

  /**
   * target이 사라질 때 저장된 예약을 지운다(선택). epochMemory가 없으면 no-op.
   * @param {string} key
   * @returns {void}
   */
  function forgetEpochMemory(key) {
    if (epochMemory === null) {
      return
    }
    try {
      epochMemory.forget(key)
    } catch {
      // 삭제 실패는 무시한다.
    }
  }

  /**
   * RuntimeView용 decision을 저장한다. decide 결과에 dueAt/expiresAt이 없고 epoch가
   * 남아 있으면 TTL로부터 계산해 채운다(설정 unknown 구간에서도 만료를 보여주기 위함).
   * @param {string} key
   * @param {object} [config]
   * @returns {any|null}
   */
  function refreshDecision(key, config) {
    const entry = targets.get(key)
    if (!entry) {
      return null
    }
    const state = entry.state
    const cfg = config ?? store.snapshot().config
    const settings = isObject(lastSettings) ? lastSettings : { known: false }
    const policy = safePolicy(state.target)
    const raw = scheduler.decide(state, {
      now: clock.now(),
      settings: {
        known: settings.known === true,
        enabled: settings.enabled === true,
        ttlMs: settings.ttlMs,
      },
      policy,
      config: cfg,
    })
    entry.decision = normalizeDecision(raw, state, settings, cfg)
    return entry.decision
  }

  /**
   * @param {any} raw
   * @param {any} state
   * @param {any} settings
   * @param {any} config
   * @returns {{kind:string, reason:string|null, dueAt:number|null, expiresAt:number|null}}
   */
  function normalizeDecision(raw, state, settings, config) {
    let dueAt = typeof raw?.dueAt === 'number' ? raw.dueAt : null
    let expiresAt = typeof raw?.expiresAt === 'number' ? raw.expiresAt : null
    if (
      (dueAt === null || expiresAt === null) &&
      state.epoch !== null &&
      settings.known === true &&
      typeof settings.ttlMs === 'number'
    ) {
      const margin = marginFor(settings.ttlMs, config)
      if (margin !== null) {
        expiresAt = state.epoch.doneAt + settings.ttlMs
        dueAt = expiresAt - margin
      }
    }
    return { kind: raw?.kind ?? 'wait', reason: raw?.reason ?? null, dueAt, expiresAt }
  }

  /**
   * store.isAllowedByPolicy를 안전하게 호출한다(scope/profileId 미확정 시 throw 금지).
   * @param {Record<string, any>} target
   * @returns {{allowed:boolean, reason:string|null}}
   */
  function safePolicy(target) {
    try {
      if (typeof target.profileId !== 'string' || target.profileId.length === 0) {
        return { allowed: false, reason: 'SETTINGS_UNKNOWN' }
      }
      return store.isAllowedByPolicy(scopeOf(target))
    } catch {
      return { allowed: false, reason: 'STORAGE_FAILED' }
    }
  }

  // -------------------------------------------------------------------------
  // 탭 제목 표시기(실험 옵션)
  // -------------------------------------------------------------------------

  /**
   * promise를 await하지 않고 rejection만 삼킨다(tick/이벤트를 막지 않게).
   * @param {unknown} promise
   */
  function fireAndForget(promise) {
    try {
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {})
      }
    } catch {
      // 무시한다.
    }
  }

  /**
   * 탭 제목 표시기에 넘길 rpc 어댑터. 재연결로 `rpc`가 바뀌어도 매 호출 시 최신
   * 인스턴스를 쓰므로 표시기를 다시 만들 필요가 없다.
   * @param {string} method
   * @param {unknown} params
   * @param {object} [options]
   * @returns {Promise<unknown>}
   */
  function titleRpcCall(method, params, options) {
    const current = rpc
    if (current === null || typeof current.call !== 'function') {
      return Promise.reject(new Error('rpc unavailable'))
    }
    return current.call(method, params, options)
  }

  /**
   * 탭 제목 표시기를 rpc 준비 후 1회 생성하고 기록을 복원(load)한다. 생성/load
   * 실패는 삼킨다.
   * @returns {Promise<void>}
   */
  async function ensureTitleIndicator() {
    if (titleIndicatorCreated || typeof createTitleIndicator !== 'function') {
      return
    }
    titleIndicatorCreated = true
    try {
      const created = createTitleIndicator({
        rpc: { call: titleRpcCall },
        hostCall,
        clock,
        diagnostics,
      })
      if (created === null || typeof created !== 'object') {
        return
      }
      titleIndicator = created
      if (typeof created.load === 'function') {
        try {
          await created.load()
        } catch {
          // load 실패는 무시한다(기록은 다음 reconcile이 복구한다).
        }
      }
    } catch {
      titleIndicator = null
    }
  }

  /**
   * 이번 tick의 desired를 만들어 표시기에 비동기로 반영한다(tick을 막지 않는다).
   * - 옵션이 꺼져 있으면 빈 목록으로 모든 기록을 제거한다.
   * - catalog가 불완전하거나 읽기에 실패하면 off 제거만 수행한다. 새 적용은 막고,
   *   목록에서 빠진 기록은 지우지 않는다. 단 옵션 off는 목록과 무관하게 모두 제거한다.
   * - 실제 전송 게이트(runSend의 assertAllowed)와 같은 cwarm 확인을 반영한다.
   *   확인이 비동기이므로 tick을 막지 않게 내부 async 함수로 감싼다.
   * @param {object} config
   * @param {boolean} catalogFailed
   */
  function updateTitleIndicator(config, catalogFailed) {
    if (titleIndicator === null || typeof titleIndicator.reconcile !== 'function') {
      return
    }
    // 이전 tick의 cwarm 확인이 늦게 끝나 이번 tick 결과를 덮지 않게 순번을 올린다.
    const seq = ++titleIndicatorSeq
    if (config.tabTitleIndicator !== true) {
      fireAndForget(titleIndicator.reconcile([]))
      return
    }
    const removeOnly = catalogIncomplete || catalogFailed
    fireAndForget(reconcileTitleIndicator(config, seq, removeOnly))
  }

  /**
   * 실제 전송 게이트와 같은 cwarm 조건을 반영해 desired를 만든다. cwarmDisabled()
   * 예외는 false로 취급한다(assertAllowed와 동일). respectCwarmDisabled=true이고
   * cwarm.disabled가 있으면 모든 target을 on=false로 보낸다. ⚡는 phase(ARMED)와
   * 무관하게 "이 탭이 keepalive 대상으로 켜져 있음"을 뜻한다.
   * @param {object} config
   * @param {number} seq updateTitleIndicator가 부여한 순번. 더 새 호출이 있으면 버린다.
   * @param {boolean} removeOnly 불완전 catalog면 off 제거만 수행한다.
   * @returns {Promise<void>}
   */
  async function reconcileTitleIndicator(config, seq, removeOnly = false) {
    let cwarmBlocked = false
    if (config.respectCwarmDisabled === true) {
      try {
        cwarmBlocked = (await cwarmDisabled()) === true
      } catch {
        cwarmBlocked = false
      }
    }
    if (seq !== titleIndicatorSeq) {
      return
    }
    if (titleIndicator === null || typeof titleIndicator.reconcile !== 'function') {
      return
    }
    const settingsKnown = isObject(lastSettings) && lastSettings.known === true
    const settingsEnabled = settingsKnown && lastSettings.enabled === true
    const connectionOk = connection.state === 'connected'
    const paused = config.paused === true
    /** @type {Array<{worktreeId:string, tabId:string, leafId:string|null, handle:string, on:boolean}>} */
    const desired = []
    for (const entry of targets.values()) {
      if (entry.meta.supported !== true) {
        continue
      }
      const target = entry.state.target
      const tabId = typeof entry.meta.tabId === 'string' ? entry.meta.tabId : null
      if (tabId === null) {
        continue
      }
      const leafId = typeof entry.meta.leafId === 'string' ? entry.meta.leafId : null
      const on =
        !cwarmBlocked &&
        !paused &&
        settingsKnown &&
        settingsEnabled &&
        connectionOk &&
        safePolicy(target).allowed === true
      desired.push({
        worktreeId: target.worktreeId,
        tabId,
        leafId,
        handle: target.handle,
        on,
      })
    }
    fireAndForget(titleIndicator.reconcile(desired, removeOnly ? { removeOnly: true } : undefined))
  }

  /**
   * stop 시 표시기의 기록을 복원한다. 최대 TITLE_RESTORE_TIMEOUT_MS까지만 기다린다.
   * @returns {Promise<void>}
   */
  async function restoreTitleIndicator() {
    if (titleIndicator === null || typeof titleIndicator.restoreAll !== 'function') {
      return
    }
    let restorePromise
    try {
      restorePromise = Promise.resolve(titleIndicator.restoreAll())
    } catch {
      return
    }
    /** @type {unknown} */
    let guard = null
    const timeout = new Promise((resolve) => {
      guard = clock.setTimeout(resolve, TITLE_RESTORE_TIMEOUT_MS)
      if (guard && typeof guard.unref === 'function') {
        guard.unref()
      }
    })
    try {
      await Promise.race([restorePromise, timeout])
    } catch {
      // 실패는 무시한다.
    } finally {
      if (guard !== null) {
        try {
          clock.clearTimeout(guard)
        } catch {
          // ignore
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // bootstrap / 연결
  // -------------------------------------------------------------------------

  function start() {
    if (started || stopped) {
      return
    }
    started = true
    void bootstrap()
  }

  async function bootstrap() {
    try {
      diagnostics.record({ event: 'bootstrap_started' })
      try {
        await store.load()
      } catch {
        // store가 자체적으로 memoryPaused/lastSaveError를 기록한다.
      }
      if (epochMemory !== null) {
        // 렐로드 전 저장한 예약을 복원하기 전에 읽어 들이고 오래된 항목을 정리한다.
        try {
          await epochMemory.load()
        } catch {
          // load 실패는 무시한다(복원 없이 진행).
        }
        try {
          epochMemory.prune(EPOCH_MEMORY_MAX_AGE_MS)
        } catch {
          // prune 실패는 무시한다.
        }
      }
      if (stopped) {
        return
      }
      connection = { state: 'starting', reason: null }
      await connectWithRetry(0)
    } catch (error) {
      // bootstrap 어떤 단계의 오류도 밖으로 새지 않게 한다.
      if (!stopped) {
        connection = { state: 'unavailable', reason: 'bootstrap_failed' }
        diagnostics.record({ event: 'runtime_unavailable', code: 'bootstrap_failed' })
      }
    }
  }

  /**
   * @param {number} attemptIndex
   * @returns {Promise<void>}
   */
  async function connectWithRetry(attemptIndex) {
    if (stopped) {
      return
    }
    let next
    try {
      next = await resolveBinding(store.snapshot().config.runtimeUserDataPath ?? null)
    } catch (error) {
      const code = isObject(error) && typeof error.code === 'string' ? error.code : 'metadata_unreadable'
      connection = { state: code === 'wrong_runtime' ? 'wrong_runtime' : 'unavailable', reason: code }
      diagnostics.record({ event: 'runtime_unavailable', code })
      const delay = RECONNECT_BACKOFF_MS[Math.min(attemptIndex, RECONNECT_BACKOFF_MS.length - 1)]
      reconnectTimer = clock.setTimeout(() => {
        void connectWithRetry(attemptIndex + 1)
      }, delay)
      return
    }
    if (stopped) {
      return
    }

    try {
      binding = next
      connection = { state: 'connected', reason: null }
      diagnostics.record({ event: 'runtime_connected' })
      rpc = createRpc({ getBinding })
      observer = createObserver({ rpc, hostCall })
      await ensureTitleIndicator()

      try {
        lastSettings = await readSettings({ userDataPath: binding.userDataPath })
      } catch {
        lastSettings = { known: false, readAt: clock.now(), reason: 'SETTINGS_UNKNOWN' }
      }
      if (
        isObject(lastSettings) &&
        lastSettings.known === true &&
        typeof lastSettings.profileId === 'string'
      ) {
        currentProfileId = lastSettings.profileId
      }

      startHeartbeat()
      void tickLoop()
    } catch {
      // rpc/observer/settings 초기화 실패: 재연결로 되돌린다.
      if (rpc !== null && typeof rpc.close === 'function') {
        try {
          rpc.close()
        } catch {
          // ignore
        }
      }
      rpc = null
      observer = null
      binding = null
      connection = { state: 'unavailable', reason: 'bootstrap_failed' }
      diagnostics.record({ event: 'runtime_unavailable', code: 'bootstrap_failed' })
      const delay = RECONNECT_BACKOFF_MS[Math.min(attemptIndex, RECONNECT_BACKOFF_MS.length - 1)]
      reconnectTimer = clock.setTimeout(() => {
        void connectWithRetry(attemptIndex + 1)
      }, delay)
    }
  }

  /**
   * rpc getBinding. 같은 Orca 인스턴스가 아니면 target을 초기화하고 오류를 던진다.
   * @returns {Promise<object>}
   */
  async function getBinding() {
    const next = await resolveBinding(store.snapshot().config.runtimeUserDataPath ?? null)
    if (binding === null || !sameBinding(next, binding)) {
      await handleBindingChanged(next)
      throw Object.assign(new Error('binding changed'), { code: 'binding_changed' })
    }
    return next
  }

  /**
   * binding 변경: 모든 target을 제거하고 새 binding을 채택한다. §동작 9.
   * @param {object} next
   * @returns {Promise<void>}
   */
  async function handleBindingChanged(next) {
    binding = next
    // 다른 런타임/프로필의 target일 수 있어 여기서는 epoch 메모리를 forget하지 않는다.
    // 다음 reconcile의 식별자 불일치 forget과 bootstrap의 prune이 정리한다.
    targets.clear()
    skipUntil.clear()
    pendingRealTurn.clear()
    currentProfileId = null
    settingsInitialized = false
    connection = { state: 'starting', reason: null }
    diagnostics.record({ event: 'settings_changed', code: 'binding_changed' })
    try {
      lastSettings = await readSettings({ userDataPath: next.userDataPath })
    } catch {
      lastSettings = { known: false, readAt: clock.now(), reason: 'SETTINGS_UNKNOWN' }
    }
    if (isObject(lastSettings) && lastSettings.known === true && typeof lastSettings.profileId === 'string') {
      currentProfileId = lastSettings.profileId
    }
    if (!stopped) {
      connection = { state: 'connected', reason: null }
    }
  }

  function startHeartbeat() {
    const beat = () => {
      if (stopped) {
        return
      }
      try {
        Promise.resolve(hostCall('storage.get', { key: STATE_KEY })).catch(() => {})
      } catch {
        // heartbeat 실패는 무시한다.
      }
      heartbeatTimer = clock.setTimeout(beat, heartbeatMs)
    }
    heartbeatTimer = clock.setTimeout(beat, heartbeatMs)
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------

  async function tickLoop() {
    if (stopped) {
      return
    }
    try {
      await serialize(() => runTick())
    } catch {
      // tick 오류가 unhandled rejection이 되거나 루프를 끊지 않게 한다.
    }
    if (stopped) {
      return
    }
    tickTimer = clock.setTimeout(() => {
      void tickLoop()
    }, tickMs)
  }

  async function runTick() {
    if (stopped || binding === null || observer === null) {
      return
    }

    // 이번 tick에서 쓸 config를 한 번만 읽는다. store.snapshot()은 전체 상태를
    // structuredClone+freeze 하므로 target마다 반복 호출하지 않는다.
    let tickConfig = store.snapshot().config

    // a. clock gap 검사.
    const now = clock.now()
    const mono = clock.monoNow()
    if (lastTickWall !== null && lastTickMono !== null) {
      const wallElapsed = now - lastTickWall
      const monoElapsed = mono - lastTickMono
      if (
        Math.abs(wallElapsed - monoElapsed) > TIMING.clockSkewMs ||
        monoElapsed > TIMING.clockGapMs + tickMs
      ) {
        for (const key of [...targets.keys()]) {
          applyReduce(key, { type: 'CLOCK_GAP' }, tickConfig)
        }
      }
    }
    lastTickWall = now
    lastTickMono = mono

    // b. 설정 재읽기.
    let settings
    try {
      settings = await readSettings({ userDataPath: binding.userDataPath })
    } catch {
      settings = { known: false, readAt: clock.now(), reason: 'SETTINGS_UNKNOWN' }
    }
    if (!isObject(settings)) {
      settings = { known: false, readAt: clock.now(), reason: 'SETTINGS_UNKNOWN' }
    }
    applySettings(settings)

    // c. catalog 재구성.
    let catalogReadFailed = false
    try {
      latestCatalog = await observer.list()
      reconcileCatalog(latestCatalog)
    } catch {
      // 읽기 실패: 기존 catalog/target을 유지한다. 제목 표시기는 off 제거만 한다.
      catalogReadFailed = true
    }
    titleIndicatorCatalogFailed = catalogReadFailed

    // c2. repo 이름 캐시 갱신(필요 시). catalog 읽기에 성공한 뒤에만 시도한다.
    // startSend와 같이 tick을 막지 않도록 백그라운드로 시작하고, 예외는 안에서 삼킨다.
    if (!catalogReadFailed) {
      scheduleRefreshRepoNames(clock.now())
    }

    // d. 대기 중 이벤트 drain.
    await drainEvents()

    // 위 await 동안 대시보드에서 바뀐 config를 반영하도록 target 루프 직전에 다시 읽는다.
    tickConfig = store.snapshot().config

    // e. supported target 결정.
    const candidates = []
    for (const key of [...targets.keys()]) {
      const entry = targets.get(key)
      if (!entry) {
        continue
      }
      if (entry.meta.supported !== true) {
        entry.decision = {
          kind: 'wait',
          reason: entry.meta.unsupportedReason ?? entry.state.reason,
          dueAt: null,
          expiresAt: null,
        }
        continue
      }
      const prevPhase = entry.state.phase
      const ticked = applyReduce(key, { type: 'TICK', now: clock.now() }, tickConfig)
      if (prevPhase !== 'NEEDS_REVIEW' && ticked !== null && ticked.phase === 'NEEDS_REVIEW') {
        // turn-start 확인 창이 지나 NEEDS_REVIEW로 전환됐다. store에도 기록해야
        // 대시보드 해제 버튼이 뜬다(§5.4/§7.3). 전환 시 1회만 호출된다.
        markReviewFromTick(ticked, key)
      }
      const decision = entry.decision
      if (decision && decision.kind === 'expire') {
        const state = targets.get(key)?.state
        if (state && state.epoch !== null) {
          applyReduce(key, { type: 'EXPIRE', epochId: state.epoch.id }, tickConfig)
        }
        diagnostics.record({ event: 'epoch_expired', code: 'EXPIRED', targetId: key })
      } else if (decision && decision.kind === 'send') {
        if (catalogIncomplete) {
          // 목록이 불완전하면 목록 전체를 정상으로 취급하지 않고 새 전송을
          // 시작하지 않는다(§4.3/§5.5). 이미 진행 중인 전송은 건드리지 않는다.
          // 대시보드에는 기존 reason 필드로 이유를 노출한다.
          entry.decision = {
            kind: 'wait',
            reason: REASON_CODES.CATALOG_INCOMPLETE,
            dueAt: decision.dueAt ?? null,
            expiresAt: decision.expiresAt ?? null,
          }
        } else {
          candidates.push({ key, dueAt: decision.dueAt ?? 0 })
        }
      }
    }

    // f. 동시 1개 전송.
    maybeSend(candidates)

    // g. 탭 제목 ⚡ 표시(실험 옵션). await하지 않아 tick을 막지 않는다.
    updateTitleIndicator(tickConfig, catalogReadFailed)
  }

  /**
   * TICK에서 NEEDS_REVIEW로 전환했을 때 store에 확인 필요를 기록한다. guarded-send의
   * uncertain 경로는 이미 journal.markReview를 호출하지만, 이 경로(turn-start 미관측)는
   * store를 갱신하지 않아 대시보드 "다음 작업부터 재개" 버튼이 뜨지 않고 해당 터미널이
   * 영구히 멈추는 결함을 막는다(§5.4/§7.3). markReview는 idempotent(이미 true면 no-op)라
   * 중복 호출해도 안전하다. 비동기 실패가 tick을 막지 않게 catch하고 진단만 남긴다.
   * @param {any} state 전환 직후 scheduler state.
   * @param {string} key target key(진단용).
   */
  function markReviewFromTick(state, key) {
    const attempt = state.attempt
    const attemptId =
      attempt && typeof attempt.id === 'string' && attempt.id.length > 0 ? attempt.id : null
    // attemptId로 budget을 찾지 못하는 경우를 대비해 없으면 scope로 호출한다.
    const arg = attemptId !== null ? attemptId : scopeOf(state.target)
    const onFailure = () => {
      diagnostics.record({ event: 'safety_skipped', code: 'review_mark_failed', targetId: key })
    }
    try {
      Promise.resolve(store.markReview(arg, UNKNOWN_SEND_REASON)).catch(onFailure)
    } catch {
      onFailure()
    }
    diagnostics.record({ event: 'send_uncertain', code: UNKNOWN_SEND_REASON, targetId: key })
  }

  /**
   * 설정 snapshot을 반영한다. profileId 전환 시 target 전체 초기화, known/enabled 변화
   * 시 diagnostics를 남긴다.
   * @param {any} settings
   */
  function applySettings(settings) {
    const known = settings.known === true
    const enabled = settings.enabled === true
    const profileId = known && typeof settings.profileId === 'string' ? settings.profileId : null
    // 전환 판정을 위해 갱신 전의 활성 여부를 잡아 둔다. "활성"=known AND enabled.
    const wasActive = lastSettingsKnown === true && lastSettingsEnabled === true
    const isActive = known && enabled
    let changed = false

    if (!settingsInitialized) {
      settingsInitialized = true
      lastSettingsKnown = known
      lastSettingsEnabled = enabled
    } else if (lastSettingsKnown !== known || lastSettingsEnabled !== enabled) {
      lastSettingsKnown = known
      lastSettingsEnabled = enabled
      changed = true
    }

    // 앱 타이머가 켜짐에서 off/unknown으로 바뀌는 순간 예약 epoch를 폐기한다.
    // §5.4 "any -- 설정 off/끊김 --> SUSPENDED". 진행 중 전송은 generation 불일치로
    // assertAllowed가 STALE_TARGET을 주므로 별도 abort는 하지 않는다.
    if (wasActive && !isActive) {
      const reason = known ? 'APP_TIMER_OFF' : 'SETTINGS_UNKNOWN'
      for (const key of [...targets.keys()]) {
        applyReduce(key, { type: 'POLICY_INVALIDATED', reason })
      }
    }

    if (profileId !== null && profileId !== currentProfileId) {
      // 프로필 전환뿐 아니라 설정 unknown 동안 profileId=null로 만들어진 target이
      // known 프로필로 승격되는 전환도 포함한다. 이때 비우지 않으면 target.profileId가
      // null로 남아 assertAllowed/safePolicy가 영구히 거절한다. clear 뒤 같은 tick의
      // reconcileCatalog가 올바른 profileId로 재생성한다.
      // epoch 메모리는 여기서 forget하지 않는다(다른 프로필일 수 있음). 재생성 시
      // profileId 불일치로 forget되고, 시작 시 prune도 정리한다.
      targets.clear()
      skipUntil.clear()
      pendingRealTurn.clear()
      currentProfileId = profileId
      changed = true
    }

    lastSettings = settings
    if (changed) {
      diagnostics.record({
        event: 'settings_changed',
        code: known ? (enabled ? 'enabled' : 'disabled') : 'unknown',
      })
    }
  }

  /**
   * catalog 완전성 변화를 반영한다. 불완전(truncated/누락)으로 바뀌는 순간 1회
   * 안전 진단을 남기고, 완전해지면 해제한다. §4.3 "truncated=true면 목록 전체
   * 정상이라고 취급하지 말고 자동 전송 중단·진단".
   * @param {any} catalog
   */
  function noteCatalogCompleteness(catalog) {
    const complete = isObject(catalog) && catalog.complete === true
    if (complete) {
      catalogIncomplete = false
      return
    }
    if (!catalogIncomplete) {
      catalogIncomplete = true
      diagnostics.record({ event: 'safety_skipped', code: REASON_CODES.CATALOG_INCOMPLETE })
    }
  }

  /**
   * catalog row를 targets Map에 반영한다. handle/ptyId/incarnationId가 바뀌면
   * TARGET_CHANGED, complete일 때만 catalog에 없는 target을 삭제한다.
   * @param {any} catalog
   */
  function reconcileCatalog(catalog) {
    noteCatalogCompleteness(catalog)
    if (!isObject(catalog) || !Array.isArray(catalog.terminals)) {
      return
    }
    const seen = new Set()
    for (const row of catalog.terminals) {
      if (!isObject(row)) {
        continue
      }
      if (typeof row.worktreeId !== 'string' || typeof row.paneKey !== 'string') {
        continue
      }
      const key = keyFor(row.worktreeId, row.paneKey)
      seen.add(key)
      const target = {
        userDataKey: binding.userDataKey,
        profileId: currentProfileId,
        worktreeId: row.worktreeId,
        paneKey: row.paneKey,
        handle: row.handle,
        ptyId: row.ptyId ?? null,
        incarnationId: row.incarnationId ?? null,
        runtimeId: binding.runtimeId,
      }
      const meta = {
        title: typeof row.title === 'string' ? row.title : null,
        label: row.projectName ?? row.branchName ?? null,
        branch: row.branchName ?? null,
        repoId:
          typeof row.repoId === 'string' && row.repoId.length > 0
            ? row.repoId
            : repoIdFromWorktreeId(row.worktreeId),
        supported: row.supported === true,
        unsupportedReason: typeof row.unsupportedReason === 'string' ? row.unsupportedReason : null,
        tabId: typeof row.tabId === 'string' ? row.tabId : null,
        leafId: typeof row.leafId === 'string' ? row.leafId : null,
      }
      const entry = targets.get(key)
      if (!entry) {
        targets.set(key, { state: scheduler.initialTargetState(target), decision: null, meta })
        // 새 target을 만들었을 때만 저장된 예약을 복원한다(전환/삭제 후 재생성 포함).
        restoreEpochMemory(key, target)
      } else {
        const prev = entry.state.target
        if (
          prev.handle !== target.handle ||
          prev.ptyId !== target.ptyId ||
          prev.incarnationId !== target.incarnationId
        ) {
          const code =
            prev.incarnationId !== target.incarnationId
              ? 'incarnation_changed'
              : prev.ptyId !== target.ptyId
                ? 'pty_changed'
                : 'handle_changed'
          diagnostics.record({ event: 'target_reset', code, targetId: key })
          applyReduce(key, { type: 'TARGET_CHANGED', target })
        }
        entry.meta = meta
      }
    }
    if (catalog.complete === true) {
      for (const key of [...targets.keys()]) {
        if (!seen.has(key)) {
          targets.delete(key)
          pendingRealTurn.delete(key)
          forgetEpochMemory(key)
        }
      }
    }
  }

  /**
   * 현재 target에 '새' repoId(캐시에도 missing에도 없는)가 있는지 확인한다. 영구
   * 미지 repoId는 repoNamesMissing에 기록되어 반복 조회를 유발하지 않는다.
   * @returns {boolean}
   */
  function hasUnknownRepoId() {
    for (const entry of targets.values()) {
      const repoId = entry.meta.repoId
      if (
        typeof repoId === 'string' &&
        repoId.length > 0 &&
        !repoNames.has(repoId) &&
        !repoNamesMissing.has(repoId)
      ) {
        return true
      }
    }
    return false
  }

  /**
   * 성공한 조회 결과를 반영한다. 캐시를 교체하고, 현재 target의 repoId 중 결과에
   * 없는 것을 repoNamesMissing으로 재계산한다(5분 주기 갱신 시 재평가).
   * @param {Map<string, string>} result
   * @param {number} now
   */
  function applyRepoNames(result, now) {
    repoNames.clear()
    for (const [repoId, name] of result) {
      if (
        typeof repoId === 'string' &&
        repoId.length > 0 &&
        typeof name === 'string' &&
        name.length > 0
      ) {
        repoNames.set(repoId, name)
      }
    }
    repoNamesMissing.clear()
    for (const entry of targets.values()) {
      const repoId = entry.meta.repoId
      if (typeof repoId === 'string' && repoId.length > 0 && !repoNames.has(repoId)) {
        repoNamesMissing.add(repoId)
      }
    }
    repoNamesLoadedAt = now
  }

  /**
   * repo 이름 조회를 실제로 수행한다. null/throw/non-Map은 모두 삼키고 기존 캐시를
   * 유지한다. 완료 시 attemptedAt을 갱신하고, 성공이면 캐시/loadedAt도 갱신한다.
   * stop 이후 늦게 끝난 결과는 무시한다(tick/전송에 영향 없음).
   * @returns {Promise<void>}
   */
  async function runRefreshRepoNames() {
    let result = null
    let failed = false
    try {
      result = await observer.listRepoNames({ signal: repoNameAbort.signal })
    } catch {
      failed = true
    }
    if (stopped) {
      return
    }
    const completedAt = clock.now()
    repoNamesAttemptedAt = completedAt
    if (failed || !(result instanceof Map)) {
      return
    }
    applyRepoNames(result, completedAt)
  }

  /**
   * repo 이름 캐시(repoId → displayName) 갱신을 필요할 때만 백그라운드로 시작한다.
   * 한 번도 성공하지 않았거나, 현재 target에 캐시/missing에 없는 새 repoId가 있거나,
   * 마지막 성공 후 REPO_NAME_REFRESH_MS가 지났을 때 시도한다. 단 마지막 시도
   * (성공/실패 무관) 후 REPO_NAME_RETRY_MS 이내에는 재시도하지 않는다. observer가
   * 메서드를 제공하지 않으면 건너뛰고, 진행 중 호출이 있으면 중복 시작하지 않는다.
   * tick을 막지 않는다.
   * @param {number} now
   */
  function scheduleRefreshRepoNames(now) {
    if (stopped || repoNamesInFlight !== null) {
      return
    }
    if (observer === null || typeof observer.listRepoNames !== 'function') {
      return
    }
    const needRefresh =
      repoNamesLoadedAt === null ||
      now - repoNamesLoadedAt >= REPO_NAME_REFRESH_MS ||
      hasUnknownRepoId()
    if (!needRefresh) {
      return
    }
    if (repoNamesAttemptedAt !== null && now - repoNamesAttemptedAt < REPO_NAME_RETRY_MS) {
      return
    }
    const task = runRefreshRepoNames()
    repoNamesInFlight = task
    const clear = () => {
      if (repoNamesInFlight === task) {
        repoNamesInFlight = null
      }
    }
    task.then(clear, clear)
  }

  /**
   * 가장 dueAt이 빠른 후보 1개를 비동기로 실행한다. tick을 막지 않는다.
   * @param {Array<{key:string, dueAt:number}>} candidates
   */
  function maybeSend(candidates) {
    if (candidates.length === 0 || runningSends.size > 0) {
      return
    }
    if (clock.now() - lastSendStartedAt < TIMING.minSendSpacingMs) {
      return
    }
    const now = clock.now()
    const eligible = candidates.filter((candidate) => (skipUntil.get(candidate.key) ?? 0) <= now)
    if (eligible.length === 0) {
      return
    }
    eligible.sort((a, b) => a.dueAt - b.dueAt)
    startSend(eligible[0].key)
  }

  /**
   * @param {string} key
   */
  function startSend(key) {
    const entry = targets.get(key)
    if (!entry || entry.state.epoch === null) {
      return
    }
    const state = entry.state
    const gen = state.generation
    const epochId = state.epoch.id
    const target = state.target
    const controller = new AbortController()
    lastSendStartedAt = clock.now()

    let task
    task = (async () => {
      try {
        await runSend(key, gen, epochId, target, controller)
      } catch {
        // runSend는 스스로 uncertain까지 처리한다.
      } finally {
        runningSends.delete(task)
      }
    })()
    runningSends.add(task)
  }

  /**
   * guarded-send 1회를 실행하고 결과를 상태머신/journal/diagnostics에 반영한다.
   * @param {string} key
   * @param {number} gen
   * @param {number} epochId
   * @param {Record<string, any>} target
   * @param {AbortController} controller
   * @returns {Promise<void>}
   */
  async function runSend(key, gen, epochId, target, controller) {
    const config = store.snapshot().config
    let reservedAttemptId = null

    const assertAllowed = async () => {
      let settings
      try {
        settings = await readSettings({ userDataPath: binding.userDataPath })
      } catch {
        settings = { known: false, readAt: clock.now(), reason: 'SETTINGS_UNKNOWN' }
      }
      if (!isObject(settings) || settings.known !== true) {
        return { allowed: false, reason: 'SETTINGS_UNKNOWN' }
      }
      if (settings.enabled !== true || settings.profileId !== target.profileId) {
        return { allowed: false, reason: 'APP_TIMER_OFF' }
      }
      const policy = safePolicy(target)
      if (policy.allowed !== true) {
        // 이번 전송의 attempt가 이미 예약된 뒤(gate2/gate3)라면 reserveAttempt가
        // charged를 +1 했으므로 상한(maxConsecutiveKeepalives)에 정확히 도달하면
        // LIMIT_REACHED가 온다. 예약 성공은 곧 저장 성공이므로, 예약 이후의
        // LIMIT_REACHED만 허용으로 취급한다(그 앞 검사인 paused/scope/needsReview는
        // isAllowedByPolicy가 LIMIT_REACHED보다 먼저 검사해 이미 통과했다는 뜻).
        // 단 memoryPaused(저장 실패) 검사는 LIMIT 뒤에 있으므로 snapshot으로 함께
        // 확인한다. state-store는 수정하지 않는다.
        const limitFromReservation =
          reservedAttemptId !== null &&
          policy.reason === 'LIMIT_REACHED' &&
          store.snapshot().memoryPaused !== true
        if (!limitFromReservation) {
          return { allowed: false, reason: policy.reason ?? 'SCOPE_DISABLED' }
        }
      }
      if (config.respectCwarmDisabled === true) {
        let disabled = false
        try {
          disabled = await cwarmDisabled()
        } catch {
          disabled = false
        }
        if (disabled === true) {
          return { allowed: false, reason: 'CWARM_DISABLED' }
        }
      }
      const current = targets.get(key)
      if (stopped || !current || current.state.generation !== gen) {
        return { allowed: false, reason: 'STALE_TARGET' }
      }
      return { allowed: true, reason: null }
    }

    let result
    try {
      result = await sendKeepalive({
        target,
        epochId,
        message: config.message,
        quietOutputMs: config.quietOutputMs,
        clientId,
        rpc,
        inspect: (t, o) => observer.inspect(t, o),
        assertAllowed,
        journal: store,
        clock: { now: clock.now, sleep: clock.sleep },
        signal: controller.signal,
        onPhase: (phase, info) => {
          try {
            if (phase === 'reserved') {
              reservedAttemptId = info?.attemptId ?? null
              applyReduce(key, {
                type: 'ATTEMPT_RESERVED',
                attemptId: info?.attemptId,
                epochId,
                at: info?.at ?? clock.now(),
                generation: gen,
              })
              diagnostics.record({ event: 'attempt_reserved', targetId: key })
            } else if (phase === 'pasted') {
              applyReduce(key, { type: 'PASTE_ACCEPTED', attemptId: info?.attemptId, generation: gen })
              diagnostics.record({ event: 'paste_accepted', targetId: key })
            } else if (phase === 'submitted') {
              applyReduce(key, {
                type: 'SUBMIT_ACCEPTED',
                attemptId: info?.attemptId,
                at: info?.at ?? clock.now(),
                generation: gen,
              })
            }
          } catch {
            // 상태 갱신 실패가 전송 프로토콜을 막지 않는다.
          }
        },
      })
    } catch {
      if (reservedAttemptId !== null) {
        applyReduce(key, { type: 'SEND_UNCERTAIN', attemptId: reservedAttemptId, reason: UNKNOWN_SEND_REASON })
        diagnostics.record({ event: 'send_uncertain', code: UNKNOWN_SEND_REASON, targetId: key })
      } else {
        skipUntil.set(key, clock.now() + tickMs)
      }
      return
    }

    const kind = isObject(result) ? result.kind : null
    if (kind === 'submitted') {
      diagnostics.record({ event: 'submit_accepted', targetId: key })
    } else if (kind === 'refused') {
      applyReduce(key, { type: 'SEND_REFUSED', attemptId: result.attemptId, reason: result.reason })
    } else if (kind === 'uncertain') {
      applyReduce(key, { type: 'SEND_UNCERTAIN', attemptId: result.attemptId, reason: result.reason })
      diagnostics.record({
        event: 'send_uncertain',
        code: result.reason ?? UNKNOWN_SEND_REASON,
        targetId: key,
      })
    } else {
      skipUntil.set(key, clock.now() + tickMs)
      diagnostics.record({
        event: 'safety_skipped',
        code: isObject(result) && typeof result.reason === 'string' ? result.reason : 'SETTINGS_UNKNOWN',
        targetId: key,
      })
    }
  }

  // -------------------------------------------------------------------------
  // 이벤트
  // -------------------------------------------------------------------------

  function onAgentEvent(payload) {
    if (stopped) {
      return
    }
    if (eventQueue.length >= MAX_EVENT_QUEUE) {
      eventQueue.shift()
      diagnostics.record({ event: 'safety_skipped', code: 'event_queue_overflow' })
    }
    eventQueue.push(payload)
    scheduleDrain()
  }

  function scheduleDrain() {
    if (stopped || drainQueued) {
      return
    }
    drainQueued = true
    serialize(async () => {
      drainQueued = false
      await drainEvents()
    }).catch(() => {})
  }

  async function drainEvents() {
    if (stopped || binding === null || observer === null) {
      return
    }
    while (eventQueue.length > 0 && !stopped) {
      const payload = eventQueue.shift()
      try {
        await handleAgentEvent(payload)
      } catch {
        // 한 이벤트 오류가 queue 전체를 막지 않는다.
      }
    }
  }

  /**
   * event_unresolved 진단을 폭주 방지와 함께 기록한다. 같은 (targetId, code)는
   * 60초 안에 1회만 남기고, Map이 256개를 넘으면 삽입이 오래된 항목부터 정리한다.
   * 진단 기록 실패는 이벤트 처리 흐름을 막지 않는다.
   * @param {string|null} code
   * @param {string|undefined} targetId
   */
  function recordUnresolved(code, targetId) {
    try {
      if (typeof code !== 'string' || code.length === 0) {
        return
      }
      const dedupeKey = `${targetId ?? ''}${KEY_SEP}${code}`
      const now = clock.now()
      const last = unresolvedRecordedAt.get(dedupeKey)
      if (typeof last === 'number' && now - last < UNRESOLVED_DEDUPE_MS) {
        return
      }
      // 최근 기록을 Map 뒤쪽으로 옮겨 삽입 순서를 최신순으로 유지한다.
      unresolvedRecordedAt.delete(dedupeKey)
      unresolvedRecordedAt.set(dedupeKey, now)
      while (unresolvedRecordedAt.size > UNRESOLVED_DEDUPE_MAX) {
        const oldest = unresolvedRecordedAt.keys().next().value
        if (oldest === undefined) {
          break
        }
        unresolvedRecordedAt.delete(oldest)
      }
      const entry = { event: 'event_unresolved', code }
      if (typeof targetId === 'string') {
        entry.targetId = targetId
      }
      diagnostics.record(entry)
    } catch {
      // 진단 기록 실패는 무시한다.
    }
  }

  /**
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async function handleAgentEvent(payload) {
    const resolved = await resolveKeyForEvent(payload)
    const key = resolved.key
    if (key === null) {
      recordUnresolved(resolved.code, resolved.targetId)
      return
    }
    let entry = targets.get(key)
    if (!entry) {
      recordUnresolved('no_target', resolved.targetId)
      return
    }
    const before = entry.state
    const hookState = isObject(payload) && typeof payload.state === 'string' ? payload.state : null
    if (hookState === 'done' && before.lastHook !== 'done' && before.seenWorking === false) {
      diagnostics.record({
        event: 'first_done_ignored',
        code: REASON_CODES.NO_FRESH_TURN,
        targetId: key,
      })
    }
    const mainAgentState =
      isObject(payload) && isObject(payload.mainAgent) && typeof payload.mainAgent.state === 'string'
        ? payload.mainAgent.state
        : null
    const after = applyReduce(key, {
      type: 'HOOK',
      state: isObject(payload) ? payload.state : undefined,
      receivedAt: isObject(payload) ? payload.receivedAt : undefined,
      mainAgentState,
      now: clock.now(),
    })
    if (after === null) {
      return
    }

    if (after.budgetResetSeq > before.budgetResetSeq) {
      try {
        await store.resetBudget(scopeOf(after.target))
      } catch {
        // 저장 실패는 store가 처리한다.
      }
    }
    if (after.selfTurnSeq > before.selfTurnSeq) {
      const attemptId = before.attempt?.id
      if (typeof attemptId === 'string') {
        try {
          await store.confirmAttempt(attemptId)
        } catch {
          // 확정 실패는 치명적이지 않다.
        }
        diagnostics.record({ event: 'turn_observed', targetId: key })
      }
    }
    if (before.phase !== 'ARMED' && after.phase === 'ARMED') {
      diagnostics.record({ event: 'epoch_armed', targetId: key })
    }

    // 탭 제목 ⚡ 표시: 자체 keepalive 턴이 아닌 실제 턴이 done이 되면 1회 새로 고친다.
    if (hookState === 'working') {
      if (after.selfTurnSeq > before.selfTurnSeq) {
        // 자체 keepalive 턴은 실제 턴 완료로 보지 않는다.
        pendingRealTurn.delete(key)
      } else if (after.budgetResetSeq > before.budgetResetSeq) {
        // 실제(사람/기타) 턴 시작: 이 target의 다음 done에서 제목을 새로 고친다.
        pendingRealTurn.add(key)
      }
    } else if (hookState === 'done' && pendingRealTurn.has(key)) {
      pendingRealTurn.delete(key)
      const tabId = typeof entry.meta.tabId === 'string' ? entry.meta.tabId : null
      const worktreeId = typeof after.target.worktreeId === 'string' ? after.target.worktreeId : null
      if (
        tabId !== null &&
        worktreeId !== null &&
        titleIndicator !== null &&
        typeof titleIndicator.onTurnCompleted === 'function'
      ) {
        fireAndForget(titleIndicator.onTurnCompleted(`${worktreeId}:${tabId}`))
      }
    }
  }

  /**
   * payload를 catalog의 유일한 row로 join한다. 없으면 catalog를 1회 재조회한다.
   * 버린 경우 code에 이유를 담아 돌려준다(내부 전용, 외부 API 불변).
   * @param {unknown} payload
   * @returns {Promise<{key: string|null, code: string|null, targetId: string|undefined}>}
   */
  async function resolveKeyForEvent(payload) {
    const event = isObject(payload) ? payload : null
    const inner = event && isObject(event.payload) ? event.payload : event
    const worktreeId = isObject(inner) ? inner.worktreeId : undefined
    const paneKey = isObject(inner) ? inner.paneKey : undefined
    const hasIds =
      typeof worktreeId === 'string' &&
      worktreeId.length > 0 &&
      typeof paneKey === 'string' &&
      paneKey.length > 0
    const targetId = hasIds ? keyFor(worktreeId, paneKey) : undefined
    if (!hasIds) {
      return { key: null, code: 'invalid_payload', targetId }
    }
    let catalog = latestCatalog
    let target = catalog ? observer.resolveEvent(payload, catalog) : null
    if (!target) {
      try {
        catalog = await observer.list()
        latestCatalog = catalog
      } catch {
        return { key: null, code: 'catalog_failed', targetId }
      }
      target = observer.resolveEvent(payload, catalog)
    }
    if (!target || typeof target.worktreeId !== 'string' || typeof target.paneKey !== 'string') {
      return { key: null, code: 'no_match', targetId }
    }
    const key = keyFor(target.worktreeId, target.paneKey)
    if (!targets.has(key) && catalog) {
      reconcileCatalog(catalog)
    }
    if (!targets.has(key)) {
      return { key: null, code: 'no_target', targetId }
    }
    return { key, code: null, targetId }
  }

  // -------------------------------------------------------------------------
  // 정책/수명주기 콜백
  // -------------------------------------------------------------------------

  function onPolicyChanged() {
    if (stopped) {
      return
    }
    // 다음 tick을 앞당기지 않는다. 진행 중 전송은 assertAllowed가 막으며, paste 이후
    // abort로 uncertain을 만들지 않는다.
    diagnostics.record({ event: 'policy_changed' })
    updateTitleIndicator(store.snapshot().config, titleIndicatorCatalogFailed)
  }

  function onWorktreeRemoved(payload) {
    if (stopped) {
      return
    }
    const worktreeId = isObject(payload) ? payload.worktreeId : undefined
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      return
    }
    for (const key of [...targets.keys()]) {
      const entry = targets.get(key)
      if (entry && entry.state.target.worktreeId === worktreeId) {
        targets.delete(key)
        pendingRealTurn.delete(key)
        forgetEpochMemory(key)
      }
    }
  }

  function onReviewCleared(payload) {
    if (stopped) {
      return
    }
    const worktreeId = isObject(payload) ? payload.worktreeId : undefined
    const paneKey = isObject(payload) ? payload.paneKey : undefined
    if (typeof worktreeId !== 'string' || typeof paneKey !== 'string') {
      return
    }
    const key = keyFor(worktreeId, paneKey)
    if (targets.has(key)) {
      applyReduce(key, { type: 'REVIEW_CLEARED' })
    }
    // 검토가 해제됐으므로 이전 예약을 복원 후보로 남기지 않는다.
    forgetEpochMemory(key)
  }

  async function currentWorktreeId() {
    if (observer === null) {
      return null
    }
    let catalog = latestCatalog
    if (!catalog) {
      try {
        catalog = await observer.list()
        latestCatalog = catalog
      } catch {
        return null
      }
    }
    try {
      return await observer.currentWorktree(catalog)
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // RuntimeView
  // -------------------------------------------------------------------------

  /**
   * dashboard-model이 쓰는 동기 view. 원시 draft/screen/token/경로를 포함하지 않는다.
   * @returns {RuntimeView}
   */
  function getRuntimeView() {
    /** @type {Map<string, any>} */
    const groups = new Map()
    for (const [key, entry] of targets) {
      const target = entry.state.target
      let group = groups.get(target.worktreeId)
      if (!group) {
        group = {
          worktreeId: target.worktreeId,
          repoId: entry.meta.repoId ?? null,
          label: entry.meta.label ?? null,
          branch: entry.meta.branch ?? null,
          projectLabel: null,
          terminals: [],
        }
        groups.set(target.worktreeId, group)
      }
      if (group.repoId === null && entry.meta.repoId) {
        group.repoId = entry.meta.repoId
      }
      if (group.label === null && entry.meta.label) {
        group.label = entry.meta.label
      }
      if (group.branch === null && entry.meta.branch) {
        group.branch = entry.meta.branch
      }
      group.terminals.push({
        worktreeId: target.worktreeId,
        paneKey: target.paneKey,
        title: entry.meta.title ?? null,
        phase: entry.state.phase,
        reason: entry.decision ? entry.decision.reason ?? null : entry.state.reason ?? null,
        dueAt: entry.decision ? entry.decision.dueAt ?? null : null,
        expiresAt: entry.decision ? entry.decision.expiresAt ?? null : null,
        supported: entry.meta.supported === true,
        unsupportedReason: entry.meta.unsupportedReason ?? null,
      })
    }

    // 같은 repoId의 워크트리는 항상 같은 projectLabel을 갖게 한다. repo 캐시에
    // displayName이 있으면 그것을 쓰고, 없으면 같은 repo의 label 중 사전순
    // 최솟값을 쓴다. repoId가 없으면 기존 group.label을 그대로 쓴다.
    const minLabelByRepo = new Map()
    for (const group of groups.values()) {
      if (typeof group.repoId !== 'string' || group.repoId.length === 0) {
        continue
      }
      if (typeof group.label !== 'string' || group.label.length === 0) {
        continue
      }
      const current = minLabelByRepo.get(group.repoId)
      if (current === undefined || group.label < current) {
        minLabelByRepo.set(group.repoId, group.label)
      }
    }
    for (const group of groups.values()) {
      const repoId = group.repoId
      if (typeof repoId !== 'string' || repoId.length === 0) {
        group.projectLabel = group.label ?? null
        continue
      }
      const cached = repoNames.get(repoId)
      group.projectLabel =
        typeof cached === 'string' ? cached : minLabelByRepo.get(repoId) ?? null
    }

    const worktrees = [...groups.values()]
      .map((group) => ({
        ...group,
        terminals: group.terminals
          .slice()
          .sort((a, b) => (a.paneKey < b.paneKey ? -1 : a.paneKey > b.paneKey ? 1 : 0)),
      }))
      .sort((a, b) => (a.worktreeId < b.worktreeId ? -1 : a.worktreeId > b.worktreeId ? 1 : 0))

    const settings = isObject(lastSettings) ? lastSettings : null
    return {
      userDataKey: binding ? binding.userDataKey : null,
      profileId: currentProfileId,
      connection: { state: connection.state, reason: connection.reason ?? null },
      appTimer: {
        known: settings ? settings.known === true : false,
        enabled: settings ? settings.enabled === true : false,
        ttlMs: settings && typeof settings.ttlMs === 'number' ? settings.ttlMs : null,
        source: settings && typeof settings.source === 'string' ? settings.source : null,
        readAt: settings && typeof settings.readAt === 'number' ? settings.readAt : null,
        reason: settings && typeof settings.reason === 'string' ? settings.reason : null,
      },
      worktrees,
    }
  }

  function getRpc() {
    return rpc
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  /**
   * timer를 해제하고 in-flight 전송(최대 10초)을 기다린 뒤 rpc를 닫는다. 두 번 안전하다.
   * @returns {Promise<void>}
   */
  function stop() {
    if (stopPromise !== null) {
      return stopPromise
    }
    stopped = true
    // 진행 중 repo 이름 조회는 중단한다. 늦게 끝난 결과는 stopped 가드로 무시된다.
    try {
      repoNameAbort.abort()
    } catch {
      // ignore
    }
    if (tickTimer !== null) {
      try {
        clock.clearTimeout(tickTimer)
      } catch {
        // ignore
      }
      tickTimer = null
    }
    if (heartbeatTimer !== null) {
      try {
        clock.clearTimeout(heartbeatTimer)
      } catch {
        // ignore
      }
      heartbeatTimer = null
    }
    if (reconnectTimer !== null) {
      try {
        clock.clearTimeout(reconnectTimer)
      } catch {
        // ignore
      }
      reconnectTimer = null
    }
    diagnostics.record({ event: 'shutdown' })

    stopPromise = (async () => {
      const pending = [...runningSends]
      if (pending.length > 0) {
        /** @type {any} */
        let guard
        const timeout = new Promise((resolve) => {
          guard = setTimeout(resolve, STOP_TIMEOUT_MS)
          if (guard && typeof guard.unref === 'function') {
            guard.unref()
          }
        })
        try {
          await Promise.race([Promise.allSettled(pending), timeout])
        } catch {
          // ignore
        }
        if (guard) {
          clearTimeout(guard)
        }
      }
      // rpc를 닫기 전에 탭 제목 기록을 복원한다(최대 5초, 실패 무시). 옵션이 꺼져
      // 있어도 남은 기록이 있으면 되돌린다.
      await restoreTitleIndicator()
      if (rpc !== null && typeof rpc.close === 'function') {
        try {
          rpc.close()
        } catch {
          // ignore
        }
      }
      // in-flight 전송을 abort하지 않는다. paste 이후 abort는 실제로 전달됐을 수 있는
      // 입력을 "불확실"로 확정하지 못하게 만들기 때문이다. 대신 stopped 플래그와
      // STALE_TARGET 게이트가 남은 전송을 막는다. 대기 중 저장은 여기서 비운다.
      if (typeof store.flush === 'function') {
        try {
          await store.flush()
        } catch {
          // flush 미지원/실패는 무시한다.
        }
      }
      // 예약 메모리의 대기 중 저장을 best-effort로 마무리한다(실패 무시).
      if (epochMemory !== null && typeof epochMemory.flush === 'function') {
        try {
          await epochMemory.flush()
        } catch {
          // flush 실패는 무시한다.
        }
      }
    })()
    return stopPromise
  }

  return {
    start,
    stop,
    onAgentEvent,
    onWorktreeRemoved,
    getRuntimeView,
    currentWorktreeId,
    onReviewCleared,
    onPolicyChanged,
    getRpc,
  }
}

/**
 * targets Map key를 만든다. main.mjs의 진단 hashTarget 연결과 테스트가 쓴다.
 * 동작은 내부 keyFor와 같다.
 */
export { keyFor as targetKeyFor }
