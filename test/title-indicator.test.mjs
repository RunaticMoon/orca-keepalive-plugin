/**
 * 🔧[OKPN-EB52] O : 탭 제목 ⚡ 표시 모듈 단위 테스트.
 *
 * 가짜 rpc/hostCall/clock/diagnostics로만 검증한다. 실제 Orca runtime이나
 * 타이머/파일을 사용하지 않는다.
 *
 * Run: `node --test test/title-indicator.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTitleIndicator } from '../src/title-indicator.mjs'

const WORKTREE = 'wt-1'
const TAB = 'tab-1'
const LEAF = 'leaf-1'
const HANDLE = 'terminal:local:1'
const PREFIX = '⚡ '
const PREFIX_NONE = '💤 '
const PREFIX_REVIEW = '⚠️ '
const KEY = 'title-indicator-v1'
const TAB_KEY = `${WORKTREE}:${TAB}`

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** 첫 호출을 붙잡아 둘 수 있는 간단한 deferred. */
function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * method→handler map fake rpc. handler가 없으면 throw한다.
 * @param {string[]} order
 * @param {Record<string, (params: any, options: any) => unknown>} handlers
 */
function makeRpc(order, handlers) {
  const calls = []
  const rpc = {
    calls,
    async call(method, params, options = {}) {
      calls.push({ method, params, options })
      order.push('rpc:' + method)
      const handler = handlers[method]
      if (typeof handler !== 'function') {
        throw new Error('unexpected rpc method ' + method)
      }
      return await handler(params, options)
    },
  }
  rpc.callsFor = (method) => calls.filter((call) => call.method === method)
  return rpc
}

/**
 * storage Map 기반 fake hostCall.
 * @param {string[]} order
 * @param {Map<string, unknown>} storage
 */
function makeHostCall(order, storage, { setError = null, getError = null } = {}) {
  const calls = []
  const fn = async (method, params) => {
    calls.push({ method, params })
    order.push('host:' + method)
    if (method === 'storage.get') {
      if (getError) throw getError
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined }
    }
    if (method === 'storage.set') {
      if (setError) throw setError
      storage.set(params.key, structuredClone(params.value))
      return { ok: true }
    }
    throw new Error('unexpected hostCall ' + method)
  }
  fn.calls = calls
  return fn
}

/** now/sleep을 제어하는 fake clock. onSleep 훅으로 refresh 중간 동작을 흉내낼 수 있다. */
function makeClock(start = 1000) {
  let current = start
  const sleeps = []
  const clock = {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms)
      if (typeof clock.onSleep === 'function') {
        await clock.onSleep(ms)
      }
    },
    advance: (ms) => {
      current += ms
    },
    sleeps,
    onSleep: null,
  }
  return clock
}

/** record 입력을 그대로 모으는 fake diagnostics. */
function makeDiagnostics() {
  const entries = []
  return {
    entries,
    record(input) {
      entries.push({ ...input })
    },
  }
}

/** pane 단위 desired 항목. */
function pane(overrides = {}) {
  return { worktreeId: WORKTREE, tabId: TAB, leafId: LEAF, handle: HANDLE, on: true, ...overrides }
}

/** session.tabs.list의 terminal 항목. 실제 Orca처럼 id는 `tabId::leafId` 합성 키다. */
function entry(overrides = {}) {
  return {
    type: 'terminal',
    id: `${TAB}::${LEAF}`,
    title: 'Claude',
    parentTabId: TAB,
    leafId: LEAF,
    ...overrides,
  }
}

function listOf(...entries) {
  return { tabs: entries }
}

/**
 * 모듈 + fakes 묶음.
 * @param {object} [options]
 */
function setup({ tabsList, rename, storage = new Map(), start = 1000, setError, getError, deps = {} } = {}) {
  const order = []
  const rpc = makeRpc(order, {
    'session.tabs.list': tabsList ?? (() => listOf(entry())),
    'terminal.rename': rename ?? (() => ({})),
  })
  const hostCall = makeHostCall(order, storage, { setError, getError })
  const clock = makeClock(start)
  const diagnostics = makeDiagnostics()
  const ti = createTitleIndicator({ rpc, hostCall, clock, diagnostics, ...deps })
  return { order, rpc, hostCall, clock, diagnostics, ti, storage }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

test('apply: 기록을 먼저 저장한 뒤 rename하고 prefix를 붙인다', async () => {
  const { order, rpc, storage, ti } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()
  order.length = 0

  await ti.reconcile([pane()])

  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })
  assert.deepEqual(storage.get(KEY), {
    [TAB_KEY]: {
      worktreeId: WORKTREE,
      tabId: TAB,
      handle: HANDLE,
      applied: PREFIX + 'Claude',
      prefix: PREFIX,
      confirmed: true,
    },
  })

  const setIndex = order.indexOf('host:storage.set')
  const renameIndex = order.indexOf('rpc:terminal.rename')
  assert.ok(setIndex !== -1, 'storage.set을 호출해야 한다')
  assert.ok(renameIndex > setIndex, `기록 저장(${setIndex})이 rename(${renameIndex})보다 먼저여야 한다`)

  const rename = rpc.callsFor('terminal.rename')[0]
  assert.deepEqual(rename.params, { terminal: HANDLE, title: PREFIX + 'Claude' })
  assert.equal(rename.options.timeoutMs, 3000)
})

