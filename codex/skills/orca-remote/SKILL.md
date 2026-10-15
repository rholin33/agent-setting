---
name: orca-remote
description: >-
  通过 Orca 与 Tailscale 复用或建立远端角色会话，分别选择运行程序和团队角色。
  用户输入 "$orca-remote -codex master"、"$orca-remote -omp designer"，
  或要求在本机与远端之间、远端与已有 agent 之间接续同一工作时使用。
  支持 --environment、--worktree 和 --to-agent；默认双向交接最新任务上下文，
  保留各端完整历史，不迁移原始会话，不复制模型凭据，不将窗口聚焦冒充交接完成。
---

# Orca Remote

这是 **AI agent 执行技能**，不是 shell 中的 `$orca-remote` 环境变量，也不表示系统已注册 `orca-remote` 可执行文件。收到调用后按下列决策流程实际操作；不要只把命令交还用户。实现、配置步骤、故障处理与历史验收见 [操作手册](references/operations.md)，首次使用及需要建立/修复实例时必须先读相关章节。

执行位置是**具备本机 Orca CLI 与文件工具权限的本机管理会话**（例如本机 Codex/OMP）。技能安装在本机，不会随 `codex --remote` 自动同步到远端，也不自动注入已运行的会话。若当前只是远端受限 Codex、仅有 worktree MCP 而无法调用本机 Orca CLI，应明确说明能力缺口并请用户回到本机管理会话调用；不能冒充已创建或用角色消息绕过权限。

## 1. 严格解析请求

支持的调用形式（运行程序标志三选一）：

```text
$orca-remote -codex <role> [--environment <name>] [--worktree <path>] [--no-handoff]
$orca-remote -omp <role> [--environment <name>] [--worktree <path>] [--no-handoff]
$orca-remote -claude <role> [--environment <name>] [--worktree <path>] [--no-handoff]
$orca-remote --to-agent <existing-terminal-handle> [--environment <terminal-host>] [--worktree <path>] [--no-handoff]
```

- 远端角色调用解析成独立的 runtime、role、environment、worktree；仅 `-codex` / `-omp` / `-claude` 调用要求 `<role>`。`--to-agent` 从该实际 agent 核对运行程序和角色，不另要求 role 参数。路径/名称可用引号包住空格；只解析参数，不用 eval 或拼成 shell 程序。
- 目标选择必须是且仅是 `-codex <role>`、`-omp <role>`、`-claude <role>`、`--to-agent <handle>` 四者之一。前三者按运行程序和角色发现/建立远端入口；`--to-agent` 只连接已存在的 agent，默认在本机 Orca 查找，显式 environment 指其终端承载主机，不创建、不改角色。拒绝混用目标选择、未知/重复参数、缺失值和额外位置参数。`--no-handoff` 是显式仅打开/聚焦，不改变任务负责人，也不声称工作接续。
- `--worktree` 缺省时使用当前会话所处的实际 Orca worktree。核对规范路径与 Orca worktree 身份；不因名称相似而选择另一个工作区。无法确定当前工作区时只询问这个必要问题。
- 显式 `--environment` 必须对应 Orca 已配置且可核对身份的 environment。缺省时优先使用该 runtime + role + worktree 已绑定的远端 environment；没有有效绑定时仅在存在唯一已连接的合格远端主机时选它。多个候选只问一个问题。已有绑定离线时报告状态，不悄悄切到另一主机。
- `environment` 是 Orca 远端环境名称，不是运行程序或模型 provider。名为 `claude` 的主机可以运行 Codex 或 OMP；`-omp designer` 不得复用 Codex master 的会话。

默认交接，不要求用户另加参数。先按 [双向交接流程](references/handoff.md) 确认当前任务 ID 与源会话：若最近已交给远端，应从远端取得新进展，而不是重发本机旧摘要。无可信源会话时只问必要的源选择；不能猜测。切换回现有 agent 时保留其原有对话，不将它的旧待办与传入任务混合。

## 2. 解析真实角色与工具入口

以下团队角色资源解析适用于 `-codex` / `-omp`；`--to-agent` 直接核对既有 agent，不要求它必须是团队中的具名角色。若由 `orca-team` 的 remote 选项打开 `remote-setup` 管理会话，管理会话只是协调者，不是待续接的业务来源；必须定位原本工作的 agent，不能把 setup 启动提示当业务上下文。来源不明时暂停询问，不生成虚假交接。

### orca-team 菜单意图

