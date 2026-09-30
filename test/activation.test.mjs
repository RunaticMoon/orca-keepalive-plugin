/**
 * 🔧[OKAP-D1C9] O : 플러그인 진입점 활성화 테스트.
 *
 * 실제 Orca/사용자 경로/실시간 타이머에 의존하지 않는다. createPlugin의 deps로
 * resolveBinding이 LocationError('metadata_missing')를 던지게 주입하고, coordinator는
 * 가짜로 바꿔 start 호출 여부만 검증한다. 대시보드 서버만 실제 loopback으로 띄운 뒤
 * deactivate가 닫는지 확인한다.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import activateDefault, { createPlugin, deactivate } from '../main.mjs'
import { LocationError } from '../src/runtime-location.mjs'
import { createCoordinator as realCreateCoordinator } from '../src/coordinator.mjs'
import { createDiagnostics } from '../src/diagnostics.mjs'

const ALL_CAPABILITIES = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'events:subscribe',
]

const MAIN_URL = new URL('../main.mjs', import.meta.url).href
const MANIFEST_URL = new URL('../orca-plugin.json', import.meta.url)

/** 타이머를 만들지 않는 clock. 실제 setTimeout 대신 placeholder만 돌려준다. */
const noopClock = {
  now: Date.now,
  monoNow: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
  sleep: async () => {},
}

/**
 * fake orca worker API. host.call은 storage와 notifications만 메모리에 기록한다.
 *
 * @param {{grantedCapabilities?: string[], failNotifications?: boolean, delivered?: boolean}} [options]
 */
function createFakeOrca({
  grantedCapabilities = ALL_CAPABILITIES,
  failNotifications = false,
  delivered = true,
} = {}) {
  /** @type {string[]} */
  const registeredCommandOrder = []
  /** @type {Map<string, () => unknown>} */
  const commands = new Map()
  /** @type {Array<{event: string, handler: unknown}>} */
  const eventRegistrations = []
  /** @type {Array<Record<string, unknown>>} */
  const notifications = []
  /** @type {string[]} */
  const logs = []
  /** @type {Map<string, unknown>} */
  const storage = new Map()

  const orca = {
    commands: {
      register(id, handler) {
        registeredCommandOrder.push(id)
        commands.set(id, handler)
      },
    },
    events: {
      on(event, handler) {
        eventRegistrations.push({ event, handler })
      },
    },
    host: {
      async call(method, params = {}) {
        if (method === 'storage.get') {
          const key = params.key
          return { value: storage.has(key) ? storage.get(key) : null }
        }
        if (method === 'storage.set') {
          storage.set(params.key, params.value)
          return { ok: true }
        }
        if (method === 'notifications.show') {
          if (failNotifications) {
            throw Object.assign(new Error('notification failed'), { code: 'notification_failed' })
          }
          notifications.push(params)
          return { ok: true, delivered }
        }
        throw Object.assign(new Error('unsupported host method: ' + method), {
          code: 'unsupported_method',
        })
      },
    },
    grantedCapabilities,
    log(message) {
      logs.push(String(message))
    },
  }

  return { orca, commands, registeredCommandOrder, eventRegistrations, notifications, logs, storage }
}

/** start/stop 호출 횟수만 기록하는 가짜 coordinator. */
function createFakeCoordinator() {
  const calls = { start: 0, stop: 0 }
  const coordinator = {
    start() {
      calls.start += 1
    },
    async stop() {
      calls.stop += 1
    },
    onAgentEvent() {},
    onWorktreeRemoved() {},
    getRuntimeView() {
      return {
        userDataKey: null,
        profileId: null,
        connection: { state: 'starting', reason: null },
        appTimer: { known: false, enabled: false, ttlMs: null, source: null, readAt: null },
        worktrees: [],
      }
    },
    async currentWorktreeId() {
      return null
    },
    onReviewCleared() {},
    onPolicyChanged() {},
    getRpc() {
      return null
    },
  }
  return { coordinator, calls }
}

/**
 * startDashboard 호출/close 순서를 기록하는 가짜 대시보드.
 *
 * @param {{port?: number, token?: string, order?: string[]}} [options]
 */
