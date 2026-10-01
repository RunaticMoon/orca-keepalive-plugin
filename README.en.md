# Cache Keepalive (Orca community plugin)

[한국어](README.md) | **English**

Cache Keepalive sends a short keepalive message to **idle Claude terminals** in
[Orca](https://github.com/stablyai/orca) shortly before the prompt cache TTL is
expected to expire, so the cached prefix stays warm. It also provides per-worktree
and per-terminal toggles, a global pause, and a small authenticated dashboard.

This is a **community, experimental** plugin. It is not an official Stably plugin.

- Plugin id: `cache-keepalive`
- Publisher slug: `runaticmoon` (plugin identity `runaticmoon.cache-keepalive`)
- License: MIT (see [LICENSE](LICENSE))
- Repository: https://github.com/RunaticMoon/orca-keepalive-plugin
- Version: `0.1.10`
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
- The agent has actually been observed finishing a turn (a fresh `working` then
  `done`). A terminal that is already idle when the plugin starts is *not* scheduled
  and waits for the next completed turn — unless the plugin itself had scheduled a
  keepalive for that same terminal before a reload, which it restores. See
  [Surviving a plugin reload](#surviving-a-plugin-reload).
- The combined agent state is `done` and the optional `mainAgent` is `done` or absent.
- `terminal.agentStatus` reports idle and running, and `terminal.show.agentWait`
  is present and `null` (no permission/wait prompt is being judged).
- The terminal screen has **no non-empty draft**, and output has been quiet for at
  least `quietOutputMs` (default 2500 ms). A change in an observed draft starts an
  input quiet window (`observedInputQuietMs`, default 30000 ms).
- No global pause, the worktree/terminal scope is enabled, `~/.claude/cwarm.disabled`
  is absent (when `respectCwarmDisabled` is on), and the consecutive keepalive cap
  for the TTL currently reported by Orca's timer has not been reached (see
  [Consecutive cap and reset](#consecutive-cap-and-reset)).

If any signal is unknown, the plugin refuses to send rather than guessing.

### Send timing

Timing is based on the **cache basis time** (`basisAt`) and the TTL reported by
Orca's timer setting. Anthropic starts the prompt-cache TTL when the request that
reads or writes the cache begins, and the response generation time is spent inside
that TTL. Claude Code sends one API request per tool call, so the plugin uses the
turn's last observed `state: 'working'` event (`basisAt`, ≈ the start of the last
API request). If there is no such observation, or it is more than 3 minutes earlier
than the completion event, the observed completion time (`doneAt`) is used instead.
Only two TTL values are accepted: 5 minutes and 1 hour.

| App TTL | Default margin | Target send time |
|---|---|---|
| `300000` ms (5 min) | `margin5mMs` = 60 s | `basisAt + TTL - 60 s` (≈ 4 minutes after the last request start) |
| `3600000` ms (1 h) | `margin1hMs` = 120 s | `basisAt + TTL - 120 s` (≈ 58 minutes after the last request start) |

- **At most one keepalive mutation per cache epoch.** A keepalive that is submitted
  starts a new working→done cycle, which opens a *new* epoch, so at most roughly one
  message per 4 minutes / 58 minutes.
- **Catch-up is never done.** Once the expected expiry passes (with a minimum of
  10 s remaining), the epoch is dropped; there is no "late" burst after sleep or a
  clock jump.

### Surviving a plugin reload

Disabling and re-enabling the plugin (or any other worker reload) clears the in-memory
schedule. The plugin keeps two kinds of per-terminal record under Orca's plugin storage
key `epochs-v1` (a separate key from the control state `state-v1`):

- an **armed** record while an epoch is **armed and not yet sent**, so a pending
  keepalive is not lost; and
- a **display-only history** record for the last observed cache epoch — its expected
  expiry time and last recorded send block reason — so the tab symbol and the dashboard
  can still show what was kept and why it ended.

An armed record is written while the epoch is armed and not yet sent, and is removed as
soon as the epoch leaves that state — work is observed, a send is attempted (an attempt
is reserved), it expired, or the target changed. A history record is **not a
reservation**: it is never turned back into a send. It is removed when the next real
work turn starts, or 24 hours after its expected expiry. (A record that expires while
the plugin is offline, or an armed record whose expected expiry already passed, is kept
as history instead of being restored as a reservation.)

On the next start the plugin restores an armed schedule only when the catalog still
contains the **same terminal**: the same `userDataKey`, `profileId`, `worktreeId`, and
`paneKey`, the same `ptyId`, and `doneAt` within the last hour. The `incarnationId` is
**not** compared: a terminal whose incarnation changed (for example after an Orca restart
or update) is restored too, and that restore is reported as an `epoch_restored` diagnostic
with `code: 'incarnation_changed'`. An entry whose scope needs review (an open, failed, or
uncertain attempt) is dropped instead of restored, and clearing the review also removes the
record so the same keepalive cannot be sent twice. Expiry and send conditions are otherwise
unchanged. After a restart the shell is new, so until Claude runs again (for example a
session resume) the pre-send safety checks find the target unsupported and nothing is
sent; only the schedule and expected expiry are shown. If the terminal finished another
turn while the plugin was unloaded, the restored schedule is still based on the older
completion time, so that one keepalive may be sent earlier than necessary; the idle,
draft, and quiet checks immediately before each send still apply. Known limitation: after
a restart, if you start a **new** Claude session in the same pane instead of resuming the
old conversation, the restored schedule can send one keepalive to that new session
(subject to the consecutive cap). Plugin reloads and marketplace updates keep the same
identifiers and were already restorable; deleting and reinstalling the plugin clears
Orca's `plugins-data` and is not restored.

A **display-only history** record (and an armed record whose expected expiry already
passed) is restored without creating a schedule: the tab symbol and the dashboard show
the earlier expiry and its last recorded block reason, but nothing is sent. History is
**not** revived by restoring it. A record whose expected expiry is more than 24 hours
old is dropped at startup and while the plugin is running; rewriting a record never
extends this limit.

The storage envelope is version **2**. Version 1 records are still read the old way, but
no history is reconstructed from them because a version 1 record has no TTL information.
An **older** plugin version cannot read a version 2 store and restores nothing from it,
so downgrading loses the stored schedule and history. Expiry history that disappeared
before you updated cannot be recovered; only history this version observed and saved is
preserved.

### Consecutive cap and reset

- Two caps are stored, one per TTL: `maxConsecutiveKeepalives5m` (default **8**) and
  `maxConsecutiveKeepalives1h` (default **3**). Both are integers `0`–`1000`, where
  `0` means unlimited. At a 5-minute TTL, 8 keepalives are about 4 minutes apart, so
  the cache stays warm for roughly 37 minutes after the last real turn; at a 1-hour
  TTL, 3 keepalives are about 58 minutes apart, so roughly 3 hours.
- Which cap applies is decided by the TTL currently reported by Orca's timer
  (`promptCacheTtlMs`, see [Send timing](#send-timing)). When the TTL cannot be read,
  the **smaller** of the two caps is applied. The dashboard form edits the two values
  separately (**연속 keepalive 상한 (5분 TTL)** and **(1시간 TTL)**), and the per-terminal
  row `연속 x/상한 y` shows the cap for the current TTL.
- The cap counts keepalives that were themselves submitted by the plugin. When a
  fresh `working` turn appears that is **not** explained by the plugin's own recent
  attempt, the budget for that target is automatically reset to 0. In practice: if
  you do real work in the terminal, the counter starts over.
- The dashboard's **reset budget** action also resets the counter without waiting.
- The counter is not persisted across long idle periods as a scheduled time; on
  restart, unfinished attempts are surfaced as "needs review" instead of being
  retried.
- The counter is **shared across TTLs**: it is one number per terminal, not one per
  TTL. If you send several keepalives at a 5-minute TTL and then switch Orca's timer
  to a 1-hour TTL, the count may already be at or above the 1-hour cap (default **3**),
  so the plugin stops sending on that terminal until the next real work turn resets
  the counter.

### `cwarm.disabled`

When `respectCwarmDisabled` is on (default), the presence of
`~/.claude/cwarm.disabled` blocks all sends. This is compatible with the concept of
the reference tool [claude-cache-keepalive](https://github.com/fifthadj/claude-cache-keepalive);
the file is only read, never written.

---

## Installation

There is no build or install command. The repository root *is* the plugin
(`orca-plugin.json`, `main.mjs`, `src/`, `ui/`). This repository also provides a
community marketplace through `orca-marketplace.json`.

### From the marketplace (recommended)

1. Open **Settings > Plugins > Manage sources** and add a marketplace:
   - **Git URL:** `https://github.com/RunaticMoon/orca-keepalive-plugin.git`
   - **Git ref:** `main`
2. Find **Cache Keepalive** in the marketplace and click **Install**.
3. Review and approve the requested permissions.

For subsequent updates, click **Refresh**, then **Check for update** on the plugin,
review the preview, and confirm the update. Refresh only reloads the marketplace
listings; it does not install code automatically. The listing follows `main`, so
updates use the latest published commit without entering the Git URL again.
This is a community source, not an official Orca marketplace listing.

Existing Git URL/local-folder installs do not automatically become marketplace
installs when the source is added. Orca currently only shows **Check for update**
for marketplace installs. Back up existing settings before any removal/reinstall
needed to switch installation source; migration has not been verified in Orca.
The marketplace UI requires an Orca version that provides **Manage sources**.

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
| `storage` | Persist plugin state under host-storage keys (`state-v1` for controls and `epochs-v1` for the reload epoch memory). Orca's own settings are never written. |
| `events:subscribe` | Subscribe to `agent.status.changed` and `worktree.removed`. |

`terminal:send` is a declaration, not a sandbox: the plugin's direct filesystem/socket
access is not mediated by it. See [Limits and risks](#limits-and-risks).

### Commands and keybindings

Open the command palette with **⌘J** on macOS or **Ctrl+Shift+J** on
Linux/Windows, then type `Cache Keepalive`. The manifest contributes eight
commands:

| Command id | Title | Context |
|---|---|---|
| `keepalive-open` | Cache Keepalive: Open Dashboard | global |
| `keepalive-toggle-pause` | Cache Keepalive: Pause/Resume All | global |
| `keepalive-pause` | Cache Keepalive: Pause All | global |
| `keepalive-resume` | Cache Keepalive: Resume | global |
| `keepalive-toggle-worktree` | Cache Keepalive: Toggle Current Worktree | worktree |
| `keepalive-worktree-on` | Cache Keepalive: Turn On for Current Worktree | worktree |
| `keepalive-worktree-off` | Cache Keepalive: Turn Off for Current Worktree | worktree |
| `keepalive-status` | Cache Keepalive: Show Status | global |

Keybindings declared in the manifest:

- **Mod+Alt+O** → `keepalive-open` (opens the dashboard).
- **Mod+Alt+P** → `keepalive-toggle-pause` (pause/resume all).
- **Mod+Alt+K** → `keepalive-toggle-worktree` (toggle the current worktree).

Orca runs plugin keybindings only when focus is on Orca's own UI, such as the sidebar. They do nothing while the cursor is in a terminal, a text field, the dashboard, or this plugin's panel, so click the sidebar first.

The three `context: worktree` commands are inactive while no worktree is active.
They only change the current worktree when the plugin workspace context resolves
to exactly one worktree; otherwise they tell you to use the dashboard. Plugins do
not intercept the app's own Cmd/Ctrl-J command UI.

**Cache Keepalive: Show Status** posts a multi-line notification. The first line is
the global state: `켜짐` or `꺼짐(일시정지)`, the Orca prompt-cache timer state
(`타이머 켜짐(5분)` / `타이머 켜짐(1시간)` / `Orca 프롬프트 캐시 타이머 꺼짐` /
`앱 타이머 설정 알 수 없음`), the runtime connection state, and `워크트리 N개`.
Each following line is one worktree:

- `▶ ` marks the worktree of the terminal that invoked the command, when the
  current worktree can be resolved (it is shown first).
- The worktree's **cache state** is appended using the same symbol rule as the tab
  title (`⚡` kept, `💤` no cache being kept, `⚠️` review) together with the counts
  `유지 중 N · 만료 M · 확인 필요 K`. The worktree's own setting (`켜짐` / `꺼짐`,
  `(기본값)` / `(직접 설정)`) is shown separately, so a worktree that is switched on
  but has no cache being kept is not labelled kept. The cache segment is omitted when
  no terminal in the worktree is on.
- While the global pause is active, a worktree that is switched on shows
  `켜짐(일시정지 중)` instead of `켜짐`.
- `다음 전송 … 후` shows the next scheduled send for that worktree as a relative
  time (for example `다음 전송 3분 12초 후`). It is omitted when nothing applies.
- If the text would exceed 900 characters, trailing worktrees are dropped and the
  message ends with `… 외 N개`.

The notification shows the worktree display name and terminal title from the
snapshot; the plugin does not add raw worktree ids, paths, or tokens (a terminal title
you set yourself is shown as-is).

## Where to find the controls

| Surface | How to open | What it is for |
|---|---|---|
| Sidebar panel | Orca right sidebar activity bar → **zap** icon (panel `keepalive-panel`, entry `panel/index.html`) | Read-only orientation: current worktree name and terminal count, plus the command and terminal-command cheat sheets. See [Sidebar panel](#sidebar-panel) for why it cannot show live state. |
| Command palette | **⌘J** (macOS) / **Ctrl+Shift+J** (Linux/Windows), then type `Cache Keepalive` | All eight commands above: open dashboard, toggle/pause/resume, per-worktree on/off, show status. |
| Dashboard | **Cache Keepalive: Open Dashboard** (or **Mod+Alt+O**) | Worktree/terminal toggles, global pause, reset budget, clear "needs review", settings form. |
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

Terminals with no running agent (plain shells) are not listed; they appear once an
agent starts in them.

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
- **Diagnostics list:** the most recent events (up to 20). Each row shows the time,
  level, and affected target as `worktree / terminal title`, a short Korean description,
  and the original `event · code` in small text. Logs store only a hashed target; the
  dashboard resolves the hash back to a label from the current catalog and falls back to
  `#` plus the first six hash characters when no live terminal matches it.

The dashboard keeps the **keepalive setting** and the **cache state** separate, so "the
setting is on" is not read as "a cache is being kept". Each worktree and terminal row
shows `유지 설정 켜짐/꺼짐` (whether the worktree/terminal policy allows keepalives)
alongside a cache state phrase:

- `캐시 유지 중 · 작업 진행 중` — a turn was observed and is still running.
- `캐시 유지 중 · 만료 예정 HH:MM` — a valid reservation exists.
- `캐시 유지 중 · 유지 메시지 전송 중` / `캐시 유지 중 · 작업 시작 확인 중` — a
  keepalive is being submitted / its turn start is being confirmed.
- `캐시 만료됨 · HH:MM · <last recorded send block reason>` — the estimate passed.
- `예약 없음 · …` — no valid reservation (this includes the scheduler's 10-second
  safety stop and the initial "no turn observed yet" state).
- `유지 중단 · …` — automatic keeping stopped (for example a permission/input wait).
- `확인 필요 · 전송 결과를 확인하세요` — a send needs review.

Two honesty notes appear with these phrases. **Expiry times are an estimate** from the
observed work and the configured TTL, not a reading of Anthropic's cache. The reason
shown with an expiry is the **last recorded send block reason**, not a confirmed cause
of expiry — see the DRAFT_PRESENT example under [Limits and risks](#limits-and-risks).

The top of the page shows the app timer state, runtime connection state and global
pause state. The first screen also notes: *"메시지는 사용량을 소비하고 대화 기록에
남습니다. 입력 감지는 제한적입니다."* (messages consume usage and remain in the
conversation; input detection is limited).

### Settings fields

These are the `DEFAULT_CONFIG` fields. The dashboard form edits a subset of them
(marked below); the rest are stored defaults / internal policy.

| Field | Default | Meaning |
|---|---|---|
| `schemaVersion` | `2` | Config schema version. A stored config at version `1` is migrated to `2` on load (see [Config migration (v1 → v2)](#config-migration-v1--v2)). |
| `runtimeUserDataPath` | `null` | Optional explicit Orca user-data directory. Editable in the form. `null` means auto-detect. |
| `paused` | `false` | Plugin-global pause. Controlled by the pause button, not a text field. |
| `defaultWorktreeEnabled` | `true` | Default state for worktrees without an explicit override. Editable in the form. |
| `message` | `Cache keepalive. Reply only OK; do not use tools or continue previous work.` | Single-line message, 1–512 UTF-8 bytes, no control characters/newlines. Editable in the form. |
| `margin5mMs` | `60000` | Margin before expiry for a 5-minute TTL (30000–120000 ms). Form edits it in **seconds**. |
| `margin1hMs` | `120000` | Margin before expiry for a 1-hour TTL (60000–600000 ms). Form edits it in **seconds**. |
| `quietOutputMs` | `2500` | Required output-quiet time before sending (2500–60000 ms). Editable in the form. |
| `observedInputQuietMs` | `30000` | Wait after an observed draft change before sending (10000–300000 ms). Not in the form. |
| `maxConsecutiveKeepalives5m` | `8` | Consecutive keepalive cap for a 5-minute TTL; `0` = unlimited (0–1000). Editable in the form as **연속 keepalive 상한 (5분 TTL)**. |
| `maxConsecutiveKeepalives1h` | `3` | Consecutive keepalive cap for a 1-hour TTL; `0` = unlimited (0–1000). Editable in the form as **연속 keepalive 상한 (1시간 TTL)**. |
| `respectCwarmDisabled` | `true` | Honor `~/.claude/cwarm.disabled`. Editable in the form. |
| `tabTitleIndicator` | `true` | Prefix the Orca tab title of Claude terminals with a cache state symbol (`⚡` kept / `💤` no cache being kept / `⚠️` review). Editable in the form as **탭 이름에 캐시 상태 표시**. See [Tab title cache state indicator](#tab-title-cache-state-indicator). |
| `logLevel` | `info` | Diagnostic level. Not in the form. |

Time and counter fields are validated on the server; a rejected value is not applied.

### Config migration (v1 → v2)

Stored configs at `schemaVersion: 1` are migrated to `2` when they are loaded, and the
migrated config is written back to plugin storage immediately (a single save). A config
that is already version `2` is not rewritten on load.

- The old single key `maxConsecutiveKeepalives` is split. If it was `3` (the old
  default) the new defaults `8` / `3` are used instead; otherwise that value is
  copied into **both** new keys. Sending the legacy key `maxConsecutiveKeepalives`
  in a config patch is still accepted and applies the same value to both keys, so
  older clients stay compatible.
- `tabTitleIndicator` is turned **on** once during the upgrade, because the old
  default (`false`) cannot be told apart from a user who had deliberately turned it
  off. If you do not want the cache state symbols, turn it off again in the dashboard.
  A config patch applied while the stored config is still version `1` does **not**
  force it on; the stored value is kept.

After the upgrade the config is version `2` and stays that way, so editing settings in
the stored config directly (see [Tab title cache state
indicator](#tab-title-cache-state-indicator)) keeps working. An **older** plugin version
that reads a version `2` config may reject it as `unsupported_schema`, so downgrading
needs care.

### Change notifications

Changing state from the **dashboard** (browser) or the **terminal CLI**
(`keepalive ...`) posts an Orca notification describing what changed. Both paths go
through the same `POST /api/action` dispatch, so the wording is identical, and it
shows only the worktree display name and terminal title from the snapshot — never a
raw worktree id, path, or token. Examples:

- `main: keepalive 켜짐` / `main: keepalive 꺼짐` for a worktree, and
  `main: 기본값 사용 (현재 켜짐)` when reverting to the default.
- `main / claude #1: keepalive 켜짐` / `main / claude #1: 상속(현재 꺼짐)` for a
  terminal.
- `모든 keepalive를 껐습니다(일시정지).` / `모든 keepalive를 켰습니다.` for the
  global pause.
- Turning a scope on while the global pause is active appends
  ` (전체 일시정지 중)`, because the on state is stored but not yet effective.

Notifications are best-effort: if showing one fails, the change itself still
succeeds. The palette commands (`keepalive-toggle-pause`,
`keepalive-toggle-worktree`, and so on) post their own messages and do not use this
path. `config`, `reset-budget`, and `clear-review` actions do not notify.

### Tab title cache state indicator

The setting **탭 이름에 캐시 상태 표시** (`tabTitleIndicator`, default **on**) prefixes
a cache state symbol to the Orca tab title of Claude terminals:

| Symbol | Meaning |
|---|---|
| `⚡ ` | A cache is being kept: a turn is running, a reservation is scheduled, or a keepalive is being sent / its turn start is being confirmed. |
| `💤 ` | No cache is being kept by the plugin right now: expired, no reservation, or automatic keeping stopped (for example a permission/input wait). This means "no automatic keepalive reservation", not necessarily that Anthropic's cache is gone. |
| `⚠️ ` | A send result needs review / confirmation. |
| (none) | The indicator is off, or keepalive does not apply to this tab. |

The tab title is what Kanban (workspace board) cards show on the agent rows, so the
symbol is visible there too.

A tab can contain several panes. Only the panes where keepalive is **on** for that tab
are combined, and the highest priority wins: **⚠️ > ⚡ > 💤**. So if one pane needs
review the tab shows ⚠️, and if any pane is keeping a cache the tab shows ⚡ rather than
💤. The per-pane details stay in the dashboard.

A symbol is only decided while keepalive applies. The plugin stops showing it (and
returns the tab to Orca's automatic name) when the plugin is globally paused, the Orca
prompt-cache timer is off or unreadable, the runtime is disconnected, the worktree or
terminal policy is off, the consecutive-keepalive cap is reached, or — when
`respectCwarmDisabled` is on — `~/.claude/cwarm.disabled` exists. Within an on tab the
per-pane cache state is what selects ⚡ vs 💤.

Same-symbol rule: while the symbol does not change, the plugin does **not** rewrite the
title. In particular it no longer refreshes the title on every completed turn. As a
result, if you let the agent (or Orca) auto-generate the tab title, a new automatic
title can appear late — it is not rewritten while the same symbol is shown. The title is
only rewritten when the symbol changes, including the first application and a retry
after a failed rename.

The option is on by default. To change it:

- Dashboard → **설정** form → check or clear **탭 이름에 캐시 상태 표시** → **저장
  (Save)**. This sends a `{ "type": "config", "patch": { "tabTitleIndicator": true } }`
  (or `false`) action, and the value is stored in the plugin config alongside the other
  settings. After an upgrade from version 1 the option is on once (see
  [Config migration (v1 → v2)](#config-migration-v1--v2)); clear it here if you do not
  want the symbols.
- Or set `tabTitleIndicator` in the stored plugin config directly. There is no CLI
  command that edits config. (The next load migrates a version `1` config to version
  `2` and turns the indicator on once — see
  [Config migration (v1 → v2)](#config-migration-v1--v2); after that the stored value
  is used as is.)

When the option is on, the plugin sets the tab's `customTitle` through the Orca
`terminal.rename` RPC. A symbol change replaces the previous symbol (including a title
where several symbols were repeated) in one rename instead of clearing and re-applying.
The plugin removes the symbol when the option is turned off, when keepalive no longer
applies, or when the plugin shuts down, returning the tab to Orca's automatic name. A
failed rename is retried on the next tick; after three consecutive failures a tab is
skipped for the rest of that run.

Known limitations (read before enabling):

- A custom tab name you set **before** a symbol was applied is not restored. The symbol
  is written as `⚡ <your name>` (or `💤`/`⚠️`), and turning the option off clears the
  custom title, so the tab ends up with Orca's automatic name. Rename the tab again
  afterwards if you need that name.
- Orca's `session.tabs.list` reports the terminal's runtime title (OSC/PTY), not the
  custom title, so the plugin cannot tell whether a tab's current name is one you set
  yourself. A tab you rename **while** a symbol is applied can therefore have your name
  cleared when the option is turned off, when the symbol changes, or when the plugin
  shuts down. The tab then gets Orca's automatic name (or `<symbol> <automatic name>`);
  rename it again afterwards if you need that name.
- While a symbol is applied, Orca's automatic tab-title generation for that tab stops.
  Because the plugin no longer refreshes on every turn, a new automatic title may only
  appear when the symbol changes (for example after expiry). The tab title can flicker
  when a symbol change is applied.
- Orca stores the tab title, so an abnormal exit can leave a symbol behind on a tab. On
  the next start the plugin removes a leftover symbol when the option is off; when the
  option is on it re-applies the symbol only where the conditions above hold (saved
  records from the previous run are treated as unconfirmed, so the symbol is rewritten
  with the current terminal handle). A leftover symbol **without** a saved record is
  replaced only when a known symbol is visible in the queried title; if no record and no
  visible symbol can be found, the plugin cannot identify the tab and does not clean it
  up. It never resets arbitrary tab titles.
- Split panes in the same tab share one tab title. The combined symbol is shown for the
  tab.
- This is a best-effort integration over Orca internals. Failures are swallowed
  (reported only as safe diagnostic codes), and a tab is skipped for the rest of the
  current run after three consecutive failures.

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
- **The expiry cause is the last recorded send block reason, not a confirmed cause.**
  The dashboard shows the last reason a send was blocked before an expected expiry, and
  the tab/dashboard notes call it exactly that. It can be wrong for the real expiry
  cause. Known example: Orca can read Claude Code's dimmed prompt suggestion as a
  draft, so the plugin records `DRAFT_PRESENT` ("a draft was detected") even though the
  input line is empty. Treat the reason as a hint, not a diagnosis.
- **The scheduler stops sending 10 seconds before the expected expiry.** During that
  window the dashboard shows `예약 없음 · 안전 전송 시간이 지남 · 만료 예정 HH:MM` rather
  than "kept". The state changes to `캐시 만료됨` only after the expected expiry time
  passes; the two are intentionally not the same moment.
- **A leftover tab symbol with no saved record may remain.** Orca stores tab titles,
  and `session.tabs.list` does not expose the custom title, so if a symbol is left
  behind after an abnormal exit and no saved record or visible symbol can be found, the
  plugin cannot identify the tab and does not clear it. See
  [Tab title cache state indicator](#tab-title-cache-state-indicator).
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

