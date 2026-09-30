/**
 * Integration tests for `bin/keepalive.mjs`.
 *
 * A real `startDashboard` server runs with a fake `getSnapshot`/`dispatch`, a
 * temporary control file points at its loopback port/token, and the CLI is
 * spawned as a child process (so direct-execution behavior is exercised).
 *
 * Run: `node --test test/cli.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDashboard } from '../src/dashboard-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'bin', 'keepalive.mjs');
const SERVER_NOW = 1_000_000;

/**
 * @param {string} id
 * @returns {string}
 */
function hashOf(id) {
  return crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Build the mutable server fixture (snapshot + dispatch recorder/applier).
 * @param {{paused?: boolean, conflictOnce?: boolean, conflictAlways?: boolean}} options
 */
function makeFixture(options = {}) {
  const state = {
    paused: options.paused === true,
    worktrees: [
      {
        id: 'wt-1',
        worktreeHash: hashOf('raw-main'),
        label: 'main',
        enabled: null,
        effectiveEnabled: true,
        reason: null,
        terminals: [
          {
            id: 'tm-1',
            title: 'claude',
            phase: 'AWAITING_TURN',
            enabledOverride: null,
            effectiveEnabled: true,
            reason: null,
            dueAt: SERVER_NOW + 192000,
            expiresAt: SERVER_NOW + 400000,
            charged: 1,
            confirmed: 0,
            needsReview: false,
            supported: true,
          },
        ],
      },
      {
        id: 'wt-2',
        worktreeHash: hashOf('raw-feat'),
        label: 'feat-x',
        enabled: false,
        effectiveEnabled: false,
        reason: null,
        terminals: [],
      },
      {
        id: 'wt-3',
        worktreeHash: hashOf('raw-dup-a'),
        label: 'dup',
        enabled: true,
        effectiveEnabled: true,
        reason: null,
        terminals: [],
      },
      {
        id: 'wt-4',
        worktreeHash: hashOf('raw-dup-b'),
        label: 'dup',
        enabled: true,
        effectiveEnabled: true,
        reason: null,
        terminals: [],
      },
    ],
  };

  let revision = 1;
  let conflictOnce = options.conflictOnce === true;
  const conflictAlways = options.conflictAlways === true;
  const actions = [];

  function snapshot() {
    return {
      revision,
      serverNow: SERVER_NOW,
      appTimer: { known: true, enabled: true, ttlMs: 300000, source: 'json', readAt: SERVER_NOW },
      connection: { state: 'connected' },
      config: {
        paused: state.paused,
        defaultWorktreeEnabled: true,
        message: 'keepalive',
        maxConsecutiveKeepalives5m: 3,
        maxConsecutiveKeepalives1h: 20,
        maxConsecutiveKeepalivesActive: 3,
      },
      worktrees: state.worktrees,
      diagnostics: [],
    };
  }

  function apply(action) {
    if (action.type === 'pause') {
      state.paused = action.paused === true;
    }
    if (action.type === 'worktree') {
      const wt = state.worktrees.find((w) => w.id === action.targetId);
      if (wt) wt.enabled = action.enabled;
    }
    if (action.type === 'worktree-orca') {
      const wt = state.worktrees.find((w) => w.worktreeHash === hashOf(action.worktreeId));
      if (!wt) {
        // 실제 dashboard-model처럼 관측되지 않은 raw id는 404 unknown_target.
        const err = new Error('unknown target');
        err.status = 404;
        err.code = 'unknown_target';
        throw err;
      }
      wt.enabled = action.enabled;
    }
  }

  return {
    actions,
    snapshot,
    dispatch: async (action) => {
      actions.push(action);
      if (conflictAlways || conflictOnce) {
        if (conflictOnce) conflictOnce = false;
        const err = new Error('revision conflict');
        err.status = 409;
        err.code = 'revision_conflict';
        throw err;
      }
      apply(action);
      revision += 1;
      return snapshot();
    },
  };
}

/**
 * Spawn the CLI and collect its output.
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runCli(args, extraEnv = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Start a dashboard + control file, run `fn`, then always clean up.
 * @param {{paused?: boolean, conflictOnce?: boolean, conflictAlways?: boolean, worktreeId?: string}} options
 * @param {(ctx: {dash: Awaited<ReturnType<typeof startDashboard>>, fixture: ReturnType<typeof makeFixture>, home: string, controlFile: string, env: Record<string,string>}) => Promise<void>} fn
 */
async function withCli(options, fn) {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-home-'));
  const assets = await mkdtemp(join(tmpdir(), 'okap-cli-assets-'));
  const fixture = makeFixture(options);
  const dash = await startDashboard({
    getSnapshot: async () => fixture.snapshot(),
    dispatch: (action) => fixture.dispatch(action),
    assetsDir: assets,
  });
  const controlFile = join(home, 'control.json');
  await writeFile(
    controlFile,
    JSON.stringify({
      schema: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: dash.port,
      token: dash.token,
      startedAt: SERVER_NOW,
    }),
  );
  /** @type {Record<string,string>} */
  const env = { ORCA_KEEPALIVE_CONTROL: controlFile };
  if (typeof options.worktreeId === 'string') {
    env.ORCA_WORKTREE_ID = options.worktreeId;
  }

  try {
    await fn({ dash, fixture, home, controlFile, env });
  } finally {
    await dash.close();
    await rm(home, { recursive: true, force: true });
    await rm(assets, { recursive: true, force: true });
  }
}

/**
 * @returns {Promise<number>} A bound-then-closed loopback port.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * @returns {Promise<number>} A pid guaranteed to be dead.
 */
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('error', reject);
    child.on('close', () => resolve(pid));
  });
}

