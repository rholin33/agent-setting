# Unified orca-team command

## Overview and user flow

Run `orca-team` from a project directory. It opens Orca if needed, reads local model choices, checks Codex, Pi and OMP updates before launch, restarts every role that is currently running with the configured agent, model, and thinking level while keeping its original conversation, then reconciles the six configured groups and starts or resumes the remaining roles. `orca-team --group TITLE` limits the operation to one group. `start` is a compatibility alias; `restart ROLE` remains an explicit forced restart of a single role.

## State and safety

Project `config.json` defines groups; `state.json` records panes, exact provider sessions, and `appliedModel`. Missing panes are created or resumed. An idle shell with a verified saved session resumes that conversation. Every role whose pane currently runs its provider agent is restarted with the selected agent, model, and thinking level, so a team recovered by Orca itself is normalized by one `orca-team` call. Panes that hold a plain shell or cannot be verified are left for the startup phase instead of being restarted twice in the same run. Busy or unverified roles are left intact and reported as incomplete with a nonzero exit. The existing project lock serializes each mutation. The update prehook stops verified managed roles before updating and restores their exact sessions afterward, including after update failure. Without lifecycle management, running agents defer updates; OMP process state is checked again immediately before updating.

OMP transcripts may start with one `title` metadata record (version 1 or unversioned) before the original `session` header. Recovery reads that header within a bounded 1 MiB prefix and still verifies the exact saved conversation ID and project. A title alone, an unknown title version, or a foreign conversation/project does not authorize recovery. Transcripts are not rewritten and no fresh conversation fallback is introduced.

OMP transcripts may start with one `title` metadata record (version 1 or unversioned) before the original `session` header. Recovery reads that header within a bounded 1 MiB prefix and still verifies the exact saved conversation ID and project. A title alone, an unknown title version, or a foreign conversation/project does not authorize recovery. Transcripts are not rewritten and no fresh conversation fallback is introduced.

The command restarts each running role in its own pane and keeps the conversation, so invoking it does not discard in-flight context. Users running it inside that role's own terminal should use another terminal if they need to keep the invoking process alive.

## Interfaces and persistence

The CLI remains the interface; there is no backend or frontend API. Quick commands invoke the default command with `--group TITLE`. Model choices are saved in `team.json` and `pi-models.json`; the role's last applied configuration remains in `state.json`. Existing transcripts and pane bindings are preserved.

## Verification and limits

The Node test suite covers the picker, role recovery, restart guards, quick command registration, reload semantics, and macOS process inspection. The default command was run from the Revisited project directory with all nine roles, restarting the running ones in their original panes; roles that were mid-turn were reported as incomplete and succeeded when restarted individually. Orca tab pinning remains optional and may report an unapplied warning on desktop versions that acknowledge `setTabProps` without applying it.


## Agent program and extension updates

On every start, the prehook checks each distinct agent type used by the selected roles. Codex and Pi program versions are compared with npm. Pi runs `pi update --extensions` even when its program is current. OMP runs `omp update`, followed by `omp update --plugins`, including Magic Context registered with OMP. Both OMP command outputs are shown separately. Explicit restart also runs the prehook.

Pi and OMP maintain separate extension installations. Updating Pi alone does not update OMP. OMP updates cover plugins registered with its plugin manager, not arbitrary unused package copies. Agent update commands are restricted to fixed templates; OMP uses the same resolved executable as role launch. No new configuration fields, database changes or UI are introduced.

Regression coverage includes OMP update ordering, duplicate agent deduplication, program/plugin output, a process appearing before update, and restoring sessions after plugin update failure. Verification: `node --test tests/agent-update.test.mjs tests/omp.test.mjs tests/omp-macos.test.mjs tests/update-lifecycle.test.mjs` passed 25 tests; the full `npm test` suite passed all 179 tests. Live managed-role shutdown/update/resume has not been executed for this change; macOS remains covered by simulated tests.
