# Global Configuration Sync

The current workflow is documented in [Selective CCB and Orca Sync](orca-ccb-sync.md).
Both targets include portable Codex/Pi configuration. Exactly one of `ccb` and
`orca` must be selected; no SessionStart hook runs synchronization.
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

## Complete Push Verification

An explicit push exports every portable local file in the selected target and
common scope. Newly installed skills and their reference files are included;
the export must not be narrowed to the most recent feature. Pull remains a
separate operation and cannot establish that local skills have been published.

The exporter records `agent-setting-export.json` in the checkout's Git directory.
The versioned manifest contains target, absolute repository/project context,
base commit, SHA-256 source digests and Git blob IDs for every export candidate.
It contains no file contents, is not staged, and survives `git stash -u`.
Blob IDs use Git clean filters and also accept exact raw source blobs, covering
repositories with historical CRLF blobs that normal Git staging leaves unchanged.
OS metadata such as `.DS_Store` is excluded from export and completeness checks.

After reviewing and staging every intended change, run:

```text
python scripts/sync-local-config.py --target orca --verify-index --project /path/to/project
```

Require success before committing. After committing, and before pushing, run:

```text
python scripts/sync-local-config.py --target orca --verify-head --project /path/to/project
```

Both checks use the original export environment/project. They compare every
manifest entry against the actual index or HEAD, including unchanged files.
They re-collect live sources without writing to detect added, removed or edited
skills since export. Missing manifests, wrong target/context, changed base,
missing files, non-regular files or wrong blob contents fail with a nonzero exit.
HEAD must be the export base (no changes) or its single-parent direct successor.
The checks never export, stage, commit, push or advance the pull baseline.

If upstream content requires a reviewed merge, back up and reconcile those
specific live files, then repeat the full export and review. Do not edit the
manifest or bypass errors to publish a subset. The pre-commit hook remains a
whitespace check; these explicit checks are mandatory in the sync skill workflow.

Verification: `python scripts/test-sync-completeness.py` covers omitted Obsidian
skills/references, stale index content, stash/subset commits, live source drift,
context/base errors, CCB/common coverage, no-change exports, read-only behavior
and Windows newline conversion. Existing scope and exclusion suites also apply.
Windows validation on 2026-10-29: 12 completeness tests, 4 exclusion tests and
37 existing sync tests passed. All seven updated installed/repository skill
copies passed `quick_validate.py`. A read-only live inventory found 730 portable
files, including all 13 Codex Obsidian skill files; this is not a publication.
The subsequent push review excluded one `.DS_Store`, leaving 729 portable files.

Limitations: this gate proves inclusion/content of export candidates, not review
of extra staged paths or absence of all possible secrets. Review the entire diff
as before. It does not automatically delete remote-only files or install Git
hooks. Direct Git commands can bypass the workflow. Repository-owned scripts
and documentation still require review separately. No UI or runtime changes.
