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
The legacy `codex-sync` alias follows the same rules. No SessionStart hook is
registered: starting an agent never synchronizes or selects CCB or Orca.
The pre-commit hook only checks staged whitespace; it never exports or stages.

## Separate Orca Runtime

Runtime source, tests and bundled role resources live in the private
[rholin33/orca-team](https://github.com/rholin33/orca-team) repository.
`orca/runtime.json` locks its exact commit; `orca/` here retains personal settings
and role prompts. Skills remain complete, including their executable helpers.

Every Orca sync checks source upstream and local code before applying the pinned
version. Newer source commits are reported for review; unpublished live changes
stop the operation. Ordinary sync requires network access to both repositories.
For explicit offline installation, `scripts/install-config.py --target orca
--offline` uses an existing cache and reports that upstream was not checked.

Before a full configuration push, run `python scripts/sync-orca-runtime.py --check`.
Runtime changes use `--push`, review/test, exact staging, `--verify-index`, source
commit, `--verify-head`, source push, then `--pin-published`. Configuration is
published only after the source commit is verified remotely. Both repositories
must be accounted for; see [migration and contract](docs/features/orca-runtime-repository.md).

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
once; then run `orca-team` from any project. See [Orca source guide](https://github.com/rholin33/orca-team).
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
| orca/ | Team/layout/model configuration, role prompts, project layouts and runtime commit pin |
| scripts/ | Cross-platform install/export entry points |
| docs/features/orca-ccb-sync.md | Scope, design and validation |

CCB selection includes current-project CCB configuration and project
`pi/settings.json`. Generated agent provider settings are excluded.
Orca selection includes portable project layout overrides, but never pane IDs,
state.json, locks, transcripts, generated machine paths or shortcut backups.
Common configuration excludes local-only `cad-fill-dimension-report` skills.
Claude Code common configuration is `claude/CLAUDE.md` and `claude/skills/`
(→ `~/.claude`). `settings.json` stays local because it carries machine-specific
hooks; `skills/synced/` is managed by the claude.ai account and is never copied.

Environment overrides: `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`, `CCB_HOME`,
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
stage every reviewed portable change, verify the complete index, commit, verify
HEAD, then push. Never apply remote CCB
configuration to the live home before exporting intended local changes.

```text
python scripts/sync-local-config.py --target orca --verify-index --project /path/to/project
# Commit only after the index check succeeds.
python scripts/sync-local-config.py --target orca --verify-head --project /path/to/project
# Push only after the HEAD check succeeds.
```

Use the same target, project and home overrides as the export. The manifest in
the Git directory survives stash and detects missing/new skills and stale content.
See [complete push verification](docs/features/global-config-sync.md#complete-push-verification).

Export validates all candidate Python, JSON and skill documents before writing
any files, including the sync hook itself. Invalid or concatenated documents stop
the export. Machine approval rules, legacy sync launchers, Pi tool binaries,
coverage output and local legacy backups are excluded. Orca project layouts are
exported only when the invoking project has a saved runtime config or an explicit
`.orca/team.json`; a global layout fallback does not create a project entry.

Text merges normalize CRLF/LF before a regular three-way merge. Conflicts retain
the local file and save the remote candidate in the backup directory without
advancing the baseline. Merged Python, JSON and skill documents are validated
before installation.

## Verification

```text
python -m unittest discover -s tests -v
python scripts/test-sync-exclusions.py
python scripts/test-sync-completeness.py
# In the separate orca-team source checkout:
node --test tests/*.test.mjs
```

Tests use isolated homes and mocked Orca. Native macOS/Linux desktop acceptance
and closing business conversations are not part of these tests.

Orca sync also manages `orca/omp-context.json` (OMP native auto-compaction disabled; Magic Context owns compression) and `cortexkit/magic-context.jsonc` → `${XDG_CONFIG_HOME:-~/.config}/cortexkit/magic-context.jsonc`. Historian/dreamer model choices are portable; credentials, service URLs, absolute paths and runtime databases are rejected. CCB sync excludes these files. Existing OMP sessions need an exact-session restart to load the overlay; sync does not restart agents.
