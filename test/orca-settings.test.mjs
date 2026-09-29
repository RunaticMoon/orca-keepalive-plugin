import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { defaultOpenSqlite, readTimerSettings } from '../src/orca-settings.mjs';

const PROFILE_ID = 'local-default';
const OTHER_PROFILE_ID = 'other-profile';
const INDEX_FILE = 'orca-profile-index.json';
const DB_FILE = 'profile-state.db';
const DATA_FILE = 'orca-data.json';

const CREATE_TABLES_SQL = `CREATE TABLE IF NOT EXISTS profile_state_meta (
    key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_state_documents (
    domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
    domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
  );`;

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeUserData() {
  return fs.mkdtemp(join(tmpdir(), 'okap-orca-settings-'));
}

/**
 * index JSON을 쓴다.
 * @param {string} userDataPath
 * @param {string} activeProfileId
 * @param {string[]} [profileIds]
 */
async function writeIndex(userDataPath, activeProfileId, profileIds = [activeProfileId]) {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    join(userDataPath, INDEX_FILE),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId,
      profiles: profileIds.map((id) => ({ id, name: id })),
    }),
  );
}

/**
 * legacy 프로필 JSON을 쓴다.
 * @param {string} userDataPath
 * @param {string} profileId
 * @param {unknown} settings
 */
async function writeProfileJson(userDataPath, profileId, settings) {
  const dir = join(userDataPath, 'profiles', profileId);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, DATA_FILE);
  await fs.writeFile(path, JSON.stringify({ settings, worktrees: [] }));
  return path;
}

/**
 * 원본 스키마(필요 테이블/컬럼만)로 SQLite DB를 만든다.
 * @param {string} databasePath
 * @param {Object} [options]
 */
function createDatabase(databasePath, options = {}) {
  const {
    profileId = PROFILE_ID,
    includeMeta = true,
    metaProfileId = profileId,
    userVersion = 3,
    includeDocument = true,
    payload = '{}',
    domainVersion = 1,
    revision = 1,
    contentHash = null,
  } = options;

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    if (userVersion > 0) {
      db.exec(`PRAGMA user_version = ${userVersion}`);
    }
    db.exec(CREATE_TABLES_SQL);
    if (includeMeta) {
      db.prepare('INSERT OR REPLACE INTO profile_state_meta (key, value) VALUES (?, ?)').run(
        'profile_id',
        metaProfileId,
      );
    }
    if (includeDocument) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      db.prepare(
        'INSERT OR REPLACE INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('settings', text, domainVersion, revision, 1, contentHash ?? sha256(text));
    }
  } finally {
    db.close();
  }
  return databasePath;
}

/**
 * 프로필 디렉터리에 DB를 만든다.
 * @param {string} userDataPath
 * @param {Object} [options]
 */
async function makeDb(userDataPath, options = {}) {
  const profileId = options.profileId ?? PROFILE_ID;
  const dir = join(userDataPath, 'profiles', profileId);
  await fs.mkdir(dir, { recursive: true });
  return createDatabase(join(dir, DB_FILE), { profileId, ...options });
}

// ---------------------------------------------------------------------------
// 정상 sqlite 경로
// ---------------------------------------------------------------------------

