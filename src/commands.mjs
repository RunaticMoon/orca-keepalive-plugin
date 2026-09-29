/**
 * Orca 커맨드 5개를 controller 동작에 연결하는 얇은 어댑터와, 내장 브라우저에
 * 대시보드를 여는 헬퍼. DESIGN.md §7.1, §7.2, §4.3의 M 작업을 구현한다.
 *
 * 이 모듈은 정책/상태머신/RPC transport를 구현하지 않는다. controller(호출자가
 * 주입)에 동작을 위임하고 `rpc.call('browser.tabCreate')` 한 번만 직접 호출한다.
 * 등록 시점에는 I/O를 하지 않으며, 모든 handler는 예외를 삼키고 정상 종료한다.
 * URL은 실패 알림에서만 노출하고 reason/로그에는 넣지 않는다.
 *
 * @module commands
 */

/**
 * Orca manifest `contributes.commands`의 id. §7.2.
 * @type {Readonly<{open:string, toggleWorktree:string, pause:string, resume:string, status:string}>}
 */
export const COMMAND_IDS = Object.freeze({
  open: 'keepalive-open',
  toggleWorktree: 'keepalive-toggle-worktree',
  pause: 'keepalive-pause',
  resume: 'keepalive-resume',
  status: 'keepalive-status',
})

/** 알림 제목(고정). */
const NOTIFICATION_TITLE = 'Cache Keepalive'

/** browser.tabCreate 단일 호출 deadline(ms). §4.3. */
const BROWSER_CALL_TIMEOUT_MS = 10000

/** 기본 handler 전체 deadline(ms). Orca 커맨드 제한 30초 안에 끝내기 위함. */
const DEFAULT_HANDLER_TIMEOUT_MS = 25000

/** reason/오류 코드로 반영해도 안전한 값의 형식. */
const SAFE_CODE_RE = /^[a-z_]{1,40}$/

/** 대시보드를 열지 못했을 때의 실패 reason 코드. */
const BROWSER_UNAVAILABLE = 'browser_unavailable'

/**
 * error에서 안전한 코드 문자열만 뽑는다. 형식에 맞지 않거나 없으면 'internal'.
 * @param {unknown} error
 * @returns {string}
 */
function safeCode(error) {
  if (error !== null && typeof error === 'object') {
    const code = /** @type {Record<string, unknown>} */ (error).code
    if (typeof code === 'string' && SAFE_CODE_RE.test(code)) {
      return code
    }
  }
  return 'internal'
}

/**
 * browser.tabCreate 결과가 성공(페이지 생성)을 나타내는지 확인한다.
 * @param {unknown} result
 * @returns {boolean}
 */
function hasBrowserPageId(result) {
  if (result === null || typeof result !== 'object') {
    return false
  }
  const id = /** @type {Record<string, unknown>} */ (result).browserPageId
  return typeof id === 'string' && id.length > 0
}

/**
 * Orca 내장 브라우저에 URL을 연다. §4.3 browser.tabCreate 행.
 *
 * `placement:{kind:'server'}`는 현재 desktop 런타임의 브라우저를, `navigation:'host'`는
 * host 화면에서의 이동을 뜻한다(서로 다른 필드). local worktreeId가 확인된 경우에만
 * `worktree:'id:'+worktreeId`를 덧붙인다. 실패/예외는 재시도하지 않고(탭 중복 방지)
 * opened=false, reason='browser_unavailable'로 보고한다. url은 reason에 넣지 않는다.
 *
 * @param {Object} options
 * @param {{ call: (method: string, params: unknown, options?: {signal?: AbortSignal, timeoutMs?: number}) => Promise<unknown> }} options.rpc
 * @param {string} options.url
 * @param {string|null} [options.worktreeId]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ opened: boolean, reason: string|null }>}
 */
export async function openInOrcaBrowser({ rpc, url, worktreeId = null, signal } = {}) {
  /** @type {Record<string, unknown>} */
  const params = {
    url,
    activate: true,
    navigation: 'host',
    waitForRegistration: false,
    placement: { kind: 'server' },
  }
  if (worktreeId) {
    params.worktree = 'id:' + worktreeId
  }

  try {
    const result = await rpc.call('browser.tabCreate', params, {
      signal,
      timeoutMs: BROWSER_CALL_TIMEOUT_MS,
    })
    if (hasBrowserPageId(result)) {
      return { opened: true, reason: null }
    }
    return { opened: false, reason: BROWSER_UNAVAILABLE }
  } catch {
    // 실패 원인을 노출하거나 재시도하지 않는다. 탭 중복 생성을 피한다.
    return { opened: false, reason: BROWSER_UNAVAILABLE }
  }
}

