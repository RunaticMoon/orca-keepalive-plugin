import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { promises as realFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiagnostics } from '../src/diagnostics.mjs'
import { DIAGNOSTIC_EVENTS, REASON_CODES } from '../src/contracts.mjs'

const SECRET = 'secret-token-XYZ'
const PATH_SECRET = '/home/user/path'
const URL_SECRET = 'http://127.0.0.1'

/**
 * OS 임시 디렉터리를 만들고, 테스트가 끝나면 지운다.
 * @param {(dir: string) => Promise<void>} fn
 */
async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cap-diag-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 고정 시각 공급자. */
function fixedNow() {
  return 1_700_000_000_000
}

/** 파일 전체 내용에 비밀 문자열이 없는지 검사한다. */
function assertNoSecrets(text) {
  for (const secret of [SECRET, PATH_SECRET, URL_SECRET]) {
    assert.equal(text.includes(secret), false, `leaked ${secret} in ${text}`)
  }
}

// ---------------------------------------------------------------------------
// allowlist: event / code
// ---------------------------------------------------------------------------

test('allowlist 밖 event는 unknown_event로 치환되고 원래 이름은 버려진다', () => {
  const lines = []
  const diag = createDiagnostics({ now: fixedNow, log: (line) => lines.push(line) })

  diag.record({ event: 'totally_custom_event' })
  diag.record({ event: 'bootstrap_started' })
  diag.record({ event: 42 })
  diag.record({})

  const entries = diag.snapshot()
  assert.equal(entries[0].event, 'unknown_event')
  assert.equal(entries[1].event, 'bootstrap_started')
  assert.equal(entries[2].event, 'unknown_event')
  assert.equal(entries[3].event, 'unknown_event')
  assert.equal(JSON.stringify(entries).includes('totally_custom_event'), false)
  assert.equal(lines.join('\n').includes('totally_custom_event'), false)
})

test('DIAGNOSTIC_EVENTS의 모든 event는 그대로 유지된다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  for (const event of DIAGNOSTIC_EVENTS) {
    diag.record({ event })
  }
  assert.deepEqual(
    diag.snapshot().map((entry) => entry.event),
    [...DIAGNOSTIC_EVENTS],
  )
})

test('title_indicator는 DIAGNOSTIC_EVENTS에 정식 등록되어 유지된다', () => {
  assert.ok(DIAGNOSTIC_EVENTS.includes('title_indicator'))
  const diag = createDiagnostics({ now: fixedNow })
  diag.record({ event: 'title_indicator', code: 'save_failed' })
  const entries = diag.snapshot()
  assert.equal(entries[0].event, 'title_indicator')
  assert.equal(entries[0].code, 'save_failed')
  // 신규 event가 unknown_event로 뭉개지지 않는다.
  assert.equal(diag.snapshot()[0].event, 'title_indicator')
})

test('notify_failed는 DIAGNOSTIC_EVENTS에 정식 등록되어 유지된다', () => {
  assert.ok(DIAGNOSTIC_EVENTS.includes('notify_failed'))
  const diag = createDiagnostics({ now: fixedNow })
  diag.record({ event: 'notify_failed', code: 'not_delivered' })
  const entries = diag.snapshot()
  assert.equal(entries[0].event, 'notify_failed')
  assert.equal(entries[0].code, 'not_delivered')
  // 신규 event가 unknown_event로 뭉개지지 않는다.
  assert.equal(diag.snapshot()[0].event, 'notify_failed')
})

test('code는 REASON_CODES 값과 lower_snake_case만 유지하고 나머지는 other', () => {
  const diag = createDiagnostics({ now: fixedNow })

  diag.record({ event: 'turn_observed', code: 'APP_TIMER_OFF' })
  diag.record({ event: 'turn_observed', code: 'my_reason' })
  diag.record({ event: 'turn_observed', code: 'my_reason_1' })
  diag.record({ event: 'turn_observed', code: 'BadCode' })
  diag.record({ event: 'turn_observed', code: 'has space' })
  diag.record({ event: 'turn_observed', code: SECRET })
  diag.record({ event: 'turn_observed' })

  const codes = diag.snapshot().map((entry) => entry.code)
  assert.equal(codes[0], 'APP_TIMER_OFF')
  assert.equal(codes[1], 'my_reason')
  assert.equal(codes[2], 'other')
  assert.equal(codes[3], 'other')
  assert.equal(codes[4], 'other')
  assert.equal(codes[5], 'other')
  assert.equal(codes[6], undefined)
  // REASON_CODES 값이 실제로 유지되는지 표본 확인.
  assert.ok(Object.values(REASON_CODES).includes(codes[0]))
})

