# Remote context switching

## Menu and ownership

Press `r` to cycle off/codex/omp, including locked Codex model rows. The initial value is the **confirmed owner runtime**, not the previous keypress. Enter emits only changed remote selections; returning to off emits `runtime: null`. Esc or cycling back to the original value does not request a switch. Remote state is separate from model presets.

`off` means hand the latest context back to the exact original local agent, not disable remote startup. Its history, native session and pane remain intact. Re-selecting the already confirmed destination only validates and focuses that owner.

## CLI

```sh
orca-team remote --remote codex:master --environment claude --project /path/to/worktree
orca-team remote --remote off:master --project /path/to/worktree
orca-team remote-status --project /path/to/worktree
```

`start` accepts the same repeatable `--remote` requests. Explicit flags win over picker changes for the same role. `--from-agent HANDLE` selects the verified original business source when an initial role has no unique saved pane binding; it requires exactly one role. Missing native session evidence blocks the switch instead of silently creating a new conversation. Existing unregistered legacy remote terminals are not adopted by title or focus.

## Durable intent and commit

`lib/remote-switch.mjs` maintains private `remote-switches.json` in the team's per-project directory, with fixed per-role `remote-handoffs/<role>/` ledgers. Directories are 0700 and files 0600. Each role preserves its original `local`, current `owner`, confirmed `runtime`, stable `taskId`, and optional `pending` intent. Native session/incarnation and worktree are part of endpoint identity. Endpoint role is the canonical team role; its instance display label may differ. Endpoint environment identifies the TUI host, separately from the requested model host.

`lib/remote-start.mjs` resolves sources and exact original return identities first. For OMP, it then calls the fixed `lib/omp-adapter.mjs` / `remote-master/omp_adapter.py` readiness path before creating an intent or coordinator. The prepared intent persists the verified target and adapter config. Only context checkpointing and acceptance use `remote-setup`; it must not research or improvise a runtime. Unknown setup creation is not retried; inspect `remote-status` and reconcile the original ledger rather than creating another task.

The coordinator uses the installed skill to obtain a fresh source checkpoint, verify a safe pause and empty input/idle destination, then prepare/claim/deliver the same task. It is not the business source. It records a real assistant acceptance or rejection through `scripts/handoff.py`. For menu requests it must use the intent's task ID and ledger directory, not the generic skill's default directory.

After accepted evidence, the coordinator runs:

```sh
orca-team remote-commit --role master --intent ACTUAL_INTENT_ID --project /path/to/worktree
```

Commit requires the next matching ledger revision, exact source and requested target, matching content hash and assistant receipt, no in-flight work, and live terminal/worktree/program/incarnation checks. Available native session metadata is also checked. For off, the target must exactly equal the preserved original local identity. Only then does the CLI persist the new owner/runtime and focus it. A rejected receipt uses `remote-reject` with the same arguments; source ownership remains. A prepared, unclaimed intent can also be cancelled through `remote-reject`; a claimed/unknown one cannot be erased this way.

These records are a cooperative protocol, not an OS lock or cryptographic proof that a model replied. The coordinator must actually observe the assistant turn; forged local JSON is not legitimate evidence. A plain Orca tab click remains focus-only, not task handoff or conversation migration.

## Lifecycle protection

When the selected scope has a switch request, a pending intent, or a remotely owned role, ordinary `start` preserves those protected roles and their shared tab layout. Local siblings recover only in their existing verified panes; independent groups also recover. Unresolved protected roles still make startup incomplete, including when local recovery succeeds. This preserves sources and original return panes before checkpoints. A separate explicit `restart` is still an intentional runtime operation, not a context switch, and may invalidate a recorded incarnation; never use it to repair a pending handoff. `--fresh` refuses continuity-bound roles.

Once a return is accepted, the confirmed state is off/local; future ordinary starts without other protected roles follow the existing local lifecycle. No task history, provider credential or business file is moved. OMP now has a separately verified private native adapter; selecting it still cannot establish task ownership without the original source, real target acceptance and commit.

## Verification (2026-10-14)

