import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { COMMAND_IDS, openInOrcaBrowser, registerCommands } from '../src/commands.mjs'

const MANIFEST_URL = new URL('../orca-plugin.json', import.meta.url)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** orca.commands.register 호출을 기록하는 fake. */
function createFakeOrca() {
  const registrations = []
  const orca = {
    commands: {
      register(id, handler) {
        registrations.push({ id, handler })
      },
    },
  }
  return { orca, registrations }
}

/** controller 각 메서드의 호출을 기록하고 주입된 결과를 돌려주는 fake. */
function createFakeController(overrides = {}) {
  const calls = {
    ensureDashboard: [],
    openDashboard: [],
    currentWorktreeId: [],
    toggleWorktree: [],
    setWorktree: [],
    togglePaused: [],
    setPaused: [],
    statusSummary: [],
  }
  const controller = {
    async ensureDashboard() {
      calls.ensureDashboard.push({})
      return { url: 'http://127.0.0.1:1234/#token=tok' }
    },
    async openDashboard(url) {
      calls.openDashboard.push({ url })
      return { opened: true }
    },
    async currentWorktreeId() {
      calls.currentWorktreeId.push({})
      return null
    },
    async toggleWorktree(worktreeId) {
      calls.toggleWorktree.push({ worktreeId })
      return { enabled: true, label: 'main' }
    },
    async setWorktree(worktreeId, enabled) {
      calls.setWorktree.push({ worktreeId, enabled })
      return { enabled, override: enabled, label: 'main' }
    },
    async togglePaused() {
      calls.togglePaused.push({})
      return { paused: true }
    },
    async setPaused(paused) {
      calls.setPaused.push({ paused })
    },
    async statusSummary(options) {
      calls.statusSummary.push({ options })
      return { text: '상태 요약' }
    },
    ...overrides,
  }
  return { controller, calls }
}

/** notify 호출을 기록하는 fake. */
function createFakeNotify() {
  const calls = []
  const notify = async (title, body) => {
    calls.push({ title, body })
  }
  return { notify, calls }
}

/** RPC 호출을 기록하고 주입된 table/결과를 돌려주는 fake. */
function createFakeRpc(handler) {
  const calls = []
  const rpc = {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options })
      return await handler(method, params, options)
    },
  }
  return rpc
}

function setup(overrides = {}, registerOptions = {}) {
  const { orca, registrations } = createFakeOrca()
  const { controller, calls } = createFakeController(overrides)
  const { notify, calls: notifyCalls } = createFakeNotify()
  registerCommands({ orca, controller, notify, ...registerOptions })
  const handlerFor = (id) => {
    const entry = registrations.find((registration) => registration.id === id)
    assert.ok(entry, `handler for ${id} is registered`)
    return entry.handler
  }
  return { registrations, calls, notifyCalls, handlerFor }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('registers exactly the eight command ids once each', () => {
  const { registrations } = setup()
  const ids = registrations.map((registration) => registration.id)
  assert.equal(ids.length, 8)
  assert.deepEqual(new Set(ids).size, 8)
  assert.deepEqual(ids, [
    COMMAND_IDS.open,
    COMMAND_IDS.togglePause,
    COMMAND_IDS.pause,
    COMMAND_IDS.resume,
    COMMAND_IDS.toggleWorktree,
    COMMAND_IDS.worktreeOn,
    COMMAND_IDS.worktreeOff,
    COMMAND_IDS.status,
  ])
  for (const registration of registrations) {
    assert.equal(typeof registration.handler, 'function')
  }
})

test('COMMAND_IDS are the frozen manifest ids', () => {
  assert.deepEqual(COMMAND_IDS, {
    open: 'keepalive-open',
    togglePause: 'keepalive-toggle-pause',
    pause: 'keepalive-pause',
    resume: 'keepalive-resume',
    toggleWorktree: 'keepalive-toggle-worktree',
    worktreeOn: 'keepalive-worktree-on',
    worktreeOff: 'keepalive-worktree-off',
    status: 'keepalive-status',
  })
  assert.ok(Object.isFrozen(COMMAND_IDS))
})

test('manifest command ids equal COMMAND_IDS exactly, without duplicates', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
  const manifestIds = manifest.contributes.commands.map((command) => command.id)

  assert.deepEqual([...manifestIds].sort(), Object.values(COMMAND_IDS).sort())
  assert.equal(new Set(manifestIds).size, manifestIds.length, '중복 command id가 없다')
  for (const command of manifest.contributes.commands) {
    assert.ok(['global', 'worktree'].includes(command.context), `${command.id}는 유효한 context를 가진다`)
  }
})

// ---------------------------------------------------------------------------
// openInOrcaBrowser
// ---------------------------------------------------------------------------

