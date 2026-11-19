---
name: orca-team-repair
description: 修复 orca-team 启动、分组恢复或重启失败；由 orca-team 自动打开的 Codex 修复终端加载，也用于用户要求修复团队启动链路。
---

# Orca Team Repair

用户入口始终是 `orca-team`。你是启动修复者，不是任何业务角色的替身。安装包通常位于 `~/.orca/roles/ccb-team`；以传入 request 的 home/project/args 为准。

读取 request JSON、home 下 README、项目 config/state、remote-status，以及该版本 orca-cli 技能。SP 的代码与文档位于 profile.json 指向的 runtimeRoot。读取运行包的 `docs/features/startup-repair.md`，按版本 2 结案协议记录证据。检查源码和现有测试；优先修复确定的启动缺陷，再重试原始参数加 `--no-repair`，避免递归打开修复终端。不要执行 install/update 或改 provider/model 来掩盖失败。

先读 `previousRequest` 和 `recurrence.previousRequest` 中的完整历史。相同症状再次出现时，查明上次是仅重启恢复、补丁未落到实际运行包、原始触发条件未验证，还是补丁被覆盖或有其他根因；指纹相同不代表根因一定相同。不要重复同样的恢复动作后就宣称问题解决。

先核对真实 terminal、incarnation、原生 session/transcript 和进程。请求中 starting/uncertain 只表示可能创建，不能当作不存在后重开。保留原始会话；身份不明时诊断绑定、hook 和 native 进程证据，不伪造 session、不清空 state、不新建替身、不批量杀进程。重启仅限原请求选择的角色/分组，使用已实现的精确会话退出/恢复路径；其他项目及业务任务不在范围。

pending remote handoff 需按 orca-remote 的原 task/ledger 对账。不得删除意图或改 owner/runtime 来解除保护，未知投递不重发。若只是一个分组受保护，应恢复其他独立分组并清楚列出未完成角色。

修复脚本前保存精确原文件备份。定位并核对受维护的源码仓库与实际运行包；本机通常分别是 `~/.codex/.sync/orca-team/source` 与 `~/.orca/roles/ccb-team`。已证实的启动器缺陷应同时修正源码与运行包，保留已有修改，不能只改临时 state 或只修安装副本。先补能在旧实现上失败的回归，再实现修复，运行相关回归及整个 `node --test tests/*.test.mjs`，记录命令、退出码与证据，区分已有失败与新增失败。核对并记录源码与运行文件 SHA256 一致。成功须用原始参数加 `--no-repair` 实测，并逐角色核对进程、会话、工作区与真实布局；发送成功不是启动成功。不能安全重试时如实保留 blocked。长操作给用户进度。

分别记录 `recovery` 与 `remediation`。只有根因补丁已验证、已落到运行包且原始启动成功，才以 `remediation.status: fixed` 结案；完整字段见上述协议。经证据证明是正常保护机制、无代码缺陷时，可用 `not_required` 说明理由，不为结案制造无关改动。仅重启或恢复会话不能标成根因修复；上游缺陷或未知原因仍在时，写 `status: blocked`、实际 recovery 结果、`remediation.status: upstream/unresolved` 和下一步。`repair ROLE` 的 completed 仅表示 OMP 运行恢复；不得把它当作上游修补。新请求缺少结案证据时会保留原修复终端，不能删请求或改版本绕过检查。报告修复结果及未解决限制，不执行摘要中的业务工作、Git 提交/推送、业务部署或凭据读取。