- Focused picker/model/launcher/registry regression covered 77 cases. One cross-role regression was found in integration, fixed, and its failed case passed on rerun. Coverage includes explicit off, unchanged/cancelled selection, unknown delivery, exact original return session, stale/foreign receipts and restarted endpoints.
- An actual isolated Orca terminal rendered the picker at `remote: omp`; pressing `r` and Enter rendered off and returned an explicit `remote: null` request. The temporary UI made no team-state change.
- Real `orca-team start` and `remote-commit` commands plus the actual Python handoff helper completed forward revision 1 and return revision 2 with the same task ID in temporary private state. Controlled Orca and assistant fixtures were used; source ownership remained until commit, the original local endpoint was restored, and startup reported that team updates/reloads were bypassed. This is not a fresh live-model round-trip claim.
- Real installed `remote-status` and `--help` ran successfully. No existing role, remote service, model configuration or business source was restarted/changed by acceptance. Full package suite and Windows live execution were not run in this task.


## OMP native identity correction (2026-10-14)

When Orca omits renderer session metadata, source resolution now reuses the saved transcript only after `validateTranscript` and native `provesSession` verification, including unchanged terminal handle, PTY and incarnation. It does not trust the saved ID alone. macOS pane inspection selects the uniquely matching live PTY host by handle/PTY/incarnation when multiple host versions coexist; global absence scans still reject ambiguous inventories. Duplicate matching owners, stale epochs and different conversations remain blocked.

20 focused native-host, macOS and remote-source tests passed. The corrected `startRemoteRequests` resolver was also exercised read-only against the actual running `master` and `archi` OMP sessions in `/Users/rholin/code/hainanpolicy`, with renderer session metadata deliberately omitted. Both resolved successfully using real native evidence. The smoke used a temporary metadata copy and intercepted focus; no message, setup terminal, role restart or real ownership-state write occurred. This verifies the reported identity blocker, not completion of a remote OMP connection.

## Visible coordinator progress (2026-10-14)

After creating `remote-setup`, the launcher now focuses that coordinator and prints its actual terminal handle. This is not destination acceptance: the source still owns the task until `remote-commit`. A focus failure reports the already-created handle and prohibits recreating the coordinator; uncertain creation remains non-retryable. Previously the coordinator could run in an unfocused tab while the menu printed only a generic request message.

11 remote-start regression cases passed, including navigation failure without duplicate creation. An actual navigation smoke exercised the changed launcher against the existing coordinator, with creation intercepted and ownership recorded only in a temporary fixture; Orca reported `navigated: true`. No additional agent was launched. The existing coordinator was observed checking source-idle state and remote OMP prerequisites; that observation does not prove a completed remote OMP handoff.

## Proven failure before delivery (2026-10-14)

A claimed setup is not necessarily an attempted context delivery. `remote-abort-preflight` records an independently inspected coordinator execution report as `preflight_failed` / `aborted_before_delivery`, **not** a target `rejected` receipt:

```sh
orca-team remote-abort-preflight --role ROLE --intent EXACT_ID --report /absolute/private/outcome.json --project /path/to/worktree
```

The version-1 report must identify the exact intent, role, task and supplied source, explicitly report `aborted_before_checkpoint_request_and_before_context_delivery`, no destination creation/launch, no checkpoint request, no context delivery, no prepare/claim/accept, no assistant decision, empty request IDs, null receipt and nonempty technical stop reasons. It is coordinator execution evidence requiring human/agent inspection, not cryptographic proof. A report claiming unknown or actual delivery is ineligible.

Settlement permits only a claimed OMP request with baseRevision 0/baseRecordId null, unchanged original local owner/runtime, and an entirely unused handoff directory (only its lock file is allowed). It shares the Python helper's advisory ledger lock, checks the exact current terminal/program/incarnation/worktree twice, validates the original transcript and independently proves its live native session. Ledger/registry changes, missing native proof, earlier history or any prepare/claim/receipt refuse settlement. The project lock protects the registry; the helper's lock prevents concurrent prepare during settlement. Hosts without Python `fcntl` fail closed.

The atomic registry write removes only `pending` and appends an audit outcome containing the full original intent, exact report bytes (base64), SHA256, original report path, failure reasons and timestamp. Original report, ledgers and native histories stay in place. Ownership never moves. Repeating settlement with an old ID fails; it cannot create a fresh request.

