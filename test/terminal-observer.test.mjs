import test from 'node:test'
import assert from 'node:assert/strict'

import { createObserver, projectNameFromPath, branchNameFromRef } from '../src/terminal-observer.mjs'
import { RpcError } from '../src/rpc-client.mjs'
import { REASON_CODES } from '../src/contracts.mjs'

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/**
 * method→응답(값/함수/Error) map을 사용하고 호출을 기록하는 fake rpc.
 * signal이 이미 abort면 RpcError('aborted')를 던진다.
 * @param {Record<string, unknown>} table
 */
function createFakeRpc(table = {}) {
  const calls = []
  const rpc = {
    calls,
    async call(method, params, options = {}) {
      calls.push({ method, params, options })
      if (options?.signal?.aborted) {
        throw new RpcError('aborted', 'aborted', { phase: 'connect' })
      }
      const entry = table[method]
      if (entry instanceof Error) {
        throw entry
      }
      if (typeof entry === 'function') {
        return await entry(params, options)
      }
      if (entry === undefined) {
        throw new Error(`unexpected method ${method}`)
      }
      return entry
    },
  }
  rpc.callsFor = (method) => calls.filter((call) => call.method === method)
  return rpc
}

/**
 * hostCall 함수를 만들고 호출을 기록한다. result가 Error면 던진다.
 * @param {unknown} result
 */
function createFakeHostCall(result) {
  const calls = []
  const fn = async (method, params) => {
    calls.push({ method, params })
    if (result instanceof Error) {
      throw result
    }
    return result
  }
  fn.calls = calls
  return fn
}

const HANDLE_1 = 'terminal:local:1'

/** RuntimeTerminalSummary 기본값. */
function summary(overrides = {}) {
  return {
    handle: HANDLE_1,
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    branch: 'main',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'Claude',
    connected: true,
    writable: true,
    lastOutputAt: 1000,
    preview: 'secret preview',
    agentIdentity: 'claude',
    executionHostId: 'local',
    ...overrides,
  }
}

function listResult(terminals, extra = {}) {
  return { terminals, totalCount: terminals.length, truncated: false, ...extra }
}

function showResult(overrides = {}, terminalOverrides = {}) {
  return { terminal: { ...summary(terminalOverrides), ...overrides } }
}

function agentStatusResult(overrides = {}) {
  return { agentStatus: { handle: HANDLE_1, isRunningAgent: true, status: 'idle', ...overrides } }
}

function readResult(overrides = {}) {
  return {
    terminal: {
      handle: HANDLE_1,
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null,
      source: 'screen',
      ...overrides,
    },
  }
}

const TARGET = Object.freeze({
  worktreeId: 'wt-1',
  paneKey: 'tab-1:leaf-1',
  handle: HANDLE_1,
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
})

function observerFor(table, { hostCall = async () => null, now = () => 42 } = {}) {
  const rpc = createFakeRpc(table)
  return { rpc, observer: createObserver({ rpc, hostCall, now }) }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list: 정상 row를 TerminalRow로 변환하고 사용하지 않는 필드는 버린다', async () => {
  const { rpc, observer } = observerFor({
    'terminal.list': listResult([summary({ title: 'x'.repeat(250) })]),
  })

  const catalog = await observer.list()

  assert.equal(catalog.complete, true)
  assert.equal(catalog.fetchedAt, 42)
  assert.equal(catalog.terminals.length, 1)
  const row = catalog.terminals[0]
  assert.equal(row.handle, HANDLE_1)
  assert.equal(row.worktreeId, 'wt-1')
  assert.equal(row.tabId, 'tab-1')
  assert.equal(row.leafId, 'leaf-1')
  assert.equal(row.paneKey, 'tab-1:leaf-1')
  assert.equal(row.ptyId, 'pty-1')
  assert.equal(row.incarnationId, 'inc-1')
  assert.equal(row.title.length, 200)
  assert.equal(row.branch, 'main')
  assert.equal(row.branchName, 'main')
  assert.equal(row.projectName, 'repo')
  assert.equal(row.connected, true)
  assert.equal(row.writable, true)
  assert.equal(row.lastOutputAt, 1000)
  assert.equal(row.agentIdentity, 'claude')
  assert.equal(row.executionHostId, 'local')
  assert.equal(row.supported, true)
  assert.equal(row.unsupportedReason, null)
  assert.ok(!('preview' in row))
  assert.ok(!('worktreePath' in row))

  assert.deepEqual(rpc.callsFor('terminal.list')[0].params, {
    limit: 1000,
    includeVisualLayouts: false,
    requireFreshPtyLiveness: true,
  })
})

