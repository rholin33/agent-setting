---
name: codex-sync
description: Synchronize portable local Codex and CCB configuration with https://github.com/rholin33/codex-setting using a pull, merge, review, commit, and push workflow. Use when the user explicitly invokes $codex-sync or asks to merge local Codex settings with that remote repository and publish the verified result. Exclude credentials, runtime state, ~/.codex/config.toml, system skills, and unrelated files.
---

# Codex Sync

Synchronize only the portable configuration managed by `codex-setting`. Preserve unrelated local changes, stop on ambiguous conflicts or sensitive-file changes, and never force-push.

## Scope

Resolve paths from `CODEX_HOME` and `CCB_HOME`, defaulting to `~/.codex` and `~/.ccb`:

- Checkout: `$CODEX_HOME/.sync/codex-setting/remote`
- Remote: `https://github.com/rholin33/codex-setting.git`, branch `main`
- Managed Codex paths: `AGENTS.md`, `hooks.json`, `rules/`, `skills/`, and `hooks/`
- Managed CCB path: `$CCB_HOME/ccb.config` exported as `ccb/ccb.config`

Never stage `auth.json`, `config.toml`, history, databases, logs, sessions, shell snapshots, temporary files, `ccb/agents/`, or `skills/.system/`.

## Workflow

1. Resolve `CODEX_HOME` and `CCB_HOME`. Verify that the checkout exists, its `origin` points to `rholin33/codex-setting`, and its current branch is `main`.
2. Check the checkout with `git status --short`. Stop if it has local changes or an unresolved merge; do not overwrite them.
3. Run `git fetch origin` followed by `git pull --ff-only`.
4. Run the repository's sync hook when present:

   ```bash
   python3 "$CODEX_HOME/hooks/sync-codex-setting.py"
   ```

   Read the sync log afterward. Treat a logged sync failure or an unresolved merge as a stop condition. The hook provides the remote baseline and merges remote changes into the live local files before export.

5. Export the live local managed files into the checkout. Use `rsync -a` or equivalent, excluding `skills/.system/`; map `$CCB_HOME/ccb.config` to `ccb/ccb.config`. Do not use a broad home-directory copy and do not delete remote files automatically.
6. Review the result before staging:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff -- AGENTS.md hooks.json rules skills hooks ccb/ccb.config
   ```

   Confirm that every changed path is portable configuration. Stop if a credential, runtime file, unrelated file, or unexpected deletion appears. Resolve textual conflicts deliberately; do not use `git reset --hard`, `git checkout --`, or `git push --force`.

7. If there is no diff, do not create an empty commit. Report that the remote is already up to date.
8. Stage only the managed allowlist, review `git diff --cached`, and commit with a concise message describing the configuration change. Do not use `git add -A`.
9. Push `main` to `origin`. If HTTPS authentication is unavailable but an already configured GitHub SSH identity succeeds, push once with `git@github.com:rholin33/codex-setting.git` without changing unrelated remotes. Never print or expose credentials.
10. Verify `git status --short --branch`, the resulting commit, and the remote `main` SHA with `git ls-remote`.

## Failure Handling

- Keep any backups produced by the sync hook; report their paths when a merge cannot be completed.
- If authentication, network access, or a non-fast-forward update blocks the operation, leave the checkout unchanged and report the exact blocking command.
- A successful run must state whether a commit was created, the commit SHA when applicable, and whether the remote branch matches it.