`remote-status` exposes this terminal outcome. Ordinary `orca-team` displays persisted reasons before the picker. Failed-role rows start at confirmed local ownership; explicit off permits the existing local lifecycle without erasing audit, while Esc cancels startup without sending anything. A new explicit OMP selection now invokes deterministic readiness; failure leaves the source unchanged and creates no setup. Historical Codex failure protection and actual/unknown delivery protection remain. Noninteractive absence of a choice does not imply off.

## Menu recovery correction (2026-10-14)

Historical preflight failure no longer blocks access to the only user entry, `orca-team`. Confirmation is carried separately from remote ownership changes: failed rows emit their explicitly confirmed choice even when off matches the initial owner. The consumer removes a confirmed exact-local off choice from remote dispatch and continues the existing local lifecycle. It does not focus/recreate a remote agent or fabricate remote completion. Cancellation exits the command rather than accidentally falling through into team restart. Model catalog changes are not saved on cancellation.

That earlier regression covered menu rendering, unchanged off confirmation, OMP re-selection refusal, cancellation and retained audit. The historical smoke opened the picker and pressed Esc without restarting roles; local lifecycle was not exercised. At that stage OMP transport was unavailable. The native adapter and live evidence below supersede that limitation.

## Native OMP delivery (2026-10-14)

`remote-master/omp_adapter.py` provisions a role-scoped authenticated tailnet relay, two loopback tunnels, local worktree MCP, remote native OMP host/control service and local native `omp join` guest. Role resources and the saved provider/model/thinking are explicit; incompatible existing bindings fail closed. There is no public relay, model-credential copying, repository clone or Codex fallback. Process-specific config roots suppress ambient plugins/MCP discovery while retaining original auth/model storage references.

Creation intent is persisted before Orca creation. Unknown receipts/inventories do not cause retries. A closed local guest may be recreated only after authoritative absence and stable remote PID/instance/generation/session/model proof; a host failure is retained for explicit reconciliation, not silently replaced. A prepared/uncertain handoff still prevents provisioning or resend.

Prepared targets are durable. Forward and return settlement verify the actual adapter binding in addition to terminal identity. Same-session guest replacement appends a validated `owner_rebindings` chain under the shared Python ledger lock; archived original receipts are unchanged. `handoff.py` validates this chain to authorize the next revision from the replacement guest, rather than accepting an arbitrary new source.

Live evidence: local OMP 18.10.3 and remote 18.10.2 master/archi produced real model responses through the private native path and read local package.json via MCP. Master edited useCountUp.ts, rejected an old SHA, and restored the exact original hash. A separate local native source and remote master completed actual accepted revisions 1 and 2 in an isolated registry, returning SOURCE-ALPHA-7391 and the remote-read package name projects to the original source session/incarnation. The accepted remote guest was closed and reopened mid-roundtrip without changing the host/session or original receipt bytes. Existing business-role ownership and the Codex chain were not changed.

Verification: 74 Python adapter/security/transport tests, 102 focused menu/registry tests, and 7 live-socket relay tests passed. The documented Node adapter wrapper also successfully reused and verified the real native endpoint. Full team-suite, Windows and host-process crash recovery are not claimed. Operational details are in the installed orca-remote skill's references/operations.md, section 2.2.

## Direct handoff without an AI coordinator (2026-10-15)

Switches to a remote OMP owner and returns to the original local session (`off`) no longer open a `remote-setup` Codex coordinator. `lib/remote-handoff.mjs` runs the same protocol deterministically inside the `orca-team` process:

1. Before any ledger write: verify the OMP adapter bindings, require the source and target to be idle (`terminal wait --for tui-idle` locally, `/snapshot` `busy=false` remotely) and the target input to be empty. A failure here cancels the prepared intent; the source keeps the task and nothing is sent.
2. Mechanical checkpoint: user/assistant messages from the source's validated local transcript, or for a remote OMP source the assistant messages published by its control service `/messages` **after the forward delivery position**; the previous ledger goal is kept because the control service exposes no user messages. `changed_files` comes from `git status`. The summary stays within handoff.py's 24 KiB limit.
3. `handoff.py prepare`, `claimRemoteSetup`, `handoff.py claim`, record the target's reply position in `<ledger>/<recordId>.delivery.json`, then send the `handoff.py show --message` text once.
4. Poll the target's assistant messages after that position for exactly one `HANDOFF_ACCEPTED`/`HANDOFF_REJECTED` that also names the record ID or SHA256, and wait until the target is idle. Record it with `handoff.py accept`, then `commitRemoteSwitch`/`rejectRemoteSwitch` (the same verification as `remote-commit`) and focus the new owner.

After delivery, a missing receipt (default timeout 10 minutes) keeps `delivery_uncertain`; running the same switch again only resumes waiting from the recorded position and never resends. Remote Codex targets/sources still use the coordinator, because their conversation lives on the remote host.

`handoff.py` and the registry's ledger lock now use `msvcrt` on Windows instead of failing on the missing `fcntl`; the Python command is `python` on Windows (`ORCA_PYTHON` overrides). The remote OMP transport itself (`remote-master/*.py`) remains POSIX-only.


## Claude terminal entry in the local project (2026-10-15)

Remote Claude execution and local Orca workspace membership are separate. Previously reuse and remote-commit focused the remote host's registered workspace, so the current Windows project's sidebar had no remote role entry.

After native session verification, lib/claude-local-terminal.mjs creates or reuses one local terminal in the invoking project. bin/claude-remote-terminal.mjs attaches to the exact existing remote PTY using Orca's paired, encrypted terminal stream. Native screen, input and viewport changes are forwarded; this never starts another Claude session or replays uncertain input. Native activity symbols are preserved with a local role label, so Orca shows the remote Claude entry in the current project's agent tree. Ctrl+] detaches only the local client. A lost connection retains the remote session and reports disconnection.

local-terminal.json and local-terminal-status.json record presentation identity separately from the handoff owner. Reuse requires the same project, local incarnation, live process/heartbeat, paired runtime and exact remote endpoint. Creation intent is persisted before the command; an uncertain result is not retried. A missing pane can be recreated only after a successful scoped inventory and a fresh native remote-session proof. The bounded same-pane reconnect described below handles a stopped client; startup never sends a launcher into an unidentified live pane.

Both explicit remote reuse and normal start for a confirmed Claude owner now focus the local entry. remote-commit also mounts the local entry after accepted ownership is verified. Original local source conversations remain paused and their history is retained. Remote native sessions remain registered on the remote host; only their interactive entry is mounted locally. No app bundle or Orca database edits, repository copies or model credentials are involved.

## Startup after a catalog sync (2026-10-16)

When a synced catalog selects Claude but the original local return conversation is OMP, ordinary startup now leaves that original CLI/session intact and verifies/reuses the confirmed remote owner. Pending handoffs and roles included in a new remote/off request also bypass local CLI migration. Independent local roles still migrate normally, and explicit restart retains its CLI mismatch guard. Previously the local CLI comparison rejected startup before remote reuse with `Cannot switch CLI for continuity-bound roles`.

Windows repair launch now invokes the quoted command with PowerShell's `&` operator. The previous quoted command was parsed as two adjacent strings, leaving an idle shell although a repair terminal had been created. Agent and repair launches use installed PowerShell 7.3+ with Standard native argument passing, preserving embedded quotes and multiline handoff prompts that Windows PowerShell 5 corrupted. No shell installation or global configuration is changed. Creation remains at most once; uncertain repair requests still require reconciliation.

Regression coverage includes protected source/return sessions, independent local migration, settled-local migration, and executing the repair command through a harmless npm-style Codex wrapper and native Node process to verify the complete prompt arrives as one argument. Live master/archi scoped starts succeeded after reconnecting their proven idle local presentation shells to the same remote Claude Opus sessions. Reconnection was recorded before input and verified with native binding checks and fresh client heartbeats; no remote agent was launched and no business prompt was submitted. The interrupted simple launch was reconciled after its exact marker appeared in the historical CLI argument error, no native transcript matched, and the original idle shell was proven; its original launch intent and handoff were retained and normal scoped start passed.