test('apply: 선행 prefix를 반복 제거한다', async () => {
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + PREFIX + PREFIX + 'Claude' })),
  })
  await ti.load()
  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename')[0].params.title, PREFIX + 'Claude')
})

test('apply: 제목이 비면 base는 Claude', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: PREFIX + PREFIX + '   ' })) })
  await ti.load()
  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename')[0].params.title, PREFIX + 'Claude')
})

test('apply: applied는 200자를 넘지 않는다', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: 'x'.repeat(300) })) })
  await ti.load()
  await ti.reconcile([pane()])

  const applied = rpc.callsFor('terminal.rename')[0].params.title
  assert.equal(applied.length, 200)
  assert.ok(applied.startsWith(PREFIX))
})

test('apply: 탭을 찾지 못하면 아무것도 하지 않는다', async () => {
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry({ parentTabId: 'other-tab' })) })
  await ti.load()
  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename').length, 0)
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.equal(storage.has(KEY), false)
})

test('apply: 기록 저장에 실패하면 rename하지 않는다', async () => {
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry()),
    setError: new Error('no storage'),
  })
  await ti.load()
  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename').length, 0)
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('reconcile: 같은 탭의 on pane을 합산해 rename 1회, handle은 첫 on pane', async () => {
  const handle2 = 'terminal:local:2'
  const tabsList = () =>
    listOf(
      entry({ id: HANDLE, leafId: 'leaf-1', title: 'off-leaf' }),
      entry({ id: handle2, leafId: 'leaf-2', title: 'Claude' }),
    )
  const { rpc, ti } = setup({ tabsList })
  await ti.load()

  await ti.reconcile([
    pane({ leafId: 'leaf-1', handle: HANDLE, on: false }),
    pane({ leafId: 'leaf-2', handle: handle2, on: true }),
  ])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: handle2, title: PREFIX + 'Claude' })
})

test('reconcile: want && 기록이 있고 handle이 바뀌면 기록만 갱신한다', async () => {
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry()) })
  await ti.load()
  await ti.reconcile([pane()])

  const handle2 = 'terminal:local:2'
  await ti.reconcile([pane({ handle: handle2 })])

  assert.equal(rpc.callsFor('terminal.rename').length, 1)
  assert.equal(storage.get(KEY)[TAB_KEY].handle, handle2)
})

// ---------------------------------------------------------------------------
// remove / load 복구
// ---------------------------------------------------------------------------

test('remove: 탭이 있으면 제목 비교 없이 null로 되돌린다', async () => {
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX + 'Claude' } },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([])

  assert.deepEqual(rpc.callsFor('terminal.rename')[0].params, { terminal: HANDLE, title: null })
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('remove: 제목이 applied와 달라도 탭이 있으면 rename(null)로 해제한다', async () => {
  // session.tabs.list title은 customTitle이 아니라 런타임 제목 투영값이라 applied와
  // 비교할 수 없다. 다른 값이어도 customTitle(⚡)을 해제해야 한다.
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX + 'Claude' } },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: '⠂ Claude Code' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([])

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('remove: 적용 후 title이 OSC 값으로 바뀌어도 off에서 rename(null)로 해제한다', async () => {
  let title = 'Claude'
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry({ title })) })
  await ti.load()
  await ti.reconcile([pane()])
  assert.equal(storage.get(KEY)[TAB_KEY].applied, PREFIX + 'Claude')

  // Claude Code가 터미널 제목을 계속 갱신해 tabs.list title이 applied와 달라진다.
  title = '⠂ Claude Code'
  rpc.calls.length = 0
  await ti.reconcile([pane({ on: false })])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: null })
  assert.deepEqual(storage.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('removeOnly: 명시된 off만 제거하고 on 적용이나 누락 기록 정리는 하지 않는다', async () => {
  const missingKey = 'wt-missing:tab-missing'
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
        },
        [missingKey]: {
          worktreeId: 'wt-missing',
          tabId: 'tab-missing',
          handle: 'h-missing',
          applied: PREFIX + 'Other',
        },
      },
    ],
  ])
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile(
    [
      pane({ on: false }),
      pane({ worktreeId: 'wt-new', tabId: 'tab-new', leafId: 'leaf-new', handle: 'h-new', on: true }),
    ],
    { removeOnly: true },
  )

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(Object.keys(storage.get(KEY)), [missingKey])
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })
})

