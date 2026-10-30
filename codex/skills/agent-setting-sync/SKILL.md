---
name: agent-setting-sync
description: Use when the user invokes agent-setting-sync, asks to synchronize the agent-setting repository, or uses the legacy codex-sync alias. Requires an explicit ccb or orca target; proactively merge changes and require push authorization before publishing.
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
An explicit target push request authorizes the publication workflow. A later
confirmation of a concrete merge-and-push proposal also authorizes that workflow
for the stated target, repositories and reviewed changes. Confirmation to merge
alone does not authorize pushing. "Sync", "update", and force alone never
authorize export/staging/commit/push. A default invocation ends after applying
and verifying local configuration unless the user confirms publication.

## Paths And Scope

Capture the user's original project directory before changing directories.
Pass it through AGENT_SETTING_PROJECT_ROOT. Resolve CODEX_HOME (default ~/.codex),
PI_CODING_AGENT_DIR (default ~/.pi/agent), CCB_HOME (default ~/.ccb), and
ORCA_TEAM_HOME (default ~/.orca/roles/ccb-team), CLAUDE_CONFIG_DIR (default ~/.claude). Python 3 runs the shared sync
implementation on Windows, macOS and Linux; use python on Windows or python3
where available. No Bash or PowerShell dependency is required for the sync core.

The managed checkout is $CODEX_HOME/.sync/codex-setting/remote. Verify its origin
and main branch; clone the canonical remote there if absent. A dirty checkout,
staged changes or unpublished commits trigger proactive reconciliation below,
not an immediate refusal. Stop for an origin mismatch or detached/non-main branch.
Preserve existing merge state and inspect it before attempting another merge.
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

Orca scope: team/layout/model/context configuration, role prompts, portable
project layouts, and a repository-owned runtime version pin.
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

1. Verify checkout/origin/branch, preserve the original project root and
   reconcile local changes using Proactive Reconciliation below.
2. Run the checkout hook with the selected target:

   python codex/hooks/sync-codex-setting.py --target orca

   Replace orca with ccb when selected; add --force only for explicit force.
   The hook fetches/fast-forwards, validates, backs up and merges managed files.
   It applies `codex/AGENTS.<target>.md`, the selected target's variant, to the
   global Codex `AGENTS.md`. Do not invoke an older installed hook that lacks target support.
3. Require exit success and review the current run's sync log at
   $CODEX_HOME/log/agent-setting-sync.log. Conflicts or incomplete configuration
   enter Proactive Reconciliation below; do not stop at reporting a conflict.
   Export/staging/commit/push still require publication authorization.
4. For Orca, follow the pinned source README.md to register the installed package's local
   shell/quick-command entries. Registration is distinct from starting agents;
   never launch a team merely to synchronize configuration. Preserve unrelated
   shortcuts and user shell profile content.
5. Report target, applied files, backups and limitations. Report "no commit or
   push" when publication was not authorized; otherwise report the verified
   publication result.

## Proactive Reconciliation

Apply this to both configuration and Orca runtime repositories, and to managed
live-file conflicts. Local edits alone are not a reason to stop.

1. Inventory tracked, staged, untracked and unpublished changes; preserve their
   contents and the original index before mutations. Fetch upstream even when
   the working tree is dirty so freshness is known. Classify selected/common
   changes separately from credentials, runtime state and unrelated files.
2. Prepare a three-way merge from the common ancestor or verified sync baseline.
   Use an isolated task directory under the OS temporary directory when the
   original checkout is dirty; preserve untracked files and same-path additions.
   Do not reset, clean, overwrite, automatically commit, or rewrite local history
   to obtain a clean tree. A temporary copy or stash is preservation, not a
   completed merge or publication. Clean up disposable merge artifacts after use.
3. Proactively combine independent changes and review the result. Apply verified
   conflict-free live-file merges with backups when ordinary pull permits them.
   Preserve local-only checkout work; reconcile it back without changing the
   existing staged/unstaged selection. Do not publish or advance the runtime pin
   without authorization. If the installer requires a clean/published source,
   prepare the reviewed publication proposal rather than bypassing its guard.
4. For actual conflicts (including semantic conflicts, deletions or competing
   additions), show each path, local and upstream intent, a concrete proposed
   resolution and its effect. Offer 2-3 options when useful, with a recommendation.
   Prepare a reviewable diff in isolation before asking. Ask once for confirmation
   of the stated resolutions; explicitly include repositories and push scope if
   publication is needed. Keep unrelated work moving while awaiting the answer.
5. After confirmation, apply the agreed merge, run relevant checks, then commit
   and push only when the existing request or that confirmation authorizes it.
   Follow the complete runtime/configuration export and verification workflows;
   publish runtime first and configuration second. New conflicts or scope changes
   require a new proposal. Without push authorization, retain reviewed local
   changes, report what remains, and do not commit or push. After publication,
   verify remote SHAs, reconcile live files and refresh only the published baseline.

## Complete Push Policy

An authorized publication publishes every valid, reviewed local change in the selected target and common scope. Do not silently narrow it to the most recent feature or a convenient subset. Exclusions for credentials, runtime state, unselected targets and repository-owned bootstrap files still apply.

