# Restart with current local credentials

## Overview
`orca-team restart` restarts every configured role in order; `restart ROLE` targets one role. Original panes and conversations are retained.

## Design and state
Each role uses the existing project lock, verifies idle state, sends one exit, verifies a shell, then launches the original conversation through the installed launcher. Busy or unverified roles are reported while other roles continue; any failure returns nonzero. Restart intent and pending markers preserve ambiguous operations.

## Credentials
New provider processes read current local configuration. Codex roles with piProvider read the latest Pi models.json key at launch. Ordinary Codex uses its local authentication/configuration. Restart does not change credential files or update keys inherited from an unchanged parent shell environment.

## Verification
59 tests pass. Whole-team live run restarted all nine roles; master initially required binding reconciliation. After the Pi launch-wrapper verification fix, master restart returned success directly. All nine original conversations were verified after the whole-team run. Single-role simple restart also passed. No credential values were changed for testing.

## UI
No new UI; terminal output reports each role.

Restart focuses the target desktop pane before waiting for idle and sending exit, and reasserts focus during exit verification. This is required on macOS where background renderer input can be delayed.

## Selecting roles and groups
`orca-team restart coder` selects coder1 and coder2. `orca-team restart coder1 coder2` selects both explicitly. Targets are validated before any restart and duplicates removed. Exact role names take precedence over same-named groups for compatibility. All roles remain the default with no targets.

Verification: 60 tests pass; coder group live restart succeeded for both roles. Reported intermittent exit-not-verified was not reproduced in this run and is not claimed resolved by argument parsing changes.
