# Portable Orca Team

The shared package preserves 199 original role resource files and eleven adapted prompts. Orca, Pi/OMP, Codex or Claude Code, their models and credentials must already be configured. Node.js 22 or later runs the portable manager. No provider settings or credentials are installed.

## Scoped remote master test console (2026-10-14)

The `remote-master/bridge.py` adapter provides a `master-remote` console inside the local hainanpolicy `fix-bug` worktree while the real Claude Code process and its existing login remain on the paired `claude` Mac. This is a custom MCP/console adapter, not a native cross-host Orca role or a replacement for the original master. It reuses the master/ccb_self role resources; it is intentionally excluded from `orca-team` bulk restart and model synchronization.

Local tools bind only to the local Tailscale address on port 18761; the remote Claude transport binds only to its Tailscale address on port 18762. Requests require a random bearer credential and an allowed peer address; browser origins are rejected. Initial bootstrap is one-use and restricted to the configured remote peer, over the encrypted tailnet. Credentials live in mode-0600 private runtime files, never in this README or the repository. No public Funnel, SSH server, provider credential copying or repository synchronization is used.

Allowed tools: tracked non-sensitive local project reads, compare-and-set Markdown document writes under `docs/` and `.codex/`, and listing/reading/messaging proven existing agents in this exact worktree. Traversal, symlinks, credential/deployment/storage paths, arbitrary shell execution, cross-worktree terminals, shell panes, raw control characters, agent creation/restart and production operations are excluded. Agent messaging delegates to an existing trusted agent and is not an operating-system sandbox. With no user task the remote master waits; it does not automatically coordinate the original master.

The current workspace has the visible `master-remote` console and a `master-remote-tools` support terminal. The remote machine retains the dedicated `master-remote-engine` support terminal; its neutral control files are under `~/.orca/remote-master-fix-bug/`, not in the remote Revisited project. Both computers, Tailscale, and both bridge processes must remain running. A remote request survives console disconnection but is not an unattended task queue. The console is line-based, not Claude's native TUI; Claude sessions resume across turns. `/recover` retrieves the same pending request without submitting it again; `/exit` closes only the console. Do not replay an unknown request automatically.

Local console relaunch: `python3 ~/.orca/roles/ccb-team/remote-master/bridge.py console --config ~/.orca/roles/ccb-team/remote-master/runtime/fix-bug.json`. Local tool process relaunch uses `local` in place of `console`. On the remote computer, relaunch the engine with `python3 ~/.orca/remote-master-fix-bug/bridge.py remote --config ~/.orca/remote-master-fix-bug/engine.json`. First verify the corresponding process is stopped; never create duplicate listeners. Full disablement means closing the specific console, local tool bridge and remote engine terminals recorded in `remote-master/runtime/session-bindings.json`; do not stop unrelated team terminals. Tailscale address changes require an explicit configuration update, not fallback to another host.

Verification: `python3 -m unittest discover -s ~/.orca/roles/ccb-team/remote-master -p test_bridge.py -v` covers authorization, path/secret/symlink boundaries, optimistic document conflicts, and rejection of shell/unknown terminal targets. Real remote Claude successfully read the local worktree identity and package file, listed local terminals and received a traversal denial; no business files were changed and no task was dispatched. Existing provider credentials and application production services were not modified.

### Remote Codex master (2026-10-14)

`master-codex-remote` now runs the official Codex 0.162.1 interactive TUI with `--remote`, connected to the remote machine's native `codex app-server`. The former line console and per-turn `exec/resume` engine have been stopped. `remote-master/native_codex.py` only launches official processes or forwards transport bytes; it does not relay conversation turns. The remote provider/model remains in place and its credentials are not copied. Orca detects the local client as Codex. This is still excluded from the team's bulk restart manager.

The independently authenticated writable MCP service remains at local tailnet port 18765; Claude retains its Markdown-only service at 18761. Native app-server binds the remote tailnet address on port 18766 and requires a capability token. A loopback-only forwarder on local port 18767 connects over encrypted Tailscale, satisfying the TUI's loopback-or-TLS bearer requirement without exposing an unauthenticated endpoint or using public Funnel. The client credential is in mode-0600 `runtime/master-codex-remote/native.json`; the remote server only receives its SHA256 digest. Process-only proxy bypass does not change system or model-provider configuration. Remote shell tools remain disabled, and the TUI explicitly uses a read-only remote sandbox with on-request approval; authorized MCP source writes remain available.