// ---------------------------------------------------------------------------
// targetId hash
// ---------------------------------------------------------------------------

test('targetId는 salt+sha256 앞 12 hex로만 저장되고 원문이 남지 않는다', () => {
  const diag = createDiagnostics({ now: fixedNow, hashSalt: 'aabbcc' })
  const targetId = 'TARGET-ID-UNIQUE-42'

  const hash = diag.hashTarget(targetId)
  assert.match(hash, /^[0-9a-f]{12}$/)
  assert.equal(diag.hashTarget(targetId), hash)
  assert.notEqual(diag.hashTarget('TARGET-ID-UNIQUE-43'), hash)

  diag.record({ event: 'epoch_armed', targetId })
  const entries = diag.snapshot()
  assert.equal(entries[0].target, hash)
  assert.equal(JSON.stringify(entries).includes(targetId), false)
})

test('salt가 다르면 같은 id의 hash도 달라진다', () => {
  const a = createDiagnostics({ now: fixedNow, hashSalt: 'aa' })
  const b = createDiagnostics({ now: fixedNow, hashSalt: 'bb' })
  assert.notEqual(a.hashTarget('same-id'), b.hashTarget('same-id'))
})

// ---------------------------------------------------------------------------
// detail redaction
// ---------------------------------------------------------------------------

test('detail은 allowlist key의 유한수/boolean만 남긴다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  diag.record({
    event: 'epoch_armed',
    detail: {
      count: 3,
      ttlMs: 300_000,
      epochId: true,
      attempt: false,
      phase_code: 'PASTING',
      bytes: Number.POSITIVE_INFINITY,
      ttlms: 5,
      nested: { a: 1 },
      list: [1, 2],
      token: SECRET,
      revision: Number.NaN,
    },
  })

  const entry = diag.snapshot()[0]
  assert.deepEqual(entry.detail, { count: 3, ttlMs: 300_000, epochId: true, attempt: false })
  assert.equal(Object.isFrozen(entry.detail), false)
})

test('detail에 문자열 값만 있으면 detail 자체가 생략된다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  diag.record({ event: 'safety_skipped', detail: { count: SECRET, phase_code: PATH_SECRET } })
  assert.equal(diag.snapshot()[0].detail, undefined)
})

// ---------------------------------------------------------------------------
// 전면 redaction
// ---------------------------------------------------------------------------

test('어떤 입력 비밀도 snapshot/log/파일에 남지 않는다', async () => {
  await withTmpDir(async (dir) => {
    const lines = []
    const diag = createDiagnostics({
      now: fixedNow,
      dir,
      log: (line) => lines.push(line),
      hashSalt: 'cafe',
    })

    diag.record({
      event: SECRET,
      level: 'warn',
      code: SECRET,
      targetId: PATH_SECRET,
      detail: {
        count: 1,
        ttlMs: SECRET,
        phase_code: URL_SECRET,
        memo: SECRET,
        url: URL_SECRET,
        path: PATH_SECRET,
      },
    })
    await diag.close()

    const snapshot = diag.snapshot()
    assertNoSecrets(JSON.stringify(snapshot))
    assertNoSecrets(lines.join('\n'))
    const file = await readFile(join(dir, 'events.jsonl'), 'utf8')
    assertNoSecrets(file)
  })
})

