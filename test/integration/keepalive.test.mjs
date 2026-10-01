/**
 * 🔧[OKAP-D1C9] P : 가짜 런타임 통합 테스트.
 *
 * 실제 제품 모듈 전체(`createPlugin`)를 가짜 런타임 소켓·가짜 host·임시 SQLite
 * 설정 위에서 돌린다. 실제 Orca, shell, claude는 사용하지 않는다.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

import { createPlugin } from '../../main.mjs'
import { createCoordinator } from '../../src/coordinator.mjs'
import { createEpochMemory } from '../../src/epoch-memory.mjs'
import { DEFAULT_CONFIG } from '../../src/config.mjs'
import { STATE_KEY } from '../../src/state-store.mjs'
import { createFakeClock } from '../fixtures/fake-clock.mjs'
import { startFakeRuntime } from '../fixtures/fake-runtime.mjs'
import { createOrcaUserData } from '../fixtures/orca-userdata.mjs'
import { createFakeHost } from '../fixtures/fake-host.mjs'

const TTL_5M = 300000
const TTL_1H = 3600000
const MARGIN_5M = 60000
const MARGIN_1H = 120000
const TICK_MS = 2000
const DUE_5M = TTL_5M - MARGIN_5M // 240000
const DUE_1H = TTL_1H - MARGIN_1H // 3480000
const DONE_MESSAGE =
  'Cache keepalive. Reply only OK; do not use tools or continue previous work.'
const DASHBOARD_URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)/

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {number} ms */
function realDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 조건이 참이 될 때까지 실제 시간으로 폴링하면서 가상 clock도 조금씩 양보한다.
 * @param {() => boolean} predicate
 * @param {{timeoutMs?: number, clock?: any}} [options]
 */
async function waitFor(predicate, { timeoutMs = 5000, clock } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) {
      throw new Error('waitFor timeout')
    }
    await realDelay(3)
    if (clock) await clock.settle(6)
  }
}

/**
 * HTTP JSON 요청 헬퍼.
 * @param {{method?:string, host?:string, port:number, path:string, token?:string, origin?:string, body?:any}} options
 */
