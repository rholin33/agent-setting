# Agent Settings

Portable Codex/Pi configuration plus one explicitly selected orchestration host:
CCB or Orca. Canonical remote: https://github.com/rholin33/agent-setting.

## Sync Through The Skill

Use one of these forms:

- `$agent-setting-sync ccb`: pull/merge common configuration and CCB.
- `$agent-setting-sync orca`: pull/merge common configuration and Orca.
- Append `force` to back up and apply remote files to this machine.
- Append `push` to export local configuration, review, commit and push.

A target is mandatory and mutually exclusive. `force` cannot combine with
`push`. Without explicit `push`, no export, staging, commit or push occurs.
The legacy `codex-sync` alias follows the same rules. Untargeted SessionStart
does nothing, so starting an agent cannot accidentally select CCB or Orca.
The pre-commit hook only checks staged whitespace; it never exports or stages.

## Install From A Checkout

Orca, Pi, Codex, model services and credentials are already configured.
Python 3 runs configuration sync on all platforms; Orca team management requires
Node.js 22+. No rsync dependency is required.

```text
python scripts/install-config.py --target orca --quick-commands
python scripts/install-config.py --target ccb
```

Use `python3` where that is the Python 3 executable. Windows also has
`./install.ps1 -Target orca -QuickCommands`; macOS/Linux have
`./install.sh --target orca --quick-commands`. Add `--force` only when remote
files should replace divergent local managed files with backups.

Orca installation generates local shell entry scripts and optionally registers
nine global quick commands. Follow the printed shell profile/PATH instruction
once; then run `orca-team` from any project. See [Orca guide](orca/README.md).
Or pass `--shell-profile PATH` to register a backed-up managed block directly
(Windows wrapper: `-ShellProfile $PROFILE`; zsh: `$HOME/.zshrc`; bash: `$HOME/.bashrc`).

Installation applies files from this checkout without Git commits or pushes.
It preserves local files absent from the package. It does not configure provider
accounts or model services. CCB role resources may be installed with --skip-tools.

## Portable And Local Files

| Repository | Purpose |
| --- | --- |
| codex/ | Shared instructions, hooks, rules and non-system skills |
| pi/ | Shared instructions, settings, skills and launch helper |
| ccb/, roles/ | CCB configuration and role bootstrap |
| orca/ | Orca team manager, nine role prompts and 199 original role resources |
| scripts/ | Cross-platform install/export entry points |
| docs/features/orca-ccb-sync.md | Scope, design and validation |

CCB selection includes current-project CCB configuration and project
`pi/settings.json`. Generated agent provider settings are excluded.
Orca selection includes portable project layout overrides, but never pane IDs,
state.json, locks, transcripts, generated machine paths or shortcut backups.
Common configuration excludes local-only `cad-fill-dimension-report` skills.

Environment overrides: `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `CCB_HOME`,
`ORCA_TEAM_HOME`; `AGENT_SETTING_PROJECT_ROOT` preserves the invoking project.
`AGENT_SETTING_PROJECT_KEY` explicitly binds the same project across machines.
Orca otherwise uses a project identity file or normalized Git origin; a project
without either falls back to a machine-specific path hash.
Runtime state is not transferred to a new machine. New machines rebuild pane
identities and shortcuts; original-conversation transfer is a separate concern.

## Explicit Export

Only after an explicit push request:

```text
python scripts/sync-local-config.py --target orca --push --project /path/to/project
```

The exporter itself never commits or pushes. Review the exact changed files,
stage only approved portable paths, commit, then push. Never apply remote CCB
configuration to the live home before exporting intended local changes.

## Verification

```text
python -m unittest discover -s tests -v
node --test orca/tests/*.test.mjs
```

Tests use isolated homes and mocked Orca. Native macOS/Linux desktop acceptance
and closing business conversations are not part of these tests.
