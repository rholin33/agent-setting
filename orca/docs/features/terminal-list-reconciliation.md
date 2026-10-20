# Terminal list reconciliation

Full `orca-team` / `start` and untargeted `restart` now reconcile the local project terminal list after successful recovery. This is automatic and does not ask for cleanup permission.

## Behavior

The configured role panes and remote binding records form the retained set. Original local return conversations, remote Claude presentation panes and adapter/service bindings are retained. Other local terminals in this project are closed through Orca's terminal API. Native transcript files are not deleted. Group-scoped startup/restart and read-only status/history do not prune the whole project.

## Implementation and persistence

`lib/list-reconcile.mjs` verifies a complete local inventory, every configured role pane and each extra terminal's current incarnation before closing. Pending handoffs prevent cleanup. The project startup lock serializes reconciliation. Binding records are read without changing owners or remote configuration. Each invocation records its plan, successful closes and final verification under `projects/<key>/list-reconciliation/`. Repeated execution with the same list closes nothing.

No application backend or frontend API changes. Existing title/layout behavior is unchanged.

## Verification

`node --test tests/*.test.mjs`: 472 passed, 10 skipped, no failures (2026-10-20). Five new tests cover retained remote/return/service panes, idempotence, missing role panes, incomplete inventory, changed incarnations and unconfirmed close.

Live industrial-drawing-translator reconciliation removed eight extras, retained ten local configured role panes plus two remote Claude presentations, and a second invocation removed zero.

## Limits

Cleanup runs after successful full startup, so a failed recovery retains existing terminals for diagnosis. Unknown or changing identity fails cleanup instead of guessing. Remote binding records are conservatively retained; stale protected binding records are not rewritten. The 2026-10-20 publishing snapshot includes the installed local implementation and its tests. Publishing does not itself reconcile or restart terminals.
