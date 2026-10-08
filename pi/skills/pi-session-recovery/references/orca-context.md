# Orca / Pi 超限恢复

适用于原会话恢复后依旧 `Context full`、Magic Context 无可用摘要，或回复已经生成但 TUI/historian 仍卡住。只处理用户指定角色。

## 发现与备份

1. 加载当前 Orca CLI 指南；核对 `terminal list/show/read` 和团队 state 中的 role、tab/leaf、session ID、JSONL 与实时进程。重启后的 handle/PID 必须重新解析。项目残留 `.ccb` 不等于当前由 CCB 管理。
2. 记录 Pi 与 Magic Context 实际安装版本、启动环境及配置路径。不要递归扫 isolated home、node_modules、会话正文或整个数据库；这些目录含巨型文件和秘密。
3. 在空闲时备份准确的 JSONL 和 session/state 指针；SQLite 用 `.backup` 建立一致快照（或正确保存 DB/WAL/SHM）。备份放到不被 session discovery 扫描的位置，权限私有。验证 JSONL 每行、行数/字节数/SHA256，SQLite `quick_check=ok`。
4. 分别读取 UI 的当前 context 与 SQLite 元数据。DB 的 last usage 可能过期或归零，不能用陈旧的低值否定屏幕的超限。

按实际 schema 选择列，不 dump 整行：

```sql
SELECT last_input_tokens,last_context_percentage,needs_emergency_recovery,
       compartment_in_progress,length(pending_pi_compaction_marker_state),
       length(wrapup_in_progress_state),historian_failure_count
FROM session_meta WHERE session_id = '<已核实的原session>';
SELECT count(*) FROM compartments WHERE session_id = '<原session>';
SELECT status,count(*) FROM historian_runs WHERE session_id = '<原session>' GROUP BY status;
SELECT operation,count(*) FROM pending_ops WHERE session_id = '<原session>' GROUP BY operation;
```

## historian 配置与升级继承

- 查当前安装包 README/schema，不把旧版 `historian.model` 直接套到新版。0.43.2 使用 `historian.pi.model`；主读取位置为 `~/.config/cortexkit/magic-context.jsonc` 与项目 `.cortexkit/magic-context.jsonc`，实际还受 HOME/XDG 和 profile 影响。
- `orca-team` 可能不继承旧 CCB isolated-home 的压缩配置。确认旧配置确实有效，再在用户授权下迁移**非秘密配置**；不复制整个 provider-state、不暴露 models.json 凭据。
- 缺 historian 时 Magic Context 可取消 native auto-compaction，却无法生成新 compartments，这是配置阻塞，不是“重启恢复成功”。
- historian 模型与 master 工作模型分开。使用已配置且适合摘要的模型；替换 historian 或新增持久配置需要恢复授权涵盖，不能自行新购服务/改凭据。
- 已核实的 0.43.2 配置形状如下；模型只是形状示例，须换成本机可靠模型：

```json
{
  "enabled": true,
  "historian": {
    "pi": { "model": "provider/model", "thinking_level": "low" }
  },
  "pi": { "subagent_extensions": [] }
}
```

`subagent_extensions: []` 隔离摘要子进程的第三方扩展，不能据此断言所有超时都是扩展导致；保留主会话的工具与扩展。旧版 schema 不支持则不添加。有效配置可能热加载，先查结果，只有必要才定点重启目标。

## 摘要与 materialization

1. 用当前宿主支持的输入入口发送已核实的 `/ctx-wrapup 50` 一次，保存 receipt/request ID。50 表示保留最新 50 条消息，**不是压到 50%**。命令收据 accepted 不等于执行。
2. 观察 historian 调用的模型、状态、时间、usage、compartments 和边界。`terminated`、空回复、流式超时分别记录，不归因猜测、不并发重复提交。允许插件自身有限重试/已配置 fallback；首轮无进展先解决服务或配置问题。
3. 显示 queued / deferred marker 后发送一次最小验证消息，禁止继续业务。摘要只写入数据库尚不足以证明当前请求已减量；确认 marker 被官方管线消耗且 UI/实际 usage 下降。
4. 若 wrapup 真正停滞，用户批准重建后才 `/ctx-recomp`，先新备份。当前版本可能要求 60 秒内再次命令确认；出现确认页不等于重建已执行。已有摘要且上下文安全时，不必为恢复而做全量重建。
5. `/ctx-flush` 不是摘要命令，不是通用的 pending Pi marker 修复。不要手改 recovery/lease/marker，也不要 `/clear`、删 thinking、改 JSONL 或清 scrollback冒充压缩。

## 回复成功但后台仍挂起

- `MASTER_CONTEXT_OK` 已出现但 `Working`、historian lease 或 CPU 持续异常，不能宣告恢复结束。核对 Pi 是否 settled、队列、当前精确摘要子进程及 active tool。
- 对维护探针/摘要挂起先用宿主正常中断，等待清理；若无效，仅在用户授权下对临执行前再次核实的**目标摘要子进程**发 SIGINT。禁止杀所有 Pi/Node 或操作执行恢复的自身会话。
- `/quit` 正常退出目标，确认无重复写同 session 的进程，再通过本机已核实的 `orca-team restart <role> --project <绝对路径>` 恢复原席位。不运行全团队 start/restart，不自动 fresh。
- 退出清理可能自然释放 marker/lease；不能手动把数据库标记改成健康。不能确认清理就报告阻塞。

## 最终验收

- 当前上下文低于约 70%，优先低于 50%；同时报告 Pi 原窗口占比与 Magic Context 可用输入窗口占比，二者分母不同。
- 原 session ID 不变；JSONL 全部可解析且旧历史字节前缀保持完整，不能只检查文件仍存在。
- emergency、compartment_in_progress 为 0；pending marker、wrapup marker为空；SQLite quick_check=ok；队列空且回到 idle，无后台写入。
- 用严格限定的小文件 read 探针确认实际工具成功及最终回复；纯口令回复只证明文字请求可用，**不能宣称工具验收通过**。探针不得继续业务/付费调用业务Provider。
- 几次短 CPU 采样，区分目标 Pi、摘要子进程、Orca/WindowServer。请求期间一次峰值不是长期泄漏。
- 向用户报告前后数值、精确目标、备份和修改、工具/回复证据、剩余服务错误。保留 historian failure 审计并说明可能后续重试；不保证上游永不超时。

“角色运行 + conversation bound”是身份门禁，不是健康验收。后续 `orca-team` 模型切换/升级应重新检查压缩配置是否被加载、上下文是否适配新窗口，不能靠重复全员重启修复超限。
