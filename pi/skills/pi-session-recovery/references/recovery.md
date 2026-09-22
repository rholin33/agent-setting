# 恢复操作参考

## 运行时发现

不要硬编码用户名、版本、PID、session ID 或 terminal handle。

- Windows 可用 `Get-CimInstance Win32_Process` 获取 `node.exe` 的 PID、父进程与 CommandLine；只输出目标候选，避免输出其他进程中的敏感参数。
- 用本机 `pi --version`、安装包 `package.json` 和实际进程命令行确认版本与路径。PATH 中的 Pi 不一定是目标进程使用的 Pi。
- Orca 遵循 `orca-cli` 技能解析 CLI。通过 `terminal list/read` 获取实时目标，`terminal send --help` 核对参数。不能把 Orca Windows 团队当成 WSL tmux 团队。
- 本机 sewpg 的宿主入口线索：`~/.orca/roles/ccb-team/bin/orca-team.mjs`，项目绑定在 `projects/*/state.json`。先读入口源码/帮助再用 `launch ... --role master --resume`，不要猜测子命令。
- 用当前 Pi 安装目录的 `docs/rpc.md`、`docs/extensions.md` 核对协议和加载规则；命令发现可使用 RPC `get_commands`。

若需要终止卡住的进程，临执行前再次核对 PID 的 CommandLine 包含准确的 Pi CLI 和目标 session 路径；先尝试宿主提供的正常中断/退出，卡死时才结束该 PID。确认没有其他进程写同一 session。

## GitHub 核对

首选 GitHub issue 和评论原文，记录当前状态、受影响版本、修复 commit/发布版本。使用 `gh api` 或 HTTPS API，不把搜索标题当成修复证据。

可复用搜索：

- `repo:cortexkit/magic-context "system_hash" "tools"`
- `repo:earendil-works/pi "long session"`
- `repo:earendil-works/pi "ParseError"`

已知相关链接（每次重新核对）：

- https://github.com/cortexkit/magic-context/issues/485 — Pi 0.86.0 / Magic Context 0.42.6 压缩后工具声明丢失。
- https://github.com/earendil-works/pi/issues/7730 — 长会话 CPU 问题，仅作为诊断线索，不能据此断言所有卡死同源。
- https://github.com/earendil-works/pi/issues/7322 — 单个扩展加载错误阻断 Pi 启动。

### #485 的已验证临时补丁

`trimPiMessagesToBoundary` 的历史裁剪循环不能删除承载初始工具声明或后续工具变更的 `system` 消息。

旧实现：

```js
for (let i = 0; i <= cutoffIndex; i++)
  remove.add(i);
```

适用旧实现的补丁：

```js
for (let i = 0; i <= cutoffIndex; i++) {
  if (piMessages[i]?.role !== "system") remove.add(i);
}
```

只在版本、函数语义和唯一匹配都核实后应用。备份原文件；已有等价修复则跳过；新版结构不同则停止套用旧补丁并重新诊断。保留并验证初始工具声明、按顺序处理的 toolsAdded/toolsRemoved、entry ID 对齐、toolCall/toolResult 配对和重复裁剪。执行 `node --check` 后仍需实测 Pi 加载和工具调用。补丁安装在包目录中，包升级可能覆盖。

## 官方 RPC 恢复

使用一个临时外部控制进程持有 Pi 的 stdin/stdout，不要使用会立即 EOF 的一次性管道。控制器启动参数通过数组传给 `spawn`，不把路径拼接成 shell 代码。

启动形态（占位值必须替换成已核实的目标参数）：

```text
node <target-pi-cli.js> --mode rpc --model <original-provider/model> --session <exact-session.jsonl> --append-system-prompt <original-role-prompt>
```

cwd 必须是原项目；原进程没有角色 prompt 时不添加该选项。先备份原始 transcript 到非会话发现目录，备份只用于回退，不用它启动第二个同 ID 会话。

按当前版本 RPC 协议逐条执行，收到对应 response 后再继续：

```json
{"id":"state-before","type":"get_state"}
{"id":"commands","type":"get_commands"}
{"id":"flush","type":"prompt","message":"/ctx-flush"}
{"id":"probe","type":"prompt","message":"这是会话恢复验证。只用 read 工具读取 <已核实存在的小文件绝对路径> 前 5 行；成功后回复 MASTER_RECOVERY_OK。不要执行原业务任务，不要修改文件，不要调用其他工具。"}
```

`/ctx-flush` 必须先在 `get_commands` 中确认存在，且有待生效操作或适用状态。未安装 Magic Context 时跳过该命令，按 Pi 原生流程处理。

控制器应：

- 按 LF 拆分 JSONL，允许 CRLF，不能按 Unicode 换行符拆分。
- 保留 correlation ID，处理 stdin/stdout/child error 和 exit；设置启动及单操作超时，超时先读取日志，不自动重发探针。
- 记录必要状态及错误，避免打印完整 `agent_end.messages` 或 `get_messages` 内容。日志留在本地，不上传原始会话。
- 观察 `tool_execution_start` 和 `tool_execution_end`，要求工具名、目标文件正确且 `isError === false`。再确认最终回复与 `agent_settled`。
- `get_state` 确认 `isStreaming === false`、`isCompacting === false`、`pendingMessageCount === 0`，另查扩展 historian 状态；Pi idle 不等于扩展后台摘要已结束。
- 若 historian 正在写入，等待支持的状态/完成事件；不要在写入中抢先恢复 TUI。卡住则用当前扩展支持的取消方法，报告阻塞。
- 正常关闭临时进程并确认退出，核实无遗留控制器和重复会话进程，再交回原宿主窗口。

若仍提示没有工具，查看实际调用事件和扩展错误，不能仅让模型“再试一次”。若出现认证/配额错误，先解决该错误，不能把它归因于上下文。

## TUI 收尾

通过原宿主启动入口恢复准确的 session。读取屏幕确认出现新探针结果和合理的上下文占用。发送已确认存在的状态命令，读取响应，再用 Escape 关闭弹窗。

向用户报告：是否恢复、保留的会话、真实工具验证、上下文前后数值、PID、补丁/备份位置，以及上游更新覆盖补丁的限制。不要声称已修复异常重复思考的生成根因；本流程验证的是会话恢复。
