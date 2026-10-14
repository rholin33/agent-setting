---
name: orca-team-repair
description: 修复 orca-team 启动、分组恢复或重启失败；由 orca-team 自动打开的 Codex 修复终端加载，也用于用户要求修复团队启动链路。
---

# Orca Team Repair

用户入口始终是 `orca-team`。你是启动修复者，不是任何业务角色的替身。安装包通常位于 `~/.orca/roles/ccb-team`；以传入 request 的 home/project/args 为准。

读取 request JSON、home 下 README、项目 config/state、remote-status，以及该版本 orca-cli 技能。检查源码和现有测试；优先修复确定的启动缺陷，再重试原始参数加 `--no-repair`，避免递归打开修复终端。不要执行 install/update 或改 provider/model 来掩盖失败。

先核对真实 terminal、incarnation、原生 session/transcript 和进程。请求中 starting/uncertain 只表示可能创建，不能当作不存在后重开。保留原始会话；身份不明时诊断绑定、hook 和 native 进程证据，不伪造 session、不清空 state、不新建替身、不批量杀进程。重启仅限原请求选择的角色/分组，使用已实现的精确会话退出/恢复路径；其他项目及业务任务不在范围。

pending remote handoff 需按 orca-remote 的原 task/ledger 对账。不得删除意图或改 owner/runtime 来解除保护，未知投递不重发。若只是一个分组受保护，应恢复其他独立分组并清楚列出未完成角色。

修复脚本前保存精确原文件备份。运行相关回归及整个 `node --test tests/*.test.mjs`，区分已有失败与新增失败。成功须逐角色核对进程、会话、工作区与真实布局；发送成功不是启动成功。长操作给用户进度。

完成后更新 request.status 为 completed，记录实际恢复角色、验证及剩余限制；无法继续则写 blocked 和准确原因，保留终端、历史、请求证据。报告修复结果，不执行摘要中的业务工作、Git 提交/推送、部署或凭据读取。