test('openInOrcaBrowser sends an exact host/server browser.tabCreate without worktree', async () => {
  const rpc = createFakeRpc(async () => ({ browserPageId: 'page-1' }))
  const result = await openInOrcaBrowser({ rpc, url: 'http://127.0.0.1:1/#token=secret' })

  assert.deepEqual(result, { opened: true, reason: null })
  assert.equal(rpc.calls.length, 1)
  const call = rpc.calls[0]
  assert.equal(call.method, 'browser.tabCreate')
  assert.deepEqual(call.params, {
    url: 'http://127.0.0.1:1/#token=secret',
    activate: true,
    navigation: 'host',
    waitForRegistration: false,
    placement: { kind: 'server' },
  })
  assert.ok(!Object.prototype.hasOwnProperty.call(call.params, 'worktree'))
  assert.equal(call.options.timeoutMs, 10000)
})

test('openInOrcaBrowser prefixes worktree as id:', async () => {
  const rpc = createFakeRpc(async () => ({ browserPageId: 'page-2' }))
  const result = await openInOrcaBrowser({
    rpc,
    url: 'http://127.0.0.1:1/#token=secret',
    worktreeId: 'wt-9',
  })

  assert.equal(result.opened, true)
  assert.deepEqual(rpc.calls[0].params, {
    url: 'http://127.0.0.1:1/#token=secret',
    activate: true,
    navigation: 'host',
    waitForRegistration: false,
    placement: { kind: 'server' },
    worktree: 'id:wt-9',
  })
})

test('openInOrcaBrowser reports browser_unavailable when the result has no page id', async () => {
  const rpc = createFakeRpc(async () => ({}))
  const result = await openInOrcaBrowser({ rpc, url: 'http://127.0.0.1:1/#token=secret' })
  assert.deepEqual(result, { opened: false, reason: 'browser_unavailable' })
})

test('openInOrcaBrowser maps exceptions to browser_unavailable and never retries', async () => {
  const rpc = createFakeRpc(async () => {
    const error = new Error('boom http://127.0.0.1:1/#token=secret')
    error.code = 'runtime_unavailable'
    throw error
  })
  const result = await openInOrcaBrowser({ rpc, url: 'http://127.0.0.1:1/#token=secret' })

  assert.deepEqual(result, { opened: false, reason: 'browser_unavailable' })
  assert.equal(rpc.calls.length, 1, 'no retry')
  assert.ok(!result.reason.includes('http'))
})

test('openInOrcaBrowser passes an abort signal through', async () => {
  const controller = new AbortController()
  const rpc = createFakeRpc(async () => ({ browserPageId: 'page-3' }))
  await openInOrcaBrowser({ rpc, url: 'http://127.0.0.1:1/', signal: controller.signal })
  assert.equal(rpc.calls[0].options.signal, controller.signal)
})

// ---------------------------------------------------------------------------
// open handler
// ---------------------------------------------------------------------------

test('open handler is silent on success and never exposes the URL', async () => {
  const { notifyCalls, handlerFor, calls } = setup()
  await handlerFor(COMMAND_IDS.open)()

  assert.equal(calls.ensureDashboard.length, 1)
  assert.equal(calls.openDashboard.length, 1)
  assert.equal(calls.openDashboard[0].url, 'http://127.0.0.1:1234/#token=tok')
  assert.equal(notifyCalls.length, 0)
})

test('open handler notifies with the URL only when opening failed', async () => {
  const { notifyCalls, handlerFor } = setup({
    async openDashboard() {
      return { opened: false }
    },
  })
  await handlerFor(COMMAND_IDS.open)()

  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].title, 'Cache Keepalive')
  assert.ok(notifyCalls[0].body.includes('http://127.0.0.1:1234/#token=tok'))
})

// ---------------------------------------------------------------------------
// toggleWorktree handler
// ---------------------------------------------------------------------------

test('toggle handler with unknown worktree notifies and does not call toggleWorktree', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return null
    },
  })
  await handlerFor(COMMAND_IDS.toggleWorktree)()

  assert.equal(calls.toggleWorktree.length, 0)
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '현재 워크트리를 특정할 수 없습니다. 대시보드에서 선택하세요.')
})

test('toggle handler reports the label and new state', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return 'wt-1'
    },
    async toggleWorktree(worktreeId) {
      calls.toggleWorktree.push({ worktreeId })
      return { enabled: true, label: 'feature/x' }
    },
  })
  await handlerFor(COMMAND_IDS.toggleWorktree)()

  assert.deepEqual(calls.toggleWorktree, [{ worktreeId: 'wt-1' }])
  assert.equal(notifyCalls[0].body, 'feature/x: keepalive 켜짐')
})