test('list: truncated=true면 complete=false', async () => {
  const { observer } = observerFor({
    'terminal.list': listResult([summary()], { truncated: true }),
  })
  const catalog = await observer.list()
  assert.equal(catalog.complete, false)
  assert.equal(catalog.terminals.length, 1)
})

test('list: truncated 키가 없으면 complete=false', async () => {
  const { observer } = observerFor({
    'terminal.list': { terminals: [summary()], totalCount: 1 },
  })
  const catalog = await observer.list()
  assert.equal(catalog.complete, false)
})

test('list: 형식이 틀린 row는 제외하고 complete=false', async () => {
  const rows = [
    summary(),
    summary({ handle: 123 }),
    summary({ leafId: undefined }),
    summary({ connected: 'yes' }),
    summary({ handle: 'terminal:local:2' }),
  ]
  const { observer } = observerFor({ 'terminal.list': listResult(rows) })
  const catalog = await observer.list()
  assert.equal(catalog.complete, false)
  assert.deepEqual(
    catalog.terminals.map((row) => row.handle),
    [HANDLE_1, 'terminal:local:2'],
  )
})

test('list: terminals가 배열이 아니면 complete=false이고 빈 목록', async () => {
  const { observer } = observerFor({ 'terminal.list': { terminals: null, truncated: false } })
  const catalog = await observer.list()
  assert.equal(catalog.complete, false)
  assert.deepEqual(catalog.terminals, [])
})

test('list: ptyId/incarnationId/title/branch 누락은 null로 유지', async () => {
  const raw = {
    handle: HANDLE_1,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    connected: true,
    writable: true,
  }
  const { observer } = observerFor({ 'terminal.list': listResult([raw]) })
  const catalog = await observer.list()
  const row = catalog.terminals[0]
  assert.equal(catalog.complete, true)
  assert.equal(row.ptyId, null)
  assert.equal(row.incarnationId, null)
  assert.equal(row.title, null)
  assert.equal(row.branch, null)
  assert.equal(row.branchName, null)
  assert.equal(row.projectName, null)
  assert.equal(row.lastOutputAt, null)
  assert.equal(row.agentIdentity, null)
  assert.equal(row.executionHostId, null)
})

test('projectNameFromPath: /와 \\ 구분자, 끝 구분자 무시, 빈 값은 null', () => {
  assert.equal(projectNameFromPath('/Users/me/dev/route-dashboard'), 'route-dashboard')
  assert.equal(projectNameFromPath('C:\\Users\\me\\route-dashboard'), 'route-dashboard')
  assert.equal(projectNameFromPath('/Users/me/dev/route-dashboard/'), 'route-dashboard')
  assert.equal(projectNameFromPath('route-dashboard'), 'route-dashboard')
  assert.equal(projectNameFromPath('/'), null)
  assert.equal(projectNameFromPath(''), null)
  assert.equal(projectNameFromPath(null), null)
  assert.equal(projectNameFromPath(42), null)
})

test('branchNameFromRef: refs/heads 제거, 없으면 원문, 빈 값은 null', () => {
  assert.equal(branchNameFromRef('refs/heads/main'), 'main')
  assert.equal(branchNameFromRef('refs/heads/feature/x'), 'feature/x')
  assert.equal(branchNameFromRef('main'), 'main')
  assert.equal(branchNameFromRef('refs/heads/'), null)
  assert.equal(branchNameFromRef(''), null)
  assert.equal(branchNameFromRef(null), null)
  assert.equal(branchNameFromRef(42), null)
})

