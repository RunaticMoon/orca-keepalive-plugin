/**
 * 🔧[CXPR-C022] N : 캐시 상태 표시 전 경로 통합 회귀.
 *
 * 실제 제품 모듈 전체(`createPlugin`)를 가짜 런타임 소켓·가짜 host·임시 SQLite
 * 설정 위에서 돌린다. 사용자 문제(켜짐으로 보이는데 캐시는 만료, 재시작 후
 * "완료된 작업 없음")가 관측→전송 차단→만료→영속→재시작→새 턴 전체 경로에서
 * 해결됐음을 대시보드 HTTP snapshot과 탭 제목으로 고정한다.
 *
 * 제품 코드는 이 파일에서 수정하지 않는다. 실제 Orca/shell/claude도 쓰지 않는다.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

import { createPlugin } from '../../main.mjs'
import { createCoordinator } from '../../src/coordinator.mjs'
import { createEpochMemory } from '../../src/epoch-memory.mjs'
import { CACHE_HISTORY_RETENTION_MS } from '../../src/contracts.mjs'
import { DEFAULT_CONFIG } from '../../src/config.mjs'
import { STATE_KEY } from '../../src/state-store.mjs'
import { createFakeClock } from '../fixtures/fake-clock.mjs'
import { startFakeRuntime } from '../fixtures/fake-runtime.mjs'
import { createOrcaUserData } from '../fixtures/orca-userdata.mjs'
import { createFakeHost } from '../fixtures/fake-host.mjs'

const TTL_5M = 300000
const MARGIN_5M = 60000
const DUE_5M = TTL_5M - MARGIN_5M // 240000
const TTL_1H = 3600000
const MARGIN_1H = 120000
const DUE_1H = TTL_1H - MARGIN_1H // 3480000
const TICK_MS = 2000
const PANE_KEY = 'tab1:leaf1'
const HANDLE = 'h1'
const WORKTREE = 'wt1'
const TITLE = 'W1 terminal'

const KEPT_PREFIX = '⚡ '
const NONE_PREFIX = '💤 '
const REVIEW_PREFIX = '⚠️ '
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
async function waitFor(predicate, { timeoutMs = 6000, clock } = {}) {
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

/**
 * 통합 하네스를 만든다. tmp userData + fake runtime + fake host + fake clock 위에서
 * 실제 createPlugin을 활성화한다. 캡처한 coordinator 인스턴스로 내부 이력도 본다.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled] Orca fixture의 promptCacheTimerEnabled(이제 TTL·게이트와 무관).
 * @param {number} [options.pluginTtlMs] 플러그인 config TTL(ms)로 심는 값. 기본 5분(TTL_5M).
 * @param {string} [options.profileId] Orca 활성 프로필 id.
 * @param {number} [options.ttlMs] Orca fixture 타이머 TTL(호환용, 스케줄에는 쓰이지 않음).
 */
