import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readActiveProfile } from '../src/orca-settings.mjs';

const PROFILE_ID = 'local-default';
const OTHER_PROFILE_ID = 'other-profile';
const INDEX_FILE = 'orca-profile-index.json';
const DB_FILE = 'profile-state.db';
const DATA_FILE = 'orca-data.json';

// Orca 타이머 키. 모듈이 이 키를 전혀 보지 않음을 검증하기 위해 동적으로 만든다.
const ENABLED_KEY = ['promptCache', 'TimerEnabled'].join('');
const TTL_KEY = ['promptCache', 'TtlMs'].join('');

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

// ---------------------------------------------------------------------------
// 정상 index 경로
// ---------------------------------------------------------------------------

test('index 정상이면 known=true, profileId, source=index를 반환한다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);

    const snapshot = await readActiveProfile({ userDataPath: dir, now: () => 12345 });
    assert.deepEqual(snapshot, {
      known: true,
      profileId: PROFILE_ID,
      source: 'index',
      readAt: 12345,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('결과에 enabled/ttlMs 같은 타이머 필드가 없다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    const snapshot = await readActiveProfile({ userDataPath: dir });
    assert.equal(snapshot.known, true);
    assert.ok(!('enabled' in snapshot), 'enabled 필드가 없어야 한다');
    assert.ok(!('ttlMs' in snapshot), 'ttlMs 필드가 없어야 한다');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 타이머 저장소(DB/JSON)를 무시한다
// ---------------------------------------------------------------------------

test('DB 손상·WAL·orca-data.json 타이머 누락/불량/false여도 index 결과는 그대로다', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, PROFILE_ID);
    const profileDir = join(dir, 'profiles', PROFILE_ID);
    await fs.mkdir(profileDir, { recursive: true });

    // 손상된 DB + WAL/SHM/journal 형제 파일.
    await fs.writeFile(join(profileDir, DB_FILE), 'not a sqlite database');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await fs.writeFile(join(profileDir, `${DB_FILE}${suffix}`), '');
    }
    // 타이머 필드가 누락된 JSON.
    await fs.writeFile(join(profileDir, DATA_FILE), JSON.stringify({ settings: {}, worktrees: [] }));

    const snapshot = await readActiveProfile({ userDataPath: dir });
    assert.deepEqual(snapshot, {
      known: true,
      profileId: PROFILE_ID,
      source: 'index',
      readAt: snapshot.readAt,
    });

    // 타이머 필드가 불량/ false여도 결과가 변하지 않는다.
    await fs.writeFile(
      join(profileDir, DATA_FILE),
      JSON.stringify({ settings: { [ENABLED_KEY]: 'yes', [TTL_KEY]: 12345 } }),
    );
    assert.equal((await readActiveProfile({ userDataPath: dir })).known, true);

    await fs.writeFile(
      join(profileDir, DATA_FILE),
      JSON.stringify({ settings: { [ENABLED_KEY]: false, [TTL_KEY]: 300000 } }),
    );
    const off = await readActiveProfile({ userDataPath: dir });
    assert.equal(off.known, true);
    assert.equal(off.profileId, PROFILE_ID);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index 외 DB/JSON 파일은 readFile로 읽지 않는다', async () => {
  const userDataPath = '/okap-fake-index-only';
  const indexPath = join(userDataPath, INDEX_FILE);
  const dbPath = join(userDataPath, 'profiles', PROFILE_ID, DB_FILE);
  const dataPath = join(userDataPath, 'profiles', PROFILE_ID, DATA_FILE);
  const validIndex = JSON.stringify({
    schemaVersion: 1,
    activeProfileId: PROFILE_ID,
    profiles: [{ id: PROFILE_ID }],
  });

  const requested = [];
  const readFile = async (path) => {
    requested.push(path);
    if (path === indexPath) {
      return validIndex;
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const snapshot = await readActiveProfile({ userDataPath, readFile });
  assert.equal(snapshot.known, true);
  assert.ok(!requested.includes(dbPath), 'DB를 읽으면 안 된다');
  assert.ok(!requested.includes(dataPath), 'orca-data.json을 읽으면 안 된다');
  assert.deepEqual(requested, [indexPath, indexPath], 'index만 두 번 읽는다');
});

// ---------------------------------------------------------------------------
// index 검증
// ---------------------------------------------------------------------------

test('index가 없으면 index_missing', async () => {
  const dir = await makeUserData();
  try {
    const snapshot = await readActiveProfile({ userDataPath: dir });
    assert.deepEqual(snapshot, { known: false, reason: 'index_missing', readAt: snapshot.readAt });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index JSON이 손상되면 index_invalid', async () => {
  const dir = await makeUserData();
  try {
    await fs.writeFile(join(dir, INDEX_FILE), '{ not json');
    const snapshot = await readActiveProfile({ userDataPath: dir });
    assert.equal(snapshot.reason, 'index_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index가 배열이거나 profiles가 없으면 index_invalid', async () => {
  const dir = await makeUserData();
  try {
    await fs.writeFile(join(dir, INDEX_FILE), '[]');
    assert.equal((await readActiveProfile({ userDataPath: dir })).reason, 'index_invalid');

    await fs.writeFile(join(dir, INDEX_FILE), JSON.stringify({ activeProfileId: PROFILE_ID }));
    assert.equal((await readActiveProfile({ userDataPath: dir })).reason, 'index_invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('activeProfileId가 profiles에 없으면 profile_invalid', async () => {
  const dir = await makeUserData();
  try {
    await writeIndex(dir, OTHER_PROFILE_ID, [PROFILE_ID]);
    const snapshot = await readActiveProfile({ userDataPath: dir });
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
      const snapshot = await readActiveProfile({ userDataPath: dir });
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
  const snapshot = await readActiveProfile({ userDataPath, readFile });
  assert.equal(snapshot.reason, 'index_invalid');
});

// ---------------------------------------------------------------------------
// 읽기 중 전환
// ---------------------------------------------------------------------------

test('readFile 주입으로 읽는 사이 profile 전환을 재현하면 profile_changed', async () => {
  const userDataPath = '/okap-fake-profile-changed';
  const indexPath = join(userDataPath, INDEX_FILE);

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
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const snapshot = await readActiveProfile({ userDataPath, readFile });
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'profile_changed');
  assert.equal(indexReads, 2);
});

test('index 재읽기가 실패하면 profile_changed로 폐기한다', async () => {
  const userDataPath = '/okap-fake-index-reread-fail';
  const indexPath = join(userDataPath, INDEX_FILE);
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
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const snapshot = await readActiveProfile({ userDataPath, readFile });
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.reason, 'profile_changed');
});

// ---------------------------------------------------------------------------
// fail-closed
// ---------------------------------------------------------------------------

test('readActiveProfile는 어떤 예외도 던지지 않는다', async () => {
  const snapshot = await readActiveProfile({
    userDataPath: '/okap-fake-throw',
    readFile: async () => {
      throw new Error('unexpected');
    },
  });
  assert.equal(snapshot.known, false);
  assert.equal(typeof snapshot.reason, 'string');
  assert.equal(typeof snapshot.readAt, 'number');
});