test('remove: 실패 재시도는 지수 백오프를 따르고 성공 시 기록을 정리한다', async () => {
  let failRemoval = true
  const { rpc, ti, clock } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    rename: (params) => {
      if (params.title === null && failRemoval) {
        throw new Error('rename down')
      }
      return {}
    },
  })
  await ti.load()
  await ti.reconcile([pane()])

  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 2)
  assert.equal(rpc.callsFor('terminal.rename').filter((call) => call.params.title === null).length, 1)

  // 첫 지연 10초 전에는 일반 reconcile이 RPC를 반복하지 않는다.
  await ti.reconcile([pane({ on: false })])
  clock.advance(9_999)
  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 2)

  // 첫 재시도 실패 뒤에는 20초로 늘어나며, 만료 전 호출은 다시 건너뛴다.
  clock.advance(1)
  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 3)
  assert.equal(rpc.callsFor('terminal.rename').filter((call) => call.params.title === null).length, 2)
  failRemoval = false
  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 3)
  clock.advance(19_999)
  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 3)

  clock.advance(1)
  await ti.reconcile([pane({ on: false })])
  assert.equal(rpc.callsFor('session.tabs.list').length, 4)
  assert.equal(rpc.callsFor('terminal.rename').filter((call) => call.params.title === null).length, 3)
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.deepEqual(rpc.callsFor('terminal.rename').at(-1).params, { terminal: HANDLE, title: null })
})

test('remove 실패는 apply disabled를 만들지 않고 on 전환 후 재적용할 수 있다', async () => {
  let failRemoval = true
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti, clock } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    rename: (params) => {
      if (params.title === null && failRemoval) {
        throw new Error('rename down')
      }
      return {}
    },
    storage,
  })
  await ti.load()

  await ti.reconcile([pane({ on: false })])
  clock.advance(10_000)
  await ti.reconcile([pane({ on: false })])
  clock.advance(20_000)
  await ti.reconcile([pane({ on: false })])
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })

  failRemoval = false
  await ti.reconcile([pane()])
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })
  assert.deepEqual(rpc.callsFor('terminal.rename').at(-1).params, {
    terminal: HANDLE,
    title: PREFIX + 'Claude',
  })
})

test('load 후 원치 않는 기록은 reconcile에서 정리한다(비정상 종료 복구)', async () => {
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX + 'Claude' } },
    ],
  ])
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  assert.equal(ti.snapshot().tabs, 1)

  // 원치 않는 다른 탭만 desired에 있다.
  await ti.reconcile([pane({ worktreeId: 'wt-other', tabId: 'tab-other', handle: 'h9' })])

  assert.deepEqual(rpc.callsFor('terminal.rename')[0].params, { terminal: HANDLE, title: null })
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

// ---------------------------------------------------------------------------
// turn 완료 (no-op) / off 제거
// ---------------------------------------------------------------------------

test('onTurnCompleted: 실제 턴 완료만으로는 rename하지 않는다(no-op)', async () => {
  // 같은 기호의 턴 완료 refresh를 제거했다. 실제 턴 완료는 제목을 다시 쓰지 않는다.
  let listCount = 0
  const tabsList = () => {
    listCount += 1
    if (listCount === 1) return listOf(entry({ title: 'Claude' }))
    return listOf(entry({ title: 'Updated' }))
  }
  const { rpc, ti, clock, storage } = setup({ tabsList, start: 1000 })
  await ti.load()
  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').length, 1)

  clock.advance(60_001)
  await ti.onTurnCompleted(TAB_KEY)

  assert.equal(rpc.callsFor('terminal.rename').length, 1, '턴 완료로 rename하지 않는다')
  assert.equal(rpc.callsFor('session.tabs.list').length, 1, '턴 완료로 조회하지 않는다')
  assert.deepEqual(clock.sleeps, [], 'settle sleep을 하지 않는다')
  assert.equal(storage.get(KEY)[TAB_KEY].applied, PREFIX + 'Claude')

  // 같은 시각에 다시 호출해도 아무 변화가 없다.
  await ti.onTurnCompleted(TAB_KEY)
  assert.equal(rpc.callsFor('terminal.rename').length, 1)
})