The user explicitly authorized current-worktree source editing. `write_file` creates/replaces non-sensitive, non-ignored UTF-8 project files in existing directories; `edit_file` replaces exactly one literal occurrence while preserving all other bytes. Both require the latest SHA256 (`absent` only for new files). New non-ignored source files can be listed/read without staging them. Stale hashes, ambiguous replacements, symlinks, hard-linked writes, binaries, ignored files, secrets, CI/agent-policy changes, deletion and arbitrary shell access remain blocked. Existing business code may now be changed; this is not limited to Markdown. No builds/tests are claimed unless actually run through separately available execution facilities.

The native TUI starts a new native conversation. Old `session.json`/`session-code.json` conversations remain preserved, but the stopped legacy engine is not used to continue the native session. Exact live terminals and the native session ID are recorded in `remote-master/runtime/session-bindings.json`. The TUI's directory, `@` file selection and shell context refer to the neutral remote runtime directory; they are not a mount of the local project. Local source access and edits continue through the worktree MCP tools, and arbitrary local shell/build execution has not been added.

Native client relaunch: `python3 ~/.orca/roles/ccb-team/remote-master/native_codex.py client --config ~/.orca/roles/ccb-team/remote-master/runtime/master-codex-remote/native.json`. Its local transport uses the same command with `tunnel` instead of `client`. Local source tools still use `bridge.py local --config ~/.orca/roles/ccb-team/remote-master/runtime/master-codex-remote/tools.json`. The remote service uses `native_codex.py server --config ~/.orca/master-codex-remote/engine.json --token-sha256 <capability-token-digest>` with the existing bridge directory on `PYTHONPATH`. Confirm a listener is stopped before relaunching it. Keep `master-codex-code-tools`, `master-codex-tailnet` and remote `master-codex-app-server` running while using the native client. Native slash commands replace the old custom `/recover` interface.

Earlier exec-adapter evidence (before native cutover):

Verified with real remote Codex: worktree reads, role listing, parent-directory denial and session continuation. After source-write authorization, Codex edited only the requested comment in `src/lib/useCountUp.ts`, a stale-SHA second edit was rejected, then the real console restored the comment using the latest hash. Local byte-for-byte comparison confirmed the entire file exactly matches its pre-test content. The writable session remained the same across edit and restore; old read-only history is retained. Eight adapter tests pass (`python3 -m unittest discover -s ~/.orca/roles/ccb-team/remote-master -p 'test_*.py' -v`), including new-file visibility, source-write isolation, credentials, ignored files, ambiguous edits and hash conflicts. No business change remains and no role task was dispatched; no application build was claimed. The remote user's existing warnings for `disable_response_storage` and `stream_max_retries` were not changed.

Native cutover verification: both direct tailnet and loopback-forwarded unauthenticated WebSocket handshakes returned 401; authenticated handshakes returned 101. The real TUI rendered `/status` with `GPT-6.1-Sol/custom` and `Read Only (Ask for approval)`, streamed real worktree tool cards, edited the requested `useCountUp.ts` comment and restored it with matching SHA256. Local byte comparison independently confirmed exact restoration. No business changes or build claims were introduced.

Reusable local-agent entry: `$orca-remote -codex <role> [--environment <name>] [--worktree <path>]` or `$orca-remote -omp <role> ...`; select one runtime independently of role and model provider. The canonical skill is `~/.codex/skills/orca-remote/SKILL.md`, with an OMP discovery symlink and Chinese `references/operations.md` manual. This is an agent skill, not a shell executable, and requires a local orchestration-capable agent. Healthy matching instances are reused. Codex retains its native adapter; OMP now uses the separate deterministic `remote-master/omp_adapter.py` private-collab adapter. Master/archi native OMP and a real isolated bidirectional handoff are verified; this is not a claim that designer or all providers have been tested. Existing Codex services and ports are unchanged.

Skill-driven switches now default to bidirectional task-context handoff, including `--to-agent <existing-handle>` for returning to an existing agent. `--no-handoff` is focus-only. The skill's `references/handoff.md` and `scripts/handoff.py` define private task/revision records, source checkpoints, one claimed delivery, explicit accepted/rejected assistant receipts, and current-owner checks. Original conversations stay in place; this is cooperative coordination, not an OS write lock or full conversation migration. Plain Orca tab clicks do not invoke it. Unknown delivery is not resent, and rejected handoffs retain source ownership.

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

Run `orca-team` in a project directory. It reconciles the team: running roles whose applied fingerprint (agent, model, thinking and role prompt) is unchanged are reused untouched; changed roles stop and resume with the current configuration (keeping each original conversation); then missing roles are created and stopped conversations resume in idle panes. `orca-team status` only inspects existing state; `orca-team init` only initializes. `--project PATH` selects a different project.

