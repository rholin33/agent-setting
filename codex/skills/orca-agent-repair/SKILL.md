---
name: orca-agent-repair
description: 诊断并恢复 Orca 管理的 OMP、Codex、Claude 角色工具卡死、运行异常、原会话恢复失败，以及远端工作区 MCP 的 Connection refused。支持 orca-repair 故障排查意图；实际入口为 orca-agent-repair。保留原窗格与会话，OMP pending-action 死锁优先调用 orca-team repair；不处理业务报错或整队更新。
---

# Orca Agent Repair

## 入口与范围

例：`$orca-agent-repair simple --project D:/Code/sewpg`，或“用 orca-agent-repair 修复当前项目的 designer”。Claude/OMP 可通过各自技能入口加载同名技能，命令语法以客户端为准。

执行技能的客户端可以是 OMP、Codex 或 Claude；目标角色使用哪种 CLI 必须从项目 state、原生进程和会话绑定核对，不凭角色名推断。项目采用明确路径或当前工作目录。缺少角色且无法唯一确定时只询问角色；不要默认重启全队。

用户已请求修复指定角色时，诊断、备份、针对性原会话恢复属于授权范围，无需重复确认。仅询问原因或要求只读排查时，不执行重启。修复不包含替角色执行业务任务、改模型/凭据/环境、更新 CLI、部署或 Git 发布。

若目标就是当前执行者，或自己的工具已被拦截，不要尝试杀死自身后声称能继续验证。提供精确命令供用户在独立终端运行，或由一个现有、工具正常的客户端执行；不自行创建替身或派发其他代理。

## 先取证

1. 定位 `ORCA_TEAM_HOME`，默认 `~/.orca/roles/ccb-team`。先读取本机 `orca-team --help` 与相关 README；旧版本不支持 `repair` 时不要伪造可用性或自动更新程序。
2. 解析本会话 Orca 可执行文件：优先 `ORCA_CLI_COMMAND`，开发环境 `ORCA_DEV_REPO_ROOT` 使用 `orca-dev`，Linux 外部终端使用 `orca-ide`，其他情况使用 `orca`。读取该可执行文件的 `skills get orca-cli --json`；后续固定使用同一可执行文件。读取终端后才发送输入。
3. 在管理包目录通过 `lib/team.mjs` 的 `projectFiles(home, project)` 定位项目文件，不手算项目哈希。读取 config/state、`orca-team remote-status --project PATH`、目标 terminal show/read，检查原生进程和 session/transcript 归属。可复用包内 `inspectHealth`、`provesSession`、`validateTranscript`；仅有旧屏幕报错或“进程存在”不足以证明当前故障。
4. 检查目标是否处于 remote pending/远端归属、未确认启动或重启中。保留其账本和原始绑定，不清空 pending、伪造 session、删除历史或批量终止进程。投递不明不重复发送；身份不明不启动另一个同名角色。

只读取必要日志，不输出 headers、token、凭据或完整敏感请求。区分工具宿主故障与业务 API 的失败。

## 根据证据恢复

### OMP pending-action 死锁

典型组合：普通工具被要求先调用 `write` 解决 pending action，同时 `xd://resolve` 返回 `No pending action to apply`，或 `xd://reject` 返回 `Nothing to reject; no pending action remains`。

`Soft tool requirement 'write' was not satisfied after 3 forced turns` 和 `400 Requests ending with a model turn are not supported` 可以伴随出现；单独出现任何一个都不能证明这类死锁。不要继续循环 resolve/reject，也不要自动应用旧预览。

```text
orca-team repair ROLE --project PATH
```

该命令只支持已有 OMP 角色。它检查最近活动分支的矛盾证据，备份 state 和完整 transcript，在原窗格恢复原会话，并发送一次无副作用的 bash echo 验证。当前识别窗口是最近 30 分钟、160 条活动分支记录；超过 64 MiB 的 transcript 需要人工诊断。

