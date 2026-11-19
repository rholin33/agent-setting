---
name: codex-sync
description: Use when the user invokes the legacy codex-sync alias for agent-setting synchronization.
---

# Legacy Alias

Read and follow ../agent-setting-sync/SKILL.md. Require exactly one explicit
target: ccb or orca. Forward push or force unchanged; they are mutually exclusive.
Without a target ask which one and do nothing. Without explicit push, never
export, stage, commit or push. Do not use the former automatic commit workflow.