test('branchNameFromRef: refs/remotes와 refs/tags도 짧게 정리한다', () => {
  assert.equal(branchNameFromRef('refs/remotes/origin/x'), 'origin/x')
  assert.equal(branchNameFromRef('refs/remotes/upstream/feature/y'), 'upstream/feature/y')
  assert.equal(branchNameFromRef('refs/tags/v1'), 'v1')
  assert.equal(branchNameFromRef('refs/tags/release/2.0'), 'release/2.0')
})

test('branchNameFromRef: 그 외 refs/ 접두어는 첫 구성요소를 뺀 나머지, 비면 null', () => {
  assert.equal(branchNameFromRef('refs/notes/commits'), 'commits')
  assert.equal(branchNameFromRef('refs/pull/123/head'), '123/head')
  // `refs/` 뒤 첫 구성요소만 있고 나머지가 비면 원문 대신 null.
  assert.equal(branchNameFromRef('refs/stash'), null)
  assert.equal(branchNameFromRef('refs/'), null)
  assert.equal(branchNameFromRef('refs/heads/'), null)
})

test('list: worktreePath와 branch ref로 projectName/branchName을 만든다', async () => {
  const { observer } = observerFor({
    'terminal.list': listResult([
      summary({
        handle: 'h-proj',
        worktreePath: '/Users/me/dev/route-dashboard',
        branch: 'refs/heads/main',
      }),
      summary({ handle: 'h-nopath', worktreePath: undefined, branch: 'refs/heads/feature/x' }),
      summary({ handle: 'h-none', worktreePath: undefined, branch: undefined }),
    ]),
  })
  const catalog = await observer.list()
  const byHandle = Object.fromEntries(catalog.terminals.map((row) => [row.handle, row]))
  assert.equal(byHandle['h-proj'].projectName, 'route-dashboard')
  assert.equal(byHandle['h-proj'].branchName, 'main')
  assert.equal(byHandle['h-nopath'].projectName, null)
  assert.equal(byHandle['h-nopath'].branchName, 'feature/x')
  assert.equal(byHandle['h-none'].projectName, null)
  assert.equal(byHandle['h-none'].branchName, null)
  assert.ok(!('worktreePath' in byHandle['h-proj']))
})

test('list: unsupportedReason 우선순위(agent → host → 연결)', async () => {
  const rows = [
    summary({ handle: 'h-agent', agentIdentity: undefined }),
    summary({ handle: 'h-codex', agentIdentity: 'codex' }),
    summary({ handle: 'h-host', executionHostId: 'ssh:box' }),
    summary({ handle: 'h-host-missing', executionHostId: undefined }),
    summary({ handle: 'h-disconnected', connected: false }),
    summary({ handle: 'h-readonly', writable: false }),
    summary({ handle: 'h-nopty', ptyId: null }),
    summary({ handle: 'h-ok' }),
  ]
  const { observer } = observerFor({ 'terminal.list': listResult(rows) })
  const catalog = await observer.list()
  const byHandle = Object.fromEntries(catalog.terminals.map((row) => [row.handle, row]))
  assert.equal(byHandle['h-agent'].unsupportedReason, REASON_CODES.UNSUPPORTED_AGENT)
  assert.equal(byHandle['h-codex'].unsupportedReason, REASON_CODES.UNSUPPORTED_AGENT)
  assert.equal(byHandle['h-host'].unsupportedReason, REASON_CODES.UNSUPPORTED_HOST)
  assert.equal(byHandle['h-host-missing'].unsupportedReason, REASON_CODES.UNSUPPORTED_HOST)
  assert.equal(byHandle['h-disconnected'].unsupportedReason, REASON_CODES.NOT_CONNECTED)
  assert.equal(byHandle['h-readonly'].unsupportedReason, REASON_CODES.NOT_CONNECTED)
  assert.equal(byHandle['h-nopty'].unsupportedReason, REASON_CODES.NOT_CONNECTED)
  assert.equal(byHandle['h-ok'].supported, true)
})

