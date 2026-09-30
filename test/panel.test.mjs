import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const panelPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../panel/index.html')

test('sidebar panel is a small self-contained srcdoc fragment', async () => {
  const [html, file] = await Promise.all([readFile(panelPath, 'utf8'), stat(panelPath)])
  assert.ok(file.size < 40 * 1024, `panel is ${file.size} bytes`)
  assert.match(html, /^<body>\s*<main\b/)
  assert.match(html, /<style>[\s\S]*<\/style>/)
  assert.match(html, /<script>[\s\S]*<\/script>/)

  for (const forbidden of [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b/i,
    /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i,
    /@import\b/i,
    /\bfetch\s*\(/i,
    /\bXMLHttpRequest\b/i,
    /\bWebSocket\b/i,
    /<a\s/i,
    /terminal\.sendText/i,
  ]) {
    assert.doesNotMatch(html, forbidden)
  }
})

test('all eight Orca commands and terminal alternatives are discoverable', async () => {
  const html = await readFile(panelPath, 'utf8')
  const titles = [
    'Open Dashboard',
    'Pause/Resume All',
    'Pause All',
    'Resume',
    'Toggle Current Worktree',
    'Turn On for Current Worktree',
    'Turn Off for Current Worktree',
    'Show Status',
  ]
  for (const title of titles) assert.ok(html.includes(`Cache Keepalive: ${title}`), title)
  for (const argument of ['status', 'on', 'off', 'here', 'here on', 'here off', 'here default', 'url']) {
    assert.ok(html.includes(`keepalive.mjs ${argument}</code>`), argument)
  }
  assert.ok(html.includes('%USERPROFILE%\\.orca-cache-keepalive\\keepalive.mjs status'))
})

test('keepalive toggle shortcuts are documented in the panel', async () => {
  const html = await readFile(panelPath, 'utf8')
  for (const shortcut of ['⌘⌥O', '⌘⌥P', '⌘⌥K', 'Ctrl+Alt+O', 'Ctrl+Alt+P', 'Ctrl+Alt+K']) {
    assert.ok(html.includes(shortcut), shortcut)
  }
  for (const removed of ['⌘⌥⇧J', 'Alt+Shift+J']) {
    assert.ok(!html.includes(removed), removed)
  }
  assert.ok(html.includes('사이드바 등 Orca 기본 화면'), '단축키 동작 범위 안내 문구가 있다')
  assert.ok(!html.includes('사이드바·대시보드 등'), '틀린 안내 문구가 없다')

  const kbdIds = [...html.matchAll(/<kbd id="([^"]+)"/g)].map((match) => match[1]).sort()
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  const script = scripts.join('\n')
  const referencedIds = [...script.matchAll(/getElementById\('([^']+-(?:primary|other))'\)/g)]
    .map((match) => match[1])
    .sort()
  assert.deepEqual(kbdIds, referencedIds)
})

test('panel explains all three tab symbols and title refresh behavior', async () => {
  const html = await readFile(panelPath, 'utf8')
  assert.match(html, /탭 이름에 캐시 상태 표시/)
  for (const label of ['⚡ 유지 중', '💤 유지 중인 캐시 없음', '⚠️ 확인 필요']) {
    assert.ok(html.includes(label), label)
  }
  assert.match(html, /같은 기호가 유지되면 제목을 다시 쓰지 않습니다/)
})

test('inline action script parses and fits Orca shell prelude', async () => {
  const html = await readFile(panelPath, 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new Function(scripts[0]))
  assert.match(scripts[0], /action:\s*'workspace\.readContext'/)
  assert.match(scripts[0], /event\.source\s*!==\s*window\.parent/)
  assert.match(scripts[0], /setTimeout\([\s\S]*5000\)/)

  const shell = '<!doctype html><html class="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'"><style>:root{--background:#15181c}</style></head>'
  const combined = shell + html + '</html>'
  assert.match(combined, /<\/head><body>/)
  assert.match(combined, /<\/body>\s*<\/html>$/)
})
