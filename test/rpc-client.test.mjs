import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { createRpcClient, RpcError } from '../src/rpc-client.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start a real node:net server on a unix socket in a fresh temp dir.
 * @param {(socket: net.Socket, server: net.Server) => void} onConnection
 */
function startServer(onConnection) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okap-rpc-'))
    const endpoint = path.join(dir, 's.sock')
    const sockets = new Set()
    const server = net.createServer()

    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      onConnection(socket, server)
    })
    server.on('error', reject)
    server.listen(endpoint, () => {
      resolve({
        server,
        endpoint,
        dir,
        sockets,
        close() {
          return new Promise((res) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => {
              try {
                fs.rmSync(dir, { recursive: true, force: true })
              } catch {
                // best effort
              }
              res()
            })
          })
        },
      })
    })
  })
}

/** Read the first newline-terminated frame written by the client. */
function firstFrame(socket) {
  return new Promise((resolve) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      resolve(buffer.slice(0, newlineIndex))
    })
  })
}

function successFrame(id, result, runtimeId) {
  const frame = { id, ok: true, result }
  if (runtimeId !== undefined) frame._meta = { runtimeId }
  return JSON.stringify(frame)
}

function failureFrame(id, error, runtimeId) {
  const frame = { id, ok: false, error }
  if (runtimeId !== undefined) frame._meta = { runtimeId }
  return JSON.stringify(frame)
}

const TOKEN = 'super-secret-runtime-token'

function bindingFor(endpoint, overrides = {}) {
  return { runtimeId: 'rt-1', endpoint, transportKind: 'unix', authToken: TOKEN, ...overrides }
}

// --- success ---------------------------------------------------------------

test('success: writes one request frame and resolves with result', async () => {
  let received = ''
  const server = await startServer((socket) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      const newlineIndex = received.indexOf('\n')
      if (newlineIndex === -1) return
      const request = JSON.parse(received.slice(0, newlineIndex))
      socket.write(successFrame(request.id, { hello: 'world' }, 'rt-1') + '\n')
    })
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    const result = await client.call('terminal.list', { limit: 1, includeVisualLayouts: false })
    assert.deepEqual(result, { hello: 'world' })

    assert.ok(received.endsWith('\n'), 'frame ends with a newline')
    assert.equal(received.split('\n').length, 2, 'exactly one trailing newline')

    const request = JSON.parse(received.trimEnd())
    assert.equal(typeof request.id, 'string')
    assert.ok(request.id.length > 0)
    assert.equal(request.authToken, TOKEN)
    assert.equal(request.method, 'terminal.list')
    assert.deepEqual(request.params, { limit: 1, includeVisualLayouts: false })
    assert.equal('jsonrpc' in request, false)
  } finally {
    client.close()
    await server.close()
  }
})

