# Publishing Cache Keepalive

This document covers the release inputs, how users install the plugin, and the
release checklist.

Cache Keepalive is a **community plugin distributed directly from its public Git
repository**. It is **not registered in any Orca marketplace index**, and no
marketplace registration is planned.

The repository root is the plugin. There is no build step and no `npm install` at
install time. A release is a git tag whose commit contains `orca-plugin.json`,
`main.mjs`, `src/`, `ui/`.

---

## 1. Release inputs

| Input | State | Notes |
|---|---|---|
| Publisher slug | **Decided**: `runaticmoon` (the repository owner's GitHub account, lowercased to satisfy the kebab-case slug rule). | Keep it stable; the plugin identity is `<publisher>.<id>`. |
| Plugin id | `"cache-keepalive"` (does not use the reserved `orca-` prefix). | Changing identity after install creates a different plugin. |
| License | **Decided**: MIT (`LICENSE`, `package.json` `license`). | This repository implements its own code and does not copy `claude-cache-keepalive` code. |
| Git remote URL | **Decided**: `https://github.com/RunaticMoon/orca-keepalive-plugin` (public). | Users install from this URL. |
| Version tag | Manifest `version` is `0.1.3`. Tags are optional (e.g. `v0.1.0`). | If you tag, the tag must match the manifest version. |

The manifest currently declares:

```json
{
  "manifestVersion": 1,
  "id": "cache-keepalive",
  "publisher": "runaticmoon",
  "version": "0.1.3",
  "engines": { "orca": ">=1.4.214" },
  "pluginApi": 1
}
```

Note: `stablyai` as publisher and the `orca-` id prefix are reserved for official
plugins. This community plugin must not claim either, and must not be described as
official or Stably-published.

---

## 2. How users install it

Orca's **Settings > Plugins > "Install plugin"** dialog offers two tabs that do not
go through a marketplace:

- **Git URL** — enter the repository URL with a `#ref`:

  ```text
  https://github.com/RunaticMoon/orca-keepalive-plugin#main     (latest code)
  https://github.com/RunaticMoon/orca-keepalive-plugin#v0.1.0   (fixed release)
  ```

  Only HTTPS or SSH URLs are accepted, and the dialog requires a non-empty `#ref`.
  The dialog text says "tag or commit", but the installer runs
  `git clone --depth 1 --branch <ref>` for anything that is not a full SHA, so a
  branch name works too (`src/main/plugins/plugin-git-repository.ts`). Orca records
  the resolved commit, copies the plugin into its plugin directory and shows the
  requested permissions for review.
- **Local folder** — point at a local clone of this repository.

For development there is also **Settings > Plugins > Development > "Development
plugin folder path"** + "Add path" (see the README), which loads the folder in place.

Updating: Orca has no automatic update for Git URL installs; each install is frozen
at the commit it resolved. To update, run **Install plugin** again — with the same
`#main` URL to get the newest commit, or with a newer tag. Orca publishes the new
copy under the same plugin key, keeps the plugin's stored data, and retains the
previous copy for rollback (`src/main/plugins/plugin-install-publication.ts`). A
permission change is shown for review again.

---

## 3. Release checklist

1. [ ] `npm test` passes (`node --test`, Node >=22.5).
2. [ ] The manual E2E checklist in [TESTING.md](./TESTING.md#3-실제-orca-수동-e2e-체크리스트)
       has been run on at least one supported platform; unrun items are recorded as
       not run.
3. [ ] `orca-plugin.json` `version` matches the release tag, and `engines.orca` is set
       to the verified minimum. (`>=1.4.214` is the current declared minimum.)
4. [ ] The release commit contains the full plugin (`orca-plugin.json`, `main.mjs`,
       `src/`, `ui/`); no install/build hook is required.
5. [ ] Optional: tag a fixed release and push the tag
       (`git tag v0.1.0 && git push origin v0.1.0`). Users on `#main` do not need
       tags; tags are for users who want a pinned version.
6. [ ] Smoke-test the Git URL install in Orca (`#main` and, if tagged, the tag):
       install, permission review, enable, reinstall to update, disable, remove.

---

## 4. Version bump and worker reload

Orca may keep an existing plugin worker running after an in-place file edit. After
changing `main.mjs` (or `src/`/`ui/`), bump the manifest `version` or disable/enable
the plugin so a fresh worker loads the new code, then confirm the running version in
the process/diagnostics output.
