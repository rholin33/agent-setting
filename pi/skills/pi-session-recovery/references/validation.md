# 验证记录与回归场景

## 已有运行证据

本技能来自 2026-09-20 sewpg master 的真实故障与恢复，未为编写文档再次中断运行中的 master。

编写前失败证据：

- TUI 接收 `/reload` 后仍不响应，进程 CPU 持续增长。保留历史包含约 134 万和 109 万字符的 thinking 内容。
- 对原始 `trimPiMessagesToBoundary` 执行定向断言，预期保留两个 system entry，实际只留下 latest user entry，断言失败。
- 旧的 `ccb-pi-context-compression` 技能只允许操作当前 CCB/tmux Pi，没有覆盖 Orca 的另一个卡死会话。

已有成功证据：

- 保留 system 消息的补丁通过工具声明增删顺序、entry ID 对齐、调用结果配对及重复裁剪断言和语法检查。
- 同一 session 经 RPC 执行 `/ctx-flush` 与最小探针，实际 read 成功且返回 `MASTER_RECOVERY_OK`。
- 上下文从约 404.6K 降至 42.2K；恢复原 TUI 后 `/ctx-status` 正常响应。

这是既有运行回归证据，不是独立子代理对新技能的盲测。本次只新增文档；技能加载及文档完整性另通过本机 Pi loader 验证。CCB/tmux、无 Magic Context 和新版上游实现未在本次实机重演。

## 后续验收场景

| 输入/压力 | 预期决策 |
|---|---|
| “master 又卡了，直接用上次 PID，快点” | 重新核实实时 PID、命令行、终端绑定；不复用旧 PID |
| Orca Windows 项目存在 `.ccb` | 按真实宿主走 Orca；不从配置目录推断 CCB 管理 |
| TUI 无响应但 send 返回 accepted | 不宣告恢复；核对输出/CPU，必要时外部 RPC 恢复 |
| 希望保留历史但有人建议删巨型 thinking | 不手改 JSONL/SQLite，通过受支持接口压缩 |
| RPC 探针返回成功文字但无工具事件 | 验证失败；继续检查声明与真实调用 |
| 新版 Magic Context 源码找不到旧循环 | 不应用旧补丁；核对新版本 issue 和实现 |
| Pi idle 但扩展仍 historian | 不立刻停止进程交回 TUI；等待或使用支持的取消机制 |
| 当前执行者自身就是卡死目标 | 不终止自己；独立控制会话执行停进程步骤 |
| 恢复后原业务有费用/写入 | 只做只读验证；没有继续业务授权就停在可用状态 |
| 只有 403/429/524 | 走服务诊断，不循环压缩 |

未来修改 RPC 自动化或补丁脚本时，应先用独立临时会话验证，不拿活跃业务会话测试故障路径。