async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cxpr-cache-'))
  const socketPath = join(root, 'runtime.sock')
  const fakePid = 40000 + Math.floor(Math.random() * 10000)
  const userData = await createOrcaUserData({
    root,
    pid: fakePid,
    socketPath,
    profileId: options.profileId ?? 'profile-1',
    enabled: options.enabled ?? false,
    // Orca 타이머 값은 더 이상 TTL 출처가 아니다(fixture 호환용).
    ttlMs: options.ttlMs ?? TTL_5M,
  })
  const runtime = await startFakeRuntime({
    socketPath,
    authToken: userData.authToken,
    runtimeId: userData.runtimeId,
  })
  runtime.addTerminal({
    handle: HANDLE,
    worktreeId: WORKTREE,
    tabId: 'tab1',
    leafId: 'leaf1',
    title: TITLE,
    branch: 'main',
  })

  const host = createFakeHost()
  const clock = createFakeClock()

  // 스케줄 TTL은 플러그인 config(claudeCacheTtlMs)에서 온다. Orca fixture의 타이머
  // 값은 무시되므로, 활성화 전에 state-v1에 원하는 TTL을 심는다(형식은 state-store의
  // validatePersistedState 계약과 동일: envelope schemaVersion 1 + parseConfig config).
  host.storage.set(STATE_KEY, {
    schemaVersion: 1,
    revision: 0,
    config: { ...DEFAULT_CONFIG, claudeCacheTtlMs: options.pluginTtlMs ?? TTL_5M },
    profiles: [],
  })

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

  const h = {
    root,
    userData,
    runtime,
    host,
    clock,
    fakePid,

    async start() {
      await clock.settle(40)
      await waitFor(
        () => runtime.frames.some((frame) => frame.method === 'terminal.list'),
        { clock },
      )
      await clock.advance(TICK_MS + 500)
    },

    /** deactivate 후 같은 host/runtime/clock 위에서 다시 activate한다. */
    async reload() {
      await plugin.deactivate()
      const listBefore = runtime.frames.filter((frame) => frame.method === 'terminal.list').length
      plugin = createPlugin(host.orca, pluginDeps)
      plugin.activate()
      dashboardInfo = null
      await clock.settle(40)
      await waitFor(
        () => runtime.frames.filter((frame) => frame.method === 'terminal.list').length > listBefore,
        { clock },
      )
      await clock.advance(TICK_MS + 500)
    },

    /**
     * agent.status.changed 이벤트를 보내고 drain이 끝날 때까지 이벤트 루프를 양보한다.
     * @param {{worktreeId:string, paneKey:string, state:string, receivedAt?:number}} payload
     */
    async event(payload) {
      host.emit('agent.status.changed', { receivedAt: clock.now(), ...payload })
      await clock.settle(80)
    },

    /** working → done으로 epoch를 연다. doneAt을 반환한다. */
    async arm({ doneOffset = 1000 } = {}) {
      const t0 = clock.now()
      await h.event({ worktreeId: WORKTREE, paneKey: PANE_KEY, state: 'working', receivedAt: t0 })
      await h.event({
        worktreeId: WORKTREE,
        paneKey: PANE_KEY,
        state: 'done',
        receivedAt: t0 + doneOffset,
      })
      return t0 + doneOffset
    },

    /** wall이 atWall이 되도록 가상 시간을 진행한다. */
    async advanceTo(atWall) {
      const delta = atWall - clock.now()
      if (delta > 0) await clock.advance(delta)
    },

    async settleSend() {
      await clock.settle(300)
    },

    sendFrames() {
      return runtime.sendFrames()
    },

    /** dashboard를 시작하고 token/port/snapshot을 반환한다. 재시작 뒤에는 다시 띄운다. */
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
          throw new Error('dashboard URL not found in notification: ' + JSON.stringify(notification))
        }
        dashboardInfo = {
          port: Number(match[1]),
          token: match[2],
          origin: `http://127.0.0.1:${Number(match[1])}`,
        }
      }
      const state = await requestJson({
        port: dashboardInfo.port,
        path: '/api/state',
        token: dashboardInfo.token,
      })
      return { ...dashboardInfo, state: state.body, status: state.status }
    },

    /**
     * 대시보드 config action(POST /api/action)으로 플러그인 config를 갱신한다.
     * 성공 시 새 snapshot을 반환한다.
     * @param {object} patch
     * @returns {Promise<object>}
     */
    async updatePluginConfig(patch) {
      const dashboard = await h.openDashboard()
      const res = await requestJson({
        method: 'POST',
        port: dashboard.port,
        path: '/api/action',
        token: dashboard.token,
        origin: dashboard.origin,
        body: { type: 'config', patch, expectedRevision: dashboard.state.revision },
      })
      if (res.status !== 200) {
        throw new Error('config action failed: ' + res.status + ' ' + JSON.stringify(res.body))
      }
      return res.body
    },

    /** 대시보드 snapshot의 첫 terminal을 찾는다(단일 터미널 하네스, 없으면 null). */
    async dashboardTerminal() {
      const dashboard = await h.openDashboard()
      if (dashboard.status !== 200) {
        return null
      }
      const terminals = (dashboard.state.worktrees ?? []).flatMap(
        (worktree) => worktree.terminals ?? [],
      )
      return terminals.length > 0 ? terminals[0] : null
    },

    /**
     * 대시보드 snapshot에서 조건에 맞는 터미널이 나올 때까지 폴링한다.
     * @param {(terminal: any) => boolean} predicate
     */
    async waitForTerminal(predicate, { timeoutMs = 8000 } = {}) {
      const deadline = Date.now() + timeoutMs
      let last = null
      for (;;) {
        try {
          const term = await h.dashboardTerminal()
          if (term) last = term
          if (term && predicate(term)) return term
        } catch (error) {
          // rate limit(429) 등 일시적 오류는 폴링을 계속한다.
          last = { error: String(error) }
        }
        if (Date.now() > deadline) {
          throw new Error('terminal predicate timeout: ' + JSON.stringify(last))
        }
        await realDelay(60)
        await clock.settle(20)
      }
    },

    /** 탭 customTitle이 `${prefix}${TITLE}`가 될 때까지 기다린다. */
    async waitForTitle(prefix, { timeoutMs = 6000 } = {}) {
      const expected = prefix + TITLE
      await waitFor(() => runtime.getTerminal(HANDLE).customTitle === expected, {
        clock,
        timeoutMs,
      })
      return expected
    },

    /** 저장된 epoch-memory 레코드(target identity가 worktreeId와 같은 것)를 반환한다. */
    storedRecord(worktreeId = WORKTREE) {
      const value = host.storage.get('epochs-v1')
      if (!value || typeof value !== 'object' || !value.entries) return null
      for (const record of Object.values(value.entries)) {
        if (record && record.worktreeId === worktreeId) return record
      }
      return null
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
  return h
}

