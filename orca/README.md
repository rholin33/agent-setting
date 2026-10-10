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

Run `orca-team` in a project directory. It reconciles the team: reuses matching roles and reloads only changed agent/model/thinking configurations (keeping each original conversation), then creates missing roles and resumes stopped conversations in idle panes. `orca-team status` only inspects existing state; `orca-team init` only initializes. `--project PATH` selects a different project.

The default command first makes sure the Orca app is running: when the runtime metadata is
missing it launches Orca and waits until the CLI answers. It then syncs role
models before launching. Codex roles without a `piProvider` take the top-level
`model` and `model_reasoning_effort` from the local Codex config (`$CODEX_HOME/config.toml`, else
`~/.codex/config.toml`). Codex launches explicitly pass these synced model and thinking values. All selected roles appear in the picker; Codex rows are read-only. Pi roles are
configured through an interactive picker in the terminal: presets and the last
confirmed selection live in `pi-models.json` next to `team.json` and can be
edited by hand. Newly configured Pi provider models are added to existing presets automatically, preserving saved role choices and custom labels. Starts without a terminal (Orca quick commands, CI) and
`--no-pick` never open the picker and keep `team.json` values unchanged.

Pi roles also load their packaged skills from `source/<role>/skills/` at each
fresh launch and exact-session resume. Roles without packaged skills retain
Pi's default skill discovery; global Pi settings remain unchanged.

Running roles are restarted through exact-session restart first, so after Orca
itself resumes panes, one `orca-team` call brings all of them back to the
configured agent, model, and thinking level. The command then recovers missing
roles and creates new ones. Busy, ambiguous, or unverified roles are left running
and reported as incomplete; rerun `orca-team` after they become idle. `start` is an alias for this default
behavior. `restart ROLE` remains available for an explicit forced restart.
When Orca has dropped a stopped role's pane and its saved conversation must not
be resumed, `orca-team start --fresh ROLE` (repeatable) clears that role's pane
binding and starts a new session. It refuses while the role is running.

```text
orca-team
orca-team status
orca-team history archi
orca-team restart archi
orca-team start --group master
orca-team start --fresh simple
orca-team status --group master
```

Restart accepts one configured role, verifies its original transcript and idle
agent, checks for an empty terminal draft, clears residual editor input, sends
`/quit`, waits for a proven shell, then resumes the same conversation in the
same pane. It shares the project startup lock. An ambiguous exit retains
`restartIntent`: the next attempt only retries when native process evidence
proves the same provider has been running since before the prior exit request.
Otherwise it refuses another send. Running `orca-team` after an exit recovers
the original session; an agent still running with an unconfirmed exit is
reported as incomplete. Opening Orca alone does not run this manager: run
`orca-team` once afterward. No watcher or OS startup service is installed.

`orca-team export-config --project PATH` prints the current project configuration without its machine-specific workspace path. This is the read-only interface used when exporting portable project customizations. It prefers runtime config, then `.orca/team.json`, then the default layout.

