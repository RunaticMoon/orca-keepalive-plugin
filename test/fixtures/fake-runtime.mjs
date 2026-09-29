/**
 * 🔧[OKAP-D1C9] P : 가짜 Orca 런타임 fixture.
 *
 * 실제 Orca 없이 §4.2 wire(줄단위 JSON + authToken + `_meta.runtimeId`)를 그대로
 * 구현하는 `node:net` 서버다. 메모리 터미널 모델만 유지하며 shell/claude를 실행하지
 * 않는다. `terminal.send`/bracketed paste/Enter를 해석해 draft와 submissions를
 * 갱신하고, 모든 요청을 `frames`에 기록한다. fault 주입으로 응답 유실/오류/형식
 * 오류/wrong runtime을 재현할 수 있다.
 *
 * 테스트 전용 fixture이며 제품 코드가 아니다.
 *
 * @module fake-runtime
 */

import { createServer } from 'node:net'
import { promises as fs } from 'node:fs'

/**
 * @typedef {'idle'|'working'|'permission'|null} AgentStatus
 *
 * @typedef {Object} FakeTerminal
 * @property {string} handle
 * @property {string} worktreeId
 * @property {string} tabId
 * @property {string} leafId
 * @property {string} paneKey
 * @property {string|null} ptyId
 * @property {string|null} incarnationId
 * @property {string|null} title
 * @property {string|null} customTitle terminal.rename으로 설정된 사용자 제목(null=해제).
 * @property {string|null} branch
 * @property {string} agentIdentity
 * @property {string} executionHostId
 * @property {boolean} connected
 * @property {boolean} writable
 * @property {number} lastOutputAt
 * @property {AgentStatus} agentStatus
 * @property {boolean} isRunningAgent
 * @property {boolean} hasAgentWait show에 agentWait 키를 넣을지 여부(작업 undefined).
 * @property {null|Object} agentWait
 * @property {string|null} draft
 */

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * bracketed paste 본문을 벗긴다. framing이 없으면 원문을 그대로 쓴다.
 * @param {string} text
 * @returns {string}
 */
function unframePaste(text) {
  if (text.startsWith(PASTE_START) && text.endsWith(PASTE_END)) {
    return text.slice(PASTE_START.length, text.length - PASTE_END.length)
  }
  return text
}

/**
 * 가짜 Orca 런타임 서버를 시작한다.
 *
 * @param {Object} options
 * @param {string} options.socketPath unix socket 경로.
 * @param {string} options.authToken metadata의 token.
 * @param {string} options.runtimeId metadata의 runtimeId.
 * @returns {Promise<Object>} runtime handle.
 */
