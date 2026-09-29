/**
 * Unit tests for `src/control-file.mjs`.
 *
 * Uses the real `node:fs` against a throwaway home directory to verify file
 * modes (POSIX), atomic replace, pid-scoped removal, and ENOENT/parse safety.
 *
 * Run: `node --test test/control-file.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_FILE_NAME,
  CONTROL_DIR_NAME,
  CONTROL_FILE_NAME,
  CONTROL_SCHEMA,
  controlPaths,
  installCli,
  removeControlFile,
  writeControlFile,
} from '../src/control-file.mjs';

const IS_WIN = process.platform === 'win32';

/**
 * @returns {Promise<string>}
 */
function makeHome() {
  return mkdtemp(join(tmpdir(), 'okap-ctl-'));
}

/**
 * @param {string} p
 * @returns {Promise<number>}
 */
async function modeOf(p) {
  return (await stat(p)).mode & 0o777;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test('controlPaths joins dir/file/cli under home', () => {
  const paths = controlPaths({ home: join('/tmp', 'u'), pathJoin: join });
  assert.equal(paths.dir, join('/tmp', 'u', CONTROL_DIR_NAME));
  assert.equal(paths.file, join('/tmp', 'u', CONTROL_DIR_NAME, CONTROL_FILE_NAME));
  assert.equal(paths.cli, join('/tmp', 'u', CONTROL_DIR_NAME, CLI_FILE_NAME));
});

test('writeControlFile creates 0700 dir and 0600 file atomically with no tmp left', async () => {
  const home = await makeHome();
  try {
    const paths = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 4242,
      port: 51234,
      token: 'tok-abc',
      now: () => 1234567890,
    });

    if (!IS_WIN) {
      assert.equal(await modeOf(paths.dir), 0o700, 'control dir mode');
      assert.equal(await modeOf(paths.file), 0o600, 'control file mode');
    }

    const record = JSON.parse(await readFile(paths.file, 'utf8'));
    assert.deepEqual(record, {
      schema: CONTROL_SCHEMA,
      pid: 4242,
      host: '127.0.0.1',
      port: 51234,
      token: 'tok-abc',
      startedAt: 1234567890,
    });

    assert.deepEqual(await readdir(paths.dir), [CONTROL_FILE_NAME]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('writeControlFile replaces an existing file and leaves no tmp', async () => {
  const home = await makeHome();
  try {
    await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 1,
      port: 1000,
      token: 'a',
      now: () => 1,
    });
    const paths = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 2,
      port: 2000,
      token: 'b',
      now: () => 2,
    });

    const record = JSON.parse(await readFile(paths.file, 'utf8'));
    assert.equal(record.pid, 2);
    assert.equal(record.port, 2000);
    assert.deepEqual(await readdir(paths.dir), [CONTROL_FILE_NAME]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('accepts an fs/promises-shaped API directly', async () => {
  const home = await makeHome();
  try {
    const fsp = await import('node:fs/promises');
    const paths = await writeControlFile({
      fs: fsp,
      home,
      pathJoin: join,
      pid: 3,
      port: 9,
      token: 't',
      now: () => 1,
    });
    const record = JSON.parse(await readFile(paths.file, 'utf8'));
    assert.equal(record.pid, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('removeControlFile unlinks only when the pid matches', async () => {
  const home = await makeHome();
  try {
    const paths = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 7,
      port: 1234,
      token: 'secret-token',
      now: () => 5,
    });

    assert.equal(await removeControlFile({ fs, home, pathJoin: join, pid: 8 }), false);
    assert.ok(await exists(paths.file), 'different pid must keep the file');

    assert.equal(await removeControlFile({ fs, home, pathJoin: join, pid: 7 }), true);
    assert.equal(await exists(paths.file), false, 'matching pid removes the file');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('removeControlFile ignores missing files and parse failures', async () => {
  const home = await makeHome();
  try {
    // Directory does not exist yet.
    assert.equal(await removeControlFile({ fs, home, pathJoin: join, pid: 1 }), false);

    const dir = join(home, CONTROL_DIR_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CONTROL_FILE_NAME), '{not json');
    assert.equal(await removeControlFile({ fs, home, pathJoin: join, pid: 1 }), false);
    assert.ok(await exists(join(dir, CONTROL_FILE_NAME)), 'unparseable file is left intact');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('installCli copies the source as 0700 with no tmp left', async () => {
  const home = await makeHome();
  try {
    const sourcePath = join(home, 'source-cli.mjs');
    await writeFile(sourcePath, '#!/usr/bin/env node\nconsole.log("hi");\n');

    const cli = await installCli({ fs, home, pathJoin: join, sourcePath });
    assert.equal(cli, join(home, CONTROL_DIR_NAME, CLI_FILE_NAME));

    const content = await readFile(cli, 'utf8');
    assert.match(content, /console\.log\("hi"\)/);
    if (!IS_WIN) {
      assert.equal(await modeOf(cli), 0o700);
    }
    assert.deepEqual(await readdir(join(home, CONTROL_DIR_NAME)), [CLI_FILE_NAME]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('writeControlFile never puts the token in a thrown error', async () => {
  const home = await makeHome();
  try {
    const token = 'super-secret-token-value';
    const failingFsp = {
      mkdir: async () => {},
      lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
      chmod: async () => {},
      rm: async () => {},
      writeFile: async () => {
        throw new Error('disk full');
      },
      rename: async () => {},
      readFile: async () => {
        throw new Error('nope');
      },
      unlink: async () => {},
    };

    await assert.rejects(
      () =>
        writeControlFile({
          fs: { promises: failingFsp },
          home,
          pathJoin: join,
          pid: 1,
          port: 2,
          token,
        }),
      (err) => {
        assert.ok(!String(err.message).includes(token), 'token must not leak');
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('writeControlFile records instanceId only when provided', async () => {
  const home = await makeHome();
  try {
    const withId = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 11,
      port: 1,
      token: 't',
      instanceId: 'run-1',
      now: () => 1,
    });
    const record = JSON.parse(await readFile(withId.file, 'utf8'));
    assert.equal(record.instanceId, 'run-1');
    assert.equal(record.pid, 11);

    const withoutId = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 12,
      port: 2,
      token: 't',
      now: () => 2,
    });
    const bare = JSON.parse(await readFile(withoutId.file, 'utf8'));
    assert.ok(!('instanceId' in bare), 'instanceId must be omitted when not provided');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('removeControlFile compares instanceId when provided', async () => {
  const home = await makeHome();
  try {
    const paths = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 21,
      port: 1,
      token: 't',
      instanceId: 'run-a',
      now: () => 1,
    });

    // Same pid but different instanceId keeps the file.
    assert.equal(
      await removeControlFile({ fs, home, pathJoin: join, pid: 21, instanceId: 'run-b' }),
      false,
    );
    assert.ok(await exists(paths.file));

    // Same pid and instanceId removes it.
    assert.equal(
      await removeControlFile({ fs, home, pathJoin: join, pid: 21, instanceId: 'run-a' }),
      true,
    );
    assert.equal(await exists(paths.file), false);

    // When instanceId is not passed, pid alone decides.
    await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 21,
      port: 1,
      token: 't',
      instanceId: 'run-a',
      now: () => 2,
    });
    assert.equal(await removeControlFile({ fs, home, pathJoin: join, pid: 21 }), true);
    assert.equal(await exists(paths.file), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('removeControlFile keeps an unlabelled file when instanceId is provided', async () => {
  const home = await makeHome();
  try {
    const paths = await writeControlFile({
      fs,
      home,
      pathJoin: join,
      pid: 31,
      port: 1,
      token: 't',
      now: () => 1,
    });
    assert.equal(
      await removeControlFile({ fs, home, pathJoin: join, pid: 31, instanceId: 'run-x' }),
      false,
    );
    assert.ok(await exists(paths.file));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  'ensureDir rejects a symlinked control directory with unsafe_control_dir',
  { skip: IS_WIN ? 'symlink semantics differ on win32' : false },
  async () => {
    const home = await makeHome();
    try {
      const realDir = join(home, 'real-target');
      await mkdir(realDir, { recursive: true });
      await symlink(realDir, join(home, CONTROL_DIR_NAME), 'dir');

      await assert.rejects(
        () => writeControlFile({ fs, home, pathJoin: join, pid: 1, port: 1, token: 't' }),
        (err) => {
          assert.equal(err.code, 'unsafe_control_dir');
          return true;
        },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test('writeControlFile replaces a leftover tmp file and never follows a symlink tmp', async () => {
  const home = await makeHome();
  try {
    const paths = controlPaths({ home, pathJoin: join });
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const pid = 33;
    const tmp = `${paths.file}.${pid}.tmp`;

    // A stale regular tmp file must not block the write.
    await writeFile(tmp, 'stale');
    await writeControlFile({ fs, home, pathJoin: join, pid, port: 1, token: 't', now: () => 1 });
    assert.ok(await exists(paths.file));
    assert.deepEqual(await readdir(paths.dir), [CONTROL_FILE_NAME]);

    if (!IS_WIN) {
      // A symlink tmp must be removed, not followed, so its target stays intact.
      const victim = join(home, 'victim.txt');
      await writeFile(victim, 'do not touch');
      await symlink(victim, tmp);
      await writeControlFile({ fs, home, pathJoin: join, pid, port: 2, token: 't2', now: () => 2 });
      assert.equal(await readFile(victim, 'utf8'), 'do not touch');
      const record = JSON.parse(await readFile(paths.file, 'utf8'));
      assert.equal(record.port, 2);
      assert.deepEqual(await readdir(paths.dir), [CONTROL_FILE_NAME]);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('installCli builds the tmp name from the injected pid with O_EXCL', async () => {
  const home = await makeHome();
  const events = [];
  const fakeP = {
    mkdir: async () => {},
    lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
    chmod: async () => {},
    readFile: async () => Buffer.from('cli'),
    rm: async (target) => {
      events.push(`rm:${target}`);
    },
    writeFile: async (target, _data, options) => {
      events.push(`write:${target}:${options && options.flag}`);
    },
    rename: async (from, to) => {
      events.push(`rename:${from}->${to}`);
    },
  };

  try {
    const cli = await installCli({
      fs: { promises: fakeP },
      home,
      pathJoin: join,
      sourcePath: '/source/keepalive.mjs',
      platform: 'linux',
      pid: 777,
    });
    assert.equal(cli, join(home, CONTROL_DIR_NAME, CLI_FILE_NAME));

    const expectedTmp = `${join(home, CONTROL_DIR_NAME, CLI_FILE_NAME)}.777.tmp`;
    assert.ok(events.includes(`rm:${expectedTmp}`), 'stale tmp is removed first');
    assert.ok(events.includes(`write:${expectedTmp}:wx`), 'tmp is created with O_EXCL');
    assert.ok(
      events.includes(`rename:${expectedTmp}->${cli}`),
      'tmp is renamed onto the CLI path',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