function createFakeDashboard({ port = 50123, token = 'tok-abc', order } = {}) {
  const calls = { start: 0, close: 0, startOptions: [] }
  const server = {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    token,
    async close() {
      calls.close += 1
      if (order) order.push('close')
    },
  }
  return {
    server,
    calls,
    startDashboard: (options) => {
      calls.start += 1
      calls.startOptions.push(options)
      return Promise.resolve(server)
    },
  }
}

/**
 * createPlugin이 만드는 대시보드 모델을 대신하는 가짜. dispatch 호출만 기록하고
 * 고정 스냅숏을 돌려주므로 알림 경로만 따로 검증할 수 있다.
 *
 * @param {{snapshot?: object, onDispatch?: (action: unknown) => Promise<object>}} [options]
 */
function createFakeModel({ snapshot, onDispatch } = {}) {
  const dispatched = []
  const defaultSnapshot = snapshot ?? { revision: 1, config: { paused: false }, worktrees: [] }
  return {
    dispatched,
    async dispatch(action) {
      dispatched.push(action)
      if (typeof onDispatch === 'function') {
        return onDispatch(action)
      }
      return defaultSnapshot
    },
    snapshot: () => defaultSnapshot,
    toggleWorktreeById: async () => ({ enabled: true, label: null }),
    setWorktreeById: async () => ({ enabled: true, override: true, label: null }),
    setPaused: async () => {},
    togglePaused: async () => ({ paused: true }),
    statusSummary: async () => ({ text: 'ok' }),
  }
}

/**
 * 실제 사용자 홈에 쓰지 않도록 제어 파일 함수를 가짜로 만든다.
 *
 * @param {{order?: string[], failWrite?: Error}} [options]
 */
function createFakeControlFile({ order, failWrite } = {}) {
  const calls = { write: [], remove: [], install: [] }
  return {
    calls,
    writeControlFile: async (options) => {
      calls.write.push(options)
      if (order) order.push('write')
      if (failWrite) throw failWrite
      return { dir: '', file: '', cli: '' }
    },
    removeControlFile: async (options) => {
      calls.remove.push(options)
      if (order) order.push('remove')
      return true
    },
    installCli: async (options) => {
      calls.install.push(options)
      if (order) order.push('install')
      return ''
    },
  }
}

/**
 * 조건이 참이 될 때까지 실제 시간으로 폴링한다(background activate 작업 대기).
 *
 * @param {() => boolean} predicate
 * @param {{timeoutMs?: number}} [options]
 */
async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/**
 * 실제 사용자 경로에 접근하지 않도록 resolveBinding 실패와 무해한 제어 파일
 * 함수를 기본 주입한 deps.
 *
 * @param {{orchestrator?: object, startDashboard?: () => Promise<object>, control?: object}} [options]
 */
function baseDeps({ orchestrator, startDashboard, control } = {}) {
  const { coordinator } = createFakeCoordinator()
  const controlFile = control ?? createFakeControlFile()
  return {
    resolveBinding: async () => {
      throw new LocationError('metadata_missing', 'test injection')
    },
    createCoordinator: () => orchestrator ?? coordinator,
    startDashboard,
    writeControlFile: controlFile.writeControlFile,
    removeControlFile: controlFile.removeControlFile,
    installCli: controlFile.installCli,
  }
}

/** manifest를 JSON으로 읽는다. */
async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
}

test('activate는 동기 반환하고 manifest의 명령 8개·이벤트 2개를 정확히 등록한다', async () => {
  const { orca, commands, registeredCommandOrder, eventRegistrations } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps())
  const startedAt = Date.now()
  plugin.activate()
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 1000, `activate가 ${elapsed}ms 소요`)
  assert.equal(plugin.activate(), undefined, 'activate는 undefined를 반환한다')

  const manifest = await readManifest()
  const manifestCommandIds = manifest.contributes.commands.map((command) => command.id).sort()
  const registeredIds = [...commands.keys()].sort()
  assert.deepEqual(registeredIds, manifestCommandIds)
  assert.deepEqual(registeredCommandOrder.slice().sort(), manifestCommandIds)
  assert.equal(registeredCommandOrder.length, 8, '명령은 정확히 8개 등록된다')
  assert.equal(new Set(registeredCommandOrder).size, 8, '중복 등록이 없다')

  const manifestEventNames = manifest.contributes.events.map((event) => event.on).sort()
  assert.deepEqual(
    eventRegistrations.map((entry) => entry.event).sort(),
    manifestEventNames,
  )
  assert.equal(eventRegistrations.length, 2, '이벤트는 정확히 2개 등록된다')
  for (const entry of eventRegistrations) {
    assert.equal(typeof entry.handler, 'function')
  }

  await plugin.deactivate()
})

