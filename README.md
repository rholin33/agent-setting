# Codex Global Config

This repository stores portable Codex global configuration that is safe to sync across machines.

## Contents

- `AGENTS.md`: global Codex instructions.
- `hooks.json`: user-level Codex lifecycle hook registration.
- `skills/`: globally installed non-system skills.
- `rules/`: global reusable rules.
- `hooks/`: user-level Codex lifecycle hooks.
- `ccb/ccb.config`: portable CCB agent and window configuration.
- `ccb/roles.json`: Role packages required by the portable CCB configuration.
- `scripts/sync-local-config.sh`: exports the local global configuration into this repository.
- `.githooks/pre-commit`: refreshes and stages the managed configuration before every commit.
- `install.sh`: installs this repository into `$CODEX_HOME`, defaulting to `~/.codex`.

Do not store Codex or CCB runtime state here, such as credentials, history, sqlite databases, logs, sessions, agent state, backups, or shell snapshots.
CCB regenerates `.ccb/agents/` from `ccb.config`; do not copy or commit that directory because it contains project paths, runtime bindings, task history, and provider state.

## Synchronization Boundary

The local global configuration is the source for exactly these repository paths:

| Local source | Repository path |
| --- | --- |
| `${CCB_HOME:-~/.ccb}/ccb.config` | `ccb/ccb.config` |
| `$CODEX_HOME/hooks/` | `hooks/` |
| `$CODEX_HOME/rules/` | `rules/` |
| `$CODEX_HOME/skills/` | `skills/` |
| `$CODEX_HOME/AGENTS.md` | `AGENTS.md` |

The export excludes system skills, OS metadata, Python caches, coverage databases, and other generated artifacts. `hooks.json` and `ccb/roles.json` are repository bootstrap metadata; they are not copied from the local global configuration export.

## Automatic Sync

The `SessionStart` hook pulls this repository and synchronizes only the boundary above into the local machine. It treats `ccb/ccb.config` as remote-authoritative and installs it into `${CCB_HOME:-~/.ccb}/ccb.config`, backing up a different local copy first and preserving user-only file permissions. `AGENTS.md`, `hooks/`, `rules/`, and `skills/` use a three-way merge against the last remote snapshot; conflicts keep the local file and save the remote copy under the sync backup directory.

The hook installs Role packages declared in `ccb/roles.json` with `--skip-tools`. Successful installations are recorded per device; unavailable or timed-out packages are logged and retried on later sessions without blocking Codex startup.

The hook does not commit or push to GitHub. It does not reload or restart CCB. A running CCB project keeps its mounted service graph until the operator applies a supported reload or starts CCB again. Generated `.ccb/agents/` directories are never synchronized.

## Install On A Machine

```bash
cd ~/projects/codex-global
chmod +x install.sh
./install.sh
```

Restart Codex after installing so new or changed skills and hooks are loaded.

`install.sh` also enables `.githooks/pre-commit` for this checkout. If the repository was installed before that hook was added, enable it once with:

```bash
git config core.hooksPath .githooks
```

## Commit From This Machine

Every commit intended for the remote repository must first export the local global configuration. The pre-commit hook performs this automatically and stages the managed paths:

```bash
./scripts/sync-local-config.sh
git diff -- AGENTS.md ccb/ccb.config hooks rules skills
git add -- AGENTS.md ccb/ccb.config hooks rules skills
git commit
git push origin main
```

The explicit export command is useful for reviewing the diff before committing. The pre-commit hook repeats it so a commit cannot omit current local changes from the managed configuration. Review and push the resulting commit; the hook never pushes automatically.
