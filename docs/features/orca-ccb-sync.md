# Selective CCB and Orca Configuration Sync

## Scope

Develop an explicit `ccb` or `orca` selector. Both selections include common
Codex/Pi portable configuration; only the selected orchestration configuration
is applied or exported. Provider installation and credentials are out of scope.
Default operation pulls and merges into the current machine. Only explicit
`push` permits export, staging, committing and pushing after review.

## Implementation Plan

- [x] Gate sync/export and legacy entry points on one target.
- [x] Preserve existing CCB merges and isolate target-specific snapshots.
- [x] Package all 199 Orca role resources and nine role definitions.
- [x] Implement portable team initialization, launch, layout, locking and resume.
- [x] Generate machine-specific shell and Orca shortcut entries.
- [x] Test target isolation, explicit push, resource integrity and OS adapters.
- [x] Update skill instructions, install documentation and verification results.

## Data Boundaries

Portable templates and role definitions belong in `orca/`. Per-machine project
state, terminal identities, transcript bindings, locks and shortcut backups do
not belong in Git. Project layout configuration is portable only after removing
machine-local workspace paths. No changes to provider login/configuration.

## Verification

Commands: `python -m unittest discover -s tests -v`,
`python scripts/test-sync-exclusions.py`, `node --test orca/tests/*.test.mjs`.
Coverage includes isolated fresh-machine installation, common/target boundaries,
mandatory target and explicit push, invalid origin, conflicts without baseline
advance, excluded runtime files, 199 exact resource hashes, shell profile
registration, fresh/repeated launch, left/right/both-pane resume and wrong IDs.
Read-only status and portable layout export succeeded against the actual sewpg
workspace without creating or restarting agents. Native macOS/Linux desktop and
live close/resume are not verified. No live installation, commit or push made.

## User Interfaces

Skill forms: `agent-setting-sync ccb`, `agent-setting-sync orca`, and
either target followed by `push` or `force`. `force` and `push` cannot combine.
No selector means no synchronization. Automatic SessionStart must not guess one.

## Persistence And Migration

`ORCA_TEAM_HOME` selects the local team deployment. Per-project config and state
remain below its `projects/<path-hash>/`; `start.node.lock` avoids the persistent
empty lock used by the old PowerShell manager. Do not run both managers together.
Orca project layout sync writes `<project>/.orca/team.json`. Start validates that
override and backs up changed local config while retaining state and sessions.
Removing a role from layout does not stop its existing terminal.

Use `AGENT_SETTING_PROJECT_KEY` for an explicit stable portable project identity.
Orca also reads `.orca/project.identity.json` with `project_slug`, existing CCB
identity for compatibility, or derives identity from normalized Git origin.
Without these, the path-hash fallback is machine-specific. Runtime path hashes
remain intentionally local and are not the portable sync key.

Shell registration is opt-in with `--shell-profile PATH`; quick commands with
`--quick-commands`. Both preserve unrelated entries and make local backups.
Historical receipts and one-time Windows repair tools stay on the original
machine; `orca/docs/history.md` inventories replacements. Byte-preserving Git
attributes protect original role resources across Windows line-ending settings.

## Limitations

Recovery hardening records new Pi launch intent before terminal creation and
passes an explicit transcript path plus a no-tools initialization prompt.
Pending is cleared only after validated transcript and live binding evidence.
Interrupted startup reconciliation never resends input. Replay of an existing
role launcher defaults to its saved conversation. `history --role NAME` exposes
the fixed binding, source and last verification time. No schema migration or
task-session reassignment is performed. Native Codex fresh binding still depends
on Orca exposing its provider session; failure remains pending.

This change does not install an Orca application-start hook or provide new
POSIX process inspection. Users invoke `orca-team`
after reopening; POSIX recovery still requires complete Orca evidence. Those
capabilities require additional host integration and real platform acceptance.

Connected-pane recovery now uses `terminal.inspectProcess` with incarnation and
freshness checks. Only proven idle shells accept an exact resume command;
unverifiable results are reported and never injected into. Windows Orca 1.4.202
uses a POSIX-only inspection path; the manager now reads local terminal-host v36
inventory and two CIM process snapshots instead. It checks pane identity, process
creation times and Windows session boundaries. Unknown protocol versions fail
closed. Tests cover false child booleans, PID reuse, replaced panes, changing
process trees, same-pane send and pending retention. Native sewpg inspection
distinguished the existing loader Pi from eight idle shells.

Windows sewpg acceptance restored master, coder1, coder2, designer, reviewer and
test in their existing panes with exact original session arguments. Loader was
reused. Archi and simple had no saved original conversation and were refused;
the command correctly exited nonzero rather than claiming all nine were ready.
Active Pi transcript paths and Codex resume IDs can confirm recovery when Orca
removes its sleeping-session record. An interrupted launch clears pending only
after this exact live-session proof and transcript validation, without resending.
Master's restored history showed context overflow and cancelled compaction;
conversation restoration does not verify model response readiness.

Restoring only the left pane can reverse left/right ordering. Missing or changed
provider bindings refuse fresh-session fallback. Different branches with the
same origin share a portable layout key unless explicitly overridden. New
machines do not inherit pane IDs or conversation files. Sync is not transactional
across all files: a failure preserves backups and does not advance its baseline,
but earlier successfully merged files can already have been applied.

## Unified Recovery Entry

`orca-team` initializes/reconciles the current project; `status` inspects it;
`history [ROLE]` shows fixed-role bindings and indexed task sessions; `restart ROLE` gracefully exits
one idle provider and resumes its exact conversation in the existing pane.
Restart uses the project lock and persists `restartIntent` before exit input.
Ambiguous exit is never resent; unconfirmed resume retains pending state.
PowerShell `.ps1` profile registration works on all three platforms.
There is no background watcher or application-open hook. Native POSIX inspection
remains outstanding; macOS/Linux GUI behavior has
not been validated. Restart tests cover Pi/Codex success, busy refusal, changed
session refusal, sibling preservation and ambiguous transport without resend.

Windows sewpg acceptance: all nine roles reported live bindings; `restart archi`
completed in its original pane with unchanged session ID, and `history archi`
reported process-argument proof with pending=false. 30 Node and 18 Python tests
passed. Live Codex restart and real macOS/Linux restart remain untested.

## Task Conversation Index

`history` refreshes local `projects/<key>/history.json` under the project lock.
Run and worker lists are paginated; local workspace identity restricts discovery.
Pi and Codex JSONL user messages provide exact Task/Dispatch/worker preamble
associations, including multiple attempts and reused sessions. Fixed roles and
task sessions stay separate. Role links distinguish task creator from worker;
unproven roles are not inferred from task titles. `history --cached` works offline.
Refresh preserves cached discoveries, exposes incomplete metadata and missing
files, and does not rewrite state.json or transcripts. The existing projects/
sync exclusion includes this index. No prompt text or capabilities are persisted.
Standard provider roots, environment overrides and known session directories are
supported; remote filesystem discovery and symlink traversal are not supported.

Validation: 32 Node tests and two sync exclusion tests pass. Initial sewpg refresh
found 22 dispatch attempts, all with local transcripts and no scan warnings.
Path/entry tests cover Windows/macOS/Linux; the history implementation uses
portable Node APIs, with actual execution verified on Windows only.
