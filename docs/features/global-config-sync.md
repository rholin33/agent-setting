# Global Configuration Sync

Define the authoritative synchronization boundary for the Codex, Pi, and CCB global configuration repository.

## Supported Capabilities

- Pull the managed configuration from the remote repository during Codex `SessionStart`.
- Synchronize separate `codex/` and `pi/` configuration trees to their corresponding local directories.
- Export the local Codex and Pi global configuration into the repository before a remote commit.
- Verify Pi `AGENTS.md`, `settings.json`, and `skills/` before installing declared Pi extension packages.
- Limit synchronization to portable instructions, hooks, rules, selected skills, Pi settings, and `ccb/ccb.config`.
- Exclude credentials, runtime state, caches, generated agent state, and other machine-local artifacts.

## Workflow

1. Codex `SessionStart` runs the remote-to-local synchronization hook.
2. The hook pulls the remote baseline, validates `codex/` and `pi/`, merges managed files, installs missing CCB Roles, and installs missing Pi extension packages from `pi/settings.json`.
3. The repository pre-commit hook runs `scripts/sync-local-config.sh` and stages the managed paths.
4. The operator reviews the resulting diff, commits the synchronized configuration, and pushes the reviewed commit.

## Interfaces

- Repository export command: `scripts/sync-local-config.sh`.
- Remote-to-local hook: `codex/hooks/sync-codex-setting.py`.
- Codex hook registration: `codex/hooks.json`.
- Repository commit hook: `.githooks/pre-commit`.
- Hook activation: `install.sh` sets `core.hooksPath` to `.githooks`.

## Data Model

Codex configuration is stored under `codex/` and maps to `$CODEX_HOME`. Pi configuration is stored under `pi/` and maps to `$PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. CCB configuration remains under `ccb/` and maps `ccb/ccb.config` to `$CCB_HOME/ccb.config`; the current project's `.ccb/ccb.config` is also synchronized under `ccb/projects/<project-key>/ccb.config`, including when `.ccb/` has not yet been generated. Project identity is read from `.ccb/project.identity.json` or `ccb/project.identity.json`, while provider state and other generated `.ccb/` files remain local-only.

Pi extension source strings live in `pi/settings.json`. The hook does not synchronize Pi npm caches, auth files, sessions, or generated extension state; it calls `pi install` only for package sources that are configured but not installed.

`codex/hooks.json` and `ccb/roles.json` remain repository bootstrap metadata. The `.system` Codex skills and generated `.ccb/agents/` state are never synchronized.

## Verification

- `./scripts/sync-local-config.sh` completes successfully and exports both configuration trees.
- Pi settings parse as a JSON object with a valid `packages` array.
- The remote-to-local hook validates that `codex/AGENTS.md`, Codex directories, `pi/AGENTS.md`, `pi/settings.json`, and a non-empty `pi/skills/` directory exist.
- `bash -n scripts/sync-local-config.sh .githooks/pre-commit install.sh` passes.
- Python compilation of `codex/hooks/sync-codex-setting.py` passes.
- `git diff --check` passes.
- The staged diff contains only portable configuration paths.

## Known Limitations

- The SessionStart hook runs from Codex and also restores Pi configuration; Pi does not run this Python hook independently.
- Export and commit are local operations; the SessionStart hook does not commit or push to GitHub automatically.
- Missing or unavailable Pi packages are logged and retried on a later Codex startup.
- `codex/hooks.json` and `ccb/roles.json` require explicit review when changed because they are bootstrap metadata rather than local export output.