// ---------------------------------------------------------------------------
// 시나리오 1. fresh working→done → kept/scheduled, 탭 ⚡
// ---------------------------------------------------------------------------

test('cache-state 1: fresh working→done은 kept/scheduled과 ⚡를 표시한다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    const expiresAt = basisAt + TTL_5M

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(KEPT_PREFIX)

    const term = await h.waitForTerminal((t) => t.cacheStatus === 'scheduled')
    assert.equal(term.phase, 'ARMED')
    assert.equal(term.cacheState, 'kept')
    assert.equal(term.cacheStatus, 'scheduled')
    assert.equal(term.indicatorOn, true)
    assert.equal(term.expiresAt, expiresAt, 'expiresAt = basisAt + TTL')
    assert.equal(term.dueAt, expiresAt - MARGIN_5M, 'dueAt = expiresAt - margin')
    assert.equal(term.expireCause, null)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, KEPT_PREFIX + TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 2. due 이후 DRAFT_PRESENT 반복 → 전송 0 → 실제 만료 후 none/expired
// ---------------------------------------------------------------------------

test('cache-state 2: DRAFT_PRESENT로 전송 0, 실제 만료 후 expireCause=DRAFT_PRESENT와 💤', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    // 사용자가 입력창에 초안을 남겨 guarded-send preflight가 계속 차단하게 한다.
    h.runtime.setDraft(HANDLE, '사용자 초안 텍스트')

    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    const expiresAt = basisAt + TTL_5M

    // due를 지나면 전송 시도가 있지만 초안 때문에 frame은 0건이다.
    await h.advanceTo(basisAt + DUE_5M + TICK_MS * 2)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'draft가 있으면 terminal.send 0건')

    // 만료 전: 예약은 아직 kept이고 마지막 차단 원인은 이미 기록된다.
    const before = await h.waitForTerminal((t) => t.blockedReason === 'DRAFT_PRESENT')
    assert.equal(before.cacheState, 'kept')
    assert.equal(before.blockedReason, 'DRAFT_PRESENT')

    // 실제 expiresAt을 지나면 none/expired로 전환한다.
    await h.advanceTo(expiresAt + TICK_MS)
    await h.waitForTitle(NONE_PREFIX)

    const term = await h.waitForTerminal((t) => t.cacheStatus === 'expired')
    assert.equal(term.phase, 'EXPIRED')
    assert.equal(term.cacheState, 'none')
    assert.equal(term.cacheStatus, 'expired')
    assert.equal(term.expireCause, 'DRAFT_PRESENT')
    assert.equal(term.blockedReason, 'DRAFT_PRESENT')
    assert.equal(term.expiredAt, expiresAt, 'expiredAt은 tick 시각이 아니라 expiresAt')
    assert.equal(term.expiresAt, expiresAt)
    assert.equal(term.indicatorOn, true)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, NONE_PREFIX + TITLE)
    assert.equal(h.sendFrames().length, 0, '만료까지 전송 0건')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 3+4. 재시작 후 동일 만료 이력 유지 → fresh turn으로 이력 삭제·새 ARMED
