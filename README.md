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
- Version: `0.1.8`
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
schedule. To avoid losing a pending keepalive, while an epoch is **armed and not yet
sent** the plugin writes its observed completion time (`doneAt`) to Orca's plugin
storage under the key `epochs-v1` (a separate key from the control state `state-v1`).
Entries older than one hour are pruned when the plugin starts, and at most 200 entries
are kept. As soon as the epoch leaves the armed, not-yet-sent state — work is observed,
a send is attempted (an attempt is reserved), it expired, or the target changed — the
entry is removed.

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
- `⚡ ` marks a worktree that is actually on. The suffix `(기본값)` or `(직접 설정)`
  distinguishes an inherited default from an explicit override.
- While the global pause is active, a worktree that is switched on shows
  `켜짐(일시정지 중)` instead of `켜짐`.
- `다음 전송 … 후` shows the next scheduled send for that worktree as a relative
  time (for example `다음 전송 3분 12초 후`), and `확인 필요 N` counts terminals
  whose send result needs review. Both are omitted when nothing applies.
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
| `tabTitleIndicator` | `true` | Prefix `⚡ ` to the Orca tab title of Claude terminals where keepalive applies. Editable in the form. See [Tab title ⚡ indicator](#tab-title--indicator). |
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
  off. If you do not want ⚡, turn it off again in the dashboard. A config patch
  applied while the stored config is still version `1` does **not** force it on; the
  stored value is kept.

After the upgrade the config is version `2` and stays that way, so editing settings in
the stored config directly (see [Tab title ⚡ indicator](#tab-title--indicator)) keeps
working. An **older** plugin version that reads a version `2` config may reject it as
`unsupported_schema`, so downgrading needs care.

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

### Tab title ⚡ indicator

The setting **탭 이름에 ⚡ 표시** (`tabTitleIndicator`, default **on**) prefixes
`⚡ ` to the Orca tab title of every Claude terminal that is **switched on as a
keepalive target**. It marks that the tab is on, not that a send is scheduled right
now: a tab can show ⚡ before its next send is due. The tab title is what Kanban
(workspace board) cards show on the agent rows, so the ⚡ marker is visible there
too.

A tab shows ⚡ only while all of these hold at the tick:

- the plugin is not globally paused;
- the Orca prompt-cache timer is on and readable;
- the runtime is connected; and
- the worktree and terminal policy for that tab is on — this includes the
  consecutive-keepalive cap, so reaching the cap (or a pending review / storage
  failure) can drop ⚡ temporarily.

When `respectCwarmDisabled` is on, an existing `~/.claude/cwarm.disabled` also turns
⚡ off.

The option is on by default. To change it:

- Dashboard → **설정** form → check or clear **탭 이름에 ⚡ 표시** → **저장 (Save)**.
  This sends a `{ "type": "config", "patch": { "tabTitleIndicator": true } }` (or
  `false`) action, and the value is stored in the plugin config alongside the other
  settings. After an upgrade from version 1 the option is on once (see
  [Config migration (v1 → v2)](#config-migration-v1--v2)); clear it here if you do
  not want ⚡.
- Or set `tabTitleIndicator` in the stored plugin config directly. There is no CLI
  command that edits config. (The next load migrates a version `1` config to version
  `2` and turns ⚡ on once — see
  [Config migration (v1 → v2)](#config-migration-v1--v2); after that the stored value
  is used as is.)

When the option is on, the plugin sets the tab's `customTitle` through the Orca
`terminal.rename` RPC. It removes the prefix again when the option is turned off,
when one of the conditions above no longer holds, or when the plugin shuts down,
returning the tab to Orca's automatic name. A failed rename is retried on the next
tick; after three consecutive failures a tab is skipped for the rest of that run.

Known limitations (read before enabling):

- A custom tab name you set **before** ⚡ was applied is not restored. ⚡ is written
  as `⚡ <your name>`, the post-turn refresh rebuilds it from Orca's automatic title,
  and turning ⚡ off clears the custom title, so the tab ends up with Orca's
  automatic name. Rename the tab again afterwards if you need that name.
- Orca's `session.tabs.list` reports the terminal's runtime title (OSC/PTY), not the
  custom title, so the plugin cannot tell whether a tab's current name is one you set
  yourself. A tab you rename **while** ⚡ is applied can therefore have your name
  cleared when ⚡ is turned off, when the post-turn refresh rebuilds the title (at most
  once per 60 s), or when the plugin shuts down. The tab then gets Orca's automatic
  name (or `⚡ <automatic name>` while ⚡ stays on); rename it again afterwards if you
  need that name.
- While ⚡ is applied, Orca's automatic tab-title generation stops. After a real user
  turn completes (at most once per 60 s), the plugin briefly clears the name, waits
  for the new automatic title, and re-applies ⚡. The tab title can flicker during
  that refresh.
- Orca stores the tab title, so an abnormal exit can leave ⚡ behind on a tab. On the
  next start the plugin removes the leftover ⚡ when the option is off; when the
  option is on it re-applies ⚡ only where the conditions above hold (saved records
  from the previous run are treated as unconfirmed, so ⚡ is rewritten with the
  current terminal handle).
- Split panes in the same tab share one tab title. ⚡ is shown when any Claude pane
  in that tab is on.
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
- **타이밍:** 캐시 기준 시각(`basisAt`) 기준 5분 TTL은 `basisAt+TTL-60초`, 1시간 TTL은
  `basisAt+TTL-120초`. `basisAt`은 턴의 마지막 `working` 이벤트 수신 시각(≈마지막 API 요청
  시작)입니다. Anthropic 규칙상 TTL은 캐시를 읽거나 쓴 요청의 시작부터 흐르고 응답 생성
  시간도 TTL을 소모합니다. 도구별 working 이벤트가 없거나 완료 시각(`doneAt`)과 3분 넘게
  차이 나면 `doneAt`을 씁니다. 캐시 epoch당 최대 1회만 보내고, 마감이 지나면 따라잡지 않습니다.
- **상한:** TTL별로 두 값 `maxConsecutiveKeepalives5m`(기본 8)·
  `maxConsecutiveKeepalives1h`(기본 3)를 저장합니다(0=무제한, 0~1000). 5분 TTL에서는 약
  4분 간격으로 마지막 실제 턴 이후 약 37분, 1시간 TTL에서는 약 58분 간격으로 약 3시간
  유지됩니다. 현재 Orca 타이머 TTL에 해당하는 상한을 적용하고, TTL을 알 수 없으면 두 값 중
  작은 쪽을 적용합니다. 대시보드 설정 폼에서 두 값을 따로 편집하며, 터미널 행 `연속 x/상한 y`는
  현재 TTL 기준 상한을 보여줍니다. 자체 전송이 아닌 새 working 턴이
  관측되면 카운터가 자동 초기화됩니다. 카운터는 TTL별로 따로가 아니라 터미널마다 하나로,
  TTL과 무관하게 공유됩니다. 예를 들어 5분 TTL로 여러 번 보낸 뒤 Orca 타이머 TTL을 1시간으로
  바꾸면 공유 카운터가 이미 1시간 상한(기본 3)에 도달해, 다음 실제 작업 턴이 카운터를 초기화할
  때까지 그 터미널에서는 더 보내지 않습니다. `~/.claude/cwarm.disabled`를 존중합니다.
- **설정 마이그레이션(v1→v2):** 저장된 v1 설정은 로드 시 v2로 변환되고 그 결과가 즉시 1회
  저장됩니다(이미 v2인 저장값은 다시 쓰지 않음). 기존 저장값 `maxConsecutiveKeepalives`가 옛
  기본값 3이면 새 기본값(8/3)을 쓰고, 3이 아니면 그 값을 두 키에 복사합니다. patch에 레거시 키를
  보내면 두 키에 같은 값이 적용됩니다(호환). 업그레이드 시 `tabTitleIndicator`가 한 번 켜집니다
  (옛 기본 false와 사용자가 끈 값을 구분할 수 없기 때문). 다만 저장값이 아직 v1일 때 적용하는
  patch 경로에서는 강제로 켜지 않고 저장된 값을 유지합니다. 원치 않으면 대시보드에서 다시 끄면
  됩니다. 새 버전 설정(v2)을 이전 버전 플러그인이 읽으면 `unsupported_schema`로 거부될 수
  있으므로 다운그레이드에 주의하세요.
- **설치/업데이트:** 이 저장소 자체가 커뮤니티 marketplace입니다. Orca 설정 >
  Plugins > Manage sources에서 Git URL에
  `https://github.com/RunaticMoon/orca-keepalive-plugin.git`, Git ref에 `main`을
  넣고 추가한 뒤 Cache Keepalive를 설치합니다. 이후 **Refresh → Check for update →
  변경 확인 및 적용**으로 업데이트합니다. 새로고침만으로 자동 설치되지는 않습니다.
  기존 Git URL/로컬 설치는 자동 전환되지 않으며, 전환을 위해 삭제·재설치할 경우
  먼저 설정을 백업하세요(실제 전환은 미검증). Git URL 직접 설치와 Development 폴더
  등록도 계속 지원합니다.
- **권한 5개:** workspace:read, terminal:send, notifications:show, storage,
  events:subscribe.
- **명령 8개 + 단축키:** 팔레트는 ⌘J(macOS)/Ctrl+Shift+J(Linux/Windows)로 열고
  "Cache Keepalive" 입력. keepalive-open(Mod+Alt+O),
  keepalive-toggle-pause(Mod+Alt+P), keepalive-pause, keepalive-resume,
  keepalive-toggle-worktree(Mod+Alt+K), keepalive-worktree-on,
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
- **상태 요약(Show Status 명령):** 첫 줄에 전역 상태(켜짐/꺼짐(일시정지) · 타이머 ·
  연결 · 워크트리 N개), 이후 워크트리별 한 줄(현재 `▶`, 실제 켜짐 `⚡`,
  `(기본값)`/`(직접 설정)`, 일시정지 중 `켜짐(일시정지 중)`, `다음 전송 … 후`,
  `확인 필요 N`)을 보여줍니다. 900자를 넘으면 `… 외 N개`로 줄입니다. 원시
  worktreeId·경로·토큰은 넣지 않습니다.
- **변경 알림:** 대시보드나 터미널 CLI로 상태를 바꾸면(예: `main: keepalive 켜짐`,
  `main / claude #1: keepalive 꺼짐`, `모든 keepalive를 껐습니다(일시정지).`) Orca
  알림이 표시됩니다. 문구에는 스냅숏의 워크트리 표시 이름과 터미널 제목만 쓰고 원시
  worktreeId·경로·토큰은 넣지 않습니다. 전역 일시정지 중 켜기는 `(전체 일시정지 중)`이
  붙고, config·예산 초기화·확인 필요 해제는 알리지 않습니다. 팔레트 명령은 자체 문구를
  씁니다.
- **⚡ 탭 표시:** 설정 `tabTitleIndicator`(기본 켜짐)가 켜져 있으면 keepalive 대상으로
  켜진 Claude 탭 이름 앞에 `⚡ `가 붙어 칸반(워크스페이스) 보드 카드에서도 보입니다.
  (실제로 전송할 탭이 아니라 켜진 탭 표시입니다.) ⚡는 전체 일시정지 아님 + Orca 앱
  타이머 켜짐 + 런타임 연결됨 + 해당 워크트리/터미널 정책 켜짐(연속 전송 상한 도달 등으로
  일시 해제될 수 있음) + (`respectCwarmDisabled`일 때) `cwarm.disabled` 없음일 때만
  붙습니다. 대시보드 설정에서 **탭 이름에 ⚡ 표시**를 체크/해제한 뒤 저장하거나 저장된
  config 값으로 바꿉니다(CLI의 config 명령은 없음). v1에서 업그레이드하면 옵션이 한 번 켜지므로
  원치 않으면 대시보드에서 끄면 됩니다. rename 실패는 다음 주기에 재시도하고,
  연속 실패가 상한(3회)에 달하면 그 탭은 이번 실행 동안 건너뜁니다. 조건이 안 맞거나
  끄면, 플러그인 종료 시 Orca 자동 이름으로 되돌립니다. 비정상 종료 뒤 남은 ⚡는 다음
  시작 시 옵션이 꺼져 있으면 제거되고, 켜져 있으면 조건에 맞는 탭에 새 handle로
  재적용됩니다(이전 실행 기록은 미확정으로 취급). `session.tabs.list` title로는
  수동 변경을 판별할 수 없어, ⚡가
  붙어 있는 동안 직접 이름을 바꾼 탭(⚡ 적용 값과 달라진 경우)도 플러그인이 덮어쓰거나
  해제할 수 있습니다(끄기·턴 완료 새로고침·재시작 후 재적용·플러그인 종료 시). 반대로
  ⚡가 붙기 **전에** 직접 지정한 탭 이름은 복원되지 않고 끄면
  Orca 자동 이름이 됩니다. 한계:
  ⚡가 붙은 동안 Orca 자동 제목 갱신이 멈추며(턴 완료 후 최소 60초 간격으로 해제→재적용,
  깜빡임 가능), 같은 탭 분할 창은 이름을 공유합니다.
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
