# Orca CLI selection

Startup should let each role select Claude Code, Codex, or its existing Pi/OMP presets.
Provider choices are saved only on confirmation; cancellation and --no-pick retain them.
Codex uses local model configuration. Claude uses native model aliases and valid effort levels.
Existing conversations cannot cross provider boundaries; switching CLI hands off a mechanical transcript extract to a new conversation.

The picker now includes native Claude sonnet/opus/haiku aliases and local Codex model/effort next to Pi/OMP presets. Left/Right or Tab switches choices; comma/period cycles provider-compatible effort. `team.json` and the existing model selection file retain the confirmed agent/model/thinking. All-Claude teams still show the picker. Existing bound or pending sessions refuse a provider change before saving.

Implementation: `orca/lib/model-picker.mjs`, `model-sync.mjs`, startup session guards in `orca/bin/orca-team.mjs`. Transcript validation retains the local OMP version-1 title prelude and adds Claude metadata scanning.

Verification: `node --test orca/tests/*.test.mjs` passed 196 tests; `git diff --check` passed. Local installation via `scripts/install-config.py --target orca` succeeded, with executable launchers regenerated and implementation bytes verified. Conflict originals are backed up in the installed package's backups directory. No live agents were launched or restarted, and no commit or push was performed.

Limitations: live Claude startup was not exercised. Cross-provider conversation conversion is unsupported; a stopped role requires explicit `orca-team start --fresh ROLE` before switching CLI. Existing quick commands invoke the same installed entry point and skip the interactive picker when no TTY is available.

## CLI switch handoff

Confirming a different CLI for a role with a saved conversation no longer requires `--fresh`. `syncModels` reports the switches through `prepareSwitches` before saving `team.json`. `switchProviders` in `orca/lib/handoff.mjs` stops running roles with their original CLI (`restartRoles` with `stopOnly`), requires the pane to be a shell, and renders a handoff from the original transcript (omp/pi, Codex and Claude formats; active branch only; about 60k characters). It then clears `session`/`launchIntent` and records `handoff` in `state.json`. Startup creates the new conversation in the existing pane. The first message (pi/omp, Claude) or the appended role prompt (Codex) instructs the role to read the handoff. A failure to stop or verify a role aborts before the selection is saved.

Verification: `node --test orca/tests/*.test.mjs` passed 203 tests. Rendering was checked against real omp (36 MB), Codex and Claude transcripts. No live roles were switched.