// ---------------------------------------------------------------------------
// resolveEvent
// ---------------------------------------------------------------------------

async function catalogWith(rows) {
  const { observer } = observerFor({ 'terminal.list': listResult(rows) })
  return observer.list()
}

test('resolveEvent: worktreeId와 paneKey가 정확히 일치하는 유일한 row로 매핑', async () => {
  const catalog = await catalogWith([
    summary({ handle: 'h1', tabId: 'tab-1', leafId: 'leaf-1' }),
    summary({ handle: 'h2', tabId: 'tab-1', leafId: 'leaf-2', ptyId: 'pty-2' }),
  ])
  const target = createObserver({ rpc: createFakeRpc(), hostCall: async () => null }).resolveEvent(
    { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-2', state: 'working' },
    catalog,
  )
  assert.deepEqual(target, {
    worktreeId: 'wt-1',
    paneKey: 'tab-1:leaf-2',
    handle: 'h2',
    ptyId: 'pty-2',
    incarnationId: 'inc-1',
  })
})

test('resolveEvent: 같은 branch 다른 worktree를 혼동하지 않는다', async () => {
  const catalog = await catalogWith([
    summary({ handle: 'h1', worktreeId: 'wt-1', branch: 'main' }),
    summary({ handle: 'h2', worktreeId: 'wt-2', branch: 'main' }),
  ])
  const { observer } = observerFor({})
  assert.equal(
    observer.resolveEvent({ worktreeId: 'wt-2', paneKey: 'tab-1:leaf-1' }, catalog).handle,
    'h2',
  )
  assert.equal(observer.resolveEvent({ worktreeId: 'wt-3', paneKey: 'tab-1:leaf-1' }, catalog), null)
})

test('resolveEvent: split pane 두 개를 각각 매핑', async () => {
  const catalog = await catalogWith([
    summary({ handle: 'h-left', tabId: 'tab-9', leafId: 'leaf-left' }),
    summary({ handle: 'h-right', tabId: 'tab-9', leafId: 'leaf-right' }),
  ])
  const { observer } = observerFor({})
  assert.equal(
    observer.resolveEvent({ worktreeId: 'wt-1', paneKey: 'tab-9:leaf-left' }, catalog).handle,
    'h-left',
  )
  assert.equal(
    observer.resolveEvent({ worktreeId: 'wt-1', paneKey: 'tab-9:leaf-right' }, catalog).handle,
    'h-right',
  )
})

test('resolveEvent: 없는 paneKey와 중복 매칭은 null', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1' }), summary({ handle: 'h2' })])
  const { observer } = observerFor({})
  assert.equal(observer.resolveEvent({ worktreeId: 'wt-1', paneKey: 'tab-1:missing' }, catalog), null)
  assert.equal(observer.resolveEvent({ worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }, catalog), null)
})

test('resolveEvent: worktreeId/paneKey가 비어 있으면 null', async () => {
  const catalog = await catalogWith([summary()])
  const { observer } = observerFor({})
  assert.equal(observer.resolveEvent({ worktreeId: null, paneKey: 'tab-1:leaf-1' }, catalog), null)
  assert.equal(observer.resolveEvent({ worktreeId: '', paneKey: 'tab-1:leaf-1' }, catalog), null)
  assert.equal(observer.resolveEvent({ worktreeId: 'wt-1' }, catalog), null)
  assert.equal(observer.resolveEvent(null, catalog), null)
})

