# 本机偏好

- 用户：Rholin
- 默认语言：简体中文；报错、代码和命令保留原文。
- 知识库路径：`C:\Users\Rholin\Documents\Obsidian\个人知识库`，用户已确认作为默认库；已初始化本地 Git 仓库并写入首条故障笔记。
- 存储偏好（最新决定）：用户接受 GitHub 私有仓库 + Obsidian Git，无需服务器或 Cloudflare Tunnel。不再部署 Fast Note Sync，也不继续官方 Sync。日常记录包含提交和推送，检索先更新远端状态，详见 [Git 同步流程](git-sync.md)。
- GitHub 仓库： https://github.com/tarysoli/obsidian-knowledge ，2026-10-28 创建，GitHub API 已确认 PRIVATE。分支 main；本地 origin 已绑定。GitHub CLI 已登录 tarysoli，凭据由系统 keyring 保存；首次推送成功，HEAD 与 origin/main 均为 `bc7361ef2f942b2baf4de44f32851e3103515628`。
- 客户端：Obsidian 1.14.5 已安装；Obsidian Git 2.42.0 文件和配置已安装，应用内启用状态尚待验证。插件计划启动拉取、每 5 分钟同步。
- Git：`D:\Git\cmd\git.exe`；GitHub CLI：`C:\Program Files\GitHub CLI\gh.exe`。本库独立凭据助手使用 gh，代理为 `http://127.0.0.1:10808`，TLS 校验开启；不覆盖其他仓库凭据或全局 Git 配置。
- 官方 Sync 历史状态：曾登录但因账号无有效订阅而建库失败。用户已改选上述方案，不再继续官方 Sync 建库、绑定或订阅流程。
- 首条笔记：`故障知识库/案例/Magic Context - storage busy 与历史消息编号冲突.md`，已验证 YAML 并上传 GitHub，提交 `bc7361e`；远端文件 blob 与本地 hash-object 一致，工作区干净。
- 官方客户端：`C:\Users\Rholin\.local\share\obsidian-headless-client\node_modules\obsidian-headless\cli.js`，通过 `node` 调用。操作见 [官方 Sync 流程](official-sync.md)。
- 同步验收：分别报告本地保存与云端同步状态。未取得同步成功证据时标注待同步，不能把文件已写入等同于云端已保存。
- 默认案例目录：故障知识库/案例（已有组织方式优先）。
- 默认索引：故障知识库/故障索引.md，仅在用户要求整理或建立索引时生成。
- 默认不自动归档每次修复，不自动运行检索结果中的命令。

用户提供路径并选择作为默认库后，仅更新本文的路径偏好；不修改全局环境变量或 Obsidian 应用设置。
