# Restart with current local credentials

## Overview
`orca-team restart` restarts every configured role; `restart ROLE` targets one role. Original panes and conversations are retained. The default `orca-team` command now uses the same restart path: every role whose pane is running its provider agent is restarted with the configured agent, model, and thinking level, so a team that Orca restored on its own is normalized by one invocation.

## Design and state
Each role uses the existing project lock, interrupts the running task, requests graceful exit (with verified-process termination fallback), verifies a shell, then launches the original conversation through the installed launcher. Unverified roles are reported while other roles continue; any failure returns nonzero. Restart intent and pending markers preserve ambiguous operations.

## Credentials
New provider processes read current local configuration. Codex roles with piProvider read the latest Pi models.json key at launch. Ordinary Codex uses its local authentication/configuration. Restart does not change credential files or update keys inherited from an unchanged parent shell environment.

## Verification
The Node suite passes, including reload tests that assert every running role is queued for restart, that none is queued when no pane is live, and that plain shells are left to the startup phase. Live runs restarted all nine roles; roles that were mid-turn reported `agent is busy` or an unverified exit and restarted successfully when retried individually. No credential values were changed for testing.

## UI
No new UI; terminal output reports each role.

Restart focuses the target desktop pane before waiting for idle and sending exit, and reasserts focus during exit verification. This is required on macOS where background renderer input can be delayed.

## Selecting roles and groups
`orca-team restart coder` selects coder1 and coder2. `orca-team restart coder1 coder2` selects both explicitly. Targets are validated before any restart and duplicates removed. Exact role names take precedence over same-named groups for compatibility. All roles remain the default with no targets.

Verification: 60 tests pass; coder group live restart succeeded for both roles. Reported intermittent exit-not-verified was not reproduced in this run and is not claimed resolved by argument parsing changes.

## Six-group layout restoration (2026-10-09)
Default order: master (master | loader), coder (coder1 | coder2), reviewer (reviewer | test), archi, simple, designer. Only two-role tabs split left/right at 50/50; one-role tabs remain unsplit. Start and explicit restart reconcile presentation via session.tabs RPC and verify readback. Unrelated service/editor tabs are retained after team tabs. No pane is created/closed or process restarted by layout reconciliation. Ambiguous/missing panes refuse before mutation.

Live hainanpolicy order and original PTY identities verified; repeat restoration produced zero mutations. Node suite: 104/104. Full desktop restart remains untested because agents are active. Backup: backups/layout-repair-20261009.

## Pi → OMP transition fix (2026-10-10)
Restart retains the source provider in runtime state throughout source-agent validation, idle checks and exit verification. Only a verified shell allows switching to the target catalog provider before exact-session resume. Previously state was marked OMP while Pi still ran, breaking native process verification and subsequent retries. Six stale local runtime records were repaired only after matching original Pi process/session evidence. Added migration success and busy-preservation tests; full suite 180/180.

## Default stop before restart (2026-10-10)
User explicitly requires stopping active agents on every invocation. Default/start no longer reuses matching configurations: all verified running roles use forceExit before exact-session resume. Explicit CLI restart does the same. Existing exitAgent first interrupts, requests graceful exit when idle, then terminates only the verified local provider process tree if needed. Pane shell, original conversation and unrelated processes remain. Master/simple live Pi→OMP migration succeeded with original conversations verified; full suite 180/180.