function requestJson({ method = 'GET', host = '127.0.0.1', port, path, token, origin, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { Host: `${host}:${port}` }
    if (token !== undefined) headers.Authorization = `Bearer ${token}`
    if (origin !== undefined) headers.Origin = origin
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    const req = http.request({ method, host, port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** 기본 터미널 1개(W1). */
function defaultTerminals() {
  return [
    {
      handle: 'h1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf1',
      title: 'W1 terminal',
      branch: 'main',
    },
  ]
}

/** W1/W2 두 워크트리 터미널. */
function twoWorktreeTerminals() {
  return [
    {
      handle: 'h1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf1',
      title: 'W1 terminal',
      branch: 'w1',
    },
    {
      handle: 'h2',
      worktreeId: 'wt2',
      tabId: 'tab2',
      leafId: 'leaf2',
      title: 'W2 terminal',
      branch: 'w2',
    },
  ]
}

/**
 * 통합 하네스를 만든다. tmp userData + fake runtime + fake host + fake clock 위에서
 * 실제 createPlugin을 활성화한다.
 *
 * `options.enabled`/`options.ttlMs`는 Orca fixture 타이머용이다(이제 제품 스케줄에
 * 영향이 없음을 검증하는 용도). 플러그인 TTL은 `options.pluginTtlMs`(기본 5분)로
 * 활성화 전 state-v1에 저장한다. `pluginTtlMs:null`이면 아무것도 저장하지 않아
 * 제품 기본 config(1시간)를 그대로 쓴다.
 *
 * @param {Object} [options]
 */
async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'okap-int-'))
  const socketPath = join(root, 'runtime.sock')
  const fakePid = 40000 + Math.floor(Math.random() * 10000)
  const userData = await createOrcaUserData({
    root,
    pid: fakePid,
    socketPath,
    profileId: options.profileId ?? 'profile-1',
    enabled: options.enabled ?? false,
    ttlMs: options.ttlMs ?? TTL_5M,
  })
  const runtime = await startFakeRuntime({
    socketPath,
    authToken: userData.authToken,
    runtimeId: userData.runtimeId,
  })

  for (const terminal of options.terminals ?? defaultTerminals()) {
    runtime.addTerminal(terminal)
  }

  const host = createFakeHost()
  // 플러그인 TTL은 Orca fixture 타이머가 아니라 plugin config(claudeCacheTtlMs)에서
  // 온다. 활성화 전에 state-v1을 채워 store.load가 이 config를 읽게 한다.
  // pluginTtlMs:null이면 쓰지 않아 DEFAULT_CONFIG(1시간)를 그대로 쓴다.
  if (options.pluginTtlMs !== null) {
    const pluginTtlMs = options.pluginTtlMs ?? TTL_5M
    host.storage.set(STATE_KEY, {
      schemaVersion: 1,
      revision: 0,
      config: { ...DEFAULT_CONFIG, claudeCacheTtlMs: pluginTtlMs },
      profiles: [],
    })
  }
  if (options.workspaceContext) {
    host.setWorkspaceContext(options.workspaceContext)
  }
  const clock = createFakeClock()

  const pluginDeps = {
    os: { homedir: () => userData.homeDir },
    proc: {
      platform: 'linux',
      ppid: fakePid,
      env: { ORCA_USER_DATA_PATH: userData.userDataPath },
    },
    // epoch-memory의 savedAt/prune이 가상 clock과 일치하도록 now를 주입한다.
    createEpochMemory: (epochOptions) =>
      createEpochMemory({ ...epochOptions, now: () => clock.now() }),
    createCoordinator: (coordinatorOptions) =>
      createCoordinator({ ...coordinatorOptions, clock, tickMs: TICK_MS }),
  }
  let plugin = createPlugin(host.orca, pluginDeps)
  plugin.activate()

  let dashboardInfo = null

  return {
    root,
    userData,
    runtime,
    host,
    clock,
    plugin,
    fakePid,

    /** bootstrap이 연결을 마치고 catalog가 채워질 때까지 기다린다. */
    async start() {
      await clock.settle(40)
      await waitFor(
        () => runtime.frames.some((frame) => frame.method === 'terminal.list'),
        { clock },
      )
      await clock.advance(TICK_MS + 500)
    },

    /**
     * 플러그인을 deactivate한 뒤 같은 host/runtime/clock 위에서 다시 activate한다.
     * host storage가 유지되므로 epoch-memory 영속/복원을 실제 경로로 검증할 수 있다.
     */
    async reload() {
      await plugin.deactivate()
      const listBefore = runtime.frames.filter((frame) => frame.method === 'terminal.list').length
      plugin = createPlugin(host.orca, pluginDeps)
      plugin.activate()
      await clock.settle(40)
      await waitFor(
        () => runtime.frames.filter((frame) => frame.method === 'terminal.list').length > listBefore,
        { clock },
      )
      await clock.advance(TICK_MS + 500)
    },

    /**
     * agent.status.changed 이벤트를 보내고 drain이 끝날 때까지 이벤트 루프를 양보한다.
     * @param {{worktreeId:string, paneKey:string, state:string, receivedAt?:number, mainAgent?:object}} payload
     */
    async event(payload) {
      host.emit('agent.status.changed', {
        receivedAt: clock.now(),
        ...payload,
      })
      await clock.settle(80)
    },

    /**
     * working → done으로 epoch를 연다. doneAt을 반환한다.
     * @param {{worktreeId?:string, paneKey?:string, doneOffset?:number}} [options]
     */
    async arm({ worktreeId = 'wt1', paneKey = 'tab1:leaf1', doneOffset = 1000 } = {}) {
      const t0 = clock.now()
      await this.event({ worktreeId, paneKey, state: 'working', receivedAt: t0 })
      await this.event({ worktreeId, paneKey, state: 'done', receivedAt: t0 + doneOffset })
      return t0 + doneOffset
    },

    /** wall이 atWall이 되도록 가상 시간을 진행한다. */
    async advanceTo(atWall) {
      const delta = atWall - clock.now()
      if (delta > 0) await clock.advance(delta)
    },

    /** 진행 중인 send 체인을 끝까지 밀어준다. */
    async settleSend() {
      await clock.settle(300)
    },

    /**
     * terminal.send frame 수가 n 이상이 될 때까지(실제 시간 폴링) 기다린다.
     * @param {number} n
     * @param {{timeoutMs?: number}} [options]
     */
    async waitForSendFrames(n, { timeoutMs = 6000 } = {}) {
      await waitFor(() => runtime.sendFrames().length >= n, { clock, timeoutMs })
    },

    /** terminal.send frame만 반환. */
    sendFrames() {
      return runtime.sendFrames()
    },

    /** dashboard를 시작하고 token/port/snapshot을 반환한다. 서버는 한 번만 뜬다. */
    async openDashboard() {
      if (dashboardInfo === null) {
        runtime.failNext('browser.tabCreate', { kind: 'error', count: 1 })
        await host.runCommand('keepalive-open')
        const notification = host.lastNotification()
        const match =
          notification && typeof notification.body === 'string'
            ? DASHBOARD_URL_RE.exec(notification.body)
            : null
        if (!match) {
          throw new Error(
            'dashboard URL not found in notification: ' + JSON.stringify(notification),
          )
        }
        const port = Number(match[1])
        const token = match[2]
        dashboardInfo = { port, token, origin: `http://127.0.0.1:${port}` }
      }
      const state = await requestJson({
        port: dashboardInfo.port,
        path: '/api/state',
        token: dashboardInfo.token,
      })
      return { ...dashboardInfo, state: state.body, status: state.status }
    },

    /**
     * 대시보드 snapshot에서 조건에 맞는 터미널이 나올 때까지 폴링한다.
     * @param {(terminal: any, snapshot: any) => boolean} predicate
     * @param {{timeoutMs?: number}} [options]
     */
    async waitForTerminal(predicate, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const dashboard = await this.openDashboard()
        const found = (dashboard.state.worktrees ?? [])
          .flatMap((worktree) => worktree.terminals ?? [])
          .find((terminal) => predicate(terminal, dashboard.state))
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error('terminal predicate timeout')
        }
        await realDelay(5)
        await clock.settle(20)
      }
    },

    async cleanup() {
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
      await userData.cleanup()
    },
  }
}

