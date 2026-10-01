import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDashboard } from '../src/dashboard-server.mjs';
import { createStateStore } from '../src/state-store.mjs';
import { createDashboardModel } from '../src/dashboard-model.mjs';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><h1>Cache Keepalive</h1><script type="module" src="/app.mjs"></script></body></html>';
const APP_MJS = 'export const version = 1;\n';
const STYLE_CSS = 'body { font-family: system-ui, sans-serif; }\n';

/**
 * @param {string[]} [files]
 */
async function makeAssets() {
  const dir = await mkdtemp(join(tmpdir(), 'okap-dash-'));
  await writeFile(join(dir, 'index.html'), INDEX_HTML);
  await writeFile(join(dir, 'app.mjs'), APP_MJS);
  await writeFile(join(dir, 'style.css'), STYLE_CSS);
  return dir;
}

/**
 * Issue a raw HTTP request with full header control.
 * @param {number} port
 * @param {{method?: string, path?: string, headers?: Record<string,string>, body?: string | Buffer}} [options]
 */
function request(port, options = {}) {
  const { method = 'GET', path = '/', headers = {}, body } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start a server with tracked stubs, run `fn`, then always close and clean up.
 * @param {{start?: object, dispatch?: Function, snapshot?: unknown, assetsDir?: string}} options
 * @param {(ctx: {result: Awaited<ReturnType<typeof startDashboard>>, calls: {snapshot: number, dispatch: any[]}, origin: string}) => Promise<void>} fn
 */
async function withServer(options, fn) {
  const assetsDir = options.assetsDir ?? (await makeAssets());
  const ownsAssets = options.assetsDir === undefined;
  const calls = { snapshot: 0, dispatch: [] };
  let current = options.snapshot ?? { revision: 1, serverNow: 1000 };
  const dispatchImpl = options.dispatch ?? (async (action) => ({ revision: 2, action }));

  const result = await startDashboard({
    getSnapshot: async () => {
      calls.snapshot += 1;
      return current;
    },
    dispatch: async (action) => {
      calls.dispatch.push(action);
      return dispatchImpl(action);
    },
    assetsDir,
    ...options.start,
  });

  try {
    await fn({
      result,
      calls,
      origin: `http://127.0.0.1:${result.port}`,
      setSnapshot: (value) => {
        current = value;
      },
    });
  } finally {
    await result.close();
    if (ownsAssets) await rm(assetsDir, { recursive: true, force: true });
  }
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function assertSecurityHeaders(headers) {
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['content-security-policy'], CSP);
  for (const name of Object.keys(headers)) {
    assert.ok(
      !name.toLowerCase().startsWith('access-control-'),
      `unexpected CORS header: ${name}`,
    );
  }
}

test('start exposes url/port/token and binds only to 127.0.0.1', async () => {
  const assetsDir = await makeAssets();
  const result = await startDashboard({
    getSnapshot: async () => ({}),
    dispatch: async () => ({}),
    assetsDir,
  });
  try {
    assert.equal(typeof result.url, 'string');
    assert.equal(typeof result.port, 'number');
    assert.equal(result.token.length, 43, '32 random bytes -> 43 base64url chars');
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.url, `http://127.0.0.1:${result.port}/#token=${result.token}`);
    const address = result.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    await result.close();
    await result.close(); // idempotent
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});

test('refuses a non-loopback host at startup', async () => {
  const assetsDir = await makeAssets();
  try {
    await assert.rejects(
      () =>
        startDashboard({
          getSnapshot: async () => ({}),
          dispatch: async () => ({}),
          assetsDir,
          host: '0.0.0.0',
        }),
      /loopback/,
    );
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});

test('serves the fixed asset allowlist with strict content types', async () => {
  await withServer({}, async ({ result }) => {
    const root = await request(result.port, { path: '/' });
    assert.equal(root.status, 200);
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(root.text, INDEX_HTML);
    assertSecurityHeaders(root.headers);

    const app = await request(result.port, { path: '/app.mjs' });
    assert.equal(app.status, 200);
    assert.equal(app.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(app.text, APP_MJS);

    const css = await request(result.port, { path: '/style.css' });
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.text, STYLE_CSS);
  });
});

test('rejects unknown paths, traversal, encoding and query tricks with 404', async () => {
  await withServer({}, async ({ result }) => {
    const paths = [
      '/nope',
      '/index.html',
      '/app.mjs/../x',
      '/app.mjs/..',
      '/..%2fapp.mjs',
      '/%2e%2e/app.mjs',
      '/%2E%2E%2Fapp.mjs',
      '/app.mjs%00',
      '/style.css/../../index.html',
      '/../index.html',
      '/app.mjs?x=1',
      '/api/state?token=abc',
      '/\\..\\app.mjs',
      '//app.mjs',
    ];
    for (const path of paths) {
      const res = await request(result.port, { path });
      assert.equal(res.status, 404, `expected 404 for ${path}`);
      assertSecurityHeaders(res.headers);
    }
  });
});

test('enforces the exact Host header to block DNS rebinding', async () => {
  await withServer({}, async ({ result }) => {
    const ok = await request(result.port, { path: '/' });
    assert.equal(ok.status, 200);

    for (const host of ['evil.example', 'localhost', `localhost:${result.port}`, '127.0.0.1', `127.0.0.1:${result.port + 1}`]) {
      const res = await request(result.port, { path: '/', headers: { Host: host } });
      assert.equal(res.status, 421, `expected 421 for Host ${host}`);
      assertSecurityHeaders(res.headers);
    }
  });
});

test('rejects cross-origin requests when Origin is present', async () => {
  await withServer({}, async ({ result }) => {
    const asset = await request(result.port, {
      path: '/',
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(asset.status, 403);

    const state = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${result.token}`, Origin: 'https://evil.example' },
    });
    assert.equal(state.status, 403);
    assertSecurityHeaders(state.headers);
  });
});

test('GET /api/state requires a bearer token (missing / wrong / wrong length)', async () => {
  await withServer({}, async ({ result, calls }) => {
    const missing = await request(result.port, { path: '/api/state' });
    assert.equal(missing.status, 401);

    const wrongSameLength = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${'A'.repeat(result.token.length)}` },
    });
    assert.equal(wrongSameLength.status, 401);

    const wrongLength = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${result.token}x` },
    });
    assert.equal(wrongLength.status, 401);

    const wrongScheme = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Basic ${result.token}` },
    });
    assert.equal(wrongScheme.status, 401);

    // Token supplied out-of-band is never accepted: query is not the route and cookies are ignored.
    const viaQuery = await request(result.port, { path: `/api/state?token=${result.token}` });
    assert.notEqual(viaQuery.status, 200);
    const viaCookie = await request(result.port, {
      path: '/api/state',
      headers: { Cookie: `token=${result.token}` },
    });
    assert.equal(viaCookie.status, 401);

    assert.equal(calls.snapshot, 0, 'snapshot must not be read for rejected requests');

    const ok = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${result.token}` },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { revision: 1, serverNow: 1000 });
    assert.equal(calls.snapshot, 1);
    assertSecurityHeaders(ok.headers);
  });
});

test('POST /api/action enforces Origin, content type and token', async () => {
  await withServer({}, async ({ result, calls }) => {
    const token = `Bearer ${result.token}`;
    const json = 'application/json';

    const noOrigin = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: { Authorization: token, 'Content-Type': json },
      body: JSON.stringify({ type: 'pause' }),
    });
    assert.equal(noOrigin.status, 403);

    const badOrigin = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: { Authorization: token, 'Content-Type': json, Origin: 'http://evil.example' },
      body: JSON.stringify({ type: 'pause' }),
    });
    assert.equal(badOrigin.status, 403);

    const noContentType = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: { Authorization: token, Origin: `http://127.0.0.1:${result.port}` },
      body: JSON.stringify({ type: 'pause' }),
    });
    assert.equal(noContentType.status, 415);

    const wrongContentType = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: {
        Authorization: token,
        'Content-Type': 'text/plain',
        Origin: `http://127.0.0.1:${result.port}`,
      },
      body: JSON.stringify({ type: 'pause' }),
    });
    assert.equal(wrongContentType.status, 415);

    const noToken = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: { 'Content-Type': json, Origin: `http://127.0.0.1:${result.port}` },
      body: JSON.stringify({ type: 'pause' }),
    });
    assert.equal(noToken.status, 401);

    assert.equal(calls.dispatch.length, 0, 'dispatch must not run for rejected requests');

    // Content-Type parameters are allowed.
    const parameterized = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json; charset=utf-8',
        Origin: `http://127.0.0.1:${result.port}`,
      },
      body: JSON.stringify({ type: 'pause', paused: true }),
    });
    assert.equal(parameterized.status, 200);
    assert.deepEqual(calls.dispatch, [{ type: 'pause', paused: true }]);
    assert.deepEqual(JSON.parse(parameterized.text), {
      revision: 2,
      action: { type: 'pause', paused: true },
    });
  });
});