test('캐시 상태 진단도 초안·화면 텍스트를 새로 기록하지 않는다', async () => {
  await withTmpDir(async (dir) => {
    const DRAFT = 'draft text: 사용자가 입력한 초안 원문'
    const SCREEN = 'screen text: 캡처된 화면 원문'
    const lines = []
    const diag = createDiagnostics({
      now: fixedNow,
      dir,
      log: (line) => lines.push(line),
      hashSalt: 'beef',
    })

    // 캐시 상태 경로(§2-3)에서 나올 수 있는 event/code 위치로 원시 문자열을 밀어넣는다.
    diag.record({
      event: 'epoch_armed',
      code: 'DRAFT_PRESENT',
      targetId: DRAFT,
      detail: { ttlMs: 300000, draft: DRAFT, screen: SCREEN, tail: SCREEN },
    })
    diag.record({ event: 'epoch_expired', code: 'DRAFT_PRESENT', targetId: SCREEN })
    diag.record({
      event: 'safety_skipped',
      code: DRAFT,
      targetId: DRAFT,
      detail: { phase_code: SCREEN, count: 1 },
    })
    diag.record({ event: 'turn_observed', code: SCREEN })
    await diag.close()

    const snapshot = diag.snapshot()
    const serialized = JSON.stringify(snapshot)
    assert.equal(serialized.includes(DRAFT), false, '초안 텍스트가 snapshot에 남으면 안 된다')
    assert.equal(serialized.includes(SCREEN), false, '화면 텍스트가 snapshot에 남으면 안 된다')
    assert.equal(lines.join('\n').includes(DRAFT), false)
    assert.equal(lines.join('\n').includes(SCREEN), false)
    const file = await readFile(join(dir, 'events.jsonl'), 'utf8')
    assert.equal(file.includes(DRAFT), false)
    assert.equal(file.includes(SCREEN), false)

    // 캐시 상태 reason enum은 그대로 유지되고, detail은 허용 key의 숫자만 남는다.
    assert.equal(snapshot[0].event, 'epoch_armed')
    assert.equal(snapshot[0].code, 'DRAFT_PRESENT')
    assert.deepEqual(snapshot[0].detail, { ttlMs: 300000 })
    assert.equal('draft' in snapshot[0].detail, false)
    assert.equal('screen' in snapshot[0].detail, false)
    assert.equal('tail' in snapshot[0].detail, false)

    // 원시 문자열 code는 other로, 문자열 detail은 버려진다.
    const skipped = snapshot.find((entry) => entry.event === 'safety_skipped')
    assert.equal(skipped.code, 'other')
    assert.deepEqual(skipped.detail, { count: 1 })
  })
})

test('record는 동기 반환이고 log를 entry별 JSON 한 줄로 호출한다', () => {
  const lines = []
  const diag = createDiagnostics({ now: fixedNow, log: (line) => lines.push(line) })
  diag.record({ event: 'bootstrap_started', code: 'SETTINGS_UNKNOWN' })
  // 동기 시점에 ring에 이미 반영되어야 한다.
  assert.equal(diag.snapshot().length, 1)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), diag.snapshot()[0])
})

test('log가 throw해도 record는 삼킨다', () => {
  const diag = createDiagnostics({
    now: fixedNow,
    log: () => {
      throw new Error('host log failure')
    },
  })
  assert.doesNotThrow(() => diag.record({ event: 'bootstrap_started' }))
  assert.equal(diag.snapshot().length, 1)
})

// ---------------------------------------------------------------------------
// ring
// ---------------------------------------------------------------------------

test('ring은 최근 200개로 제한되고 snapshot은 복사본을 반환한다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  for (let i = 0; i < 250; i += 1) {
    diag.record({ event: 'turn_observed', detail: { count: i } })
  }

  const snapshot = diag.snapshot()
  assert.equal(snapshot.length, 200)
  assert.equal(snapshot[0].detail.count, 50)
  assert.equal(snapshot[199].detail.count, 249)

  snapshot[0].detail.count = -1
  snapshot.pop()
  assert.equal(diag.snapshot().length, 200)
  assert.equal(diag.snapshot()[0].detail.count, 50)
})

// ---------------------------------------------------------------------------
// level filter
// ---------------------------------------------------------------------------

test('level 필터: 기본 info는 debug를 무시한다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  diag.record({ event: 'turn_observed', level: 'debug' })
  diag.record({ event: 'turn_observed', level: 'info' })
  diag.record({ event: 'turn_observed', level: 'warn' })
  diag.record({ event: 'turn_observed', level: 'error' })
  diag.record({ event: 'turn_observed', level: 'nonsense' })

  assert.deepEqual(
    diag.snapshot().map((entry) => entry.level),
    ['info', 'warn', 'error', 'info'],
  )
})

test('setLevel은 임계값 이상만 통과시키고 허용값이 아니면 무시한다', () => {
  const diag = createDiagnostics({ now: fixedNow })
  diag.setLevel('warn')
  diag.record({ event: 'turn_observed', level: 'info' })
  diag.record({ event: 'turn_observed', level: 'warn' })
  diag.setLevel('bogus')
  diag.record({ event: 'turn_observed', level: 'info' })
  diag.setLevel('debug')
  diag.record({ event: 'turn_observed', level: 'debug' })

  assert.deepEqual(
    diag.snapshot().map((entry) => entry.level),
    ['warn', 'debug'],
  )
})

