# Unified orca-team command

## Overview and user flow

Run `orca-team` from a project directory. It opens Orca if needed, checks Pi updates before the first Pi launch, reads local model choices, reconciles the six configured groups, then applies model or thinking changes to running roles. `orca-team --group TITLE` limits the operation to one group. `start` is a compatibility alias; `restart ROLE` remains an explicit forced restart.

## State and safety

Project `config.json` defines groups; `state.json` records panes, exact provider sessions, and `appliedModel`. Missing panes are created or resumed. An idle shell with a verified saved session resumes that conversation. A running role is restarted only if `appliedModel` differs from the selected agent, model, or thinking. Busy or unverified roles are left intact and reported as pending with a nonzero exit. The existing project lock serializes each mutation. Pi updates are deferred while a Pi pane in the project is live.

The command does not close an active role merely because it was invoked. It can restart an idle role after a real configuration change. Users running it inside that role's own terminal should use another terminal if they need to keep the invoking process alive.

## Interfaces and persistence

The CLI remains the interface; there is no backend or frontend API. Quick commands invoke the default command with `--group TITLE`. Model choices are saved in `team.json` and `pi-models.json`; the role's last applied configuration remains in `state.json`. Existing transcripts and pane bindings are preserved.

## Verification and limits

The Node test suite covers the picker, role recovery, restart guards, quick command registration, and macOS process inspection. The default command was run from the Revisited project directory with all eight existing roles and reported no restart when their applied settings matched. A live configuration-change restart was not forced during active project work. Orca tab pinning remains optional and may report an unapplied warning on desktop version 1.4.201.