test('main.mjs import만으로 타이머·서버 같은 부작용이 없다', () => {
  const script = `await import(${JSON.stringify(MAIN_URL)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
    encoding: 'utf8',
  })
  assert.equal(
    result.error,
    undefined,
    result.error ? `자식 프로세스 오류: ${String(result.error)}` : '',
  )
  assert.equal(result.signal, null, `자식 프로세스가 종료되지 않음(signal=${result.signal})`)
  assert.equal(result.status, 0, `자식 프로세스 실패: ${result.stderr}`)
})

test('terminal:send 미허용이면 coordinator.start를 호출하지 않는다', async () => {
  const { coordinator, calls } = createFakeCoordinator()
  const { orca, logs } = createFakeOrca({
    grantedCapabilities: ALL_CAPABILITIES.filter((kind) => kind !== 'terminal:send'),
  })
  const plugin = createPlugin(orca, baseDeps({ orchestrator: coordinator }))
  plugin.activate()

  assert.equal(calls.start, 0, 'terminal:send 없이는 start하지 않는다')
  assert.ok(
    logs.some((line) => line.includes('safety_skipped')),
    '권한 부족을 진단에 남긴다',
  )

  await plugin.deactivate()
})

test('terminal:send가 허용되면 coordinator.start를 정확히 한 번 호출한다', async () => {
  const { coordinator, calls } = createFakeCoordinator()
  const { orca } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps({ orchestrator: coordinator }))
  plugin.activate()

  assert.equal(calls.start, 1)
  await plugin.deactivate()
  assert.equal(calls.stop, 1)
})

test('createPlugin은 coordinator에 hostCall과 실제 title indicator 팩토리를 주입한다', async () => {
  const { coordinator } = createFakeCoordinator()
  const { orca } = createFakeOrca()
  let captured = null
  const plugin = createPlugin(orca, {
    ...baseDeps({ orchestrator: coordinator }),
    createCoordinator: (options) => {
      captured = options
      return coordinator
    },
  })
  plugin.activate()

  assert.ok(captured, 'coordinator 옵션이 전달된다')
  assert.equal(typeof captured.hostCall, 'function')
  assert.equal(typeof captured.createTitleIndicator, 'function')

  // 실제 팩토리가 주입됐는지 계약대로 가볍게 확인한다(부작용 없음).
  const indicator = captured.createTitleIndicator({
    rpc: { call: async () => ({ tabs: [] }) },
    hostCall: async () => ({ value: undefined }),
    clock: noopClock,
    diagnostics: { record() {} },
  })
  assert.equal(typeof indicator.reconcile, 'function')
  assert.equal(typeof indicator.restoreAll, 'function')

  await plugin.deactivate()
})

test('createPlugin은 epochMemory를 만들어 coordinator에 전달하고 dashboard model에 hashTarget을 준다', async () => {
  const { coordinator } = createFakeCoordinator()
  const { orca } = createFakeOrca()
  let epochOptions = null
  let coordinatorOptions = null
  let modelOptions = null
  const fakeEpochMemory = {
    load: async () => {},
    get: () => null,
    remember() {},
    forget() {},
    prune() {},
    flush: async () => {},
  }
  const plugin = createPlugin(orca, {
    ...baseDeps({ orchestrator: coordinator }),
    createEpochMemory: (options) => {
      epochOptions = options
      return fakeEpochMemory
    },
    createCoordinator: (options) => {
      coordinatorOptions = options
      return coordinator
    },
    createDashboardModel: (options) => {
      modelOptions = options
      return createFakeModel()
    },
  })
  plugin.activate()

  assert.ok(epochOptions, 'createEpochMemory가 호출된다')
  assert.equal(typeof epochOptions.hostCall, 'function')
  assert.equal(coordinatorOptions.epochMemory, fakeEpochMemory, '만든 epochMemory를 coordinator에 전달한다')

  assert.ok(modelOptions, 'createDashboardModel이 호출된다')
  assert.equal(typeof modelOptions.hashTarget, 'function', 'dashboard model에 hashTarget을 전달한다')
  assert.match(modelOptions.hashTarget('w1', 'tab:leaf'), /^[0-9a-f]{12}$/)

  await plugin.deactivate()
})

test('keepalive-status는 런타임 없음 상태 문구를 알림으로 보낸다', async () => {
  const { coordinator } = createFakeCoordinator()
  const { orca, commands, notifications } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps({ orchestrator: coordinator }))
  plugin.activate()

  try {
    const handler = commands.get('keepalive-status')
    assert.equal(typeof handler, 'function')
    await handler()

    // 상태 요약 알림 1건 + 브라우저 열기 실패로 인한 URL 안내 1건.
    assert.equal(notifications.length, 2, '상태 요약 + URL 안내')
    assert.equal(notifications[0].title, 'Cache Keepalive')
    assert.equal(typeof notifications[0].body, 'string')
    assert.ok(notifications[0].body.length > 0)
    assert.equal(notifications[1].title, 'Cache Keepalive')
    assert.ok(
      notifications[1].body.includes('http://127.0.0.1:'),
      `두 번째 알림은 대시보드 URL 안내여야 한다: ${notifications[1].body}`,
    )
  } finally {
    await plugin.deactivate()
  }
})

test('notify가 delivered:false를 반환하면 diagnostics에 not_delivered를 기록하고 예외는 없다', async () => {
  const { orca, commands } = createFakeOrca({ delivered: false })
  const diag = createDiagnostics({ log: () => {} })
  const plugin = createPlugin(orca, {
    ...baseDeps(),
    createDiagnostics: () => diag,
  })
  plugin.activate()

  try {
    const handler = commands.get('keepalive-status')
    await assert.doesNotReject(() => handler())

    const events = diag.snapshot().filter((entry) => entry.event === 'notify_failed')
    assert.equal(events.length, 2, '상태 요약 + URL 안내 모두 not_delivered')
    assert.ok(events.every((entry) => entry.code === 'not_delivered'))
  } finally {
    await plugin.deactivate()
  }
})

test('notify가 throw하면 diagnostics에 host_call_failed를 기록하고 예외는 전파되지 않는다', async () => {
  const { orca, commands } = createFakeOrca({ failNotifications: true })
  const diag = createDiagnostics({ log: () => {} })
  const plugin = createPlugin(orca, {
    ...baseDeps(),
    createDiagnostics: () => diag,
  })
  plugin.activate()

  try {
    const handler = commands.get('keepalive-status')
    await assert.doesNotReject(() => handler())

    const events = diag.snapshot().filter((entry) => entry.event === 'notify_failed')
    assert.equal(events.length, 2, '상태 요약 + URL 안내 모두 host_call_failed')
    assert.ok(events.every((entry) => entry.code === 'host_call_failed'))
  } finally {
    await plugin.deactivate()
  }
})

test('notify가 delivered:true를 반환하면 diagnostics에 notify_failed가 기록되지 않는다', async () => {
  const { orca, commands } = createFakeOrca()
  const diag = createDiagnostics({ log: () => {} })
  const plugin = createPlugin(orca, {
    ...baseDeps(),
    createDiagnostics: () => diag,
  })
  plugin.activate()

  const handler = commands.get('keepalive-status')
  await handler()

  const events = diag.snapshot().filter((entry) => entry.event === 'notify_failed')
  assert.equal(events.length, 0)

  await plugin.deactivate()
})

test('keepalive-open은 대시보드 서버를 시작하고 URL을 알린 뒤 deactivate가 닫는다', async () => {
  const { coordinator } = createFakeCoordinator()
  const { orca, commands, notifications } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps({ orchestrator: coordinator }))
  plugin.activate()

  const handler = commands.get('keepalive-open')
  await handler()

  assert.equal(notifications.length, 1, '브라우저 열기 실패 시에만 URL을 알린다')
  const body = notifications[0].body
  const match = /(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)/.exec(body)
  assert.ok(match, `URL을 찾지 못함: ${body}`)

  const url = match[1]
  const landing = url.split('#')[0]
  const first = await fetch(landing)
  assert.equal(first.status, 200, '대시보드 landing이 응답해야 한다')

  await plugin.deactivate()

  await assert.rejects(fetch(landing), 'deactivate 후에는 서버가 닫혀야 한다')
})

test('deactivate는 두 번 호출해도 안전하다', async () => {
  const { orca } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps())
  plugin.activate()

  await plugin.deactivate()
  await plugin.deactivate()
})

test('activate는 대시보드를 즉시 시작하고 제어 파일·CLI를 설치한다', async () => {
  const { orca } = createFakeOrca()
  const dash = createFakeDashboard({ port: 50123, token: 'tok-abc' })
  const control = createFakeControlFile()
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: dash.startDashboard, control }),
  )
  plugin.activate()

  await waitFor(() => control.calls.install.length === 1)

  assert.equal(dash.calls.start, 1, '대시보드는 한 번 시작한다')
  assert.equal(control.calls.write.length, 1, '제어 파일을 한 번 쓴다')
  const written = control.calls.write[0]
  assert.equal(written.pid, process.pid)
  assert.equal(written.port, 50123)
  assert.equal(written.token, 'tok-abc')

  assert.equal(control.calls.install.length, 1, 'CLI를 한 번 복사한다')
  const sourcePath = control.calls.install[0].sourcePath
  assert.ok(
    sourcePath.endsWith(join('bin', 'keepalive.mjs')),
    `installCli sourcePath가 bin/keepalive.mjs여야 한다: ${sourcePath}`,
  )

  await plugin.deactivate()
})

test('activate 후 open 명령을 실행해도 대시보드를 다시 시작하지 않는다', async () => {
  const { orca, commands } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: dash.startDashboard, control }),
  )
  plugin.activate()

  await waitFor(() => dash.calls.start === 1)
  await waitFor(() => control.calls.install.length === 1)

  await commands.get('keepalive-open')()

  assert.equal(dash.calls.start, 1, 'open 명령도 같은 서버를 재사용한다')
  await plugin.deactivate()
})

test('대시보드 dispatch는 model 결과를 그대로 돌려주고 변경 알림을 1회 보낸다', async () => {
  const { orca, notifications } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const snap = { revision: 2, config: { paused: true }, worktrees: [] }
  const model = createFakeModel({ snapshot: snap })
  const plugin = createPlugin(orca, {
    ...baseDeps({ startDashboard: dash.startDashboard, control }),
    createDashboardModel: () => model,
  })
  plugin.activate()

  await waitFor(() => dash.calls.start === 1)

  const { dispatch } = dash.calls.startOptions[0]
  assert.equal(typeof dispatch, 'function', 'startDashboard가 dispatch를 받는다')
  const action = { type: 'pause', paused: true, expectedRevision: 1 }
  const result = await dispatch(action)

  assert.equal(result, snap, 'model.dispatch 결과가 그대로 반환된다')
  assert.deepEqual(model.dispatched, [action], 'model.dispatch로 action이 전달된다')
  assert.equal(notifications.length, 1, '변경 알림은 정확히 1회')
  assert.equal(notifications[0].title, 'Cache Keepalive')
  assert.equal(notifications[0].body, '모든 keepalive를 껐습니다(일시정지).')

  await plugin.deactivate()
})

test('config action은 대시보드 경로에서 변경 알림을 보내지 않는다', async () => {
  const { orca, notifications } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const snap = { revision: 2, config: { paused: false }, worktrees: [] }
  const plugin = createPlugin(orca, {
    ...baseDeps({ startDashboard: dash.startDashboard, control }),
    createDashboardModel: () => createFakeModel({ snapshot: snap }),
  })
  plugin.activate()

  await waitFor(() => dash.calls.start === 1)
  const { dispatch } = dash.calls.startOptions[0]
  const result = await dispatch({ type: 'config', patch: { paused: true }, expectedRevision: 1 })

  assert.equal(result, snap)
  assert.equal(notifications.length, 0, '설정 변경은 알림을 보내지 않는다')

  await plugin.deactivate()
})

test('model.dispatch가 던지면 변경 알림 없이 예외가 그대로 전파된다', async () => {
  const { orca, notifications } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const boom = Object.assign(new Error('conflict'), { code: 'revision_conflict' })
  const model = createFakeModel({
    onDispatch: async () => {
      throw boom
    },
  })
  const plugin = createPlugin(orca, {
    ...baseDeps({ startDashboard: dash.startDashboard, control }),
    createDashboardModel: () => model,
  })
  plugin.activate()

  await waitFor(() => dash.calls.start === 1)
  const { dispatch } = dash.calls.startOptions[0]

  await assert.rejects(
    dispatch({ type: 'pause', paused: true, expectedRevision: 1 }),
    (error) => error === boom,
  )
  assert.equal(notifications.length, 0, '실패한 dispatch는 알림을 보내지 않는다')

  await plugin.deactivate()
})

test('알림 전송이 실패해도 dispatch 결과는 정상 반환된다', async () => {
  const { orca, notifications } = createFakeOrca({ failNotifications: true })
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const snap = { revision: 2, config: { paused: false }, worktrees: [] }
  const plugin = createPlugin(orca, {
    ...baseDeps({ startDashboard: dash.startDashboard, control }),
    createDashboardModel: () => createFakeModel({ snapshot: snap }),
  })
  plugin.activate()

  await waitFor(() => dash.calls.start === 1)
  const { dispatch } = dash.calls.startOptions[0]
  const result = await dispatch({ type: 'pause', paused: false, expectedRevision: 1 })

  assert.equal(result, snap, '알림 실패가 dispatch 결과를 바꾸지 않는다')
  assert.equal(notifications.length, 0)

  await plugin.deactivate()
})

test('제어 파일 기록 실패는 activate/명령을 막지 않고 토큰을 로그에 남기지 않는다', async () => {
  const token = 'super-secret-token-value'
  const { orca, commands, logs } = createFakeOrca()
  const dash = createFakeDashboard({ token })
  const control = createFakeControlFile({
    failWrite: Object.assign(new Error('denied'), { code: 'EACCES' }),
  })
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: dash.startDashboard, control }),
  )
  plugin.activate()

  await waitFor(() => logs.some((line) => line.includes('control file unavailable')))

  // 명령은 정상 동작한다.
  const handler = commands.get('keepalive-status')
  assert.equal(typeof handler, 'function')
  await handler()

  assert.ok(
    logs.some((line) => line.includes('control file unavailable (EACCES)')),
    `실패 코드를 로그로 남긴다: ${logs.join(' | ')}`,
  )
  assert.ok(!logs.some((line) => line.includes(token)), '토큰이 로그에 남으면 안 된다')
  assert.equal(control.calls.install.length, 0, 'write 실패 뒤 installCli는 호출하지 않는다')

  await plugin.deactivate()
})

test('deactivate는 서버를 닫기 전에 같은 pid로 제어 파일을 지우고 두 번 호출해도 안전하다', async () => {
  const order = []
  const { orca } = createFakeOrca()
  const dash = createFakeDashboard({ order })
  const control = createFakeControlFile({ order })
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: dash.startDashboard, control }),
  )
  plugin.activate()

  await waitFor(() => control.calls.install.length === 1)

  await plugin.deactivate()
  await plugin.deactivate()

  assert.equal(control.calls.remove.length, 1, '두 번 호출해도 remove는 한 번')
  assert.equal(control.calls.remove[0].pid, process.pid)
  assert.ok(
    order.includes('remove') &&
      order.includes('close') &&
      order.indexOf('remove') < order.indexOf('close'),
    `remove가 server close보다 먼저여야 한다: ${order.join(',')}`,
  )
})

test('activate/deactivate는 같은 instanceId로 제어 파일을 쓰고 지운다', async () => {
  const { orca } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: dash.startDashboard, control }),
  )
  plugin.activate()

  await waitFor(() => control.calls.install.length === 1)
  await plugin.deactivate()

  assert.equal(control.calls.write.length, 1)
  assert.equal(control.calls.remove.length, 1)
  const writeId = control.calls.write[0].instanceId
  const removeId = control.calls.remove[0].instanceId
  assert.equal(typeof writeId, 'string', 'instanceId는 문자열이어야 한다')
  assert.ok(writeId.startsWith('cache-keepalive:'), `instanceId 접두어: ${String(writeId)}`)
  assert.equal(removeId, writeId, 'write와 remove가 같은 instanceId를 써야 한다')
})

test('서버가 준비되기 전에 deactivate하면 제어 파일을 쓰지 않는다', async () => {
  const { orca } = createFakeOrca()
  const control = createFakeControlFile()
  let resolveServer
  const deferred = new Promise((resolve) => {
    resolveServer = resolve
  })
  const server = {
    url: 'http://127.0.0.1:1/#token=late',
    port: 1,
    token: 'late',
    async close() {},
  }
  const plugin = createPlugin(
    orca,
    baseDeps({ startDashboard: () => deferred, control }),
  )
  plugin.activate()

  const deactivating = plugin.deactivate()
  resolveServer(server)
  await deactivating

  assert.equal(control.calls.write.length, 0, 'deactivate 뒤에는 제어 파일을 쓰지 않는다')
})

test('default activate와 named deactivate는 등록을 마치고 두 번 호출해도 안전하다', async () => {
  // terminal:send를 빼서 coordinator.start(=실제 경로 접근)를 막는다.
  const { orca, commands } = createFakeOrca({
    grantedCapabilities: ALL_CAPABILITIES.filter((kind) => kind !== 'terminal:send'),
  })
  // default activate는 deps 주입이 없으므로 HOME을 임시 디렉터리로 돌려
  // 실제 사용자 홈에 제어 파일/CLI를 쓰지 않게 한다.
  const home = await mkdtemp(join(tmpdir(), 'okap-act-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const startedAt = Date.now()
    const returned = activateDefault(orca)
    const elapsed = Date.now() - startedAt

    assert.equal(returned, undefined)
    assert.ok(elapsed < 1000, `activate가 ${elapsed}ms 소요`)
    assert.equal(commands.size, 8)

    await deactivate()
    await deactivate()
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('실제 coordinator를 써도 activate는 즉시 반환하고 binding 실패를 삼킨다', async () => {
  const { orca, commands } = createFakeOrca()
  const dash = createFakeDashboard()
  const control = createFakeControlFile()
  const plugin = createPlugin(orca, {
    resolveBinding: async () => {
      throw new LocationError('metadata_missing', 'test injection')
    },
    createCoordinator: (options) => realCreateCoordinator({ ...options, clock: noopClock }),
    startDashboard: dash.startDashboard,
    writeControlFile: control.writeControlFile,
    removeControlFile: control.removeControlFile,
    installCli: control.installCli,
  })
  const startedAt = Date.now()
  plugin.activate()
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 1000, `activate가 ${elapsed}ms 소요`)
  assert.equal(commands.size, 8)

  await plugin.deactivate()
  await plugin.deactivate()
})

test('orca-plugin.json은 스키마 필수 필드와 참조 일관성을 만족한다', async () => {
  const manifest = await readManifest()

  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.id, 'cache-keepalive')
  assert.equal(manifest.publisher, 'runaticmoon')
  assert.equal(manifest.name, 'Cache Keepalive')
  assert.equal(manifest.version, '0.1.8')
  assert.equal(manifest.pluginApi, 1)
  assert.equal(manifest.main, 'main.mjs')
  assert.deepEqual(manifest.engines, { orca: '>=1.4.214' })
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.length > 0)

  // 예약 접두 'orca-' 금지 + kebab-case.
  assert.ok(!manifest.id.startsWith('orca-'), 'id가 예약 접두 orca-로 시작하면 안 된다')
  assert.match(manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.match(manifest.publisher, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)

  const commandIds = manifest.contributes.commands.map((command) => command.id)
  assert.equal(commandIds.length, 8)
  assert.deepEqual(commandIds, [
    'keepalive-open',
    'keepalive-toggle-pause',
    'keepalive-pause',
    'keepalive-resume',
    'keepalive-toggle-worktree',
    'keepalive-worktree-on',
    'keepalive-worktree-off',
    'keepalive-status',
  ])
  for (const command of manifest.contributes.commands) {
    assert.equal(command.action, undefined, '선언형 action을 쓰지 않는다')
    assert.ok(['global', 'worktree'].includes(command.context))
  }

  assert.deepEqual(manifest.contributes.panels, [
    { id: 'keepalive-panel', title: 'Cache Keepalive', icon: 'zap', entry: 'panel/index.html' },
  ])

  const eventNames = manifest.contributes.events.map((event) => event.on)
  assert.deepEqual(eventNames, ['agent.status.changed', 'worktree.removed'])

  assert.equal(manifest.contributes.keybindings.length, 1)
  const keybinding = manifest.contributes.keybindings[0]
  assert.equal(keybinding.command, 'keepalive-open')
  assert.ok(commandIds.includes(keybinding.command), 'keybinding은 존재하는 command를 참조한다')
  assert.equal(keybinding.key, 'Mod+Alt+Shift+J')
  assert.equal(keybinding.when, 'global')

  const capabilityKinds = manifest.capabilities.map((capability) => capability.kind)
  assert.deepEqual(capabilityKinds.sort(), ALL_CAPABILITIES.slice().sort())
})
