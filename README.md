# Cache Keepalive (Orca community plugin)

Cache Keepalive sends a short keepalive message to **idle Claude terminals** in
[Orca](https://github.com/stablyai/orca) shortly before the prompt cache TTL is
expected to expire, so the cached prefix stays warm. It also provides per-worktree
and per-terminal toggles, a global pause, and a small authenticated dashboard.

This is a **community, experimental** plugin. It is not an official Stably plugin.

- Plugin id: `cache-keepalive`
- Publisher slug: `runaticmoon` (plugin identity `runaticmoon.cache-keepalive`)
- License: MIT (see [LICENSE](LICENSE))
- Repository: https://github.com/RunaticMoon/orca-keepalive-plugin
- Version: `0.1.0`
- Minimum Orca engine declared: `>=1.4.214`
- Plugin API: `pluginApi 1` (`contributes` is strict)
- Runtime: Node >=22.5 (development has been done on Node 24); no build step, no npm dependencies

---

## What it does

The Orca setting **Settings > Agents > Prompt Cache Timer** only controls a timer
inside Orca's renderer. This plugin does not start that timer and cannot read its
exact start time. Instead it watches agent status events, and after it observes a
turn complete it schedules one keepalive message per cache epoch.

When all send conditions are met it sends two RPC requests to Orca's local runtime
socket:

1. a guarded bracketed-paste of the configured message, then
2. a guarded Enter keystroke.

### Conditions required before a send

A keepalive is only considered when **all** of these are true at inspection time:

- Orca's own prompt cache timer is **on** (read from the active profile; see risks below).
- The terminal's agent identity is `claude` (`agentIdentity === 'claude'`).
- The execution host is local (`executionHostId === 'local'`).
- The terminal is connected to a live PTY.
- The agent has actually been observed finishing a turn in this plugin's lifetime
  (a fresh `working` then `done`); a terminal that is already idle at plugin start
  is *not* scheduled — it waits for the next completed turn.
- The combined agent state is `done` and the optional `mainAgent` is `done` or absent.
- `terminal.agentStatus` reports idle and running, and `terminal.show.agentWait`
  is present and `null` (no permission/wait prompt is being judged).
- The terminal screen has **no non-empty draft**, and output has been quiet for at
  least `quietOutputMs` (default 2500 ms). A change in an observed draft starts an
  input quiet window (`observedInputQuietMs`, default 30000 ms).
- No global pause, the worktree/terminal scope is enabled, `~/.claude/cwarm.disabled`
  is absent (when `respectCwarmDisabled` is on), and the consecutive keepalive cap
  has not been reached.

If any signal is unknown, the plugin refuses to send rather than guessing.

### Send timing

Timing is based on the observed completion time (`doneAt`) and the TTL reported by
Orca's timer setting. Only two TTL values are accepted: 5 minutes and 1 hour.

| App TTL | Default margin | Target send time |
|---|---|---|
| `300000` ms (5 min) | `margin5mMs` = 60 s | `doneAt + TTL - 60 s` (≈ 4 minutes after completion) |
| `3600000` ms (1 h) | `margin1hMs` = 120 s | `doneAt + TTL - 120 s` (≈ 58 minutes after completion) |

- **At most one keepalive mutation per cache epoch.** A keepalive that is submitted
  starts a new working→done cycle, which opens a *new* epoch, so at most roughly one
  message per 4 minutes / 58 minutes.
- **Catch-up is never done.** Once the expected expiry passes (with a minimum of
  10 s remaining), the epoch is dropped; there is no "late" burst after sleep or a
  clock jump.

### Consecutive cap and reset

- `maxConsecutiveKeepalives` defaults to **3**. `0` means unlimited.
- The cap counts keepalives that were themselves submitted by the plugin. When a
  fresh `working` turn appears that is **not** explained by the plugin's own recent
  attempt, the budget for that target is automatically reset to 0. In practice: if
  you do real work in the terminal, the counter starts over.
- The dashboard's **reset budget** action also resets the counter without waiting.
- The counter is not persisted across long idle periods as a scheduled time; on
  restart, unfinished attempts are surfaced as "needs review" instead of being
  retried.

### `cwarm.disabled`

When `respectCwarmDisabled` is on (default), the presence of
`~/.claude/cwarm.disabled` blocks all sends. This is compatible with the concept of
the reference tool [claude-cache-keepalive](https://github.com/fifthadj/claude-cache-keepalive);
the file is only read, never written.

---

## Installation

There is no build or install command. The repository root *is* the plugin
(`orca-plugin.json`, `main.mjs`, `src/`, `ui/`). This community plugin is not listed
in any marketplace; install it directly from Git or from a local folder.

### From the Git URL

1. In Orca open **Settings > Plugins** and click **Install plugin**.
2. Choose the **Git URL** tab and enter the repository URL with a `#ref`:

   ```text
   https://github.com/RunaticMoon/orca-keepalive-plugin#main
   ```

   The dialog requires some `#ref`. It can be a branch (`#main`, follows the latest
   code), a tag (e.g. `#v0.1.0`, a fixed release), or a full commit SHA. Orca copies
   the plugin and shows the requested permissions for review.
3. Approve the permissions, then run **Cache Keepalive: Open Dashboard** from the
   command palette.

Updating: Orca does not auto-update plugins installed from a Git URL. To update,
run **Install plugin** again with the same URL (`#main` picks up the newest commit)
or with a newer tag. Orca replaces the installed copy in place, keeps the plugin's
stored settings, and keeps the previous copy for rollback. You can also use the
**Local folder** tab with a local clone.

### Development path

1. In Orca open **Settings > Plugins** and expand the **Development** section.
2. In **Development plugin folder path**, enter the absolute path to this repository
   and click **Add path**.
3. Approve the requested permissions when Orca asks. Development plugins still go
   through permission (capability) review.
4. Run **Cache Keepalive: Open Dashboard** from the command palette.

Notes:

- Only files loaded when Orca actually starts the plugin worker cause side effects;
  importing `main.mjs` starts nothing. Commands and event handlers are registered
  synchronously, and startup work runs in the background.
- If you change `main.mjs` and the plugin does not pick it up, bump `version` in
  `orca-plugin.json` or disable/enable the plugin to force a fresh worker. (Orca may
  keep an existing worker running after an in-place edit.)

### Required capabilities

`orca-plugin.json` requests five capabilities:

| Capability | Why it is needed |
|---|---|
| `workspace:read` | Read the plugin workspace context (terminal handles) so commands and the dashboard can resolve the current worktree. The plugin never guesses focus from a title. |
| `terminal:send` | Declares intent to send terminal text/Enter. Without it the internal RPC sender is not started; command registration and diagnostics still work. |
| `notifications:show` | Feedback for toggle/pause/resume/status commands, and the dashboard URL fallback when Orca's built-in browser cannot be opened. |
| `storage` | Persist plugin state under a single host-storage key (`state-v1`). Orca's own settings are never written. |
| `events:subscribe` | Subscribe to `agent.status.changed` and `worktree.removed`. |

`terminal:send` is a declaration, not a sandbox: the plugin's direct filesystem/socket
access is not mediated by it. See [Limits and risks](#limits-and-risks).

### Commands and keybinding

Open the command palette with **⌘J** on macOS or **Ctrl+Shift+J** on
Linux/Windows, then type `Cache Keepalive`. The manifest contributes eight
commands:

| Command id | Title | Context |
|---|---|---|
| `keepalive-open` | Cache Keepalive: Open Dashboard | global |
| `keepalive-toggle-pause` | Cache Keepalive: Toggle On/Off (All) | global |
| `keepalive-pause` | Cache Keepalive: Pause All | global |
| `keepalive-resume` | Cache Keepalive: Resume | global |
| `keepalive-toggle-worktree` | Cache Keepalive: Toggle Current Worktree | worktree |
| `keepalive-worktree-on` | Cache Keepalive: Turn On for Current Worktree | worktree |
| `keepalive-worktree-off` | Cache Keepalive: Turn Off for Current Worktree | worktree |
| `keepalive-status` | Cache Keepalive: Show Status | global |

Keybinding declared in the manifest:

- **Mod+Alt+Shift+J** → `keepalive-open` (opens the dashboard).

The three `context: worktree` commands are inactive while no worktree is active.
They only change the current worktree when the plugin workspace context resolves
to exactly one worktree; otherwise they tell you to use the dashboard. Plugins do
not intercept the app's own Cmd/Ctrl-J command UI.

**Cache Keepalive: Show Status** posts a one-line notification that starts with
`켜짐` (on) or `꺼짐(일시정지)` (off/paused) and includes `워크트리 N개`, plus the
app-timer/connection state and per-target active/scheduled/needs-review counts.

## Where to find the controls

| Surface | How to open | What it is for |
|---|---|---|
| Sidebar panel | Orca right sidebar activity bar → **zap** icon (panel `keepalive-panel`, entry `panel/index.html`) | Read-only orientation: current worktree name and terminal count, plus the command and terminal-command cheat sheets. See [Sidebar panel](#sidebar-panel) for why it cannot show live state. |
| Command palette | **⌘J** (macOS) / **Ctrl+Shift+J** (Linux/Windows), then type `Cache Keepalive` | All eight commands above: open dashboard, toggle/pause/resume, per-worktree on/off, show status. |
| Dashboard | **Cache Keepalive: Open Dashboard** (or **Mod+Alt+Shift+J**) | Worktree/terminal toggles, global pause, reset budget, clear "needs review", settings form. |
| Terminal CLI | `node ~/.orca-cache-keepalive/keepalive.mjs <command>` | Scriptable status and toggles from any Orca terminal, including per-worktree `here`. |
| Settings switch | **Settings > Plugins > Cache Keepalive** | Turn the whole plugin (worker) on/off. |

The only place that changes plugin-wide state is one of the in-plugin controls
(palette, dashboard, CLI). The Settings switch disables the plugin itself, and
the Orca app timer under **Settings > Agents > Prompt Cache Timer** is a separate
Orca setting the plugin only reads.

### Sidebar panel

The `keepalive-panel` panel is a **sandboxed iframe**. In Orca 1.4.214 the only
host APIs a panel can call are `workspace.readContext`, `terminal.sendText`, and
`notifications.show`; panel storage reads/writes, command execution, worker
messaging, network access (`connect-src 'none'`), and navigation are all blocked.
Because live keepalive state and toggles would need those blocked APIs, the panel
**cannot show or change keepalive state**. It deliberately does not call
`terminal.sendText` either.

What the panel actually does: the **새로고침 (Refresh)** button reads the current
worktree through `workspace.readContext` and shows its display name/branch and
terminal count (permission, rate-limit, timeout and unavailable errors each get a
plain-language message). It lists the palette commands and terminal commands with
copy buttons that fall back to selecting the text when the clipboard API is not
available. Live status and toggles live in the dashboard, palette commands, and
terminal CLI instead.

### Terminal CLI

When the plugin is active, the worker starts the dashboard server and writes a
control file so a plain `node` CLI can reach it. The CLI itself is copied to a
stable path:

- Control directory: `~/.orca-cache-keepalive/` — created `0700`.
- Control file: `~/.orca-cache-keepalive/control.json` — written `0600`, and
  removed on shutdown. It contains the worker `pid`, the `127.0.0.1` port, and the
  bearer token.
- CLI copy: `~/.orca-cache-keepalive/keepalive.mjs` (`0700`).

The CLI talks to the loopback dashboard API using the control file's port/token.
`here` hashes `ORCA_WORKTREE_ID` the same way the snapshot does (sha256, first 16
hex) to find the current worktree, and the dashboard API exposes that value as a
per-worktree `worktreeHash` plus a `worktree-orca` action for setting a worktree
by raw Orca id. Commands (`node bin/keepalive.mjs help` in a clone shows the same
text):

| Command | What it does |
|---|---|
| `status [--json]` | Show the current state (this is also the default with no arguments). `--json` prints a machine-readable summary. |
| `on` / `off` | Turn all keepalive on / pause it (global pause). |
| `here [on\|off\|default]` | Show or set the worktree of the Orca terminal you are running in. Uses `ORCA_WORKTREE_ID`, so it must run inside an Orca terminal. |
| `worktree <number\|label> <on\|off\|default>` | Set a specific worktree by its 1-based `status` number or exact label. |
| `url` | Print the dashboard URL, **including the token**, and warn not to share it. |
| `help` | Print usage. |

Exit codes: `0` success, `1` error, `2` usage error (or `here` run outside an
Orca terminal, when the plugin is running), `3` the plugin is not running (stale
or missing control file).

```sh
node ~/.orca-cache-keepalive/keepalive.mjs status
node ~/.orca-cache-keepalive/keepalive.mjs here off
# optional shell alias:
alias keepalive='node ~/.orca-cache-keepalive/keepalive.mjs'
```

On Windows use the profile path:

```powershell
node %USERPROFILE%\.orca-cache-keepalive\keepalive.mjs status
```

---

## Dashboard

**Cache Keepalive: Open Dashboard** asks Orca to open the already-running loopback
HTTP server in Orca's built-in browser (`browser.tabCreate`, `placement: server`).
The server itself starts during plugin activation (see [Terminal CLI](#terminal-cli)).
If the browser cannot be opened, the command shows the URL in a notification so you
can open it manually. While the server is starting, the command waits up to 5 seconds.

Server properties:

- Listens on **`127.0.0.1` only**, with an ephemeral port and a fresh 256-bit random
  token on each process start.
- The token travels in the URL **fragment** (`http://127.0.0.1:<port>/#token=...`).
  The page moves it into `sessionStorage` and erases the fragment. Every API request
  must send it as `Authorization: Bearer <token>`.
- Host/Origin are validated, plus a strict Content-Security-Policy. There is no
  arbitrary file or RPC proxy endpoint.

What you can do in the dashboard:

- **Worktree toggle:** on / off / (default). The button label distinguishes an explicit
  setting from an inherited default.
- **기본값으로 (revert to default):** removes an explicit worktree override.
- **Terminal toggle:** on / off / inherit (per terminal).
- **Global pause / resume.**
- **Reset budget ("횟수 초기화"):** zeroes the consecutive counter for one target.
- **Clear "needs review":** acknowledges an uncertain send after you have checked the
  terminal input line. It does not delete text or press Enter again.
- **Settings form** (see below). Changes apply only after you press **저장 (Save)**.

The top of the page shows the app timer state, runtime connection state and global
pause state. The first screen also notes: *"메시지는 사용량을 소비하고 대화 기록에
남습니다. 입력 감지는 제한적입니다."* (messages consume usage and remain in the
conversation; input detection is limited).

### Settings fields

These are the `DEFAULT_CONFIG` fields. The dashboard form edits a subset of them
(marked below); the rest are stored defaults / internal policy.

| Field | Default | Meaning |
|---|---|---|
| `schemaVersion` | `1` | State schema version; only `1` is accepted. |
| `runtimeUserDataPath` | `null` | Optional explicit Orca user-data directory. Editable in the form. `null` means auto-detect. |
| `paused` | `false` | Plugin-global pause. Controlled by the pause button, not a text field. |
| `defaultWorktreeEnabled` | `true` | Default state for worktrees without an explicit override. Editable in the form. |
| `message` | `Cache keepalive. Reply only OK; do not use tools or continue previous work.` | Single-line message, 1–512 UTF-8 bytes, no control characters/newlines. Editable in the form. |
| `margin5mMs` | `60000` | Margin before expiry for a 5-minute TTL (30000–120000 ms). Form edits it in **seconds**. |
| `margin1hMs` | `120000` | Margin before expiry for a 1-hour TTL (60000–600000 ms). Form edits it in **seconds**. |
| `quietOutputMs` | `2500` | Required output-quiet time before sending (2500–60000 ms). Editable in the form. |
| `observedInputQuietMs` | `30000` | Wait after an observed draft change before sending (10000–300000 ms). Not in the form. |
| `maxConsecutiveKeepalives` | `3` | Consecutive keepalive cap; `0` = unlimited (0–1000). Editable in the form. |
| `respectCwarmDisabled` | `true` | Honor `~/.claude/cwarm.disabled`. Editable in the form. |
| `logLevel` | `info` | Diagnostic level. Not in the form. |

Time and counter fields are validated on the server; a rejected value is not applied.

---

## Limits and risks

Read this section before enabling the plugin.

- **It depends on Orca internals, not a public plugin API.** To do its job the plugin
  reads Orca's internal runtime RPC socket metadata (`orca-runtime.json`) and the
  active profile's SQLite state (`profile-state.db`), **read-only**. These are not
  part of the public plugin API and may change in any Orca update. The declared
  `engines: ">=1.4.214"` is only a minimum gate; it does not guarantee that future
  internal shapes keep working. If a required shape is missing, the plugin stops
  sending instead of falling back.
- **Every keepalive is a real user message.** It consumes model tokens/usage and
  stays in the conversation transcript. There is no "free" keepalive.
- **Draft detection is best-effort.** "Draft" is inferred from the terminal screen
  emulator, not from input events. There is an unavoidable race between the final
  draft check and pressing Enter. If a user types in that window, the message can
  merge with their input. The plugin never sends Esc/Ctrl-U/Ctrl-C and never restores
  a draft for you.
- **Unknown means "do not send".** Missing agent identity, unknown wait state,
  unreadable screen, or a truncated terminal list all result in refusal, not a
  best-guess send. This favors protecting your input over maximizing cache warmth.
- **No real Orca E2E has been run here.** The automated suite runs against a fake
  Orca runtime; it does not prove the plugin works against a real Orca desktop. See
  [docs/TESTING.md](docs/TESTING.md) for the status and a manual checklist.
- **App-setting changes are not instantaneous.** Orca debounces settings writes
  (about 1–5 s plus queueing), so turning the app timer off may not be observed by the
  plugin immediately. Use the plugin's **global pause** for immediate stop. Bytes that
  already reached Orca cannot be recalled.
- **The dashboard token is stored in a plain file in your home directory.** For
  the terminal CLI to work, the worker writes the bearer token to
  `~/.orca-cache-keepalive/control.json` with mode `0600` (directory `0700`).
  Any other process running as the same OS user can therefore read the token and
  call the dashboard API — the same trust boundary as Orca's own runtime metadata.
  On Windows POSIX modes do not apply, so protection relies on the user profile's
  ACL. Treat the `url` output and the control file like a credential.
- **The dashboard server listens whenever the plugin is active.** The loopback
  server starts as part of plugin activation and stays up on `127.0.0.1` until the
  plugin is disabled or the worker stops; it is not tied to the Open Dashboard
  command. Pausing keepalive stops sends but does not stop the server.
- **No cache-hit proof.** The plugin reports "message sent / turn started observed";
  it does not verify that Anthropic's cache actually hit or that any billing was saved.
- **The plugin API is experimental.** This plugin targets `pluginApi 1`, which may
  change.

If you need atomic input protection (host-owned keepalive with an input revision),
that is not achievable with the current Orca API. See DESIGN.md §12 for the proposed
upstream contract. The current implementation is offered as an experimental release.

---

## Repository layout

```text
orca-plugin.json     manifest
main.mjs             plugin entry (activate / deactivate glue)
package.json         npm test only (no dependencies)
src/                 policy, scheduler, RPC, settings, state, HTTP server, commands
ui/                  dashboard (no imports, no CDN, no framework)
panel/               sidebar panel (sandboxed iframe, entry panel/index.html)
bin/keepalive.mjs    terminal CLI (copied to ~/.orca-cache-keepalive/)
test/                node:test unit + integration (fake Orca runtime)
scripts/demo.mjs     runnable local demo
docs/DESIGN.md       full design
docs/TESTING.md      how to test
docs/PUBLISHING.md   how to release and install from Git
```

No `dependencies`/`devDependencies`; the test runner is `node --test` (Node >=22.5).

---

## 한국어 요약

- **무엇:** Orca에서 Claude 터미널이 턴을 마친 뒤, 프롬프트 캐시 TTL 만료 직전에
  짧은 keepalive 메시지를 보내 캐시를 유지하는 커뮤니티 실험 플러그인입니다.
- **조건:** Orca의 "설정 > 에이전트 > 프롬프트 캐시 타이머"가 켜져 있어야 하며,
  대상이 `claude` 에이전트·로컬 호스트·연결된 PTY이고, 초안 없음·출력 조용·
  권한/대기 아님일 때만 보냅니다. 판정 불가는 전송하지 않습니다.
- **타이밍:** 완료 관측 시각 기준 5분 TTL은 `완료+TTL-60초`, 1시간 TTL은
  `완료+TTL-120초`. 캐시 epoch당 최대 1회만 보내고, 마감이 지나면 따라잡지 않습니다.
- **상한:** 연속 keepalive 기본 3회(0=무제한). 자체 전송이 아닌 새 working 턴이
  관측되면 카운터가 자동 초기화됩니다. `~/.claude/cwarm.disabled`를 존중합니다.
- **설치:** 마켓플레이스에는 등록하지 않는 커뮤니티 플러그인입니다. Orca 설정 >
  Plugins > "Install plugin" > "Git URL" 탭에
  `https://github.com/RunaticMoon/orca-keepalive-plugin#main`을 넣어 설치합니다.
  `#ref`는 필수이며 브랜치(`#main`, 최신 코드)·태그(`#v0.1.0`, 고정)·커밋 모두
  됩니다. 자동 업데이트는 없고 같은 URL로 다시 설치하면 최신 커밋으로 교체되며
  설정은 유지됩니다. 개발 중에는 Plugins > Development에서 폴더 절대 경로를 넣고
  "Add path". 어느 방식이든 권한 검토가 필요하며 빌드/설치 명령은 없습니다.
- **권한 5개:** workspace:read, terminal:send, notifications:show, storage,
  events:subscribe.
- **명령 8개 + 단축키:** 팔레트는 ⌘J(macOS)/Ctrl+Shift+J(Linux/Windows)로 열고
  "Cache Keepalive" 입력. keepalive-open(Mod+Alt+Shift+J), keepalive-toggle-pause,
  keepalive-pause, keepalive-resume, keepalive-toggle-worktree, keepalive-worktree-on,
  keepalive-worktree-off, keepalive-status. worktree 명령은 활성 워크트리가 없으면
  비활성입니다.
- **UI 진입점:** 오른쪽 사이드바 activity bar의 번개(zap) 아이콘 패널(읽기 전용),
  명령 팔레트, 대시보드, 터미널 CLI, Settings > Plugins의 플러그인 on/off 스위치.
- **사이드바 패널:** sandboxed iframe이라 Orca 1.4.214에서 호출 가능한 host API가
  `workspace.readContext`·`terminal.sendText`·`notifications.show`뿐이고 storage·
  명령 실행·worker 메시지·네트워크·navigation이 막혀 있어 **실시간 상태·토글은 표시할
  수 없습니다**. 현재 워크트리 이름/터미널 수와 명령·터미널 명령 안내만 보여줍니다.
- **터미널 CLI:** 플러그인이 켜지면 worker가 대시보드 서버를 시작하고
  `~/.orca-cache-keepalive/control.json`(디렉터리 0700·파일 0600, pid·127.0.0.1 포트·
  토큰)을 쓰며 CLI를 `~/.orca-cache-keepalive/keepalive.mjs`로 복사합니다. 종료 시
  제어 파일을 삭제합니다. 명령: `status [--json]`, `on`, `off`,
  `here [on|off|default]`(Orca 터미널 안에서만), `worktree <번호|label> <on|off|default>`,
  `url`, `help`. 종료 코드 0/1/2/3(3=플러그인 미실행).
  예: `node ~/.orca-cache-keepalive/keepalive.mjs status`.
- **대시보드:** Orca 내장 브라우저로 열리며 127.0.0.1 루프백 + URL fragment 토큰으로
  인증합니다. 워크트리/터미널 on/off/기본값, 전역 일시정지/재개, 예산 초기화,
  "확인 필요" 해제, 설정 편집(저장 버튼)을 제공합니다. 서버는 Open Dashboard와
  무관하게 플러그인 활성화 동안 계속 127.0.0.1에서 대기합니다.
- **한계(정직하게):** 공개 플러그인 API만으로는 불가능해 Orca 내부 런타임 RPC
  소켓과 프로필 SQLite를 읽기 전용으로 사용하므로 Orca 업데이트로 깨질 수 있습니다.
  대시보드 토큰은 사용자 홈의 0600 파일에 저장되므로 같은 OS 사용자로 실행되는
  프로세스는 API를 호출할 수 있습니다(Windows는 POSIX 모드가 없어 프로필 ACL에
  의존). keepalive 한 번은 실제 메시지로 토큰/사용량을 소모하고 대화에 남습니다. 초안
  검출은 화면 기반 추정이라 마지막 검사와 Enter 사이 경쟁이 남습니다. 실제 Orca
  E2E는 아직 미검증이며 pluginApi 1은 실험적입니다.
