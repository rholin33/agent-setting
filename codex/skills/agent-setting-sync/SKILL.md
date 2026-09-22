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
ORCA_TEAM_HOME (default ~/.orca/roles/ccb-team). Python 3 runs the shared sync
implementation on Windows, macOS and Linux; use python on Windows or python3
where available. No Bash or PowerShell dependency is required for the sync core.

The managed checkout is $CODEX_HOME/.sync/codex-setting/remote. Verify its origin
and main branch; clone the canonical remote there if absent. Stop on a dirty
checkout, detached/non-main branch, staged changes or unresolved merge.
Do not discard changes to make synchronization proceed.

Common scope: target-selected Codex AGENTS.md variants codex/AGENTS.ccb.md and
codex/AGENTS.orca.md (each run syncs only its own variant to the global
~/.codex/AGENTS.md), codex/hooks/, codex/rules/, codex/skills/ excluding .system
and caches; pi/AGENTS.md, pi/settings.json, pi/skills/, pi/bin/.
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
   "no commit or push". Automatic SessionStart without a target is a no-op.

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
5. Stage only the exact reviewed changed paths, never git add -A or a blanket
   root directory. Review git diff --cached and --cached --check. If no changes,
   report no commit; do not create an empty commit.
6. Commit with a concise configuration-change message, then git push origin main.
   Explicit push authorizes this workflow; do not ask a second routine approval.
   A rejected/non-fast-forward push stops without force or history rewriting.
7. Verify local commit SHA and git ls-remote origin refs/heads/main. Report the
   commit, push result and remaining local changes; do not claim success from
   command launch alone.

The pre-commit hook validates staged whitespace only. It must never export or
stage local settings automatically, even during an unrelated development commit.