// ---------------------------------------------------------------------------
// 파일 기록 · 회전 · 권한
// ---------------------------------------------------------------------------

test('dir이 있으면 events.jsonl에 append한다', async () => {
  await withTmpDir(async (dir) => {
    const diag = createDiagnostics({ now: fixedNow, dir })
    diag.record({ event: 'bootstrap_started' })
    diag.record({ event: 'runtime_connected' })
    await diag.close()

    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).event, 'bootstrap_started')
    assert.equal(JSON.parse(lines[1]).event, 'runtime_connected')
  })
})

test('maxBytes를 넘으면 events.jsonl.1/.2로 회전한다', async () => {
  await withTmpDir(async (dir) => {
    // 한 줄이 약 81 byte이므로 maxBytes=90이면 매 기록마다 회전한다.
    const diag = createDiagnostics({ now: fixedNow, dir, maxBytes: 90, maxFiles: 3 })
    for (let i = 0; i < 10; i += 1) {
      diag.record({ event: 'epoch_armed', detail: { count: i } })
    }
    await diag.close()

    const names = (await readdir(dir)).sort()
    assert.deepEqual(names, ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2'])

    for (const name of names) {
      const content = (await readFile(join(dir, name), 'utf8')).trim()
      assert.notEqual(content, '')
      for (const line of content.split('\n')) {
        const entry = JSON.parse(line)
        assert.equal(entry.event, 'epoch_armed')
      }
    }
    // 가장 오래된 파일에는 최신 값만큼 오래된 count가 들어 있다.
    const oldest = JSON.parse((await readFile(join(dir, 'events.jsonl.2'), 'utf8')).trim())
    assert.equal(oldest.detail.count, 7)
  })
})

test('파일 권한은 0600(POSIX에서만 검사)', { skip: process.platform === 'win32' }, async () => {
  await withTmpDir(async (dir) => {
    const diag = createDiagnostics({ now: fixedNow, dir })
    diag.record({ event: 'shutdown' })
    await diag.close()
    const info = await stat(join(dir, 'events.jsonl'))
    assert.equal(info.mode & 0o777, 0o600)
  })
})

// ---------------------------------------------------------------------------
// fs 실패 fallback
// ---------------------------------------------------------------------------

test('주입 fs가 throw해도 record/snapshot은 계속 동작하고 dir 기록을 끈다', async () => {
  const fail = () => {
    throw new Error('injected fs failure')
  }
  const brokenFs = { mkdir: fail, stat: fail, appendFile: fail, rename: fail, rm: fail }
  const diag = createDiagnostics({ now: fixedNow, dir: '/nonexistent', fs: brokenFs })

  assert.doesNotThrow(() => {
    diag.record({ event: 'bootstrap_started' })
    diag.record({ event: 'shutdown' })
  })
  await diag.close()
  assert.equal(diag.snapshot().length, 2)
})

test('setDir로 새 디렉터리를 주면 fs 실패에서 회복해 다시 기록한다', async () => {
  await withTmpDir(async (dir) => {
    let failFirst = true
    const flakyFs = {
      mkdir: (...args) => {
        if (failFirst) {
          failFirst = false
          throw new Error('first write fails')
        }
        return realFs.mkdir(...args)
      },
      stat: (...args) => realFs.stat(...args),
      appendFile: (...args) => realFs.appendFile(...args),
      rename: (...args) => realFs.rename(...args),
      rm: (...args) => realFs.rm(...args),
      chmod: (...args) => realFs.chmod(...args),
    }
    const diag = createDiagnostics({ now: fixedNow, dir, fs: flakyFs })

    diag.record({ event: 'bootstrap_started' })
    await new Promise((resolve) => setImmediate(resolve))
    diag.setDir(dir)
    diag.record({ event: 'shutdown' })
    await diag.close()

    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).event, 'shutdown')
  })
})

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test('close는 대기 중인 쓰기를 flush하고 멱등이며 이후 record를 무시한다', async () => {
  await withTmpDir(async (dir) => {
    const diag = createDiagnostics({ now: fixedNow, dir })
    diag.record({ event: 'bootstrap_started' })

    await diag.close()
    await assert.doesNotReject(() => diag.close())

    diag.record({ event: 'shutdown' })
    assert.equal(diag.snapshot().length, 1)

    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).event, 'bootstrap_started')
  })
})
