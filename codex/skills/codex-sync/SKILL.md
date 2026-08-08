---
name: codex-sync
description: Legacy alias for agent-setting-sync. Use $agent-setting-sync for the current portable Codex, Pi, and CCB synchronization workflow with https://github.com/rholin33/agent-setting.
---

# Legacy Alias

Use `$agent-setting-sync` for the current workflow. This alias remains installed so existing `$codex-sync` requests can be migrated without losing the remote-layout, Pi, and CCB synchronization instructions.

Synchronize only the portable configuration managed by `agent-setting`. Preserve unrelated local changes, stop on ambiguous conflicts or sensitive-file changes, and never force-push.

## Scope

Resolve paths from these environment variables, using the defaults when unset:

- `CODEX_HOME`: `~/.codex`
- `PI_CODING_AGENT_DIR`: `~/.pi/agent`
- `CCB_HOME`: `~/.ccb`

The checkout is `$CODEX_HOME/.sync/codex-setting/remote`. The remote is `https://github.com/rholin33/agent-setting.git` on branch `main`.

Managed Codex paths are stored under `codex/`:

- `codex/AGENTS.md`
- `codex/hooks/`
- `codex/rules/`
- `codex/skills/`

Managed Pi paths are stored under `pi/`:

- `pi/AGENTS.md`
- `pi/settings.json`
- `pi/skills/`

The managed CCB path is `$CCB_HOME/ccb.config` exported as `ccb/ccb.config`.

Do not sync `auth.json`, `config.toml`, history, databases, logs, sessions, shell snapshots, temporary files, `ccb/agents/`, `skills/.system/`, Pi npm package caches, or generated extension state. Pi extensions are represented by the package sources in `pi/settings.json`; the sync hook installs missing packages with `pi install`.

## Workflow

1. Resolve `CODEX_HOME`, `PI_CODING_AGENT_DIR`, and `CCB_HOME`. Verify that the checkout exists, its `origin` points to `rholin33/agent-setting`, and its current branch is `main`.
2. Check the checkout with `git status --short`. Stop if it has local changes or an unresolved merge; do not overwrite them.
3. Run `git fetch origin` followed by `git pull --ff-only`.
4. Run the repository's Codex SessionStart sync hook when present:

   ```bash
   python3 "$CODEX_HOME/hooks/sync-codex-setting.py"
   ```

   Read the sync log afterward. Treat a logged sync failure, an incomplete `pi/` layout, or an unresolved merge as a stop condition. The hook provides the remote baseline, merges remote changes into the live Codex and Pi files, verifies Pi `AGENTS.md`, `skills/`, and `settings.json`, and installs missing Pi extensions.
5. Export the live local managed files into the checkout with:

   ```bash
   ./scripts/sync-local-config.sh
   ```

   The export maps Codex files to `codex/`, Pi files to `pi/`, and `$CCB_HOME/ccb.config` to `ccb/ccb.config`. It excludes system skills and runtime state. Do not use a broad home-directory copy and do not delete remote files outside the managed allowlist.
6. Review the result before staging:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff -- codex pi ccb/ccb.config
   ```

   Confirm that every changed path is portable configuration. Stop if a credential, runtime file, unrelated file, or unexpected deletion appears. Resolve textual conflicts deliberately; do not use `git reset --hard`, `git checkout --`, or `git push --force`.
7. If there is no diff, do not create an empty commit. Report that the remote is already up to date.
8. Stage only the managed allowlist, review `git diff --cached`, and commit with a concise message describing the configuration change. Do not use `git add -A`.
9. Push `main` to `origin`. If HTTPS authentication is unavailable but an already configured GitHub SSH identity succeeds, push once with `git@github.com:rholin33/agent-setting.git` without changing unrelated remotes. Never print or expose credentials.
10. Verify `git status --short --branch`, the resulting commit, and the remote `main` SHA with `git ls-remote`.

## Failure Handling

- Keep any backups produced by the sync hook; report their paths when a merge cannot be completed.
- If authentication, network access, an incomplete Pi configuration, or a non-fast-forward update blocks the operation, leave the checkout unchanged and report the exact blocking command.
- A successful run must state whether a commit was created, the commit SHA when applicable, and whether the remote branch matches it.
