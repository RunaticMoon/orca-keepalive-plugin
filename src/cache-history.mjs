/**
 * 캐시 관측 이력의 순수 reducer(§2-3).
 *
 * scheduler의 전송 예약 epoch와 **독립**이다: 이 모듈은 표시·만료 이력만 다루고
 * 전송 여부나 예약을 결정하지 않는다. 부작용이 없다: 시계·타이머·난수·파일·
 * 네트워크를 쓰지 않고 모든 시각을 입력으로 받는다. 입력 history는 절대 변경하지
 * 않고 매번 새 객체(또는 같은 참조/null)를 반환한다.
 *
 * 반환 규약:
 * - 의미 있는 변화가 없으면 **입력과 같은 참조**를 그대로 돌려준다(호출자가 저장
 *   변경 없음을 알 수 있다).
 * - 알 수 없는 이벤트·불량 입력은 기존 이력을 그대로 돌려준다. throw하지 않는다.
 * - 이력이 필요 없어지면 null을 돌려준다.
 *
 * @module cache-history
 */

import { CACHE_HISTORY_RETENTION_MS, EXPIRE_CAUSE_REASONS } from './contracts.mjs';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 차단 reason을 만료 원인 allowlist(EXPIRE_CAUSE_REASONS)로 정규화한다.
 * 허용 목록 밖의 값(EXPIRED/NO_FRESH_TURN/임의 문자열/null 포함)은 null이 된다.
 * @param {unknown} reason
 * @returns {string|null}
 */
export function normalizeBlockReason(reason) {
  return EXPIRE_CAUSE_REASONS.includes(reason) ? reason : null;
}

/**
 * 이력이 이미 만료 확정됐는지 돌려준다(expiredAt !== null).
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @returns {boolean}
 */
export function isCacheHistoryExpired(history) {
  return (
    history !== null &&
    typeof history === 'object' &&
    history.expiredAt !== null &&
    history.expiredAt !== undefined
  );
}

