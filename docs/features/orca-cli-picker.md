# Orca CLI selection

## Agent/model columns and local catalog sync

The picker separates agent and model columns. Tab/Shift-Tab selects a column and Left/Right edits it; `a` and `m` directly select the agent/model column. Up/Down selects a role. Model edits never change the CLI. Presets are deduplicated and sorted by provider and natural model name (numeric versions included). Switching back to an agent restores that row's previous model and thinking within the menu. Codex model/thinking stay bound to local configuration. Enter confirms; Escape cancels without applying role choices or remote requests.

The Agent update stage merges effective local Pi/OMP model catalogs (Pi `models.json`, OMP `models.yml`/`models.yaml` with legacy JSON fallback). It keeps the union of provider/model IDs, prefers the catalog with more distinct models on conflicts (ties Pi), backs up originals, and preserves role/session ownership. Object fields are merged recursively; model arrays merge by ID and other arrays use a union. Per-model thinking maps are merged; unrelated native settings and runtime files remain local to each CLI. YAML parsing preserves comments on unchanged top-level fields. Invalid configuration aborts before writes, staged writes detect concurrent source changes, and completed writes are rolled back on a write failure. Backups are sibling `.orca-sync-<id>.bak` files.

Both explicit `orca-team update` and the start/restart Agent update stage run this merge, including when no newer CLI exists or the version cache is fresh. Automatic startup retains its existing warning/continue behavior when a sync fails. An explicit update skips package maintenance if configuration sync fails. No network, credential printing or remote configuration export is performed by the merge. Existing sessions are not restarted for configuration-only sync.

Implementation: `orca/lib/model-picker.mjs`, `model-presets.mjs`, `model-sync.mjs`, `local-model-config.mjs`, `agent-update.mjs`, and `orca/bin/orca-team.mjs`. The portable package bundles ISC-licensed `yaml@2.9.1` under `lib/vendor` so deployment does not require npm/Python dependencies. Directories support `ORCA_PI_AGENT_DIR`, `ORCA_OMP_AGENT_DIR`, `PI_CODING_AGENT_DIR`, and OMP profiles; a shared Pi/OMP directory is rejected.

Verification (2026-10-20): full `node --test tests/*.test.mjs` completed with 455 passed, 10 platform skips, 0 failures. Coverage includes column navigation through actual raw Tab input, stable ordering, agent memory, remote continuity, merge conflict preference, backups, idempotency and invalid configuration. Installed files were hash-verified against source. A live Orca preview verified agent-only and model-only edits then Escape; original team/state bytes and all 11 preexisting terminal incarnations were preserved. OMP native `models pay --json --no-extensions` read the updated catalog successfully. Both effective local catalogs contain 2 providers / 6 models; the second merge wrote no files.

Limits: sync covers models/providers and per-model thinking only. It does not mirror native plugin/theme/default-model settings or auth/session stores. No end-to-end live package upgrade or role restart was performed. No service/API/database changes. The local validation above preceded the publishing review.

Startup should let each role select Claude Code, Codex, or its existing Pi/OMP presets.
Provider choices are saved only on confirmation; cancellation and --no-pick retain them.
Codex uses local model configuration. Claude uses native model aliases and valid effort levels.
Existing conversations cannot cross provider boundaries; switching CLI hands off a mechanical transcript extract to a new conversation.

The picker includes native Claude sonnet/opus/haiku aliases and local Codex model/effort next to Pi/OMP presets. The independent agent/model columns described above replace the old combined Left/Right cycle; comma/period cycles provider-compatible effort. `team.json` and the existing model selection file retain confirmed agent/model/thinking. All-Claude teams still show the picker. Bound/pending session safeguards remain in the switch workflow.

Implementation: `orca/lib/model-picker.mjs`, `model-sync.mjs`, startup session guards in `orca/bin/orca-team.mjs`. Transcript validation retains the local OMP version-1 title prelude and adds Claude metadata scanning.

Verification: `node --test orca/tests/*.test.mjs` passed 196 tests; `git diff --check` passed. Local installation via `scripts/install-config.py --target orca` succeeded, with executable launchers regenerated and implementation bytes verified. Conflict originals are backed up in the installed package's backups directory. No live agents were launched or restarted, and no commit or push was performed.

Limitations: live Claude startup was not exercised. Cross-provider raw conversation conversion is unsupported; the handoff workflow below carries context instead. Existing quick commands invoke the same installed entry point and skip the interactive picker when no TTY is available.

Publishing verification (2026-10-20): `node --test orca/tests/*.test.mjs` completed with 472 passed, 10 platform skips and 0 failures. The Python sync suite has 3 Windows path-separator assertion failures and 1 default-encoding error; all four also reproduce on unmodified remote commit `898c4a0`. Publishing does not restart live agents.

## CLI switch handoff

Confirming a different CLI for a role with a saved conversation no longer requires `--fresh`. `syncModels` reports the switches through `prepareSwitches` before saving `team.json`. `switchProviders` in `orca/lib/handoff.mjs` stops running roles with their original CLI (`restartRoles` with `stopOnly`), requires the pane to be a shell, and renders a handoff from the original transcript (omp/pi, Codex and Claude formats; active branch only; about 60k characters). It then clears `session`/`launchIntent` and records `handoff` in `state.json`. Startup creates the new conversation in the existing pane. The first message (pi/omp, Claude) or the appended role prompt (Codex) instructs the role to read the handoff. A failure to stop or verify a role aborts before the selection is saved.

Verification: `node --test orca/tests/*.test.mjs` passed 203 tests. Rendering was checked against real omp (36 MB), Codex and Claude transcripts. No live roles were switched.
