---
name: ccb-pi-context-compression
description: Quickly trigger Magic Context recomp for the current CCB Pi and trim its tmux TUI history.
---

# CCB Pi Context Compression

Do only these two actions for the current CCB-managed Pi. Do not inspect or modify sibling agents, project services, Pi JSONL, or the Magic Context database.

## 1. Trigger Magic Context

1. Read the current project's `.ccb/agents/<agent>/runtime.json` and use its exact `pane_id`, provider, and tmux socket. The target must be the current Pi agent.
2. Use the official CCB context-command handler to send `/ctx-recomp` to that pane. Do not use `/compact`, `/clear`, or manual JSONL/SQLite changes.
3. If Magic Context shows `Recomp Confirmation Required`, send `/ctx-recomp` one more time immediately. Do not wait for historian completion or verify database, JSONL, compartments, context metrics, or idle state. Return after the command is accepted/submitted.

## 2. Trim TUI history

1. Set `history-limit` to `5000` on the target CCB tmux server.
2. Clear history for the target `pane_id`.
3. Ensure the persistent tmux config has `set -g history-limit 5000`.

TUI history trimming is independent of Magic Context and must not delete or rewrite Pi conversation data. Do not run `/ctx-wrapup` unless explicitly requested.
