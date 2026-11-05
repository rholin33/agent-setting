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
- `agent-setting-sync ccb` syncs that file to `~/.ccb/ccb.config` as a remote-authoritative configuration and backs up a different local copy before replacement.
- Required Role packages are declared in `ccb/roles.json`; the hook installs missing packages without tools and retries unavailable packages on later sessions.
- Syncing updates disk configuration only. It must not reload, restart, or otherwise mutate a mounted CCB runtime automatically.
- Never sync `.ccb/agents/`, provider state, jobs, events, runtime bindings, or generated agent memory. CCB recreates those from `ccb.config` and installed Role packages.

<!-- magpie:begin · written by magpie from its Library -->
# Global Codex Instructions

## Installed Skills From bd-dxg/skills

The following skills from `https://github.com/bd-dxg/skills` are installed globally under `~/.codex/skills`:

- `code-review-expert`: structured code review focused on architecture, SOLID, security, and removable code.
- `gencom`: generate a project-style commit message from the current Git diff.
- `grill-me`: ask iterative questions about a plan or design until open decisions are resolved.
- `naming`: generate concise natural English file names from Chinese descriptions.
- `planning-with-files`: organize complex work through file-based plans, findings, and progress records.

Use these skills when the user explicitly names them or when the task clearly matches their purpose.

## Installed Skills From nextlevelbuilder/ui-ux-pro-max-skill

The following skills from `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill` are installed globally under `~/.codex/skills`:

- `banner-design` (`ckm:banner-design`): design banners for social media, ads, website heroes, creative assets, and print.
- `brand` (`ckm:brand`): brand voice, visual identity, messaging frameworks, asset management, and consistency checks.
- `design` (`ckm:design`): comprehensive design workflows for logos, CIP, slides, banners, icons, and social images.
- `design-system` (`ckm:design-system`): token architecture, component specifications, and slide generation.
- `slides` (`ckm:slides`): strategic HTML presentations with Chart.js, tokens, layouts, and copywriting formulas.
- `ui-styling` (`ckm:ui-styling`): accessible UI styling with shadcn/ui, Tailwind CSS, and canvas-based visual designs.
- `ui-ux-pro-max`: UI/UX design intelligence for web and mobile, with searchable data and scripts.

Use these skills when the user explicitly names them or when the task clearly matches their purpose.

## Superpowers 本地覆写

- 轻量任务不进入完整 brainstorming / writing-plans / using-git-worktrees / subagent-driven-development 链路。
- 轻量任务定义：单文件或小范围修改、明确 bug 修复、配置调整、文案修改、小测试补充。
- 轻量任务默认直接分析代码并实现；只有遇到关键不确定性时才提问，且首次最多问 1 个问题。
- 如果项目上下文、AGENTS.md、现有代码已经能回答的问题，不要重复提问。
- 非我明确要求时，不要默认创建 worktree。
- 非我明确要求时，不要默认把 spec / plan 提交到 git。
- 在 Codex 环境中，默认优先使用 executing-plans，而不是 subagent-driven-development。
- 只有在任务明确适合并行、且平台对子代理支持良好时，才使用 subagent-driven-development。
- 需要确认时，优先一次性给出 2 到 3 个可选方案和推荐，不要把确认拆成过多轮。
- 以下操作仍然必须确认：删除文件（下节明确授权的本轮临时内容清理除外）、大规模重构、修改 git 历史、推送远程、改环境配置、改 CI、数据库变更。

## 任务产物与浏览器缓存清理

- 创建文件前先区分交付物与临时内容。交付文档、用户要求的产物及必要验收证据保存到项目约定位置；临时脚本、中间输出、调试截图、下载副本、测试缓存和浏览器 profile 默认放系统临时目录下本任务独立创建的目录，不散落在仓库、用户主目录或长期文档目录中。确需在项目内运行的临时文件应集中存放并记录精确路径。
- 使用操作系统临时目录 API，兼容 Windows、macOS、Linux；为每次任务或测试运行创建唯一目录。浏览器自动化使用独立的临时 context/profile，不复用或清理用户日常浏览器 profile、登录数据或其他任务的缓存。
- 编写或修改会生成临时文件的脚本时，用 try/finally、上下文管理器或等效机制覆盖成功、失败及可捕获中断的收尾；先关闭本轮浏览器/context 和文件句柄，再清理临时目录。仅在启动前清理旧目录不算完成收尾。异常退出无法清理时，应记录残留路径，待确认无活动进程占用后处理。
- 本规则明确授权自动清理本轮创建、用途明确、归属可核实且已不再使用的临时文件与目录，无需逐项再次确认。递归删除前核对解析后的绝对路径确实位于本任务记录的临时目录内；不得跟随符号链接或 junction 越界，不得用宽泛通配符、文件名相似或修改时间推断归属。删除操作使用同一 shell 的原生命令。
- 历史残留、用户已有文件、归属不明内容、仍在运行的服务数据，以及持久源码副本、未回传修改、提案、恢复备份和会话历史，不属于自动清理范围；删除这些内容仍需明确确认。不得为清理而中断无关进程。
- 任务结束前核对本轮产物清单，清理可回收内容，只保留交付物及最少必要证据。确需保留诊断文件时明确说明用途和路径；清理失败或仍有占用时如实报告残留，不能声称已清理。长时间等待用户期间，在安全检查点回收已不再使用的临时内容。
- .gitignore 仅防止误提交，不能代替实际清理。新增持久缓存须定义复用方式、容量或数量上限及回收策略，避免每次运行无上限新增目录；回收仍遵守上述归属与授权边界。

## Imported Rules

Rules imported from `https://github.com/bd-dxg/skills` are stored here:

- `~/.codex/rules/bd-dxg-code-style.md`
- `~/.codex/rules/bd-dxg-tool-usage.md`

Apply the code-style guidance when it matches the active project and does not conflict with repository-local conventions. Prefer project-local instructions over these imported global rules.

The imported tool-usage rule was written for Claude Code on Windows. In Codex, follow Codex's active tool and sandbox instructions first. Treat `~/.codex/rules/bd-dxg-tool-usage.md` as reference material only when its guidance is compatible with Codex tools.

Original Claude Code examples from the repository are archived in:

- `~/.codex/bd-dxg-skills/CLAUDE.md`
- `~/.codex/bd-dxg-skills/settings.json`
- `~/.codex/bd-dxg-skills/mcp.json`
<!-- magpie:end -->
