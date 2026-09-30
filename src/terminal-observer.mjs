/**
 * Orca runtime RPC 응답을 검증된 Catalog/Target/Observation으로 변환하는 읽기 전용
 * 어댑터. DESIGN.md §4.3, §5.1, §5.5(읽기 부분), §6의 H 작업을 구현한다.
 *
 * 이 모듈은 전송/paste/Enter/상태머신/주기 polling을 하지 않는다. RPC 호출도 하지
 * 않고 주입된 `rpc`/`hostCall`만 사용한다. import 시 부작용이 없으며, `draft` 원문은
 * Observation에만 담고 로그/에러/예외 메시지에 넣지 않는다.
 *
 * @module terminal-observer
 */

import { REASON_CODES } from './contracts.mjs'

/**
 * terminal.list의 정규화된 row. §4.3 terminal.list 결과의 부분집합.
 * preview/worktreePath 등 전송에 쓰지 않는 필드는 버린다.
 * @typedef {Object} TerminalRow
 * @property {string} handle RPC handle.
 * @property {string} worktreeId
 * @property {string} tabId
 * @property {string} leafId
 * @property {string} paneKey `${tabId}:${leafId}`.
 * @property {string|null} ptyId
 * @property {string|null} incarnationId
 * @property {string|null} title 최대 200자로 자른 값.
 * @property {string|null} branch 원시 branch ref.
 * @property {string|null} branchName 표시용 짧은 branch 이름(`refs/heads/` 제거).
 * @property {string|null} projectName worktreePath의 마지막 경로 요소(전체 경로 미노출).
 * @property {boolean} connected
 * @property {boolean} writable
 * @property {number|null} lastOutputAt
 * @property {string|null} agentIdentity
 * @property {string|null} executionHostId
 * @property {boolean} supported
 * @property {string|null} unsupportedReason supported=false일 때의 reason 코드.
 */

/**
 * terminal.list 결과를 검증해 만든 목록. complete=false면 자동 전송 판단에 쓰지 않는다.
 * @typedef {Object} Catalog
 * @property {boolean} complete truncated=false이고 모든 row 형식이 정상일 때만 true.
 * @property {number} fetchedAt now() 시각(ms).
 * @property {TerminalRow[]} terminals
 */

/**
 * 이벤트에서 정확히 join된 전송 후보.
 * @typedef {Object} Target
 * @property {string} worktreeId
 * @property {string} paneKey
 * @property {string} handle
 * @property {string|null} ptyId
 * @property {string|null} incarnationId
 */

/**
 * 한 target에 대한 읽기 전용 관측 결과. 실패/미평가 필드는 unknown으로 유지한다.
 * @typedef {Object} Observation
 * @property {Target} target
 * @property {number} observedAt
 * @property {string|null} identity
 * @property {string|null} executionHostId
 * @property {boolean} connected
 * @property {boolean} writable
 * @property {string|null} ptyId
 * @property {string|null} incarnationId
 * @property {number|null} lastOutputAt
 * @property {'idle'|'working'|'permission'|'unknown'} agentStatus
 * @property {boolean|null} isRunningAgent
 * @property {'none'|'waiting'|'unknown'} agentWait
 * @property {'ok'|'unknown'} screen
 * @property {boolean|null} screenTruncated
 * @property {string|null} draft 비어 있으면 null. 공개 snapshot/로그에 넣지 않는다.
 * @property {boolean} stale
 * @property {string|null} reason reason 코드(정보용).
 */

