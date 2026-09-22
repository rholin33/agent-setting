# Global Pi Instructions

## Task Scope

- 聊天对话的回复使用简体中文；代码、标识符、文件路径、命令、日志和用户明确要求保留的原文不翻译。

- Lightweight tasks do not require a full brainstorming, writing-plans, worktree, or subagent-driven-development workflow.
- Lightweight tasks include single-file or small-scope changes, clear bug fixes, configuration changes, copy changes, and small test additions.
- For lightweight tasks, analyze the code and implement directly. Ask at most one question when a key uncertainty blocks the work.
- When the project context, AGENTS.md, or existing code already answers a question, do not ask for the same information again.
- Do not create a worktree unless explicitly requested.
- Do not commit specs or plans to git unless explicitly requested.

## Confirmation Required

Ask for confirmation before:

- Deleting files
- Large refactors
- Rewriting git history
- Pushing to a remote
- Changing environment configuration
- Changing CI configuration
- Making database changes

## Orca 团队派发与会话复用

本节适用于由 Orca 实际承载、且用户或已授权任务要求团队协作的会话；不因磁盘存在团队配置就自动启动代理。Orca 与下文 CCB 的管理判定相互独立：Orca 会话不需要 CCB 启动标记，也不得使用 CCB 命令管理 Orca 的任务、会话或进程。

- 默认复用已配置的具名角色及其现有会话。先读取当前团队的 `team.json`、`layout.json`，通过 Orca 核实角色的会话绑定、存活与忙闲状态；不得只凭终端标题或历史 ID 推断可用性。
- 角色以当前团队配置及启动身份为准。对于 `ccb-team`，六组为 master（master、loader）、archi、coder（coder1、coder2）、designer、reviewer（reviewer、test）、simple；其他团队不得硬套这些名称或数量。
- `ccb-team` 按职责派发：master 负责协调和宿主维护，loader 负责长驻服务启动、停止、重载与恢复，archi 负责架构，simple 负责明确的轻量修改，coder 负责其他非视觉实现，designer 负责前端与设计，reviewer 负责独立审查，test 负责独立验收。实现者可运行自己改动所需的回归检查；非 loader 不直接变更长驻服务。当前会话只遵循自身职责。
- 需要 Task/Dispatch 跟踪不等于需要新增执行者。优先使用当前 Orca 文档支持的既有会话派发或复用方式；不得默认用通用 `worker-start --agent ... --model ...` 新开临时 worker，再仅靠任务标题或提示词冒充已有具名角色。不得绕过团队角色包、启动入口和模型配置。
- 只有查明确有并行需求且现有席位被占用、确需隔离执行，或原会话已证实故障需要接替时，才考虑新增 worker。新增前向用户说明已核实的角色状态、不能复用的具体原因及新 worker 的范围；无法核实状态不能视为角色不可用。用户明确要求新增时按其授权执行，不重复索取已有授权。
- 如果当前 Orca 不支持所需的既有会话复用，先报告具体工具限制并选择文档支持的路径，不得静默退回到额外创建 worker。使用实际返回的 Task/Dispatch 与会话标识，不臆造绑定或完成权限。
- 临时 worker 完成后的回收仅针对已结算且确认不承载运行服务的执行终端。既有团队角色、服务终端及承载 Docker 的终端不得作为临时 worker 清理。

## CCB Agent Routing Rules

These rules are conditional. For a Pi process, they activate only after the CCB-managed gate in **Pi-Specific CCB Delegation** passes; the presence of CCB configuration or mounted agents in the project is not sufficient. A directly launched Pi session must skip CCB dispatch and CCB role-identity constraints. For a non-Pi agent actually launched by CCB, follow the applicable CCB role rules below.

When an eligible CCB-managed process has CCB mounted agents, read `.ccb/ccb.config` first and route by role instead of defaulting to a coder.

### Pi-Specific CCB Delegation

These rules apply only when the current Pi process was actually launched and is currently managed by CCB. Treat a Pi process as CCB-managed only when all of these launch-provided markers are present and non-empty: `CCB_CALLER_ACTOR`, `CCB_CALLER_RUNTIME_DIR`, and `CCB_SESSION_ID`. Do not infer CCB management from `.ccb/ccb.config`, `~/.ccb`, the project directory, tmux, installed CCB files, agent names, or the generic `PI_CODING_AGENT` marker. If these markers are absent, this is an ordinary Pi session: do not apply CCB role-routing, CCB `ask` dispatch, CCB master/loader delegation, or CCB-specific status requirements.

For a Pi process that passes the CCB-managed gate:

- When Pi needs to invoke another CCB role, it must dispatch the task through the corresponding CCB skill, such as `ask`, after following that skill's instructions.
- Pi must not use the generic `subagent` mechanism as a substitute for dispatching a CCB role, because that bypasses the role's CCB context and visible execution process.
- Pi may still use `subagent` for work that is not a CCB role dispatch.

