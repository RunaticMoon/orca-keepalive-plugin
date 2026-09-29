/**
 * @file Line-delimited JSON transport client for the Orca local runtime.
 *
 * One request = one connection. The client writes a single newline-terminated
 * JSON frame (`{id, authToken, method, params}`; not JSON-RPC 2.0) and reads
 * newline-delimited response frames until one terminal success/failure frame
 * arrives. Intermediate frames carrying a `_keepalive` key only refresh the
 * idle timer; they never extend the absolute deadline.
 *
 * There is no retry and no fallback transport. Errors are always typed
 * `RpcError` and never contain the `authToken`.
 */

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'

/**
 * @typedef {'runtime_unavailable' | 'runtime_timeout' | 'invalid_response' | 'runtime_mismatch' | 'response_too_large' | 'aborted' | 'remote_error' | 'invalid_binding'} RpcErrorCode
 */

/**
 * @typedef {object} Binding
 * @property {string} runtimeId
 * @property {string} endpoint
 * @property {'unix' | 'named-pipe'} transportKind
 * @property {string} authToken
 */

/**
 * @typedef {object} RpcLimits
 * @property {number} [timeoutMs] Absolute per-call deadline in milliseconds.
 * @property {number} [idleTimeoutMs] Per-call inactivity limit in milliseconds.
 * @property {number} [maxFrameBytes] Maximum size of one accumulated frame.
 */

const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  idleTimeoutMs: 5_000,
  maxFrameBytes: 4 * 1024 * 1024,
})

const NEWLINE = 0x0a

/**
 * Typed transport error. `message` never includes the runtime `authToken`.
 */
export class RpcError extends Error {
  /**
   * @param {RpcErrorCode} code
   * @param {string} message
   * @param {{ phase?: 'connect' | 'write' | 'response', mayHaveWritten?: boolean, remoteCode?: string, data?: unknown, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RpcError'
    /** @type {RpcErrorCode} */
    this.code = code
    /** @type {'connect' | 'write' | 'response'} */
    this.phase = options.phase ?? 'response'
    this.mayHaveWritten = options.mayHaveWritten === true
    if (options.remoteCode !== undefined) this.remoteCode = options.remoteCode
    if (options.data !== undefined) this.data = options.data
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Validate a resolved binding without ever echoing secret material.
 * @param {unknown} binding
 * @returns {asserts binding is Binding}
 */
function assertBinding(binding) {
  if (binding === null || typeof binding !== 'object') {
    throw new RpcError('invalid_binding', 'Runtime binding is missing or invalid.', { phase: 'connect' })
  }
  const { endpoint, authToken, runtimeId, transportKind } = /** @type {Record<string, unknown>} */ (binding)
  const valid =
    typeof endpoint === 'string' &&
    endpoint.length > 0 &&
    typeof authToken === 'string' &&
    authToken.length > 0 &&
    typeof runtimeId === 'string' &&
    runtimeId.length > 0 &&
    (transportKind === 'unix' || transportKind === 'named-pipe')
  if (!valid) {
    throw new RpcError('invalid_binding', 'Runtime binding is missing required fields.', { phase: 'connect' })
  }
}

/**
 * Create a runtime RPC client.
 *
 * @param {object} options
 * @param {() => Binding | Promise<Binding>} options.getBinding Resolves the current binding before every call.
 * @param {(endpoint: string) => import('node:net').Socket} [options.connect] Injectable socket factory.
 * @param {RpcLimits} [options.limits]
 * @returns {{ call: (method: string, params: unknown, options?: { signal?: AbortSignal, timeoutMs?: number, idleTimeoutMs?: number }) => Promise<unknown>, close: () => void }}
 */
export function createRpcClient({ getBinding, connect = createConnection, limits = {} } = {}) {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
  const idleTimeoutMs = limits.idleTimeoutMs ?? DEFAULT_LIMITS.idleTimeoutMs
  const maxFrameBytes = limits.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes

  /** @type {Set<import('node:net').Socket>} */
  const activeSockets = new Set()
  let closed = false

  /**
   * Send one request and resolve with its `result`.
   *
   * @param {string} method
   * @param {unknown} params
   * @param {{ signal?: AbortSignal, timeoutMs?: number, idleTimeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  async function call(method, params, options = {}) {
    const signal = options.signal
    const requestTimeoutMs = options.timeoutMs ?? timeoutMs
    const requestIdleTimeoutMs = options.idleTimeoutMs ?? idleTimeoutMs

    if (closed) {
      throw new RpcError('runtime_unavailable', 'RPC client has been closed.', { phase: 'connect' })
    }
    if (signal?.aborted) {
      throw new RpcError('aborted', 'RPC request was aborted before connecting.', { phase: 'connect' })
    }
    if (typeof getBinding !== 'function') {
      throw new RpcError('invalid_binding', 'Runtime binding provider is not configured.', { phase: 'connect' })
    }

    let binding
    try {
      binding = await getBinding()
    } catch (cause) {
      throw new RpcError('invalid_binding', 'Could not resolve a runtime binding.', { phase: 'connect', cause })
    }

    if (closed) {
      throw new RpcError('runtime_unavailable', 'RPC client has been closed.', { phase: 'connect' })
    }
    if (signal?.aborted) {
      throw new RpcError('aborted', 'RPC request was aborted before connecting.', { phase: 'connect' })
    }
    assertBinding(binding)

    return await new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const decoder = new TextDecoder('utf-8')

      /** @type {import('node:net').Socket | undefined} */
      let socket
      let written = false
      let settled = false
      let lineText = ''
      let lineBytes = 0
      /** @type {ReturnType<typeof setTimeout> | null} */
      let idleTimer = null
      /** @type {ReturnType<typeof setTimeout> | null} */
      let deadlineTimer = null

      const onAbort = () => {
        settleReject('aborted', 'RPC request was aborted.', { phase: written ? 'response' : 'connect' })
      }

      const removeAbortListener = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
      }

