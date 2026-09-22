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