test('onTurnCompleted: 호출 후 off reconcile이면 정상 제거 경로로 되돌린다', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })) })
  await ti.load()
  await ti.reconcile([pane()])

  const completed = ti.onTurnCompleted(TAB_KEY)
  const off = ti.reconcile([pane({ on: false })])
  await Promise.all([completed, off])

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: PREFIX + 'Claude' },
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('onTurnCompleted: 기록이 없어도 off reconcile 전에는 rename하지 않는다', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()
  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').length, 1)

  await ti.onTurnCompleted(TAB_KEY)
  assert.equal(rpc.callsFor('terminal.rename').length, 1)
  assert.equal(rpc.callsFor('session.tabs.list').length, 1)
})

test('onTurnCompleted: 기록이 없으면 RPC를 호출하지 않는다', async () => {
  const { rpc, ti } = setup()
  await ti.load()
  await ti.onTurnCompleted('nope:tab')
  assert.equal(rpc.callsFor('session.tabs.list').length, 0)
})

// ---------------------------------------------------------------------------
// coalesce / 실패 차단
// ---------------------------------------------------------------------------

test('reconcile: 진행 중 들어온 호출은 최신 desired 하나로 합쳐진다', async () => {
  const gate = deferred()
  let first = true
  const tabsList = (params) => {
    if (first) {
      first = false
      return gate.promise
    }
    const suffix = params.worktree === 'id:wt-3' ? '3' : '2'
    return listOf(
      entry({ id: 'h' + suffix, leafId: 'leaf-' + suffix, parentTabId: 'tab-1', title: 'Claude' }),
    )
  }
  const { rpc, ti, storage } = setup({ tabsList })
  await ti.load()

  const p1 = ti.reconcile([pane({ worktreeId: 'wt-1', handle: HANDLE, leafId: 'leaf-1' })])
  // D1이 실제로 시작해 list를 기다리는 상태를 만든다.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rpc.callsFor('session.tabs.list').length, 1)

  // 최신 desired는 wt-1, wt-3만 원한다. 중간의 wt-2는 coalesce로 건너뛴다.
  const p2 = ti.reconcile([
    pane({ worktreeId: 'wt-1', handle: HANDLE, leafId: 'leaf-1' }),
    pane({ worktreeId: 'wt-2', handle: 'h2', leafId: 'leaf-2' }),
  ])
  const p3 = ti.reconcile([
    pane({ worktreeId: 'wt-1', handle: HANDLE, leafId: 'leaf-1' }),
    pane({ worktreeId: 'wt-3', handle: 'h3', leafId: 'leaf-3' }),
  ])

  gate.resolve(listOf(entry({ id: HANDLE, leafId: 'leaf-1', title: 'Claude' })))
  await Promise.all([p1, p2, p3])

  assert.deepEqual(Object.keys(storage.get(KEY)).sort(), ['wt-1:tab-1', 'wt-3:tab-1'])
  assert.equal(rpc.callsFor('terminal.rename').length, 2)
})

test('연속 실패가 maxFailures회면 그 탭을 건너뛴다', async () => {
  const tabsList = () => {
    throw new Error('rpc down')
  }
  const { rpc, ti } = setup({ tabsList })
  await ti.load()

  await ti.reconcile([pane()])
  await ti.reconcile([pane()])
  await ti.reconcile([pane()])

  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 1 })
  assert.equal(rpc.callsFor('session.tabs.list').length, 3)

  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('session.tabs.list').length, 3)
})

test('remove 실패는 apply disabled를 만들지 않고 백오프 후 계속 시도한다', async () => {
  let mode = 'ok'
  const storage = new Map()
  const tabsList = () => {
    if (mode === 'fail') throw new Error('down')
    return listOf(entry({ title: PREFIX + 'Claude' }))
  }
  const { rpc, ti, clock, storage: store } = setup({ tabsList, storage })
  await ti.load()
  await ti.reconcile([pane()])
  assert.equal(store.get(KEY)[TAB_KEY].applied, PREFIX + 'Claude')

  mode = 'fail'
  await ti.reconcile([])
  await ti.reconcile([])
  await ti.reconcile([])
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })
  assert.equal(rpc.callsFor('session.tabs.list').length, 2, '백오프 전에는 조회를 반복하지 않는다')

  mode = 'ok'
  const before = rpc.callsFor('session.tabs.list').length
  clock.advance(10_000)
  await ti.reconcile([])
  assert.ok(rpc.callsFor('session.tabs.list').length > before)
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

// ---------------------------------------------------------------------------
// confirmed / 재적용(M1) · terminal handle 계약(M2)
// ---------------------------------------------------------------------------

test('apply: agg.handle이 없으면 적용하지 않는다(핸들은 terminal.list에서만 온다)', async () => {
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()
  await ti.reconcile([pane({ handle: undefined })])

  assert.equal(rpc.callsFor('terminal.rename').length, 0)
  assert.equal(rpc.callsFor('session.tabs.list').length, 0)
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.equal(storage.has(KEY), false)
})

