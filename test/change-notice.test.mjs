/**
 * 🔧[OKPN-EB52] N : 대시보드·CLI 변경 알림 문구 단위 테스트.
 *
 * `describeActionChange`는 순수 함수다: dispatch가 돌려준 스냅숏과 Action만으로
 * 문구를 만들고 I/O를 하지 않는다. 여기서는 원시 worktreeId가 결과에 새지 않는지와
 * 전역 일시정지/200자 자르기 경계를 함께 확인한다.
 *
 * Run: `node --test test/change-notice.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { describeActionChange } from '../src/change-notice.mjs'

const RAW_WORKTREE_ID = 'raw-secret-worktree-id'
const WORKTREE_HASH = createHash('sha256')
  .update(RAW_WORKTREE_ID, 'utf8')
  .digest('hex')
  .slice(0, 16)

/**
 * 계약(contracts.mjs DashboardSnapshot) 모양의 스냅숏.
 * @param {object} [over]
 */
function snapshot(over = {}) {
  return {
    revision: 3,
    serverNow: 0,
    profileSettings: { known: true, source: 'index', readAt: 0 },
    connection: { state: 'connected' },
    config: { paused: false },
    worktrees: [
      {
        id: 'wt-1',
        worktreeHash: WORKTREE_HASH,
        label: 'main',
        enabled: null,
        effectiveEnabled: true,
        terminals: [
          { id: 'tm-1', title: 'claude #1', enabledOverride: null, effectiveEnabled: true },
          { id: 'tm-2', title: 'claude #2', enabledOverride: false, effectiveEnabled: false },
        ],
      },
    ],
    diagnostics: [],
    ...over,
  }
}

const rev = 3

test('pause는 켜짐/꺼짐 문구를 만든다', () => {
  assert.equal(
    describeActionChange({ type: 'pause', paused: true, expectedRevision: rev }, snapshot()),
    '모든 keepalive를 껐습니다(일시정지).',
  )
  assert.equal(
    describeActionChange({ type: 'pause', paused: false, expectedRevision: rev }, snapshot()),
    '모든 keepalive를 켰습니다.',
  )
})

test('pause가 boolean이 아니면 null', () => {
  assert.equal(describeActionChange({ type: 'pause', expectedRevision: rev }, snapshot()), null)
})

test('worktree는 targetId로 label을 찾아 켜짐/꺼짐/기본값 문구를 만든다', () => {
  const snap = snapshot()
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: true, expectedRevision: rev }, snap),
    'main: keepalive 켜짐',
  )
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: false, expectedRevision: rev }, snap),
    'main: keepalive 꺼짐',
  )
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: null, expectedRevision: rev }, snap),
    'main: 기본값 사용 (현재 켜짐)',
  )
})

test('worktree 기본값 문구는 effectiveEnabled를 따른다', () => {
  const snap = snapshot({
    worktrees: [
      {
        id: 'wt-1',
        worktreeHash: WORKTREE_HASH,
        label: 'main',
        enabled: null,
        effectiveEnabled: false,
        terminals: [],
      },
    ],
  })
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: null, expectedRevision: rev }, snap),
    'main: 기본값 사용 (현재 꺼짐)',
  )
})

test('worktree label을 못 찾으면 워크트리로 대체한다', () => {
  assert.equal(
    describeActionChange(
      { type: 'worktree', targetId: 'unknown-id', enabled: true, expectedRevision: rev },
      snapshot(),
    ),
    '워크트리: keepalive 켜짐',
  )
})

test('worktree-orca는 원시 id를 해시로 매칭한다', () => {
  const snap = snapshot()
  assert.equal(
    describeActionChange({ type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: true, expectedRevision: rev }, snap),
    'main: keepalive 켜짐',
  )
  assert.equal(
    describeActionChange({ type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: false, expectedRevision: rev }, snap),
    'main: keepalive 꺼짐',
  )
  assert.equal(
    describeActionChange({ type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: null, expectedRevision: rev }, snap),
    'main: 기본값 사용 (현재 켜짐)',
  )
})

test('worktree-orca는 매칭 실패 시 워크트리로 대체하고 원시 id를 노출하지 않는다', () => {
  const body = describeActionChange(
    { type: 'worktree-orca', worktreeId: 'not-in-snapshot', enabled: true, expectedRevision: rev },
    snapshot(),
  )
  assert.equal(body, '워크트리: keepalive 켜짐')
  assert.ok(!body.includes('not-in-snapshot'), '원시 worktreeId가 문구에 남으면 안 된다')
})