test('sqlite: enabled=true / TTL=1h / revision을 반환한다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, {
      payload: { promptCacheTimerEnabled: true, promptCacheTtlMs: 3600000, secret: 'ignore-me' },
      revision: 7,
    });

    const snapshot = await readTimerSettings({ userDataPath: dir, now: () => 12345 });
    assert.deepEqual(snapshot, {
      known: true,
      profileId: PROFILE_ID,
      enabled: true,
      ttlMs: 3600000,
      revision: 7,
      source: 'sqlite',
      readAt: 12345,
    });
    assert.ok(!('secret' in snapshot), 'settings payload의 다른 값은 반환하지 않는다');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sqlite: 키 누락은 enabled=false, TTL=300000 기본값', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { payload: {} });

    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.known, true);
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.ttlMs, 300000);
    assert.equal(snapshot.source, 'sqlite');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sqlite: 저장은 core 필드만 덮어쓰고 DB는 그대로다(mtime/크기 불변)', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    const dbPath = await makeDb(dir, {
      payload: { promptCacheTimerEnabled: true, promptCacheTtlMs: 300000 },
    });
    const before = await fs.stat(dbPath);

    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.known, true);

    const after = await fs.stat(dbPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'main DB mtime이 변하면 안 된다');
    assert.equal(after.size, before.size, 'main DB 크기가 변하면 안 된다');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WAL 모드에서 다른 커넥션이 업데이트한 값을 다음 호출에서 읽는다', async () => {
  const dir = await makeUserData();
  /** @type {DatabaseSync|null} */
  let writer = null;
  try {
    await writeIndex(dir, PROFILE_ID);
    const dbDir = join(dir, 'profiles', PROFILE_ID);
    await fs.mkdir(dbDir, { recursive: true });
    const dbPath = join(dbDir, DB_FILE);

    writer = new DatabaseSync(dbPath);
    assert.equal(writer.exec('PRAGMA journal_mode = WAL'), undefined);
    writer.exec('PRAGMA user_version = 3');
    writer.exec(CREATE_TABLES_SQL);
    writer.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run('profile_id', PROFILE_ID);

    let revision = 0;
    const upsert = (settings) => {
      revision += 1;
      const text = JSON.stringify(settings);
      writer
        .prepare(
          'INSERT OR REPLACE INTO profile_state_documents (domain, payload, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('settings', text, 1, revision, Date.now(), sha256(text));
    };

    upsert({ promptCacheTimerEnabled: false, promptCacheTtlMs: 300000 });
    const first = await readTimerSettings({ userDataPath: dir });
    assert.equal(first.known, true);
    assert.equal(first.enabled, false);

    upsert({ promptCacheTimerEnabled: true, promptCacheTtlMs: 3600000 });
    const second = await readTimerSettings({ userDataPath: dir });
    assert.equal(second.known, true);
    assert.equal(second.enabled, true);
    assert.equal(second.ttlMs, 3600000);
    assert.equal(second.revision, 2);
  } finally {
    writer?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JSON 경로
// ---------------------------------------------------------------------------

test('DB가 없으면 profiles/<id>/orca-data.json의 .settings를 읽는다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await writeProfileJson(dir, PROFILE_ID, {
      promptCacheTimerEnabled: true,
      promptCacheTtlMs: 3600000,
    });

    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.deepEqual(snapshot, {
      known: true,
      profileId: PROFILE_ID,
      enabled: true,
      ttlMs: 3600000,
      revision: null,
      source: 'json',
      readAt: snapshot.readAt,
    });
    assert.equal(typeof snapshot.readAt, 'number');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json: 루트 legacy orca-data.json은 채택하지 않는다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    // 루트 legacy 파일만 있고 프로필 JSON은 없다.
    await fs.writeFile(
      join(dir, DATA_FILE),
      JSON.stringify({ settings: { promptCacheTimerEnabled: true } }),
    );

    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.known, false);
    assert.equal(snapshot.reason, 'json_missing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DB와 JSON이 모두 있으면 DB가 우선한다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await writeProfileJson(dir, PROFILE_ID, {
      promptCacheTimerEnabled: true,
      promptCacheTtlMs: 3600000,
    });
    await makeDb(dir, { payload: { promptCacheTimerEnabled: false, promptCacheTtlMs: 300000 } });

    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.known, true);
    assert.equal(snapshot.source, 'sqlite');
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.ttlMs, 300000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('main DB가 없어도 -wal/-shm/-journal이 남아 있으면 db_error(JSON 미사용)', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    // JSON이 있으므로 fallback했다면 성공했을 것이다.
    await writeProfileJson(dir, PROFILE_ID, { promptCacheTimerEnabled: true });

    for (const suffix of ['-wal', '-shm', '-journal']) {
      const profileDir = join(dir, 'profiles', PROFILE_ID);
      await fs.mkdir(profileDir, { recursive: true });
      const familyPath = join(profileDir, `${DB_FILE}${suffix}`);
      await fs.writeFile(familyPath, '');
      try {
        const snapshot = await readTimerSettings({ userDataPath: dir });
        assert.equal(snapshot.known, false, `${suffix}: JSON으로 fallback하면 안 된다`);
        assert.equal(snapshot.reason, 'db_error', `${suffix}: db_error로 접어야 한다`);
      } finally {
        await fs.rm(familyPath, { force: true });
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// index 검증
// ---------------------------------------------------------------------------

test('index가 없으면 index_missing', async () => {
  const dir = await makeUserData();
  try {
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.deepEqual(snapshot, { known: false, reason: 'index_missing', readAt: snapshot.readAt });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index JSON이 손상되면 index_invalid', async () => {
  const dir = await makeUserData();
  try {
    await fs.writeFile(join(dir, INDEX_FILE), '{ not json');
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'index_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index가 배열이거나 profiles가 없으면 index_invalid', async () => {
  const dir = await makeUserData();
  try {
    await fs.writeFile(join(dir, INDEX_FILE), '[]');
    assert.equal((await readTimerSettings({ userDataPath: dir })).reason, 'index_invalid');

    await fs.writeFile(join(dir, INDEX_FILE), JSON.stringify({ activeProfileId: PROFILE_ID }));
    assert.equal((await readTimerSettings({ userDataPath: dir })).reason, 'index_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activeProfileId가 profiles에 없으면 profile_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, OTHER_PROFILE_ID, [PROFILE_ID]);
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'profile_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activeProfileId 형식이 틀리면 profile_invalid', async () => {
  const dir = await makeUserData();
  try {
    for (const badId of ['-leading', 'has space', 'a'.repeat(129)]) {
      await writeIndex(dir, badId, [badId]);
      const snapshot = await readTimerSettings({ userDataPath: dir });
      assert.equal(snapshot.reason, 'profile_invalid', `bad id: ${badId}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index가 1 MiB를 넘으면 index_invalid', async () => {
  const userDataPath = '/okap-fake-index-large';
  const indexPath = join(userDataPath, INDEX_FILE);
  const readFile = async (path) => {
    if (path === indexPath) {
      return 'x'.repeat(1024 * 1024 + 1);
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const snapshot = await readTimerSettings({ userDataPath, readFile });
  assert.equal(snapshot.reason, 'index_invalid');
});

// ---------------------------------------------------------------------------
// SQLite 스키마 검증
// ---------------------------------------------------------------------------

test('user_version이 3이 아니면 schema_unsupported', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { userVersion: 2, payload: { promptCacheTimerEnabled: true } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'schema_unsupported');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('meta profile_id가 활성 프로필과 다르면 profile_mismatch', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { metaProfileId: OTHER_PROFILE_ID, payload: { promptCacheTimerEnabled: true } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'profile_mismatch');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('meta profile_id가 없으면 profile_mismatch', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { includeMeta: false, payload: { promptCacheTimerEnabled: true } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'profile_mismatch');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('settings 행이 없으면 document_missing', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { includeDocument: false });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'document_missing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('domain_version이 1이 아니면 schema_unsupported', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { domainVersion: 2, payload: { promptCacheTimerEnabled: true } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'schema_unsupported');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('revision이 양의 안전정수가 아니면 db_error', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { revision: 0, payload: { promptCacheTimerEnabled: true } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'db_error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('content_hash가 payload와 다르면 hash_mismatch', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, {
      payload: { promptCacheTimerEnabled: true },
      contentHash: '0'.repeat(64),
    });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'hash_mismatch');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('payload JSON이 손상되면 payload_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { payload: '{ invalid json' });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'payload_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('payload가 배열이면 payload_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { payload: [1, 2, 3] });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'payload_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TTL이 12345 같은 허용 외 값이면 payload_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { payload: { promptCacheTtlMs: 12345 } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'payload_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('enabled가 boolean이 아니면 payload_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await makeDb(dir, { payload: { promptCacheTimerEnabled: 'yes' } });
    const snapshot = await readTimerSettings({ userDataPath: dir });
    assert.equal(snapshot.reason, 'payload_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json: TTL/enabled 타입 오류는 payload_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    await writeProfileJson(dir, PROFILE_ID, { promptCacheTtlMs: 12345 });
    assert.equal((await readTimerSettings({ userDataPath: dir })).reason, 'payload_invalid');

    await writeProfileJson(dir, PROFILE_ID, { promptCacheTimerEnabled: 'yes' });
    assert.equal((await readTimerSettings({ userDataPath: dir })).reason, 'payload_invalid');

    await writeProfileJson(dir, PROFILE_ID, [1, 2]);
    assert.equal((await readTimerSettings({ userDataPath: dir })).reason, 'payload_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// openSqlite / close
// ---------------------------------------------------------------------------

test('openSqlite 주입이 던지면 sqlite_unavailable/db_error로 접는다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    const dbDir = join(dir, 'profiles', PROFILE_ID);
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(join(dbDir, DB_FILE), '');

    const unavailable = await readTimerSettings({
      userDataPath: dir,
      openSqlite: async () => {
        throw Object.assign(new Error('node:sqlite missing'), { code: 'sqlite_unavailable' });
      },
    });
    assert.equal(unavailable.known, false);
    assert.equal(unavailable.reason, 'sqlite_unavailable');

    const dbError = await readTimerSettings({
      userDataPath: dir,
      openSqlite: async () => {
        throw new Error('open failed');
      },
    });
    assert.equal(dbError.known, false);
    assert.equal(dbError.reason, 'db_error');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('열린 DB close는 성공/실패 경로 모두에서 호출된다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    const dbDir = join(dir, 'profiles', PROFILE_ID);
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(join(dbDir, DB_FILE), '');

    let closeCount = 0;
    const successDb = {
      prepare(sql) {
        if (sql.includes('PRAGMA user_version')) {
          return { get: () => ({ user_version: 3 }) };
        }
        if (sql.includes('profile_state_meta')) {
          return { get: () => ({ value: PROFILE_ID }) };
        }
        if (sql.includes('profile_state_documents')) {
          return {
            get: () => ({
              domain: 'settings',
              payload: '{"promptCacheTimerEnabled":true}',
              domain_version: 1,
              revision: 3,
              updated_at: 1,
              content_hash: sha256('{"promptCacheTimerEnabled":true}'),
            }),
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      exec() {},
      close() {
        closeCount += 1;
      },
    };

    const ok = await readTimerSettings({ userDataPath: dir, openSqlite: async () => successDb });
    assert.equal(ok.known, true);
    assert.equal(ok.enabled, true);
    assert.equal(closeCount, 1);

    const errorDb = {
      prepare() {
        throw new Error('boom');
      },
      exec() {},
      close() {
        closeCount += 1;
      },
    };
    const bad = await readTimerSettings({ userDataPath: dir, openSqlite: async () => errorDb });
    assert.equal(bad.known, false);
    assert.equal(bad.reason, 'db_error');
    assert.equal(closeCount, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readFile 주입으로 읽는 사이 profile 전환을 재현하면 profile_changed', async () => {
  const userDataPath = '/okap-fake-profile-changed';
  const indexPath = join(userDataPath, INDEX_FILE);
  const dataPath = join(userDataPath, 'profiles', PROFILE_ID, DATA_FILE);

  const indexBefore = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: PROFILE_ID,
    profiles: [{ id: PROFILE_ID }],
  });
  const indexAfter = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: OTHER_PROFILE_ID,
    profiles: [{ id: PROFILE_ID }, { id: OTHER_PROFILE_ID }],
  });

  let indexReads = 0;
  const readFile = async (path) => {
    if (path === indexPath) {
      indexReads += 1;
      return indexReads === 1 ? indexBefore : indexAfter;
    }
    if (path === dataPath) {
      return JSON.stringify({ settings: { promptCacheTimerEnabled: true } });
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const snapshot = await readTimerSettings({ userDataPath, readFile });
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'profile_changed');
  assert.equal(indexReads, 2);
});

test('index 재읽기가 실패하면 profile_changed로 폐기한다', async () => {
  const userDataPath = '/okap-fake-index-reread-fail';
  const indexPath = join(userDataPath, INDEX_FILE);
  const dataPath = join(userDataPath, 'profiles', PROFILE_ID, DATA_FILE);
  const validIndex = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: PROFILE_ID,
    profiles: [{ id: PROFILE_ID }],
  });

  let indexReads = 0;
  const readFile = async (path) => {
    if (path === indexPath) {
      indexReads += 1;
      if (indexReads === 1) {
        return validIndex;
      }
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }
    if (path === dataPath) {
      return JSON.stringify({ settings: { promptCacheTimerEnabled: true } });
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const snapshot = await readTimerSettings({ userDataPath, readFile });
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'profile_changed');
});

// ---------------------------------------------------------------------------
// defaultOpenSqlite
// ---------------------------------------------------------------------------

test('defaultOpenSqlite는 읽기 전용 연결을 연다', async () => {
  const dir = await makeUserData();
  try {
    const dbPath = join(dir, 'sample.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE t (a INTEGER)');
    seed.prepare('INSERT INTO t (a) VALUES (1)').run();
    seed.exec('PRAGMA user_version = 3');
    seed.close();

    const db = await defaultOpenSqlite(dbPath);
    try {
      const row = db.prepare('PRAGMA user_version').get();
      assert.equal(Number(Object.values(row)[0]), 3);
      assert.throws(() => db.exec('INSERT INTO t (a) VALUES (2)'), /readonly|read-only/i);
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readTimerSettings는 어떤 예외도 던지지 않는다', async () => {
  const snapshot = await readTimerSettings({
    userDataPath: '/okap-fake-throw',
    readFile: async () => {
      throw new Error('unexpected');
    },
  });
  assert.equal(snapshot.known, false);
  assert.equal(typeof snapshot.reason, 'string');
  assert.equal(typeof snapshot.readAt, 'number');
});