test('status prints a human summary and never the token', async () => {
  await withCli({ worktreeId: 'raw-main' }, async ({ dash, env }) => {
    const { code, stdout, stderr } = await runCli(['status'], env);
    assert.equal(code, 0);
    assert.match(stdout, /Cache Keepalive: 켜짐/);
    assert.match(stdout, /Orca 프롬프트 캐시 타이머: 켜짐 \(5분\)/);
    assert.match(stdout, /런타임 연결: connected/);
    assert.match(stdout, /워크트리 4개/);
    assert.match(stdout, /1\. main  \[켜짐 · 기본값\]  ← 현재 터미널/);
    assert.match(stdout, /claude  대기 · 다음 전송 3분 12초 후 · 연속 1\/3/);
    assert.match(stdout, /\(터미널 없음\)/);
    assert.ok(!stdout.includes(dash.token), 'token must not appear in status');
    assert.ok(!stderr.includes(dash.token), 'token must not appear in stderr');
    assert.equal(stderr.trim(), '');
  });
});

test('status --json prints a JSON summary without the token', async () => {
  await withCli({ worktreeId: 'raw-main' }, async ({ dash, env }) => {
    const { code, stdout } = await runCli(['status', '--json'], env);
    assert.equal(code, 0);
    assert.ok(!stdout.includes(dash.token), 'token must not appear in JSON status');
    const summary = JSON.parse(stdout);
    assert.equal(summary.paused, false);
    assert.equal(summary.appTimer.ttlMs, 300000);
    assert.equal(summary.connection.state, 'connected');
    assert.equal(summary.worktreeCount, 4);
    assert.equal(summary.worktrees[0].label, 'main');
    assert.equal(summary.worktrees[0].current, true);
    assert.equal(summary.worktrees[1].current, false);
    assert.equal(summary.worktrees[0].terminals[0].phase, 'AWAITING_TURN');
    assert.equal(summary.worktrees[0].terminals[0].dueInMs, 192000);
    assert.equal(summary.maxConsecutiveKeepalives5m, 3);
    assert.equal(summary.maxConsecutiveKeepalives1h, 20);
    assert.equal(summary.maxConsecutiveKeepalivesActive, 3);
  });
});

test('on sends pause paused:false with expectedRevision', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code, stdout } = await runCli(['on'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [{ type: 'pause', paused: false, expectedRevision: 1 }]);
    assert.match(stdout, /Cache Keepalive를 켰습니다\./);
    assert.match(stdout, /Cache Keepalive: 켜짐/);
  });
});