若启动消息提供了持久切换 intent，先读取 [菜单交接协议](references/handoff.md#7-orca-team-菜单接入)。严格沿用其中的 `source`、`local`、`taskId`、`ledgerDirectory` 和 `id`；不能新建另一任务/账本，不能把 `remote-setup` 当 source，也不能改成 `--no-handoff`。`runtime: null` 表示返回 intent.local 指定的**原本本机会话**，不得另开会话替代。

菜单身份中的 role 是核实过角色资源的规范团队角色，不是终端实例显示名；environment 是终端承载主机，不是模型主机。不得仅凭标签给角色授权。必须核对真实原生 session/incarnation；缺失或改变时停止并报告，不用编造/unknown ID 完成菜单切换。

拿到并记录真实 accepted 回执后，先执行启动消息给出的 `orca-team remote-commit --role ... --intent ... --project ... --home ...`，由它校验 ledger 和当前终端、持久更新归属并聚焦；不能只聚焦就宣称菜单切换成功。明确 rejected 时用 `remote-reject` 结算并保留 source；未知投递只对账，禁止另开 setup 或重发。完整历史保持原地。已受菜单管理的任务不能另开一个独立 skill ledger 绕开它的当前接手方。

### 通用角色核对

1. 按已安装 `orca-cli` 技能解析当前会话的 Orca 可执行文件，读取该版本的 `skills get orca-cli` 指南。环境、worktree、terminal 的读取、创建、聚焦、发送输入和关闭命令必须来自此指南或该版本 `--help`；不得编造 CLI/API。若版本缺少必要能力，报告具体缺口，不能绕过成另一套启动器。
2. 定位当前项目生效的团队配置及其引用的团队包。读取 `team.json`、`layout.json` 中所选角色相关段落，并解析真实 `source/<角色资源>/role.toml`、适配 prompt 及必要资源。共享包默认位置为 `~/.orca/roles/ccb-team/`；项目覆盖配置优先，不把共享包列表硬当作项目角色列表。
3. 用团队成员 `name` 精确匹配 `<role>`，再解析它的 `role` 引用。例如当前共享包 `master → agentroles.ccb_self`、`coder1 → agentroles.coder`。这些是已观察示例，不是技能允许列表。名称相近、共享同一个角色资源或同一个模型，都不意味着同一会话身份。
4. 角色不存在、引用缺失或 prompt 无法解析时，列出当前可用的真实角色并停止。不得造一个同名 role stub、用 master prompt 代替其他角色、修改团队成员的常规 provider，或覆盖原来的本机角色。
5. `-codex` / `-omp` / `-claude` 只选择本次远端会话运行程序，不修改团队角色的常规程序、模型或会话。模型/provider 另从真实角色要求及远端已配置能力核对；例如 designer 的模型不能从 master 会话抄来。

### Claude 远程终端分支

`runtime=claude` 使用 Orca 远程终端，跳过 Codex app-server 和 OMP host/join 专用流程。先读 references/claude.md；依照其环境、工作区、会话与助手回执校验完成创建/复用和双向交接。

### 按运行程序分流

- `--to-agent`：核对该现有终端的真实程序、角色、会话、工作区访问范围和忙闲状态。不要覆盖其系统提示词或改用新会话；不执行第 3–4 节创建流程。身份与范围通过后执行双向交接，再按第 7 节交付。

- `runtime=codex`：执行下面第 3–5 节的已实现 Codex 流程。
- `runtime=omp`：执行本节 OMP 流程及 [双向交接流程](references/handoff.md)，再遵守第 6–7 节公共规则；**跳过 Codex 专用第 3–5 节**，不得调用 `native_codex.py` 或传递 Codex 的 `--remote`、app-server 参数。

OMP 流程：

1. 使用团队包的 `lib/omp-adapter.mjs`：以 `ompSelection(home, role)` 读取该角色明确保存的模型与 thinking，再将规范化的本机 `project`、实际 `home`、`role` 和已选择的 `environment` 传给 `ensureOmp()`。它调用固定 `remote-master/omp_adapter.py ensure --request <0600 JSON>`；不要临场拼装另一套 OMP 服务、启动 Codex 来研究协议，或复制其他角色模型。完整命令见手册第 2.2 节。
2. 对返回结果执行 `validateOmpEndpoint()` 和 `verifyOmpBinding()`，核对本机终端、incarnation、真实远端 session、模型及 worktree。菜单 intent 已包含 `target` 与 `adapterConfig` 时，只核验这个固定目标，不另建实例、改目标或覆盖 intent。没有身份、模型、原生连接或项目工具证据时停止，不用 unknown ID 或仅进程存活代替。
3. 实现采用私网鉴权 relay、两端 loopback tunnel、远端原生 OMP host 与本机 `omp join`。不走公网 relay、不用 RPC/逐轮 exec 冒充 TUI；远端凭据继续留在远端。源码经角色限定 MCP 访问，本机文件系统没有被透明挂载；任意 Shell、删除、秘密/ignored/CI/agent-policy 文件仍禁用。
4. 启动器以进程专属配置根隔离环境插件与 MCP 自动发现，保留原有 auth/model 存储引用，不修改用户全局配置。模型、thinking、会话或角色与既有绑定不符时拒绝，不静默降级。创建前写持久意图，创建回执不确定时禁止重发；已知原生 host 不健康时保留现场，不自动重启成新会话。
5. 同范围健康实例直接复用。只有权威终端列表证明旧 guest 已不存在，且远端 PID/instance/generation/session/model 均未变化时，才能重开本机 guest。已接手角色由菜单在共享账本锁下追加 `owner_rebindings`，原始回执不改写；不能拿旧 UI 身份直接发送下一版交接。
6. 上下文仍按双向流程处理：读取源端最新检查点并确认暂停；确认目标 `busy=false`、输入框为空且无冲突，再投递一次。读取控制服务 `/messages` 的真实 assistant 回复，配合 `/snapshot` 的 session/busy 核验，而非把 `terminal send accepted` 或输入回显当回执。收到真实 accepted 后才提交归属；返回必须是原本的 local endpoint。接口 Bearer 只从私有配置读取，不输出到命令、日志或对话。
7. 已实测本机 OMP 18.10.3、远端 18.10.2 的 `master`/`archi` 原生连接，远端真实模型通过 MCP 读取本机项目；master 源码写入、stale-SHA 拒绝与原文恢复也已通过。另在隔离账本内完成真实本机 OMP → 远端 OMP → 原本机会话的 revision 1/2 往返及关闭 guest 后同 session 重连。此证据不代表任意主机/模型或 designer 均已验收；每个新范围仍须做实际检查。

## 3. 启动前只读核对；复用优先

按手册检查现状，任何检查失败都先定位原因，不先重启：

- **版本/能力**：本机原生 Codex 客户端、远端既有 Codex launcher、Orca 与 Python；核对客户端 `--remote` / `--remote-auth-token-env`、远端 `app-server` capability-token 鉴权，以及桥接器依赖的限制开关。已完成部署的 Codex 版本为 `0.162.1`，这是历史基线，不是“任何同版本都已健康”的证明。不要自动升级、重新登录、修改全局 Codex 配置。
- **网络/主机**：Tailscale 在线、选定 environment 对应的主机与 peer 地址一致、双向所需端口可达；本机 forwarder 仅 loopback、远端 app-server 仅指定 tailnet 地址、MCP 仅指定本机 tailnet 地址。公网 Funnel 或开放监听不是修复方法。
- **绑定/身份**：从 `remote-master/runtime/session-bindings.json` 提取非秘密字段，结合 Orca 实时终端、进程和监听信息交叉核对。必须同时匹配 role、provider=codex、environment/远端主机、规范 worktree、本地工具 root、远端中性 control directory、各端口、配置归属、终端及 native session。终端标题或“端口有响应”均不足以证明匹配。
- **权限/健康**：核对 MCP 健康/工具能力、允许的 peer、`code_write_enabled` 与该角色的授权范围；核对原生连接与远端模型证据。读取 runtime 配置时只提取必要非秘密字段，禁止输出整个 JSON、token、请求 Authorization 或带凭据命令。进程诊断也不得打印可能含密钥的完整环境/参数。

决策：

| 现状 | 动作 |
| --- | --- |
| 唯一匹配且健康 | 复用既有 TUI，不创建/重启；默认完成上下文交接后聚焦，--no-handoff 才只聚焦；不重跑历史写入验收 |
| 绑定存在但离线/故障 | 保留配置和历史，只读检查网络、终端、进程、端口、鉴权及 MCP；不能把“离线”当作允许重建 |
| 同范围出现多个候选/归属冲突 | 不任意挑选或杀进程；先核对证据，仍有歧义时只问一个关键问题 |
| 无实例且能证明无未完成启动/隐藏运行实例 | 按下一节和手册建立独立实例 |
| 状态查询失败/不完整 | 报告无法证明复用或创建安全；不能把查询失败解释为实例不存在 |

实例定位信息属于本机运行状态，必须从实际绑定与实时 Orca 查询取得；可移植技能不保存历史主机地址、工作区或端口绑定。旧 exec engine 不作为原生续聊入口，保留原有历史。

## 4. 无可复用实例时建立真实角色会话

仅在参数、角色、主机、worktree 与权限均确定后，按手册的新增角色步骤执行。禁止直接复制 master 私有配置改标题。

1. 记录启动前的绑定、终端和监听基线。为该 role + environment + worktree 分配独立本地 runtime、远端中性 control directory、native 会话和终端名称；不得覆盖既有目录、配置、token 或会话。
2. 选择经核对空闲的 MCP 端口、远端 native 端口和本机 tunnel 端口。配置 `native_port` 于两端对应配置、`tunnel_port` 于本机 native 配置，同时匹配 `url`、MCP `local_url`、`bind`、`peer`、`root`、`worktree` 等真实字段。默认 `18766/18767` 只适用于没有冲突的默认实例，不是所有角色共用端口。
3. 使用两种相互独立的随机凭据：MCP bearer 和 native capability token；不同角色也必须独立。私有目录 `0700`、配置/凭据文件 `0600`。native token 明文仅保存在本机，远端 app-server 只接收 SHA256 摘要；MCP bearer 按手册仅提供给需要访问本机工具的远端受限配置。两者均不是模型账号凭据，不得输出或提交。
4. 将解析出的真实既有角色 prompt 与本次远端边界组成 `role_prompt`；明确其角色名、本机工作区和工具范围。不得将其他角色的 developer instructions 或旧 native 会话移花接木。配置中的 `role` 必须是本次真实角色会话名称；代码中的历史环境变量名称不代表可以复用 master 身份。
5. `code_write_enabled` 必须依据当前角色/工作区的明确授权设置，不因 master 已获授权就自动开放新范围。无源码写授权时保持关闭，只有任务确实需要新增权限才单独询问该权限。默认也不得开放任意 Shell、秘密文件、CI/agent-policy 修改、跨工作区或生产操作。
6. 使用手册中的既有 `bridge.py local`、`native_codex.py server`、`native_codex.py tunnel`、`native_codex.py client` 入口，按依赖顺序建立本机 MCP、远端原生 app-server、本机 loopback forwarder 和本机原生 TUI。所有 `--config` 指向本角色独立文件；远端沿用其既有 Codex launcher/provider/登录。本机不复制仓库，不复制远端模型凭据，不启动旧 `codex_engine.py` exec 服务。
   注意：不要调用旧 `bridge.py bootstrap` CLI，它专用于 Claude 且硬编码旧目录。原生 Codex 新实例使用手册中的一次性 `/bootstrap` HTTP 交换；响应仅含 token、role_prompt、local_url、peer，其他角色/能力/端口字段必须显式合并，响应正文不得回显。
7. 每一步只发送一次创建/启动操作。超时、失败或回包丢失后先重新核对是否已经创建终端、进程、监听或会话；未证明失败前禁止盲重试。部分启动结果与非秘密绑定应保留为“未确认”，不能声称成功。
8. 只有下一节核验成功后才写入/更新本实例非秘密成功绑定；保留其他角色和历史记录，不更改常规 `orca-team` 批量管理对象。

## 5. 成功证据与原生能力边界

“已发送启动命令”“有终端”“握手成功”都不是完整成功。复用时可组合当前健康信息和身份一致的既有原生证据；建立/修复后必须取得新的对应证据。原生 TUI 正忙时只聚焦、不打断、不注入 `/status`，将无法安全复核的项目明确报告为待确认，不能伪称已验。

- **原生链路**：本机 Orca 识别真实 Codex TUI，经 loopback 转发连接选定主机的 `codex app-server`；按手册核对无凭据拒绝、正确凭据可用，且不泄露凭据。已有实例不为重复验收而轮换 token。
- **模型/会话**：原生 `/status` 或等价可信状态显示实际模型/provider、native session、approval/sandbox；当前历史已验模型为 `GPT-6.1-Sol/custom`。必须报告本次实际值，不能从角色配置或模型自述推测远端成功，也不能静默改到本机模型。
- **本机 MCP 目标**：经该 native 会话调用 `workspace_info`，核对返回的本机 worktree/root 与请求完全一致；进行一次任务范围内非敏感文件的只读读取以确认工具链。健康复用且证据充分时不重复派发读文件任务；不得为了验证自动改源码。
- **写权限**：TUI 的 `Read Only (Ask for approval)` 指远端沙箱，不等于本机 MCP 没有写权限。真正的本机能力由 MCP 与该角色授权决定。写工具要求最新 SHA256、现有目录和受限路径；如需写入实测，先取得具体测试文件/变更授权并按手册精确恢复，不重复历史 `useCountUp.ts` 改/恢复实验。
- **文件系统边界**：项目仍在本机，模型/app-server 在远端；本机源码通过受限 MCP 读写，不是全量挂载。原生 `@文件`、TUI 目录及 `!Shell` 属远端中性目录；Shell 还受配置限制。不能把远端同名文件当成本机文件，不能宣称原生文件选择或 Shell 已透明操作本机项目。

### 5.1 双向工作接续（所有运行程序与现有 agent 共用）

严格执行 [references/handoff.md](references/handoff.md)。交接包含任务目标、约束、已改文件、已完成事项、决定、验证、待办和未结束操作；源在安全检查点暂停，目标确认接收后才成为该任务的当前接手方。使用 `scripts/handoff.py` 私密保存 task_id、递增 revision、源/目标真实会话及回执，双向切换沿用同一 task_id，但摘要必须反映最近接手方的新进展。

没有目标助手的真实明确接受，只能报告“交接待确认”；Orca 输入已接受、输入回显或摘要文件存在均不算接收。明确拒绝须记录 rejected，源仍持有任务，保留理由后才能修正为下一 revision。发送结果未知时不重发。协调式任务负责人记录不会锁死其他终端，必须遵守源暂停和单方写入约定。直接点击 Orca tab 不触发技能，不能宣称它也自动交接。

## 6. 故障、权限与清理纪律

- 不以故障为由先重启 Orca/Tailscale、重载整个团队、杀占用端口者、重建会话、升级软件或换模型。只读定位后，如确需恢复动作，先明确受影响的既有实例与用户授权；不影响其他会话。
- 不读取/复制模型凭据、SSH 私钥、秘密配置全文；不输出 token、Cookie 或完整带签名 URL；不将运行数据/配置加入 Git。不执行 commit/push、破坏性 Git、仓库同步、部署或生产操作。选择 `deploy` 角色本身不等于生产变更授权。
- 不改本机原有角色、Claude 服务及其端口/凭据，也不清除旧 exec 对话历史。
- 失败清理仅限本轮明确创建、可由精确终端 ID/进程归属/配置目录证明归属的实例。停止前再次核对，不用 `killall`、通配删除或单凭端口号终止进程。存在会话记录、用户工作或归属不明时保留并报告；既有实例的停止/删除须另有明确授权。
- 用户调用技能切换，已授权最小必要上下文交接：可以请求源总结和目标接收确认，不自动启动摘要中的业务工作、构建、部署或扩大权限。目标确认后等待用户继续。显式 --no-handoff 时仅核验并聚焦，不发送上下文。

## 7. 最终输出与可测试入口

简要报告：

1. 分开报告连接结果与交接结果：`已复用/新建`；`上下文已确认/待确认/未发送（--no-handoff）`。只有有真实回执时才称工作接续完成。
2. 已解析的 runtime、role、environment、规范 worktree，以及实际终端/会话的非秘密标识。
3. 远端实际模型/provider、MCP 目标与只读/源码可写范围；指出本次证据和历史证据的区别，列明未完成项。
   同时列出 task_id、上下文 revision、源与目标会话、接收回执依据及当前接手方；说明原始历史仍分开保存，不是完整会话迁移。
4. 不含凭据的再次调用，例如（只有实际解析匹配时才采用相应值）：

   ```text
   $orca-remote -codex master
   $orca-remote -omp designer
   $orca-remote --to-agent <实际存在的本机agent句柄>
   $orca-remote -codex master --environment claude --worktree /path/to/worktree
   ```

   其他角色使用其真实团队成员名替换，不输出不存在的示范角色作为可运行实例。说明这些调用应发送给已加载本技能的 AI agent，而不是粘贴为 shell 命令。
5. 给出准确的 Orca 终端定位和对应程序实际支持的状态查看方式（Codex 可用 `/status`；OMP 以其版本为准），附 [操作手册](references/operations.md)。不得把参数解析、文档创建或某程序历史验收说成本轮另一程序已启动/验收。