      const cleanup = () => {
        if (idleTimer !== null) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        removeAbortListener()
        if (socket) activeSockets.delete(socket)
      }

      /**
       * @param {RpcErrorCode} code
       * @param {string} message
       * @param {{ phase?: 'connect' | 'write' | 'response', remoteCode?: string, data?: unknown, cause?: unknown }} [extra]
       */
      const settleReject = (code, message, extra = {}) => {
        if (settled) return
        settled = true
        cleanup()
        if (socket) socket.destroy()
        reject(
          new RpcError(code, message, {
            phase: extra.phase ?? (written ? 'response' : 'connect'),
            mayHaveWritten: written,
            remoteCode: extra.remoteCode,
            data: extra.data,
            cause: extra.cause,
          }),
        )
      }

      const settleResolve = (value) => {
        if (settled) return
        settled = true
        cleanup()
        if (socket) socket.end()
        resolve(value)
      }

      const armIdleTimer = () => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          settleReject('runtime_timeout', 'Timed out waiting for runtime activity.', {
            phase: written ? 'response' : 'connect',
          })
        }, requestIdleTimeoutMs)
      }

      /**
       * Accumulate one line segment (no newline) and enforce the frame limit.
       * @param {Buffer} segment
       * @returns {boolean} false when the stream must stop.
       */
      const appendPartial = (segment) => {
        lineBytes += segment.length
        if (lineBytes > maxFrameBytes) {
          settleReject('response_too_large', 'The runtime response frame exceeded the size limit.')
          return false
        }
        lineText += decoder.decode(segment, { stream: true })
        return true
      }

      /**
       * Handle one complete line. Returns false to stop reading.
       * @param {string} line
       * @returns {boolean}
       */
      const handleLine = (line) => {
        if (line.trim().length === 0) return true

        let raw
        try {
          raw = JSON.parse(line)
        } catch {
          settleReject('invalid_response', 'The runtime returned a frame that is not valid JSON.')
          return false
        }

        if (raw !== null && typeof raw === 'object' && '_keepalive' in raw) {
          armIdleTimer()
          return true
        }

        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          settleReject('invalid_response', 'The runtime returned an invalid response frame.')
          return false
        }

        if (raw.id !== requestId) {
          settleReject('invalid_response', 'The runtime returned a response with a mismatched id.')
          return false
        }

        if (raw.ok === true) {
          const meta = raw._meta
          const metaRuntimeId = meta !== null && typeof meta === 'object' ? meta.runtimeId : undefined
          if (typeof metaRuntimeId === 'string' && metaRuntimeId !== binding.runtimeId) {
            settleReject('runtime_mismatch', 'The runtime changed while the request was in flight.')
            return false
          }
          settleResolve(raw.result)
          return false
        }

        if (raw.ok === false) {
          const remote = raw.error !== null && typeof raw.error === 'object' ? raw.error : {}
          const remoteCode = typeof remote.code === 'string' ? remote.code : 'unknown'
          settleReject('remote_error', `remote error: ${remoteCode}`, {
            phase: 'response',
            remoteCode,
            data: remote.data,
          })
          return false
        }

        settleReject('invalid_response', 'The runtime returned an invalid response frame.')
        return false
      }

      /**
       * Split one chunk into lines, tolerating partial lines across chunks.
       * @param {Buffer} chunk
       */
      const parseFrames = (chunk) => {
        let cursor = 0
        while (cursor <= chunk.length) {
          const newlineIndex = chunk.indexOf(NEWLINE, cursor)
          if (newlineIndex === -1) {
            appendPartial(chunk.subarray(cursor))
            return
          }
          if (!appendPartial(chunk.subarray(cursor, newlineIndex))) return
          const line = lineText
          lineText = ''
          lineBytes = 0
          if (!handleLine(line)) return
          cursor = newlineIndex + 1
        }
      }

      try {
        socket = connect(binding.endpoint)
      } catch (cause) {
        settled = true
        removeAbortListener()
        reject(
          new RpcError('runtime_unavailable', 'Could not create a connection to the Orca runtime.', {
            phase: 'connect',
            mayHaveWritten: false,
            cause,
          }),
        )
        return
      }

      activeSockets.add(socket)

      deadlineTimer = setTimeout(() => {
        settleReject('runtime_timeout', 'Timed out waiting for the Orca runtime to respond.', {
          phase: written ? 'response' : 'connect',
        })
      }, requestTimeoutMs)

      armIdleTimer()

      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      socket.once('connect', () => {
        if (settled) return
        const frame = JSON.stringify({ id: requestId, authToken: binding.authToken, method, params }) + '\n'
        written = true
        try {
          socket.write(frame, (error) => {
            if (error) {
              settleReject('runtime_unavailable', 'Could not write the request to the Orca runtime.', { phase: 'write' })
            }
          })
        } catch (cause) {
          settleReject('runtime_unavailable', 'Could not write the request to the Orca runtime.', {
            phase: 'write',
            cause,
          })
        }
      })

      socket.on('data', (chunk) => {
        if (settled) return
        parseFrames(chunk)
      })

      socket.once('error', (cause) => {
        settleReject('runtime_unavailable', 'Could not communicate with the running Orca app.', { cause })
      })

      socket.once('close', () => {
        settleReject('runtime_unavailable', 'The Orca runtime closed the connection before responding.')
      })
    })
  }

  function close() {
    closed = true
    for (const socket of activeSockets) {
      try {
        socket.destroy()
      } catch {
        // best effort cleanup
      }
    }
    activeSockets.clear()
  }

  return { call, close }
}
