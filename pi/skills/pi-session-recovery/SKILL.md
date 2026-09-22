---
name: pi-session-recovery
description: Use when a Pi session is unusable after long context, hangs while resuming or rendering history, exceeds the context window, loses read/bash tools after Magic Context compaction, or the user asks to recover a Pi master session (上下文过长、会话卡死、工具丢失、恢复 master).
---

# Pi Session Recovery

恢复用户指定的 **原 Pi 会话**，保留历史和业务断点。适用于 Orca、普通终端及实际由 CCB 管理的 Pi；按宿主选择操作入口。先阅读 [恢复操作参考](references/recovery.md)。

## 1. 锁定目标

- 从用户请求和运行状态确定项目、角色、session ID、JSONL 绝对路径、Pi 可执行文件、版本、模型、启动参数、PID、终端 handle。不可凭旧 PID 或旧 handle 操作。
- Orca：使用 `orca-cli` 技能，先加载当前 CLI 的指南，再列出终端并读取目标。`.orca/roles/ccb-team/projects/*/state.json` 是绑定线索，必须与实时进程及终端核对。
- 当前 Pi 仅在 `CCB_CALLER_ACTOR`、`CCB_CALLER_RUNTIME_DIR`、`CCB_SESSION_ID` 三项均非空时应用 CCB 分工。实际 CCB 运行变更按规则交给 loader；不能因目录里有 `.ccb` 就走 tmux。
- 若目标就是执行恢复的当前会话，不能自行结束当前进程；将停进程/RPC 恢复交给独立控制会话。
- 读取报错及少量日志，统计保留历史的大小，避免把巨型 thinking 或整个 JSONL 输出进上下文。

## 2. 按症状选择恢复路径

| 症状 | 下一步 |
|---|---|
| TUI 可响应，Magic Context 已压缩但待生效 | 核对本机命令后 `/ctx-flush`，执行最小只读探针，让压缩结果生效 |
| TUI 无响应，CPU 持续增长，保留历史有巨型内容 | 停止核实过的单个目标进程，确认退出，用同一 session 的官方 RPC 模式恢复 |
| 压缩后模型称没有文件/终端工具 | 核对工具调用证据、Pi/扩展版本与 GitHub issue；按参考检查 #485 |
| `ParseError` 或扩展加载失败 | 先定位当前文件和错误；语法检查通过不代表 Pi 扩展加载成功 |
| 403/429/524、连接失败 | 按服务/认证问题处理，不据此反复压缩或清历史 |
| 无 Magic Context | 使用当前 Pi 官方 compaction 文档；不要发送 `/ctx-*` |

不要把 `/ctx-flush` 当成新一轮摘要：它只处理已排队操作。无待生效压缩且仍超限时，检查 historian 状态及当前版重新压缩命令；不要循环发送。`/ctx-wrapup` 仅在用户明确要求时使用。

## 3. 执行与验证

1. 恢复请求已授权必要的目标会话操作；遵守当前宿主和项目规则。修改补丁前备份准确的原文件。需要数据库修改、历史删除或额外环境变更时，不扩展本技能范围。
2. RPC 与 TUI **不得同时打开并写入同一 session**。保留原模型、项目 cwd、会话路径和角色 system prompt。只通过 Pi/扩展支持的接口生成压缩边界，不手改 JSONL 或 SQLite。
3. 发送只读探针：读取项目中已存在的小文件前 5 行，要求返回 `MASTER_RECOVERY_OK` 或适用标记，并明确禁止执行原业务任务。确认实际 `tool_execution_end` 成功；只看回复文字不算通过。
4. 观察 `agent_settled`，确认无重试、待处理消息或压缩写入；退出临时 RPC，核实退出后用宿主入口恢复原 TUI。
5. 在恢复后的 TUI 验证命令响应，例如 `/ctx-status`；关闭状态弹窗。记录上下文前后变化、当前 PID 和未解决问题。

## 常见误判

- `input_accepted` 只表示输入被接收；必须读取实际终端结果。
- 不清空历史、不创建空会话冒充恢复、不批量结束所有 Node/Pi 进程。
- 不把旧版本补丁无条件应用到新版，不自动升级依赖；升级可能覆盖本地补丁。
- 恢复完成后等待用户继续，除非用户已明确要求本次恢复后接着执行业务。

验收清单和未实测边界见 [验证记录](references/validation.md)。
