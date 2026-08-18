---
name: ccb-pi-context-compression
description: Safely compact one named Pi agent managed by CCB while preserving its complete session history. Use when a CCB Pi session is near or over its context limit, shows `Context full`, enters emergency recovery, has an accumulating Magic Context queue, or the user asks to compress one Pi without losing context. Covers target discovery, integrity backups, historian-backed `/ctx-wrapup`, bounded `/ctx-recomp` fallback, marker verification, and CPU/context acceptance checks; never treats tmux scrollback, mailboxes, or JSONL deletion as context compaction.
---

# CCB Pi Context Compression

Compact exactly one CCB-managed Pi session without deleting its conversation. Keep the operation scoped to the requested project root and agent name (for example, `master` or `archi`). Do not combine sibling Pi sessions in one run.

## Safety Contract

- Read the active project's `.ccb/ccb.config` before choosing a pane or role. Treat the configured agent identity and the project runtime as authoritative; do not infer a target from a tmux title alone.
- Preserve the Pi JSONL, session pointer, Magic Context SQLite database, and all existing backups. Never truncate, rewrite, deduplicate, or manually append to JSONL.
- Never edit `pending_pi_compaction_marker_state`, recovery flags, or other Magic Context markers directly. Never run `/clear` for a context-preserving repair.
- Do not use raw tmux input to send provider commands. Use the installed CCB `project_context.send_context_command`/official context-command handler, or the supported CCB request path for the target agent. Record the job/request id and wait for provider completion.
- If the caller is not the runtime-authorized CCB role, delegate long-lived pane/restart mutations to the configured owner (normally `loader`) instead of bypassing role ownership. Read-only diagnostics may be performed locally.
- Never expose API keys or copy credential-bearing configuration into logs, backups, or the final report.

## 1. Resolve And Classify

1. Resolve the project root explicitly. Require `.ccb/ccb.config`, `.ccb/agents/<agent>/runtime.json`, and the target Pi provider state beneath that root. Do not silently use another `$HOME/.ccb` project.
2. Read the target runtime record and confirm the exact `agent_name`, `pane_id`, `session_id`, `session_file`, lifecycle state, health, and queue depth.
3. Locate the target session JSONL from the runtime record, not from the newest file in the directory. Confirm that the requested agent is a Pi provider.
4. Read only bounded pane output to classify the current turn. Wait for the target Pi to be at a stable prompt with no active tool, `Working...`, historian, or provider request. Do not interrupt an active business turn unless the user explicitly authorizes it.
5. Query Magic Context for the target session. Use named columns only:

```sql
SELECT session_id, last_input_tokens, last_context_percentage,
       needs_emergency_recovery, emergency_recovery_origin,
       compartment_in_progress, pending_pi_compaction_marker_state,
       wrapup_in_progress_state
FROM session_meta
WHERE session_id = '<target-session-id>';
```

Also count `compartments`, `pending_ops`, and `historian_runs`, and group pending operations by `operation` and historian runs by `status`. Do not dump whole rows; they contain large cached fields.

Use this decision rule:

| Condition | Action |
| --- | --- |
| Context below roughly 70%, no emergency flag, no stuck marker | Verify and report; do not compact preemptively. |
| Context near the limit, `Context full`, or emergency recovery set | Back up, then use `/ctx-wrapup 50`. |
| Wrapup has no eligible progress, returns empty provider replies, or leaves a deferred marker after one bounded materialization attempt | Back up again and request user confirmation before `/ctx-recomp`. |
| `historian.model` is missing | Stop and report the configuration blocker; do not fabricate credentials or repeatedly retry. |

## 2. Create A Forensic Backup

Before any state-changing command, create a timestamped directory under the project, for example:

```text
.ccb/backups/pi-context-wrapup/<UTC>-<agent>-pre-wrapup/
```

Copy, without editing, all of:

- the target session JSONL;
- the target Pi session pointer (`.pi-<agent>-session` or the runtime-recorded pointer);
- `context.db`, `context.db-wal`, and `context.db-shm` when present.

Validate the backup before continuing:

- parse every JSONL line and record line count and byte count;
- compute SHA-256 for the JSONL and pointer;
- run `sqlite3 <backup>/context.db 'PRAGMA quick_check;'` and require `ok`;
- record the original session path, session id, and pre-operation context metrics.

Do not delete old backups. If the target is actively writing, wait for a stable prompt and make a fresh snapshot rather than trusting an earlier one.

## 3. Restore Required Historian Configuration

`/ctx-wrapup` and `/ctx-recomp` require an effective `historian.model`. Check project, CCB-isolated, and user Magic Context configuration without printing secrets. If the intended existing historian configuration is available in a trusted scope but absent from the target Pi scope:

1. show the missing-key diagnosis;
2. request explicit user approval for the persistent configuration change;
3. copy only the approved non-secret configuration into the target isolated scope;
4. validate it and use the official CCB restart/reload path if required;
5. re-resolve the exact Pi session and create a new pre-command backup.

Do not edit the Magic Context SQLite database to compensate for missing configuration.

## 4. Preferred Lossless Path: Wrapup

When the target is idle and backed up:

1. Use the official context-command handler to send `/ctx-wrapup 50` once.
2. Wait for the historian job to settle. Record chunks, compartments produced, historian status, and any `Partial`/`no-progress` result.
3. If a deferred Pi marker is queued, send at most one minimal provider message through the official handler to let the normal pipeline materialize it. Do not spam `retry` or submit parallel requests.
4. Re-read the database and pane. Native Pi compaction may be cancelled by Magic Context's `session_before_compact` hook; this is expected when Magic Context owns the compaction pipeline.

`/ctx-flush` only drains ordinary `pending_ops` (usually by marking them dropped). It is not a Pi compaction and cannot by itself reduce the rendered context.

## 5. Fallback: Full Recomp

Use `/ctx-recomp` only after the wrapup path genuinely stalls and the user has approved the heavier operation. It is still loss-preserving: Magic Context rebuilds compartments over the raw history; it must not rewrite or shorten the JSONL.

1. Create a new pre-recomp backup, even if a wrapup backup already exists.
2. Send `/ctx-recomp` through the official CCB context-command handler and wait for completion.
3. Accept a bounded automatic retry if a tool invocation/result boundary is rejected; do not manually choose a smaller range unless the handler reports it.
4. Record the number of compartments, historian passes, covered ordinal/message range, and any partial-range state.
5. Re-read all recovery and marker fields. If a marker remains but the rebuilt boundary is stale, inspect Magic Context logs for `stale-skip`, `compartment-removed`, or `target-superseded`; do not edit the marker.

## 6. Acceptance And Report

Require all of the following before declaring success:

- target Pi is idle/restored and the CCB queue is empty;
- context is back in a safe range (normally below 70%, preferably below 50%);
- `needs_emergency_recovery=0`, `compartment_in_progress=0`, and
  `wrapup_in_progress_state` is empty;
- `pending_pi_compaction_marker_state` is empty/null, unless the report clearly
  explains a non-blocking stale marker and the user accepts the residual risk;
- target SQLite `PRAGMA quick_check` returns `ok`;
- live JSONL remains parseable and its history was not truncated or rewritten;
- latest backup path, SHA-256, line/byte counts, context before/after, and historian/compartment counts are recorded;
- take several short CPU samples after settling. Distinguish Pi, ccbd, kitty, and WindowServer; do not treat a single transient spike as a persistent leak.

The native JSONL `type: "compaction"` count is a separate provenance signal, not the sole success criterion. Magic Context can reduce the active rendered context through compartments while Pi's native compaction hook is cancelled. Report that distinction explicitly.

## Scope Boundaries

- Do not clean `inbox.jsonl` or mailbox duplicates as a substitute for Pi compaction. Inspect mailbox pressure separately and leave it unchanged unless the user asks for a mailbox-repair task.
- Do not clear or delete terminal scrollback as a context repair. A tmux `history-limit` or `clear-history` operation changes only the UI buffer and must be handled as a separate, explicitly approved runtime task.
- Do not compact sibling agents automatically. Audit each Pi session independently and only act on the named target.
- Do not restart the whole CCB project merely to compact one Pi session.

Always finish with the target identity, backup location, before/after metrics, exact commands attempted, residual risks, and any unavailable health check or address.
