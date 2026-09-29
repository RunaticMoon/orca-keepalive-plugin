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

import { TIMING } from './contracts.mjs'
import { sameBinding } from './runtime-location.mjs'
import { marginFor } from './scheduler.mjs'

/** targets Map key 구분자. worktreeId/paneKey를 tuple로 join한다. */
const KEY_SEP = '\u0000'
/** 이벤트 queue 상한. 초과 시 가장 오래된 것부터 버린다. */
const MAX_EVENT_QUEUE = 1000
/** heartbeat가 사용하는 host storage key. §5.2. */
const STATE_KEY = 'state-v1'
/** stop이 in-flight 전송을 기다리는 최대 시간. */
const STOP_TIMEOUT_MS = 10000
/** bootstrap 재연결 backoff(ms). §4.2. 마지막 값을 상한으로 반복한다. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000]
/** 전송 결과 불확실을 나타내는 reason. */
const UNKNOWN_SEND_REASON = 'PARTIAL_OR_UNKNOWN_SEND'

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
 * @property {string|null} label
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
   * 적용 뒤 RuntimeView용 decision을 갱신한다.
   * @param {string} key
   * @param {object} input
   * @returns {any|null}
   */
  function applyReduce(key, input) {
    const entry = targets.get(key)
    if (!entry) {
      return null
    }
    entry.state = scheduler.reduceTarget(entry.state, input)
    refreshDecision(key)
    return entry.state
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
    targets.clear()
    skipUntil.clear()
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
          applyReduce(key, { type: 'CLOCK_GAP' })
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
    try {
      latestCatalog = await observer.list()
      reconcileCatalog(latestCatalog)
    } catch {
      // 읽기 실패: 기존 catalog/target을 유지한다.
    }

    // d. 대기 중 이벤트 drain.
    await drainEvents()

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
      applyReduce(key, { type: 'TICK', now: clock.now() })
      const decision = entry.decision
      if (decision && decision.kind === 'expire') {
        const state = targets.get(key)?.state
        if (state && state.epoch !== null) {
          applyReduce(key, { type: 'EXPIRE', epochId: state.epoch.id })
        }
        diagnostics.record({ event: 'epoch_expired', code: 'EXPIRED', targetId: key })
      } else if (decision && decision.kind === 'send') {
        if (catalogIncomplete) {
          // 목록이 불완전하면 목록 전체를 정상으로 취급하지 않고 새 전송을
          // 시작하지 않는다(§4.3/§5.5). 이미 진행 중인 전송은 건드리지 않는다.
          // 대시보드에는 기존 reason 필드로 이유를 노출한다.
          entry.decision = {
            kind: 'wait',
            reason: 'catalog_incomplete',
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

    if (profileId !== null) {
      if (currentProfileId === null) {
        currentProfileId = profileId
      } else if (profileId !== currentProfileId) {
        targets.clear()
        skipUntil.clear()
        currentProfileId = profileId
        changed = true
      }
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
      diagnostics.record({ event: 'safety_skipped', code: 'catalog_incomplete' })
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
        label: typeof row.branch === 'string' ? row.branch : null,
        supported: row.supported === true,
        unsupportedReason: typeof row.unsupportedReason === 'string' ? row.unsupportedReason : null,
      }
      const entry = targets.get(key)
      if (!entry) {
        targets.set(key, { state: scheduler.initialTargetState(target), decision: null, meta })
      } else {
        const prev = entry.state.target
        if (
          prev.handle !== target.handle ||
          prev.ptyId !== target.ptyId ||
          prev.incarnationId !== target.incarnationId
        ) {
          applyReduce(key, { type: 'TARGET_CHANGED', target })
        }
        entry.meta = meta
      }
    }
    if (catalog.complete === true) {
      for (const key of [...targets.keys()]) {
        if (!seen.has(key)) {
          targets.delete(key)
        }
      }
    }
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
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async function handleAgentEvent(payload) {
    const key = await resolveKeyForEvent(payload)
    if (key === null) {
      return
    }
    let entry = targets.get(key)
    if (!entry) {
      return
    }
    const before = entry.state
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
  }

  /**
   * payload를 catalog의 유일한 row로 join한다. 없으면 catalog를 1회 재조회한다.
   * @param {unknown} payload
   * @returns {Promise<string|null>}
   */
  async function resolveKeyForEvent(payload) {
    let catalog = latestCatalog
    let target = catalog ? observer.resolveEvent(payload, catalog) : null
    if (!target) {
      try {
        catalog = await observer.list()
        latestCatalog = catalog
      } catch {
        return null
      }
      target = observer.resolveEvent(payload, catalog)
    }
    if (!target || typeof target.worktreeId !== 'string' || typeof target.paneKey !== 'string') {
      return null
    }
    const key = keyFor(target.worktreeId, target.paneKey)
    if (!targets.has(key) && catalog) {
      reconcileCatalog(catalog)
    }
    return key
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
        group = { worktreeId: target.worktreeId, label: entry.meta.label ?? null, terminals: [] }
        groups.set(target.worktreeId, group)
      }
      if (group.label === null && entry.meta.label) {
        group.label = entry.meta.label
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
      if (rpc !== null && typeof rpc.close === 'function') {
        try {
          rpc.close()
        } catch {
          // ignore
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