test('apply: rename은 session.tabs.list 항목 id가 아니라 terminal handle로 호출한다', async () => {
  // entry().id는 `${TAB}::${LEAF}`이고 terminal handle은 HANDLE이다.
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()
  await ti.reconcile([pane()])

  const rename = rpc.callsFor('terminal.rename')[0]
  assert.deepEqual(rename.params, { terminal: HANDLE, title: PREFIX + 'Claude' })
  assert.notEqual(rename.params.terminal, `${TAB}::${LEAF}`)
})

test('apply: rename 1회 실패 후 다음 reconcile에서 재시도해 확정한다', async () => {
  let attempts = 0
  const { rpc, ti, storage } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    rename: () => {
      attempts += 1
      if (attempts === 1) throw new Error('rename down')
      return {}
    },
  })
  await ti.load()
  await ti.reconcile([pane()])

  // 첫 실패: 기록은 미확정으로 남고 제목은 그대로다.
  assert.equal(storage.get(KEY)[TAB_KEY].confirmed, false)
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })

  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename').length, 2)
  assert.deepEqual(storage.get(KEY)[TAB_KEY], {
    worktreeId: WORKTREE,
    tabId: TAB,
    handle: HANDLE,
    applied: PREFIX + 'Claude',
    prefix: PREFIX,
    confirmed: true,
  })
})

test('apply: 연속 rename 실패가 maxFailures면 탭을 비활성화하고 재시도하지 않는다', async () => {
  const { rpc, ti, storage } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    rename: () => {
      throw new Error('rename down')
    },
  })
  await ti.load()

  await ti.reconcile([pane()])
  await ti.reconcile([pane()])
  await ti.reconcile([pane()])

  assert.equal(rpc.callsFor('terminal.rename').length, 3)
  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 1 })
  assert.equal(storage.get(KEY)[TAB_KEY].confirmed, false)

  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').length, 3, '비활성화 후 rename 시도 없음')
  assert.equal(rpc.callsFor('session.tabs.list').length, 3, '비활성화 후 list 시도 없음')
})

test('reconcile: 저장 후 rename 전 중단된 미확정 기록을 재적용한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })), storage })
  await ti.load()
  assert.equal(ti.snapshot().tabs, 1)

  await ti.reconcile([pane()])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: PREFIX + 'Claude' })
})

test('reconcile: 이미 ⚡가 붙은 미확정 기록은 중복 접두어 없이 재적용한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane()])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: PREFIX + 'Claude' })
})

test('load: 이전 실행 기록은 미확정으로 보고 첫 reconcile에서 재적용한다', async () => {
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX + 'Claude' } },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane()])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  // 이미 ⚡가 붙은 제목에서 재적용해도 중복 접두어가 생기지 않는다.
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: PREFIX + 'Claude' })
  assert.equal(store.get(KEY)[TAB_KEY].confirmed, true)
})

test('load: confirmed:true 저장 기록도 새 handle로 첫 reconcile에서 재적용한다', async () => {
  const handle2 = 'terminal:local:2'
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane({ handle: handle2 })])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: handle2, title: PREFIX + 'Claude' })
  assert.deepEqual(store.get(KEY)[TAB_KEY], {
    worktreeId: WORKTREE,
    tabId: TAB,
    handle: handle2,
    applied: PREFIX + 'Claude',
    prefix: PREFIX,
    confirmed: true,
  })
})

test('load: 이전 종료가 ⚡를 지운 탭에 저장 기록으로 재적용한다', async () => {
  // 이전 인스턴스 종료가 중간에 끊겨 제목의 ⚡는 지워졌지만 기록은 confirmed:true.
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane()])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: PREFIX + 'Claude' })
  assert.equal(store.get(KEY)[TAB_KEY].confirmed, true)
})

test('load: removeOnly reconcile은 미확정으로 읽은 기록을 재적용하지 않는다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane()], { removeOnly: true })

  assert.equal(rpc.callsFor('terminal.rename').length, 0)
  assert.equal(store.get(KEY)[TAB_KEY].confirmed, true, '저장 형식의 confirmed는 유지된다')
})

test('load: 재적용 후 다음 reconcile은 rename을 반복하지 않는다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').length, 1)

  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').length, 1, '확정된 뒤에는 재적용하지 않는다')
})

