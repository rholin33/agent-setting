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

When the selected scope has a switch request, a pending intent, or a remotely owned role, ordinary `start` preserves each protected group and skips its updates/reloads/recovery. Independent groups can recover; unresolved protected roles still make startup incomplete. This preserves sources and original return panes before checkpoints. A separate explicit `restart` is still an intentional runtime operation, not a context switch, and may invalidate a recorded incarnation; never use it to repair a pending handoff. `--fresh` refuses continuity-bound roles.

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
