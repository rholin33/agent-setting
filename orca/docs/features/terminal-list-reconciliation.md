# Terminal list reconciliation

Full `orca-team` / `start` and untargeted `restart` reconcile the local project terminal list after successful recovery. As of 2026-10-28, ordinary startup preserves every additional terminal; it does not authorize closing them.

## Behavior

The configured role panes and remote binding records form the retained set. Original local return conversations, remote Claude presentation panes and adapter/service bindings are retained. Unregistered terminals are also retained: they can host development services, repair agents or user work. The internal reconciliation API accepts explicit close targets bound to both terminal handle and incarnation; ordinary startup supplies none. Native transcript files are not deleted.

## Implementation and persistence

`lib/list-reconcile.mjs` verifies a complete local inventory, every configured role pane and each explicitly selected terminal's current incarnation before closing. Pending handoffs prevent cleanup. The project startup lock serializes reconciliation. Binding records are read without changing owners or remote configuration. Each invocation records its plan, successful closes and final verification under `projects/<key>/list-reconciliation/`. Repeated execution with the same list closes nothing.

No application backend or frontend API changes. Existing title/layout behavior is unchanged.

## Verification

2026-10-28: 529 tests, 519 passed, 10 skipped, no failures. Added regression coverage for unregistered terminals surviving ordinary startup and stale close targets preserving replacement terminal instances. Live reconciliation retained all current team terminals and closed zero. The earlier cleanup behavior below is historical and is no longer the default.

`node --test tests/*.test.mjs`: 472 passed, 10 skipped, no failures (2026-10-20). Five new tests cover retained remote/return/service panes, idempotence, missing role panes, incomplete inventory, changed incarnations and unconfirmed close.

Live industrial-drawing-translator reconciliation removed eight extras, retained ten local configured role panes plus two remote Claude presentations, and a second invocation removed zero.

## Limits

Cleanup runs after successful full startup, so a failed recovery retains existing terminals for diagnosis. Unknown or changing identity fails cleanup instead of guessing. Remote binding records are conservatively retained; stale protected binding records are not rewritten. The 2026-10-20 publishing snapshot includes the installed local implementation and its tests. Publishing does not itself reconcile or restart terminals.