Live acceptance: master and archi appeared under industrial-drawing-translator / main / Local Windows. Both retained their exact remote terminal incarnations and native sessions, with actual claude-opus-5-5 confirmed through process/PTY/transcript checks. Explicit remote reuse and ordinary scoped start succeeded. Transport/mount checks passed; see [Claude remote behavior](remote-claude.md) and the [publication checks](../changes/2026-10-15-remote-claude-and-parallel-designers.md) for current results. Full local orchestration inbox/dispatch migration is still outside this terminal mount repair.

## Stopped local clients and final startup verification (2026-10-16)

A remote RPC timeout or closed connection can stop the local presentation process while the remote Claude session keeps running. Startup previously waited for a heartbeat from that stopped process and failed. It now reconnects in the same local pane only after proving the old client PID is absent, checking an empty native shell twice, and verifying the exact remote owner again. A durable reconnect intent precedes the single launcher send; its nonce must appear in the new client's live heartbeat before success. Unknown delivery is retained for reconciliation, input drafts are untouched, and repeated completed reconnects archive the previous receipt. This repairs recovery after a disconnect; it does not prevent network outages or retry business keystrokes.

Historical tab-retirement proof now survives a later legitimate CLI change in its established live replacement pane. Published old panes, disconnected replacements, foreign projects and ambiguous replacement identities remain blocked. Windows local Claude launches explicitly use the default permission mode, avoiding an inherited bypass-permission confirmation during startup.

The original full startup with `--no-pick --no-repair` returned exit 0. Master and archi reconnected to their unchanged remote Opus sessions under the invoking local project; all eight local roles had verified native process/session bindings, including both designers. Loader and simple retained their original launch markers and handoff documents. Optional Orca tab pinning was not applied by this desktop version; configured layouts were verified. At this checkpoint reviewer started on local Claude Sonnet but its first context-read request received API 403 `Current user is in debt`. The later verified OMP selection and successful context recovery described below resolved that startup blocker.

The earlier publication checkpoint was assembled from the remote baseline plus only the 17 reviewed repair files, excluding unrelated local changes. Its full suite has 429 tests: Windows passed 419 with 10 POSIX-only skips; Linux passed 427 with 2 Windows-only skips; both had zero failures. The 2 sync-exclusion tests also passed. Cross-platform coverage includes Windows file-URL normalization and native argument preservation. Native OMP adapter tests require POSIX private file modes and run on Linux; Windows skips these explicitly instead of weakening the production file-permission checks.

## Loader beside a remote master (2026-10-16)

After a selected Codex-to-OMP switch, loader's source exited and its handoff was saved, but startup skipped the entire master/loader group because master was remotely owned. This left loader at an idle shell while the command could report success. Protection now applies to individual roles: loader completes the existing CLI handoff in its verified original pane, while master's original local return state, remote ownership and shared layout stay untouched. A missing sibling pane fails explicitly instead of creating a replacement tab or silently skipping it. Remote proof failures are accumulated while independent local recovery continues, then startup returns failure with the actual reasons.

The native Claude probe now recognizes both exact `--session-id` launches and `--resume` of the same session. It parses executable and arguments rather than matching substrings; conflicting IDs, another model, a shell wrapper and session-prefix matches are rejected. The live remote master had resumed its original session, which previously produced a false identity failure.

Live validation: loader launched OMP with the already selected `pay/gpt-6-astra` / `xhigh`, read its retained Codex handoff and replied `loader ready`. Reviewer had also moved to its selected OMP runtime and replied `reviewer ready` after reading both handoff documents. Full startup returned exit 0 and checked all eight local roles, including loader; native bindings were verified and remote ownership plus original master/archi return records remained byte-for-byte unchanged. The installed suite passed 429 tests with 10 platform skips and no failures (439 total).

## Distinct sidebar identities after recovery (2026-10-16)

Orca applies a custom terminal-tab title to every agent row in that split. Renaming the retained master/loader tab to include loader therefore made two different native sessions appear as duplicate loaders; coder and designer splits had the same ambiguity. The desktop's `session.tabs.updatePaneLayout` also acknowledges leaf-title edits without applying them while an authoritative window is open. A success receipt alone did not establish the requested sidebar change.