Before publishing, inventory the entire export and classify every difference. Merge overlapping upstream changes instead of replacing newer remote code with older local copies. Preserve current local model choices unless the user requests otherwise. If a decision prevents publishing the full allowed scope, explain the exact unresolved items and resolve them with the user before pushing; a partial push requires explicit user approval. A stash or backup preserves data but does not count as publishing it.

After a successful push, verify the remote SHA, reconcile any reviewed merge-only changes back into the corresponding live managed files with backups, and verify live configuration against the published result. Update the synchronization baseline only to the verified remote snapshot, never to local unpublished content. Do not leave a successful partial or full publication described as complete while live files and the baseline are unintentionally divergent. Report any deliberate local-only differences and preserved checkout edits separately. Never restart agents merely to align configuration.

## Separate Orca Runtime Repository

Orca uses two repositories: configuration in rholin33/agent-setting and private
runtime source in https://github.com/rholin33/orca-team.git. `orca/runtime.json`
pins a reviewed full commit. Source checkout: `$CODEX_HOME/.sync/orca-team/source`
(or `ORCA_SOURCE_REPO`). Runtime bin/lib/source/tests/docs/remote-master belong
only to the source repository. Configuration retains team/layout/models/context,
role prompts and project layouts. Complete skills still include their helpers.

Every Orca pull fetches source main, validates the pin and checks local runtime
edits before installing the pinned code. Report pinned SHA, source main SHA,
update_available and upstream_checked. A newer source main is reported for review;
never silently advance the pin or claim both repositories are current. Network
failure stops normal sync. Explicit offline installation may use the cached pin
but must report upstream freshness unverified. Runtime updates preserve config,
back up code and never restart agents. New source files and local edits cannot be
silently overwritten, even with force. CCB does not fetch/install Orca.

Every authorized Orca publication checks both repositories before config export:

1. Run `python scripts/sync-orca-runtime.py --check`. If live code differs or
   source main is newer, inspect the source checkout and retain backups.
2. With a clean source main checkout, run
   `python scripts/sync-orca-runtime.py --push`. This exports the entire runtime
   and merges nonoverlapping upstream/local file changes. Overlapping edits or
   deletions require explicit resolution; never ignore a file to pass.
3. Review every source diff and untracked path, run `node --test tests/*.test.mjs`
   in the source checkout, stage exact reviewed paths there. Run configuration
   checkout `python scripts/sync-orca-runtime.py --verify-index` before committing
   source, then `--verify-head` before its ordinary `git push origin main`.
   These checks use the full runtime export manifest. No changes needs no commit.
4. Verify source remote SHA, then run `python scripts/sync-orca-runtime.py
   --pin-published` (one command). It reconciles reviewed upstream-only changes
   with backups, checks complete live content and updates the configuration pin.
5. Continue the full configuration push below, including the changed runtime pin.
   Its index/HEAD checks also verify the runtime repository. Publish runtime first,
   configuration second. If the second push fails, report runtime published but
   configuration pending; retain the pin and retry without claiming completion.

Source code development should happen in the source checkout. Dirty checkout or
unpublished commits trigger Proactive Reconciliation; inspect and attempt a
three-way merge before asking the user to intervene. The installer clean-checkout
guard remains in force: if reviewed local runtime changes require publication
before installation, prepare a concrete merge-and-push proposal and obtain
authorization instead of bypassing the guard or silently dropping local changes.
Legacy live patches can use the full runtime export workflow above once
publication is authorized.
After successful two-repository sync, report both SHAs and refresh the baseline
only from verified published configuration. Existing active sessions stay intact.

## Authorized Publication

Use this workflow after an explicit target push request or confirmation of a
concrete merge-and-push proposal.

1. Verify target, origin/main and original project root. Reconcile existing
   checkout edits first; preserve unrelated files and staged state.
2. Fetch and merge upstream changes using Proactive Reconciliation. Do NOT apply
   remote files to the live home first: CCB's authoritative pull could erase the
   user's intended upload.
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
   Retain conflicting data/backups; propose resolutions and obtain confirmation
   before applying conflicting changes.
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

   Then git push origin main. Existing publication authorization needs no second
   routine approval. If a concurrent update rejects the push, fetch and prepare
   a new merge; obtain confirmation for any new conflicts, rerun verification
   and retry once. Stop and report if rejected again. Never force-push or rewrite
   existing history. The checker never stages, commits or pushes.
7. Verify local commit SHA and git ls-remote origin refs/heads/main. Report the
   manifest file count, verification results, commit, push result and remaining
   local changes. Exported/stashed files are not published files. Reconcile live
   files and the verified remote baseline as required by Complete Push Policy.

The pre-commit hook validates staged whitespace only. It must never export or
stage local settings automatically, even during an unrelated development commit.

Orca sync also manages `orca/omp-context.json` (OMP native auto-compaction disabled; Magic Context owns compression) and `cortexkit/magic-context.jsonc` → `${XDG_CONFIG_HOME:-~/.config}/cortexkit/magic-context.jsonc`. Historian/dreamer model choices are portable; credentials, service URLs, absolute paths and runtime databases are rejected. CCB sync excludes these files. Existing OMP sessions need an exact-session restart to load the overlay; sync does not restart agents.
