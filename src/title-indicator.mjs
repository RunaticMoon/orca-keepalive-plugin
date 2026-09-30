/**
 * 옵션(기본 켜짐): keepalive가 적용되는 Claude 터미널의 Orca 탭 이름 앞에
 * prefix("⚡ ")를 붙이는 모듈 (작업 O).
 *
 * Orca 런타임 RPC만 사용한다(주입된 `rpc`/`hostCall`). `terminal.rename`은 탭 전체의
 * customTitle을 바꾸고(영구 저장) `null`/`""`은 customTitle을 해제한다. 사용자 지정
 * 이름과 자동 이름을 구분하는 필드가 RPC에 없으므로 되돌릴 때는 `null`만 쓴다(한계).
 *  - `session.tabs.list`의 title은 customTitle이 아니라 런타임 제목 투영값(OSC/PTY,
 *    최신 갱신 우선)이라 applied와 비교할 수 없다. 그래서 off 해제는 제목 비교 없이
 *    rename(null)을 시도하며, 사용자가 수동으로 바꾼 탭 제목도 off 시 해제될 수 있다(한계).
 *
 * 안전 규칙:
 *  - 기록(records)을 storage에 먼저 저장한 뒤 rename한다. 비정상 종료 시 prefix가
 *    남아도 다음 시작의 reconcile이 되돌릴 수 있게 하기 위함이다. 기록의
 *    `confirmed`가 false면 rename이 아직 확인되지 않았다는 뜻이고, 다음
 *    reconcile이 재적용을 시도한다. 새 인스턴스는 storage에서 읽은 기록을 이번
 *    실행에서 확인되지 않은 것(confirmed:false)으로 취급해 첫 전체 reconcile에서
 *    want=true 탭에 ⚡를 다시 적용한다. 이전 인스턴스 종료가 2초 제한으로 중간에
 *    끊기면(Orca 업데이트/종료 시 runtime RPC가 동시에 닫힘) ⚡가 지워졌는데 기록은
 *    confirmed:true로 남을 수 있기 때문이다.
 *  - `session.tabs.list`의 terminal 항목 `id`는 탭 합성 키일 뿐 terminal
 *    핸들이 아니다. rename에는 coordinator가 terminal.list에서 넘긴 handle만 쓴다.
 *  - 모든 RPC/저장 오류는 삼키고 진단에는 안전한 code만 남긴다. 제목 문자열/토큰은
 *    로그·에러·진단에 넣지 않는다.
 *  - 탭별 연속 실패가 maxFailures회면 그 탭을 이 인스턴스 수명 동안 건너뛴다.
 *
 * import 시 부작용이 없고 I/O/타이머를 시작하지 않는다.
 *
 * @module title-indicator
 */

/** 저장 기록 최대 개수. */
const MAX_RECORDS = 200

/** 저장 JSON 직렬화 크기 상한(byte). */
const MAX_STORAGE_BYTES = 64 * 1024

/** customTitle 최대 길이(문자). */
const MAX_APPLIED_LENGTH = 200

const DEFAULT_STORAGE_KEY = 'title-indicator-v1'
const DEFAULT_PREFIX = '⚡ '
const DEFAULT_REFRESH_MIN_INTERVAL_MS = 60_000
const DEFAULT_SETTLE_MS = 1_500
const DEFAULT_RPC_TIMEOUT_MS = 3_000
const DEFAULT_MAX_FAILURES = 3
const REMOVE_RETRY_BASE_MS = 10_000
const REMOVE_RETRY_MAX_MS = 5 * 60_000

/** 제목이 비었을 때 넣는 대체 base. */
const FALLBACK_BASE = 'Claude'

/** prefix 반복 제거 루프의 안전 상한(비정상 입력 방어). */
const MAX_PREFIX_STRIPS = 1000

