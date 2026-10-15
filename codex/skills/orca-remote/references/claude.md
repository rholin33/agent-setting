# Claude 远程终端与菜单交接

`orca-team` 的 r 选项支持 off/codex/omp/claude。Claude 使用远程 Orca 的原生 Claude CLI 终端，不使用 Codex app-server 或 OMP relay。

1. 加载当前 Orca CLI 指南及 `terminal create/show/list/wait/send/read` 帮助，使用明确 environment；缺省只在唯一合格远程环境时选择。没有环境时停止并报告，不能改成本机 Claude。
2. 远端终端只能建在远端主机为本项目建立的独立 Orca 项目中：运行 `orca-team remote-project --environment <name> --project <本机项目>`，它在远端创建或复用 `<远端用户目录>/Code/orca-remote/<本机项目名>`（macOS、Linux、Windows 均按远端路径风格），输出 `path`。后续 `terminal create --environment ... --worktree path:<该 path>` 都使用它；不得把远端角色建到远端当前打开的其他项目里。核对远程项目 setup 和真实工作区访问。远程 Claude 必须能访问该工作区，或已配置、验证过的同范围 worktree MCP。不要复制仓库、凭据或伪造本机路径的远程映射。没有可访问的工作区时停止，保留源及 pending 现场。
3. 从团队包解析规范 role、prompt 和选定 Claude 模型/effort。Claude 模型只使用明确保存的 Claude 选择，若角色当前是 OMP/Codex，询问 Claude 模型而非抄用其模型。使用远端已配置 CLI/账号，不改角色常规配置。
4. 用远程 `terminal list/show --environment ...` 查找同 runtime/role/worktree 的已绑定会话。复用前核对 session、incarnation、工具权限、idle 和空输入。创建前持久记录意图和分配 UUID；用远端原生 Claude `--session-id`，角色 prompt、模型与 effort，参数必须按远端 CLI 的 `--help` 验证。源码/角色资源通过受控工具传递；不复制秘密。创建回执不明确时不得再次创建。
5. 使用远程 terminal wait 的 tui-idle satisfied=true 后才交接。必须取得 Claude 的真实原生 session ID，并核对 terminal show 的 agentIdentity=claude、executionHostId、worktreeId/Path、incarnation；缺失即停止，不能用 UUID 意图代替实际会话证据。
6. 沿用菜单 intent 的 source/local/taskId/ledgerDirectory。按 handoff.md 读取源最新检查点，准备并领取一次，用 terminal send 投递，读取真实助手 HANDOFF_ACCEPTED/HANDOFF_REJECTED 回答及原生对话证据。send accepted 或输入回显不能当助手回执。
7. 在本机私有项目运行目录保存已验证的 Claude binding：version=1、role、project、environment（配对 ID）、runtimeId、remoteWorktree、endpoint；若 Orca 登记目录与实际 cwd 不同，还需 registeredWorktree 与经过身份核对的 probeTerminal/probeIncarnation。endpoint 必须来自实际观察，包含 runtime、role、environment、terminal、incarnation、session。使相同 pending intent 的 claudeConfig 引用该私有文件；不得由此修改 owner、taskId、回执或菜单归属。当前初次绑定依赖协调者准备，缺少绑定时停止，不能声称完成。
8. 用 handoff.py 记录绑定目标身份的回执，再执行 intent 指定 remote-commit。该命令验证交接和原生绑定、更新 owner，然后创建或复用发起本机项目的交互终端。核对本地 terminal 的 worktreePath、executionHostId=local、客户端心跳、远端 session 未变，才能报告本地挂载成功。仅聚焦远端标签页不算完成。
9. 已确认 Claude owner 的普通启动或显式复用应回到上述本地入口。返回 off 必须复用原本的 local 会话；Claude 当前 owner 的最新进展应从远程读取。local-terminal.json / local-terminal-status.json 是展示记录，不能冒充 owner ledger；创建或输入结果未知时先核对现场，不重发。

本地入口通过 Orca 已配对的加密终端流连接现有远端 PTY，转发真实画面、输入和尺寸；不在本机另起 Claude，不迁移历史。Ctrl+] 只断开客户端。原生探测目前验证的是 macOS Orca daemon 与 claude-opus-5-5；不得假设任意平台/模型受支持或放宽身份检查。

本机工作区访问需单独验证的受限 MCP，不自动共享文件系统。read_only 模式同时禁用写入与派发；master 可用的 list_roles/read_role/send_role 不等同完整本地编排 inbox/ACK。同步只发布代码、角色和布局，绝不复制配对密钥、账号、绑定、会话记录或 ledger。
