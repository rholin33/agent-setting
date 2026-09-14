# Global Configuration Sync

The current workflow is documented in [Selective CCB and Orca Sync](orca-ccb-sync.md).
Both targets include portable Codex/Pi configuration. Exactly one of `ccb` and
`orca` must be selected; automatic SessionStart without a target does nothing.
Only explicit `push` permits export, staging, commit and push. The repository
pre-commit hook validates whitespace without exporting or staging files.

Common files map from `codex/` and `pi/` to their configured homes. CCB selection
adds global/current-project CCB config and project `pi/settings.json`, excluding
generated agent settings. Orca selection adds the portable team package and
project layouts, excluding local runtime identities, locks and conversations.

Use `scripts/install-config.py --target ccb|orca` for checked-out installation,
`codex/hooks/sync-codex-setting.py --target ccb|orca` for pull/merge, and
`scripts/sync-local-config.py --target ccb|orca --push` for explicit export.
Python 3 is used across platforms; shell wrappers are optional. Existing role
installation uses CCB `--skip-tools`; provider service/login setup is external.

Verification: `python scripts/test-sync-exclusions.py` retains coverage of
local-only CAD skills and generated provider-state exclusions. See the new
feature document for target isolation and Orca tests.