test('load: confirmed:true 기록이라도 on:false reconcile은 재적용 없이 해제만 한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane({ on: false })])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: HANDLE, title: null })
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('remove: 미확정 기록도 탭이 있으면 되돌린다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([])

  assert.deepEqual(rpc.callsFor('terminal.rename')[0].params, { terminal: HANDLE, title: null })
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('remove: 미확정 기록도 제목 비교 없이 rename(null)로 해제한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([])

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

test('reconcile: 교체 rename 실패 시 미확정으로 남기고 다음 reconcile에서 재적용한다', async () => {
  let title = 'Claude'
  const tabsList = () => listOf(entry({ title }))
  let failNextRename = false
  const rename = (params) => {
    if (failNextRename) throw new Error('rename down')
    title = params.title ?? 'Claude'
    return {}
  }
  const { rpc, ti, storage } = setup({ tabsList, rename, start: 1000 })
  await ti.load()
  await ti.reconcile([pane({ cacheState: 'kept' })])
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)
  assert.equal(storage.get(KEY)[TAB_KEY].confirmed, true)

  // ⚡ → 💤 교체 rename 실패: 새 prefix 기록이 미확정으로 남는다.
  failNextRename = true
  await ti.reconcile([pane({ cacheState: 'none' })])
  assert.equal(storage.get(KEY)[TAB_KEY].confirmed, false)
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, '💤 ')
  assert.equal(storage.get(KEY)[TAB_KEY].applied, '💤 Claude')

  // 다음 reconcile에서 재적용 rename은 한 번만 발생한다(2단계 교체 금지).
  failNextRename = false
  const before = rpc.callsFor('terminal.rename').length
  await ti.reconcile([pane({ cacheState: 'none' })])
  assert.equal(rpc.callsFor('terminal.rename').length - before, 1)
  assert.equal(storage.get(KEY)[TAB_KEY].confirmed, true)
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, '💤 ')
})

test('onTurnCompleted: 미확정 기록도 no-op이라 RPC를 호출하지 않는다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX + 'Claude',
          prefix: PREFIX,
          confirmed: false,
        },
      },
    ],
  ])
  const { rpc, ti, clock } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })), storage })
  await ti.load()
  clock.advance(60_001)
  await ti.onTurnCompleted(TAB_KEY)

  assert.equal(rpc.callsFor('session.tabs.list').length, 0)
  assert.equal(rpc.callsFor('terminal.rename').length, 0)
})

// ---------------------------------------------------------------------------
// restoreAll
// ---------------------------------------------------------------------------

test('restoreAll: 모든 기록을 되돌리고 실패해도 계속한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        'wt-1:tab-1': { worktreeId: 'wt-1', tabId: 'tab-1', handle: 'h1', applied: PREFIX + 'A' },
        'wt-2:tab-2': { worktreeId: 'wt-2', tabId: 'tab-2', handle: 'h2', applied: PREFIX + 'B' },
      },
    ],
  ])
  const tabsList = (params) => {
    if (params.worktree === 'id:wt-1') throw new Error('down')
    return listOf(
      entry({ id: 'h2', title: PREFIX + 'B', parentTabId: 'tab-2', leafId: 'leaf-2' }),
    )
  }
  const { rpc, ti, storage: store, diagnostics } = setup({ tabsList, storage })
  await ti.load()
  await ti.restoreAll()

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.deepEqual(renames[0].params, { terminal: 'h2', title: null })
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.ok(diagnostics.entries.some((e) => e.code === 'restore_failed'))
})

test('restoreAll: 제목이 applied와 달라도 탭이 있으면 rename(null)로 해제한다', async () => {
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX + 'Claude' } },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: '⠂ Claude Code' })),
    storage,
  })
  await ti.load()
  await ti.restoreAll()

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})

// ---------------------------------------------------------------------------
// 저장소 불량 / redaction
// ---------------------------------------------------------------------------

test('load: 저장소 JSON이 불량이면 빈 기록으로 시작한다', async () => {
  const storage = new Map([[KEY, 'not-json']])
  const { ti, diagnostics } = setup({ storage })
  await ti.load()

  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.ok(diagnostics.entries.some((e) => e.code === 'record_invalid'))
})

test('load: record 형식이 불량인 항목은 버린다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: { foo: 1 },
        'ok:tab': { worktreeId: 'ok', tabId: 'tab', handle: 'h', applied: PREFIX + 'Claude' },
      },
    ],
  ])
  const { ti } = setup({ storage })
  await ti.load()

  assert.deepEqual(ti.snapshot(), { tabs: 1, disabledTabs: 0 })
})

test('load: storage.get 실패는 빈 기록이고 진단만 남긴다', async () => {
  const { ti, diagnostics } = setup({ getError: new Error('boom') })
  await ti.load()

  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
  assert.ok(diagnostics.entries.some((e) => e.code === 'load_failed'))
})

test('load: 기록이 200개를 넘으면 오래된 것부터 버린다', async () => {
  const recs = {}
  for (let i = 0; i < 250; i += 1) {
    recs[`wt-${i}:tab`] = { worktreeId: `wt-${i}`, tabId: 'tab', handle: `h${i}`, applied: PREFIX + 'C' }
  }
  const storage = new Map([[KEY, recs]])
  const { ti } = setup({ storage })
  await ti.load()

  assert.equal(ti.snapshot().tabs, 200)
})

