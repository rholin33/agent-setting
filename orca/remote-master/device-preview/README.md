# co / Revisited device preview execution configuration

This standalone OMP launcher is separate from `test` and `code_reviewer`.
The original runtime copied `native_omp.py` from the originating team's source
and embedded `/Users/gs/Code/Revisited` as the local MCP root. That adapter has
no remote terminal execution tool. Do not weaken it for all reviewers.

## Source and scope

`policy.json`, `role.md`, `service.py`, and `launch.py` are the source. The
launcher generates only this task's private MCP/overlay under
`~/.orca/device-preview-session-20261022`. It reuses the existing native OMP
plugin-isolation helpers and existing model storage without inspecting or
copying credentials. The model/thinking selection comes from the team's test
row; the role and tool privileges do not.

The only exposed MCP tool accepts an operation enum, no paths, shell strings,
environment variables, arbitrary command arguments, recipients or message bodies.
All terminal commands use fixed argv. General bash/python/file tools, extension,
rule and skill discovery remain off. Only the dedicated MCP is discovered.
This is an application tool boundary, **not an operating-system sandbox**.
Trusted OMP, Orca and WeChat processes retain their normal OS permissions.

Task files are confined to `~/Code/orca-remote/Revisited/device-preview-20261021`.
Traversal, symbolic links, hardlinked files, archive links/devices, duplicate
archive entries and overwrites during extraction are rejected. There is no
upload, trial publication, submission, git, arbitrary write or credential tool.
The project is not a mount or copy of the source worktree.

## Current verification phase

`business_enabled=false` rejects download, extraction, login and preview before
execution. The model cannot change this policy. `download_url=null` adds another
download prerequisite. The package SHA256 is a local observed baseline, not a
sender-authenticated checksum. No command enables the WeChat service port.

`terminal_probe` executes `/bin/pwd -P` in the fixed task directory.
`orca_roundtrip` sends one fixed status message to this new session's own Run,
then checks the same mailbox without acknowledging unrelated mail. Its Run is
created from inside the real Orca terminal, without borrowing `--from`.
Unknown send results preserve an intent and refuse blind retries.
Self-mail proves local durable messaging only; no original remote coordinator
or Dispatch is assumed, and no lifecycle-completion authority is claimed.

## Validation

```sh
python3 service.py --validate
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p test_service.py -v
python3 launch.py --prepare
```

The first command validates this package's own policy schema, not an Orca-wide
configuration. The last writes the task's generated files but starts no model.
Actual OMP startup must still establish MCP connectivity and model tool calls.

First activation, inside a new Orca terminal in the existing Revisited workspace:

```sh
python3 ~/.orca/roles/ccb-team/remote-master/device-preview/launch.py
```

Do not repeat first activation after `binding.json` or `run-intent.json` exists.
They deliberately fence duplicate sessions/Run creation. Inspect the retained
terminal and session; do not delete bindings to force a restart. This package
does not implement automatic resume/recovery. No Orca-wide restart is required.
Old test sessions do not acquire these tools.

## Future business authorization and synchronization

Business execution is not authorized in this repair. Before enabling it, verify
the sender's digest, inspect project settings and CLI side effects (including
dependencies, external paths and project hooks), resolve the service-port issue
with the user, and establish the real destination Run/Dispatch. The current
local message probe is not the future cross-host result-delivery configuration.
Do not enable business execution solely because these configuration tests pass.

Only co's source package was added. The original `/Users/gs` team's source is
not modified. Preserve this reviewed source directory when integrating it back
into that team's `remote-master/` source; never copy the private runtime,
sessions, bindings or model storage. This is not a request to run agent sync.
Future sync/redeployment can replace managed sources, so integrate and review
the source on the originating host before relying on repeated deployment.
No git commit/push, synchronization, provider change or global permission change
was performed. An explicit `agent-setting-sync orca push` would be a separate
publication action, not necessary to keep this already-created co session open.