test('rejects malformed bodies and actions with 400', async () => {
  await withServer({}, async ({ result, calls }) => {
    const headers = {
      Authorization: `Bearer ${result.token}`,
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${result.port}`,
    };

    const badJson = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers,
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.text).error.code, 'bad_json');

    for (const body of ['[]', '"pause"', '42', 'null', '{"type":123}', '{}']) {
      const res = await request(result.port, { method: 'POST', path: '/api/action', headers, body });
      assert.equal(res.status, 400, `expected 400 for body ${body}`);
      assert.equal(JSON.parse(res.text).error.code, 'bad_request');
      assertSecurityHeaders(res.headers);
    }
    assert.equal(calls.dispatch.length, 0);
  });
});

test('enforces the 16 KiB body limit with 413', async () => {
  await withServer({}, async ({ result }) => {
    const headers = {
      Authorization: `Bearer ${result.token}`,
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${result.port}`,
    };

    // Exactly at the limit is accepted.
    const prefix = '{"type":"x","pad":"';
    const suffix = '"}';
    const pad = 'a'.repeat(16 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
    const atLimit = `${prefix}${pad}${suffix}`;
    assert.equal(Buffer.byteLength(atLimit), 16 * 1024);
    const accepted = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers,
      body: atLimit,
    });
    assert.equal(accepted.status, 200);

    const overLimit = await request(result.port, {
      method: 'POST',
      path: '/api/action',
      headers,
      body: `${atLimit}a`,
    });
    assert.equal(overLimit.status, 413);
    assert.equal(JSON.parse(overLimit.text).error.code, 'payload_too_large');
    assertSecurityHeaders(overLimit.headers);
  });
});

