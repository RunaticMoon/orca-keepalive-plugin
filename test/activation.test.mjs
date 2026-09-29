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
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import activateDefault, { createPlugin, deactivate } from '../main.mjs'
import { LocationError } from '../src/runtime-location.mjs'
import { createCoordinator as realCreateCoordinator } from '../src/coordinator.mjs'

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
 * @param {{grantedCapabilities?: string[]}} [options]
 */
function createFakeOrca({ grantedCapabilities = ALL_CAPABILITIES } = {}) {
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
          notifications.push(params)
          return { ok: true }
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
 * 실제 사용자 경로에 접근하지 않도록 resolveBinding 실패를 주입한 deps.
 *
 * @param {{orchestrator?: object}} [options]
 */
function baseDeps({ orchestrator } = {}) {
  const { coordinator } = createFakeCoordinator()
  return {
    resolveBinding: async () => {
      throw new LocationError('metadata_missing', 'test injection')
    },
    createCoordinator: () => orchestrator ?? coordinator,
  }
}

/** manifest를 JSON으로 읽는다. */
async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
}

test('activate는 동기 반환하고 manifest의 명령 5개·이벤트 2개를 정확히 등록한다', async () => {
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
  assert.equal(registeredCommandOrder.length, 5, '명령은 정확히 5개 등록된다')
  assert.equal(new Set(registeredCommandOrder).size, 5, '중복 등록이 없다')

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

test('keepalive-status는 런타임 없음 상태 문구를 알림으로 보낸다', async () => {
  const { coordinator } = createFakeCoordinator()
  const { orca, commands, notifications } = createFakeOrca()
  const plugin = createPlugin(orca, baseDeps({ orchestrator: coordinator }))
  plugin.activate()

  const handler = commands.get('keepalive-status')
  assert.equal(typeof handler, 'function')
  await handler()

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].title, 'Cache Keepalive')
  assert.equal(typeof notifications[0].body, 'string')
  assert.ok(notifications[0].body.length > 0)

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

test('default activate와 named deactivate는 등록을 마치고 두 번 호출해도 안전하다', async () => {
  // terminal:send를 빼서 coordinator.start(=실제 경로 접근)를 막는다.
  const { orca, commands } = createFakeOrca({
    grantedCapabilities: ALL_CAPABILITIES.filter((kind) => kind !== 'terminal:send'),
  })
  const startedAt = Date.now()
  const returned = activateDefault(orca)
  const elapsed = Date.now() - startedAt

  assert.equal(returned, undefined)
  assert.ok(elapsed < 1000, `activate가 ${elapsed}ms 소요`)
  assert.equal(commands.size, 5)

  await deactivate()
  await deactivate()
})

test('실제 coordinator를 써도 activate는 즉시 반환하고 binding 실패를 삼킨다', async () => {
  const { orca, commands } = createFakeOrca()
  const plugin = createPlugin(orca, {
    resolveBinding: async () => {
      throw new LocationError('metadata_missing', 'test injection')
    },
    createCoordinator: (options) => realCreateCoordinator({ ...options, clock: noopClock }),
  })
  const startedAt = Date.now()
  plugin.activate()
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 1000, `activate가 ${elapsed}ms 소요`)
  assert.equal(commands.size, 5)

  await plugin.deactivate()
  await plugin.deactivate()
})

test('orca-plugin.json은 스키마 필수 필드와 참조 일관성을 만족한다', async () => {
  const manifest = await readManifest()

  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.id, 'cache-keepalive')
  assert.equal(manifest.publisher, 'runaticmoon')
  assert.equal(manifest.name, 'Cache Keepalive')
  assert.equal(manifest.version, '0.1.0')
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
  assert.equal(commandIds.length, 5)
  assert.deepEqual(commandIds, [
    'keepalive-open',
    'keepalive-toggle-worktree',
    'keepalive-pause',
    'keepalive-resume',
    'keepalive-status',
  ])
  for (const command of manifest.contributes.commands) {
    assert.equal(command.action, undefined, '선언형 action을 쓰지 않는다')
    assert.ok(['global', 'worktree'].includes(command.context))
  }

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