/**
 * controller 동작에 연결된 커맨드 handler를 만든다(등록은 registerCommands가 한다).
 *
 * @param {Object} options
 * @param {() => Promise<void>} options.notifySafe 실패를 삼킨 알림 함수.
 * @param {number} options.timeoutMs handler 전체 deadline(ms).
 * @param {Object} options.controller
 * @returns {Record<string, () => Promise<void>>}
 */
function createHandlers({ notifySafe, timeoutMs, controller }) {
  /**
   * handler 본문을 deadline 안에서 실행하고, 예외/타임아웃은 알림 후 정상 종료한다.
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  async function withGuard(work) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    const workPromise = Promise.resolve().then(work)
    // race에서 진 work의 늦은 rejection이 unhandled가 되지 않게 한다.
    workPromise.catch(() => {})
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('command timed out')
        error.code = 'command_timeout'
        reject(error)
      }, timeoutMs)
    })
    try {
      await Promise.race([workPromise, timeoutPromise])
    } catch (error) {
      await notifySafe(NOTIFICATION_TITLE, '명령 실패: ' + safeCode(error))
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }

  return {
    /** 대시보드 열기. 성공하면 조용히 종료하고, 실패하면 이때만 URL을 알린다. */
    [COMMAND_IDS.open]: () =>
      withGuard(async () => {
        const { url } = await controller.ensureDashboard()
        const { opened } = await controller.openDashboard(url)
        if (opened) {
          return
        }
        await notifySafe(
          NOTIFICATION_TITLE,
          '대시보드를 Orca 브라우저에서 열지 못했습니다. 브라우저에서 다음 주소를 여세요: ' + url,
        )
      }),

    /** 현재 워크트리 on/off. worktreeId를 특정할 수 없으면 변경하지 않는다. */
    [COMMAND_IDS.toggleWorktree]: () =>
      withGuard(async () => {
        const worktreeId = await controller.currentWorktreeId()
        if (worktreeId === null || worktreeId === undefined) {
          await notifySafe(
            NOTIFICATION_TITLE,
            '현재 워크트리를 특정할 수 없습니다. 대시보드에서 선택하세요.',
          )
          return
        }
        const result = await controller.toggleWorktree(worktreeId)
        await notifySafe(
          NOTIFICATION_TITLE,
          `${result.label ?? '현재 워크트리'}: keepalive ${result.enabled ? '켜짐' : '꺼짐'}`,
        )
      }),

    /** 전역 일시정지(멱등). */
    [COMMAND_IDS.pause]: () =>
      withGuard(async () => {
        await controller.setPaused(true)
        await notifySafe(NOTIFICATION_TITLE, '모든 keepalive를 일시정지했습니다.')
      }),

    /** 전역 재개(멱등). budget/앱 timer off를 무시하지 않는다. */
    [COMMAND_IDS.resume]: () =>
      withGuard(async () => {
        await controller.setPaused(false)
        await notifySafe(
          NOTIFICATION_TITLE,
          'keepalive를 재개했습니다. (Orca 프롬프트 캐시 타이머 설정과 상한은 그대로 적용됩니다)',
        )
      }),

    /** 상태 요약 알림. 토큰/원시 화면 없음. */
    [COMMAND_IDS.status]: () =>
      withGuard(async () => {
        const { text } = await controller.statusSummary()
        await notifySafe(NOTIFICATION_TITLE, text)
      }),
  }
}

/**
 * Orca 커맨드 5개를 정확히 1회 등록한다. 등록 시점에는 어떤 I/O도 하지 않는다.
 *
 * notify는 실패를 삼킨다: 알림 오류가 handler를 실패로 만들지 않는다.
 *
 * @param {Object} options
 * @param {{ commands: { register: (id: string, handler: () => unknown) => void } }} options.orca
 * @param {Object} options.controller
 * @param {(title: string, body?: string) => Promise<void>|void} options.notify
 * @param {number} [options.timeoutMs] handler 전체 deadline(ms). 기본 25000.
 * @returns {void}
 */
export function registerCommands({ orca, controller, notify, timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS }) {
  /**
   * 알림 실패를 삼키는 wrapper.
   * @param {string} title
   * @param {string} [body]
   * @returns {Promise<void>}
   */
  async function notifySafe(title, body) {
    try {
      await notify(title, body)
    } catch {
      // 알림 실패는 무시한다.
    }
  }

  const handlers = createHandlers({ notifySafe, timeoutMs, controller })
  for (const id of Object.values(COMMAND_IDS)) {
    orca.commands.register(id, handlers[id])
  }
}
