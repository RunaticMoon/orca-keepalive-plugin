/**
 * Cache Keepalive 진단 sink.
 *
 * DESIGN.md §8의 bounded/redacted 기록기. event/reason은 allowlist로만 유지하고
 * targetId는 salt+SHA-256 앞 12 hex로만 저장하며 detail은 정해진 key의 유한수/
 * boolean만 남긴다. 전송 본문·draft·URL·경로·token·error.message 같은 문자열은
 * 절대 기록하지 않는다.
 *
 * 구성:
 * - host `log(line)`에 entry별 JSON 한 줄 전달(예외 삼킴).
 * - 최근 ringSize개 memory ring(snapshot은 복사본).
 * - dir이 있으면 `${dir}/events.jsonl`에 append(0600, 디렉터리 0700 best effort).
 *   파일 크기+줄 크기가 maxBytes를 넘으면 events.jsonl(-1,-2…)로 회전한다.
 * - 쓰기는 내부 직렬 queue로 순서를 보장하고 record()는 동기 반환한다.
 *   비동기 쓰기 실패는 삼키고 dir 기록을 비활성화한 뒤 ring/log만 유지한다.
 *
 * @module diagnostics
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

import { DIAGNOSTIC_EVENTS, REASON_CODES } from './contracts.mjs'

/**
 * 진단 level. 낮을수록 상세하다.
 * @typedef {'debug'|'info'|'warn'|'error'} DiagnosticLevel
 */

/**
 * redaction을 거친 진단 entry. §8.
 * @typedef {Object} DiagnosticEntry
 * @property {number} at
 * @property {DiagnosticLevel} level
 * @property {string} event allowlist에 존재했던 event(아니면 'unknown_event').
 * @property {string} [code] REASON_CODES 값 또는 `/^[a-z_]{1,40}$/`.
 * @property {string} [target] hashTarget(targetId).
 * @property {Record<string, number|boolean>} [detail] allowlist key의 유한수/boolean.
 */

/**
 * record 입력. §8.
 * @typedef {Object} DiagnosticInput
 * @property {string} event
 * @property {DiagnosticLevel} [level]
 * @property {string} [code]
 * @property {string} [targetId]
 * @property {Object} [detail]
 */

/** level별 심각도. setLevel 이상만 기록한다. */
const LEVEL_SEVERITY = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 })

/** detail에 남길 수 있는 key만 모은 allowlist. §8. */
const DETAIL_KEYS = Object.freeze([
  'count',
  'ttlMs',
  'marginMs',
  'dueInMs',
  'remainingMs',
  'phase_code',
  'epochId',
  'bytes',
  'elapsedMs',
  'attempt',
  'revision',
])

/** event allowlist 조회용 Set. */
const EVENT_SET = new Set(DIAGNOSTIC_EVENTS)

/** reason 코드 조회용 Set(REASON_CODES는 key===value). */
const REASON_SET = new Set(Object.values(REASON_CODES))

/** 문자열 code의 허용 shape. */
const CODE_RE = /^[a-z_]{1,40}$/

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_FILES = 3
const DEFAULT_RING_SIZE = 200
const DEFAULT_LEVEL = 'info'
const DEFAULT_LEVEL_ERROR = 'unknown_event'
const LOG_FILE_NAME = 'events.jsonl'

/**
 * level 문자열이 허용값이면 그대로, 아니면 fallback을 돌려준다.
 * @param {unknown} value
 * @param {DiagnosticLevel} fallback
 * @returns {DiagnosticLevel}
 */
function normalizeLevel(value, fallback) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_SEVERITY, value)
    ? /** @type {DiagnosticLevel} */ (value)
    : fallback
}

/**
 * detail 객체에서 allowlist key의 유한수/boolean만 새 객체로 추린다.
 * 문자열·객체·배열·비유한수·미등록 key는 전부 버린다.
 * @param {unknown} value
 * @returns {Record<string, number|boolean>|null}
 */
