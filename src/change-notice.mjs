/**
 * 대시보드/터미널 CLI 변경 알림 문구 생성기 (작업 N).
 *
 * 대시보드 HTTP API `POST /api/action`과 터미널 CLI는 같은 `dispatch(action)` 경로를
 * 타므로, main.mjs가 dispatch 결과 스냅숏을 이 모듈에 넘겨 사람이 읽을 한 줄 알림을
 * 만든다. 팔레트 명령은 model을 직접 호출하고 자체 알림을 띄우므로 여기를 타지 않는다.
 *
 * 이 모듈은 순수 함수만 내보내며 I/O·타이머·파일 접근을 하지 않는다. 공개 스냅숏에
 * 없는 원시 worktreeId·토큰·경로는 결과에 절대 넣지 않는다: worktree 대상은 스냅숏의
 * `label`, `worktreeHash`(원시 id의 sha256 앞 16 hex), terminal은 `title`만 쓴다.
 *
 * @module change-notice
 */

import { createHash } from 'node:crypto'

/** 알림 본문 최대 길이(문자). main.mjs NOTIFICATION_BODY_MAX_CHARS와 같은 상한. */
const MAX_NOTICE_CHARS = 200

/** 전역 일시정지 중 켜기 시도에 덧붙이는 꼬리말. */
const PAUSED_SUFFIX = ' (전체 일시정지 중)'

/** label/title을 못 찾을 때의 대체 문구. 원시 식별자는 절대 노출하지 않는다. */
const FALLBACK_WORKTREE_LABEL = '워크트리'
const FALLBACK_TERMINAL_TITLE = '터미널'

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmptyStringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 원시 worktreeId의 스냅숏 식별용 해시(sha256 앞 16 hex). dashboard-model.mjs와 같은 방식.
 * @param {string} worktreeId
 * @returns {string}
 */
function worktreeHashOf(worktreeId) {
  return createHash('sha256').update(worktreeId, 'utf8').digest('hex').slice(0, 16)
}

/**
 * @param {unknown} snapshot
 * @returns {Array<object>}
 */
function worktreesOf(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.worktrees)) {
    return []
  }
  return snapshot.worktrees
}

/**
 * @param {Array<object>} worktrees
 * @param {unknown} targetId opaque worktree id
 * @returns {object|null}
 */
function findWorktreeByTargetId(worktrees, targetId) {
  const id = nonEmptyStringOrNull(targetId)
  if (id === null) {
    return null
  }
  return worktrees.find((worktree) => isPlainObject(worktree) && worktree.id === id) ?? null
}

/**
 * @param {Array<object>} worktrees
 * @param {unknown} rawWorktreeId 원시 Orca worktreeId
 * @returns {object|null}
 */
function findWorktreeByRawId(worktrees, rawWorktreeId) {
  const raw = nonEmptyStringOrNull(rawWorktreeId)
  if (raw === null) {
    return null
  }
  const hash = worktreeHashOf(raw)
  return worktrees.find((worktree) => isPlainObject(worktree) && worktree.worktreeHash === hash) ?? null
}

/**
 * @param {Array<object>} worktrees
 * @param {unknown} targetId opaque terminal id
 * @returns {{worktree: object, terminal: object}|null}
 */
function findTerminalByTargetId(worktrees, targetId) {
  const id = nonEmptyStringOrNull(targetId)
  if (id === null) {
    return null
  }
  for (const worktree of worktrees) {
    if (!isPlainObject(worktree) || !Array.isArray(worktree.terminals)) {
      continue
    }
    for (const terminal of worktree.terminals) {
      if (isPlainObject(terminal) && terminal.id === id) {
        return { worktree, terminal }
      }
    }
  }
  return null
}

/**
 * @param {object|null} worktree
 * @returns {string}
 */
function labelOf(worktree) {
  if (isPlainObject(worktree)) {
    const label = nonEmptyStringOrNull(worktree.label)
    if (label !== null) {
      return label
    }
  }
  return FALLBACK_WORKTREE_LABEL
}

