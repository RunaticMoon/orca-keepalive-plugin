/**
 * 캐시 상태 projection(§2-1, §2-2).
 *
 * 한 target의 scheduler state와 표시 전용 관측 이력(§2-3)을 받아 대시보드 terminal과
 * 탭 제목 표시기가 **같은 값**을 쓰도록 cacheState/cacheStatus/시각 필드를 계산한다.
 * 순수 함수다: 시계·파일·네트워크·난수를 쓰지 않고 모든 시각을 입력으로 받는다.
 * 실제 Anthropic 캐시 적중 여부나 전송 허용을 판정하지 않는다(§2-1). review만의
 * 표시 gate 예외(§2-2)는 coordinator가 담당하고, 이 모듈은 상태 문자열만 만든다.
 *
 * @module cache-status
 */

import { normalizeBlockReason } from './cache-history.mjs'

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 한 target의 cacheState/cacheStatus와 시각 필드를 계산한다(§2-1 표).
 *
 * 규칙 우선순위:
 * 1. needsReview(영속 budget) 또는 phase==='NEEDS_REVIEW' → review/review.
 * 2. BUSY → kept/working. 작업 완료 전에는 만료 시각을 표시하지 않는다(expiresAt=null).
 * 3. ARMED/CHECKING + 유효 epoch + 예상 만료 전 → kept/scheduled.
 * 4. PASTING/SUBMITTING + 유효 attempt + 예상 만료 전 → kept/sending.
 *    AWAITING_TURN + 유효 attempt + 예상 만료 전 → kept/awaiting-turn.
 * 5. 알려진 만료 시각이 실제로 지났거나 이력이 만료 확정됐으면 none/expired,
 *    expireCause=마지막 차단 reason.
 * 6. SUSPENDED + INTERACTIVE_WAIT → none/interactive-wait, 그 밖의 SUSPENDED → none/suspended.
 * 7. 나머지(초기 UNKNOWN, 실제 만료 전 10초 cutoff 구간, 이력 없음) → none/no-reservation.
 *    cutoff 구간에서는 known expiresAt을 그대로 내보내 UI가 "안전 전송 시간이 지남 ·
 *    만료 예정"을 표시할 수 있게 한다(expiredAt=null).
 *
 * `expiresAt`은 이력이 있으면 이력의 값을 예약 취소 후에도 유지한다.
 * `blockedReason`은 이력의 마지막 차단 reason(만료 전 포함)이다.
 *
 * @param {{
 *   state: any,
 *   history: import('./contracts.mjs').CacheHistory|null,
 *   now: number,
 *   needsReview?: boolean,
 *   dueAt?: number|null,
 * }} input
 * @returns {{
 *   cacheState: 'kept'|'none'|'review',
 *   cacheStatus: 'working'|'scheduled'|'sending'|'awaiting-turn'|'expired'|'no-reservation'|'interactive-wait'|'suspended'|'review',
 *   expiresAt: number|null,
 *   expiredAt: number|null,
 *   expireCause: string|null,
 *   blockedReason: string|null,
 * }}
 */
export function projectCacheStatus({ state, history, now, needsReview } = /** @type {any} */ ({})) {
  const phase = isObject(state) && typeof state.phase === 'string' ? state.phase : null
  const reason = isObject(state) && typeof state.reason === 'string' ? state.reason : null
  const epoch = isObject(state) ? state.epoch : null
  const attempt = isObject(state) ? state.attempt : null

  const hasHistory = isObject(history)
  const historyExpiresAt = hasHistory && isFiniteNumber(history.expiresAt) ? history.expiresAt : null
  const historyExpiredAt = hasHistory && isFiniteNumber(history.expiredAt) ? history.expiredAt : null
  const blockedReason = hasHistory ? normalizeBlockReason(history.lastBlockReason) : null

  const nowMs = isFiniteNumber(now) ? now : 0
  const epochValid = isObject(epoch) && isFiniteNumber(epoch.id)
  const pastKnownExpiry = historyExpiresAt !== null && nowMs >= historyExpiresAt
  // 실제 만료: 이력이 만료 확정됐거나 알려진 expiresAt이 실제로 지났을 때만 표시한다.
  // 10초 조기 EXPIRE(cutoff)는 여기서 만료로 취급하지 않는다(§2-3).
  const expired = historyExpiredAt !== null || pastKnownExpiry
  const expiredAt = historyExpiredAt !== null ? historyExpiredAt : pastKnownExpiry ? historyExpiresAt : null
  const expiresAt = historyExpiresAt

  // 1. 검토 필요가 항상 우선한다.
  if (needsReview === true || phase === 'NEEDS_REVIEW') {
    return {
      cacheState: 'review',
      cacheStatus: 'review',
      expiresAt,
      expiredAt,
      expireCause: null,
      blockedReason,
    }
  }

  // 2. 작업 진행 중: 완료 전에는 만료 시각을 표시하지 않는다.
  if (phase === 'BUSY') {
    return {
      cacheState: 'kept',
      cacheStatus: 'working',
      expiresAt: null,
      expiredAt: null,
      expireCause: null,
      blockedReason,
    }
  }

  // 3. 실행 가능한 예약이 살아 있다.
  if ((phase === 'ARMED' || phase === 'CHECKING') && epochValid && !expired) {
    return {
      cacheState: 'kept',
      cacheStatus: 'scheduled',
      expiresAt,
      expiredAt: null,
      expireCause: null,
      blockedReason,
    }
  }

  // 4. 전송 중/응답 대기: 유효 attempt가 있고 예상 만료 전이면 유지 중이다.
  if (!expired && isObject(attempt)) {
    if (phase === 'PASTING' || phase === 'SUBMITTING') {
      return {
        cacheState: 'kept',
        cacheStatus: 'sending',
        expiresAt,
        expiredAt: null,
        expireCause: null,
        blockedReason,
      }
    }
    if (phase === 'AWAITING_TURN') {
      return {
        cacheState: 'kept',
        cacheStatus: 'awaiting-turn',
        expiresAt,
        expiredAt: null,
        expireCause: null,
        blockedReason,
      }
    }
  }

  // 5. 실제 만료: 마지막 차단 reason을 원인으로 전달한다.
  if (expired) {
    return {
      cacheState: 'none',
      cacheStatus: 'expired',
      expiresAt,
      expiredAt,
      expireCause: blockedReason,
      blockedReason,
    }
  }

  // 6. 유지 중단(예약 폐기). INTERACTIVE_WAIT는 만료로 표현하지 않는다.
  if (phase === 'SUSPENDED') {
    return {
      cacheState: 'none',
      cacheStatus: reason === 'INTERACTIVE_WAIT' ? 'interactive-wait' : 'suspended',
      expiresAt,
      expiredAt: null,
      expireCause: null,
      blockedReason,
    }
  }

  // 7. 초기 UNKNOWN · 실제 만료 전 cutoff 구간 · 이력 없음.
  return {
    cacheState: 'none',
    cacheStatus: 'no-reservation',
    expiresAt,
    expiredAt: null,
    expireCause: null,
    blockedReason,
  }
}