function sanitizeDetail(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const source = /** @type {Record<string, unknown>} */ (value)
  /** @type {Record<string, number|boolean>} */
  const out = {}
  for (const key of DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue
    }
    const raw = source[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw
    } else if (typeof raw === 'boolean') {
      out[key] = raw
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * JSON.stringify의 예외를 삼킨다. redaction 후 plain object라 실패할 일은 없지만
 * log/ring 경로가 절대 throw하지 않게 방어한다.
 * @param {unknown} value
 * @returns {string|null}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/**
 * bounded/redacted 진단 기록기를 만든다.
 *
 * @param {Object} [options]
 * @param {(line: string) => void} [options.log] host log sink(entry별 JSON 한 줄).
 * @param {string|null} [options.dir] JSONL 파일을 쓸 디렉터리(없으면 memory ring만).
 * @param {Object} [options.fs] node:fs/promises 호환 객체(테스트 주입용).
 * @param {() => number} [options.now] 현재 시각(ms) 공급자.
 * @param {number} [options.maxBytes] 회전 기준 파일 크기(byte).
 * @param {number} [options.maxFiles] events.jsonl을 포함한 최대 파일 수.
 * @param {number} [options.ringSize] 메모리 ring 상한.
 * @param {DiagnosticLevel} [options.level] 기록 최소 level.
 * @param {string} [options.hashSalt] targetId hash에 쓸 salt(기본 random 16 byte hex).
 * @returns {{
 *   record: (event: DiagnosticInput) => void,
 *   snapshot: () => DiagnosticEntry[],
 *   setDir: (dir: string|null) => void,
 *   setLevel: (level: string) => void,
 *   close: () => Promise<void>,
 *   hashTarget: (id: string) => string,
 * }}
 */
export function createDiagnostics({
  log = () => {},
  dir = null,
  fs = nodeFs,
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  ringSize = DEFAULT_RING_SIZE,
  level = DEFAULT_LEVEL,
  hashSalt = randomBytes(16).toString('hex'),
} = {}) {
  const salt = typeof hashSalt === 'string' ? hashSalt : String(hashSalt)

  const limitBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
  const limitFiles =
    Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES
  const limitRing = Number.isSafeInteger(ringSize) && ringSize >= 0 ? ringSize : DEFAULT_RING_SIZE

  /** @type {string|null} */
  let currentDir = typeof dir === 'string' && dir.length > 0 ? dir : null
  /** @type {DiagnosticLevel} */
  let currentLevel = normalizeLevel(level, DEFAULT_LEVEL)

  /** @type {DiagnosticEntry[]} */
  const ring = []
  /** @type {Promise<void>} */
  let queueTail = Promise.resolve()
  let fsFailed = false
  let fsErrorCount = 0
  let closed = false

  /**
   * salt+id의 SHA-256 앞 12 hex. 원문은 어디에도 남기지 않는다.
   * @param {string} id
   * @returns {string}
   */
  function hashTarget(id) {
    const value = typeof id === 'string' ? id : String(id)
    return createHash('sha256').update(salt).update(value).digest('hex').slice(0, 12)
  }

  /**
   * 입력을 allowlist 규칙으로 redaction한 entry로 만든다.
   * @param {unknown} value
   * @returns {DiagnosticEntry}
   */
  function sanitize(value) {
    const source =
      value !== null && typeof value === 'object' ? /** @type {DiagnosticInput} */ (value) : {}

    const rawEvent = /** @type {{event?: unknown}} */ (source).event
    const event =
      typeof rawEvent === 'string' && EVENT_SET.has(rawEvent)
        ? rawEvent
        : DEFAULT_LEVEL_ERROR

    /** @type {DiagnosticEntry} */
    const entry = {
      at: now(),
      level: normalizeLevel(source.level, 'info'),
      event,
    }

    if (source.code !== undefined) {
      const code = source.code
      entry.code =
        typeof code === 'string' && (REASON_SET.has(code) || CODE_RE.test(code))
          ? code
          : 'other'
    }

    if (typeof source.targetId === 'string') {
      entry.target = hashTarget(source.targetId)
    }

    const detail = sanitizeDetail(source.detail)
    if (detail !== null) {
      entry.detail = detail
    }

    return entry
  }

  /**
   * 파일이 있으면 지운다(best effort).
   * @param {string} path
   * @returns {Promise<void>}
   */
  async function removeIfExists(path) {
    if (typeof fs.rm === 'function') {
      try {
        await fs.rm(path, { force: true })
      } catch {
        /* best effort */
      }
      return
    }
    if (typeof fs.unlink === 'function') {
      try {
        await fs.unlink(path)
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * from이 있으면 to로 rename한다. 없으면 조용히 넘어간다.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<void>}
   */
  async function renameIfExists(from, to) {
    try {
      await fs.rename(from, to)
    } catch (error) {
      if (error && /** @type {{code?: string}} */ (error).code === 'ENOENT') {
        return
      }
      throw error
    }
  }

  /**
   * events.jsonl을 한 단계 회전한다. maxFiles=3이면 .2 삭제 → .1→.2 → base→.1.
   * @param {string} base events.jsonl의 절대/상대 경로.
   * @returns {Promise<void>}
   */
  async function rotate(base) {
    await removeIfExists(`${base}.${limitFiles - 1}`)
    for (let i = limitFiles - 2; i >= 1; i -= 1) {
      await renameIfExists(`${base}.${i}`, `${base}.${i + 1}`)
    }
    await renameIfExists(base, `${base}.1`)
  }

  /**
   * 한 entry line을 파일에 append한다. 회전/디렉터리 생성 포함.
   * @param {string} targetDir
   * @param {string} line
   * @returns {Promise<void>}
   */
  async function writeLine(targetDir, line) {
    if (!targetDir || fsFailed) {
      return
    }
    const target = join(targetDir, LOG_FILE_NAME)
    const bytes = Buffer.byteLength(line, 'utf8') + 1

    if (typeof fs.mkdir === 'function') {
      await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
    }

    let size = 0
    if (typeof fs.stat === 'function') {
      try {
        const stats = await fs.stat(target)
        size = stats.size
      } catch (error) {
        if (!error || /** @type {{code?: string}} */ (error).code !== 'ENOENT') {
          throw error
        }
      }
    }

    if (limitFiles >= 2 && size + bytes > limitBytes) {
      await rotate(target)
    }

    if (typeof fs.appendFile === 'function') {
      await fs.appendFile(target, `${line}\n`, { mode: 0o600 })
    }
    if (typeof fs.chmod === 'function') {
      try {
        await fs.chmod(target, 0o600)
      } catch {
        /* best effort: Windows ACL 등 */
      }
    }
  }

  /**
   * line을 직렬 queue에 넣는다. record()는 이 함수를 기다리지 않는다.
   * @param {string} targetDir
   * @param {string} line
   */
  function enqueue(targetDir, line) {
    queueTail = queueTail
      .then(() => writeLine(targetDir, line))
      .catch(() => {
        fsFailed = true
        fsErrorCount += 1
      })
  }

  /**
   * 진단 entry 하나를 기록한다. 동기 반환한다.
   * @param {DiagnosticInput} input
   * @returns {void}
   */
  function record(input) {
    if (closed) {
      return
    }
    const entry = sanitize(input)
    if (LEVEL_SEVERITY[entry.level] < LEVEL_SEVERITY[currentLevel]) {
      return
    }

    ring.push(entry)
    while (ring.length > limitRing) {
      ring.shift()
    }

    const line = safeStringify(entry)
    if (line === null) {
      return
    }

    try {
      log(line)
    } catch {
      /* host log 실패는 무시 */
    }

    if (currentDir && !fsFailed) {
      enqueue(currentDir, line)
    }
  }

  /**
   * ring의 복사본을 반환한다. 반환된 객체를 바꿔도 내부 상태는 그대로다.
   * @returns {DiagnosticEntry[]}
   */
  function snapshot() {
    return ring.map((entry) => {
      /** @type {DiagnosticEntry} */
      const copy = { at: entry.at, level: entry.level, event: entry.event }
      if (entry.code !== undefined) {
        copy.code = entry.code
      }
      if (entry.target !== undefined) {
        copy.target = entry.target
      }
      if (entry.detail !== undefined) {
        copy.detail = { ...entry.detail }
      }
      return copy
    })
  }

  /**
   * dir을 바꾼다. 새 dir에서 다시 파일 기록을 시도한다.
   * @param {string|null} nextDir
   * @returns {void}
   */
  function setDir(nextDir) {
    currentDir = typeof nextDir === 'string' && nextDir.length > 0 ? nextDir : null
    fsFailed = false
  }

  /**
   * 기록 최소 level을 바꾼다. 허용값이 아니면 무시한다.
   * @param {string} nextLevel
   * @returns {void}
   */
  function setLevel(nextLevel) {
    if (
      typeof nextLevel === 'string' &&
      Object.prototype.hasOwnProperty.call(LEVEL_SEVERITY, nextLevel)
    ) {
      currentLevel = /** @type {DiagnosticLevel} */ (nextLevel)
    }
  }

  /**
   * 대기 중인 파일 쓰기를 flush하고 종료한다. 두 번 호출해도 안전하며 이후
   * record는 무시된다.
   * @returns {Promise<void>}
   */
  async function close() {
    closed = true
    await queueTail
  }

  return { record, snapshot, setDir, setLevel, close, hashTarget }
}