test('toggle handler falls back to a generic label and reports off', async () => {
  const { notifyCalls, handlerFor } = setup({
    async currentWorktreeId() {
      return 'wt-1'
    },
    async toggleWorktree() {
      return { enabled: false, label: null }
    },
  })
  await handlerFor(COMMAND_IDS.toggleWorktree)()

  assert.equal(notifyCalls[0].body, '현재 워크트리: keepalive 꺼짐')
})

// ---------------------------------------------------------------------------
// togglePause handler
// ---------------------------------------------------------------------------

test('togglePause calls controller.togglePaused and notifies when resumed', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async togglePaused() {
      calls.togglePaused.push({})
      return { paused: false }
    },
  })
  await handlerFor(COMMAND_IDS.togglePause)()

  assert.equal(calls.togglePaused.length, 1)
  assert.equal(calls.setPaused.length, 0, 'isPaused/setPaused 대신 togglePaused를 쓴다')
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].title, 'Cache Keepalive')
  assert.equal(
    notifyCalls[0].body,
    '모든 keepalive를 켰습니다. (Orca 프롬프트 캐시 타이머 설정과 상한은 그대로 적용됩니다)',
  )
})

test('togglePause notifies paused when the controller returns paused true', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async togglePaused() {
      calls.togglePaused.push({})
      return { paused: true }
    },
  })
  await handlerFor(COMMAND_IDS.togglePause)()

  assert.equal(calls.togglePaused.length, 1)
  assert.equal(calls.setPaused.length, 0)
  assert.equal(notifyCalls[0].body, '모든 keepalive를 껐습니다(일시정지).')
})

test('togglePause toggles in both directions on consecutive calls', async () => {
  let paused = false
  const { notifyCalls, handlerFor, calls } = setup({
    async togglePaused() {
      calls.togglePaused.push({})
      paused = !paused
      return { paused }
    },
  })

  await handlerFor(COMMAND_IDS.togglePause)()
  await handlerFor(COMMAND_IDS.togglePause)()

  assert.deepEqual(calls.togglePaused, [{}, {}])
  assert.deepEqual(
    notifyCalls.map((call) => call.body),
    [
      '모든 keepalive를 껐습니다(일시정지).',
      '모든 keepalive를 켰습니다. (Orca 프롬프트 캐시 타이머 설정과 상한은 그대로 적용됩니다)',
    ],
  )
})

// ---------------------------------------------------------------------------
// worktreeOn / worktreeOff handlers
// ---------------------------------------------------------------------------

test('worktreeOn enables the current worktree and reports the label', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return 'wt-1'
    },
    async setWorktree(worktreeId, enabled) {
      calls.setWorktree.push({ worktreeId, enabled })
      return { enabled: true, override: true, label: 'feature/x' }
    },
  })
  await handlerFor(COMMAND_IDS.worktreeOn)()

  assert.deepEqual(calls.setWorktree, [{ worktreeId: 'wt-1', enabled: true }])
  assert.equal(calls.toggleWorktree.length, 0)
  assert.equal(notifyCalls[0].body, 'feature/x: keepalive 켜짐')
})

test('worktreeOff disables the current worktree and falls back to a generic label', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return 'wt-1'
    },
    async setWorktree(worktreeId, enabled) {
      calls.setWorktree.push({ worktreeId, enabled })
      return { enabled: false, override: false, label: null }
    },
  })
  await handlerFor(COMMAND_IDS.worktreeOff)()

  assert.deepEqual(calls.setWorktree, [{ worktreeId: 'wt-1', enabled: false }])
  assert.equal(notifyCalls[0].body, '현재 워크트리: keepalive 꺼짐')
})

test('worktreeOn reports success state even when the store returns a disabled override', async () => {
  const { notifyCalls, handlerFor } = setup({
    async currentWorktreeId() {
      return 'wt-2'
    },
    async setWorktree() {
      return { enabled: false, override: false, label: 'main' }
    },
  })
  await handlerFor(COMMAND_IDS.worktreeOn)()

  assert.equal(notifyCalls[0].body, 'main: keepalive 꺼짐')
})

test('worktreeOn with unknown worktree notifies and does not call setWorktree', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return null
    },
  })
  await handlerFor(COMMAND_IDS.worktreeOn)()

  assert.equal(calls.setWorktree.length, 0)
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '현재 워크트리를 특정할 수 없습니다. 대시보드에서 선택하세요.')
})

test('worktreeOff with unknown worktree notifies and does not call setWorktree', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      return undefined
    },
  })
  await handlerFor(COMMAND_IDS.worktreeOff)()

  assert.equal(calls.setWorktree.length, 0)
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '현재 워크트리를 특정할 수 없습니다. 대시보드에서 선택하세요.')
})