test('terminal은 워크트리 label / 터미널 title 문구를 만든다', () => {
  const snap = snapshot()
  assert.equal(
    describeActionChange({ type: 'terminal', targetId: 'tm-1', enabled: true, expectedRevision: rev }, snap),
    'main / claude #1: keepalive 켜짐',
  )
  assert.equal(
    describeActionChange({ type: 'terminal', targetId: 'tm-1', enabled: false, expectedRevision: rev }, snap),
    'main / claude #1: keepalive 꺼짐',
  )
  assert.equal(
    describeActionChange({ type: 'terminal', targetId: 'tm-2', enabled: null, expectedRevision: rev }, snap),
    'main / claude #2: 상속(현재 꺼짐)',
  )
})

test('terminal을 못 찾으면 워크트리 / 터미널로 대체한다', () => {
  assert.equal(
    describeActionChange(
      { type: 'terminal', targetId: 'unknown-id', enabled: true, expectedRevision: rev },
      snapshot(),
    ),
    '워크트리 / 터미널: keepalive 켜짐',
  )
})

test('전역 일시정지 중 켜면 전체 일시정지 중 꼬리말을 붙인다', () => {
  const paused = snapshot({ config: { paused: true } })
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: true, expectedRevision: rev }, paused),
    'main: keepalive 켜짐 (전체 일시정지 중)',
  )
  assert.equal(
    describeActionChange({ type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: true, expectedRevision: rev }, paused),
    'main: keepalive 켜짐 (전체 일시정지 중)',
  )
  assert.equal(
    describeActionChange({ type: 'terminal', targetId: 'tm-1', enabled: true, expectedRevision: rev }, paused),
    'main / claude #1: keepalive 켜짐 (전체 일시정지 중)',
  )
})

test('전역 일시정지 중이라도 끄면 꼬리말을 붙이지 않는다', () => {
  const paused = snapshot({ config: { paused: true } })
  assert.equal(
    describeActionChange({ type: 'worktree', targetId: 'wt-1', enabled: false, expectedRevision: rev }, paused),
    'main: keepalive 꺼짐',
  )
})

test('config·reset-budget·clear-review·알 수 없는 type은 null', () => {
  const snap = snapshot()
  assert.equal(describeActionChange({ type: 'config', patch: { paused: true }, expectedRevision: rev }, snap), null)
  assert.equal(describeActionChange({ type: 'reset-budget', targetId: 'tm-1', expectedRevision: rev }, snap), null)
  assert.equal(describeActionChange({ type: 'clear-review', targetId: 'tm-1', expectedRevision: rev }, snap), null)
  assert.equal(describeActionChange({ type: 'nope', expectedRevision: rev }, snap), null)
})

test('알 수 없는 action 모양은 null', () => {
  assert.equal(describeActionChange(null, snapshot()), null)
  assert.equal(describeActionChange(undefined, snapshot()), null)
  assert.equal(describeActionChange('pause', snapshot()), null)
})

test('200자를 넘는 label은 잘라내고 원시 id를 남기지 않는다', () => {
  const longLabel = 'L'.repeat(500)
  const snap = snapshot({
    worktrees: [
      {
        id: 'wt-1',
        worktreeHash: WORKTREE_HASH,
        label: longLabel,
        enabled: null,
        effectiveEnabled: true,
        terminals: [],
      },
    ],
  })
  const body = describeActionChange(
    { type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: true, expectedRevision: rev },
    snap,
  )
  assert.ok(body.length <= 200, `200자 이하여야 한다: ${body.length}`)
  assert.ok(!body.includes(RAW_WORKTREE_ID), '원시 worktreeId가 남으면 안 된다')
})

test('200자를 넘어도 일시정지 꼬리말은 보존한다', () => {
  const longLabel = 'L'.repeat(500)
  const snap = snapshot({
    config: { paused: true },
    worktrees: [
      {
        id: 'wt-1',
        worktreeHash: WORKTREE_HASH,
        label: longLabel,
        enabled: null,
        effectiveEnabled: false,
        terminals: [],
      },
    ],
  })
  const body = describeActionChange(
    { type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled: true, expectedRevision: rev },
    snap,
  )
  assert.ok(body.length <= 200, `200자 이하여야 한다: ${body.length}`)
  assert.ok(body.endsWith(' (전체 일시정지 중)'), `꼬리말 보존: ${body.slice(-30)}`)
})

test('원시 worktreeId는 어떤 워크트리 문구에도 포함되지 않는다', () => {
  const snap = snapshot()
  for (const enabled of [true, false, null]) {
    const body = describeActionChange(
      { type: 'worktree-orca', worktreeId: RAW_WORKTREE_ID, enabled, expectedRevision: rev },
      snap,
    )
    assert.ok(!body.includes(RAW_WORKTREE_ID), `원시 id 노출: ${body}`)
  }
})