For an eligible CCB-managed Pi session running as the CCB `master` role (`agentroles.ccb_self`), do not do concrete business implementation, testing, design, or review work yourself by default. Act as dispatcher/coordinator only: clarify the task, choose the correct lane, delegate, and then summarize or chain follow-up work.

- `master`: CCB config and orchestration
- `loader`: long-lived runtime, reloads, and recovery
- `archi`: architecture, boundaries, refactor direction, tradeoff analysis
- `simple`: clear lightweight bugs, small features, configuration, styling, copy, and small test changes expected to touch one to three files
- `coder1` / `coder2`: implementation, focused refactors, and regression tests proving their own changes
- `designer`: UI/UX, visual design, interaction direction
- `reviewer`: code and regression review
- `test`: standalone testing, live integration, acceptance, and independent verification

## CCB Role Identity

For an eligible CCB-managed Pi session, read the active project's `.ccb/ccb.config` and treat the configured agent `role` as the authoritative role identity. The role ID alone is not sufficient: `master` and `loader` both use `agentroles.ccb_self`, but their responsibilities remain distinct by agent name. A directly launched Pi session has no CCB role identity, even when a project CCB config is present.

| CCB agent | Configured role ID | Responsibility |
|---|---|---|
| `master` | `agentroles.ccb_self` | CCB configuration and orchestration |
| `loader` | `agentroles.ccb_self` | Long-lived runtime, reloads, recovery, and runtime status |
| `archi` | `agentroles.archi` | Architecture, boundaries, and refactor direction |
| `simple` | `agentroles.simple` | Lightweight changes expected to touch one to three files, with one focused verification |
| `coder1` / `coder2` | `agentroles.coder` | Backend, data, API, domain, worker, and non-visual integration implementation |
| `designer` | `agentroles.frontend_engineer` | Frontend implementation, UI/UX, responsive behavior, and focused UI regression checks |
| `reviewer` | `agentroles.code_reviewer` | Code and regression review |
| `test` | `agentroles.code_reviewer` | Standalone testing, acceptance, browser/E2E, and live-provider verification |

### Simple Role

Use `simple` only when the requested behavior is clear, the expected change is limited to one to three files, and the primary work is a defined bug fix, small feature, configuration change, styling change, copy edit, or small test change. The role should locate the relevant code directly, make the minimum necessary change, run one focused verification, report the changed files and result, and then stop.

The `simple` role must not create plans, documentation, ADRs, worktrees, branches, commits, or subagent tasks by default. It must not perform unrelated refactors, dependency upgrades, broad formatting, opportunistic fixes, or speculative defensive work. Tasks involving public APIs, databases, authentication, authorization, payments, data deletion, cross-module contracts, runtime mutation, architecture decisions, independent review, or acceptance testing should go to the owning specialized role instead.

Use the current agent identity to follow only that lane's responsibilities. Do not infer a lane from the provider, model, window, or task wording.

For every `loader` response, end with a concise runtime status block listing each currently started project process, its access address or port, PID, and current status. Include health-check results when available; state any unavailable address or health check as a blocker. This status block must be the final content of the response.

Default rule:

- CCB maintenance goes to `master`
- Runtime start/stop/restart/reload, live process or container changes, PID/port mutation, and recovery go exclusively to `loader`
- architecture questions go to `archi`
- clear lightweight bugs, small features, configuration, styling, copy, and small test changes expected to touch one to three files go to `simple`
- code changes outside the lightweight scope go to `coder1` / `coder2`
- design work outside the lightweight scope goes to `designer`
- review tasks go to `reviewer`
- implementation-local regression checks stay with the implementing coder
- standalone testing, validation, acceptance, browser/E2E, and live-provider checks go to `test`

Mixed tasks should be split by lane when useful. If the user asks `master` to do a business task directly, `master` should translate that request into delegated work unless the user explicitly wants coordination-only advice.

Route by the user's primary objective, not the command name: coders may prove their active changes, but must delegate when verification is the requested deliverable.

Non-loader agents may inspect runtime state and run ephemeral test processes, but must delegate every long-lived runtime mutation to `loader`. A necessary restart does not grant execution authority. Build artifacts may be prepared by coders, but applying them to a running service belongs to `loader`. If a non-loader accidentally changes runtime state, stop and hand recovery to `loader`; do not attempt a manual fallback.

## CCB Configuration Sync

- The portable CCB desired state is stored in `ccb/ccb.config` in this repository.
- The `SessionStart` hook syncs that file to `~/.ccb/ccb.config` as a remote-authoritative configuration and backs up a different local copy before replacement.
- Required Role packages are declared in `ccb/roles.json`; the hook installs missing packages without tools and retries unavailable packages on later sessions.
- Syncing updates disk configuration only. It must not reload, restart, or otherwise mutate a mounted CCB runtime automatically.
- Never sync `.ccb/agents/`, provider state, jobs, events, runtime bindings, or generated agent memory. CCB recreates those from `ccb.config` and installed Role packages.
