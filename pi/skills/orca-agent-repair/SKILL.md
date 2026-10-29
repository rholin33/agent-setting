---
name: orca-agent-repair
description: 诊断并恢复 Orca 管理的单个 OMP、Codex 或 Claude 角色的工具卡死、运行异常或原会话恢复失败。支持从三种客户端执行，保留原窗格与完整会话；OMP pending-action 死锁优先调用 orca-team repair。用于“修复 simple/designer 等角色”或显式调用 orca-agent-repair；不是业务报错修复或整队更新。
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

## 验证与报告

恢复前后比较目标 session ID、transcript 路径、窗格与其他角色状态。确认原生进程已恢复，并绑定同一会话。

OMP 自动 repair 以新 transcript 中匹配随机 token 的 bash 调用及成功 toolResult 为准。其他角色恢复后，只发送一次“执行无副作用 echo 标记并报告结果，不开展业务修改”的简短验证提示，核对真实工具输出；用单行提示避免终端把换行拆成多个提交。`accepted: true`、助手自述成功、旧日志都不算验证。未知投递不重发；新错误或超时则报告“会话已恢复、工具验证未完成”。

备份与证据放项目私有运行目录，记录角色、原因、原会话、恢复动作、验证结果和限制。不要把既有无关 startup-repair request 标成完成。报告只覆盖实际验证到的能力：进程恢复不代表业务问题已解决，也不代表 OMP/Codex/Claude 底层缺陷已永久修补。

## 分发与同步

保持同一份技能内容供三个客户端读取：Codex `~/.codex/skills/orca-agent-repair`、OMP `~/.omp/agent/skills/orca-agent-repair`、Claude `~/.claude/skills/orca-agent-repair`。环境自定义目录优先于默认目录。

本机 agent-setting 目前完整导出 Codex、Pi、Claude 的 skills，OMP 独立 skills 根目录不在直接导出范围。同步使用的镜像还放在 `~/.pi/agent/skills/orca-agent-repair`；更新技能时保持四份一致。远端推送必须包含完整技能目录；不能声称同步已自动覆盖 OMP 独立目录。此技能依赖本机 orca-team 修复模块，双仓库发布须先发布运行代码再更新配置 pin。创建或使用本技能本身不授权推送。
