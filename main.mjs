/**
 * Cache Keepalive Orca plugin worker entry point.
 *
 * DESIGN.md §7.2 / §11 (작업 O). 이 파일은 이미 완료된 모듈들을 Orca가 로드 가능한
 * 단일 플러그인으로 묶는 glue만 담당한다. 정책/상태머신/RPC/HTTP 로직은 `src/*.mjs`
 * 모듈에 있고 여기서는 주입만 한다.
 *
 * 대시보드는 이제 activate 시 즉시 시작된다(터미널 CLI용). 제어 파일
 * (`~/.orca-cache-keepalive/control.json`)과 CLI 복사본은 activate의 background
 * 작업이 만들고 deactivate가 지운다.
 *
 * Orca host 계약 (`src/main/plugins/plugin-host-runtime.ts`):
 * - default export `activate(orca)`를 host가 `await`한다. 여기서는 등록을 동기적으로
 *   마치고 background bootstrap은 coordinator에 위임하므로 무한 loop await가 없다.
 * - named export `deactivate()`를 shutdown 시 host가 호출한다. 두 번 호출해도 안전하다.
 * - import 시점에는 서버·타이머·파일 I/O 등 어떤 부작용도 만들지 않는다.
 *
 * @module main
 */

import * as nodeCrypto from 'node:crypto'
import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodeProcess from 'node:process'
import { join as nodeJoin } from 'node:path'
import { fileURLToPath as nodeFileURLToPath } from 'node:url'

import { createStateStore } from './src/state-store.mjs'
import { resolveBinding } from './src/runtime-location.mjs'
import { createRpcClient } from './src/rpc-client.mjs'
import { createObserver } from './src/terminal-observer.mjs'
import { readTimerSettings } from './src/orca-settings.mjs'
import { sendKeepalive } from './src/guarded-send.mjs'
import { initialTargetState, reduceTarget, decide } from './src/scheduler.mjs'
import { createDiagnostics } from './src/diagnostics.mjs'
import { createCoordinator } from './src/coordinator.mjs'
import { createDashboardModel } from './src/dashboard-model.mjs'
import { startDashboard } from './src/dashboard-server.mjs'
import { registerCommands, openInOrcaBrowser } from './src/commands.mjs'
import {
  writeControlFile,
  removeControlFile,
  installCli,
} from './src/control-file.mjs'

/** 대시보드 서버가 이 시간 안에 준비되지 않으면 dashboard_unavailable로 실패한다(ms). */
const DASHBOARD_START_TIMEOUT_MS = 5000

/** 알림 본문 최대 길이(문자). host 계약을 넘지 않도록 자른다. */
const NOTIFICATION_BODY_MAX_CHARS = 1000

/** manifest가 선언한 terminal:send capability 종류. 없으면 sender를 시작하지 않는다. */
const TERMINAL_SEND_CAPABILITY = 'terminal:send'

/**
 * 모듈 전역에 보관하는 활성 인스턴스. default activate가 설정하고 named deactivate가
 * 소비한다. 테스트는 createPlugin을 직접 쓰므로 이 변수를 건드리지 않는다.
 *
 * @type {{activate: () => void, deactivate: () => Promise<void>} | null}
 */
let currentInstance = null

/**
 * 플러그인 인스턴스를 만든다. 모든 외부 의존(모듈 factory·os/process/fs/crypto/time)을
 * `deps`로 덮어쓸 수 있어 실제 Orca나 사용자 경로 없이 테스트할 수 있다.
 *
 * @param {Object} orca Orca worker가 주는 plugin API.
 * @param {Object} [deps] 테스트/호스트 주입용 의존성 override.
 * @returns {{activate: () => void, deactivate: () => Promise<void>}}
 */