// ---------------------------------------------------------------------------
// 시나리오 1. Orca 타이머 off(fixture enabled:false)여도 플러그인 config TTL로 전송
// ---------------------------------------------------------------------------

test('scenario 1: Orca 타이머가 꺼져 있어도 fresh epoch due에 paste 1+Enter 1', async () => {
  const h = await createHarness({ enabled: false, pluginTtlMs: TTL_5M })
  try {
    await h.start()

    // Orca fixture의 타이머는 여전히 꺼져 있다(제품은 더 이상 이 값을 쓰지 않는다).
    const orcaPayload = await h.userData.readPayload()
    assert.equal(orcaPayload.enabled, false, 'Orca fixture 타이머는 off')

    const doneAt = await h.arm()
    // basisAt은 done 이벤트 1초 전의 마지막 working 시각이므로 due도 1초 앞당겨진다.
    const dueAt = doneAt - 1000 + DUE_5M
    await h.advanceTo(dueAt - 1000)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'due 1초 전에는 0')

    await h.advanceTo(dueAt + TICK_MS)
    await h.waitForSendFrames(2)
    const frames = h.sendFrames()
    assert.equal(frames.length, 2, 'due 이후 paste 1 + Enter 1')
    assert.equal(typeof frames[0].params.text, 'string')
    assert.ok(frames[0].params.text.includes(DONE_MESSAGE), '첫 frame은 메시지 text')
    assert.ok(!('enter' in frames[0].params) || frames[0].params.enter !== true)
    assert.equal(frames[1].params.enter, true, '둘째 frame은 enter만')
    assert.ok(!('text' in frames[1].params), 'Enter frame에는 text가 없다')
    assert.equal(frames[0].params.requireAgentStatus, 'sendable')
    assert.equal(frames[1].params.requireAgentStatus, 'sendable')
    assert.equal(h.runtime.submissions.length, 1)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 2. config 미설정 → 제품 기본 1시간 TTL로 dueAt 계산(실제 대기 없음)
// ---------------------------------------------------------------------------

test('scenario 2: 플러그인 config가 없으면 기본 1시간 TTL로 dueAt을 계산한다', async () => {
  const h = await createHarness({ pluginTtlMs: null })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000

    // 실제 시간을 기다리지 않고 대시보드 snapshot의 dueAt/expiresAt만 검증한다.
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const term = await h.waitForTerminal((entry) => entry.cacheStatus === 'scheduled')
    assert.equal(term.expiresAt, basisAt + TTL_1H, 'expiresAt = basisAt + 기본 1시간 TTL')
    assert.equal(term.dueAt, basisAt + DUE_1H, 'dueAt = basisAt + TTL - margin1h')
    assert.equal(h.sendFrames().length, 0, 'due 전이므로 전송 0')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 3. 자체 순환과 연속 상한 3회 → 비자체 turn reset
// ---------------------------------------------------------------------------

test('scenario 3: 자체 순환 3회 후 4번째 0, 비자체 turn이면 budget reset 후 재전송', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()

    // 5분 TTL 상한을 3으로 명시해 기본값(8)과 무관하게 경계를 검증한다.
    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    const configured = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { maxConsecutiveKeepalives5m: 3, maxConsecutiveKeepalives1h: 3 },
        expectedRevision: dashboard.state.revision,
      },
    })
    assert.equal(configured.status, 200, 'cap 3 config POST 성공')

    let expected = 0
    for (let index = 0; index < 3; index += 1) {
      const doneAt = await h.arm()
      await h.advanceTo(doneAt + DUE_5M + TICK_MS)
      expected += 2
      await h.waitForSendFrames(expected)
      assert.equal(
        h.sendFrames().length,
        expected,
        `자체 순환 ${index + 1}회차 전송`,
      )
    }

    // 4번째 자체 turn: charged=3이라 전송하지 않는다.
    const doneAt4 = await h.arm()
    await h.advanceTo(doneAt4 + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 6, '설정한 상한 3회 후 4번째는 전송 0')

    // 자체 turn이 아닌 fresh working(15초 밖)은 budget을 0으로 reset한다.
    await h.advanceTo(h.clock.now() + 20000)
    const doneAt5 = await h.arm()
    await h.advanceTo(doneAt5 + DUE_5M + TICK_MS)
    await h.waitForSendFrames(8)
    assert.equal(h.sendFrames().length, 8, '비자체 turn 뒤 다시 전송한다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 4. preflight 차단(draft/permission/agentWait)
// ---------------------------------------------------------------------------

test('scenario 4a: draft 존재 시 전송 0', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setDraft('h1', 'user is typing')
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0)
  } finally {
    await h.cleanup()
  }
})