const MAX_TITLE_LENGTH = 200
const TERMINAL_LIST_LIMIT = 1000
const READ_LIMIT = 200

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 비어 있지 않은 문자열만 통과시키고 그 외에는 null을 반환한다.
 * @param {unknown} value
 * @returns {string|null}
 */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 유한한 number만 통과시키고 그 외에는 null을 반환한다.
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * worktreePath에서 마지막 경로 요소(프로젝트 이름)만 뽑는다. `/`와 `\`를 모두
 * 구분자로 보고 끝 구분자는 무시한다. 경로가 없거나 이름이 비면 null이다.
 * 원시 전체 경로는 반환/저장하지 않는다.
 * @param {unknown} worktreePath
 * @returns {string|null}
 */
export function projectNameFromPath(worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return null
  }
  const segments = worktreePath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return null
  }
  return segments[segments.length - 1]
}

/**
 * branch ref에서 짧은 branch/태그 이름을 뽑는다. `refs/` 접두어가 있으면 `refs/`와
 * 그 뒤 첫 구성요소(헤드 종류/remote)를 떼고 나머지를 쓴다(예: `refs/heads/main` →
 * `main`, `refs/remotes/origin/x` → `origin/x`, `refs/tags/v1` → `v1`). 나머지가
 * 비면 null이다. `refs/` 접두어가 없으면 원문을 쓰고, 비어 있으면 null이다.
 * @param {unknown} branch
 * @returns {string|null}
 */
export function branchNameFromRef(branch) {
  const value = stringOrNull(branch)
  if (value === null) {
    return null
  }
  const prefix = 'refs/'
  if (!value.startsWith(prefix)) {
    return value
  }
  const parts = value.slice(prefix.length).split('/')
  // `refs/heads/feature/x`처럼 첫 구성요소 뒤에 여러 단계가 남을 수 있다.
  const name = parts.slice(1).join('/')
  return name.length > 0 ? name : null
}

/**
 * row의 지원 여부와 unsupportedReason을 계산한다. §5.1.
 * @param {{agentIdentity:string|null, executionHostId:string|null, connected:boolean, writable:boolean, ptyId:string|null}} row
 * @returns {string|null} 지원되면 null, 아니면 reason 코드.
 */
function computeUnsupportedReason(row) {
  if (row.agentIdentity !== 'claude') {
    return REASON_CODES.UNSUPPORTED_AGENT
  }
  if (row.executionHostId !== 'local') {
    return REASON_CODES.UNSUPPORTED_HOST
  }
  if (!row.connected || !row.writable || row.ptyId === null) {
    return REASON_CODES.NOT_CONNECTED
  }
  return null
}

/**
 * RuntimeTerminalSummary 하나를 TerminalRow로 변환한다. handle/worktreeId/tabId/leafId/
 * connected/writable이 형식에 맞지 않으면 null을 반환해 목록에서 제외한다.
 * @param {unknown} raw
 * @returns {TerminalRow|null}
 */
function parseRow(raw) {
  if (!isObject(raw)) {
    return null
  }

  const handle = stringOrNull(raw.handle)
  const worktreeId = stringOrNull(raw.worktreeId)
  const tabId = stringOrNull(raw.tabId)
  const leafId = stringOrNull(raw.leafId)
  if (handle === null || worktreeId === null || tabId === null || leafId === null) {
    return null
  }
  if (typeof raw.connected !== 'boolean' || typeof raw.writable !== 'boolean') {
    return null
  }

  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE_LENGTH) : null
  const ptyId = stringOrNull(raw.ptyId)
  const incarnationId = stringOrNull(raw.incarnationId)
  const row = {
    handle,
    worktreeId,
    tabId,
    leafId,
    paneKey: `${tabId}:${leafId}`,
    ptyId,
    incarnationId,
    title,
    branch: stringOrNull(raw.branch),
    branchName: branchNameFromRef(raw.branch),
    projectName: projectNameFromPath(raw.worktreePath),
    connected: raw.connected,
    writable: raw.writable,
    lastOutputAt: finiteNumberOrNull(raw.lastOutputAt),
    agentIdentity: stringOrNull(raw.agentIdentity),
    executionHostId: stringOrNull(raw.executionHostId),
    supported: false,
    unsupportedReason: null,
  }
  const unsupportedReason = computeUnsupportedReason(row)
  row.unsupportedReason = unsupportedReason
  row.supported = unsupportedReason === null
  return row
}

/**
 * show 결과에서 agentWait를 판정한다. 키가 없으면 미평가(unknown)다. §4.3, S15.
 * @param {Record<string, unknown>} show
 * @returns {'none'|'waiting'|'unknown'}
 */
function parseAgentWait(show) {
  if (!Object.prototype.hasOwnProperty.call(show, 'agentWait')) {
    return 'unknown'
  }
  const value = show.agentWait
  if (value === null) {
    return 'none'
  }
  if (isObject(value)) {
    return 'waiting'
  }
  return 'unknown'
}

/**
 * read 결과에서 draft를 판정한다. 문자열이면 그대로(빈 문자열은 null) 쓴다.
 * @param {Record<string, unknown>} read
 * @returns {string|null}
 */
function parseDraft(read) {
  return typeof read.draft === 'string' && read.draft.length > 0 ? read.draft : null
}

/**
 * RpcError를 reason 코드로 대표화한다. abort는 호출부에서 먼저 rethrow한다.
 * @param {unknown} error
 * @returns {string}
 */
function reasonForError(error) {
  const code = isObject(error) ? error.code : undefined
  if (code === 'runtime_mismatch') {
    return REASON_CODES.WRONG_RUNTIME
  }
  return REASON_CODES.RUNTIME_UNAVAILABLE
}

/**
 * signal abort로 인한 오류인지 확인한다.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  const code = isObject(error) ? error.code : undefined
  const name = isObject(error) ? error.name : undefined
  return code === 'aborted' || name === 'AbortError'
}

/**
 * Observation에서 정보용 reason 코드를 우선순위대로 산출한다.
 * @param {Observation} observation
 * @param {string|null} failure
 * @returns {string|null}
 */
function computeReason(observation, failure) {
  if (observation.stale) {
    return REASON_CODES.STALE_TARGET
  }
  if (failure !== null) {
    return failure
  }
  if (observation.identity !== 'claude') {
    return REASON_CODES.UNSUPPORTED_AGENT
  }
  if (observation.executionHostId !== 'local') {
    return REASON_CODES.UNSUPPORTED_HOST
  }
  if (!observation.connected || !observation.writable) {
    return REASON_CODES.NOT_CONNECTED
  }
  if (observation.agentStatus === 'working') {
    return REASON_CODES.BUSY
  }
  if (observation.agentStatus === 'permission' || observation.agentWait === 'waiting') {
    return REASON_CODES.INTERACTIVE_WAIT
  }
  if (observation.agentWait === 'unknown' || observation.agentStatus === 'unknown') {
    return REASON_CODES.UNKNOWN_WAIT
  }
  if (observation.screen !== 'ok') {
    return REASON_CODES.SCREEN_UNKNOWN
  }
  if (observation.draft !== null) {
    return REASON_CODES.DRAFT_PRESENT
  }
  return null
}

/**
 * show 결과가 target과 같은 터미널 incarnation을 가리키는지 확인한다.
 * handle/ptyId/worktreeId는 항상, incarnationId는 양쪽 다 있을 때만 비교한다.
 * @param {{handle:string|null, worktreeId:string|null, ptyId:string|null, incarnationId:string|null}} shown
 * @param {Target} target
 * @returns {boolean}
 */
function isStale(shown, target) {
  if (shown.handle !== target.handle) {
    return true
  }
  if (shown.worktreeId !== target.worktreeId) {
    return true
  }
  if (shown.ptyId !== target.ptyId) {
    return true
  }
  if (
    target.incarnationId !== null &&
    shown.incarnationId !== null &&
    shown.incarnationId !== target.incarnationId
  ) {
    return true
  }
  return false
}

/**
 * 읽기 전용 터미널 관측 어댑터를 만든다.
 *
 * @param {Object} options
 * @param {{ call: (method: string, params: unknown, options?: {signal?: AbortSignal}) => Promise<unknown> }} options.rpc
 * @param {(method: string, params?: unknown) => Promise<unknown>} options.hostCall
 * @param {() => number} [options.now]
 * @returns {{
 *   list: (options?: {signal?: AbortSignal}) => Promise<Catalog>,
 *   resolveEvent: (event: unknown, catalog: Catalog) => Target|null,
 *   inspect: (target: Target, options?: {signal?: AbortSignal}) => Promise<Observation>,
 *   currentWorktree: (catalog: Catalog) => Promise<string|null>,
 * }}
 */
export function createObserver({ rpc, hostCall, now = Date.now }) {
  /**
   * terminal.list를 호출해 Catalog를 만든다. 전송 오류는 그대로 던지고, 성공했지만
   * 형식이 비정상이거나 row가 잘못된 경우 complete=false로 표시한다.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Catalog>}
   */
  async function list({ signal } = {}) {
    const result = await rpc.call(
      'terminal.list',
      { limit: TERMINAL_LIST_LIMIT, includeVisualLayouts: false, requireFreshPtyLiveness: true },
      signal ? { signal } : {},
    )

    /** @type {TerminalRow[]} */
    const terminals = []
    let complete = true

    if (!isObject(result)) {
      complete = false
    } else {
      if (result.truncated !== false) {
        complete = false
      }
      const rawTerminals = result.terminals
      if (!Array.isArray(rawTerminals)) {
        complete = false
      } else {
        for (const raw of rawTerminals) {
          const row = parseRow(raw)
          if (row === null) {
            complete = false
            continue
          }
          terminals.push(row)
        }
      }
    }

    return { complete, fetchedAt: now(), terminals }
  }

  /**
   * agent.status.changed payload를 catalog에서 worktreeId와 paneKey가 정확히 일치하는
   * 유일한 row로 매핑한다. 추측/split 없이 정확 일치만 사용한다.
   * @param {unknown} event payload 또는 그 payload를 감싼 객체.
   * @param {Catalog} catalog
   * @returns {Target|null}
   */
  function resolveEvent(event, catalog) {
    if (!isObject(event) || !isObject(catalog) || !Array.isArray(catalog.terminals)) {
      return null
    }

    const payload = isObject(event.payload) ? event.payload : event
    const worktreeId = payload.worktreeId
    const paneKey = payload.paneKey
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      return null
    }
    if (typeof paneKey !== 'string' || paneKey.length === 0) {
      return null
    }

    const matches = catalog.terminals.filter(
      (row) => row.worktreeId === worktreeId && row.paneKey === paneKey,
    )
    if (matches.length !== 1) {
      return null
    }

    const row = matches[0]
    return {
      worktreeId: row.worktreeId,
      paneKey: row.paneKey,
      handle: row.handle,
      ptyId: row.ptyId,
      incarnationId: row.incarnationId,
    }
  }

  /**
   * target에 대해 show → agentStatus → read를 순서대로 읽기만 한다. 각 호출 실패는
   * 해당 필드를 unknown으로 두고 reason에 대표 코드를 남긴다. signal abort만 rethrow한다.
   * @param {Target} target
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Observation>}
   */
  async function inspect(target, { signal } = {}) {
    const callOptions = signal ? { signal } : {}
    const handle = target.handle
    const requestBase =
      target.incarnationId !== null && target.incarnationId !== undefined
        ? { terminal: handle, expectedIncarnationId: target.incarnationId }
        : { terminal: handle }

    /** @type {string|null} */
    let failure = null
    const noteFailure = (error) => {
      if (isAbortError(error)) {
        throw error
      }
      if (failure === null) {
        failure = reasonForError(error)
      }
    }

    // 1) terminal.show → summary + agentWait
    /** @type {Record<string, unknown>|null} */
    let show = null
    try {
      const result = await rpc.call('terminal.show', requestBase, callOptions)
      if (isObject(result) && isObject(result.terminal)) {
        show = result.terminal
      } else {
        noteFailure(new Error('malformed terminal.show result'))
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      noteFailure(error)
    }

    const shown = {
      handle: show === null ? null : stringOrNull(show.handle),
      worktreeId: show === null ? null : stringOrNull(show.worktreeId),
      ptyId: show === null ? null : stringOrNull(show.ptyId),
      incarnationId: show === null ? null : stringOrNull(show.incarnationId),
    }
    const identity = show === null ? null : stringOrNull(show.agentIdentity)
    const executionHostId = show === null ? null : stringOrNull(show.executionHostId)
    const connected = show !== null && typeof show.connected === 'boolean' ? show.connected : false
    const writable = show !== null && typeof show.writable === 'boolean' ? show.writable : false
    const lastOutputAt = show === null ? null : finiteNumberOrNull(show.lastOutputAt)
    const agentWait = show === null ? 'unknown' : parseAgentWait(show)
    const stale = show !== null && isStale(shown, target)

    // 2) terminal.agentStatus
    let agentStatus = 'unknown'
    /** @type {boolean|null} */
    let isRunningAgent = null
    try {
      const result = await rpc.call('terminal.agentStatus', requestBase, callOptions)
      if (isObject(result) && isObject(result.agentStatus)) {
        const status = result.agentStatus.status
        if (status === 'idle' || status === 'working' || status === 'permission') {
          agentStatus = status
        }
        if (typeof result.agentStatus.isRunningAgent === 'boolean') {
          isRunningAgent = result.agentStatus.isRunningAgent
        }
      } else {
        noteFailure(new Error('malformed terminal.agentStatus result'))
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      noteFailure(error)
    }

    // 3) terminal.read {screen:true}
    let screen = 'unknown'
    /** @type {boolean|null} */
    let screenTruncated = null
    /** @type {string|null} */
    let draft = null
    try {
      const result = await rpc.call(
        'terminal.read',
        { ...requestBase, screen: true, limit: READ_LIMIT },
        callOptions,
      )
      if (isObject(result) && isObject(result.terminal)) {
        const read = result.terminal
        if (read.source === 'screen' && read.status === 'running') {
          screen = 'ok'
        }
        if (typeof read.truncated === 'boolean') {
          screenTruncated = read.truncated
        }
        draft = parseDraft(read)
      } else {
        noteFailure(new Error('malformed terminal.read result'))
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      noteFailure(error)
    }

    /** @type {Observation} */
    const observation = {
      target,
      observedAt: now(),
      identity,
      executionHostId,
      connected,
      writable,
      ptyId: shown.ptyId,
      incarnationId: shown.incarnationId,
      lastOutputAt,
      agentStatus,
      isRunningAgent,
      agentWait,
      screen,
      screenTruncated,
      draft,
      stale,
      reason: null,
    }
    observation.reason = computeReason(observation, failure)
    return observation
  }

  /**
   * workspace.readContext가 돌려준 terminal handle들을 catalog와 join해 현재
   * worktreeId를 정확히 하나로 특정할 때만 반환한다. catalog가 complete가 아니거나
   * hostCall이 실패하면 null이다. branch/displayName으로 매칭하지 않는다.
   * @param {Catalog} catalog
   * @returns {Promise<string|null>}
   */
  async function currentWorktree(catalog) {
    if (!isObject(catalog) || catalog.complete !== true) {
      return null
    }
    if (!Array.isArray(catalog.terminals) || catalog.terminals.length === 0) {
      return null
    }

    let context
    try {
      context = await hostCall('workspace.readContext')
    } catch {
      return null
    }
    if (!isObject(context) || !Array.isArray(context.terminals) || context.terminals.length === 0) {
      return null
    }

    const contextIds = new Set()
    for (const terminal of context.terminals) {
      if (isObject(terminal)) {
        const id = stringOrNull(terminal.id)
        if (id !== null) {
          contextIds.add(id)
        }
      }
    }

    const worktreeIds = new Set()
    for (const row of catalog.terminals) {
      if (contextIds.has(row.handle)) {
        worktreeIds.add(row.worktreeId)
      }
    }

    return worktreeIds.size === 1 ? [...worktreeIds][0] : null
  }

  return { list, resolveEvent, inspect, currentWorktree }
}
