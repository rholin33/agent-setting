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