- `completed`：还要核对 receipt 中原会话和真实工具执行证据。
- `not_needed`：表示未匹配近期未解除的已知特征，不等于所有故障都不存在。结合新日志判断；健康角色不重启。
- `blocked`、超时、投递不明或已有未完成 receipt：读取 `projects/<key>/runtime-repairs/<role>.json` 和新日志，保留证据，不删除 receipt 后盲重跑。

修复轮询需持续关注进度；命令仍运行时只等待该进程，不启动第二次 repair。原有 TODO 或排队消息可能在恢复后继续触发任务，不能宣称它们已清空。

### Codex、Claude 和其他运行异常

`orca-team repair` 当前没有 Codex/Claude 自动诊断适配，不能把它用于这两个目标。先区分以下情况：

- 认证、限流/额度、代理连接、服务端拒绝、上下文超限：按实际原因排查；重启不构成修复，不切模型或复制凭据掩盖异常。
- 等待用户输入/审批、当前任务正常执行、Orca 标题滞后：先核对真实状态，不当成卡死。
- 绑定错位、原会话不可用、远端交接未完成：保留现场，报告具体阻塞，不新建会话替代。
- 已证实进程/工具运行状态异常，且原会话和原窗格可验证：备份 state 与 transcript，复用管理包的精确单角色恢复路径。

普通 `orca-team restart ROLE --project PATH --no-repair` 可能运行版本检查、模型同步等前置步骤。仅恢复运行状态时，优先在管理包目录使用现有 API，避免扩大变更：

```javascript
import { restartRole } from './lib/restart.mjs';
import { orca, snapshot } from './lib/orca.mjs';
await restartRole({ home, project, role, forceExit: true, cli: orca, snapshot });
```

`home/project/role` 必须使用已核对的绝对目录与单个角色名；不要把示例直接作为未赋值脚本执行。调用前检查远端保护、原生 session 归属和角色配置未变化。使用 `restartRole` 的项目锁，不直接调用无锁内部函数。它可以中断目标角色当前回合，必须在确认是本次待修复的异常角色后才执行。退出未确认时保留 restartIntent，不额外发送 exit/resume。

### 远端 Claude 工作区 MCP：Connection refused

当 workspace_info 与 list_roles 同时报 Connection refused，先查共同传输，不重启业务前后端或健康角色。用户说“orca-repair”时可按本技能处理此故障；实际技能入口名仍为 orca-agent-repair。

1. 分开验证 Orca 主控制面、Tailnet 与专用工作区桥接。固定同一 Orca 可执行文件，执行 status、worktree current，以及 status --environment 已登记远端；单向可达不代表反向 MCP 可达。environment list 是本机配置，不使用 --environment 试图读取另一台机器的登记。
2. 在远端读取该角色实际加载的 mcp.json，并跟随 stdio mcp_cache_proxy 的 --upstream 到 upstream-mcp.json；只输出去掉查询参数的 scheme/host/port/path，不输出 Authorization、token 或完整配置。以实际上游为准，不把 Orca 主端口、业务 API 端口、另一个 profile 的待交接桥接混为一谈。
3. 从实际远端对上游 host:port 作有界 TCP 连接；在本机核同端口监听、真实进程命令及所属配置。ECONNREFUSED + 无监听/无原桥接进程可判为桥接未运行；超时、HTTP403、工具返回 stale handle 是不同故障，分别查路由/鉴权/绑定。旧日志不证明本次退出原因，pid 文件也不证明进程存活。
4. 查找并脱敏核对原 workspace.json 的 root/role/bind/peer/port/orca，必须与实际远端上游和项目一致。旧 projects 与 profiles 下同项目可能有不同端口的 pending handoff，不能凭目录新旧选择。先检查 task-routes 及原账本；bridge 启动会创建 router 并 reconcile，若可能恢复未结算任务或派发历史步骤，先明确授权边界，不清账本、不伪造结算、不改 owner 来强行启动。
5. 仅在用户已授权恢复、精确原配置匹配且任务重放风险已排除时，由当前运行规则允许的宿主维护者恢复缺失服务。使用已安装解释器执行受维护的 remote-master/bridge.py local --config 原workspace.json；优先包内已支持的恢复入口，否则在 Orca 管理的持久服务终端启动并记录终端、PID、日志。先读终端确认是空闲shell且没有待提交输入；健康实例不重复启动，端口被其他进程占用则停止并报告。保留原 token、peer 限制、bind、权限、会话与配置；不新建配对、不扩大到 0.0.0.0、不开放 Orca 主控制端口、不顺带部署或重启应用。
6. 验收必须从实际远端使用原认证，依次读取 /health 并执行 /mcp 的 tools/call workspace_info、list_roles。检查 HTTP/JSON-RPC/工具 isError、项目根路径、目标角色与真实当前 handles；两项都成功才称查询恢复。凭据仅内存使用。/health 的 router 状态另行记录，查询成功不等于任务派发可用；不要用业务 task_submit 验证。
7. Orca 重启后旧 .orca-team/roles.json、local-terminal 缓存与 binding 可能仍含旧 handle。以当前 terminal list/show 的工作区、tab/leaf、incarnation、原生角色身份交叉核对，通过管理包已有正式协调/刷新路径恢复；不凭标题手填绑定，也不把 Connection refused 与后续 stale handle 合并为同一根因。不得提交远端终端现有草稿或发送“好了”触发业务。

