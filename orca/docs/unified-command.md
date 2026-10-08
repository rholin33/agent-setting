# Unified orca-team command

## Overview and user flow

Run `orca-team` from a project directory. It opens Orca if needed, checks Pi updates before the first Pi launch, reads local model choices, restarts every role that is currently running with the configured agent, model, and thinking level while keeping its original conversation, then reconciles the six configured groups and starts or resumes the remaining roles. `orca-team --group TITLE` limits the operation to one group. `start` is a compatibility alias; `restart ROLE` remains an explicit forced restart of a single role.

## State and safety

Project `config.json` defines groups; `state.json` records panes, exact provider sessions, and `appliedModel`. Missing panes are created or resumed. An idle shell with a verified saved session resumes that conversation. Every role whose pane currently runs its provider agent is restarted with the selected agent, model, and thinking level, so a team recovered by Orca itself is normalized by one `orca-team` call. Panes that hold a plain shell or cannot be verified are left for the startup phase instead of being restarted twice in the same run. Busy or unverified roles are left intact and reported as incomplete with a nonzero exit. The existing project lock serializes each mutation. Pi updates are deferred while a Pi pane in the project is live.

The command restarts each running role in its own pane and keeps the conversation, so invoking it does not discard in-flight context. Users running it inside that role's own terminal should use another terminal if they need to keep the invoking process alive.

## Interfaces and persistence

The CLI remains the interface; there is no backend or frontend API. Quick commands invoke the default command with `--group TITLE`. Model choices are saved in `team.json` and `pi-models.json`; the role's last applied configuration remains in `state.json`. Existing transcripts and pane bindings are preserved.

## Verification and limits

The Node test suite covers the picker, role recovery, restart guards, quick command registration, reload semantics, and macOS process inspection. The default command was run from the Revisited project directory with all nine roles, restarting the running ones in their original panes; roles that were mid-turn were reported as incomplete and succeeded when restarted individually. Orca tab pinning remains optional and may report an unapplied warning on desktop versions that acknowledge `setTabProps` without applying it.
