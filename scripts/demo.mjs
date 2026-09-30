#!/usr/bin/env node
/**
 * 🔧[OKAP-D1C9] P : 사람이 UI를 볼 수 있는 데모 러너.
 *
 * 실제 Orca 없이 가짜 런타임 소켓·가짜 host·임시 SQLite 설정 위에서 실제 플러그인을
 * 돌린다. 실제 타이머를 쓰되 clock을 `--speed`배로 가속하므로 5분 TTL이 몇 초 만에
 * 도달한다. `keepalive-open`으로 대시보드 URL을 출력하고, 가짜 에이전트가 주기적으로
 * working→done을 만들며 Enter를 받으면 자체 turn을 흉내낸다.
 *
 *   node scripts/demo.mjs [--speed 60] [--exit-after 20] [--layout-fixture]
 *
 * `--layout-fixture`는 긴 브랜치/제목, 제목 없는 터미널, 미지원 터미널을
 * 화면 검증용으로 만든다. 기본 데모 데이터와 제품 동작은 그대로 둔다.
 *
 * SIGINT/SIGTERM 또는 --exit-after 도달 시 플러그인을 deactivate하고 소켓·tmp를 정리한다.
 * 실제 shell/claude/Orca 프로세스는 실행하지 않는다.
 *
 * @module demo
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPlugin } from '../main.mjs'
import { createCoordinator } from '../src/coordinator.mjs'
import { createDashboardModel } from '../src/dashboard-model.mjs'
import { DEFAULT_CONFIG } from '../src/config.mjs'
import { startFakeRuntime } from '../test/fixtures/fake-runtime.mjs'
import { createOrcaUserData } from '../test/fixtures/orca-userdata.mjs'
import { createFakeHost } from '../test/fixtures/fake-host.mjs'

const DEFAULT_SPEED = 60

/** 데모 userdata fixture에 설정하는 앱 타이머 TTL(ms). 5분. */
const DEMO_TTL_MS = 300000

/**
 * 주기 가짜 turn이 epoch를 리셋해 due에 도달하기 전에 예약을 지우지 않도록 하는
 * 가속 시간 기준 여유(ms). 터미널당 turn 간격을 `TTL + 여유`보다 길게 만든다.
 */
const PERIODIC_TURN_SAFETY_MS = 30000

/**
 * 인자를 파싱한다.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { speed: DEFAULT_SPEED, exitAfter: null, layoutFixture: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--speed') {
      options.speed = Number(argv[++i])
    } else if (arg.startsWith('--speed=')) {
      options.speed = Number(arg.slice('--speed='.length))
    } else if (arg === '--exit-after') {
      options.exitAfter = Number(argv[++i])
    } else if (arg.startsWith('--exit-after=')) {
      options.exitAfter = Number(arg.slice('--exit-after='.length))
    } else if (arg === '--layout-fixture') {
      options.layoutFixture = true
    }
  }
  if (!Number.isFinite(options.speed) || options.speed <= 0) {
    options.speed = DEFAULT_SPEED
  }
  if (options.exitAfter !== null && (!Number.isFinite(options.exitAfter) || options.exitAfter <= 0)) {
    options.exitAfter = null
  }
  return options
}

/**
 * 실제 시간을 `speed`배로 가속한 clock. coordinator/guarded-send가 요구하는
 * 인터페이스를 제공한다.
 * @param {number} speed
 */
