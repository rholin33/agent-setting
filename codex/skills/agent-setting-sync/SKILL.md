---
name: agent-setting-sync
description: Use when the user invokes agent-setting-sync, asks to synchronize the agent-setting repository, or uses the legacy codex-sync alias. Requires an explicit ccb or orca target; explicit push is required to publish local configuration.
---

# Agent Settings Sync

Repository: https://github.com/rholin33/agent-setting.git, branch main.
Preserve unrelated files. Never force-push, copy credentials, or synchronize
runtime state. Provider CLIs, model services and login are already configured.

## Required Invocation

| Request | Behavior |
| --- | --- |
| agent-setting-sync ccb | Pull and merge common Codex/Pi plus CCB into this machine |
| agent-setting-sync orca | Pull and merge common Codex/Pi plus Orca into this machine |
| agent-setting-sync ccb force | Back up and apply remote CCB/common files |
| agent-setting-sync orca force | Back up and apply remote Orca/common files |
| agent-setting-sync ccb push | Export, review, commit and push CCB/common files |
| agent-setting-sync orca push | Export, review, commit and push Orca/common files |

Require exactly one target. Missing target: ask "Sync ccb or orca?" before any
mutation. Both targets, unknown modes, or force plus push: reject the request.
Do not infer target from the current application, existing folders or past runs.
Only the literal explicit push request authorizes local export/staging/commit/push.
"Sync", "update", and force never authorize those steps. A default invocation
ends after applying and verifying local configuration, even if local edits exist.

## Paths And Scope

Capture the user's original project directory before changing directories.
Pass it through AGENT_SETTING_PROJECT_ROOT. Resolve CODEX_HOME (default ~/.codex),
PI_CODING_AGENT_DIR (default ~/.pi/agent), CCB_HOME (default ~/.ccb), and
ORCA_TEAM_HOME (default ~/.orca/roles/ccb-team), CLAUDE_CONFIG_DIR (default ~/.claude). Python 3 runs the shared sync
implementation on Windows, macOS and Linux; use python on Windows or python3
where available. No Bash or PowerShell dependency is required for the sync core.

The managed checkout is $CODEX_HOME/.sync/codex-setting/remote. Verify its origin
and main branch; clone the canonical remote there if absent. Stop on a dirty
checkout, detached/non-main branch, staged changes or unresolved merge.
Do not discard changes to make synchronization proceed.

Common scope: target-selected Codex AGENTS.md variants codex/AGENTS.ccb.md and
codex/AGENTS.orca.md (each run syncs only its own variant to the global
~/.codex/AGENTS.md), codex/hooks/, codex/rules/, codex/skills/ excluding .system
and caches; pi/AGENTS.md, pi/settings.json, pi/skills/, pi/bin/; claude/CLAUDE.md and
claude/skills/ excluding skills/synced (claude.ai-managed). Claude settings.json
is local-only (machine hooks) and is never exported.
CCB scope: ccb/ccb.config and the current project's ccb/projects configuration
and pi/projects settings. CCB role bootstrap in roles/ and ccb/roles.json belongs
only to CCB. Orca mode must not apply CCB config, install CCB roles, or touch
.ccb provider-state settings. CCB mode must not apply or export orca/.

Orca scope: portable orca/ team package, all original source role resources,
nine prompt templates, team/layout definitions and portable project layouts.
Recreate shell launchers and Orca shortcuts for the destination machine.
Never export generated launchers with absolute local paths, Orca profile data,
quick-command backups, project state.json, locks, pane IDs, transcript bindings,
transcripts, logs, auth files or accounts. Existing local historical files remain
local; no broad directory copy or destructive mirror.

Bootstrap files (hooks.json, scripts/, install entry points and repository docs)
are repository-owned: do not overwrite them by exporting arbitrary home files.
Model names and thinking levels in team.json are portable; service endpoints and
credentials are not part of the Orca package.

## Pull Or Force

1. Verify clean checkout/origin/branch and preserve the original project root.
2. Run the checkout hook with the selected target:

   python codex/hooks/sync-codex-setting.py --target orca

   Replace orca with ccb when selected; add --force only for explicit force.
   The hook fetches/fast-forwards, validates, backs up and merges managed files.
   It applies `codex/AGENTS.<target>.md`, the selected target's variant, to the
   global Codex `AGENTS.md`. Do not invoke an older installed hook that lacks target support.