test('resolveEvent: payload를 감싼 이벤트도 처리한다', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1' })])
  const { observer } = observerFor({})
  const target = observer.resolveEvent(
    { type: 'HOOK', at: 5, payload: { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' } },
    catalog,
  )
  assert.equal(target.handle, 'h1')
})

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test('inspect: 정상 idle/none/ok를 파싱한다', async () => {
  const { rpc, observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult({ status: 'idle', isRunningAgent: true }),
    'terminal.read': readResult(),
  })

  const observation = await observer.inspect(TARGET)

  assert.equal(observation.target, TARGET)
  assert.equal(observation.observedAt, 42)
  assert.equal(observation.identity, 'claude')
  assert.equal(observation.executionHostId, 'local')
  assert.equal(observation.connected, true)
  assert.equal(observation.writable, true)
  assert.equal(observation.ptyId, 'pty-1')
  assert.equal(observation.incarnationId, 'inc-1')
  assert.equal(observation.lastOutputAt, 1000)
  assert.equal(observation.agentStatus, 'idle')
  assert.equal(observation.isRunningAgent, true)
  assert.equal(observation.agentWait, 'none')
  assert.equal(observation.screen, 'ok')
  assert.equal(observation.screenTruncated, false)
  assert.equal(observation.draft, null)
  assert.equal(observation.stale, false)
  assert.equal(observation.reason, null)
  assert.deepEqual(
    rpc.calls.map((call) => call.method),
    ['terminal.show', 'terminal.agentStatus', 'terminal.read'],
  )
})

test('inspect: agentWait 키가 없으면 unknown이고 UNKNOWN_WAIT', async () => {
  const { observer } = observerFor({
    'terminal.show': { terminal: summary() },
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.agentWait, 'unknown')
  assert.equal(observation.reason, REASON_CODES.UNKNOWN_WAIT)
})

test('inspect: agentWait가 object면 waiting이고 INTERACTIVE_WAIT', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: { source: 'hook', since: 1 } }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.agentWait, 'waiting')
  assert.equal(observation.reason, REASON_CODES.INTERACTIVE_WAIT)
})

test('inspect: status null은 unknown이고 UNKNOWN_WAIT', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult({ status: null, isRunningAgent: true }),
    'terminal.read': readResult(),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.agentStatus, 'unknown')
  assert.equal(observation.isRunningAgent, true)
  assert.equal(observation.reason, REASON_CODES.UNKNOWN_WAIT)
})

test('inspect: agentStatus working은 BUSY, permission은 INTERACTIVE_WAIT', async () => {
  const working = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult({ status: 'working' }),
    'terminal.read': readResult(),
  })
  assert.equal(
    (await working.observer.inspect(TARGET)).reason,
    REASON_CODES.BUSY,
  )

  const permission = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult({ status: 'permission' }),
    'terminal.read': readResult(),
  })
  assert.equal(
    (await permission.observer.inspect(TARGET)).reason,
    REASON_CODES.INTERACTIVE_WAIT,
  )
})

test('inspect: screen-unavailable이면 screen=unknown, SCREEN_UNKNOWN', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult({ source: 'screen-unavailable' }),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.screen, 'unknown')
  assert.equal(observation.screenTruncated, false)
  assert.equal(observation.reason, REASON_CODES.SCREEN_UNKNOWN)
})

test('inspect: draft가 있으면 그대로 담고 DRAFT_PRESENT', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult({ draft: 'cache keepalive text' }),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.draft, 'cache keepalive text')
  assert.equal(observation.reason, REASON_CODES.DRAFT_PRESENT)
})

test('inspect: read의 빈 draft는 null로 본다', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult({ draft: '' }),
  })
  assert.equal((await observer.inspect(TARGET)).draft, null)
})

test('inspect: show의 ptyId가 바뀌면 STALE_TARGET', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }, { ptyId: 'pty-2', incarnationId: 'inc-2' }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.stale, true)
  assert.equal(observation.ptyId, 'pty-2')
  assert.equal(observation.reason, REASON_CODES.STALE_TARGET)
})

