# Claude 远程终端与菜单交接

`orca-team` 的 r 选项支持 off/codex/omp/claude。Claude 使用远程 Orca 的原生 Claude CLI 终端，不使用 Codex app-server 或 OMP relay。

1. 加载当前 Orca CLI 指南及 `terminal create/show/list/wait/send/read` 帮助，使用明确 environment；缺省只在唯一合格远程环境时选择。没有环境时停止并报告，不能改成本机 Claude。
2. 远端终端只能建在远端主机为本项目建立的独立 Orca 项目中：运行 `orca-team remote-project --environment <name> --project <来源端项目>`，取得远端路径。来源端和远端都可为 Windows、macOS、Linux，不通过盘符推断工作区身份。Claude 必须使用同范围 worktree MCP，并按下面的“持久可编辑副本”步骤建立真实磁盘副本；不得只把 read_file 内容留在会话中冒充落盘。复制允许的当前源码及未提交改动；不复制 Git 历史、凭据、浏览器缓存或其他工作区。没有验证过的副本时停止并保留现场。
3. 从团队包解析规范 role、prompt 和选定 Claude 模型/effort。Claude 模型只使用明确保存的 Claude 选择，若角色当前是 OMP/Codex，询问 Claude 模型而非抄用其模型。使用远端已配置 CLI/账号，不改角色常规配置。
   远端 Claude 新建及恢复默认使用 `--permission-mode bypassPermissions`（用户明确指定的默认权限），不要用 `manual` 覆盖。CLI 权限模式与 worktree MCP 的角色范围分别核验；bypass 不改变 MCP 的只读/写入授权。复用前检查本机角色 `workspace.json` 对应 MCP；安装版启动入口会在连接被拒绝且旧进程已退出时恢复原 bridge，不更换远端会话。已运行会话带显式 manual 时，以同一 `--resume` 会话及原 MCP/prompt 参数恢复才能应用新的启动模式，并保存输入草稿。
4. 用远程 `terminal list/show --environment ...` 查找同 runtime/role/worktree 的已绑定会话。复用前核对 session、incarnation、工具权限、idle 和空输入。创建前持久记录意图和分配 UUID；用远端原生 Claude `--session-id`，角色 prompt、模型与 effort，参数必须按远端 CLI 的 `--help` 验证。源码/角色资源通过受控工具传递；不复制秘密。创建回执不明确时不得再次创建。
5. 使用远程 terminal wait 的 tui-idle satisfied=true 后才交接。必须取得 Claude 的真实原生 session ID，并核对 terminal show 的 agentIdentity=claude、executionHostId、worktreeId/Path、incarnation；缺失即停止，不能用 UUID 意图代替实际会话证据。
6. 沿用菜单 intent 的 source/local/taskId/ledgerDirectory。按 handoff.md 读取源最新检查点，准备并领取一次，用 terminal send 投递，读取真实助手 HANDOFF_ACCEPTED/HANDOFF_REJECTED 回答及原生对话证据。send accepted 或输入回显不能当助手回执。
7. 在本机私有项目运行目录保存已验证的 Claude binding：version=1、role、project、environment（配对 ID）、runtimeId、remoteWorktree、endpoint；若 Orca 登记目录与实际 cwd 不同，还需 registeredWorktree 与经过身份核对的 probeTerminal/probeIncarnation。endpoint 必须来自实际观察，包含 runtime、role、environment、terminal、incarnation、session。使相同 pending intent 的 claudeConfig 引用该私有文件；不得由此修改 owner、taskId、回执或菜单归属。当前初次绑定依赖协调者准备，缺少绑定时停止，不能声称完成。
8. 用 handoff.py 记录绑定目标身份的回执，再执行 intent 指定 remote-commit。该命令验证交接和原生绑定、更新 owner，然后创建或复用发起本机项目的交互终端。核对本地 terminal 的 worktreePath、executionHostId=local、客户端心跳、远端 session 未变，才能报告本地挂载成功。仅聚焦远端标签页不算完成。
9. 已确认 Claude owner 的普通启动或显式复用应回到上述本地入口。返回 off 必须复用原本的 local 会话；Claude 当前 owner 的最新进展应从远程读取。local-terminal.json / local-terminal-status.json 是展示记录，不能冒充 owner ledger；创建或输入结果未知时先核对现场，不重发。