OMP launches now load a small role-title extension that sets the native session name through OMP's own API, with no model turn. Startup verifies the exact local tab/leaves and distinct native names before clearing their shared custom title. It does not send rename commands into agents during startup, and unsupported/missing native names fail visibly instead of claiming a repaired display. Working OMP titles may append the project name; that suffix is verified separately. Other CLI types retain their existing behavior.

The existing ten OMP sessions received native `/rename` metadata commands only after process/session and empty-input checks. Source master/archi names explicitly retain their local-return status; their remote Claude owners remain separate. No transcript was manually edited, no extra business agent was created, and no business prompt was submitted by this repair. Live accessibility and screenshot checks show one loader, separate coder1/coder2 and designer/designer2, plus distinct reviewer and test entries under the invoking local project. The two retained local return sessions and existing auxiliary Codex sessions are still present and identifiable.

Full normal startup with `--no-pick --no-repair` exited 0. A separate ephemeral native OMP RPC probe loaded the naming extension and returned the expected session name, zero messages and `isStreaming=false`. Later loader received work outside this repair and entered working state in its original terminal/session; an optional restart check correctly refused at the busy guard before exit or launcher input. No forced restart was performed. Optional desktop tab pinning remains unsupported by this Orca version; pane layout and role names were verified independently.

The final publication candidate contains only the 27 reviewed repair paths atop upstream `0b301da`, retaining its copywriter role and model choices. The upstream team's count assertions were updated for twelve roles/eight groups. Final suites: 448 tests; Windows 438 passed and 10 platform skips, Linux 446 passed and 2 platform skips, zero failures. The installed package has four additional local tests (452 total). Two synchronization-exclusion tests passed. Runtime identities, handoff ledgers, transcripts, secrets and unrelated configuration exports are excluded from publication.

## Recovery after profile migration and missing return panes (2026-10-28)

Orca's profile migration can leave an obsolete `orca-data.json` beside the authoritative `profile-state.db`. Reading the old export caused startup to inspect retired tabs and refuse valid original conversations. `lib/orca.mjs` now reads the SQLite `workspaceSession` document in a read-only transaction, checking profile identity, revision, domain version and content hash. A database or migration marker prevents fallback to obsolete JSON when verification fails. Profiles without migration evidence retain legacy JSON support. No profile database is modified or exported.

If a remote owner's original local tab has disappeared, a local sibling such as loader may resume its exact saved conversation in a separate tab. Both the live inventory and published desktop panes must show the original protected tab absent; the normal native process-absence checks still run before a resume. The protected role's saved return conversation and remote ownership remain unchanged. If the original protected tab is present or its absence is uncertain, recovery retains the existing refusal. Extra-terminal cleanup is deferred while original remotely owned return panes are absent.

Windows absence checks distinguish a local remote-Claude presentation process from a local Claude agent. The proof requires the exact installed client launcher, descendant PID, local terminal incarnation and pane, matching scoped remote endpoint, and a connected heartbeat younger than 25 seconds. Reconnected clients additionally require the launch connection ID to match the heartbeat. This permits independent local recovery without weakening the unbound-agent guard; native scans still reject a running original conversation anywhere on the machine.

Remote Claude diagnostic-shell or owner identity changes still stop automatic reuse. Recovery must verify the original native session, transcript, model, process ancestry and scope, then use the existing audited owner-rebinding API. This change does not automatically recreate a remote agent, change the task ledger owner to another conversation, resend uncertain input, or remove a pending handoff.

Verification: the portable publication candidate passed `node --test tests/*.test.mjs` on Windows (497 passed, 10 platform skips, zero failures). Regression cases cover authoritative SQLite snapshots and integrity failures, detached sibling resume and repeat-start idempotence, presentation identity and reconnect nonces, and cleanup deferral. The installed repair also passed a full startup in 45.2 seconds, with all ten configured roles independently verified against their original native sessions. Native tab pinning remains optional and unsupported by the observed Orca desktop version; local loader may remain in its own tab. No fresh cross-platform live acceptance is claimed for this change.