3. Require exit success and review the current run's sync log at
   $CODEX_HOME/log/agent-setting-sync.log. Conflicts or incomplete configuration
   stop the workflow. Do not call export, git add, git commit or git push.
4. For Orca, follow orca/README.md to register the installed package's local
   shell/quick-command entries. Registration is distinct from starting agents;
   never launch a team merely to synchronize configuration. Preserve unrelated
   shortcuts and user shell profile content.
5. Report target, applied files, backups and limitations. Explicitly report
   "no commit or push".

## Complete Push Policy

An explicit target push publishes every valid, reviewed local change in the selected target and common scope. Do not silently narrow it to the most recent feature or a convenient subset. Exclusions for credentials, runtime state, unselected targets and repository-owned bootstrap files still apply.

Before publishing, inventory the entire export and classify every difference. Merge overlapping upstream changes instead of replacing newer remote code with older local copies. Preserve current local model choices unless the user requests otherwise. If a decision prevents publishing the full allowed scope, explain the exact unresolved items and resolve them with the user before pushing; a partial push requires explicit user approval. A stash or backup preserves data but does not count as publishing it.

After a successful push, verify the remote SHA, reconcile any reviewed merge-only changes back into the corresponding live managed files with backups, and verify live configuration against the published result. Update the synchronization baseline only to the verified remote snapshot, never to local unpublished content. Do not leave a successful partial or full publication described as complete while live files and the baseline are unintentionally divergent. Report any deliberate local-only differences and preserved checkout edits separately. Never restart agents merely to align configuration.

## Explicit Push Only

1. Verify target, clean checkout, origin/main and original project root.
2. Fetch and fast-forward the checkout. Do NOT apply remote files to the live
   home first: CCB's authoritative pull could erase the user's intended upload.
3. Export only the selected/common scope:

   python scripts/sync-local-config.py --target orca --push

   Replace orca with ccb when selected. Pass AGENT_SETTING_PROJECT_ROOT explicitly.
   Export never commits or pushes itself; it must not mutate source config. The
   exporter writes the global Codex `AGENTS.md` to `codex/AGENTS.<target>.md` for
   the selected target and skips it when the global file matches the other
   target's variant.
4. Review git status --short, git diff --check and the full changed-file list.
   Inspect the actual diff before staging. Reject secrets, runtime state,
   unselected-target changes, unexplained deletions or unrelated paths.
   Retain conflicting data/backups; do not resolve silently.
5. Stage every exact reviewed changed path, never git add -A or a blanket
   root directory. Review git diff --cached and --cached --check. Require:

   python scripts/sync-local-config.py --target orca --verify-index

   Use the same target, project and home overrides as the export. The export
   manifest lives in the Git directory and survives stash. The check compares
   all exported files (including new skills/references) with the index, and
   rejects live source changes since export. Fix every reported omission before
   continuing. If no changes, report no commit; do not create an empty commit.
   A reviewed upstream merge must be backed up and reconciled into the relevant
   live files, then fully re-exported/reviewed. Do not edit the manifest or bypass
   the check to publish a subset. Review extra staged paths separately.
6. Commit with a concise configuration-change message. Before pushing, require:

   python scripts/sync-local-config.py --target orca --verify-head

   Then git push origin main. Explicit push authorizes this workflow; do not ask
   a second routine approval. A rejected/non-fast-forward push stops without
   force or history rewriting. The checker never stages, commits or pushes.
7. Verify local commit SHA and git ls-remote origin refs/heads/main. Report the
   manifest file count, verification results, commit, push result and remaining
   local changes. Exported/stashed files are not published files. Reconcile live
   files and the verified remote baseline as required by Complete Push Policy.

The pre-commit hook validates staged whitespace only. It must never export or
stage local settings automatically, even during an unrelated development commit.

Orca sync also manages `orca/omp-context.json` (OMP native auto-compaction disabled; Magic Context owns compression) and `cortexkit/magic-context.jsonc` → `${XDG_CONFIG_HOME:-~/.config}/cortexkit/magic-context.jsonc`. Historian/dreamer model choices are portable; credentials, service URLs, absolute paths and runtime databases are rejected. CCB sync excludes these files. Existing OMP sessions need an exact-session restart to load the overlay; sync does not restart agents.
