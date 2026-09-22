# Portable Orca Team

The shared package preserves 199 original role resource files and nine adapted prompts. Orca, Pi, Codex, their models and credentials must already be configured. Node.js 22 or later runs the portable manager. No provider settings or credentials are installed.

## Installation

Run `node orca/bin/orca-team.mjs install --quick-commands` from the configuration repository. Omit `--quick-commands` to deploy without writing Orca settings. Deployment defaults to `~/.orca/roles/ccb-team`; `ORCA_TEAM_HOME` or `--home PATH` overrides it. Existing project state is preserved. Quick command registration uses Orca's local authenticated RPC socket, backs up previous commands locally, preserves unrelated commands, and verifies the six grouped entries. Legacy individual-role entries are removed from Orca settings, not from disk.

Windows PowerShell profile entry (use the deployment path if customized):

```powershell
. "$HOME/.orca/roles/ccb-team/bin/orca-team.ps1"
```

macOS zsh or Linux bash profile entry:

```sh
export PATH="$HOME/.orca/roles/ccb-team/bin:$PATH"
```

The installer generates these entry scripts without rewriting existing shell profiles by default. To register the entry in a profile, supply `install --shell-profile PATH` (PowerShell: `--shell-profile "$PROFILE"`; zsh: `--shell-profile "$HOME/.zshrc"`; bash: `--shell-profile "$HOME/.bashrc"`). This backs up the original and adds or updates only the marked orca-team block. Open a new shell afterward. All three platforms use the same manager. The generated command uses the Node executable on the installation machine; rerun install after moving Node or the package.

## Projects

Run `orca-team` in a project directory. This initializes and starts the team. `orca-team status` only inspects existing state; `orca-team init` only initializes. `--project PATH` selects a different project.

`start` first makes sure the Orca app is running: when the runtime metadata is
missing it launches Orca and waits until the CLI answers. It then syncs role
models before launching. Codex roles without a `piProvider` take the top-level
`model` from the local Codex config (`$CODEX_HOME/config.toml`, else
`~/.codex/config.toml`) instead of the model last used by that role. Pi roles are
configured through an interactive picker in the terminal: presets and the last
confirmed selection live in `pi-models.json` next to `team.json` and can be
edited by hand. Starts without a terminal (Orca quick commands, CI) and
`--no-pick` never open the picker and keep `team.json` values unchanged.

Finally `start` reloads the project. Roles whose applied model configuration
(catalogued per role in the project `state.json` as `appliedModel`) differs from
the freshly synced configuration are restarted concurrently under one project
lock and resume their exact conversation; roles already running the current
configuration are kept as-is, so a start with no config change does not restart
anything. Busy, timed-out or unverifiable roles are skipped with a warning so no
in-flight work is lost, and roles whose panes are absent are created or resumed
by the normal startup pass.

```text
orca-team
orca-team status
orca-team history archi
orca-team restart archi
orca-team start --group master
orca-team status --group master
```

Restart accepts one configured role, verifies its original transcript and idle
agent, sends `/quit` once, waits for a proven shell, then resumes the same
conversation in the same pane. It shares the project startup lock. An ambiguous
exit retains `restartIntent` and is not resent. Running `orca-team` after an exit
recovers the original session; an agent still running with an unconfirmed exit
is reported as incomplete. Opening Orca alone does not run this manager: run
`orca-team` once afterward. No watcher or OS startup service is installed.

`orca-team export-config --project PATH` prints the current project configuration without its machine-specific workspace path. This is the read-only interface used when exporting portable project customizations. It prefers runtime config, then `.orca/team.json`, then the default layout.