test('진단에는 제목 문자열/handle을 남기지 않는다', async () => {
  const secretTitle = 'SECRET-TITLE-XYZ'
  const tabsList = () => listOf(entry({ title: secretTitle }))
  const rename = () => {
    throw new Error(`rename failed for ${secretTitle} ${HANDLE}`)
  }
  const { ti, diagnostics } = setup({ tabsList, rename })
  await ti.load()
  await ti.reconcile([pane()])

  const text = JSON.stringify(diagnostics.entries)
  assert.ok(diagnostics.entries.length > 0)
  assert.equal(text.includes(secretTitle), false)
  assert.equal(text.includes(HANDLE), false)
})

// ---------------------------------------------------------------------------
// 세 상태 prefix 합산·교체 (작업 H)
// ---------------------------------------------------------------------------

test('reconcile: 세 기호 전환은 매번 rename 1회, 결과 접두어 1개', async () => {
  const prefixes = { kept: PREFIX, none: PREFIX_NONE, review: PREFIX_REVIEW }
  let title = 'Claude'
  const tabsList = () => listOf(entry({ title }))
  const rename = (params) => {
    title = params.title ?? 'Claude'
    return {}
  }
  const { rpc, ti, storage } = setup({ tabsList, rename })
  await ti.load()

  // 최초 적용(⚡)은 rename 1회.
  await ti.reconcile([pane({ cacheState: 'kept' })])
  assert.equal(rpc.callsFor('terminal.rename').length, 1)
  assert.equal(title, PREFIX + 'Claude')

  const transitions = [
    ['kept', 'none'],
    ['none', 'review'],
    ['review', 'kept'],
    ['kept', 'review'],
    ['review', 'none'],
    ['none', 'kept'],
  ]
  for (const [from, to] of transitions) {
    assert.equal(storage.get(KEY)[TAB_KEY].prefix, prefixes[from], `${from} 상태로 시작`)
    const before = rpc.callsFor('terminal.rename').length
    await ti.reconcile([pane({ cacheState: to })])
    assert.equal(rpc.callsFor('terminal.rename').length - before, 1, `${from} → ${to} rename 1회`)
    assert.equal(title, prefixes[to] + 'Claude', `${from} → ${to} 결과 접두어 1개`)
    assert.equal(storage.get(KEY)[TAB_KEY].prefix, prefixes[to])
  }
})

test('reconcile: 같은 기호 반복(BUSY→ARMED 상당)은 rename하지 않는다', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()
  await ti.reconcile([pane({ cacheState: 'kept' })])
  assert.equal(rpc.callsFor('terminal.rename').length, 1)

  for (let i = 0; i < 3; i += 1) {
    await ti.reconcile([pane({ cacheState: 'kept' })])
  }
  assert.equal(rpc.callsFor('terminal.rename').length, 1, '같은 기호는 rename하지 않는다')
  assert.equal(rpc.callsFor('session.tabs.list').length, 1, '같은 기호는 조회도 반복하지 않는다')
})

test('reconcile: on pane 우선순위 review > kept > none, off pane은 제외', async () => {
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()

  // none + kept → kept(⚡)
  await ti.reconcile([
    pane({ leafId: 'leaf-1', handle: HANDLE, on: true, cacheState: 'none' }),
    pane({ leafId: 'leaf-2', handle: 'h2', on: true, cacheState: 'kept' }),
  ])
  assert.equal(rpc.callsFor('terminal.rename').at(-1).params.title, PREFIX + 'Claude')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)

  // off pane의 review는 합산에서 제외된다 → none(💤)
  await ti.reconcile([
    pane({ leafId: 'leaf-1', handle: HANDLE, on: true, cacheState: 'none' }),
    pane({ leafId: 'leaf-2', handle: 'h2', on: false, cacheState: 'review' }),
  ])
  assert.equal(rpc.callsFor('terminal.rename').at(-1).params.title, PREFIX_NONE + 'Claude')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX_NONE)

  // kept + review → review(⚠️)
  await ti.reconcile([
    pane({ leafId: 'leaf-1', handle: HANDLE, on: true, cacheState: 'kept' }),
    pane({ leafId: 'leaf-2', handle: 'h2', on: true, cacheState: 'review' }),
  ])
  assert.equal(rpc.callsFor('terminal.rename').at(-1).params.title, PREFIX_REVIEW + 'Claude')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX_REVIEW)
})

test('reconcile: cacheState 누락·불량은 kept(⚡)로 간주한다', async () => {
  const { rpc, ti, storage } = setup({ tabsList: () => listOf(entry({ title: 'Claude' })) })
  await ti.load()

  await ti.reconcile([pane()])
  assert.equal(rpc.callsFor('terminal.rename').at(-1).params.title, PREFIX + 'Claude')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)

  await ti.reconcile([pane({ cacheState: 'bogus' })])
  assert.equal(rpc.callsFor('terminal.rename').length, 1, '누락과 같은 kept이므로 rename하지 않는다')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)
})

