# Publishing Cache Keepalive

This document covers the pre-release inputs, a marketplace entry example, and the
release checklist. **Some release inputs are still undecided** — they are marked
below and must be resolved by the repository owner before a public release.

The distribution model is a **Git-backed Orca plugin**: the repository root is the
plugin, and there is no build step or `npm install` at install time. A release is a
git tag whose commit contains `orca-plugin.json`, `main.mjs`, `src/`, `ui/`.

---

## 1. Required inputs before release (some undecided)

| Input | Current state | Action |
|---|---|---|
| Publisher slug | **Placeholder**: manifest `publisher` is `"community-keepalive"`. | Replace with the real owner's publisher slug. |
| Plugin id | `"cache-keepalive"` (does not use the reserved `orca-` prefix). | Keep or rename before first publish; changing identity after install creates a different plugin. |
| License | **미정 — no `LICENSE` file exists in this repository** (checked). | Choose and add a license. If any reference-tool code were copied, its notice would need separate review; this repository implements its own code and does not copy `claude-cache-keepalive` code. |
| Git remote URL | A remote is configured locally as `origin` = `https://github.com/RunaticMoon/orca-keepalive-plugin` **(확인 필요 — whether this is the public release remote is not confirmed)**. | Confirm the public remote URL (or create one). This is `<REMOTE_URL>` below. |
| Version tag | Manifest `version` is `0.1.0`; suggested tag `v0.1.0`. | Confirm the tag matches the manifest version and the resolved commit. |
| Marketplace categories | **확인 필요** — see §2. | Pick categories that actually exist in the marketplace index. |

The manifest currently declares:

```json
{
  "manifestVersion": 1,
  "id": "cache-keepalive",
  "publisher": "community-keepalive",
  "version": "0.1.0",
  "engines": { "orca": ">=1.4.214" },
  "pluginApi": 1
}
```

Note: `stablyai` as publisher and the `orca-` id prefix are reserved for official
plugins. This community plugin must not claim either.

---

## 2. Marketplace entry

The community/Orca marketplace index is a Git repository whose root file is
`orca-marketplace.json`. A plugin entry has the shape:

```json
{
  "id": "<publisher-slug>.<plugin-id>",
  "source": { "kind": "git", "url": "<REMOTE_URL>", "ref": "<tag>" },
  "description": "<short description>",
  "categories": ["<category>", "..."]
}
```

Example for this plugin (placeholders in angle brackets are **확인 필요**):

```json
{
  "id": "<publisher-slug>.cache-keepalive",
  "source": {
    "kind": "git",
    "url": "<REMOTE_URL>",
    "ref": "v0.1.0"
  },
  "description": "Schedules small keepalive messages for idle Claude terminals in Orca, with per-worktree and per-terminal controls.",
  "categories": ["<category>"]
}
```

With the current placeholder publisher and observed remote, the entry would look
like this — **do not publish until the publisher slug, remote, license and
categories are confirmed**:

```json
{
  "id": "community-keepalive.cache-keepalive",
  "source": {
    "kind": "git",
    "url": "https://github.com/RunaticMoon/orca-keepalive-plugin.git",
    "ref": "v0.1.0"
  },
  "description": "Schedules small keepalive messages for idle Claude terminals in Orca, with per-worktree and per-terminal controls.",
  "categories": ["utilities"]
}
```

### Categories

The categories in the local official index (`orca-plugins/orca-marketplace.json`)
include: `themes`, `official`, `skills`, `languages`, `icons`, `terminal-themes`,
`vm-recipes`, `keybindings`. None of these cleanly describes Cache Keepalive, so the
category value above is a **placeholder (확인 필요)**. Confirm which category names
the target marketplace accepts before submitting. Do not use the reserved `official`
category.

### Notes taken from the source contract

- The marketplace matches `source.kind: 'git'` with a URL and a **named ref**, and
  resolves the ref to an exact commit. Keep the tag, the index `ref`, and the
  manifest `version` consistent; do not point the index at one version and the
  manifest at another.
- The plugin id in the entry is `<publisher>.<id>`; keep the publisher consistent
  between the manifest and the marketplace entry.

---

## 3. Release checklist

1. [ ] `npm test` passes (`node --test`, Node >=22.5).
2. [ ] The manual E2E checklist in [TESTING.md](./TESTING.md#3-실제-orca-수동-e2e-체크리스트)
       has been run on at least one supported platform; unrun items are recorded as
       not run.
3. [ ] `orca-plugin.json` `version` matches the release tag, and `engines.orca` is set
       to the verified minimum. (`>=1.4.214` is the current declared minimum.)
4. [ ] Publisher slug, license, and remote URL are finalized (see §1).
5. [ ] The release commit contains the full plugin (`orca-plugin.json`, `main.mjs`,
       `src/`, `ui/`); no install/build hook is required.
6. [ ] Tag the release (e.g. `v0.1.0`).
7. [ ] Add or update the marketplace entry (§2) with the same publisher, remote and
       ref.
8. [ ] Smoke-test in Orca's Plugins marketplace management: list, permission review,
       install, update, and remove. Diagnose any URL access or index validation
       failure.

Registration in the official `stablyai/orca-plugins` index is a separate decision and
its acceptance is not guaranteed by this document. Do not describe this plugin as
official or Stably-published.

---

## 4. Version bump and worker reload

Orca may keep an existing plugin worker running after an in-place file edit. After
changing `main.mjs` (or `src/`/`ui/`), bump the manifest `version` or disable/enable
the plugin so a fresh worker loads the new code, then confirm the running version in
the process/diagnostics output.