test('off sends pause paused:true', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code, stdout } = await runCli(['off'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [{ type: 'pause', paused: true, expectedRevision: 1 }]);
    assert.match(stdout, /일시정지했습니다/);
    assert.match(stdout, /Cache Keepalive: 꺼짐 \(일시정지\)/);
  });
});

test('here shows the current worktree marker', async () => {
  await withCli({ worktreeId: 'raw-feat' }, async ({ env }) => {
    const { code, stdout } = await runCli(['here'], env);
    assert.equal(code, 0);
    assert.match(stdout, /2\. feat-x  \[꺼짐 · 직접 설정\]  ← 현재 터미널/);
  });
});

test('here on sends worktree-orca with the raw ORCA_WORKTREE_ID', async () => {
  await withCli({ worktreeId: 'raw-feat' }, async ({ fixture, env }) => {
    const { code, stdout } = await runCli(['here', 'on'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree-orca', worktreeId: 'raw-feat', enabled: true, expectedRevision: 1 },
    ]);
    assert.match(stdout, /현재 워크트리 'feat-x' keepalive를 켰습니다\./);
  });
});

test('here default sends worktree-orca with enabled:null', async () => {
  await withCli({ worktreeId: 'raw-main' }, async ({ fixture, env }) => {
    const { code } = await runCli(['here', 'default'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree-orca', worktreeId: 'raw-main', enabled: null, expectedRevision: 1 },
    ]);
  });
});

test('here without ORCA_WORKTREE_ID exits 2 with guidance', async () => {
  await withCli({}, async ({ env }) => {
    const { code, stderr } = await runCli(['here'], env);
    assert.equal(code, 2);
    assert.match(stderr, /Orca 터미널 안에서 실행해야/);
  });
});

test('worktree <number> resolves by position and sends targetId', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code, stdout } = await runCli(['worktree', '2', 'off'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree', targetId: 'wt-2', enabled: false, expectedRevision: 1 },
    ]);
    assert.match(stdout, /워크트리 'feat-x' keepalive를 껐습니다\./);
  });
});

test('worktree <label> resolves by exact label', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code } = await runCli(['worktree', 'feat-x', 'on'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree', targetId: 'wt-2', enabled: true, expectedRevision: 1 },
    ]);
  });
});

test('worktree with an ambiguous label exits 2 without dispatching', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code, stderr } = await runCli(['worktree', 'dup', 'on'], env);
    assert.equal(code, 2);
    assert.match(stderr, /모호/);
    assert.equal(fixture.actions.length, 0);
  });
});

test('retries exactly once on revision_conflict', async () => {
  await withCli({ conflictOnce: true }, async ({ fixture, env }) => {
    const { code } = await runCli(['on'], env);
    assert.equal(code, 0);
    assert.equal(fixture.actions.length, 2);
    assert.deepEqual(fixture.actions[0], { type: 'pause', paused: false, expectedRevision: 1 });
    assert.deepEqual(fixture.actions[1], { type: 'pause', paused: false, expectedRevision: 1 });
  });
});

test('persistent revision_conflict exits 1 with the server code', async () => {
  await withCli({ conflictAlways: true }, async ({ env }) => {
    const { code, stderr } = await runCli(['on'], env);
    assert.equal(code, 1);
    assert.match(stderr, /오류: revision_conflict/);
  });
});

test('url prints the dashboard address and a token warning on stderr', async () => {
  await withCli({}, async ({ dash, env }) => {
    const { code, stdout, stderr } = await runCli(['url'], env);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), `http://127.0.0.1:${dash.port}/#token=${dash.token}`);
    assert.match(stderr, /공유하지 마세요/);
  });
});

