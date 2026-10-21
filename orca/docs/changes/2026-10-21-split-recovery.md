# Interrupted Codex split recovery (2026-10-21)

Orca may create a split and its native agent but time out before returning the
terminal handle. Sleeping-pane records can lag fresh Codex sessions. Recovery now
requires a unique connected new leaf in the original creation-intent tab, matching
workspace, verified native agent and validated original session or launch marker.
Ambiguous panes remain blocked. No replacement session or repeated split is sent.

Validation: 497 tests, 487 passed, 10 skipped, zero failures. Real startup recovered
coder2 without replacing its conversation, reused the first four roles and created
the remaining eight. Desktop layout verification passed. Optional tab pinning is
not applied by the current Orca desktop and remains a warning.
