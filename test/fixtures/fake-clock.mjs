/**
 * 🔧[OKAP-D1C9] P : 가상 시간 clock fixture.
 *
 * coordinator/guarded-send가 요구하는 `now`/`monoNow`/`setTimeout`/`clearTimeout`/
 * `sleep(ms, signal)` 인터페이스를 실제 타이머 없이 제공한다. `advance(ms)`는 예약된
 * 콜백을 시간순으로 실행하고, 각 콜백 뒤에 microtask와 실제 I/O(소켓/파일)가 끝나도록
 * 이벤트 루프를 여러 번 양보한다. `jumpWall(ms)`은 monotonic을 건드리지 않고 wall만
 * 점프시켜 절전·시계 조정 시나리오를 재현한다.
 *
 * 테스트 전용 fixture이며 제품 코드가 아니다.
 *
 * @module fake-clock
 */

/**
 * 콜백 1개를 실행한 뒤, 그 비동기 후속 작업이 다음 timer를 예약할 때까지 기다리는
 * 최대 이벤트 루프 양보 횟수. coordinator의 tickLoop는 RPC/설정 읽기 뒤에 다음
 * tick을 예약하므로 새 timer id가 나타나면 즉시 멈춘다.
 */
const MAX_FLUSH_PER_TIMER = 5000
/** 한 timer의 비동기 후속을 기다리는 실제 시간 상한(ms). */
const MAX_WAIT_MS = 500
/** advance 마지막에 추가로 양보할 횟수. 진행 중인 send 체인을 끝까지 밀어준다. */
const FLUSH_FINAL = 300

/**
 * 한 번의 이벤트 루프 양보. setImmediate는 poll 단계 이후(check 단계)에 실행되므로
 * 직전에 완료된 실제 I/O 콜백이 함께 처리된다.
 * @returns {Promise<void>}
 */
function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * abort 오류를 만든다.
 * @returns {Error & {code:string}}
 */
function abortError() {
  return Object.assign(new Error('aborted'), { code: 'aborted' })
}

/**
 * 가상 clock을 만든다.
 *
 * @param {{start?: number}} [options] wall/mono 초기값(기본 2024-01-01 근처 큰 수).
 * @returns {{
 *   now: () => number,
 *   monoNow: () => number,
 *   setTimeout: (fn: Function, ms: number) => number,
 *   clearTimeout: (id: number) => void,
 *   sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   jumpWall: (ms: number) => void,
 *   jumpMono: (ms: number) => void,
 *   advance: (ms: number) => Promise<void>,
 *   settle: (iterations?: number) => Promise<void>,
 *   pendingCount: () => number,
 * }}
 */
export function createFakeClock({ start = 1_700_000_000_000 } = {}) {
  let wall = start
  let mono = start
  let seq = 0
  /** @type {Map<number, {at: number, fn: Function}>} */
  const timers = new Map()
  /** 진단용 카운터. */
  const stats = { timersRun: 0, capped: 0, maxYields: 0, totalYields: 0 }

  /**
   * 이벤트 루프를 `iterations`번 양보한다.
   * @param {number} iterations
   * @returns {Promise<void>}
   */
  async function flush(iterations) {
    for (let i = 0; i < iterations; i += 1) {
      await yieldLoop()
    }
  }

  /** @type {any} */
  const clock = {
    now: () => wall,
    monoNow: () => mono,

    setTimeout(fn, ms) {
      const id = ++seq
      const delay = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0
      timers.set(id, { at: wall + delay, fn })
      return id
    },

    clearTimeout(id) {
      timers.delete(id)
    },

    /**
     * 가상 시간을 `ms`만큼 진행시키고 microtask에서 resolve한다. 실제 대기는 하지
     * 않는다. AbortSignal을 존중한다.
     * @param {number} ms
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError())
          return
        }
        const onAbort = () => {
          if (typeof signal?.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
          reject(abortError())
        }
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
        const delay = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0
        wall += delay
        mono += delay
        queueMicrotask(() => {
          if (typeof signal?.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
          resolve()
        })
      })
    },

    /** mono를 건드리지 않고 wall만 점프시킨다(절전/수동 시계 조정 재현). */
    jumpWall(ms) {
      wall += ms
    },

    /** wall을 건드리지 않고 mono만 점프시킨다. */
    jumpMono(ms) {
      mono += ms
    },

    /**
     * wall+ms까지 예약 콜백을 시간순으로 실행한다. 각 콜백 뒤 이벤트 루프를 양보해
     * 소켓/파일 I/O가 진행되게 한다.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    async advance(ms) {
      const target = wall + (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0)
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at
            nextId = id
          }
        }
        if (nextId === null) {
          break
        }
        const timer = timers.get(nextId)
        timers.delete(nextId)
        if (timer.at > wall) {
          const delta = timer.at - wall
          wall += delta
          mono += delta
        }
        const knownIds = new Set(timers.keys())
        stats.timersRun += 1
        try {
          timer.fn()
        } catch {
          // 예약 콜백 오류는 advance를 멈추지 않는다.
        }
        // 후속 비동기 작업이 새 timer를 예약할 때까지 이벤트 루프를 양보한다.
        // setImmediate만으로는 threadpool 완료가 늦을 수 있어 주기적으로 실제
        // setTimeout(0)도 섞고, 실제 시간 예산을 넘기면 포기한다.
        let scheduled = false
        let yieldsUsed = 0
        const waitStart = Date.now()
        for (;;) {
          await yieldLoop()
          yieldsUsed += 1
          for (const id of timers.keys()) {
            if (!knownIds.has(id)) {
              scheduled = true
              break
            }
          }
          if (scheduled) break
          if (yieldsUsed % 50 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          if (Date.now() - waitStart > MAX_WAIT_MS || yieldsUsed >= MAX_FLUSH_PER_TIMER) {
            break
          }
        }
        stats.totalYields += yieldsUsed
        if (yieldsUsed > stats.maxYields) stats.maxYields = yieldsUsed
        if (!scheduled) {
          stats.capped += 1
        }
      }
      if (target > wall) {
        const delta = target - wall
        wall += delta
        mono += delta
      }
      await flush(FLUSH_FINAL)
    },

    /**
     * 시간을 진행하지 않고 이벤트 루프만 양보한다.
     * @param {number} [iterations]
     * @returns {Promise<void>}
     */
    async settle(iterations = FLUSH_FINAL) {
      await flush(iterations)
    },

    pendingCount: () => timers.size,
    stats,
  }

  return clock
}

export default createFakeClock