/**
 * 배열이 아닌 객체인지 확인한다.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 비어 있지 않은 문자열인지 확인한다.
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * prefix를 반복 제거한 뒤 trim한다.
 * @param {string} value
 * @param {string} prefix
 * @returns {string}
 */
function stripPrefix(value, prefix) {
  let text = typeof value === 'string' ? value : ''
  if (prefix.length === 0) {
    return text.trim()
  }
  let strips = 0
  while (strips < MAX_PREFIX_STRIPS && text.startsWith(prefix)) {
    text = text.slice(prefix.length)
    strips += 1
  }
  return text.trim()
}

/**
 * 저장된 tabKey에서 records Map을 복원한다. 최상위 형식이 불량이면 null을 돌려준다.
 * 개별 record가 불량이면 그 항목만 버린다. `confirmed`가 없으면 true로 채운다(형식
 * 기본값). load()는 이 값을 저장소에 남기지 않고 모든 항목을 미확정으로 다시
 * 표시하므로 이 기본값은 재적용 여부에 영향을 주지 않는다.
 * @param {unknown} raw
 * @returns {Map<string, {worktreeId:string, tabId:string, handle:string, applied:string, confirmed:boolean}>|null}
 */
function parseStoredRecords(raw) {
  if (raw === undefined || raw === null) {
    return new Map()
  }
  let source = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return null
    }
  }
  if (!isObject(source)) {
    return null
  }

  const records = new Map()
  for (const [key, value] of Object.entries(source)) {
    if (!isNonEmptyString(key) || !isObject(value)) {
      continue
    }
    const { worktreeId, tabId, handle, applied, confirmed } = value
    if (!isNonEmptyString(worktreeId) || !isNonEmptyString(tabId)) {
      continue
    }
    if (!isNonEmptyString(handle) || !isNonEmptyString(applied)) {
      continue
    }
    records.set(key, { worktreeId, tabId, handle, applied, confirmed: confirmed !== false })
  }
  return records
}

/**
 * pane 단위 desired 목록을 탭 단위 want/handle/leafId로 합산한다.
 * on pane이 하나라도 있으면 want=true이고 handle/leafId는 첫 on pane의 값이다.
 * @param {unknown} desired
 * @returns {Map<string, {worktreeId:string, tabId:string, want:boolean, handle:string|null, leafId:string|null}>}
 */
function aggregateDesired(desired) {
  const byTab = new Map()
  if (!Array.isArray(desired)) {
    return byTab
  }
  for (const pane of desired) {
    if (!isObject(pane)) {
      continue
    }
    const worktreeId = pane.worktreeId
    const tabId = pane.tabId
    if (!isNonEmptyString(worktreeId) || !isNonEmptyString(tabId)) {
      continue
    }
    const tabKey = `${worktreeId}:${tabId}`
    let agg = byTab.get(tabKey)
    if (agg === undefined) {
      agg = { worktreeId, tabId, want: false, handle: null, leafId: null }
      byTab.set(tabKey, agg)
    }
    if (pane.on === true) {
      agg.want = true
      if (agg.handle === null && isNonEmptyString(pane.handle)) {
        agg.handle = pane.handle
        agg.leafId = isNonEmptyString(pane.leafId) ? pane.leafId : null
      }
    }
  }
  return byTab
}

/**
 * 탭 이름 표시기를 만든다.
 *
 * @param {Object} deps
 * @param {{ call: (method: string, params: unknown, options?: {timeoutMs?: number}) => Promise<unknown> }} deps.rpc
 * @param {(method: string, params?: unknown) => Promise<unknown>} deps.hostCall `storage.get`/`storage.set`.
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<unknown> }} [deps.clock]
 * @param {{ record: (input: {event: string, code?: string}) => void }} [deps.diagnostics]
 * @param {string} [deps.storageKey]
 * @param {string} [deps.prefix]
 * @param {number} [deps.refreshMinIntervalMs]
 * @param {number} [deps.settleMs]
 * @param {number} [deps.rpcTimeoutMs]
 * @param {number} [deps.maxFailures]
 * @returns {{
 *   load: () => Promise<void>,
 *   reconcile: (desired: unknown, options?: {removeOnly?: boolean}) => Promise<void>,
 *   onTurnCompleted: (tabKey: string) => Promise<void>,
 *   restoreAll: () => Promise<void>,
 *   snapshot: () => {tabs: number, disabledTabs: number},
 * }}
 */