export function createPlugin(orca, deps = {}) {
  const {
    os = nodeOs,
    proc = nodeProcess,
    fs = nodeFs,
    pathJoin = nodeJoin,
    fileURLToPath = nodeFileURLToPath,
    URL: URLCtor = URL,
    randomUUID = () => nodeCrypto.randomUUID(),
    createDiagnostics: makeDiagnostics = createDiagnostics,
    createStateStore: makeStateStore = createStateStore,
    createCoordinator: makeCoordinator = createCoordinator,
    createDashboardModel: makeDashboardModel = createDashboardModel,
    startDashboard: startDashboardImpl = startDashboard,
    registerCommands: registerCommandsImpl = registerCommands,
    openInOrcaBrowser: openInOrcaBrowserImpl = openInOrcaBrowser,
    resolveBinding: resolveBindingImpl = resolveBinding,
    createRpcClient: makeRpcClient = createRpcClient,
    createObserver: makeObserver = createObserver,
    readTimerSettings: readSettings = readTimerSettings,
    sendKeepalive: sendKeepaliveImpl = sendKeepalive,
    initialTargetState: initialTargetStateImpl = initialTargetState,
    reduceTarget: reduceTargetImpl = reduceTarget,
    decide: decideImpl = decide,
    writeControlFile: writeControlFileImpl = writeControlFile,
    removeControlFile: removeControlFileImpl = removeControlFile,
    installCli: installCliImpl = installCli,
  } = deps

  let started = false
  /** @type {Promise<void>|null} */
  let stopPromise = null
  /** @type {Promise<void>|null} activate가 시작하는 background 제어 파일 작업. */
  let controlPromise = null
  /** @type {Promise<{url: string, close: () => unknown}>|null} */
  let ensureDashboardPromise = null
  /** @type {{url: string, close: () => unknown}|null} */
  let dashboardServer = null
  let deactivated = false
  /** @type {string|null} 이 인스턴스 고유 id. 제어 파일 소유권 확인에 쓴다. */
  let clientId = null

  /** @type {ReturnType<typeof createCoordinator>|null} */
  let coordinator = null
  /** @type {ReturnType<typeof createDashboardModel>|null} */
  let model = null
  /** @type {ReturnType<typeof createDiagnostics>|null} */
  let diagnostics = null

  /**
   * `~/.claude/cwarm.disabled` 존재 여부. ENOENT만 false, 그 밖의 오류는 판정 불가로
   * 보고 전송을 막는 보수적 true를 돌려준다.
   *
   * @returns {Promise<boolean>}
   */
  async function cwarmDisabled() {
    const target = pathJoin(os.homedir(), '.claude', 'cwarm.disabled')
    const access = fs && fs.promises ? fs.promises.access : null
    if (typeof access !== 'function') {
      return true
    }
    try {
      await access(target)
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false
      }
      return true
    }
  }

  /**
   * 대시보드 서버를 지연 시작한다. 처음 호출에서만 시작하고 동시 호출은 같은
   * promise를 공유한다. 5초 안에 준비되지 않으면 code='dashboard_unavailable'.
   *
   * @returns {Promise<{url: string, close: () => unknown}>}
   */
  function ensureDashboard() {
    if (ensureDashboardPromise !== null) {
      return ensureDashboardPromise
    }
    const starting = Promise.resolve().then(() =>
      startDashboardImpl({
        getSnapshot: () => model.snapshot(),
        dispatch: (action) => model.dispatch(action),
        assetsDir: fileURLToPath(new URLCtor('./ui/', import.meta.url)),
      }),
    )
    // 늦게 준비된 서버도 deactivate가 닫을 수 있게 항상 붙잡아 둔다.
    starting.then(
      (server) => {
        dashboardServer = server
        if (deactivated) {
          try {
            server.close()
          } catch {
            // ignore
          }
          dashboardServer = null
        }
      },
      () => {
        // 시작 실패는 race 쪽 rejection으로만 보고한다.
      },
    )
    ensureDashboardPromise = new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        const error = new Error('dashboard did not start within timeout')
        error.code = 'dashboard_unavailable'
        reject(error)
      }, DASHBOARD_START_TIMEOUT_MS)
      if (timer && typeof timer.unref === 'function') {
        timer.unref()
      }
      starting.then(
        (server) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          resolve(server)
        },
        (error) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    return ensureDashboardPromise
  }

  /**
   * 제어 파일/CLI 준비 실패를 토큰·경로·URL 없이 안전한 코드만 남긴다.
   *
   * @param {unknown} error
   * @returns {void}
   */
  function logControlUnavailable(error) {
    const raw = error && typeof error.code === 'string' ? error.code : ''
    const code = /^[A-Za-z_]{1,40}$/.test(raw) ? raw : 'internal'
    try {
      orca.log(`cache-keepalive: control file unavailable (${code})`)
    } catch {
      // 로그 실패는 무시한다.
    }
  }

  /**
   * 등록을 동기적으로 마치고 coordinator bootstrap만 background로 시작한다.
   *
   * @returns {void}
   */
  function activate() {
    if (started) {
      return
    }
    started = true

    const hostCall = (method, params) => orca.host.call(method, params)
    diagnostics = makeDiagnostics({ log: (message) => orca.log(message) })
    const store = makeStateStore({ hostCall })
    clientId = 'cache-keepalive:' + randomUUID()

    coordinator = makeCoordinator({
      hostCall,
      store,
      resolveBinding: (override) =>
        resolveBindingImpl({
          platform: proc.platform,
          home: os.homedir(),
          env: proc.env,
          override,
          parentPid: proc.ppid,
        }),
      createRpc: ({ getBinding }) => makeRpcClient({ getBinding }),
      createObserver: ({ rpc, hostCall: hostCallImpl }) =>
        makeObserver({ rpc, hostCall: hostCallImpl }),
      readSettings,
      sendKeepalive: sendKeepaliveImpl,
      scheduler: {
        initialTargetState: initialTargetStateImpl,
        reduceTarget: reduceTargetImpl,
        decide: decideImpl,
      },
      diagnostics,
      cwarmDisabled,
      clientId,
    })

    model = makeDashboardModel({
      store,
      getRuntimeView: () => coordinator.getRuntimeView(),
      getDiagnostics: () => diagnostics.snapshot(),
      onReviewCleared: (info) => coordinator.onReviewCleared(info),
      onPolicyChanged: () => coordinator.onPolicyChanged(),
    })

    // 핸들러는 queue에 넣고 즉시 반환한다(coordinator가 직렬화한다).
    orca.events.on('agent.status.changed', (payload) => {
      coordinator.onAgentEvent(payload)
    })
    orca.events.on('worktree.removed', (payload) => {
      coordinator.onWorktreeRemoved(payload)
    })

    const controller = {
      ensureDashboard,
      openDashboard: async (url) => {
        const rpc = coordinator.getRpc()
        if (!rpc) {
          return { opened: false }
        }
        const worktreeId = await coordinator.currentWorktreeId().catch(() => null)
        return openInOrcaBrowserImpl({ rpc, url, worktreeId })
      },
      currentWorktreeId: () => coordinator.currentWorktreeId(),
      toggleWorktree: (id) => model.toggleWorktreeById(id),
      setWorktree: (id, enabled) => model.setWorktreeById(id, enabled),
      setPaused: (paused) => model.setPaused(paused),
      togglePaused: () => model.togglePaused(),
      statusSummary: async () => model.statusSummary(),
    }

    const notify = async (title, body) => {
      try {
        await orca.host.call(
          'notifications.show',
          body ? { title, body: String(body).slice(0, NOTIFICATION_BODY_MAX_CHARS) } : { title },
        )
      } catch {
        // 알림 실패는 명령을 실패로 만들지 않는다.
      }
    }

    registerCommandsImpl({ orca, controller, notify })

    const granted = Array.isArray(orca.grantedCapabilities) ? orca.grantedCapabilities : []
    if (granted.includes(TERMINAL_SEND_CAPABILITY)) {
      coordinator.start()
    } else {
      // 명령·대시보드는 살리되 direct RPC sender는 시작하지 않는다.
      diagnostics.record({ event: 'safety_skipped', code: 'terminal_send_not_granted' })
    }

    // 터미널 CLI가 접속할 수 있게 대시보드를 즉시 시작하고 제어 파일·CLI를 준비한다.
    // activate는 이 작업을 await하지 않는다. 실패는 삼키고 안전한 코드만 로그한다.
    controlPromise = (async () => {
      let server
      try {
        server = await ensureDashboard()
      } catch (error) {
        logControlUnavailable(error)
        return
      }
      // deactivate가 이미 시작됐으면 늦게 준비된 서버의 제어 파일을 쓰지 않는다.
      if (deactivated) {
        return
      }
      try {
        await writeControlFileImpl({
          fs,
          home: os.homedir(),
          pathJoin,
          pid: proc.pid,
          port: server.port,
          token: server.token,
          instanceId: clientId,
          platform: proc.platform,
        })
      } catch (error) {
        logControlUnavailable(error)
        return
      }
      // CLI 복사 실패는 제어 파일을 유지한다(플러그인 폴더에서 직접 실행 가능).
      try {
        await installCliImpl({
          fs,
          home: os.homedir(),
          pathJoin,
          sourcePath: fileURLToPath(new URLCtor('./bin/keepalive.mjs', import.meta.url)),
          platform: proc.platform,
        })
      } catch (error) {
        logControlUnavailable(error)
      }
    })()
  }

  /**
   * coordinator/server/diagnostics를 정리한다. 두 번 호출해도 안전하다.
   *
   * @returns {Promise<void>}
   */
  function deactivate() {
    if (stopPromise !== null) {
      return stopPromise
    }
    deactivated = true
    stopPromise = (async () => {
      if (coordinator !== null) {
        try {
          await coordinator.stop()
        } catch {
          // ignore
        }
      }
      // 서버를 닫기 전에 background 제어 파일 작업을 정리하고 제어 파일을 지운다.
      if (controlPromise !== null) {
        try {
          await controlPromise
        } catch {
          // ignore
        }
      }
      try {
        await removeControlFileImpl({
          fs,
          home: os.homedir(),
          pathJoin,
          pid: proc.pid,
          instanceId: clientId,
        })
      } catch {
        // ignore
      }
      if (dashboardServer !== null && typeof dashboardServer.close === 'function') {
        try {
          await dashboardServer.close()
        } catch {
          // ignore
        }
      }
      dashboardServer = null
      if (diagnostics !== null) {
        try {
          await diagnostics.close()
        } catch {
          // ignore
        }
      }
    })()
    return stopPromise
  }

  return { activate, deactivate }
}

/**
 * Orca worker가 호출하는 default export. 등록을 동기적으로 끝내고 즉시 반환한다.
 *
 * @param {Object} orca Orca plugin API.
 * @returns {void}
 */
export default function activate(orca) {
  const plugin = createPlugin(orca)
  currentInstance = plugin
  plugin.activate()
  return undefined
}

/**
 * Orca worker shutdown 시 호출하는 named export. 두 번 호출해도 안전하다.
 *
 * @returns {Promise<void>}
 */
export async function deactivate() {
  const plugin = currentInstance
  currentInstance = null
  if (plugin !== null) {
    await plugin.deactivate()
  }
}