export async function startFakeRuntime({ socketPath, authToken, runtimeId }) {
  /** @type {Map<string, FakeTerminal>} */
  const terminals = new Map()
  /** @type {Array<{method:string, params:any}>} */
  const frames = []
  /** @type {Array<{handle:string, text:string, at:number}>} */
  const submissions = []
  /** @type {Array<{method:string, kind:string, remaining:number}>} */
  const faults = []
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  let browserTabCreateResult = { browserPageId: 'page-1' }
  /** @type {((params:any, terminal:FakeTerminal) => void)|null} */
  let pasteMutator = null
  let closed = false

  // 이전 socket 파일 정리(unix).
  try {
    await fs.rm(socketPath, { force: true })
  } catch {
    // ignore
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    /** @type {Buffer} */
    let buffer = Buffer.alloc(0)

    const writeFrame = (payload) => {
      if (socket.destroyed) return
      try {
        socket.write(JSON.stringify(payload) + '\n')
      } catch {
        // ignore
      }
    }

    const respondOk = (id, result, metaRuntimeId = runtimeId) =>
      writeFrame({ id, ok: true, result, _meta: { runtimeId: metaRuntimeId } })
    const respondError = (id, code, message) =>
      writeFrame({ id, ok: false, error: { code, message } })

    const takeFault = (method) => {
      for (const fault of faults) {
        if (fault.method === method && fault.remaining > 0) {
          fault.remaining -= 1
          return fault.kind
        }
      }
      return null
    }

    const onLine = (line) => {
      if (line.trim().length === 0) return
      let request
      try {
        request = JSON.parse(line)
      } catch {
        respondError(null, 'invalid_json', 'request was not valid JSON')
        return
      }
      const id = isObject(request) ? request.id : undefined
      if (!isObject(request) || request.authToken !== authToken) {
        respondError(id ?? null, 'unauthorized', 'auth token mismatch')
        return
      }
      const method = request.method
      const params = isObject(request.params) ? request.params : {}
      frames.push({ method, params })
      const fault = typeof method === 'string' ? takeFault(method) : null
      let result
      try {
        result = dispatch(method, params)
      } catch (error) {
        const code = isObject(error) && typeof error.code === 'string' ? error.code : 'internal_error'
        respondError(id, code, 'rpc handler failed')
        return
      }

      if (fault === 'drop') {
        socket.destroy()
        return
      }
      if (fault === 'error') {
        respondError(id, 'remote_failure', 'injected error')
        return
      }
      if (fault === 'malformed') {
        try {
          socket.write('{"id":' + '\n')
        } catch {
          // ignore
        }
        return
      }
      if (fault === 'wrongRuntime') {
        respondOk(id, result, runtimeId + '-other')
        return
      }
      respondOk(id, result)
    }

    const dispatch = (method, params) => {
      switch (method) {
        case 'terminal.list':
          return listTerminals()
        case 'terminal.resolvePane':
          return { terminal: resolvePane(params) }
        case 'terminal.show':
          return { terminal: showTerminal(params) }
        case 'terminal.agentStatus':
          return { agentStatus: agentStatusOf(params) }
        case 'terminal.read':
          return { terminal: readTerminal(params) }
        case 'terminal.rename':
          return renameTerminal(params)
        case 'session.tabs.list':
          return sessionTabsList(params)
        case 'terminal.send':
          return { send: handleSend(params) }
        case 'browser.tabCreate':
          return browserTabCreateResult
        default:
          return { unsupported: true }
      }
    }

    /** @param {any} params @returns {FakeTerminal|null} */
    const lookup = (params) =>
      isObject(params) && typeof params.terminal === 'string' ? terminals.get(params.terminal) ?? null : null

    const listTerminals = () => ({
      terminals: [...terminals.values()].map((terminal) => ({
        handle: terminal.handle,
        worktreeId: terminal.worktreeId,
        tabId: terminal.tabId,
        leafId: terminal.leafId,
        ptyId: terminal.ptyId,
        incarnationId: terminal.incarnationId,
        title: terminal.customTitle ?? terminal.title,
        branch: terminal.branch,
        connected: terminal.connected,
        writable: terminal.writable,
        lastOutputAt: terminal.lastOutputAt,
        agentIdentity: terminal.agentIdentity,
        executionHostId: terminal.executionHostId,
      })),
      totalCount: terminals.size,
      truncated: false,
    })

    const resolvePane = (params) => {
      const paneKey = isObject(params) ? params.paneKey : undefined
      const worktreeId = isObject(params) ? params.worktreeId : undefined
      for (const terminal of terminals.values()) {
        if (terminal.paneKey === paneKey && terminal.worktreeId === worktreeId) {
          return {
            handle: terminal.handle,
            tabId: terminal.tabId,
            leafId: terminal.leafId,
            ptyId: terminal.ptyId,
            connected: terminal.connected,
            worktreeId: terminal.worktreeId,
            incarnationId: terminal.incarnationId,
            executionHostId: terminal.executionHostId,
          }
        }
      }
      return null
    }

    const showTerminal = (params) => {
      const terminal = lookup(params)
      if (terminal === null) {
        return null
      }
      /** @type {Record<string, any>} */
      const out = {
        handle: terminal.handle,
        worktreeId: terminal.worktreeId,
        tabId: terminal.tabId,
        leafId: terminal.leafId,
        ptyId: terminal.ptyId,
        incarnationId: terminal.incarnationId,
        title: terminal.customTitle ?? terminal.title,
        branch: terminal.branch,
        agentIdentity: terminal.agentIdentity,
        executionHostId: terminal.executionHostId,
        connected: terminal.connected,
        writable: terminal.writable,
        lastOutputAt: terminal.lastOutputAt,
      }
      if (terminal.hasAgentWait) {
        out.agentWait = terminal.agentWait
      }
      return out
    }

    const agentStatusOf = (params) => {
      const terminal = lookup(params)
      if (terminal === null) {
        return { handle: isObject(params) ? params.terminal : null, isRunningAgent: false, status: null }
      }
      return {
        handle: terminal.handle,
        isRunningAgent: terminal.isRunningAgent,
        status: terminal.agentStatus,
      }
    }

    const readTerminal = (params) => {
      const terminal = lookup(params)
      if (terminal === null) {
        return null
      }
      return {
        handle: terminal.handle,
        status: 'running',
        source: 'screen',
        truncated: false,
        tail: terminal.draft ?? '',
        draft: terminal.draft ?? '',
      }
    }

    const renameTerminal = (params) => {
      const terminal = lookup(params)
      if (terminal === null) {
        // 실제 Orca는 알려지지 않은 terminal 핸들을 거부한다. tabs.list id 같은
        // 잘못된 핸들 사용이 테스트에서 드러나도록 오류로 응답한다.
        const error = new Error('terminal not found')
        error.code = 'not_found'
        throw error
      }
      const raw = isObject(params) ? params.title : undefined
      terminal.customTitle = typeof raw === 'string' && raw.length > 0 ? raw : null
      return { handle: terminal.handle, title: terminal.customTitle }
    }

    /**
     * title-indicator가 쓰는 session.tabs.list. 실제 Orca처럼 terminal 항목의
     * `id`는 `${tabId}::${leafId}` 합성 키이고 terminal 핸들이 아니다.
     */
    const sessionTabsList = (params) => {
      const worktree = isObject(params) && typeof params.worktree === 'string' ? params.worktree : null
      const worktreeId = worktree !== null && worktree.startsWith('id:') ? worktree.slice(3) : null
      const tabs = []
      for (const terminal of terminals.values()) {
        if (worktreeId !== null && terminal.worktreeId !== worktreeId) {
          continue
        }
        tabs.push({
          type: 'terminal',
          id: `${terminal.tabId}::${terminal.leafId}`,
          title: terminal.customTitle ?? terminal.title,
          parentTabId: terminal.tabId,
          leafId: terminal.leafId,
          worktreeId: terminal.worktreeId,
        })
      }
      return { tabs }
    }

    const handleSend = (params) => {
      const requested = isObject(params) && typeof params.terminal === 'string' ? params.terminal : null
      const terminal = requested === null ? null : terminals.get(requested) ?? null
      const hasText = isObject(params) && typeof params.text === 'string' && params.text.length > 0
      const hasEnter = isObject(params) && params.enter === true
      const refused = (refusedReason) => ({
        handle: requested,
        accepted: false,
        bytesWritten: 0,
        ...(refusedReason ? { refusedReason } : {}),
      })

      if (terminal === null) {
        return refused('no-agent')
      }
      if (params.requireAgentStatus === 'sendable') {
        if (hasText && hasEnter) {
          return refused(undefined)
        }
        if (terminal.agentIdentity !== 'claude' || terminal.isRunningAgent !== true) {
          return refused('no-agent')
        }
        if (terminal.agentStatus === 'permission') {
          return refused('permission')
        }
      }

      if (hasEnter && !hasText) {
        submissions.push({ handle: terminal.handle, text: terminal.draft ?? '', at: Date.now() })
        terminal.draft = null
        return { handle: terminal.handle, accepted: true, bytesWritten: 1 }
      }

      if (hasText) {
        const body = unframePaste(params.text)
        terminal.draft = (terminal.draft ?? '') + body
        if (typeof pasteMutator === 'function') {
          pasteMutator(params, terminal)
        }
        return { handle: terminal.handle, accepted: true, bytesWritten: Buffer.byteLength(params.text, 'utf8') }
      }

      return refused(undefined)
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const index = buffer.indexOf(0x0a)
        if (index === -1) break
        const lineText = buffer.subarray(0, index).toString('utf8')
        buffer = buffer.subarray(index + 1)
        onLine(lineText)
      }
    })
    socket.on('error', () => {
      // 클라이언트 destroy 등은 정상 흐름이다.
    })
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(undefined)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })

  /**
   * @param {Partial<FakeTerminal> & {handle:string, worktreeId:string, tabId:string, leafId:string}} input
   * @returns {FakeTerminal}
   */
  function addTerminal(input) {
    const paneKey = `${input.tabId}:${input.leafId}`
    /** @type {FakeTerminal} */
    const terminal = {
      handle: input.handle,
      worktreeId: input.worktreeId,
      tabId: input.tabId,
      leafId: input.leafId,
      paneKey,
      ptyId: input.ptyId ?? `pty-${input.handle}`,
      incarnationId: input.incarnationId ?? `inc-${input.handle}`,
      title: input.title ?? null,
      customTitle: input.customTitle ?? null,
      branch: input.branch ?? null,
      agentIdentity: input.agentIdentity ?? 'claude',
      executionHostId: input.executionHostId ?? 'local',
      connected: input.connected ?? true,
      writable: input.writable ?? true,
      lastOutputAt: input.lastOutputAt ?? 0,
      agentStatus: input.agentStatus ?? 'idle',
      isRunningAgent: input.isRunningAgent ?? true,
      hasAgentWait: input.hasAgentWait ?? true,
      agentWait: input.agentWait ?? null,
      draft: input.draft ?? null,
    }
    terminals.set(terminal.handle, terminal)
    return terminal
  }

  return {
    socketPath,
    runtimeId,
    authToken,
    server,
    terminals,
    frames,
    submissions,
    addTerminal,
    getTerminal: (handle) => terminals.get(handle) ?? null,
    removeTerminal: (handle) => terminals.delete(handle),
    setAgentStatus(handle, status) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.agentStatus = status
    },
    setRunningAgent(handle, running) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.isRunningAgent = running === true
    },
    /**
     * agentWait를 설정한다. undefined면 show에서 키 자체를 생략(미평가)한다.
     * @param {string} handle
     * @param {null|Object|undefined} value
     */
    setAgentWait(handle, value) {
      const terminal = terminals.get(handle)
      if (!terminal) return
      if (value === undefined) {
        terminal.hasAgentWait = false
        terminal.agentWait = null
      } else {
        terminal.hasAgentWait = true
        terminal.agentWait = value
      }
    },
    setDraft(handle, value) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.draft = value === null || value === undefined ? null : String(value)
    },
    getDraft: (handle) => terminals.get(handle)?.draft ?? null,
    setLastOutputAt(handle, ms) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.lastOutputAt = ms
    },
    setWritable(handle, writable) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.writable = writable === true
    },
    setConnected(handle, connected) {
      const terminal = terminals.get(handle)
      if (terminal) terminal.connected = connected === true
    },
    setBrowserTabCreateResult(result) {
      browserTabCreateResult = result
    },
    /**
     * paste 직후 draft를 변조하는 hook(사용자 타이핑 모사).
     * @param {((params:any, terminal:FakeTerminal) => void)|null} fn
     */
    setPasteMutator(fn) {
      pasteMutator = typeof fn === 'function' ? fn : null
    },
    /**
     * 다음 `count`번의 `method` 요청에 fault를 주입한다.
     * @param {string} method
     * @param {{kind:'drop'|'error'|'malformed'|'wrongRuntime', count?:number}} options
     */
    failNext(method, { kind, count = 1 } = { kind: 'error' }) {
      faults.push({ method, kind, remaining: count })
    },
    sendFrames: () => frames.filter((frame) => frame.method === 'terminal.send'),
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      }
      sockets.clear()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      try {
        await fs.rm(socketPath, { force: true })
      } catch {
        // ignore
      }
    },
  }
}

export default startFakeRuntime