export function createTitleIndicator({
  rpc,
  hostCall,
  clock,
  diagnostics,
  storageKey = DEFAULT_STORAGE_KEY,
  prefix = DEFAULT_PREFIX,
  refreshMinIntervalMs = DEFAULT_REFRESH_MIN_INTERVAL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
} = {}) {
  if (rpc === null || typeof rpc !== 'object' || typeof rpc.call !== 'function') {
    throw new TypeError('createTitleIndicator requires an rpc.call function')
  }
  if (typeof hostCall !== 'function') {
    throw new TypeError('createTitleIndicator requires a hostCall function')
  }

  const now = clock !== null && typeof clock === 'object' && typeof clock.now === 'function' ? clock.now : () => Date.now()
  const sleep =
    clock !== null && typeof clock === 'object' && typeof clock.sleep === 'function'
      ? clock.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const diag =
    diagnostics !== null && typeof diagnostics === 'object' && typeof diagnostics.record === 'function'
      ? diagnostics
      : { record: () => {} }

  const safePrefix = typeof prefix === 'string' ? prefix : DEFAULT_PREFIX
  const key = isNonEmptyString(storageKey) ? storageKey : DEFAULT_STORAGE_KEY
  const minInterval =
    typeof refreshMinIntervalMs === 'number' && Number.isFinite(refreshMinIntervalMs) && refreshMinIntervalMs >= 0
      ? refreshMinIntervalMs
      : DEFAULT_REFRESH_MIN_INTERVAL_MS
  const settle =
    typeof settleMs === 'number' && Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : DEFAULT_SETTLE_MS
  const timeout =
    typeof rpcTimeoutMs === 'number' && Number.isFinite(rpcTimeoutMs) && rpcTimeoutMs > 0
      ? rpcTimeoutMs
      : DEFAULT_RPC_TIMEOUT_MS
  const failureLimit =
    Number.isSafeInteger(maxFailures) && maxFailures > 0 ? maxFailures : DEFAULT_MAX_FAILURES

  /**
   * tabKey → { worktreeId, tabId, handle, applied, confirmed }. 삽입 순서가 곧 오래된 순서다.
   * `applied`는 더 이상 제거/복원 판정에 쓰지 않는다(Orca `session.tabs.list` title이
   * customTitle이 아니라 런타임 제목이라 비교할 수 없다). 저장 형식 호환·진단용으로만 유지한다.
   * @type {Map<string, {worktreeId:string, tabId:string, handle:string, applied:string, confirmed:boolean}>}
   */
  const records = new Map()
  /** @type {Map<string, boolean>} tabKey → 최근 reconcile의 want. */
  const wantByTab = new Map()
  /** @type {Map<string, number>} tabKey → 마지막 refresh 시각(ms). 메모리 전용. */
  const lastRefreshAt = new Map()
  /** @type {Map<string, number>} tabKey → 연속 실패 횟수. */
  const failures = new Map()
  /** @type {Map<string, number>} tabKey → 제거 작업 연속 실패 횟수. apply 실패와 분리한다. */
  const removeFailures = new Map()
  /** @type {Map<string, number>} tabKey → 다음 제거 재시도 가능 시각(ms). */
  const removeRetryAt = new Map()
  /** @type {Set<string>} 이 인스턴스에서 건너뛸 탭. */
  const disabled = new Set()

  let queueTail = Promise.resolve()
  let reconcileBusy = false
  /** @type {{list: unknown[], removeOnly: boolean}|null} */
  let pendingDesired = null
  let reconcileTail = Promise.resolve()

  /**
   * 안전한 code만 진단에 남긴다. 제목/토큰 등 문자열은 넘기지 않는다.
   * @param {string} code
   */
  function diagnose(code) {
    try {
      diag.record({ event: 'title_indicator', code })
    } catch {
      /* 진단 실패는 삼킨다. */
    }
  }

  /**
   * 작업을 단일 queue에 넣어 순서를 보장한다. 이전 task 실패는 다음 task를 막지 않는다.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queueTail.then(() => task())
    queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 탭별 연속 실패를 기록한다. 상한에 도달하면 그 탭을 비활성화한다.
   * @param {string} tabKey
   * @param {string} code
   */
  function noteFailure(tabKey, code) {
    diagnose(code)
    const count = (failures.get(tabKey) ?? 0) + 1
    failures.set(tabKey, count)
    if (count >= failureLimit && !disabled.has(tabKey)) {
      disabled.add(tabKey)
      diagnose('tab_disabled')
    }
  }

  /**
   * 성공 시 실패 카운터를 지운다.
   * @param {string} tabKey
   */
  function clearFailures(tabKey) {
    failures.delete(tabKey)
  }

  /**
   * 제거 실패를 기록하고 지수 백오프를 예약한다. apply용 disabled/failures는 건드리지 않는다.
   * @param {string} tabKey
   * @param {string} code
   */
  function noteRemoveFailure(tabKey, code) {
    diagnose(code)
    const count = (removeFailures.get(tabKey) ?? 0) + 1
    removeFailures.set(tabKey, count)
    const exponent = Math.min(count - 1, 5)
    const delay = Math.min(REMOVE_RETRY_BASE_MS * 2 ** exponent, REMOVE_RETRY_MAX_MS)
    removeRetryAt.set(tabKey, now() + delay)
  }

  /** @param {string} tabKey */
  function clearRemoveFailure(tabKey) {
    removeFailures.delete(tabKey)
    removeRetryAt.delete(tabKey)
  }

  /**
   * records를 저장용 plain object로 복사한다.
   * @returns {Record<string, {worktreeId:string, tabId:string, handle:string, applied:string, confirmed:boolean}>}
   */
  function recordsToObject() {
    /** @type {Record<string, {worktreeId:string, tabId:string, handle:string, applied:string, confirmed:boolean}>} */
    const out = {}
    for (const [tabKey, record] of records) {
      out[tabKey] = { ...record }
    }
    return out
  }

  /**
   * records를 최대 개수·크기 상한 안으로 줄인다(오래된 항목부터 버린다).
   */
  function trimRecords() {
    while (records.size > MAX_RECORDS) {
      const oldest = records.keys().next().value
      if (oldest === undefined) {
        break
      }
      records.delete(oldest)
    }
    let bytes = Buffer.byteLength(JSON.stringify(recordsToObject()), 'utf8')
    while (records.size > 0 && bytes > MAX_STORAGE_BYTES) {
      const oldest = records.keys().next().value
      if (oldest === undefined) {
        break
      }
      records.delete(oldest)
      bytes = Buffer.byteLength(JSON.stringify(recordsToObject()), 'utf8')
    }
  }

  /** records를 storage에 저장한다. 실패 시 throw한다. */
  async function persistRecords() {
    trimRecords()
    await hostCall('storage.set', { key, value: recordsToObject() })
  }

  /**
   * 탭의 현재 제목을 session.tabs.list에서 읽는다.
   * 같은 tabId(parentTabId) 아래 terminal 항목 중 leafId 일치를 우선한다.
   * 탭이 없으면 null. 항목의 `id`는 탭 합성 키이므로 terminal 핸들로 쓰지 않는다.
   * @param {string} worktreeId
   * @param {string} tabId
   * @param {string|null} leafId
   * @returns {Promise<{title: string}|null>}
   */
  async function readTab(worktreeId, tabId, leafId) {
    const result = await rpc.call(
      'session.tabs.list',
      { worktree: 'id:' + worktreeId },
      { timeoutMs: timeout },
    )
    const tabs = isObject(result) && Array.isArray(result.tabs) ? result.tabs : []
    const candidates = tabs.filter(
      (entry) =>
        isObject(entry) &&
        entry.parentTabId === tabId &&
        (entry.type === undefined || entry.type === 'terminal'),
    )
    if (candidates.length === 0) {
      return null
    }
    let chosen = null
    if (isNonEmptyString(leafId)) {
      chosen = candidates.find((entry) => entry.leafId === leafId) ?? null
    }
    if (chosen === null) {
      chosen = candidates[0]
    }
    return {
      title: typeof chosen.title === 'string' ? chosen.title : '',
    }
  }

  /**
   * 제목에서 prefix 반복을 제거하고 trim한 base를 만든다. 비면 'Claude'.
   * @param {unknown} title
   * @returns {string}
   */
  function baseFromTitle(title) {
    const stripped = stripPrefix(typeof title === 'string' ? title : '', safePrefix)
    return stripped.length > 0 ? stripped : FALLBACK_BASE
  }

  /**
   * base에 prefix를 붙이고 최대 길이로 자른다.
   * @param {string} base
   * @returns {string}
   */
  function makeApplied(base) {
    const full = safePrefix + base
    return full.length > MAX_APPLIED_LENGTH ? full.slice(0, MAX_APPLIED_LENGTH) : full
  }

  /**
   * want=true이고 적용이 필요할 때 prefix를 적용한다. 기록을 `confirmed:false`로
   * 먼저 저장한 뒤 rename하고, rename이 성공하면 `confirmed:true`로 갱신·저장한다.
   * 핸들은 coordinator가 terminal.list에서 넘긴 `agg.handle`만 쓴다. 탭을 찾지
   * 못하거나 핸들이 없으면 아무것도 하지 않는다.
   * @param {{worktreeId:string, tabId:string, handle:string|null, leafId:string|null}} agg
   */
  async function applyTab(agg) {
    const tabKey = `${agg.worktreeId}:${agg.tabId}`
    if (disabled.has(tabKey)) {
      return
    }
    if (!isNonEmptyString(agg.handle)) {
      // terminal 핸들이 없으면 rename할 수 없다. tabs.list id를 핸들로 쓰지 않는다.
      return
    }

    let found
    try {
      found = await readTab(agg.worktreeId, agg.tabId, agg.leafId)
    } catch {
      noteFailure(tabKey, 'list_failed')
      return
    }
    if (found === null) {
      return
    }
    const handle = agg.handle

    const base = baseFromTitle(found.title)
    const applied = makeApplied(base)
    const record = { worktreeId: agg.worktreeId, tabId: agg.tabId, handle, applied, confirmed: false }

    records.set(tabKey, record)
    try {
      await persistRecords()
    } catch {
      records.delete(tabKey)
      noteFailure(tabKey, 'save_failed')
      return
    }

    try {
      await rpc.call('terminal.rename', { terminal: handle, title: applied }, { timeoutMs: timeout })
    } catch {
      // 기록은 미확정으로 남긴다. 다음 reconcile이 재적용을 시도한다.
      noteFailure(tabKey, 'rename_failed')
      return
    }

    record.confirmed = true
    records.set(tabKey, record)
    try {
      await persistRecords()
    } catch {
      // 메모리 값은 확정으로 유지한다.
      diagnose('save_failed')
    }
    clearFailures(tabKey)
    clearRemoveFailure(tabKey)
  }

  /**
   * 기록을 지우고 저장한다.
   * @param {string} tabKey
   */
  async function deleteRecord(tabKey) {
    records.delete(tabKey)
    wantByTab.delete(tabKey)
    lastRefreshAt.delete(tabKey)
    failures.delete(tabKey)
    clearRemoveFailure(tabKey)
    try {
      await persistRecords()
    } catch {
      diagnose('save_failed')
    }
  }

  /**
   * want=false이고 기록이 있을 때 prefix를 되돌린다. `session.tabs.list`의 title은
   * customTitle이 아니라 런타임 제목 투영값이라 applied와 비교할 수 없다. 탭이
   * 존재하면(found !== null) 제목 비교 없이 항상 rename(null)을 시도하고, 탭이
   * 없으면 rename 없이 기록만 정리한다. 이 때문에 사용자가 수동으로 바꾼 탭 제목도
   * off 시 해제될 수 있다(한계). 조회/rename 실패면 기록을 보존하고 지수 백오프 후
   * 재시도한다.
   * @param {string} tabKey
   * @param {{worktreeId:string, tabId:string, handle:string, applied:string, confirmed:boolean}} record
   */
  async function removeTab(tabKey, record) {
    if (now() < (removeRetryAt.get(tabKey) ?? 0)) {
      return
    }

    let found
    try {
      found = await readTab(record.worktreeId, record.tabId, null)
    } catch {
      noteRemoveFailure(tabKey, 'list_failed')
      return
    }

    if (found !== null) {
      try {
        await rpc.call(
          'terminal.rename',
          { terminal: record.handle, title: null },
          { timeoutMs: timeout },
        )
      } catch {
        // 실패했을 수 있으므로 기록을 보존해 다음 reconcile에서 재시도한다.
        noteRemoveFailure(tabKey, 'rename_failed')
        return
      }
    }

    await deleteRecord(tabKey)
  }

  /**
   * 실제 사용자 턴 완료 시 커스텀 제목을 해제하고 자동 제목을 다시 읽어 새 prefix를
   * 적용한다. 확정(`confirmed:true`)된 기록에만 동작한다. 갱신 중 rename이 실패하면
   * 기록을 미확정으로 돌려 다음 reconcile이 재적용하게 한다. 간격 제한을 지키고
   * 직렬 queue로 실행한다.
   * @param {string} tabKey
   */
  async function refreshTab(tabKey) {
    const record = records.get(tabKey)
    if (record === undefined || record.confirmed !== true || disabled.has(tabKey)) {
      return
    }
    if (wantByTab.get(tabKey) === false) {
      await removeTab(tabKey, record)
      return
    }

    let found
    try {
      found = await readTab(record.worktreeId, record.tabId, null)
    } catch {
      noteFailure(tabKey, 'list_failed')
      return
    }
    if (found === null) {
      noteFailure(tabKey, 'tab_missing')
      return
    }
    // title은 런타임 제목 투영값이라 applied와 비교할 수 없다. 사용자가 이름을
    // 바꿨는지 판별할 수 없으므로 항상 rename(null)로 해제한 뒤 새 제목을 적용한다.

    const handle = record.handle
    try {
      await rpc.call('terminal.rename', { terminal: handle, title: null }, { timeoutMs: timeout })
    } catch {
      noteFailure(tabKey, 'rename_failed')
      return
    }

    await sleep(settle)

    if (wantByTab.get(tabKey) === false) {
      await deleteRecord(tabKey)
      return
    }

    let after
    try {
      after = await readTab(record.worktreeId, record.tabId, null)
    } catch {
      noteFailure(tabKey, 'list_failed')
      return
    }
    if (after === null) {
      noteFailure(tabKey, 'tab_missing')
      return
    }

    const applied = makeApplied(baseFromTitle(after.title))
    record.applied = applied
    record.confirmed = false
    records.set(tabKey, record)
    try {
      await persistRecords()
    } catch {
      noteFailure(tabKey, 'save_failed')
      return
    }
    try {
      await rpc.call(
        'terminal.rename',
        { terminal: record.handle, title: applied },
        { timeoutMs: timeout },
      )
    } catch {
      // 미확정으로 남긴다. 다음 reconcile이 재적용을 시도한다.
      noteFailure(tabKey, 'rename_failed')
      return
    }
    record.confirmed = true
    records.set(tabKey, record)
    try {
      await persistRecords()
    } catch {
      diagnose('save_failed')
    }
    clearFailures(tabKey)
    // 제거 재시도가 실패했던 탭도 refresh로 제목을 복구했으면 재시도 상태를 지운다.
    clearRemoveFailure(tabKey)
  }

  /**
   * desired 하나를 모든 탭에 대해 반영한다.
   * @param {unknown[]} desired
   * @param {boolean} removeOnly
   */
  async function doReconcile(desired, removeOnly) {
    const byTab = aggregateDesired(desired)
    const tabKeys = new Set([...byTab.keys(), ...records.keys()])
    for (const tabKey of tabKeys) {
      const agg = byTab.get(tabKey) ?? null
      const record = records.get(tabKey) ?? null
      // 불완전 catalog에서는 명시적으로 알려진 off만 제거한다. 누락된 기록은
      // 목록에서 사라졌다고 단정할 수 없고, on target도 새로 적용하지 않는다.
      if (removeOnly && agg === null) {
        continue
      }
      const want = agg !== null && agg.want === true
      wantByTab.set(tabKey, want)

      if (removeOnly) {
        if (!want && record !== null) {
          await removeTab(tabKey, record)
        }
        continue
      }

      if (want) {
        if (record === null) {
          if (agg !== null && !disabled.has(tabKey)) {
            await applyTab(agg)
          }
        } else if (record.confirmed !== true || removeFailures.has(tabKey)) {
          // 저장만 되고 rename이 확인되지 않은 기록은 다시 적용을 시도한다.
          // 제거 재시도가 실패했던 탭도 on 전환 시 다시 적용해 표시기를 복구한다.
          // (crash로 이미 prefix가 붙어 있어도 base 계산이 중복 접두어를 막는다.)
          if (agg !== null && !disabled.has(tabKey)) {
            await applyTab(agg)
          }
        } else if (
          agg !== null &&
          !disabled.has(tabKey) &&
          isNonEmptyString(agg.handle) &&
          agg.handle !== record.handle
        ) {
          record.handle = agg.handle
          records.set(tabKey, record)
          try {
            await persistRecords()
          } catch {
            diagnose('save_failed')
          }
        }
      } else if (record !== null) {
        // disabled여도 기록이 있으면 remove만 시도한다.
        await removeTab(tabKey, record)
      }
    }
  }

  /**
   * 최근 reconcile의 want 상태를 동기적으로 갱신한다. refresh가 "도중 off"를
   * 판단할 때 최신 호출을 즉시 볼 수 있게 한다.
   * @param {unknown[]} desired
   * @param {boolean} removeOnly
   */
  function applyWantState(desired, removeOnly) {
    const byTab = aggregateDesired(desired)
    for (const [tabKey, agg] of byTab) {
      wantByTab.set(tabKey, agg.want)
    }
    if (!removeOnly) {
      for (const tabKey of records.keys()) {
        if (!byTab.has(tabKey)) {
          wantByTab.set(tabKey, false)
        }
      }
    }
  }

  /**
   * desired를 반영한다. 진행 중이면 다음 호출은 최신 desired 하나로 합쳐진다.
   * @param {unknown} desired
   * @param {{removeOnly?: boolean}} [options] 불완전 목록에서 off 제거만 수행한다.
   * @returns {Promise<void>}
   */
  function reconcile(desired, options = {}) {
    const list = Array.isArray(desired) ? desired : []
    const removeOnly = options !== null && options.removeOnly === true
    applyWantState(list, removeOnly)
    pendingDesired = { list, removeOnly }
    if (!reconcileBusy) {
      reconcileBusy = true
      reconcileTail = enqueue(async () => {
        try {
          while (pendingDesired !== null) {
            const next = pendingDesired
            pendingDesired = null
            await doReconcile(next.list, next.removeOnly)
          }
        } finally {
          reconcileBusy = false
        }
      })
    }
    return reconcileTail
  }

  /**
   * storage에서 기록을 읽는다. 형식이 불량이면 빈 기록으로 시작한다. 읽은 기록은
   * 저장된 `confirmed`와 무관하게 이번 실행에서 미확정(confirmed:false)으로
   * 표시해, 첫 전체 reconcile이 want=true 탭에 ⚡를 다시 적용하게 한다.
   * @returns {Promise<void>}
   */
  function load() {
    return enqueue(async () => {
      let raw
      try {
        const result = await hostCall('storage.get', { key })
        raw = isObject(result) && 'value' in result ? result.value : result
      } catch {
        records.clear()
        diagnose('load_failed')
        return
      }
      const parsed = parseStoredRecords(raw)
      records.clear()
      failures.clear()
      removeFailures.clear()
      removeRetryAt.clear()
      disabled.clear()
      if (parsed === null) {
        if (raw !== undefined && raw !== null) {
          diagnose('record_invalid')
        }
        return
      }
      // 저장된 confirmed 값과 무관하게 이번 실행에서는 미확정으로 취급한다. 이전
      // 인스턴스 종료가 2초 제한으로 중간에 끊기면 ⚡가 지워졌는데 기록은
      // confirmed:true로 남을 수 있으므로, 첫 전체 reconcile이 want=true 탭에
      // 새 handle로 ⚡를 다시 적용하게 한다. 저장 형식의 confirmed 필드는 유지한다.
      for (const [tabKey, record] of parsed) {
        records.set(tabKey, { ...record, confirmed: false })
      }
      trimRecords()
    })
  }

  /**
   * 사용자 턴 완료 시 호출된다. 기록이 있고 간격이 지났으면 refresh를 queue에 넣는다.
   * @param {string} tabKey
   * @returns {Promise<void>}
   */
  function onTurnCompleted(tabKey) {
    const record = isNonEmptyString(tabKey) ? records.get(tabKey) : undefined
    if (record === undefined || record.confirmed !== true || disabled.has(tabKey)) {
      return Promise.resolve()
    }
    const last = lastRefreshAt.get(tabKey)
    if (typeof last === 'number' && now() - last < minInterval) {
      return Promise.resolve()
    }
    lastRefreshAt.set(tabKey, now())
    return enqueue(() => refreshTab(tabKey))
  }

  /**
   * 모든 기록에 remove를 수행한다. 실패해도 계속하며 기록은 정리한다.
   * title은 런타임 제목 투영값이라 applied와 비교할 수 없으므로, 탭이 존재하면
   * 제목 비교 없이 rename(null)을 시도한다(사용자가 바꾼 제목도 해제될 수 있음, 한계).
   * @returns {Promise<void>}
   */
  function restoreAll() {
    return enqueue(async () => {
      for (const [tabKey, record] of [...records]) {
        try {
          const found = await readTab(record.worktreeId, record.tabId, null)
          if (found !== null) {
            await rpc.call(
              'terminal.rename',
              { terminal: record.handle, title: null },
              { timeoutMs: timeout },
            )
          }
        } catch {
          diagnose('restore_failed')
        } finally {
          records.delete(tabKey)
          wantByTab.delete(tabKey)
          lastRefreshAt.delete(tabKey)
          failures.delete(tabKey)
          clearRemoveFailure(tabKey)
        }
      }
      try {
        await persistRecords()
      } catch {
        diagnose('save_failed')
      }
    })
  }

  /**
   * 테스트/대시보드용 요약. 제목 문자열은 포함하지 않는다.
   * @returns {{tabs: number, disabledTabs: number}}
   */
  function snapshot() {
    return { tabs: records.size, disabledTabs: disabled.size }
  }

  return { load, reconcile, onTurnCompleted, restoreAll, snapshot }
}