test('apply: 세 기호가 섞여 반복된 접두어를 모두 제거한다', async () => {
  const { rpc, ti } = setup({ tabsList: () => listOf(entry({ title: `${PREFIX_NONE}${PREFIX}${PREFIX_REVIEW}${PREFIX_NONE}Claude` })) })
  await ti.load()
  await ti.reconcile([pane({ cacheState: 'review' })])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.equal(renames[0].params.title, PREFIX_REVIEW + 'Claude')
})

test('load: 재시작 후 미확정 재적용은 현재 상태 기호로 한다(TTLI-ED3D)', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX_NONE + 'Claude',
          prefix: PREFIX_NONE,
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX_NONE + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane({ cacheState: 'none' })])

  const renames = rpc.callsFor('terminal.rename')
  assert.equal(renames.length, 1)
  assert.equal(renames[0].params.title, PREFIX_NONE + 'Claude')
  assert.equal(store.get(KEY)[TAB_KEY].confirmed, true)
})

test('load: prefix 없는 옛 기록은 applied에서 기호를 읽어 호환한다', async () => {
  const storage = new Map([
    [
      KEY,
      { [TAB_KEY]: { worktreeId: WORKTREE, tabId: TAB, handle: HANDLE, applied: PREFIX_REVIEW + 'Claude' } },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX_REVIEW + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane({ cacheState: 'review' })])

  assert.equal(rpc.callsFor('terminal.rename').at(-1).params.title, PREFIX_REVIEW + 'Claude')
  assert.equal(store.get(KEY)[TAB_KEY].prefix, PREFIX_REVIEW)
})

test('apply: 새 기록 선저장 실패 시 기존 복구 기록을 되돌린다', async () => {
  const storage = new Map()
  let failSet = false
  const order = []
  const rpc = makeRpc(order, {
    'session.tabs.list': () => listOf(entry({ title: PREFIX + 'Claude' })),
    'terminal.rename': () => ({}),
  })
  const hostCall = async (method, params) => {
    if (method === 'storage.get') {
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined }
    }
    if (method === 'storage.set') {
      if (failSet) throw new Error('no storage')
      storage.set(params.key, structuredClone(params.value))
      return { ok: true }
    }
    throw new Error('unexpected hostCall ' + method)
  }
  const ti = createTitleIndicator({ rpc, hostCall, clock: makeClock(1000), diagnostics: makeDiagnostics() })
  await ti.load()

  // 확정 기록을 만든다.
  await ti.reconcile([pane({ cacheState: 'kept' })])
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)
  const applied = rpc.callsFor('terminal.rename').length
  assert.equal(applied, 1)

  // 선저장 실패로 ⚡ → 💤 교체를 시도한다.
  failSet = true
  await ti.reconcile([pane({ cacheState: 'none' })])
  assert.equal(rpc.callsFor('terminal.rename').length, applied, '선저장 실패면 rename하지 않는다')

  // 기존 ⚡ 확정 기록이 살아 있어 같은 기호 reconcile은 rename하지 않는다.
  failSet = false
  await ti.reconcile([pane({ cacheState: 'kept' })])
  assert.equal(rpc.callsFor('terminal.rename').length, applied, '복구 기록 유지(같은 기호 rename 0)')
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX)

  // 저장이 회복되면 교체가 진행된다.
  await ti.reconcile([pane({ cacheState: 'none' })])
  assert.equal(storage.get(KEY)[TAB_KEY].prefix, PREFIX_NONE)
})

test('removeOnly: 💤 기록도 명시적 off에서 rename(null)로 해제한다', async () => {
  const storage = new Map([
    [
      KEY,
      {
        [TAB_KEY]: {
          worktreeId: WORKTREE,
          tabId: TAB,
          handle: HANDLE,
          applied: PREFIX_NONE + 'Claude',
          prefix: PREFIX_NONE,
          confirmed: true,
        },
      },
    ],
  ])
  const { rpc, ti, storage: store } = setup({
    tabsList: () => listOf(entry({ title: PREFIX_NONE + 'Claude' })),
    storage,
  })
  await ti.load()
  await ti.reconcile([pane({ on: false })], { removeOnly: true })

  assert.deepEqual(rpc.callsFor('terminal.rename').map((call) => call.params), [
    { terminal: HANDLE, title: null },
  ])
  assert.deepEqual(store.get(KEY), {})
  assert.deepEqual(ti.snapshot(), { tabs: 0, disabledTabs: 0 })
})