test('maps dispatch errors without leaking messages or stacks', async () => {
  const dispatch = async (action) => {
    switch (action.type) {
      case 'conflict':
        throw Object.assign(new Error('revision is stale'), {
          status: 409,
          code: 'revision_conflict',
        });
      case 'missing':
        throw Object.assign(new Error('unknown target'), { status: 404, code: 'unknown_target' });
      case 'unavailable':
        throw Object.assign(new Error('storage down'), {
          status: 503,
          code: 'storage_unavailable',
        });
      case 'rejected':
        throw Object.assign(new Error('bad payload'), { status: 400, code: 'invalid_payload' });
      case 'invalid-code':
        throw Object.assign(new Error('nope'), { status: 409, code: 'NOT VALID CODE' });
      case 'secret':
        throw Object.assign(new Error('super secret message'), { code: 'Secret!' });
      default:
        throw new Error('leak-me-please');
    }
  };

  await withServer({ dispatch }, async ({ result }) => {
    const headers = {
      Authorization: `Bearer ${result.token}`,
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${result.port}`,
    };
    const cases = [
      ['conflict', 409, 'revision_conflict'],
      ['missing', 404, 'unknown_target'],
      ['unavailable', 503, 'storage_unavailable'],
      ['rejected', 400, 'invalid_payload'],
      ['invalid-code', 409, 'internal'],
      ['secret', 500, 'internal'],
      ['boom', 500, 'internal'],
    ];
    for (const [type, status, code] of cases) {
      const res = await request(result.port, {
        method: 'POST',
        path: '/api/action',
        headers,
        body: JSON.stringify({ type }),
      });
      assert.equal(res.status, status, `status for ${type}`);
      assert.deepEqual(JSON.parse(res.text), { error: { code } }, `body for ${type}`);
      assert.ok(!res.text.includes('secret'), 'error message must not leak');
      assert.ok(!res.text.includes('leak-me'), 'error message must not leak');
      assert.ok(!res.text.includes('Error'), 'stack must not leak');
      assertSecurityHeaders(res.headers);
    }
  });
});

test('rate limits the whole server with 429', async () => {
  await withServer({ start: { maxRequestsPerSecond: 3 } }, async ({ result }) => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(result.port, { path: '/' });
      statuses.push(res.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 3);
    assert.equal(statuses.filter((s) => s === 429).length, 3);
    const limited = await request(result.port, { path: '/' });
    if (limited.status === 429) assertSecurityHeaders(limited.headers);
  });
});

test('OPTIONS is rejected with 405', async () => {
  await withServer({}, async ({ result }) => {
    const res = await request(result.port, { method: 'OPTIONS', path: '/api/state' });
    assert.equal(res.status, 405);
    assertSecurityHeaders(res.headers);
  });
});

test('close is idempotent and terminates keep-alive connections', async () => {
  const assetsDir = await makeAssets();
  const result = await startDashboard({
    getSnapshot: async () => ({}),
    dispatch: async () => ({}),
    assetsDir,
  });
  try {
    const first = await request(result.port, { path: '/' });
    assert.equal(first.status, 200);
    await result.close();
    await result.close();
    await assert.rejects(() => request(result.port, { path: '/' }));
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});

test('returns JSON snapshots and never emits CORS headers', async () => {
  await withServer({ snapshot: { revision: 7, serverNow: 42 } }, async ({ result }) => {
    const res = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${result.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(res.text), { revision: 7, serverNow: 42 });
    assertSecurityHeaders(res.headers);
  });
});

// ---------------------------------------------------------------------------
// 캐시 상태 표시 필드: 실제 dashboard-model snapshot을 HTTP로 전달
// ---------------------------------------------------------------------------

/** 메모리 Map 기반 fake host storage(제품 상태 저장소용). */
function createMemoryHost() {
  const storage = new Map();
  async function hostCall(method, params = {}) {
    if (method === 'storage.get') {
      return { value: storage.has(params.key) ? structuredClone(storage.get(params.key)) : undefined };
    }
    if (method === 'storage.set') {
      storage.set(params.key, structuredClone(params.value));
      return { ok: true };
    }
    throw new Error(`unknown method ${method}`);
  }
  return { hostCall, storage };
}

test('GET /api/state는 캐시 상태 필드를 전달하고 알 수 없는 문자열·초안 텍스트를 새 필드로 노출하지 않는다', async () => {
  const DRAFT_TEXT = 'draft-secret: 사용자가 입력한 초안';
  const SCREEN_TEXT = 'screen-secret: 캡처된 화면 원문';
  const UNKNOWN_REASON = 'SOMETHING_UNKNOWN_XYZ';
  const UNKNOWN_STATE = 'draft-secret-state';
  const UNKNOWN_STATUS = 'draft-secret-status';

  const { hostCall } = createMemoryHost();
  const store = createStateStore({ hostCall });
  await store.load();

  const runtime = {
    userDataKey: 'u'.repeat(64),
    profileId: 'p1',
    connection: { state: 'connected', reason: null },
    profileSettings: {
      known: true,
      source: 'index',
      readAt: 1,
      reason: null,
    },
    worktrees: [
      {
        worktreeId: 'worktree-abc',
        label: 'main',
        branch: 'main',
        terminals: [
          {
            worktreeId: 'worktree-abc',
            paneKey: 'pane-kept',
            title: 'claude #1',
            phase: 'ARMED',
            reason: null,
            dueAt: 5000,
            expiresAt: 9000,
            supported: true,
            unsupportedReason: null,
            cacheState: 'kept',
            cacheStatus: 'scheduled',
            indicatorOn: true,
            expiredAt: 9000,
            expireCause: 'DRAFT_PRESENT',
            blockedReason: 'OUTPUT_ACTIVE',
            // 노출되면 안 되는 원시 문자열. snapshot 어디에도 새 필드로 나오면 안 된다.
            draft: DRAFT_TEXT,
            screen: SCREEN_TEXT,
          },
          {
            worktreeId: 'worktree-abc',
            paneKey: 'pane-unknown',
            title: 'claude #2',
            phase: 'ARMED',
            reason: null,
            supported: true,
            unsupportedReason: null,
            cacheState: UNKNOWN_STATE,
            cacheStatus: UNKNOWN_STATUS,
            indicatorOn: 'yes',
            expiresAt: 'not-a-number',
            expiredAt: Number.POSITIVE_INFINITY,
            expireCause: UNKNOWN_REASON,
            blockedReason: DRAFT_TEXT,
          },
        ],
      },
    ],
  };

  const model = createDashboardModel({
    store,
    getRuntimeView: () => runtime,
    getDiagnostics: () => [],
    now: () => 1000,
  });

  const assetsDir = await makeAssets();
  const result = await startDashboard({
    getSnapshot: () => model.snapshot(),
    dispatch: async () => ({}),
    assetsDir,
  });
  try {
    const res = await request(result.port, {
      path: '/api/state',
      headers: { Authorization: `Bearer ${result.token}` },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    const terminals = (body.worktrees ?? []).flatMap((worktree) => worktree.terminals ?? []);
    assert.equal(terminals.length, 2);

    const kept = terminals.find((terminal) => terminal.title === 'claude #1');
    assert.ok(kept, '첫 터미널이 있어야 한다');
    assert.equal(kept.cacheState, 'kept');
    assert.equal(kept.cacheStatus, 'scheduled');
    assert.equal(kept.indicatorOn, true);
    assert.equal(kept.expiresAt, 9000);
    assert.equal(kept.expiredAt, 9000);
    assert.equal(kept.expireCause, 'DRAFT_PRESENT');
    assert.equal(kept.blockedReason, 'OUTPUT_ACTIVE');
    assert.equal(kept.dueAt, 5000);
    assert.equal(kept.phase, 'ARMED');
    // raw draft/screen 키는 terminal row에 없어야 한다.
    assert.equal('draft' in kept, false, 'raw draft 키가 노출되면 안 된다');
    assert.equal('screen' in kept, false, 'raw screen 키가 노출되면 안 된다');
    assert.equal(res.text.includes(DRAFT_TEXT), false, '초안 텍스트가 응답에 노출되면 안 된다');
    assert.equal(res.text.includes(SCREEN_TEXT), false, '화면 텍스트가 응답에 노출되면 안 된다');

    const unknown = terminals.find((terminal) => terminal.title === 'claude #2');
    assert.ok(unknown, '둘째 터미널이 있어야 한다');
    assert.equal(unknown.cacheState, 'none', '알 수 없는 cacheState는 none으로 정규화');
    assert.equal(unknown.cacheStatus, 'no-reservation', '알 수 없는 cacheStatus는 기본값으로 정규화');
    assert.equal(unknown.indicatorOn, false, 'boolean이 아닌 indicatorOn은 false');
    assert.equal(unknown.expiresAt, null);
    assert.equal(unknown.expiredAt, null, '비유한 expiredAt은 null');
    assert.equal(unknown.expireCause, null, 'allowlist 밖 reason은 null');
    assert.equal(unknown.blockedReason, null, '초안 텍스트를 blockedReason으로 노출하지 않는다');
    assert.equal(res.text.includes(UNKNOWN_REASON), false);
    assert.equal(res.text.includes(UNKNOWN_STATE), false);
    assert.equal(res.text.includes(UNKNOWN_STATUS), false);
    assertSecurityHeaders(res.headers);
  } finally {
    await result.close();
    await rm(assetsDir, { recursive: true, force: true });
  }
});