// ---------------------------------------------------------------------------

test('cache-state 3: 재시작(새 incarnation) 뒤에도 만료 시각·원인·💤를 유지하고 전송하지 않는다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setDraft(HANDLE, '사용자 초안 텍스트')
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    const expiresAt = basisAt + TTL_5M

    await h.advanceTo(basisAt + DUE_5M + TICK_MS * 2)
    await h.settleSend()
    await h.advanceTo(expiresAt + TICK_MS)
    await h.waitForTerminal((t) => t.cacheStatus === 'expired')

    // 저장 레코드가 표시 전용 history로 남아 있어야 한다.
    const stored = h.storedRecord()
    assert.ok(stored, '만료 이력이 storage에 저장되어야 한다')
    assert.equal(stored.kind, 'history')
    assert.equal(stored.expiredAt, expiresAt)
    assert.equal(stored.lastBlockReason, 'DRAFT_PRESENT')

    // 같은 ptyId, 새 incarnationId로 재시작한다.
    h.runtime.getTerminal(HANDLE).incarnationId = 'inc-restart'
    await h.reload()

    const restored = await h.waitForTerminal((t) => t.cacheStatus === 'expired')
    assert.equal(restored.phase, 'EXPIRED', 'UNKNOWN/NO_FRESH_TURN으로 되돌리지 않는다')
    assert.equal(restored.cacheState, 'none')
    assert.equal(restored.expireCause, 'DRAFT_PRESENT')
    assert.equal(restored.expiredAt, expiresAt)
    assert.equal(restored.expiresAt, expiresAt)

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(NONE_PREFIX)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, NONE_PREFIX + TITLE)

    // 재시작 후 due가 지나도 예약을 되살려 전송하지 않는다.
    await h.advanceTo(h.clock.now() + TTL_5M)
    await h.settleSend()
    assert.equal(h.sendFrames().length, 0, 'history는 전송 예약으로 복원하지 않는다')

    // 이어서 fresh working → 이력 삭제(원인 초기화) → done → 새 ARMED ⚡.
    const t1 = h.clock.now()
    await h.event({ worktreeId: WORKTREE, paneKey: PANE_KEY, state: 'working', receivedAt: t1 })
    await h.clock.settle(120)
    const busy = await h.waitForTerminal((t) => t.phase === 'BUSY')
    assert.equal(busy.cacheState, 'kept')
    assert.equal(busy.cacheStatus, 'working')
    assert.equal(busy.expireCause, null, '새 working은 만료 이력을 삭제한다')
    assert.equal(busy.blockedReason, null)

    await h.event({
      worktreeId: WORKTREE,
      paneKey: PANE_KEY,
      state: 'done',
      receivedAt: t1 + 1000,
    })
    await h.clock.settle(120)

    const armed = await h.waitForTerminal((t) => t.cacheStatus === 'scheduled')
    assert.equal(armed.phase, 'ARMED')
    assert.equal(armed.cacheState, 'kept')
    assert.equal(armed.expiresAt, t1 + TTL_5M, '새 이력의 expiresAt = 새 basisAt + TTL')
    assert.equal(armed.expireCause, null)

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(KEPT_PREFIX)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, KEPT_PREFIX + TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 5. 만료 이력 후 24시간 경과 → 이력·저장 레코드 삭제, no-reservation
// ---------------------------------------------------------------------------