test('worktreeOn/Off controller errors become a safe code notification', async () => {
  const { notifyCalls, handlerFor } = setup({
    async currentWorktreeId() {
      return 'wt-1'
    },
    async setWorktree() {
      const error = new Error('storage exploded')
      error.code = 'storage_failed'
      throw error
    },
  })

  await assert.doesNotReject(() => handlerFor(COMMAND_IDS.worktreeOn)())
  assert.equal(notifyCalls[0].body, '명령 실패: storage_failed')

  await assert.doesNotReject(() => handlerFor(COMMAND_IDS.worktreeOff)())
  assert.equal(notifyCalls[1].body, '명령 실패: storage_failed')
})

// ---------------------------------------------------------------------------
// pause / resume / status
// ---------------------------------------------------------------------------

test('pause and resume call setPaused idempotently with fixed messages', async () => {
  const { notifyCalls, handlerFor, calls } = setup()

  await handlerFor(COMMAND_IDS.pause)()
  await handlerFor(COMMAND_IDS.pause)()
  await handlerFor(COMMAND_IDS.resume)()
  await handlerFor(COMMAND_IDS.resume)()

  assert.deepEqual(calls.setPaused, [{ paused: true }, { paused: true }, { paused: false }, { paused: false }])
  assert.deepEqual(
    notifyCalls.map((call) => call.body),
    [
      '모든 keepalive를 일시정지했습니다.',
      '모든 keepalive를 일시정지했습니다.',
      'keepalive를 재개했습니다. (Orca 프롬프트 캐시 타이머 설정과 상한은 그대로 적용됩니다)',
      'keepalive를 재개했습니다. (Orca 프롬프트 캐시 타이머 설정과 상한은 그대로 적용됩니다)',
    ],
  )
})

test('status handler notifies the summary text', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async statusSummary() {
      calls.statusSummary.push({})
      return { text: '대상 2개 / 예약 1개 / 차단 0개' }
    },
  })
  await handlerFor(COMMAND_IDS.status)()

  assert.equal(calls.statusSummary.length, 1)
  assert.equal(notifyCalls[0].title, 'Cache Keepalive')
  assert.equal(notifyCalls[0].body, '대상 2개 / 예약 1개 / 차단 0개')
})

test('status handler passes the current worktree id to statusSummary', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      calls.currentWorktreeId.push({})
      return 'wt-1'
    },
  })
  await handlerFor(COMMAND_IDS.status)()

  assert.equal(calls.currentWorktreeId.length, 1)
  assert.deepEqual(calls.statusSummary, [{ options: { currentWorktreeId: 'wt-1' } }])
  assert.equal(notifyCalls[0].body, '상태 요약')
})

test('status handler notifies with a null id when currentWorktreeId fails', async () => {
  const { notifyCalls, handlerFor, calls } = setup({
    async currentWorktreeId() {
      throw new Error('runtime gone')
    },
  })

  await assert.doesNotReject(() => handlerFor(COMMAND_IDS.status)())
  assert.deepEqual(calls.statusSummary, [{ options: { currentWorktreeId: null } }])
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '상태 요약')
})

// ---------------------------------------------------------------------------
// error containment + timeout
// ---------------------------------------------------------------------------

test('controller errors become a safe code notification without propagating', async () => {
  const { notifyCalls, handlerFor } = setup({
    async setPaused() {
      const error = new Error('storage exploded')
      error.code = 'storage_failed'
      throw error
    },
  })

  await assert.doesNotReject(() => handlerFor(COMMAND_IDS.pause)())
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '명령 실패: storage_failed')
})

test('unknown error shapes collapse to internal', async () => {
  const { notifyCalls, handlerFor } = setup({
    async statusSummary() {
      const error = new Error('nope')
      error.code = 'Not A Code!'
      throw error
    },
  })
  await handlerFor(COMMAND_IDS.status)()

  assert.equal(notifyCalls[0].body, '명령 실패: internal')
})

test('notify failures never make a handler reject', async () => {
  const { orca, registrations } = createFakeOrca()
  const { controller } = createFakeController({
    async currentWorktreeId() {
      return null
    },
  })
  const notify = async () => {
    throw new Error('notification channel down')
  }
  registerCommands({ orca, controller, notify })
  const handler = registrations.find((r) => r.id === COMMAND_IDS.toggleWorktree).handler

  await assert.doesNotReject(() => handler())
})

test('a slow controller is cut off by the injected timeout', async () => {
  const { notifyCalls, handlerFor } = setup(
    {
      async statusSummary() {
        return await new Promise(() => {})
      },
    },
    { timeoutMs: 25 },
  )

  const started = Date.now()
  await handlerFor(COMMAND_IDS.status)()
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2000, `handler resolved promptly (took ${elapsed}ms)`)
  assert.equal(notifyCalls.length, 1)
  assert.equal(notifyCalls[0].body, '명령 실패: command_timeout')
})
