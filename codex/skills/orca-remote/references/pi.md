# Pi 配对终端与任务工具

1. 对照当前 Orca CLI 的终端创建帮助和配对主机的 `pi --help`。执行入口为 `orca-team remote --remote pi:ROLE --environment NAME --project PROJECT`。沿用团队规范角色与管理意图指定的已准备工作区。
2. 在托管远端项目创建 Pi 终端，显式声明 Pi 程序身份。启动命令将 cwd 设在已准备的工作区副本，使用 `pi --extension <pi_task_extension> --append-system-prompt <directory>/role.txt`。复用时用 `--session <原生会话文件或 ID>` 恢复同一会话，并核对它在相同 cwd。模型由配对主机已有的 Pi 配置和用户选择决定。
3. 用 Orca 终端信息核对环境、项目、Pi 身份、终端实例和原生会话。通过实际 Pi 会话调用 `list_roles` 和 `task_status` 检查工作区工具。按意图保存私有绑定，再调用 `remote-bind`。
4. 按 [双向交接](handoff.md) 获取源检查点，只投递一次。取得原生助手回执后由 `remote-commit` 接管归属。切回 off 时从 Pi 原生会话取得最新进展，沿用原任务与递增版本，回到意图内的本机会话。
5. 授权任务通过 `task_submit` 派给来源项目的现有角色。收到回调时用 `task_status` 验收，再用 `task_ack` 记录结论。执行其他角色派发的任务时，按 Orca 注入的 `worker_done` 契约返回结果和验证证据。