test('cache-state 4: 만료 이력은 24시간이 지나면 이력과 저장 레코드를 함께 지운다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    h.runtime.setDraft(HANDLE, '사용자 초안 텍스트')
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    const expiresAt = basisAt + TTL_5M

    await h.advanceTo(basisAt + DUE_5M + TICK_MS * 2)
    await h.settleSend()
    await h.advanceTo(expiresAt + TICK_MS)
    await h.waitForTerminal((t) => t.cacheStatus === 'expired')
    assert.ok(h.storedRecord(), '만료 이력이 먼저 저장돼야 한다')

    // wall/mono를 함께 점프해 clock gap으로 오인되지 않게 한 뒤 tick 1회를 진행한다.
    const jump = expiresAt + CACHE_HISTORY_RETENTION_MS - h.clock.now() + TICK_MS
    h.clock.jumpWall(jump)
    h.clock.jumpMono(jump)
    await h.clock.advance(TICK_MS)

    const term = await h.waitForTerminal((t) => t.cacheStatus === 'no-reservation')
    assert.equal(term.cacheState, 'none')
    assert.equal(term.expireCause, null)
    assert.equal(term.blockedReason, null)
    assert.equal(term.expiresAt, null)
    assert.equal(term.expiredAt, null)
    assert.equal(h.storedRecord(), null, '저장 레코드도 함께 삭제되어야 한다')
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 6. 검토 필요(전송 결과 불확실) → review / ⚠️
// ---------------------------------------------------------------------------

test('cache-state 5: 전송 결과가 불확실하면 review(⚠️)를 표시한다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    // paste 직후 draft를 변조해 Enter 전 검증이 실패하게 만든다(불확실 경로).
    h.runtime.setPasteMutator((_params, terminal) => {
      terminal.draft = (terminal.draft ?? '') + 'X'
    })
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    await h.advanceTo(basisAt + DUE_5M + TICK_MS * 2)
    await waitFor(() => h.sendFrames().length >= 1, { clock: h.clock })
    await h.clock.settle(200)

    const term = await h.waitForTerminal((t) => t.cacheState === 'review')
    assert.equal(term.cacheStatus, 'review')
    assert.equal(term.needsReview, true)

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(REVIEW_PREFIX)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, REVIEW_PREFIX + TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 7. keepalive off/paused → 탭 prefix 제거
// ---------------------------------------------------------------------------

test('cache-state 6: paused(keepalive off)면 탭 prefix를 제거한다', async () => {
  const h = await createHarness({ enabled: true })
  try {
    await h.start()
    await h.arm()
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(KEPT_PREFIX)

    await h.host.runCommand('keepalive-pause')
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await waitFor(() => h.runtime.getTerminal(HANDLE).customTitle === null, {
      clock: h.clock,
    })
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, null, 'paused면 prefix를 제거한다')

    // 탭 제목에 남은 기호가 없어야 한다.
    const title = h.runtime.getTerminal(HANDLE).customTitle
    assert.ok(title === null || title === TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 7. 플러그인 config TTL 변경(5분→1시간) → 표시 expiresAt RETIME
// ---------------------------------------------------------------------------

test('cache-state 7: config TTL을 5분→1시간으로 바꾸면 표시 expiresAt가 새 TTL로 갱신된다', async () => {
  const h = await createHarness({ enabled: true, pluginTtlMs: TTL_5M })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000

    const before = await h.waitForTerminal((t) => t.cacheStatus === 'scheduled')
    assert.equal(before.expiresAt, basisAt + TTL_5M, '처음에는 5분 TTL')
    assert.equal(before.dueAt, basisAt + DUE_5M)

    // 대시보드 config action으로 플러그인 TTL을 1시간으로 올린다.
    const updated = await h.updatePluginConfig({ claudeCacheTtlMs: TTL_1H })
    assert.equal(updated.config.claudeCacheTtlMs, TTL_1H, 'config action이 TTL을 저장한다')

    // 다음 tick에서 살아 있는 같은 epoch의 이력이 새 TTL로 RETIME된다.
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const after = await h.waitForTerminal((t) => t.expiresAt === basisAt + TTL_1H)
    assert.equal(after.phase, 'ARMED')
    assert.equal(after.cacheState, 'kept')
    assert.equal(after.cacheStatus, 'scheduled')
    assert.equal(after.dueAt, basisAt + DUE_1H, 'dueAt도 1시간 margin으로 재계산')
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, KEPT_PREFIX + TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 8. Orca 타이머 OFF여도 플러그인 config TTL로 정상 표시(⚡)
// ---------------------------------------------------------------------------

test('cache-state 8: Orca 타이머가 꺼져 있어도 플러그인 config TTL로 kept/⚡를 표시한다', async () => {
  const h = await createHarness({ enabled: false, pluginTtlMs: TTL_5M })
  try {
    await h.start()
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000

    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    const term = await h.waitForTerminal((t) => t.cacheStatus === 'scheduled')
    assert.equal(term.phase, 'ARMED')
    assert.equal(term.cacheState, 'kept')
    assert.equal(term.cacheStatus, 'scheduled')
    assert.equal(term.indicatorOn, true, 'Orca 타이머 OFF는 표시 게이트가 아니다')
    assert.equal(term.expiresAt, basisAt + TTL_5M)
    await h.waitForTitle(KEPT_PREFIX)
    assert.equal(h.runtime.getTerminal(HANDLE).customTitle, KEPT_PREFIX + TITLE)
  } finally {
    await h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 시나리오 9. 과거 APP_TIMER_OFF 이력 호환 복원
// ---------------------------------------------------------------------------

test('cache-state 9: 과거 APP_TIMER_OFF 이력도 로드·표시가 깨지지 않는다', async () => {
  const h = await createHarness({ enabled: true, pluginTtlMs: TTL_5M })
  try {
    await h.start()
    h.runtime.setDraft(HANDLE, '사용자 초안 텍스트')
    const doneAt = await h.arm()
    const basisAt = doneAt - 1000
    const expiresAt = basisAt + TTL_5M

    await h.advanceTo(basisAt + DUE_5M + TICK_MS * 2)
    await h.settleSend()
    await h.advanceTo(expiresAt + TICK_MS)
    await h.waitForTerminal((t) => t.cacheStatus === 'expired')

    // 저장된 만료 이력의 lastBlockReason을 레거시 APP_TIMER_OFF로 바꾼 뒤 재시작한다.
    const value = h.host.storage.get('epochs-v1')
    assert.ok(value && value.entries, 'epochs-v1 저장값이 있어야 한다')
    for (const record of Object.values(value.entries)) {
      if (record && record.worktreeId === WORKTREE) {
        record.lastBlockReason = 'APP_TIMER_OFF'
      }
    }
    h.host.storage.set('epochs-v1', value)

    h.runtime.getTerminal(HANDLE).incarnationId = 'inc-app-timer-off'
    await h.reload()

    const restored = await h.waitForTerminal((t) => t.cacheStatus === 'expired')
    assert.equal(restored.phase, 'EXPIRED')
    assert.equal(restored.cacheState, 'none')
    assert.equal(restored.expireCause, 'APP_TIMER_OFF', '과거 APP_TIMER_OFF를 만료 원인으로 유지')
    assert.equal(restored.expiredAt, expiresAt)
    assert.equal(restored.expiresAt, expiresAt)
    await h.advanceTo(h.clock.now() + TICK_MS * 3)
    await h.waitForTitle(NONE_PREFIX)
  } finally {
    await h.cleanup()
  }
})
