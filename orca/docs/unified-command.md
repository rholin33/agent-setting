# Unified orca-team command

## Overview and user flow

Run `orca-team` from a project directory. It opens Orca if needed, reads local model choices, merges local Pi/OMP model catalogs and checks agent updates before launch. Running roles with matching applied configuration are reused; changed roles retain their original conversation when restarted with the same agent. The command then restores configured groups and starts or resumes missing roles. `orca-team --group TITLE` limits the operation to one group. `start` is a compatibility alias; `restart ROLE` remains an explicit forced restart of a single role.

## State and safety

Project `config.json` defines groups; `state.json` records panes, exact provider sessions, and `appliedModel`. Missing panes are created or resumed. An idle shell with a verified saved session resumes that conversation. Startup compares each role's applied agent, model and thinking before deciding whether a restart is needed. Busy or unverified roles that require restart are left intact and reported as incomplete with a nonzero exit. The existing project lock serializes each mutation. Automatic package updates defer while that CLI has running processes. Explicit `orca-team update` stops verified managed roles and restores their exact sessions afterward, including after update failure.

OMP transcripts may start with one `title` metadata record (version 1 or unversioned) before the original `session` header. Recovery reads that header within a bounded 1 MiB prefix and still verifies the exact saved conversation ID and project. A title alone, an unknown title version, or a foreign conversation/project does not authorize recovery. Transcripts are not rewritten and no fresh conversation fallback is introduced.

A successful full start or untargeted restart also reconciles the project terminal list: panes outside the configured team and protected remote bindings are closed after identity checks. See [terminal list reconciliation](features/terminal-list-reconciliation.md). Run these commands from a separate terminal when the invoking terminal must remain open.

## Interfaces and persistence

The CLI remains the interface; there is no backend or frontend API. Quick commands invoke the default command with `--group TITLE`. The picker has separate agent/model columns; Tab selects a column and Left/Right changes its value. Model choices are saved in `team.json` and `pi-models.json` or `omp-models.json`; the role's last applied configuration remains in `state.json`. Existing transcripts and configured pane bindings are preserved.

## Verification and limits

The Node test suite covers the picker, catalog merge, role recovery, restart guards, terminal reconciliation, quick command registration, reload semantics, and macOS process inspection. The 2026-10-20 publishing snapshot passed 472 tests with 10 platform skips. No live package update or team restart was performed as part of publishing. Orca tab pinning remains optional and may report an unapplied warning on desktop versions that acknowledge `setTabProps` without applying it.


## Agent program and extension updates

Start/restart merges local Pi/OMP catalogs even when no newer CLI exists or the version cache is fresh. Version checks are cached for 24 hours; an available update is installed only when that CLI is idle. Explicit `orca-team update` clears the check cache and performs managed stop/update/resume. Its Pi maintenance runs `pi update --extensions` even when the program is current. OMP maintenance runs `omp update`, followed by `omp update --plugins`, including Magic Context registered with OMP. Both OMP command outputs are shown separately.

Pi and OMP maintain separate extension installations. Updating Pi alone does not update OMP. OMP updates cover plugins registered with its plugin manager, not arbitrary unused package copies. Agent update commands are restricted to fixed templates; OMP uses the same resolved executable as role launch. No new configuration fields, database changes or UI are introduced.

Regression coverage includes OMP update ordering, duplicate agent deduplication, program/plugin output, a process appearing before update, restoring sessions after plugin update failure, and catalog sync with a fresh update cache. macOS behavior remains covered by simulated tests.