test('scenario 4b: permission 상태면 전송 0', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setAgentStatus('h1', 'permission')
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0)
  } finally {
    await h.cleanup()
  }
})

test('scenario 4c: agentWait 객체면 전송 0', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setAgentWait('h1', { kind: 'permission' })
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 5. paste 후 draft 변조 → Enter 0 + needsReview
// ---------------------------------------------------------------------------

test('scenario 5: paste 후 draft가 변하면 Enter 0 + dashboard needsReview', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setPasteMutator((_params, terminal) => {
      terminal.draft = (terminal.draft ?? '') + 'X'
    })
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.waitForSendFrames(1)
    await h.clock.settle(200)

    const frames = h.sendFrames()
    assert.equal(frames.length, 1, 'paste 1회만')
    assert.equal(frames.filter((frame) => frame.params.enter === true).length, 0, 'Enter 0')

    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    const terminal = await h.waitForTerminal((entry) => entry.needsReview === true)
    assert.ok(terminal, '대시보드 스냅숏에 needsReview true가 있어야 한다')
    assert.equal(terminal.phase, 'NEEDS_REVIEW')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 6. 워크트리 scope(W1 off / W2 on)
// ---------------------------------------------------------------------------

test('scenario 6: W1을 dashboard로 off하면 W2만 전송한다(활성 worktree 무관)', async () => {
  const h = await createHarness({
    enabled: true,
    terminals: twoWorktreeTerminals(),
    // 현재 활성 worktree는 W1을 가리키지만 W2 전송에는 영향이 없어야 한다.
    workspaceContext: { terminals: [{ id: 'h1' }] },
  })
  try {
    await h.start()

    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    const wt1 = (dashboard.state.worktrees ?? []).find((worktree) => worktree.label === 'w1')
    assert.ok(wt1, 'W1 worktree가 스냅숏에 있어야 한다')

    // expectedRevision으로 W1만 끈다.
    const revoked = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: { type: 'worktree', targetId: wt1.id, enabled: false, expectedRevision: dashboard.state.revision },
    })
    assert.equal(revoked.status, 200, 'W1 off POST 성공')

    const t1 = h.clock.now()
    h.host.emit('agent.status.changed', {
      worktreeId: 'wt1',
      paneKey: 'tab1:leaf1',
      state: 'working',
      receivedAt: t1,
    })
    h.host.emit('agent.status.changed', {
      worktreeId: 'wt2',
      paneKey: 'tab2:leaf2',
      state: 'working',
      receivedAt: t1,
    })
    await h.clock.settle(80)
    h.host.emit('agent.status.changed', {
      worktreeId: 'wt1',
      paneKey: 'tab1:leaf1',
      state: 'done',
      receivedAt: t1 + 1000,
    })
    h.host.emit('agent.status.changed', {
      worktreeId: 'wt2',
      paneKey: 'tab2:leaf2',
      state: 'done',
      receivedAt: t1 + 1000,
    })
    await h.clock.settle(80)

    await h.advanceTo(t1 + 1000 + DUE_5M + TICK_MS * 2)
    await h.waitForSendFrames(2)

    const frames = h.sendFrames()
    assert.equal(frames.length, 2, 'W2만 paste+Enter')
    assert.ok(frames.every((frame) => frame.params.terminal === 'h2'), 'W1은 전송하지 않는다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 7. 대시보드 HTTP 인증 + terminal off
// ---------------------------------------------------------------------------

test('scenario 7: 인증된 dashboard로 해당 terminal을 끄면 전송 0', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200, 'token으로 GET /api/state 200')
    assert.equal(typeof dashboard.state.revision, 'number')

    const noToken = await requestJson({
      port: dashboard.port,
      path: '/api/state',
      origin: dashboard.origin,
    })
    assert.equal(noToken.status, 401, 'token 없으면 401')

    const wrongOrigin = await requestJson({
      port: dashboard.port,
      path: '/api/state',
      token: dashboard.token,
      origin: 'http://evil.example',
    })
    assert.equal(wrongOrigin.status, 403, '다른 Origin은 403')

    const terminal = (dashboard.state.worktrees ?? [])
      .flatMap((worktree) => worktree.terminals ?? [])
      .find((entry) => entry.id !== undefined)
    assert.ok(terminal, '터미널 targetId가 있어야 한다')

    const off = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: { type: 'terminal', targetId: terminal.id, enabled: false, expectedRevision: dashboard.state.revision },
    })
    assert.equal(off.status, 200, 'terminal off POST 성공')

    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'terminal off면 전송 0')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 8. paste 응답 drop → 재전송 0 + needsReview
// ---------------------------------------------------------------------------

test('scenario 8: paste 응답 유실이면 재전송 0, Enter 0, needsReview', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.failNext('terminal.send', { kind: 'drop', count: 1 })
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.waitForSendFrames(1)
    await h.clock.settle(200)

    assert.equal(h.sendFrames().length, 1, 'paste 1회만 시도하고 재전송하지 않는다')
    assert.equal(h.sendFrames().filter((frame) => frame.params.enter === true).length, 0, 'Enter 0')

    // 추가 tick에도 재전송하지 않는다.
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 1, '추가 시간이 지나도 재전송 0')

    const review = await h.waitForTerminal((entry) => entry.needsReview === true)
    assert.ok(review, 'needsReview가 표시되어야 한다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 9. clock jump(절전)
// ---------------------------------------------------------------------------

test('scenario 9: wall 1시간 점프 뒤에는 burst 전송 0', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    await h.arm()
    // monotonic은 그대로 두고 wall만 1시간 점프한다.
    h.clock.jumpWall(TTL_1H)
    await h.advanceTo(h.clock.now() + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'clock gap 뒤에는 전송하지 않는다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 10. pause/resume
// ---------------------------------------------------------------------------

test('scenario 10: pause면 전송 0, resume 뒤 다음 turn부터 재개', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    await h.host.runCommand('keepalive-pause')

    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'pause 중 전송 0')

    await h.host.runCommand('keepalive-resume')
    const doneAt2 = await h.arm()
    await h.advanceTo(doneAt2 + DUE_5M + TICK_MS)
    await h.waitForSendFrames(2)
    assert.equal(h.sendFrames().length, 2, 'resume 뒤 다음 turn에서 재개')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 11. host heartbeat
// ---------------------------------------------------------------------------

test('scenario 11: 5분 이상 가상 시간 동안 host.call(storage.get) heartbeat가 있다', async () => {
  const h = await createHarness({ enabled: false })
  try {
    await h.start()
    const before = h.host.countHostCall('storage.get')
    await h.advanceTo(h.clock.now() + 5 * 60000 + TICK_MS)
    await h.settleSend()
    const after = h.host.countHostCall('storage.get')
    assert.ok(after > before, `heartbeat가 있어야 한다(before=${before}, after=${after})`)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 12. 탭 제목 캐시 상태 표시(실험 옵션) on → rename, off → rename(null)
//   관측 전(초기 UNKNOWN)은 💤, fresh working→done으로 예약이 열리면 ⚡.
// ---------------------------------------------------------------------------

test('scenario 12: 관측 전 탭은 💤, fresh working→done 뒤 ⚡로 바뀌고 off면 원래대로 되돌린다', async () => {
  const INITIAL_PREFIX = '💤 '
  const KEPT_PREFIX = '⚡ '
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    assert.equal(dashboard.state.config.tabTitleIndicator, true, '기본값은 켜짐(true)')

    const on = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { tabTitleIndicator: true },
        expectedRevision: dashboard.state.revision,
      },
    })
    assert.equal(on.status, 200, '옵션 on POST 성공')

    // 관측 전(초기 UNKNOWN): 유지 예약이 없으므로 💤.
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(
      () => h.runtime.getTerminal('h1').customTitle === INITIAL_PREFIX + 'W1 terminal',
      { clock: h.clock },
    )
    assert.equal(h.runtime.getTerminal('h1').customTitle, INITIAL_PREFIX + 'W1 terminal')

    // rename은 session.tabs.list 항목 id(tab1::leaf1)가 아니라 terminal handle(h1)로 호출된다.
    const renames = h.runtime.frames.filter((frame) => frame.method === 'terminal.rename')
    assert.ok(renames.length > 0, 'rename frame이 있어야 한다')
    assert.ok(
      renames.every((frame) => frame.params && frame.params.terminal === 'h1'),
      'rename은 terminal handle로만 호출된다',
    )

    // fresh working→done으로 유지 예약이 열리면 같은 탭이 ⚡로 바뀐다(기호 전환 rename 1회).
    await h.arm()
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(
      () => h.runtime.getTerminal('h1').customTitle === KEPT_PREFIX + 'W1 terminal',
      { clock: h.clock },
    )
    const keptRenames = h.runtime.frames.filter(
      (frame) =>
        frame.method === 'terminal.rename' &&
        frame.params &&
        frame.params.title === KEPT_PREFIX + 'W1 terminal',
    )
    assert.equal(keptRenames.length, 1, '💤→⚡ 전환 rename은 1회')

    const off = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { tabTitleIndicator: false },
        expectedRevision: on.body.revision,
      },
    })
    assert.equal(off.status, 200, '옵션 off POST 성공')

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(
      () =>
        h.runtime.frames.some(
          (frame) =>
            frame.method === 'terminal.rename' &&
            frame.params &&
            (frame.params.title === null || frame.params.title === ''),
        ),
      { clock: h.clock },
    )
    assert.equal(h.runtime.getTerminal('h1').customTitle, null, 'off면 원래대로 되돌린다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 13. 런타임 제목이 바뀐 뒤 off — tabs.list title ≠ applied여도 해제
// ---------------------------------------------------------------------------

test('scenario 13: 관측 전 💤가 적용된 뒤 런타임 제목이 달라져도 off면 customTitle을 해제한다', async () => {
  const PREFIX = '💤 '
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)

    const on = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { tabTitleIndicator: true },
        expectedRevision: dashboard.state.revision,
      },
    })
    assert.equal(on.status, 200, '옵션 on POST 성공')

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(
      () => h.runtime.getTerminal('h1').customTitle === PREFIX + 'W1 terminal',
      { clock: h.clock },
    )

    // Claude Code가 OSC/PTY 제목을 계속 갱신해 session.tabs.list title이 applied와
    // 달라진 상태를 만든다. 실제 Orca는 customTitle을 알려주지 않는다.
    h.runtime.setTitle('h1', '⠂ Claude Code')
    assert.notEqual(h.runtime.getTerminal('h1').title, PREFIX + 'W1 terminal')

    const off = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { tabTitleIndicator: false },
        expectedRevision: on.body.revision,
      },
    })
    assert.equal(off.status, 200, '옵션 off POST 성공')

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(
      () =>
        h.runtime.frames.some(
          (frame) =>
            frame.method === 'terminal.rename' &&
            frame.params &&
            frame.params.terminal === 'h1' &&
            (frame.params.title === null || frame.params.title === ''),
        ),
      { clock: h.clock },
    )
    assert.equal(
      h.runtime.getTerminal('h1').customTitle,
      null,
      'tabs.list title이 applied와 달라도 customTitle은 해제된다',
    )
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 14. epoch 메모리 영속/복원(플러그인 리로드)
// ---------------------------------------------------------------------------

