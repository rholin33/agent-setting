# 远端 Claude 与本地项目入口

## 功能概述

`orca-team` 支持把角色交接到 Orca 配对主机上的原生 Claude 会话。远端运行 Claude，本机当前项目保留可交互入口。2026-10-15 已验证 master、archi 使用远端 Opus，并显示在调用项目的 `main → Local Windows` 清单下。

## 使用流程与界面

- 模型菜单按 `r` 依次切换 `off → codex → omp → claude → off`；也可指定 `--remote claude:ROLE --environment NAME`。
- 环境缺失或存在多个候选时，在停止本机角色或切换其 CLI 之前报告阻塞。环境名称不代表运行程序；注册主机后仍须验证连接、工作区权限和原生会话。
- 首次交接由 `orca-remote` 协调者核对源角色、安全暂停、目标权限及助手回执。`remote-commit` 只接受匹配的已验证交接记录。
- 提交交接后，在发起项目创建本地终端入口，连接已存在的远端 PTY。普通启动和显式远端复用均聚焦此本地入口。
- `Ctrl+]` 仅断开本地客户端。连接中断保留远端进程与历史；未知投递结果不会自动重发。

## 远端主机上的项目归属

远端角色终端统一建在远端主机的独立 Orca 项目中：`<远端用户目录>/Code/orca-remote/<调用方项目名>`。`lib/remote-project.mjs` 通过已配对的加密通道调用远端 `files.browseServerDir('~')` 取用户目录与路径风格（posix/win32），再用 `repo.create` 创建或复用该项目，因此远端是 macOS、Linux 或 Windows 都适用。同名项目已登记时直接复用；目录存在但非空且未登记时报错，不改用其他目录。OMP 适配器自动使用该路径；Claude/Codex 协调者通过 `orca-team remote-project` 取得。此前远端角色会被建到远端当前打开的项目里，混在对方项目的标签页中；已有的旧远端会话不自动迁移。

## 实现与状态

`claude-binding.mjs` 核对配对 runtime、terminal、incarnation、原生 session 和工作区。需要原生探测时，`claude_probe.py` 还核对 daemon 身份、PTY、进程父子关系、实际 cwd 与会话记录中的模型。

`claude-local-terminal.mjs` 将展示状态与任务 owner 分开记录。私有 `binding.json` 包括 version、role、project、environment、runtimeId、remoteWorktree、endpoint，以及按需使用的 registeredWorktree、probeTerminal、probeIncarnation。endpoint 包含 runtime、role、environment、terminal、incarnation、session。所有值来自实际观察；此文件及 pending 中的 claudeConfig 引用只保存在本机。

创建前保存意图，成功后保存 `local-terminal.json`；运行进程写入 `local-terminal-status.json`。复用需要匹配本地窗格、进程、心跳和远端身份。创建结果未知时保留现场，不重复创建。

`claude-terminal-client.mjs` 使用 Orca 配对身份建立加密 WebSocket 连接，转发原生画面、输入和窗口大小。标题保留原生状态符号并显示角色标签，不依赖特定项目名称。不会启动另一份 Claude。依赖使用已安装 Orca 的 `ws` 与 `tweetnacl`；非标准安装位置可指定 `ORCA_RESOURCES`。

## 本地工作区 MCP

远端通过已验证的受限 MCP 访问本地项目，不把本机路径伪装成远端路径。`read_only` 同时隐藏并拒绝写入、任务派发；`read_untracked` 只增加非敏感、未忽略文件的读取。Markdown 写入根目录从 docs、.codex、todo_list、undo_list 白名单中显式选择。角色清单限定当前项目，Windows 路径和 UTF-8 输出已兼容。无产品 API 或数据库结构变更。

## 验证状态

现场验收确认两个角色仍使用原远端 terminal/incarnation/session，实际模型为 `claude-opus-5-5`；普通启动及显式复用能回到本地项目入口。原本本地源会话保持暂停和历史。

自动验证覆盖环境预检、菜单循环、绑定身份、加密传输、禁止输入重发、本地入口复用，以及 MCP 只读边界。发布检查结果见 [本次变更记录](../changes/2026-10-15-remote-claude-and-parallel-designers.md)。

## 限制与迁移

- 原生探测目前针对已验证的 macOS Orca daemon 和 `claude-opus-5-5`；其他平台或模型需要补充验证，不会自动放宽条件。
- 首次环境、受限 MCP 和绑定准备仍由协调者完成；本次不声称一条启动命令可在任意新主机自动配置全部依赖。
- 同步只携带代码、角色与可移植布局。配对凭据、endpoint、会话、owner ledger 和本地入口状态不上传；新机器必须重新建立真实绑定。
- team.json / omp-models.json 的本地 CLI、模型与远端 owner 是独立配置。安装这些模板不会替换已确认远端 owner，但也不会凭空恢复另一台机器的远端会话。
- 远端 master 通过限定的 list_roles/read_role/send_role 协作；完整本地 orchestration inbox、ACK、dispatch 迁移仍未实现。