Exception: context-switch requests, pending intents, or remotely owned roles in the selected scope defer ordinary start's update/reload/layout recovery; no source or original return conversation is stopped. Use `remote-status` to inspect confirmed owners and pending switches. Explicit `restart` is not a context handoff.

The default command first makes sure the Orca app is running: when the runtime metadata is
missing it launches Orca and waits until the CLI answers. It then syncs role
models before launching. Codex roles without a `piProvider` take the top-level
`model` and `model_reasoning_effort` from the local Codex config (`$CODEX_HOME/config.toml`, else
`~/.codex/config.toml`). Codex launches explicitly pass these synced model and thinking values. All selected roles appear in the picker; Codex model/thinking follow local config, while its agent column remains editable. Pi/OMP roles are
configured through an interactive picker in the terminal: presets and the last
confirmed selection live in `pi-models.json` next to `team.json` and can be
edited by hand (`omp-models.json` for OMP teams). The picker has separate `role | agent | model | thinking | remote` columns. Up/Down selects a role; Tab/Shift-Tab switches the agent/model column; Left/Right changes only that column; `a`/`m` directly focus agent/model. Models are deduplicated and sorted by provider then natural model name (numeric versions included). Switching back to an agent restores its previous model/thinking within the menu. Newly configured Pi and OMP provider models are read from their native catalogs automatically, preserving saved role choices. Starts without a terminal (Orca quick commands, CI) and
`--no-pick` never open the picker and keep `team.json` values unchanged.

Pi roles also load their packaged skills from `source/<role>/skills/` at each
fresh launch and exact-session resume. Roles without packaged skills retain
Pi's default skill discovery; global Pi settings remain unchanged.

Running roles are restarted through exact-session restart first, so after Orca
itself resumes panes, one `orca-team` call brings all of them back to the
configured agent, model, and thinking level. The command then recovers missing
roles and creates new ones. Busy tasks are interrupted before exit. Ambiguous or unverified process identities
are reported as incomplete. `start` is an alias for this default
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

Restart accepts one configured role, verifies its original transcript and running agent, interrupts its task, requests
`/quit` when idle, and falls back to terminating the verified provider process if
needed. A proven shell is required before resuming the same conversation in the
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

Claude Code roles (`"agent": "claude"`) use `model` and `thinking` from
`team.json` directly (`--model`, `--effort`). The startup picker includes Claude
CLI / sonnet, opus and haiku alongside local Codex and Pi/OMP presets. Left/Right
or Tab selects CLI/model; comma/period changes effort. Enter saves the selected
agent, model and thinking; Escape cancels. Codex model/effort follow local config.
Conversations cannot be resumed across CLIs. When the picker confirms a different
CLI for a role with a saved conversation, start first stops the running role with
its original CLI, then writes a handoff document to
`projects/<key>/handoff/<role>-<from>-to-<to>-<time>.md` and clears the old
binding. The document is a mechanical extract of the active branch: user and
assistant messages, condensed tool calls, and the latest compaction summary;
tool outputs and reasoning are omitted. The new conversation's first message asks
the role to read it. `state.json` keeps `handoff` with the source transcript path.
If the role cannot be stopped or verified, team.json stays unchanged.
`orca-team start --fresh ROLE` still starts without a handoff.
The role prompt is passed with `--append-system-prompt-file` on every fresh launch
and resume. A fresh launch pre-assigns the conversation with `--session-id` from
`launchIntent`, so the binding is proven by the process arguments plus the
`$CLAUDE_CONFIG_DIR/projects/*/<id>.jsonl` transcript (default `~/.claude`);
resume uses `--resume <id>`. Exit uses `/exit`, interrupt uses Escape. Packaged
Pi role skills are not loaded into Claude, and Claude Code updates itself, so
update checks skip it. `ORCA_CLAUDE_COMMAND` overrides the executable.

`orca-team start` and `restart` check OMP, Codex and Pi versions at most once per
24 hours (cached in `agent-update-check.json`, failures included). When a newer
version exists and no process on this machine uses that CLI, they install it
before launching roles, so a cold start always runs current CLIs. They never stop
a role for an update: running processes lazily read hashed asset files from the
install directory, so a CLI in use is postponed with a notice. Process detection
reads full command lines because macOS truncates `comm` and runs OMP under `bun`.
`orca-team update` updates immediately: it scans running processes across projects and stops tracked blocking roles before
updates, then resumes their original conversations. Busy tasks are interrupted; verified local Windows and macOS provider processes can be forcibly terminated if graceful exit fails. External Codex and Pi processes are left running and do not preemptively block program or extension installation; actual installer errors are reported. Idle npm-installed providers query the
registry and install only when their version differs from the latest version;
idle Pi then runs `pi update --extensions` for its packages. A shared update lock keeps
multiple team commands from installing simultaneously. Update failures warn
and continue startup with the available installation.