Default tabs: master / loader, archi, coder1 / coder2, designer, reviewer / test, simple. Slash denotes an equal left/right split (`vertical` in Orca's native representation). The manager activates the primary tab before splitting and validates the actual desktop pane tree afterward. CCB sidebar ratios remain recorded but are not applied because Orca has no matching sidebar API.

Quick commands use `start --group TITLE`, not the internal single-role `launch` action.
They start/recover only the selected group, reuse its existing panes and exact
conversations, and focus it after verification. Group titles must be unique.
Global shortcuts come from `layout.json`; a project that renames/omits a group
rejects that shortcut rather than silently launching a different group.

`pinTabs: true` in `layout.json` requests native Orca pins after successful startup
and layout verification. Existing projects without this key inherit the template;
an explicit project `pinTabs: false` disables automatic pinning (it does not unpin
existing tabs). `init` only writes config; `start` creates and pins the tabs.
The manager verifies the pin state by reading it back, not by trusting an
`updated: true` acknowledgment. An unapplied optional pin reports a warning without
failing agent startup, closing, relaunching, or undoing the existing agents. Some
desktop versions acknowledge `session.tabs.setTabProps` without applying it;
automatic pinning remains unavailable on those versions.
Native pins disable context-menu close and skip bulk UI closes, but are NOT a
hard lock: unpinning or confirming a close shortcut can still close the tab.
This package does not patch Orca, suppress its dialogs, or install a watcher.

Each project gets `projects/<path-hash>/config.json`, `state.json`, and an exclusive startup lock. Config is seeded from `layout.json`. When the project's `.orca/team.json` exists, it is the portable authoritative layout: initialization/start validates it, backs up differing local config, and applies it without replacing state. Without this override, existing project config remains independent of template updates. Windows project keys ignore path case; macOS/Linux keys preserve it. Runtime state records pane IDs, model settings, and exact provider conversation bindings. Locks are removed after successful or failed normal execution. After a process crash, inspect the recorded PID and Orca before manually removing a stale lock; there is no automatic stale-lock takeover.

The portable lock is `start.node.lock`. The predecessor PowerShell manager retained a zero-byte `start.lock` after normal completion; that legacy file is preserved and is not interpreted as an active Node lock. Stop using the old `manage.ps1` entry when adopting the portable entry: the two managers must not be invoked concurrently.

## Recovery And Limits

New managed Pi roles receive a unique transcript path recorded in `launchIntent`
before pane creation, plus a minimal no-tools initialization prompt. A launch
stays pending until its transcript and live provider binding are verified. A
retry reconciles completed launches without sending again; an unconfirmed launch
remains blocked. Existing saved conversations are resumed even when Orca replays
the original `launch` command without `--resume`.

`orca-team history` refreshes `projects/<key>/history.json` and prints fixed-role
bindings plus task/dispatch conversation history. It paginates all Orca Runs
and worker attempts, scopes them to the local project, and matches Pi/Codex user
dispatch preambles to exact Task ID, Dispatch ID and worker handle. Retries and
multiple tasks in one transcript remain separate entries. `history archi`
filters by proven role associations; `roleLinks` distinguishes creator from
worker. Unassociated workers remain visible in the unfiltered output. Titles
and task wording never determine role identity. Old states need no migration.

`orca-team history --cached` reads the index without Orca or transcript scanning.
Normal refresh retains old discoveries if Orca is unavailable or files were
moved/deleted; `cached`, `metadataComplete`, `warnings` and session `available`
report these limitations. Standard Pi/Codex roots, Orca's Codex runtime home,
managed session directories and known binding directories are scanned. Custom
roots follow `PI_CODING_AGENT_DIR` and `CODEX_HOME`. Symlinks are not traversed.
Only index metadata is saved, never full prompts or dispatch capabilities.
Remote-host conversations are outside this local index. It does not change
fixed-role bindings, provider transcripts, Task status or Dispatch authority.
New transcripts under `projects/<key>/sessions/` are local runtime data and
are excluded from synchronization.

Connected panes are inspected using Orca's fenced process evidence. A live shell
with confirmed no children can resume the exact saved conversation in-place;
the prompt and incarnation are rechecked before sending. Input acceptance alone
does not complete recovery: the original binding and agent process must appear.
Unconfirmed recovery retains pending state and is never automatically resent.
Unverifiable process tables (including older Windows hosts returning false child
booleans) block startup success and command injection. A connected shell is not
reported as a running agent. Local Windows uses a read-only terminal-host v36
inventory plus two native CIM snapshots, checking pane incarnation, PID creation
time, session boundaries and recognized provider processes. Unknown protocol
versions, WSL, changed identities or incomplete snapshots refuse recovery. No
Orca application files are patched; daemon tokens and command lines are never logged.

Windows 1.4.202 has native recovery acceptance coverage. macOS/Linux use Orca's
process evidence and have platform-routing/path tests, not GUI acceptance.
If their daemon omits `childProcessEvidence: no-children`, idle-shell recovery
remains unavailable; the manager reports it rather than guessing from a false
child boolean. This release does not claim automatic recovery parity on all hosts.

Existing connected panes are reused. A missing pane requires an exact saved transcript ID and project path plus proof of closure. On Windows versions without persisted closure records, two matching native PTY inventories and OS process scans may instead prove absence. Incomplete inventories, hidden PTYs, unbound running agents, or a conversation still running in another pane block recovery. Other platforms still require a closure record. Pi receives its exact transcript path; Codex receives its exact session ID and original Codex home. No latest-session search or fresh-session fallback occurs. Unknown/disconnected/orphaned panes and interrupted launches stop the operation for inspection. The manager never closes active panes.

Bindings are read from Orca's persisted workspace session, not inferred by project or file modification time. Some active providers do not yet expose a binding: the manager reports this; rerun before closing those panes. A verified pane layout does not prove provider login/readiness. Restoring only the left pane places it to the right of the surviving sibling; both roles remain paired, but order can swap. Invisible renderer panes can require Orca View > Reload. No automatic reload occurs.

Orca storage defaults: Windows `%APPDATA%/orca`, macOS `~/Library/Application Support/orca`, Linux `${XDG_CONFIG_HOME:-~/.config}/orca`. `ORCA_TEAM_DATA_DIR` overrides storage, `ORCA_TEAM_PROFILE` selects the profile (default `local-default`), and `ORCA_CLI_COMMAND` selects the CLI executable. These persisted session fields and quick command RPC names are Orca-version-sensitive. Tests cover platform path/quoting and mocked orchestration; real macOS/Linux GUI acceptance and destructive close/resume testing are not performed by the test suite.

Without `ORCA_CLI_COMMAND`, Linux invokes `orca-ide` (avoiding the unrelated GNOME screen reader named `orca`); Windows/macOS invoke `orca`.

## Synchronization Boundary

Sync only source resources, prompts, catalog/layout, manager code, documentation and tests. Exclude `projects/`, `generated/`, `backups/`, locks, transcript files, runtime metadata and credentials. New machines reconstruct local pane identities and shortcut paths. Conversation transfer across machines is outside this package.

`docs/history.md` inventories predecessor helpers. Historical runtime backups are deliberately retained on the original machine rather than published with personal paths and terminal IDs.

Run verification with `node --test orca/tests/*.test.mjs` from the repository root.