test('scenario 14: deactivate→재activate 뒤 저장된 예약을 ARMED로 복원하고 epoch_restored를 남긴다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()

    // done으로 epoch를 열면 실제 epoch-memory가 host storage에 예약을 저장한다.
    const doneAt = await h.arm()
    await waitFor(() => h.host.storage.has('epochs-v1'), { clock: h.clock })

    // 대시보드를 먼저 열지 않는다(리로드 시 서버가 닫히므로 캐시가 무효해진다).
    await h.reload()

    const restored = await h.waitForTerminal((terminal) => terminal.phase === 'ARMED')
    assert.ok(restored, '재activate 뒤 ARMED로 복원되어야 한다')
    // 저장된 basisAt(마지막 working = done 1초 전)이 복원돼 예약 시각 계산에 쓰인다.
    assert.equal(restored.dueAt, doneAt - 1000 + DUE_5M, 'dueAt = basisAt + TTL - margin')
    assert.equal(restored.expiresAt, doneAt - 1000 + TTL_5M)

    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    assert.ok(
      dashboard.state.diagnostics.some((entry) => entry.event === 'epoch_restored'),
      'epoch_restored 진단이 기록되어야 한다',
    )
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 15. 명시 5분 TTL + Orca fixture TTL 변경은 스케줄에 영향 없음
// ---------------------------------------------------------------------------

test('scenario 15: 명시 5분 config로 dueAt을 계산하고 Orca fixture TTL 변경에 영향받지 않는다', async () => {
  const h = await createHarness({ enabled: true, ttlMs: TTL_1H, pluginTtlMs: TTL_5M })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const before = await h.waitForTerminal((entry) => entry.cacheStatus === 'scheduled')
    assert.equal(before.expiresAt, basisAt + TTL_5M, 'expiresAt = basisAt + 명시 5분')
    assert.equal(before.dueAt, basisAt + DUE_5M, 'dueAt = basisAt + 5분 TTL - margin5m')

    // Orca fixture 타이머 TTL을 1시간으로 바꿔도 플러그인 config 스케줄은 그대로다.
    await h.userData.setTimerSettings({ enabled: false, ttlMs: TTL_1H })
    const payload = await h.userData.readPayload()
    assert.equal(payload.ttlMs, TTL_1H, 'Orca fixture TTL은 1시간으로 바뀌었다')

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const after = await h.waitForTerminal((entry) => entry.cacheStatus === 'scheduled')
    assert.equal(after.dueAt, basisAt + DUE_5M, 'Orca fixture TTL 변경 뒤에도 5분 그대로')
    assert.equal(after.expiresAt, basisAt + TTL_5M)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 16. config action으로 claudeCacheTtlMs 변경 → ARMED due 재계산
// ---------------------------------------------------------------------------

test('scenario 16: config action으로 claudeCacheTtlMs를 바꾸면 ARMED dueAt을 재계산한다', async () => {
  const h = await createHarness({ enabled: true, pluginTtlMs: TTL_5M })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const before = await h.waitForTerminal((entry) => entry.cacheStatus === 'scheduled')
    assert.equal(before.dueAt, basisAt + DUE_5M, '처음에는 5분 기준 dueAt')

    const dashboard = await h.openDashboard()
    const changed = await requestJson({
      method: 'POST',
      port: dashboard.port,
      path: '/api/action',
      token: dashboard.token,
      origin: dashboard.origin,
      body: {
        type: 'config',
        patch: { claudeCacheTtlMs: TTL_1H },
        expectedRevision: dashboard.state.revision,
      },
    })
    assert.equal(changed.status, 200, 'claudeCacheTtlMs 1시간 config POST 성공')

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const after = await h.waitForTerminal(
      (entry) => entry.cacheStatus === 'scheduled' && entry.dueAt === basisAt + DUE_1H,
    )
    assert.equal(after.dueAt, basisAt + DUE_1H, 'dueAt이 1시간 기준으로 재계산된다')
    assert.equal(after.expiresAt, basisAt + TTL_1H, 'expiresAt도 1시간으로 재계산된다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 17. 활성 프로필 index 손상/누락 → 전송 0(SETTINGS_UNKNOWN)
// ---------------------------------------------------------------------------

test('scenario 17: 활성 프로필 index가 손상되면 예약돼도 전송 0(SETTINGS_UNKNOWN)', async () => {
  const h = await createHarness({ enabled: true, pluginTtlMs: TTL_5M })
  try {
    // 활성화 전에 index를 손상시킨다(프로필 unknown).
    await writeFile(
      join(h.userData.userDataPath, 'orca-profile-index.json'),
      '{not-json',
      'utf8',
    )

    await h.start()
    const doneAt = await h.arm()
    await h.advanceTo(doneAt + DUE_5M + TICK_MS)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, '프로필 unknown이면 예약돼도 전송 0')

    const dashboard = await h.openDashboard()
    assert.equal(dashboard.status, 200)
    assert.equal(dashboard.state.profileSettings.known, false, 'profileSettings.known=false')
  } finally {
    await h.cleanup()
  }
})