test('exits 3 when the control file is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-missing-'));
  try {
    const { code, stderr } = await runCli(['status'], {
      ORCA_KEEPALIVE_CONTROL: join(home, 'nope', 'control.json'),
    });
    assert.equal(code, 3);
    assert.match(stderr, /실행 중이 아닙니다/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('exits 3 when the recorded pid is dead', async () => {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-dead-'));
  try {
    const file = join(home, 'control.json');
    await writeFile(
      file,
      JSON.stringify({ schema: 1, pid: await deadPid(), host: '127.0.0.1', port: 1, token: 'x' }),
    );
    const { code, stderr } = await runCli(['status'], { ORCA_KEEPALIVE_CONTROL: file });
    assert.equal(code, 3);
    assert.match(stderr, /실행 중이 아닙니다/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('exits 3 when the pid is alive but the server is down', async () => {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-noserver-'));
  try {
    const file = join(home, 'control.json');
    await writeFile(
      file,
      JSON.stringify({
        schema: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: await freePort(),
        token: 'x',
      }),
    );
    const { code, stderr } = await runCli(['status'], { ORCA_KEEPALIVE_CONTROL: file });
    assert.equal(code, 3);
    assert.match(stderr, /실행 중이 아닙니다/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('unknown command prints usage and exits 2', async () => {
  await withCli({}, async ({ env }) => {
    const { code, stderr } = await runCli(['frobnicate'], env);
    assert.equal(code, 2);
    assert.match(stderr, /알 수 없는 명령: frobnicate/);
    assert.match(stderr, /사용법: keepalive/);
  });
});

test('help exits 0 and prints usage without needing a control file', async () => {
  const { code, stdout } = await runCli(['help'], {
    ORCA_KEEPALIVE_CONTROL: '/nonexistent/control.json',
  });
  assert.equal(code, 0);
  assert.match(stdout, /사용법: keepalive/);
});

test('here exits 1 with an actionable message when ORCA_WORKTREE_ID is unknown', async () => {
  await withCli({ worktreeId: 'raw-unknown' }, async ({ env }) => {
    const { code, stdout, stderr } = await runCli(['here'], env);
    assert.equal(code, 1);
    assert.match(stderr, /keepalive 대상 목록에서 찾지 못했습니다/);
    assert.match(stderr, /'status'로 목록을 확인하고 'worktree <번호> on\|off'를 사용하세요/);
    assert.equal(stdout.trim(), '');
  });
});

test('here on exits 1 with the same guidance when the server reports unknown_target', async () => {
  await withCli({ worktreeId: 'raw-unknown' }, async ({ env }) => {
    const { code, stdout, stderr } = await runCli(['here', 'on'], env);
    assert.equal(code, 1);
    assert.match(stderr, /keepalive 대상 목록에서 찾지 못했습니다/);
    assert.doesNotMatch(stderr, /오류: unknown_target/);
    assert.equal(stdout.trim(), '');
  });
});

test('worktree trims a label selector before matching', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code } = await runCli(['worktree', '  feat-x  ', 'on'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree', targetId: 'wt-2', enabled: true, expectedRevision: 1 },
    ]);
  });
});

test('worktree <number> default sends enabled:null', async () => {
  await withCli({}, async ({ fixture, env }) => {
    const { code } = await runCli(['worktree', '1', 'default'], env);
    assert.equal(code, 0);
    assert.deepEqual(fixture.actions, [
      { type: 'worktree', targetId: 'wt-1', enabled: null, expectedRevision: 1 },
    ]);
  });
});

test('url exits 3 when the plugin is not running', async () => {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-url-missing-'));
  try {
    const { code, stdout, stderr } = await runCli(['url'], {
      ORCA_KEEPALIVE_CONTROL: join(home, 'nope', 'control.json'),
    });
    assert.equal(code, 3);
    assert.match(stderr, /실행 중이 아닙니다/);
    assert.equal(stdout.trim(), '');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('treats an oversized control file as not running (exit 3)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'okap-cli-big-'));
  try {
    const file = join(home, 'control.json');
    await writeFile(file, 'x'.repeat(64 * 1024 + 1));
    const { code, stderr } = await runCli(['status'], { ORCA_KEEPALIVE_CONTROL: file });
    assert.equal(code, 3);
    assert.match(stderr, /실행 중이 아닙니다/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
