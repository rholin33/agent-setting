# Global Codex Instructions

## Installed Skills From bd-dxg/skills

The following skills from `https://github.com/bd-dxg/skills` are installed globally under `~/.codex/skills`:

- `code-review-expert`: structured code review focused on architecture, SOLID, security, and removable code.
- `gencom`: generate a project-style commit message from the current Git diff.
- `grill-with-docs`: ask iterative questions about a plan or design while creating ADRs and a glossary; invoke explicitly because model invocation is disabled.
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

## Additional Installed Skills

The following skill directories also currently exist under `~/.codex/skills`:

### Codex System Skills

- `imagegen`: generate or edit raster images when bitmap assets are more appropriate than SVG, CSS, or code-native visuals.
- `openai-docs`: use current official OpenAI and Codex documentation, model guidance, and API references.
- `plugin-creator`: create and update Codex plugins, manifests, optional plugin structure, and personal marketplace entries.
- `skill-creator`: create or update skills with effective descriptions, workflows, progressive disclosure, and validation.
- `skill-installer`: list and install Codex skills from curated sources or GitHub repositories.

### Other Installed Skills

- `ask`: send requests to CCB agents with `ask`; use only when CCB delegation is appropriate.
- `cad-fill-dimension-report`: fill only the dimension-report worksheet of an Excel signing or FAI report from DWG-derived dimension specifications.
- `ccb-clear`: clear CCB-managed agent conversation context; use for explicit `$ccb-clear` or `$ccb_clear` requests.
- `agent-setting-sync`: synchronize portable Codex, Pi, and CCB configuration with the configured remote repository; use only for explicit sync requests. `$codex-sync` is the legacy alias.
- `context7-cli`: use the `ctx7` CLI to fetch current library documentation, manage skills, and configure Context7.
- `easypm`: manage EasyPM sessions, projects, work items, labour logs, progress records, and related Git hooks.
- `find-docs`: retrieve current documentation, API references, and examples for libraries, frameworks, SDKs, CLIs, and cloud services.
- `md-doc`: create or update a Markdown feature document for standalone features, workflows, modules, or cross-layer changes.
- `reconnect`: enable or disable tmux-bound disconnect recovery for the current Codex thread; use only for `$reconnect on` or `$reconnect off`.

The authoritative workflow for every skill is its own `SKILL.md`. This inventory reflects the current local installation and should be updated when skill directories are added or removed.


- 轻量任务不进入完整 brainstorming / writing-plans / using-git-worktrees / subagent-driven-development 链路。
- 轻量任务定义：单文件或小范围修改、明确 bug 修复、配置调整、文案修改、小测试补充。
- 轻量任务默认直接分析代码并实现；只有遇到关键不确定性时才提问，且首次最多问 1 个问题。
- 如果项目上下文、AGENTS.md、现有代码已经能回答的问题，不要重复提问。
- 非我明确要求时，不要默认创建 worktree。
- 非我明确要求时，不要默认把 spec / plan 提交到 git。
- 在 Codex 环境中，默认优先使用 executing-plans，而不是 subagent-driven-development。
- 只有在任务明确适合并行、且平台对子代理支持良好时，才使用 subagent-driven-development。
- 需要确认时，优先一次性给出 2 到 3 个可选方案和推荐，不要把确认拆成过多轮。
- 以下操作仍然必须确认：删除文件、大规模重构、修改 git 历史、推送远程、改环境配置、改 CI、数据库变更。

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

## CCB Agent Routing Rules

When a project has CCB mounted agents, read `.ccb/ccb.config` first and route by role instead of defaulting to a coder.

If you are running as the CCB `master` role (`agentroles.ccb_self`), do not do concrete business implementation, testing, design, or review work yourself by default. Act as dispatcher/coordinator only: clarify the task, choose the correct lane, delegate, and then summarize or chain follow-up work.

- `master`: CCB config and orchestration
- `loader`: long-lived runtime, reloads, and recovery
- `archi`: architecture, boundaries, refactor direction, tradeoff analysis
- `coder1` / `coder2`: implementation, focused refactors, and regression tests proving their own changes
- `designer`: UI/UX, visual design, interaction direction
- `reviewer`: code and regression review
- `test`: standalone testing, live integration, acceptance, and independent verification

## CCB Role Identity

When CCB launches Codex or Pi, read the active project's `.ccb/ccb.config` and treat the configured agent `role` as the authoritative role identity. The role ID alone is not sufficient: `master` and `loader` both use `agentroles.ccb_self`, but their responsibilities remain distinct by agent name.

| CCB agent | Configured role ID | Responsibility |
|---|---|---|
| `master` | `agentroles.ccb_self` | CCB configuration and orchestration |
| `loader` | `agentroles.ccb_self` | Long-lived runtime, reloads, recovery, and runtime status |
| `archi` | `agentroles.archi` | Architecture, boundaries, and refactor direction |
| `coder1` / `coder2` | `agentroles.coder` | Backend, data, API, domain, worker, and non-visual integration implementation |
| `designer` | `agentroles.frontend_engineer` | Frontend implementation, UI/UX, responsive behavior, and focused UI regression checks |
| `reviewer` | `agentroles.code_reviewer` | Code and regression review |
| `test` | `agentroles.code_reviewer` | Standalone testing, acceptance, browser/E2E, and live-provider verification |

Use the current agent identity to follow only that lane's responsibilities. Do not infer a lane from the provider, model, window, or task wording.

For every `loader` response, end with a concise runtime status block listing each currently started project process, its access address or port, PID, and current status. Include health-check results when available; state any unavailable address or health check as a blocker. This status block must be the final content of the response.

Default rule:

- CCB maintenance goes to `master`
- Runtime start/stop/restart/reload, live process or container changes, PID/port mutation, and recovery go exclusively to `loader`
- architecture questions go to `archi`
- code changes go to `coder1` / `coder2`
- design work goes to `designer`
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