test('inspect: handle/worktreeId 불일치도 stale', async () => {
  const handleMismatch = observerFor({
    'terminal.show': showResult({ agentWait: null }, { handle: 'terminal:local:other' }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await handleMismatch.observer.inspect(TARGET)).stale, true)

  const worktreeMismatch = observerFor({
    'terminal.show': showResult({ agentWait: null }, { worktreeId: 'wt-2' }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await worktreeMismatch.observer.inspect(TARGET)).stale, true)
})

test('inspect: incarnationId는 양쪽 다 있을 때만 비교한다', async () => {
  const targetNoIncarnation = { ...TARGET, incarnationId: null }
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }, { incarnationId: 'inc-9' }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await observer.inspect(targetNoIncarnation)).stale, false)
})

test('inspect: read 실패 시 나머지는 유지하고 reason은 RUNTIME_UNAVAILABLE', async () => {
  const failure = new RpcError('runtime_unavailable', 'boom')
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': failure,
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.identity, 'claude')
  assert.equal(observation.agentStatus, 'idle')
  assert.equal(observation.screen, 'unknown')
  assert.equal(observation.screenTruncated, null)
  assert.equal(observation.draft, null)
  assert.equal(observation.reason, REASON_CODES.RUNTIME_UNAVAILABLE)
})

test('inspect: agentStatus 실패는 show/read 결과를 유지한다', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': new RpcError('runtime_timeout', 'timeout'),
    'terminal.read': readResult({ draft: 'd' }),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.agentStatus, 'unknown')
  assert.equal(observation.screen, 'ok')
  assert.equal(observation.draft, 'd')
  assert.equal(observation.reason, REASON_CODES.RUNTIME_UNAVAILABLE)
})

test('inspect: show 실패 시 UNSUPPORTED_AGENT로 오판하지 않고 failure reason을 쓴다', async () => {
  const { observer } = observerFor({
    'terminal.show': new RpcError('runtime_unavailable', 'down'),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  const observation = await observer.inspect(TARGET)
  assert.equal(observation.identity, null)
  assert.equal(observation.agentWait, 'unknown')
  assert.equal(observation.reason, REASON_CODES.RUNTIME_UNAVAILABLE)
})

test('inspect: runtime_mismatch는 WRONG_RUNTIME', async () => {
  const { observer } = observerFor({
    'terminal.show': new RpcError('runtime_mismatch', 'changed'),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await observer.inspect(TARGET)).reason, REASON_CODES.WRONG_RUNTIME)
})

test('inspect: identity/host 불일치는 UNSUPPORTED_AGENT/UNSUPPORTED_HOST', async () => {
  const noAgent = observerFor({
    'terminal.show': showResult({ agentWait: null }, { agentIdentity: undefined }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await noAgent.observer.inspect(TARGET)).reason, REASON_CODES.UNSUPPORTED_AGENT)

  const ssh = observerFor({
    'terminal.show': showResult({ agentWait: null }, { executionHostId: 'ssh:box' }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await ssh.observer.inspect(TARGET)).reason, REASON_CODES.UNSUPPORTED_HOST)
})

test('inspect: disconnected는 NOT_CONNECTED', async () => {
  const { observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }, { connected: false }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  assert.equal((await observer.inspect(TARGET)).reason, REASON_CODES.NOT_CONNECTED)
})

test('inspect: signal abort를 rethrow한다', async () => {
  const controller = new AbortController()
  controller.abort()
  const { observer } = observerFor({})
  await assert.rejects(
    () => observer.inspect(TARGET, { signal: controller.signal }),
    (error) => error.code === 'aborted',
  )
})

test('inspect: 진행 중 abort도 rethrow한다', async () => {
  const controller = new AbortController()
  const { observer } = observerFor({
    'terminal.show': async () => {
      controller.abort()
      return showResult({ agentWait: null })
    },
    'terminal.agentStatus': () => {
      throw new Error('should not run')
    },
  })
  await assert.rejects(
    () => observer.inspect(TARGET, { signal: controller.signal }),
    (error) => error.code === 'aborted',
  )
})

test('inspect: show/agentStatus/read 파라미터와 expectedIncarnationId 전달', async () => {
  const { rpc, observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  await observer.inspect(TARGET)
  assert.deepEqual(rpc.callsFor('terminal.show')[0].params, {
    terminal: HANDLE_1,
    expectedIncarnationId: 'inc-1',
  })
  assert.deepEqual(rpc.callsFor('terminal.agentStatus')[0].params, {
    terminal: HANDLE_1,
    expectedIncarnationId: 'inc-1',
  })
  assert.deepEqual(rpc.callsFor('terminal.read')[0].params, {
    terminal: HANDLE_1,
    expectedIncarnationId: 'inc-1',
    screen: true,
    limit: 200,
  })
})

test('inspect: incarnationId가 없으면 expectedIncarnationId를 보내지 않는다', async () => {
  const { rpc, observer } = observerFor({
    'terminal.show': showResult({ agentWait: null }),
    'terminal.agentStatus': agentStatusResult(),
    'terminal.read': readResult(),
  })
  await observer.inspect({ ...TARGET, incarnationId: null })
  assert.deepEqual(rpc.callsFor('terminal.show')[0].params, { terminal: HANDLE_1 })
  assert.deepEqual(rpc.callsFor('terminal.agentStatus')[0].params, { terminal: HANDLE_1 })
  assert.deepEqual(rpc.callsFor('terminal.read')[0].params, {
    terminal: HANDLE_1,
    screen: true,
    limit: 200,
  })
})

// ---------------------------------------------------------------------------
// currentWorktree
// ---------------------------------------------------------------------------

test('currentWorktree: context handles join 결과가 하나면 그 worktreeId', async () => {
  const catalog = await catalogWith([
    summary({ handle: 'h1', worktreeId: 'wt-1' }),
    summary({ handle: 'h2', worktreeId: 'wt-1' }),
  ])
  const hostCall = createFakeHostCall({
    branch: 'main',
    displayName: 'Repo',
    terminals: [{ id: 'h1' }, { id: 'h2' }],
  })
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), 'wt-1')
  assert.equal(hostCall.calls.length, 1)
  assert.equal(hostCall.calls[0].method, 'workspace.readContext')
})

test('currentWorktree: join 결과가 복수면 null', async () => {
  const catalog = await catalogWith([
    summary({ handle: 'h1', worktreeId: 'wt-1' }),
    summary({ handle: 'h2', worktreeId: 'wt-2' }),
  ])
  const hostCall = createFakeHostCall({ terminals: [{ id: 'h1' }, { id: 'h2' }] })
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), null)
})

test('currentWorktree: catalog에 없는 handle은 무시한다', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1', worktreeId: 'wt-1' })])
  const hostCall = createFakeHostCall({ terminals: [{ id: 'h1' }, { id: 'unknown' }] })
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), 'wt-1')
})

