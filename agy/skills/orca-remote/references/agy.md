# AGY 远程终端与菜单交接

`orca-team` 和 `orca-sp` 的 r 菜单支持 off/codex/omp/claude/grok/agy。

1. 加载 Orca CLI 指南，核对 environment、远端 AGY CLI 及登录。`co` 指当前调用机器；AGY 未指定 environment 时默认 local，不要求配对。显式指定远端时必须解析到唯一配对 ID。本机模型与登录不复制。
2. 本机 AGY 直接使用来源项目目录，不创建远端副本或 bridge。远端模式执行 `orca-team remote-project --environment NAME --project LOCAL_PROJECT` 获取独立远端项目。复用 intent 已准备的 workspace、sourceConfig、localPort 及角色限定可编辑副本；不创建第二条 bridge。AGY 的 cwd 使用该副本，Orca registeredWorktree 可以是外层已注册项目。
3. 读取所选主机的 `agy --help`、`agy models`、`agy mcp add --help`。沿用 AGY 原生默认模型，或用户明确保存的 AGY 模型；不抄用其他程序模型。通过 `agy mcp add --type http NAME URL` 配置角色工作区 upstream，或用 `--settings` 的进程专属配置；必须通过实际工具调用验证角色/root 和可编辑副本。秘密参数不写进日志。
4. 本机模式省略 --environment，使用本机项目；远端模式显式传配对 ID。从团队包解析规范角色 prompt，用 `orca agent launch --agent antigravity --surface terminal --environment ID --worktree path:REMOTE_PROJECT --prompt TEXT` 创建。首次 prompt 包含唯一 `[orca-agy-launch UUID]` 标记。使用已观察的原生 conversation ID 恢复时必须传 `--conversation ID`，不使用 continue 自动选择会话。不确定的创建结果先核查，不能重复创建。
5. 取得真实 AGY conversation ID、terminal handle、incarnation、PTY、配对 runtimeId。Orca `agentIdentity` 必须为 `antigravity`；endpoint.runtime 为 `agy`。没有原生会话证据就停止。Orca 不提供 session 时可保存预先核实空闲的专属诊断 shell 的 probeTerminal/probeIncarnation、launchId；`lib/agy-binding.mjs` 在配对 macOS 主机运行只读 `remote-master/agy_probe.py`，核对同 PTY 进程、conversation 参数或首次标记、原生 transcript 和 SQLite 工作区。
6. `terminal wait --for tui-idle --timeout-ms ...` 必须 satisfied=true，输入框为空后按 handoff.md 获取源检查点并投递一次。AGY 原生 transcript 中的真实助手 HANDOFF_ACCEPTED/HANDOFF_REJECTED 才能形成回执；终端回显不算。
7. 本机绑定使用 environment=local、runtimeId=local、remoteWorktree=本机 project；不含远端 workspace/MCP 字段，由本机只读 SQLite 和原生进程校验。保存私有 `agy-runtime/ROLE/binding.json`：version=1、role、project（本机项目）、environment（配对 ID）、runtimeId、remoteWorktree（AGY cwd）、可选 registeredWorktree、localPort、workspace，以及 endpoint。workspace 含准备结果的 mcp、mcp_sha256、identity 和 upstreamUrl。endpoint 包含 runtime=agy、role、environment、terminal、incarnation、session（原生 ID）。
8. 执行 intent 中的 `remote-bind --role ROLE --intent ID --config FILE`，它只记录 pending.agyConfig。保存真实助手回执后执行 `remote-commit`；该命令再次验证绑定和工作区，更新 owner；本机目标直接复用原 AGY 终端，远端目标打开本机 `agy-remote-terminal.mjs` 交互入口。普通启动复用已绑定入口；Ctrl+] 只断开本机客户端。
9. 返回 off 使用最初 local endpoint；最新工作进展从远端 AGY 原生历史读取。保持同 taskId、递增 revision，原始历史各自保留。

当前只读原生探针支持 macOS Orca daemon。其他主机必须由 Orca 提供可验证的原生 session ID，否则停止；不声称已完成该平台验收。
