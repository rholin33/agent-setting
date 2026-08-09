# Agent Global Config

This repository stores portable global configuration for Codex, Pi, and CCB. The repository was originally named `codex-setting`; its canonical remote is now `https://github.com/rholin33/agent-setting`.

## Layout

- `codex/`: Codex global instructions, hooks, rules, and non-system skills.
- `pi/`: Pi global instructions, selected skills, and Pi settings including extension package sources.
- `ccb/`: portable CCB configuration and required Role metadata.
- `roles/`: portable local CCB Role sources installed by the sync and install scripts.
- `hooks/`: not used at the repository root; the Codex sync hook is stored under `codex/hooks/`.
- `scripts/sync-local-config.sh`: exports the live Codex, Pi, and CCB configuration into this repository.
- `.githooks/pre-commit`: refreshes and stages the managed configuration before every commit.
- `install.sh`: installs both Codex and Pi configuration, plus CCB configuration.

Do not store credentials or runtime state here, including Codex auth/history/session data, Pi auth/session/npm caches, sqlite databases, logs, backups, shell snapshots, or generated CCB agent state. CCB regenerates `.ccb/agents/` from its portable configuration; that directory is never synchronized.

## Synchronization Boundary

The local global configuration is the source for these repository paths:

| Local source | Repository path | Notes |
| --- | --- | --- |
| `${CODEX_HOME:-~/.codex}/AGENTS.md` | `codex/AGENTS.md` | Codex global instructions |
| `${CODEX_HOME:-~/.codex}/hooks/` | `codex/hooks/` | Codex lifecycle hooks |
| `${CODEX_HOME:-~/.codex}/rules/` | `codex/rules/` | Codex reusable rules |
| `${CODEX_HOME:-~/.codex}/skills/` | `codex/skills/` | Non-system Codex skills |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/AGENTS.md` | `pi/AGENTS.md` | Pi global instructions |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json` | `pi/settings.json` | Pi settings and extension package sources |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` | `pi/models.json` | Pi custom provider and model definitions without credentials |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/` | `pi/skills/` | Selected Pi skills |
| `${CCB_HOME:-~/.ccb}/ccb.config` | `ccb/ccb.config` | Portable CCB configuration |

`codex/hooks.json` is bootstrap metadata for registering the Codex SessionStart hook. It is tracked in the repository but is not exported from local state. `ccb/roles.json` and `roles/` are also repository-managed bootstrap data.

Codex system skills under `codex/skills/.system/` are excluded from export. Pi package caches, package lock state, authentication files, sessions, and generated extension state are excluded as well. Pi extensions are restored from the package sources in `pi/settings.json`; the sync hook checks Pi `AGENTS.md`, `skills/`, and valid JSON settings before installing missing packages with `pi install`.

## Automatic Sync

The Codex `SessionStart` hook pulls the remote repository and synchronizes both configuration trees and the CCB config. It uses a three-way merge against the last remote snapshot for text files. Pi settings receive a JSON-aware merge: resource keys such as `packages` and `skills` follow the remote configuration when both sides changed, while unrelated local preference keys remain local on conflict.

The hook validates the remote `codex/` and `pi/` layouts before applying them. If Pi is missing `AGENTS.md`, `settings.json`, `models.json`, or a non-empty `skills/` directory, the sync records a failure and does not install Pi extensions. Missing or unavailable Pi packages are logged and retried on a later startup without blocking Codex startup.

The hook installs CCB Role sources and catalog Roles with `--skip-tools` when available. It never commits, pushes, reloads, or restarts CCB or Pi automatically.

## Install On A Machine

```bash
cd ~/projects/agent-setting
chmod +x install.sh
./install.sh
```

The installer copies Codex files into `${CODEX_HOME:-~/.codex}`, Pi files into `${PI_CODING_AGENT_DIR:-~/.pi/agent}`, and CCB config into `${CCB_HOME:-~/.ccb}`. It installs the Pi package sources declared in `pi/settings.json` when the `pi` command is available.

Restart Codex and Pi after installing so new or changed instructions, skills, hooks, and extensions are loaded.

The installer also enables the repository pre-commit hook. If this checkout was installed before the hook was added, enable it once with:

```bash
git config core.hooksPath .githooks
```

## Commit From This Machine

Every commit intended for the remote repository must first export the local configuration. The pre-commit hook repeats the export and stages only managed paths:

```bash
./scripts/sync-local-config.sh
git diff -- codex pi ccb/ccb.config
git add -- codex pi ccb/ccb.config
git commit
git push origin main
```

Review the staged diff before committing. The hook never pushes automatically.
