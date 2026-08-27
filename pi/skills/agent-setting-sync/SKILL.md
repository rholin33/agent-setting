---
name: agent-setting-sync
description: Synchronize portable local Codex, Pi, and CCB configuration with https://github.com/rholin33/agent-setting using a pull, merge, review, commit, and push workflow. Use when the user explicitly invokes $agent-setting-sync, asks to synchronize the agent-setting repository, or uses the legacy $codex-sync name. Exclude credentials, runtime state, system skills, and unrelated files.
---

# Agent Settings Sync

Synchronize only the portable configuration managed by `agent-setting`. Preserve unrelated local changes, stop on ambiguous conflicts or sensitive-file changes, and never force-push.

## Modes

- `force`: make the validated remote configuration authoritative for the current machine. Invoke the sync hook with `--force`; it backs up overwritten managed files and does not export, commit, or push. The current project's `.ccb/ccb.config` is restored even when `.ccb/` does not yet exist; project Pi settings are restored when the project has `pi/` or `.ccb/agents/`. It does not delete local files absent from the remote.

## Scope

Resolve paths from these environment variables, using the defaults when unset:

- `CODEX_HOME`: `~/.codex`
- `PI_CODING_AGENT_DIR`: `~/.pi/agent`
- `CCB_HOME`: `~/.ccb`

The checkout is `$CODEX_HOME/.sync/codex-setting/remote`. The local sync directory keeps the historical `codex-setting` name for compatibility; its `origin` must be `https://github.com/rholin33/agent-setting.git` on branch `main`.

Managed Codex paths are stored under `codex/` and map to the corresponding paths below `$CODEX_HOME`:

- `codex/AGENTS.md`
- `codex/hooks/`
- `codex/rules/`
- `codex/skills/`

Managed Pi paths are stored under `pi/` and map to `$PI_CODING_AGENT_DIR`:

- `pi/AGENTS.md`
- `pi/settings.json`
- `pi/skills/`
- `pi/bin/pi`

The managed global `pi/settings.json` keeps the configured HTTP proxy (`httpProxy`, currently `http://127.0.0.1:1087`) so Pi requests use the system proxy by default.

When the current project has a `pi/` directory or `.ccb/agents/`, its project Pi scope is stored under `pi/projects/<project-key>/`:

- `pi/projects/<project-key>/settings.json` maps to `<project>/pi/settings.json`.
- `pi/projects/<project-key>/agents/<agent>/provider-state/pi/home/settings.json` maps to `<project>/.ccb/agents/<agent>/provider-state/pi/home/settings.json`.

Only these Pi `settings.json` files are portable. Never synchronize project Pi `auth.json`, `models.json`, `models-store.json`, npm/package caches, sessions, logs, or generated extension state. Provider credentials remain in the machine's application credential store.

The managed global CCB path is `$CCB_HOME/ccb.config`, exported as `ccb/ccb.config`. The current project's `.ccb/ccb.config` is always managed (except when the repository checkout itself is the project root), even when `.ccb/` does not yet exist, and is stored remotely as `ccb/projects/<project-key>/ccb.config`. Project identity is read from `.ccb/project.identity.json` or `ccb/project.identity.json`, with a deterministic directory-name/path-hash fallback. A missing project file is seeded from the matching remote project config or the global remote config. Other `.ccb/` runtime state and identity files are excluded.

`codex/hooks.json`, `ccb/roles.json`, `roles/`, `scripts/`, and `install.sh` are repository-owned bootstrap files. Review them separately and stage them only when their changes are intentional; they are not produced by the local export.

Do not sync or stage `auth.json`, `config.toml`, history, databases, logs, sessions, shell snapshots, temporary files, `ccb/agents/`, `skills/.system/`, Pi npm package caches, authentication files, or generated extension state. Pi extensions are represented by package sources in `pi/settings.json`; restore missing packages with `pi install` rather than copying caches.

## Workflow

1. Resolve `CODEX_HOME`, `PI_CODING_AGENT_DIR`, and `CCB_HOME`. Verify the checkout exists, `origin` points to `rholin33/agent-setting`, and the current branch is `main`.
2. Check the checkout with `git status --short`. Stop if it has local changes, an unresolved merge, or a detached/non-main branch. Do not overwrite local checkout changes.
3. Run `git fetch origin` followed by `git pull --ff-only`.
4. Run the repository's Codex SessionStart sync hook when present:

   ```bash
   python3 "$CODEX_HOME/hooks/sync-codex-setting.py"
   ```

   Read `$CODEX_HOME/log/agent-setting-sync.log` afterward. Treat a logged sync failure, incomplete remote or local Pi layout, invalid Pi settings, or an unresolved merge as a stop condition. The hook validates `codex/` and `pi/`, performs three-way text merges, performs a JSON-aware merge of global and discovered project Pi settings, treats global and discovered project CCB configs as remote-authoritative, saves backups, installs packaged/catalog CCB Roles with `--skip-tools`, and installs missing Pi extensions. It never commits, pushes, reloads, or restarts services automatically.
5. Export the live local managed files into the checkout:

   ```bash
   ./scripts/sync-local-config.sh
   ```

   The export maps Codex files to `codex/`, global Pi files to `pi/`, `$CCB_HOME/ccb.config` to `ccb/ccb.config`, and the current project's `.ccb/ccb.config` to `ccb/projects/<project-key>/ccb.config`. A missing project `.ccb/` directory is created and seeded from the matching remote project or global config. Project Pi settings are exported to `pi/projects/<project-key>/` when present. It excludes system skills, credentials, caches, project identity, and runtime state. Do not use a broad home-directory copy or delete remote files outside the managed allowlist.
6. Review before staging:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff -- codex/AGENTS.md codex/hooks codex/rules codex/skills \
     pi/AGENTS.md pi/settings.json pi/skills pi/bin pi/projects ccb/ccb.config ccb/projects
   ```

   Confirm every changed path is portable configuration. Stop if a credential, runtime file, unrelated file, or unexpected deletion appears. Resolve conflicts deliberately; do not use `git reset --hard`, `git checkout --`, or `git push --force`.
7. If there is no diff, do not create an empty commit. Report that the remote is already up to date.
8. Stage only the managed export allowlist, review `git diff --cached`, and commit with a concise message describing the configuration change. Do not use `git add -A`:

   ```bash
   git add -- \
     codex/AGENTS.md codex/hooks codex/rules codex/skills \
     pi/AGENTS.md pi/settings.json pi/skills pi/bin pi/projects ccb/ccb.config ccb/projects
   git diff --cached --check
   git diff --cached
   git commit -m "chore: sync agent settings"
   ```

9. Push `main` to `origin`. If HTTPS authentication is unavailable but an already configured GitHub SSH identity succeeds, push once with `git@github.com:rholin33/agent-setting.git` without changing unrelated remotes. Never print or expose credentials.
10. Verify `git status --short --branch`, the resulting commit, and the remote `main` SHA with `git ls-remote https://github.com/rholin33/agent-setting.git refs/heads/main`.

## Failure Handling

- Keep backups produced by the sync hook and report their paths when a merge cannot be completed. They normally live under `$CODEX_HOME/.sync/codex-setting/backups/`.
- If authentication, network access, an incomplete configuration, a logged hook failure, or a non-fast-forward update blocks the operation, leave the checkout unchanged and report the exact blocking command and relevant log path.
- A successful run must state whether a commit was created, the commit SHA when applicable, and whether the remote branch matches it.
