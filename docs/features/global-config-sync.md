# Global Configuration Sync

## Feature Overview

Define the authoritative local-to-remote synchronization boundary for the Codex and CCB global configuration repository.

## Supported Capabilities

- Pull the managed configuration from the remote repository during `SessionStart`.
- Export the local global configuration into the repository before a remote commit.
- Limit synchronization to `ccb/ccb.config`, `hooks/`, `rules/`, `skills/`, and the global `AGENTS.md`.
- Exclude credentials, runtime state, caches, generated agent state, and other machine-local artifacts.

## Workflow

1. SessionStart runs the existing remote-to-local merge hook.
2. The repository pre-commit hook runs `scripts/sync-local-config.sh` and stages the managed paths.
3. The operator reviews the resulting diff and commits the synchronized configuration.
4. The operator pushes the reviewed commit to the remote repository.

## Interfaces

- Repository export command: `scripts/sync-local-config.sh`.
- Remote-to-local hook: `hooks/sync-codex-setting.py`.
- Repository commit hook: `.githooks/pre-commit`.
- Hook activation: `install.sh` sets `core.hooksPath` to `.githooks`.

## Data Model

The managed path set is the five-path boundary described above. `ccb/roles.json` and `hooks.json` remain repository bootstrap metadata and are not sourced from the local global configuration export.

## Verification

- `./scripts/sync-local-config.sh` completed successfully and produced no configuration drift.
- `./.githooks/pre-commit` completed successfully and staged only the managed paths.
- `bash -n scripts/sync-local-config.sh .githooks/pre-commit install.sh` passed.
- Python compilation of `hooks/sync-codex-setting.py` passed.
- `git diff --check` passed.

## Known Limitations

- Export and commit are local operations; the SessionStart hook does not commit or push to GitHub automatically.
- `hooks.json` and `ccb/roles.json` remain repository bootstrap metadata and require explicit review if changed.
