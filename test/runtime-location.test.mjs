import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocationError,
  candidateUserDataPaths,
  readRuntimeBinding,
  resolveBinding,
  sameBinding,
} from '../src/runtime-location.mjs';

const METADATA_FILE = 'orca-runtime.json';
const MAX_METADATA_BYTES = 1024 * 1024;

/** @returns {Record<string, unknown>} */
function validMetadata(overrides = {}) {
  return {
    runtimeId: 'rt-1',
    pid: 4242,
    transports: [{ kind: 'unix', endpoint: '/tmp/orca.sock' }],
    authToken: 'secret-token',
    startedAt: 1727000000000,
    ...overrides,
  };
}

/**
 * userDataPath -> 반환값(JSON 문자열) 또는 던질 Error. 그 외 경로는 ENOENT.
 * @param {Record<string, unknown>} byDir
 */
function readerByDir(byDir) {
  return async (/** @type {string} */ metadataPath) => {
    for (const [dir, value] of Object.entries(byDir)) {
      if (metadataPath === join(dir, METADATA_FILE)) {
        if (value instanceof Error) {
          throw value;
        }
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    throw enoentError();
  };
}

/** @returns {Error & {code:string}} */
function enoentError() {
  return /** @type {any} */ (Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

const passThroughRealpath = async (/** @type {string} */ p) => p;

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function assertLocationError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LocationError, `expected LocationError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// candidateUserDataPaths
// ---------------------------------------------------------------------------

test('linux 기본 후보는 ~/.config/orca', () => {
  assert.deepEqual(candidateUserDataPaths({ platform: 'linux', home: '/home/u', env: {} }), [
    '/home/u/.config/orca',
  ]);
});

test('linux은 XDG_CONFIG_HOME을 쓴다', () => {
  assert.deepEqual(
    candidateUserDataPaths({ platform: 'linux', home: '/home/u', env: { XDG_CONFIG_HOME: '/xdg' } }),
    ['/xdg/orca'],
  );
});

test('linux에서 ORCA_USER_DATA_PATH가 맨 앞에 추가된다', () => {
  assert.deepEqual(
    candidateUserDataPaths({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/custom', XDG_CONFIG_HOME: '/xdg' },
    }),
    ['/custom', '/xdg/orca'],
  );
});

test('후보 중복은 제거된다', () => {
  assert.deepEqual(
    candidateUserDataPaths({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/home/u/.config/orca' },
    }),
    ['/home/u/.config/orca'],
  );
});

test('빈 env(scrub)에서도 linux 후보가 나온다', () => {
  assert.deepEqual(candidateUserDataPaths({ platform: 'linux', home: '/home/u', env: {} }), [
    '/home/u/.config/orca',
  ]);
});

test('darwin 후보는 Application Support/orca', () => {
  assert.deepEqual(candidateUserDataPaths({ platform: 'darwin', home: '/Users/u', env: {} }), [
    '/Users/u/Library/Application Support/orca',
  ]);
});

test('darwin에서도 ORCA_USER_DATA_PATH가 앞에 온다', () => {
  assert.deepEqual(
    candidateUserDataPaths({ platform: 'darwin', home: '/Users/u', env: { ORCA_USER_DATA_PATH: '/x' } }),
    ['/x', '/Users/u/Library/Application Support/orca'],
  );
});

test('win32 APPDATA가 있으면 APPDATA/orca', () => {
  assert.deepEqual(
    candidateUserDataPaths({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    }),
    ['C:\\Users\\u\\AppData\\Roaming\\orca'],
  );
});

test('win32 APPDATA가 없으면 홈 fallback을 쓰고 던지지 않는다', () => {
  assert.deepEqual(candidateUserDataPaths({ platform: 'win32', home: 'C:\\Users\\u', env: {} }), [
    'C:\\Users\\u\\AppData\\Roaming\\orca',
  ]);
});

test('win32에서도 ORCA_USER_DATA_PATH가 앞에 온다', () => {
  assert.deepEqual(
    candidateUserDataPaths({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { ORCA_USER_DATA_PATH: 'C:\\custom', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    }),
    ['C:\\custom', 'C:\\Users\\u\\AppData\\Roaming\\orca'],
  );
});

test('override는 단독 후보이고 다른 env 후보를 무시한다', () => {
  assert.deepEqual(
    candidateUserDataPaths({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/y', XDG_CONFIG_HOME: '/xdg' },
      override: '/abs/override',
    }),
    ['/abs/override'],
  );
});

test('override가 null이면 env 후보를 쓴다', () => {
  assert.deepEqual(candidateUserDataPaths({ platform: 'linux', home: '/home/u', override: null }), [
    '/home/u/.config/orca',
  ]);
});

// ---------------------------------------------------------------------------
// readRuntimeBinding (주입 readFile)
// ---------------------------------------------------------------------------

test('정상 metadata로 Binding을 만든다', async () => {
  const binding = await readRuntimeBinding({
    userDataPath: '/ud',
    parentPid: 4242,
    readFile: readerByDir({ '/ud': validMetadata() }),
    realpath: passThroughRealpath,
  });

  assert.deepEqual(binding, {
    userDataPath: '/ud',
    userDataKey: createHash('sha256').update('/ud', 'utf8').digest('hex'),
    runtimeId: 'rt-1',
    pid: 4242,
    startedAt: 1727000000000,
    endpoint: '/tmp/orca.sock',
    transportKind: 'unix',
    authToken: 'secret-token',
  });
});

test('레거시 단수 transport 객체를 읽는다', async () => {
  const binding = await readRuntimeBinding({
    userDataPath: '/ud',
    parentPid: 4242,
    readFile: readerByDir({
      '/ud': validMetadata({ transports: undefined, transport: { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\orca' } }),
    }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.transportKind, 'named-pipe');
  assert.equal(binding.endpoint, '\\\\.\\pipe\\orca');
});

test('transports 배열에서 지원 kind의 첫 항목을 쓴다', async () => {
  const binding = await readRuntimeBinding({
    userDataPath: '/ud',
    parentPid: 4242,
    readFile: readerByDir({
      '/ud': validMetadata({
        transports: [
          { kind: 'websocket', endpoint: 'ws://x' },
          { kind: 'unix', endpoint: '/first.sock' },
          { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\second' },
        ],
      }),
    }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.transportKind, 'unix');
  assert.equal(binding.endpoint, '/first.sock');
});

test('tcp/웹소켓 전용 transports는 no_transport', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata({ transports: [{ kind: 'websocket', endpoint: 'ws://x' }] }) }),
      realpath: passThroughRealpath,
    }),
    'no_transport',
  );
});

test('빈 transports 배열은 no_transport', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata({ transports: [] }) }),
      realpath: passThroughRealpath,
    }),
    'no_transport',
  );
});

test('endpoint가 비면 metadata_invalid', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata({ transports: [{ kind: 'unix', endpoint: '' }] }) }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('pid가 parentPid와 다르면 wrong_runtime', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 1,
      readFile: readerByDir({ '/ud': validMetadata() }),
      realpath: passThroughRealpath,
    }),
    'wrong_runtime',
  );
});

test('authToken 누락은 metadata_invalid', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata({ authToken: undefined }) }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('authToken 빈값은 metadata_invalid', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata({ authToken: '' }) }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('runtimeId/pid/startedAt 누락은 metadata_invalid', async () => {
  for (const overrides of [{ runtimeId: '' }, { pid: 0 }, { pid: 1.5 }, { startedAt: 'x' }]) {
    await assertLocationError(
      readRuntimeBinding({
        userDataPath: '/ud',
        parentPid: 4242,
        readFile: readerByDir({ '/ud': validMetadata(overrides) }),
        realpath: passThroughRealpath,
      }),
      'metadata_invalid',
    );
  }
});

test('잘못된 JSON은 metadata_invalid', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': '{not json' }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('배열 JSON은 metadata_invalid', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': '[]' }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('ENOENT는 metadata_missing', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({}),
      realpath: passThroughRealpath,
    }),
    'metadata_missing',
  );
});

test('기타 읽기 오류는 metadata_unreadable', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      realpath: passThroughRealpath,
    }),
    'metadata_unreadable',
  );
});

test('1 MiB 초과는 too_large', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: async () => 'x'.repeat(MAX_METADATA_BYTES + 1),
      realpath: passThroughRealpath,
    }),
    'too_large',
  );
});

test('1 MiB 이하 크기는 크기 때문에 거절되지 않는다', async () => {
  const padded = validMetadata({ padding: 'y'.repeat(1000) });
  const binding = await readRuntimeBinding({
    userDataPath: '/ud',
    parentPid: 4242,
    readFile: readerByDir({ '/ud': padded }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.runtimeId, 'rt-1');
});

test('에러 message/필드에 authToken이 들어가지 않는다', async () => {
  const token = 'SUPER-SECRET-TOKEN';
  async function capture(overrides) {
    try {
      await readRuntimeBinding({
        userDataPath: '/ud',
        parentPid: 4242,
        readFile: readerByDir({ '/ud': validMetadata({ authToken: token, ...overrides }) }),
        realpath: passThroughRealpath,
      });
      assert.fail('expected throw');
    } catch (error) {
      assert.ok(error instanceof LocationError);
      assert.ok(!error.message.includes(token), `message leaked token: ${error.message}`);
      assert.ok(!JSON.stringify(error).includes(token), 'serialized error leaked token');
      assert.ok(!JSON.stringify({ name: error.name, code: error.code, message: error.message }).includes(token));
      return error;
    }
  }

  await capture({ runtimeId: '' }); // metadata_invalid
  await capture({ pid: 9999, authToken: token }); // wrong_runtime
  await capture({ transports: [] }); // no_transport
});

test('realpath 실패는 metadata_unreadable', async () => {
  await assertLocationError(
    readRuntimeBinding({
      userDataPath: '/ud',
      parentPid: 4242,
      readFile: readerByDir({ '/ud': validMetadata() }),
      realpath: async () => {
        throw new Error('boom');
      },
    }),
    'metadata_unreadable',
  );
});

// ---------------------------------------------------------------------------
// readRuntimeBinding (실제 파일)
// ---------------------------------------------------------------------------

test('실제 파일을 읽어 userDataKey를 realpath 해시로 만든다', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'okap-runtime-'));
  try {
    await fs.writeFile(join(dir, METADATA_FILE), JSON.stringify(validMetadata({ pid: process.pid })));
    const binding = await readRuntimeBinding({ userDataPath: dir, parentPid: process.pid });
    const real = await fs.realpath(dir);
    assert.equal(binding.userDataKey, createHash('sha256').update(real, 'utf8').digest('hex'));
    assert.equal(binding.runtimeId, 'rt-1');
    assert.equal(binding.authToken, 'secret-token');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('실제 파일: 파일이 없으면 metadata_missing', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'okap-runtime-'));
  try {
    await assertLocationError(readRuntimeBinding({ userDataPath: dir, parentPid: 1 }), 'metadata_missing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sameBinding
// ---------------------------------------------------------------------------

test('sameBinding: 토큰만 다르면 true', () => {
  const a = { userDataKey: 'k', runtimeId: 'r', pid: 1, startedAt: 2, endpoint: 'e', authToken: 'a' };
  const b = { ...a, authToken: 'b' };
  assert.equal(sameBinding(a, b), true);
});

test('sameBinding: runtimeId가 다르면 false', () => {
  const a = { userDataKey: 'k', runtimeId: 'r1', pid: 1, startedAt: 2, endpoint: 'e', authToken: 'a' };
  const b = { ...a, runtimeId: 'r2' };
  assert.equal(sameBinding(a, b), false);
});

test('sameBinding: 각 필드 차이는 false', () => {
  const a = { userDataKey: 'k', runtimeId: 'r', pid: 1, startedAt: 2, endpoint: 'e', authToken: 'a' };
  assert.equal(sameBinding(a, { ...a, userDataKey: 'k2' }), false);
  assert.equal(sameBinding(a, { ...a, pid: 9 }), false);
  assert.equal(sameBinding(a, { ...a, startedAt: 9 }), false);
  assert.equal(sameBinding(a, { ...a, endpoint: 'e2' }), false);
});

test('sameBinding: 동일하면 true', () => {
  const a = { userDataKey: 'k', runtimeId: 'r', pid: 1, startedAt: 2, endpoint: 'e', authToken: 'a' };
  assert.equal(sameBinding(a, { ...a }), true);
});

test('sameBinding: null/undefined는 false', () => {
  const a = { userDataKey: 'k', runtimeId: 'r', pid: 1, startedAt: 2, endpoint: 'e', authToken: 'a' };
  assert.equal(sameBinding(null, null), false);
  assert.equal(sameBinding(a, null), false);
  assert.equal(sameBinding(null, a), false);
  assert.equal(sameBinding(undefined, a), false);
});

// ---------------------------------------------------------------------------
// resolveBinding
// ---------------------------------------------------------------------------

test('resolveBinding: 첫 후보 성공을 반환한다', async () => {
  const binding = await resolveBinding({
    platform: 'linux',
    home: '/home/u',
    env: { ORCA_USER_DATA_PATH: '/first' },
    parentPid: 4242,
    readFile: readerByDir({ '/first': validMetadata() }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.userDataPath, '/first');
  assert.equal(binding.runtimeId, 'rt-1');
});

test('resolveBinding: 첫 후보가 없으면 다음 후보를 시도한다', async () => {
  const binding = await resolveBinding({
    platform: 'linux',
    home: '/home/u',
    env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
    parentPid: 4242,
    readFile: readerByDir({ '/xdg/orca': validMetadata() }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.userDataPath, '/xdg/orca');
});

test('resolveBinding: override 단독 후보를 쓴다', async () => {
  const binding = await resolveBinding({
    platform: 'linux',
    home: '/home/u',
    env: { ORCA_USER_DATA_PATH: '/first' },
    override: '/override',
    parentPid: 4242,
    readFile: readerByDir({ '/override': validMetadata() }),
    realpath: passThroughRealpath,
  });
  assert.equal(binding.userDataPath, '/override');
});

test('resolveBinding: 우선순위 metadata_invalid > metadata_missing', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 4242,
      readFile: readerByDir({ '/xdg/orca': validMetadata({ authToken: '' }) }),
      realpath: passThroughRealpath,
    }),
    'metadata_invalid',
  );
});

test('resolveBinding: 우선순위 wrong_runtime > metadata_missing', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 1,
      readFile: readerByDir({ '/xdg/orca': validMetadata() }),
      realpath: passThroughRealpath,
    }),
    'wrong_runtime',
  );
});

test('resolveBinding: 우선순위 no_transport > metadata_missing', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 4242,
      readFile: readerByDir({ '/xdg/orca': validMetadata({ transports: [{ kind: 'websocket', endpoint: 'ws://x' }] }) }),
      realpath: passThroughRealpath,
    }),
    'no_transport',
  );
});

test('resolveBinding: 우선순위 metadata_unreadable > metadata_missing', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 4242,
      readFile: readerByDir({
        '/xdg/orca': Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      }),
      realpath: passThroughRealpath,
    }),
    'metadata_unreadable',
  );
});

test('resolveBinding: 첫 후보의 wrong_runtime이 뒤의 metadata_missing을 이긴다', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 1,
      readFile: readerByDir({ '/first': validMetadata() }),
      realpath: passThroughRealpath,
    }),
    'wrong_runtime',
  );
});

test('resolveBinding: 모두 없으면 metadata_missing', async () => {
  await assertLocationError(
    resolveBinding({
      platform: 'linux',
      home: '/home/u',
      env: { ORCA_USER_DATA_PATH: '/first', XDG_CONFIG_HOME: '/xdg' },
      parentPid: 4242,
      readFile: readerByDir({}),
      realpath: passThroughRealpath,
    }),
    'metadata_missing',
  );
});
