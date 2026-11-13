# Grok 远程终端与菜单交接

`orca-team` 的 r 选项支持 off/codex/omp/claude/grok。Grok 使用远程 Orca 的原生 Grok Build CLI 终端，不使用 Codex app-server 或 OMP relay。

1. 加载当前 Orca CLI 指南及 `agent launch`、`terminal create/show/list/wait/send/read` 帮助，使用明确 environment；缺省只在唯一合格远程环境时选择。没有环境时停止并报告，不能改成本机 Grok 冒充远端。
2. 远端终端只能建在远端主机为本项目建立的独立 Orca 项目中：运行 `orca-team remote-project --environment <name> --project <来源端项目>`，取得远端路径。Grok 的 cwd 是该远端项目。需要本机源码时，复用该角色已有的 worktree MCP / 可编辑副本；没有验证过的副本时停止，不要把远端同名目录当成本机项目。
3. 从团队包解析规范 role 与 prompt。Grok 模型只使用明确保存的 Grok 选择（`grok-4.7` / `grok-4.6` / `grok-4.5` 及 effort）；若角色当前是 OMP/Codex/Claude，询问 Grok 模型而非抄用其模型。使用远端已安装并已登录的 `grok` CLI，不改角色常规配置、不复制 `~/.grok/auth.json`。
   远端 Grok 新建及恢复默认使用 `--permission-mode bypassPermissions`。CLI 权限模式与 worktree MCP 的角色范围分别核验。
4. 用远程 `terminal list/show --environment ...` 查找同 runtime=grok、role、worktree 的已绑定会话。复用前核对 session、incarnation、idle 和空输入。创建前持久记录意图；用远端 `orca agent launch --agent grok --environment <id> --worktree path:<远端项目>`，并按远端 CLI `--help` 验证 `--model` / `--effort` / `--prompt`。创建回执不明确时不得再次创建。
5. 使用远程 `terminal wait --for tui-idle` 且 `satisfied=true` 后才交接。必须取得 Grok 的真实原生 session ID，并核对 `terminal show` 的 `agentIdentity=grok`、executionHostId、worktreeId/Path、incarnation；缺失即停止，不能用 UUID 意图代替实际会话证据。
6. 沿用菜单 intent 的 source/local/taskId/ledgerDirectory。按 handoff.md 读取源最新检查点，准备并领取一次，用 terminal send 投递，读取真实助手 `HANDOFF_ACCEPTED` / `HANDOFF_REJECTED` 回答及原生对话证据。send accepted 或输入回显不能当助手回执。
7. 在本机私有项目运行目录保存已验证的 Grok binding：version=1、role、project、environment（配对 ID）、runtimeId、remoteWorktree、endpoint。endpoint 必须来自实际观察，包含 runtime=`grok`、role、environment、terminal、incarnation、session。使相同 pending intent 的 `grokConfig` 引用该私有文件；不得由此修改 owner、taskId、回执或菜单归属。
8. 用 handoff.py 记录绑定目标身份的回执，再执行 intent 指定 `remote-commit`。该命令验证交接和原生绑定、更新 owner，然后创建或复用发起本机项目的交互终端（`grok-remote-terminal.mjs`）。核对本地 terminal 的 worktreePath、executionHostId=local、客户端心跳、远端 session 未变，才能报告本地挂载成功。仅聚焦远端标签页不算完成。
9. 已确认 Grok owner 的普通启动或显式复用应回到上述本地入口。返回 off 必须复用原本的 local 会话；Grok 当前 owner 的最新进展应从远程读取。

本地入口通过 Orca 已配对的加密终端流连接现有远端 PTY，转发真实画面、输入和尺寸；不在本机另起 Grok，不迁移历史。Ctrl+] 只断开客户端。

远端主机必须已经安装 `grok` 并完成 xAI 登录。本机 `~/.grok` 凭据不会自动同步到远端。
