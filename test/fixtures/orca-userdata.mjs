/**
 * 🔧[OKAP-D1C9] P : tmp Orca userData fixture(SQLite 권위 저장소 포함).
 *
 * 실제 Orca의 파일 배치를 최소한으로 재현한다.
 *  - `<userData>/orca-runtime.json`: §4.2 wire metadata(transports/authToken/pid).
 *  - `<userData>/orca-profile-index.json`: 활성 프로필 index.
 *  - `<userData>/profiles/<id>/profile-state.db`: schema version 3, meta `profile_id`,
 *    `settings` document(payload + SHA-256 hash + revision).
 *
 * `setTimerSettings`는 write connection을 잠깐 열어 payload/hash/revision을 갱신한다.
 * 제품 모듈은 이 DB를 readOnly로만 읽는다.
 *
 * 테스트 전용 fixture이며 제품 코드가 아니다.
 *
 * @module orca-userdata
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const SCHEMA_VERSION = 3
const DOCUMENT_VERSION = 1

/**
 * payload의 SHA-256(hex)을 계산한다.
 * @param {string} payload
 * @returns {string}
 */
function hashPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * settings payload를 만든다. 제품이 읽는 두 키만 담는다.
 * @param {boolean} enabled
 * @param {number} ttlMs
 * @returns {string}
 */
function buildPayload(enabled, ttlMs) {
  return JSON.stringify({ promptCacheTimerEnabled: enabled === true, promptCacheTtlMs: ttlMs })
}

/**
 * tmp userData 트리를 만들고 metadata/index/SQLite를 기록한다.
 *
 * @param {Object} options
 * @param {string} options.root tmp 루트 디렉터리(호출자가 mkdtemp한 경로).
 * @param {number} options.pid metadata pid이자 plugin worker의 parentPid.
 * @param {string} [options.socketPath] runtime endpoint(unix socket 경로).
 * @param {string} [options.profileId]
 * @param {boolean} [options.enabled] 초기 promptCacheTimerEnabled.
 * @param {number} [options.ttlMs] 초기 promptCacheTtlMs.
 * @returns {Promise<Object>}
 */
export async function createOrcaUserData({
  root,
  pid,
  socketPath,
  profileId = 'profile-1',
  enabled = false,
  ttlMs = 300000,
} = {}) {
  const userDataPath = join(root, 'orca-userdata')
  const homeDir = join(root, 'home')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(homeDir, { recursive: true })

  const endpoint = socketPath ?? join(root, 'orca-runtime.sock')
  const runtimeId = 'rt-' + randomUUID()
  const authToken = randomBytes(24).toString('base64url')
  const startedAt = Date.now()

  await fs.writeFile(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId,
      pid,
      transports: [{ kind: 'unix', endpoint }],
      authToken,
      startedAt,
    }),
    'utf8',
  )

  await fs.writeFile(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId: profileId,
      profiles: [{ id: profileId, name: 'Default' }],
    }),
    'utf8',
  )

  const profileDir = join(userDataPath, 'profiles', profileId)
  await fs.mkdir(profileDir, { recursive: true })
  const dbPath = join(profileDir, 'profile-state.db')

  const payload = buildPayload(enabled, ttlMs)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS profile_state_meta (
        key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_state_documents (
        domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
        domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
      );`,
    )
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.prepare('INSERT OR REPLACE INTO profile_state_meta (key, value) VALUES (?, ?)').run(
      'profile_id',
      profileId,
    )
    db.prepare(
      `INSERT OR REPLACE INTO profile_state_documents
        (domain, payload, domain_version, revision, updated_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('settings', payload, DOCUMENT_VERSION, 1, Date.now(), hashPayload(payload))
  } finally {
    db.close()
  }

  /**
   * DB의 settings payload를 읽는다(검증용).
   * @returns {Promise<{payload:string, revision:number, enabled:boolean, ttlMs:number}|null>}
   */
  async function readPayload() {
    const reader = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = reader
        .prepare(
          'SELECT payload, revision FROM profile_state_documents WHERE domain = ?',
        )
        .get('settings')
      if (!row) return null
      const parsed = JSON.parse(row.payload)
      return {
        payload: row.payload,
        revision: row.revision,
        enabled: parsed.promptCacheTimerEnabled === true,
        ttlMs: parsed.promptCacheTtlMs,
      }
    } finally {
      reader.close()
    }
  }

  /**
   * settings 타이머 값을 갱신한다. revision을 +1하고 hash를 재계산한다.
   * @param {{enabled: boolean, ttlMs: number}} settings
   * @returns {Promise<{revision:number, payload:string}>}
   */
  async function setTimerSettings({ enabled: nextEnabled, ttlMs: nextTtlMs }) {
    const writer = new DatabaseSync(dbPath)
    try {
      const current = writer
        .prepare('SELECT revision FROM profile_state_documents WHERE domain = ?')
        .get('settings')
      const nextRevision = (current?.revision ?? 0) + 1
      const nextPayload = buildPayload(nextEnabled === true, nextTtlMs)
      writer
        .prepare(
          `UPDATE profile_state_documents
           SET payload = ?, revision = ?, updated_at = ?, content_hash = ?
           WHERE domain = ?`,
        )
        .run(nextPayload, nextRevision, Date.now(), hashPayload(nextPayload), 'settings')
      return { revision: nextRevision, payload: nextPayload }
    } finally {
      writer.close()
    }
  }

  /** @type {string} */
  const realPath = await fs.realpath(userDataPath)

  return {
    root,
    userDataPath,
    realPath,
    homeDir,
    socketPath: endpoint,
    runtimeId,
    authToken,
    pid,
    profileId,
    dbPath,
    readPayload,
    setTimerSettings,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

export default createOrcaUserData