The Agent update stage also merges local Pi and OMP model configuration, even when version checks are cached or no CLI update is available. It reads Pi `models.json` and OMP `models.yml`/`models.yaml` (legacy `models.json` only if YAML is absent). Providers and model IDs are unioned; conflicting fields prefer the catalog with more distinct provider/model pairs, with Pi winning ties. Per-model thinking overrides are merged as well. Original changed files receive sibling `.orca-sync-<id>.bak` backups; repeated sync is a no-op. Invalid configurations abort the merge before any write. Credentials remain local and are never printed or exported.

Native themes, plugin lists, default model selection, compaction settings, authentication stores and conversation files are not mirrored. Default directories are `~/.pi/agent` and `~/.omp/agent`; `PI_CODING_AGENT_DIR` is honored. For distinct custom locations use `ORCA_PI_AGENT_DIR` and `ORCA_OMP_AGENT_DIR`. A shared directory is rejected to avoid overwriting two formats in one location. Existing processes are not restarted for a configuration merge; newly started sessions read it.
The picker reads per-role model and thinking selections from local `pi-models.json`;
`,` and `.` change the selected role's thinking level, and Enter saves it.
Default startup reuses running roles whose applied fingerprint matches and stops
only changed roles. A legacy fingerprint without the role prompt hash compares
agent, model and thinking only. Stopping interrupts busy tasks, requests graceful exit, and terminates only
verified local provider processes if exit fails, then resumes original conversations.
Explicit `restart` always uses this stop-first behavior for the selected roles.
Role process inspections run in parallel (4 at a time on macOS, 2 on Windows).
Startup prints elapsed time for connection, update, model selection, reload,
and layout/conversation recovery. No overall time limit is imposed.

Each project gets `projects/<path-hash>/config.json`, `state.json`, and an exclusive startup lock. Config is seeded from `layout.json`. A project-specific layout lives globally in the team directory as `projects/<path-hash>/team.json` (synced as `orca/project-configs/<project-key>/config.json`), never inside the project workspace. When it exists it is the authoritative layout: initialization/start validates it, backs up differing local config, and applies it without replacing state. A legacy workspace `.orca/team.json` is migrated there once when no global layout exists; if both exist and differ, start refuses until the workspace copy is removed. Without this override, existing project config remains independent of template updates. Windows project keys ignore path case; macOS/Linux keys preserve it. Runtime state records pane IDs, model settings, and exact provider conversation bindings. Locks are removed after successful or failed normal execution. A lock owned by a live PID blocks another start or restart; a lock whose PID has exited is preserved with a stale suffix and replaced automatically.

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

After updating local provider credentials, run `orca-team restart` in the project to restart all configured roles in their original panes and conversations. `orca-team restart ROLE` restarts one role. Busy tasks are interrupted and stopped before exact-session resume; unverifiable roles report failure. Any incomplete role makes the command exit nonzero. Credentials are reread by the launch path and are never printed or copied by restart. Keys inherited from an unchanged parent shell must be refreshed at their source first.
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

OMP transcripts may contain one version-1 title metadata record before the session header. Validation preserves support for that prelude and still checks the exact session ID and project directory.

Default startup order is model selection, agent update check, configuration reconciliation, then layout/session verification. Changed roles restart with the newly selected model and thinking level; matching roles are reused by reconciliation. Explicit restart uses the saved selections.

The macOS changes have simulated process/PTY and lifecycle regression coverage; no Mac hardware was available for acceptance testing. macOS users must configure OMP providers locally. Credentials and original Windows session files are not portable configuration.

## Terminal remote selection

In the startup picker, press `r` on any role to cycle `remote: off / codex / omp`. Each row starts from its confirmed owner runtime; Enter emits only changes and Esc cancels picker requests. `off` requests a context handoff back to the exact original local agent. The runtime selection changes persistently only after a verified assistant acknowledgement and commit. Remote choices live in private per-project ownership state, never model presets. `--no-pick` and non-TTY starts only use explicit remote flags.

```sh
orca-team remote --remote codex:master --environment claude --project /path/to/worktree
orca-team start --remote omp:designer --project /path/to/worktree
orca-team remote --remote off:master --project /path/to/worktree
orca-team remote-status --project /path/to/worktree
```