/**
 * @param {object|null} terminal
 * @returns {string}
 */
function titleOf(terminal) {
  if (isPlainObject(terminal)) {
    const title = nonEmptyStringOrNull(terminal.title)
    if (title !== null) {
      return title
    }
  }
  return FALLBACK_TERMINAL_TITLE
}

/**
 * 전역 일시정지 여부. snapshot.config.paused === true일 때만 참.
 * @param {unknown} snapshot
 * @returns {boolean}
 */
function isGloballyPaused(snapshot) {
  return isPlainObject(snapshot) && isPlainObject(snapshot.config) && snapshot.config.paused === true
}

/**
 * base에 꼬리말을 붙인 뒤 200자 이하로 자른다. 꼬리말이 있으면 잘릴 때도 보존한다.
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function finalize(base, suffix) {
  const full = base + suffix
  if (full.length <= MAX_NOTICE_CHARS) {
    return full
  }
  if (suffix.length >= MAX_NOTICE_CHARS) {
    return suffix.slice(0, MAX_NOTICE_CHARS)
  }
  return base.slice(0, MAX_NOTICE_CHARS - suffix.length) + suffix
}

/**
 * 성공한 Action에 대한 사람이 읽을 한 줄 변경 알림을 만든다. 알릴 내용이 없으면 null.
 *
 * @param {unknown} action dispatch에 전달한 Action(원문 또는 검증된 형태).
 * @param {unknown} snapshot dispatch가 반환한 새 DashboardSnapshot.
 * @returns {string|null} 200자 이하 문구 또는 null(알림 없음).
 */
export function describeActionChange(action, snapshot) {
  if (!isPlainObject(action)) {
    return null
  }
  const type = action.type

  if (type === 'pause') {
    if (action.paused === true) {
      return finalize('모든 keepalive를 껐습니다(일시정지).', '')
    }
    if (action.paused === false) {
      return finalize('모든 keepalive를 켰습니다.', '')
    }
    return null
  }

  const worktrees = worktreesOf(snapshot)

  if (type === 'worktree' || type === 'worktree-orca') {
    const worktree =
      type === 'worktree'
        ? findWorktreeByTargetId(worktrees, action.targetId)
        : findWorktreeByRawId(worktrees, action.worktreeId)
    const label = labelOf(worktree)
    const enabled = action.enabled

    let base
    if (enabled === true) {
      base = `${label}: keepalive 켜짐`
    } else if (enabled === false) {
      base = `${label}: keepalive 꺼짐`
    } else if (enabled === null) {
      const current = isPlainObject(worktree) && worktree.effectiveEnabled === true ? '켜짐' : '꺼짐'
      base = `${label}: 기본값 사용 (현재 ${current})`
    } else {
      return null
    }

    // 전역 일시정지 중 켜기는 실제로 반영되지 않으므로 꼬리말로 알린다.
    const suffix = enabled === true && isGloballyPaused(snapshot) ? PAUSED_SUFFIX : ''
    return finalize(base, suffix)
  }

  if (type === 'terminal') {
    const found = findTerminalByTargetId(worktrees, action.targetId)
    const label = labelOf(found === null ? null : found.worktree)
    const title = titleOf(found === null ? null : found.terminal)
    const enabled = action.enabled

    let state
    if (enabled === true) {
      state = 'keepalive 켜짐'
    } else if (enabled === false) {
      state = 'keepalive 꺼짐'
    } else if (enabled === null) {
      const current = found !== null && found.terminal.effectiveEnabled === true ? '켜짐' : '꺼짐'
      state = `상속(현재 ${current})`
    } else {
      return null
    }

    const suffix = enabled === true && isGloballyPaused(snapshot) ? PAUSED_SUFFIX : ''
    return finalize(`${label} / ${title}: ${state}`, suffix)
  }

  // config / reset-budget / clear-review / 알 수 없는 type은 알리지 않는다.
  return null
}