test('currentWorktree: context가 null이거나 terminals가 비면 null', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1', worktreeId: 'wt-1' })])
  const nullHost = createFakeHostCall(null)
  assert.equal(await observerFor({}, { hostCall: nullHost }).observer.currentWorktree(catalog), null)

  const emptyHost = createFakeHostCall({ terminals: [] })
  assert.equal(await observerFor({}, { hostCall: emptyHost }).observer.currentWorktree(catalog), null)
})

test('currentWorktree: catalog가 incomplete면 hostCall 없이 null', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1', worktreeId: 'wt-1' })])
  catalog.complete = false
  const hostCall = createFakeHostCall({ terminals: [{ id: 'h1' }] })
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), null)
  assert.equal(hostCall.calls.length, 0)
})

test('currentWorktree: catalog terminals가 비면 null', async () => {
  const catalog = { complete: true, fetchedAt: 1, terminals: [] }
  const hostCall = createFakeHostCall({ terminals: [{ id: 'h1' }] })
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), null)
  assert.equal(hostCall.calls.length, 0)
})

test('currentWorktree: hostCall 실패 시 null', async () => {
  const catalog = await catalogWith([summary({ handle: 'h1', worktreeId: 'wt-1' })])
  const hostCall = createFakeHostCall(new Error('host down'))
  const { observer } = observerFor({}, { hostCall })
  assert.equal(await observer.currentWorktree(catalog), null)
})