Repeat `--remote` for different roles. Requested switches resolve the real source and exact original return session before local-team reload. OMP then runs deterministic native readiness before persisting the verified target and opening a `remote-setup` context coordinator; the coordinator no longer researches runtime installation. Missing/ambiguous source identities block rather than creating a blank replacement. `--from-agent HANDLE` can select a verified source for one role. The coordinator checkpoints the source and obtains actual target acceptance; `remote-commit --role ROLE --intent ID` verifies ledger and live/native identities, persists ownership and focuses the target. Unknown creation/delivery is not resent, and rejection retains the source. Closed OMP guests can reattach to the unchanged remote conversation through an audited same-session binding chain. No Codex fallback is provided.

See [feature documentation](docs/features/remote-startup.md).

## Automatic startup repair

The user entry remains `orca-team`. `start` and `restart` failures now open one local
Codex repair terminal using `~/.codex/skills/orca-team-repair/SKILL.md`. The private
project `startup-repair.json` retains the original arguments and error; uncertain
creation is never repeated. The original command still exits nonzero until verified
recovery. Repair retries use `--no-repair` to prevent recursion. This does not replace
business roles or change their models. `restart --group TITLE` selects that group;
restart's update check covers only its requested runtime families. Pending remote
handoffs preserve their groups while independent groups can recover; they no longer
silently report a complete startup. Shell recovery reads the rendered screen so old
TUI scrollback does not falsely block an empty prompt. If stale TUI footer rows
remain below a PowerShell prompt, recovery rechecks the native idle shell and
unchanged pane incarnation, then sends one Ctrl+L redraw without Enter. Resume
requires a freshly read empty prompt and the same verified shell; redraw failure,
input drafts, or changed process identity stop recovery without launching.

### Remote OMP preparation failure

A proven original coordinator abort before any checkpoint/context delivery can be settled through `orca-team remote-abort-preflight --role ROLE --intent EXACT_ID --report FILE`. The tightly scoped path preserves source ownership, exact report bytes and audit as `preflight_failed`; it never invents rejection. Zero revision, unused ledger and unchanged live native source remain mandatory. Actual/unknown deliveries remain protected. The menu displays historical reasons; explicit off permits the existing local lifecycle and Esc cancels startup. An explicit OMP retry now runs the implemented native readiness path without erasing history; a failed readiness check creates no setup and retains the source. See [native OMP delivery and verified boundaries](docs/features/remote-startup.md#native-omp-delivery-2026-10-14).

## Portable remote sources and synchronization

Orca synchronization includes the `orca-remote` skill, its handoff helper and
`remote-master/` Python/TypeScript adapter sources. Runtime bindings, credentials,
transcripts, caches and repair backups remain local. Resolve hosts, ports and
worktrees from the destination machine's verified bindings; example paths are
placeholders. No agents are started or restarted by exporting configuration.

The merged package retains Claude Code launch/resume and transcript verification,
and the common OMP compaction overlay. Machine-specific production deployment
instructions and generated project compaction paths are excluded. The deployment
role uses protected local configuration and requires current-task authorization.

Validation: 341 Node tests, 37 synchronization tests, 78 remote-adapter Python
tests and 7 handoff tests passed. macOS synchronization tests use a canonical
`TMPDIR=/private/tmp` to preserve symlink rejection. Native connections and Bun
relay integration are not exercised by this configuration push; the latter
requires an explicit `COLLAB_TEST_BIND` tailnet interface.

Multiple Orca terminal hosts may stay alive after an Orca upgrade (the old host keeps pre-upgrade terminals). Pane-specific inspection selects the unique owning host; global inventories used by absence proofs merge every live host under a combined identity, and fail closed when a registered live host cannot be read. Project locks also treat a live PID whose process started after the lock was created as a reused PID and recover the stale lock.

## Parallel frontend seats

The designer group now contains `designer` and `designer2`, with separate conversations in equal split panes. `orca-team start --group designer` opens or reuses both. The second seat inherits the existing frontend role and model selection. Master assigns independent files/modules to both seats, keeps shared-file edits under one owner, and checks both reports before acceptance. Existing project layouts remain explicit; the active industrial-drawing-translator layout has been updated. See [parallel designers](docs/features/parallel-designers.md).

See [2026-10-15 remote Claude and parallel designer changes](docs/changes/2026-10-15-remote-claude-and-parallel-designers.md) for the fixes, portable configuration, verification and machine-local setup requirements.