本地入口通过 Orca 已配对的加密终端流连接现有远端 PTY，转发真实画面、输入和尺寸；不在本机另起 Claude，不迁移历史。Ctrl+] 只断开客户端。原生探测目前验证的是 macOS Orca daemon 与 claude-opus-5-5；不得假设任意平台/模型受支持或放宽身份检查。

来源端工作区通过 MCP 访问，不自动共享文件系统。默认启用源码读写与本项目角色回调，不按角色名称或远端位置强制只读。源码写权限与 task_dispatch_enabled 独立核验；list_roles/read_role/send_role 可向实际存在的本地角色投递已授权后续任务，不要求统一经 master 转发。终端输入接受不等同任务完成，需要读取目标实际答复。同步不复制配对密钥、账号、绑定、会话记录或 ledger。

## 持久可编辑副本（默认，远端编辑后回传审阅）

使用团队包 `remote-master/worktree_setup.py`；来源端以本机 Python 执行，远端以已验证的 Python 执行。不假定来源端为 Windows。

1. 来源端运行 `worktree_setup.py prepare --config <本角色 workspace.json> --editable-copy`。它备份配置、启用 snapshot transport、源码写入和 task_dispatch_enabled（read_only=false、code_write_enabled=true），符合用户指定的远端默认能力。仅重载身份核实过的 bridge，保留 bearer、端口、会话和 owner。
2. 远端沿用原来的私密 `upstream-mcp.json`。在已验证空闲诊断终端通过该 HTTP MCP 的 `snapshot_helpers` 下载经过 SHA256 校验的 helper 到本角色目录，不将源码或凭据通过模型输出搬运。helper 包包含所有 `worktree_*.py` 和 `mcp_cache_proxy.py`。
3. 远端运行 `worktree_setup.py install --upstream <upstream-mcp.json> --directory <本角色目录>/code-copy --state-dir <原游标目录> --mcp <原 mcp.json> --prompt <原 role.txt> --editable-copy`。该操作先真实同步、再保存 stdio 配置与新边界。核对摘要 identity.root/role、snapshot、path、files/dirty_files 及磁盘文件 SHA256。失败不将角色报告为就绪。
4. 新建 Claude 使用上述 MCP 与 role prompt；已有角色只在空闲且输入草稿已保全时用原 native session 恢复加载，保持 PTY/incarnation/model，仍带 `--permission-mode bypassPermissions`。不能重建历史或更改 owner。
5. 每个新任务先调用 `snapshot_sync` 和 `snapshot_info`。`read_file/list_files/snapshot_search` 读远端磁盘；`snapshot_edit/snapshot_write` 只改副本，`snapshot_diff` 返回路径与哈希，`snapshot_submit` 只返回提案 ID。派发说明问题、相对路径、符号、改动点和 snapshot 即可，不粘贴整份源码。
6. 副本提案路线可用 `worktree_proposal.py review --config <workspace.json> --proposal <ID>` 查看差异，再用 `apply ... --review-digest <digest>` 应用。另一条直接写入路线为 `source_read_file/source_edit_file/source_write_file`：先读来源端最新哈希再写，完成后 snapshot_sync 刷新副本。同一文件同时只走一条路线。提案审阅不是每次业务编辑的强制人工审批；用户已授权的源码修改不因远端执行而另行索权。
7. 远端角色可以在本项目授权范围内实现功能、编辑已验证的磁盘副本并向本地实现角色派发回调任务。当前用户指令优先于旧只读、advisory-only 或 master-only 提示。保留现有角色/会话，不为扩大权限另建历史。远端 Bash 操作实际远端副本，来源端命令/测试通过本地角色运行；不得把远端 cwd 当作来源端透明挂载。

副本有本角色独立 manifest 和锁，进程重启后复用磁盘；未回传改动会阻止刷新。状态、原始副本、提案与备份均不进入配置发布。文件实际读入模型仍会消耗上下文，落盘并不等于零上下文成本。