/**
 * OPEN: 인정된 새 epoch의 이력으로 교체한다. 이전 이력과 마지막 차단 원인을
 * 초기화한다. 네 시각·id 중 하나라도 유한수가 아니면 이력을 바꾸지 않는다.
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @param {{epochId:number, doneAt:number, basisAt:number, expiresAt:number}} event
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
function reduceOpen(history, event) {
  if (
    !isFiniteNumber(event.epochId) ||
    !isFiniteNumber(event.doneAt) ||
    !isFiniteNumber(event.basisAt) ||
    !isFiniteNumber(event.expiresAt)
  ) {
    return history;
  }
  return {
    epochId: event.epochId,
    doneAt: event.doneAt,
    basisAt: event.basisAt,
    expiresAt: event.expiresAt,
    lastBlockReason: null,
    expiredAt: null,
  };
}

/**
 * RETIME: 살아 있는(만료 확정 전) 같은 epoch의 expiresAt만 갱신한다.
 * 다른 epoch이거나 이미 만료 확정된 이력은 연장하지 않는다.
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @param {{epochId:number, expiresAt:number}} event
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
function reduceRetime(history, event) {
  if (history === null || typeof history !== 'object') {
    return history;
  }
  if (history.epochId !== event.epochId) {
    return history;
  }
  if (history.expiredAt !== null) {
    return history;
  }
  if (!isFiniteNumber(event.expiresAt)) {
    return history;
  }
  return { ...history, expiresAt: event.expiresAt };
}

/**
 * BLOCK: 같은 epoch이고 예상 만료 전(at < expiresAt)에 발생한 허용 reason만
 * 마지막 차단 원인으로 기록한다. 같은 reason 반복이면 같은 참조를 돌려준다.
 * 만료 확정 후이거나 다른 epoch, 허용 밖 reason은 무시한다.
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @param {{epochId:number, reason:string, at:number}} event
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
function reduceBlock(history, event) {
  if (history === null || typeof history !== 'object') {
    return history;
  }
  if (history.epochId !== event.epochId) {
    return history;
  }
  if (history.expiredAt !== null) {
    return history;
  }
  if (!isFiniteNumber(event.at) || event.at >= history.expiresAt) {
    return history;
  }
  const reason = normalizeBlockReason(event.reason);
  if (reason === null || reason === history.lastBlockReason) {
    return history;
  }
  return { ...history, lastBlockReason: reason };
}

/**
 * ADVANCE: now 기준으로 만료를 확정하고 24시간 경과분을 정리한다.
 * - expiredAt===null 이고 now >= expiresAt 이면 expiredAt = expiresAt(tick 시각이
 *   아니라 예상 만료 시각).
 * - now >= expiresAt + CACHE_HISTORY_RETENTION_MS 이면 null.
 * - 변화가 없으면 같은 참조를 돌려준다.
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @param {{now:number}} event
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
function reduceAdvance(history, event) {
  if (history === null || typeof history !== 'object') {
    return history;
  }
  if (!isFiniteNumber(event.now)) {
    return history;
  }
  let next = history;
  if (history.expiredAt === null && event.now >= history.expiresAt) {
    next = { ...history, expiredAt: history.expiresAt };
  }
  if (event.now >= next.expiresAt + CACHE_HISTORY_RETENTION_MS) {
    return null;
  }
  return next;
}

/**
 * RESTORE: 검증된 저장 레코드에서 이력을 만든다. epochId는 null(실행 중 경합
 * 검증용이라 영속 저장하지 않는다). reason은 허용 목록으로 정규화하고,
 * expiredAt은 null 또는 expiresAt과 같아야 하며 아니면 복원을 거부(null)한다.
 * doneAt/expiresAt이 비유한수면 거부하고, basisAt이 비유한수면 doneAt을 쓴다.
 * @param {{doneAt:number, basisAt:number|null, expiresAt:number, lastBlockReason?:string|null, expiredAt?:number|null}} record
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
function reduceRestore(record) {
  if (record === null || typeof record !== 'object') {
    return null;
  }
  if (!isFiniteNumber(record.doneAt) || !isFiniteNumber(record.expiresAt)) {
    return null;
  }
  const expiredAt = record.expiredAt ?? null;
  if (expiredAt !== null && expiredAt !== record.expiresAt) {
    return null;
  }
  return {
    epochId: null,
    doneAt: record.doneAt,
    basisAt: isFiniteNumber(record.basisAt) ? record.basisAt : record.doneAt,
    expiresAt: record.expiresAt,
    lastBlockReason: normalizeBlockReason(record.lastBlockReason),
    expiredAt,
  };
}

/**
 * 캐시 관측 이력의 수명주기를 순수하게 적용한다.
 *
 * event 종류(§2-3):
 * - OPEN {epochId, doneAt, basisAt, expiresAt}: 새 이력으로 교체.
 * - RETIME {epochId, expiresAt}: 살아 있는 같은 epoch의 만료 시각 갱신.
 * - BLOCK {epochId, reason, at}: 동일 epoch·만료 전 허용 reason 기록.
 * - ADVANCE {now}: 만료 확정과 24시간 경과 정리.
 * - RESTORE {record}: 저장 레코드에서 복원(epochId=null).
 * - CLEAR: 이력 삭제(null).
 *
 * @param {import('./contracts.mjs').CacheHistory|null} history
 * @param {{type:string} & Record<string, unknown>} event
 * @returns {import('./contracts.mjs').CacheHistory|null}
 */
export function reduceCacheHistory(history, event) {
  if (event === null || typeof event !== 'object') {
    return history;
  }
  switch (event.type) {
    case 'OPEN':
      return reduceOpen(history, /** @type {any} */ (event));
    case 'RETIME':
      return reduceRetime(history, /** @type {any} */ (event));
    case 'BLOCK':
      return reduceBlock(history, /** @type {any} */ (event));
    case 'ADVANCE':
      return reduceAdvance(history, /** @type {any} */ (event));
    case 'RESTORE':
      return reduceRestore(/** @type {any} */ (event.record));
    case 'CLEAR':
      return null;
    default:
      return history;
  }
}