test('success: omitted _meta is accepted', async () => {
  const server = await startServer(async (socket) => {
    const frame = await firstFrame(socket)
    const request = JSON.parse(frame)
    socket.write(successFrame(request.id, 'ok-no-meta') + '\n')
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    assert.equal(await client.call('x', {}), 'ok-no-meta')
  } finally {
    client.close()
    await server.close()
  }
})

// --- remote failure --------------------------------------------------------

test('server ok:false maps to remote_error and does not leak token/message', async () => {
  const server = await startServer(async (socket) => {
    const frame = await firstFrame(socket)
    const request = JSON.parse(frame)
    socket.write(failureFrame(request.id, { code: 'boom', message: `leaked ${TOKEN}`, data: { detail: 1 } }, 'rt-1') + '\n')
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, 'remote_error')
      assert.equal(error.phase, 'response')
      assert.equal(error.mayHaveWritten, true)
      assert.equal(error.remoteCode, 'boom')
      assert.deepEqual(error.data, { detail: 1 })
      assert.equal(error.message, 'remote error: boom')
      assert.equal(error.message.includes(TOKEN), false)
      assert.equal(String(error.cause ?? '').includes(TOKEN), false)
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

// --- connection lifecycle --------------------------------------------------

test('EOF before response rejects with runtime_unavailable', async () => {
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    socket.destroy()
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'runtime_unavailable')
      assert.equal(error.phase, 'response')
      assert.equal(error.mayHaveWritten, true)
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

test('connect failure rejects with runtime_unavailable and mayHaveWritten false', async () => {
  const missing = path.join(os.tmpdir(), `okap-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
  const client = createRpcClient({ getBinding: () => bindingFor(missing) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'runtime_unavailable')
      assert.equal(error.phase, 'connect')
      assert.equal(error.mayHaveWritten, false)
      return true
    })
  } finally {
    client.close()
  }
})

// --- invalid responses -----------------------------------------------------

test('mismatched id rejects with invalid_response', async () => {
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    socket.write(successFrame('not-the-request-id', 'nope', 'rt-1') + '\n')
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'invalid_response')
      assert.equal(error.phase, 'response')
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

test('mismatched runtimeId rejects with runtime_mismatch', async () => {
  const server = await startServer(async (socket) => {
    const frame = await firstFrame(socket)
    const request = JSON.parse(frame)
    socket.write(successFrame(request.id, 'nope', 'other-runtime') + '\n')
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'runtime_mismatch')
      assert.equal(error.phase, 'response')
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

test('malformed JSON rejects with invalid_response', async () => {
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    socket.write('this is not json\n')
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'invalid_response')
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

// --- framing / utf-8 -------------------------------------------------------

test('byte-split response with a multibyte Korean result decodes correctly', async () => {
  const korean = '한글 결과 ✓ 완료'
  const server = await startServer(async (socket) => {
    const frame = await firstFrame(socket)
    const request = JSON.parse(frame)
    const bytes = Buffer.from(successFrame(request.id, korean, 'rt-1') + '\n', 'utf8')
    for (const byte of bytes) {
      if (socket.destroyed) break
      socket.write(Buffer.from([byte]))
      await delay(1)
    }
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    assert.equal(await client.call('x', {}), korean)
  } finally {
    client.close()
    await server.close()
  }
})

test('one chunk with blank line, keepalive and response resolves', async () => {
  const server = await startServer(async (socket) => {
    const frame = await firstFrame(socket)
    const request = JSON.parse(frame)
    socket.write('\n{"_keepalive":true}\n\n' + successFrame(request.id, 42, 'rt-1') + '\n')
  })
  const client = createRpcClient({
    getBinding: () => bindingFor(server.endpoint),
    limits: { idleTimeoutMs: 200, timeoutMs: 5000 },
  })
  try {
    assert.equal(await client.call('x', {}), 42)
  } finally {
    client.close()
    await server.close()
  }
})

// --- timeouts --------------------------------------------------------------

test('keepalives refresh idle but cannot extend the absolute deadline', async () => {
  let keepaliveTimer
  const server = await startServer((socket) => {
    keepaliveTimer = setInterval(() => {
      if (!socket.destroyed) socket.write('{"_keepalive":true}\n')
    }, 40)
    socket.on('close', () => clearInterval(keepaliveTimer))
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    const startedAt = Date.now()
    await assert.rejects(client.call('x', {}, { timeoutMs: 250, idleTimeoutMs: 1000 }), (error) => {
      assert.equal(error.code, 'runtime_timeout')
      assert.equal(error.phase, 'response')
      return true
    })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 200, `deadline fired around 250ms (elapsed=${elapsed})`)
  } finally {
    clearInterval(keepaliveTimer)
    client.close()
    await server.close()
  }
})

test('idle timeout rejects when the server sends nothing', async () => {
  const server = await startServer(() => {
    // never respond
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    const startedAt = Date.now()
    await assert.rejects(client.call('x', {}, { timeoutMs: 5000, idleTimeoutMs: 150 }), (error) => {
      assert.equal(error.code, 'runtime_timeout')
      return true
    })
    assert.ok(Date.now() - startedAt < 1500)
  } finally {
    client.close()
    await server.close()
  }
})

test('oversized frame destroys the socket with response_too_large', async () => {
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    if (!socket.destroyed) socket.write('x'.repeat(2000))
    await delay(200)
    if (!socket.destroyed) socket.write('\n')
  })
  const client = createRpcClient({
    getBinding: () => bindingFor(server.endpoint),
    limits: { maxFrameBytes: 512, timeoutMs: 5000, idleTimeoutMs: 3000 },
  })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'response_too_large')
      assert.equal(error.phase, 'response')
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

// --- abort -----------------------------------------------------------------

test('already-aborted signal rejects without connecting', async () => {
  let bindingCalls = 0
  let connections = 0
  const server = await startServer(() => {
    connections += 1
  })
  const controller = new AbortController()
  controller.abort()
  const client = createRpcClient({
    getBinding: () => {
      bindingCalls += 1
      return bindingFor(server.endpoint)
    },
  })
  try {
    await assert.rejects(client.call('x', {}, { signal: controller.signal }), (error) => {
      assert.equal(error.code, 'aborted')
      assert.equal(error.mayHaveWritten, false)
      return true
    })
    assert.equal(bindingCalls, 0)
    assert.equal(connections, 0)
  } finally {
    client.close()
    await server.close()
  }
})

test('abort mid-flight destroys the socket and rejects with aborted', async () => {
  let serverClosed
  const closed = new Promise((resolve) => {
    serverClosed = resolve
  })
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    socket.on('close', () => serverClosed())
    // never respond
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  const controller = new AbortController()
  try {
    const pending = client.call('x', {}, { signal: controller.signal, timeoutMs: 5000, idleTimeoutMs: 5000 })
    await delay(60)
    controller.abort()
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'aborted')
      assert.equal(error.phase, 'response')
      assert.equal(error.mayHaveWritten, true)
      return true
    })
    await closed
  } finally {
    client.close()
    await server.close()
  }
})

// --- close -----------------------------------------------------------------

test('close rejects in-flight and subsequent calls with runtime_unavailable', async () => {
  const server = await startServer(async (socket) => {
    await firstFrame(socket)
    // never respond
  })
  const client = createRpcClient({ getBinding: () => bindingFor(server.endpoint) })
  try {
    const pending = client.call('x', {}, { timeoutMs: 5000, idleTimeoutMs: 5000 })
    await delay(50)
    client.close()
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'runtime_unavailable')
      return true
    })
    await assert.rejects(client.call('y', {}), (error) => {
      assert.equal(error.code, 'runtime_unavailable')
      assert.equal(error.mayHaveWritten, false)
      return true
    })
  } finally {
    client.close()
    await server.close()
  }
})

// --- binding ---------------------------------------------------------------

test('invalid binding rejects with invalid_binding', async () => {
  const client = createRpcClient({ getBinding: () => ({ runtimeId: 'rt', endpoint: '', transportKind: 'unix', authToken: TOKEN }) })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'invalid_binding')
      assert.equal(error.phase, 'connect')
      assert.equal(error.mayHaveWritten, false)
      assert.equal(error.message.includes(TOKEN), false)
      return true
    })
  } finally {
    client.close()
  }
})

test('getBinding rejection maps to invalid_binding', async () => {
  const client = createRpcClient({
    getBinding: () => {
      throw new Error('no metadata')
    },
  })
  try {
    await assert.rejects(client.call('x', {}), (error) => {
      assert.equal(error.code, 'invalid_binding')
      assert.equal(error.mayHaveWritten, false)
      return true
    })
  } finally {
    client.close()
  }
})
