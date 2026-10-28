# Orca runtime repository separation

## Scope

The approved design separates private `rholin33/orca-team` source from
`rholin33/agent-setting` configuration. Existing history stays intact. Full skills
remain in configuration, including their executable helpers. Team, models, layout,
role prompts and project layouts remain user configuration. Runtime source,
tests, bundled original resources and runtime documentation move to the source
repository. Example defaults in the source repository support standalone tests.

## Sync contract

`orca/runtime.json` pins the canonical source URL and a full commit SHA.
Every Orca pull checks source main, installs the reviewed pin, reports newer
upstream versions and refuses to overwrite unpublished local runtime edits.
Configuration push also checks runtime sources. Publish reviewed runtime changes
first, verify their remote commit, then update the pin and publish configuration.
Never silently publish only one half or automatically follow an unreviewed branch.

Installation writes only runtime-owned paths, with backups and a receipt of
installed digests. User configuration and active sessions are preserved. No
restart, provider installation, credentials transfer or Git history rewrite.
Cached pinned source can be used for explicitly offline installation; normal
sync must check upstream and report network failure honestly.

## Implementation and verification

Implemented: `codex/hooks/orca_runtime.py` for pin validation, upstream checks,
source inventory and installation; `scripts/sync-orca-runtime.py` for explicit
runtime export, inspection and pin update. Existing sync/install/export entry
points invoke these checks. Test isolated installs, repeat installs, updates,
dirty source refusal, invalid pin, runtime exclusion from configuration and
independent source tests. No UI or database changes.

Source repository is private and published at `9da237b09bcd7573e1bd184f64c670bae2f73120`. Validation: 47 Python sync/runtime tests, 4 exclusions and 12 completeness checks passed. Independent source tests: 533 pass, 10 platform skips, no failures. Three repository sync skill copies passed quick validation. Local runtime check matches the pinned remote commit; no sessions were restarted.

352 runtime files moved; 199 original resources retain their exact hashes. Earlier history remains in agent-setting. The source root includes example defaults for independent testing; installer does not overwrite personal configuration with them. Legacy removed runtime paths in the old sync baseline are ignored by the new scope.

Runtime helper commands: `--check`, `--push`, `--verify-index`, `--verify-head`, `--pin-published`. Source export records a full manifest in its Git directory. Pinning requires verified source main and matching live contents or the unchanged reviewed merge manifest; reviewed upstream-only edits are backed up and reconciled. Source and configuration pushes are sequential, not atomic; partial publication must be reported and retried.

Known limits: file-level divergent edits require manual merge; deletions require explicit review. Normal sync checks the newest main but installs only the pin. Git credentials are machine-local, and new machines need read access to both private repositories.

Fresh online acceptance: cloned the private source into an empty temporary home, installed pinned code and personal configuration, generated launchers, and verified CCB remained untouched. Source clone inherits only the configuration repository credential username; credentials remain in the machine helper.