Default tabs: master / loader, archi, coder1 / coder2, designer, reviewer / test, simple (six groups, nine roles). Slash denotes an equal left/right split (`vertical` in Orca's native representation). The manager activates the primary tab before splitting and validates the actual desktop pane tree afterward. CCB sidebar ratios remain recorded but are not applied because Orca has no matching sidebar API.

Quick commands use `--group TITLE`, not the internal single-role `launch` action.
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

Pi roles use the selected `provider/model`. Before startup, Codex role models
sync from the machine's Codex configuration. Role `thinking` maps to the
provider's reasoning setting.

`orca-team` checks Codex and Pi updates once before team startup or explicit
restart. It scans running processes across projects and stops tracked blocking roles before
updates, then resumes their original conversations. Busy tasks are interrupted; verified local Windows and macOS provider processes can be forcibly terminated if graceful exit fails. External Codex and Pi processes are left running and do not preemptively block program or extension installation; actual installer errors are reported. Idle npm-installed providers query the
registry and install only when their version differs from the latest version;
idle Pi then runs `pi update --extensions` for its packages. A shared update lock keeps
multiple team commands from installing simultaneously. Update failures warn
and continue startup with the available installation.
The picker reads per-role model and thinking selections from local `pi-models.json`;
`,` and `.` change the selected role's thinking level, and Enter saves it.
Default startup reuses running roles whose recorded applied agent, model, and
thinking match the current configuration. Only changed or unknown configurations
are reloaded. Explicit `restart` still forces the selected roles to restart.
Startup prints elapsed time for connection, update, model selection, reload,
and layout/conversation recovery. No overall time limit is imposed.

Each project gets `projects/<path-hash>/config.json`, `state.json`, and an exclusive startup lock. Config is seeded from `layout.json`. When the project's `.orca/team.json` exists, it is the portable authoritative layout: initialization/start validates it, backs up differing local config, and applies it without replacing state. Without this override, existing project config remains independent of template updates. Windows project keys ignore path case; macOS/Linux keys preserve it. Runtime state records pane IDs, model settings, and exact provider conversation bindings. Locks are removed after successful or failed normal execution. A lock owned by a live PID blocks another start or restart; a lock whose PID has exited is preserved with a stale suffix and replaced automatically.

The portable lock is `start.node.lock`. The predecessor PowerShell manager retained a zero-byte `start.lock` after normal completion; that legacy file is preserved and is not interpreted as an active Node lock. Stop using the old `manage.ps1` entry when adopting the portable entry: the two managers must not be invoked concurrently.

## Recovery And Limits

New managed Pi roles receive a unique transcript path recorded in `launchIntent`
before pane creation, plus a minimal no-tools initialization prompt. That path is
pre-created as an empty file: Pi writes its session header immediately for an
existing empty `--session` file, but only persists a brand-new file after the
first assistant turn. Without the placeholder Pi stays file-less until its first
reply, Orca never records a pane binding, and the role reports
`conversation binding unavailable` even though it is healthy. An empty
placeholder is never treated as a conversation; only a file with Pi's session
header binds. A launch stays pending until its transcript and live provider
binding are verified. A retry reconciles completed launches without sending
again; an unconfirmed launch remains blocked. Existing saved conversations are
resumed even when Orca replays the original `launch` command without `--resume`.

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
booleans) block startup success and command injection. One exception is
`ambiguous_foreground_group`: when a CLI is launched through an npm wrapper, the
wrapper and the real vendor binary share the foreground process group, so Orca's
fence cannot name a single foreground process even though the pane is healthy.
For that reason only, the manager falls back to Orca's own `terminal.agentStatus`
for the pane. It can only upgrade the verdict to a running agent, never to an idle
shell, so the injection path stays closed and the fallback cannot paste into a
live TUI. A connected shell is not
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

## macOS initialization repair (2026-09-21)

Initialization activates the local Orca application and focuses the primary pane before splitting. macOS may defer renderer split requests while Orca is in the background. A split timeout is reconciled against the saved launch intent, pre-split pane inventory, and persisted provider bindings; the mutation is never automatically resent. Interrupted Pi launches recover by exact transcript path. Interrupted Codex splits require exactly one new bound pane in the original tab.

For local macOS, when Orca reports incomplete process fences, the manager reads authenticated terminal-host v36 inventory and takes two native process snapshots. It requires stable daemon identity, PTY incarnation, root PID creation time, same-TTY descendants, and one foreground provider process. Uncertain evidence still blocks recovery. This adapter proves running agents, not idle shells or absent processes.

Validation: six configured tabs and eight bound roles on macOS; repeated initialization must retain all pane and conversation identities. Model service availability and optional Orca tab pinning are reported separately from layout initialization.

### Restoring a closed team on macOS

When all project terminals have been closed, two authenticated native/desktop inventories, original transcript validation, open-file ownership checks and exact conversation argument checks establish absence before resuming saved sessions. Hidden terminals, incomplete inventories, open transcripts and host identity changes block recovery. Partial-project absence remains conservative and requires inspection; this change does not claim general idle-shell recovery. Native Codex resume arguments prove the original conversation while Orca binding records are still catching up.

## Reload local keys

After updating local provider credentials, run `orca-team restart` in the project to restart all configured roles in their original panes and conversations. `orca-team restart ROLE` restarts one role. Busy roles are skipped and reported; other roles continue. Any incomplete role makes the command exit nonzero. Credentials are reread by the launch path and are never printed or copied by restart. Keys inherited from an unchanged parent shell must be refreshed at their source first.
## Missing-pane recovery