function createScaledClock(speed) {
  const wallStart = Date.now()
  const monoStart = Number(process.hrtime.bigint() / 1000000n)
  const base = Date.now()
  const toRealDelay = (ms) => Math.max(0, Math.round(ms / speed))

  return {
    now: () => base + (Date.now() - wallStart) * speed,
    monoNow: () => base + (Number(process.hrtime.bigint() / 1000000n) - monoStart) * speed,
    setTimeout(fn, ms) {
      return setTimeout(fn, toRealDelay(ms))
    },
    clearTimeout(id) {
      clearTimeout(id)
    },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
          return
        }
        const onAbort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
        }
        const timer = setTimeout(() => {
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
          resolve()
        }, toRealDelay(ms))
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = await mkdtemp(join(tmpdir(), 'okap-demo-'))
  const socketPath = join(root, 'runtime.sock')
  const fakePid = 41000 + Math.floor(Math.random() * 1000)

  const userData = await createOrcaUserData({
    root,
    pid: fakePid,
    socketPath,
    profileId: 'demo-profile',
    enabled: true,
    ttlMs: DEMO_TTL_MS,
  })
  const runtime = await startFakeRuntime({
    socketPath,
    authToken: userData.authToken,
    runtimeId: userData.runtimeId,
  })

  // 워크트리 2개, 터미널 3개(한 탭의 split 포함).
  runtime.addTerminal({
    handle: 'h1',
    worktreeId: 'wt-alpha',
    tabId: 'tab-a',
    leafId: 'leaf-1',
    title: options.layoutFixture ? '' : 'alpha main',
    branch: options.layoutFixture ? 'feature/MRTN-2716-cache-keepalive-dashboard-worktree-layout' : 'feature/alpha',
  })
  runtime.addTerminal({
    handle: 'h2',
    worktreeId: 'wt-alpha',
    tabId: 'tab-a',
    leafId: 'leaf-2',
    title: options.layoutFixture ? 'Claude terminal for a long running cache keepalive investigation' : 'alpha split',
    branch: options.layoutFixture ? 'feature/MRTN-2716-cache-keepalive-dashboard-worktree-layout' : 'feature/alpha',
  })
  runtime.addTerminal({
    handle: 'h3',
    worktreeId: 'wt-beta',
    tabId: 'tab-b',
    leafId: 'leaf-1',
    title: options.layoutFixture ? 'Remote terminal · unsupported' : 'beta main',
    branch: options.layoutFixture ? 'feature/MRTN-2717-remote-session-support-check' : 'feature/beta',
    ...(options.layoutFixture ? { executionHostId: 'remote' } : {}),
  })

  // 실제 Orca 브라우저가 없으므로 tabCreate를 실패시켜 알림으로 URL을 받는다.
  runtime.setBrowserTabCreateResult({})

  const host = createFakeHost()
  const clock = createScaledClock(options.speed)
  const plugin = createPlugin(host.orca, {
    os: { homedir: () => userData.homeDir },
    proc: {
      platform: 'linux',
      ppid: fakePid,
      env: { ORCA_USER_DATA_PATH: userData.userDataPath },
    },
    createCoordinator: (coordinatorOptions) =>
      createCoordinator({ ...coordinatorOptions, clock }),
    // 대시보드 스냅숏의 serverNow도 가속 clock 기준으로 맞춘다. dueAt/expiresAt이
    // 가속 시계라 기본 Date.now()를 쓰면 카운트다운이 어긋난다(제품 코드는 불변).
    createDashboardModel: (modelOptions) =>
      createDashboardModel({ ...modelOptions, now: () => clock.now() }),
  })
  plugin.activate()

  /** @type {Array<NodeJS.Timeout>} */
  const timers = []
  let cleaned = false

  const terminals = [
    { handle: 'h1', worktreeId: 'wt-alpha', paneKey: 'tab-a:leaf-1' },
    { handle: 'h2', worktreeId: 'wt-alpha', paneKey: 'tab-a:leaf-2' },
    { handle: 'h3', worktreeId: 'wt-beta', paneKey: 'tab-b:leaf-1' },
  ]

  /**
   * 가짜 작업 turn: working → done 이벤트를 보낸다.
   * @param {{handle:string, worktreeId:string, paneKey:string}} terminal
   */
  function emitTurn(terminal) {
    const receivedAt = clock.now()
    host.emit('agent.status.changed', {
      worktreeId: terminal.worktreeId,
      paneKey: terminal.paneKey,
      state: 'working',
      receivedAt,
    })
    host.emit('agent.status.changed', {
      worktreeId: terminal.worktreeId,
      paneKey: terminal.paneKey,
      state: 'done',
      receivedAt: receivedAt + 1000,
    })
  }

  async function cleanup(code = 0) {
    if (cleaned) return
    cleaned = true
    for (const timer of timers) {
      clearInterval(timer)
      clearTimeout(timer)
    }
    try {
      await plugin.deactivate()
    } catch {
      // ignore
    }
    try {
      await runtime.close()
    } catch {
      // ignore
    }
    try {
      await userData.cleanup()
    } catch {
      // ignore
    }
    process.exit(code)
  }

  // keepalive-open → 알림에서 dashboard URL을 출력한다.
  await host.runCommand('keepalive-open')
  const notification = host.lastNotification()
  const urlMatch = notification && typeof notification.body === 'string'
    ? /(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)/.exec(notification.body)
    : null

  // 데모가 실제로 쓰는 TTL과 플러그인 기본 margin으로 예상 TTL/due를 표시한다.
  const margin5mMs = DEFAULT_CONFIG.margin5mMs
  const ttlSec = DEMO_TTL_MS / 1000
  const dueSec = (DEMO_TTL_MS - margin5mMs) / 1000

  // 주기 turn 간격 계산. 터미널당 가속 시간 기준 간격이 `TTL + 여유`보다 길어야
  // due(done + TTL - margin)에 도달하기 전에 epoch가 리셋되지 않는다. 전체 주기는
  // 3개 터미널을 순환하므로 터미널당 간격을 터미널 수로 나눈 값이다.
  const perTerminalAcceleratedMs = DEMO_TTL_MS + PERIODIC_TURN_SAFETY_MS
  const perTerminalRealMs = Math.ceil(perTerminalAcceleratedMs / options.speed)
  const periodicRealMs = Math.max(500, Math.ceil(perTerminalRealMs / terminals.length))

  process.stdout.write(
    [
      'Cache Keepalive demo',
      `  speed: ${options.speed}x (5분 TTL ≈ ${Math.round(ttlSec / options.speed)}s, due ≈ ${Math.round(dueSec / options.speed)}s)`,
      `  periodic turn ≈ ${periodicRealMs}ms/terminal회전 (터미널당 가속 ${Math.round(perTerminalRealMs * options.speed / 1000)}s)`,
      `  worktrees: wt-alpha(h1,h2 split) / wt-beta(h3)`,
      `  ORCA_USER_DATA_PATH override: ${userData.userDataPath}`,
      urlMatch ? `  Dashboard: ${urlMatch[1]}` : '  Dashboard: (URL not found in notification)',
      '  Ctrl+C로 종료합니다. Enter 수신 시 가짜 에이전트가 working→done을 흉내냅니다.',
      '',
    ].join('\n') + '\n',
  )

  // 시작 직후 각 터미널에 fresh turn을 만든다.
  setTimeout(() => {
    for (const terminal of terminals) emitTurn(terminal)
  }, Math.max(50, Math.round(500 / options.speed)))

  // 주기적으로 실제 작업 turn을 흉내낸다(비자체 turn). 간격은 위에서 TTL/margin에
  // 맞춰 계산한 periodicRealMs를 쓴다(due 전에 epoch가 리셋되지 않게 함).
  let rotate = 0
  const periodic = setInterval(() => {
    const terminal = terminals[rotate % terminals.length]
    rotate += 1
    emitTurn(terminal)
  }, periodicRealMs)
  timers.push(periodic)

  // Enter(submission) 수신 시 자체 turn(working→done)을 흉내낸다.
  let seenSubmissions = 0
  const watcher = setInterval(
    () => {
      if (runtime.submissions.length <= seenSubmissions) return
      const newSubmissions = runtime.submissions.slice(seenSubmissions)
      seenSubmissions = runtime.submissions.length
      for (const submission of newSubmissions) {
        const terminal = terminals.find((entry) => entry.handle === submission.handle)
        if (!terminal) continue
        process.stdout.write(
          `  [keepalive] ${terminal.handle}에 Enter 수신 → 자체 turn 시뮬레이션\n`,
        )
        const receivedAt = clock.now()
        host.emit('agent.status.changed', {
          worktreeId: terminal.worktreeId,
          paneKey: terminal.paneKey,
          state: 'working',
          receivedAt,
        })
        setTimeout(() => {
          host.emit('agent.status.changed', {
            worktreeId: terminal.worktreeId,
            paneKey: terminal.paneKey,
            state: 'done',
            receivedAt: clock.now(),
          })
        }, Math.max(20, Math.round(500 / options.speed)))
      }
    },
    Math.max(50, Math.round(200 / options.speed)),
  )
  timers.push(watcher)

  process.on('SIGINT', () => {
    void cleanup(0)
  })
  process.on('SIGTERM', () => {
    void cleanup(0)
  })

  if (options.exitAfter !== null) {
    const exitTimer = setTimeout(() => {
      process.stdout.write(`\n--exit-after ${options.exitAfter}s 도달, 정리합니다.\n`)
      void cleanup(0)
    }, options.exitAfter * 1000)
    timers.push(exitTimer)
  }
}

main().catch((error) => {
  process.stderr.write(`demo 실패: ${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