已验证的受维护桥接支持 local --config 原workspace.json --pause-task-router 时，可在协调者明确GO后用它恢复有历史任务的桥接：不创建后台router线程，health显示paused/alive=false，原认证/工具声明/显式任务权限不变，task_status仍可查。它不禁止显式任务写入，不是只读权限模式；不执行 task_submit/task_ack 等作为探针。禁止与 --supersede 混用，也不用于remote/bootstrap/console。去掉暂停重启前必须先获准对原Run/Task/Dispatch结算；不把旧任务自动重放当网络修复。实际MCP helper若自带ProxyHandler({})直连，应沿原Upstream.call验证，不能用继承系统代理的临时探针502否定生产路径，也不能仅靠临时绕代理宣称生产成功。

参考实证：一次 Windows 本机 Orca 主控制面正常，远端 master/archi 的 MCP 实际分别使用 Tailnet 上的 18981/18982；两个本机独立 bridge 进程未运行，远端均 ConnectionRefusedError。端口和路径只是该次实例，后续必须重新发现。恢复运行与永久修复分开报告：仅拉起原服务不能声称已实现开机/Orca重启自愈；没有启动管理缺陷的代码及触发验证，不新增自启动/计划任务。


## 验证与报告

恢复前后比较目标 session ID、transcript 路径、窗格与其他角色状态。确认原生进程已恢复，并绑定同一会话。

OMP 自动 repair 以新 transcript 中匹配随机 token 的 bash 调用及成功 toolResult 为准。其他角色恢复后，只发送一次“执行无副作用 echo 标记并报告结果，不开展业务修改”的简短验证提示，核对真实工具输出；用单行提示避免终端把换行拆成多个提交。`accepted: true`、助手自述成功、旧日志都不算验证。未知投递不重发；新错误或超时则报告“会话已恢复、工具验证未完成”。

备份与证据放项目私有运行目录，记录角色、原因、原会话、恢复动作、验证结果和限制。不要把既有无关 startup-repair request 标成完成。报告只覆盖实际验证到的能力：进程恢复不代表业务问题已解决，也不代表 OMP/Codex/Claude 底层缺陷已永久修补。

## 分发与同步

保持同一份技能内容供三个客户端读取：Codex `~/.codex/skills/orca-agent-repair`、OMP `~/.omp/agent/skills/orca-agent-repair`、Claude `~/.claude/skills/orca-agent-repair`。环境自定义目录优先于默认目录。

本机 agent-setting 目前完整导出 Codex、Pi、Claude 的 skills，OMP 独立 skills 根目录不在直接导出范围。同步使用的镜像还放在 `~/.pi/agent/skills/orca-agent-repair`；更新技能时保持四份一致。远端推送必须包含完整技能目录；不能声称同步已自动覆盖 OMP 独立目录。此技能依赖本机 orca-team 修复模块，双仓库发布须先发布运行代码再更新配置 pin。创建或使用本技能本身不授权推送。