`orca-team` retains saved conversations when Orca's persisted tab snapshot differs
from the published desktop tabs. Before replacing a tab with no live PTY, startup
requires the original role/session bindings, absence from the published tab list,
and the existing native terminal-host plus OS process absence checks. Unavailable
or conflicting evidence stops recovery without sending a launch command.

Verified retired tab IDs and their original session IDs are recorded in the project
state before replacement panes launch. Later starts ignore these stale snapshot
entries only while the saved conversation identities still match and the old tabs
remain absent from both the live terminals and published desktop. History files
and Orca's persisted tab records are retained. Existing layout verification still
checks every configured role/group after recovery. Pi startup waits for a complete
session header when its transcript file has just been precreated.


Windows maintenance uses asynchronous CLI requests and at most two concurrent roles under one project lock. Each inspection retains two independent CIM reads and verifies the PTY identity before and after. Supported Codex launches include --no-daemon to preserve per-pane hook identity when resuming sessions. Runtime role count and sidebar status are separate checks; a valid layout alone does not prove sidebar visibility.

## Portable restart compatibility

On macOS, fixed Pi roles explicitly load the packaged `lib/pi-session-proof.ts` extension. It records only the current PID, process start time, pane identity, project path and original session identity under the installed team home's `runtime/session-proofs/`. These local records are never synchronized. Native PTY/process checks and transcript-header validation must match before a record is accepted. `ORCA_TEAM_HOME` controls the destination; no global Pi settings are changed.

Codex launch checks the installed CLI help before enabling `--no-daemon`. Supported versions use a runtime owned by the role terminal so quitting releases it; older versions retain their existing launch arguments. Desktop restarts run sequentially because focus and screen verification are shared. Stable empty Codex screens supplement unavailable idle status; working, permission and takeover screens remain blocked. Recognized Pi mouse-report residue is cancelled only after an idle shell is verified, followed by another clean-prompt check.

When a saved project has no live terminals, startup reveals an existing AGENTS.md or README.md through Orca's file-open CLI and waits briefly for its saved panes. Missing or ambiguous identities still stop recovery.


macOS update prehooks stop tracked roles even when Pi changes its process title. Forced exit verifies the local host, PTY incarnation, provider PID creation time and same-terminal descendants before signalling individual processes; it preserves the pane shell and external agents. macOS maintenance remains sequential because focus and screen checks are shared. Windows uses at most two concurrent roles. The update then resumes each original conversation. macOS process termination is covered by simulated identity/descendant tests; this update has not been verified on a physical Mac.

## Windows OMP roles

The six former Pi roles use OMP; Codex roles remain configured separately. OMP is resolved from ORCA_OMP_COMMAND, the default Windows local installer path, then PATH. Role skills use a generated config overlay (skills.customDirectories), and OMP model selections use omp-models.json. The prehook stops verified managed OMP processes, runs omp update and omp update --plugins, then resumes exact sessions. The current project migration retains original Pi transcripts and resumes separate OMP copies. Windows native health, termination and absence checks recognize omp.exe.

## macOS OMP parity

OMP roles share the Windows launch arguments, model picker, role skill overlays, transcript validation and update lifecycle. macOS resolves ORCA_OMP_COMMAND first, then local installer/Homebrew paths and PATH. Native inspection verifies the foreground OMP process and exact --session/--resume transcript path, rechecking the PTY and process identities. Closed-pane recovery refuses duplicate conversations, including when Orca labels OMP as Pi. Updates stop managed roles sequentially, run omp update and omp update --plugins, then resume their exact conversations. External OMP instances are preserved and do not preemptively block updates.

Default startup order is model selection, agent update prehook, configuration reconciliation, then layout/session verification. Update recovery applies the newly selected model and thinking level; matching roles are reused by reconciliation. Explicit restart uses the saved selections.

The macOS changes have simulated process/PTY and lifecycle regression coverage; no Mac hardware was available for acceptance testing. macOS users must configure OMP providers locally. Credentials and original Windows session files are not portable configuration.
