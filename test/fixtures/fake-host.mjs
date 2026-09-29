/**
 * 🔧[OKAP-D1C9] P : 가짜 Orca plugin host fixture.
 *
 * main.mjs가 기대하는 worker API 표면(`orca.commands.register`, `orca.events.on`,
 * `orca.host.call`, `orca.grantedCapabilities`, `orca.log`)만 실제 계약처럼 제공한다.
 * storage/notifications/workspace.readContext는 메모리에서 처리하고 모든 host.call을
 * 기록한다. event/command dispatch helper도 함께 제공한다.
 *
 * 테스트 전용 fixture이며 제품 코드가 아니다.
 *
 * @module fake-host
 */

import { randomUUID } from 'node:crypto'

const ALL_CAPABILITIES = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'events:subscribe',
]

/**
 * 가짜 orca host를 만든다.
 *
 * @param {{grantedCapabilities?: string[]}} [options]
 * @returns {Object}
 */
export function createFakeHost({ grantedCapabilities = ALL_CAPABILITIES } = {}) {
  /** @type {Map<string, unknown>} */
  const storage = new Map()
  /** @type {Array<{title?: string, body?: string}>} */
  const notifications = []
  /** @type {Map<string, Function>} */
  const commands = new Map()
  /** @type {Array<string>} */
  const registeredCommandOrder = []
  /** @type {Map<string, Set<Function>>} */
  const eventHandlers = new Map()
  /** @type {Array<{method: string, params: any}>} */
  const hostCalls = []
  /** @type {string[]} */
  const logs = []
  /** @type {Record<string, unknown>} */
  let workspaceContext = { terminals: [] }

  const orca = {
    commands: {
      register(id, handler) {
        registeredCommandOrder.push(id)
        commands.set(id, handler)
      },
    },
    events: {
      on(name, handler) {
        let set = eventHandlers.get(name)
        if (!set) {
          set = new Set()
          eventHandlers.set(name, set)
        }
        set.add(handler)
      },
    },
    host: {
      async call(method, params = {}) {
        hostCalls.push({ method, params })
        if (method === 'storage.get') {
          const key = params.key
          return { value: storage.has(key) ? structuredClone(storage.get(key)) : undefined }
        }
        if (method === 'storage.set') {
          storage.set(params.key, structuredClone(params.value))
          return { ok: true }
        }
        if (method === 'notifications.show') {
          /** @type {{title?: string, body?: string}} */
          const entry = {}
          if (typeof params.title === 'string') entry.title = params.title
          if (typeof params.body === 'string') entry.body = params.body
          notifications.push(entry)
          return { ok: true }
        }
        if (method === 'workspace.readContext') {
          return structuredClone(workspaceContext)
        }
        throw Object.assign(new Error(`unsupported host method: ${String(method)}`), {
          code: 'unsupported_method',
        })
      },
    },
    grantedCapabilities: [...grantedCapabilities],
    log(message) {
      logs.push(String(message))
    },
  }

  return {
    orca,
    storage,
    notifications,
    commands,
    registeredCommandOrder,
    hostCalls,
    logs,
    /**
     * 등록된 이벤트 handler를 모두 호출한다.
     * @param {string} name
     * @param {unknown} payload
     */
    emit(name, payload) {
      const set = eventHandlers.get(name)
      if (!set) return
      for (const handler of [...set]) {
        try {
          handler(payload)
        } catch (error) {
          logs.push('event handler error: ' + String(error))
        }
      }
    },
    /**
     * 등록된 커맨드 handler를 실행한다.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async runCommand(id) {
      const handler = commands.get(id)
      if (typeof handler !== 'function') {
        throw new Error(`command not registered: ${id}`)
      }
      await handler()
    },
    setWorkspaceContext(context) {
      workspaceContext = context ?? { terminals: [] }
    },
    getNotifications: () => notifications.map((entry) => ({ ...entry })),
    lastNotification: () => (notifications.length > 0 ? { ...notifications[notifications.length - 1] } : null),
    clearNotifications() {
      notifications.length = 0
    },
    countHostCall: (method) => hostCalls.filter((call) => call.method === method).length,
    newClientId: () => 'cache-keepalive:' + randomUUID(),
  }
}

export { ALL_CAPABILITIES }
export default createFakeHost
