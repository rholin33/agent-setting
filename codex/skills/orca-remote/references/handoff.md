# 双向任务上下文交接

## 范围与默认行为

技能发起的本机→远端、远端→本机已有 agent、远端→另一已有 agent 都默认交接。`--no-handoff` 仅聚焦，不改变任务接手方。直接点击 Orca 标签页不经过技能，当前不自动交接。

这是任务连续性，不是完整原始对话迁移：同一 `task_id` 保留目标和决策，交接 `revision` 递增；所有源会话历史原地保留。目标使用自己的原有会话，不能覆盖其系统指令、工具权限或抹掉旧历史。目标角色无权执行传入任务时必须报告冲突。

## 1. 定位最新上下文和安全检查点

1. 私密记录放在 `~/.orca/role-handoffs/<worktree-scope>/`，目录 0700、文件 0600；不放项目 Git、URL、共享笔记或公开 relay。使用稳定、无秘密的 scope。
2. 当前已有任务按记录的最新接手方取上下文。第一次交接从实际源会话整理；多个任务/源会话无法唯一定位时只问一次来源，不把终端标题或当前 UI 焦点当作会话身份。
3. 若执行技能的管理 agent 就是源，使用已知对话、任务记录和实际修改证据整理。若源是另一 agent，先确认无运行中的修改和输入草稿，再请求它生成一次检查点摘要；必须读取它的真实回复。不能仅用本机过时摘要替代远端的新进展，也不能把截断的 terminal tail 当作完整上下文。
4. 请求摘要时明确“只总结，暂停此任务后续写操作，保留会话；不执行待办”。未知结果的外部请求、未完成写入、后台构建/部署须先确认终态或明确安全暂停；`inflight` 未清空时不交接。不使用强制中断来制造空闲。
5. 记录两端真实 terminal handle、incarnation、运行程序、角色、终端承载 environment 和会话标识。远端 Codex 的 TUI 可以是本机 terminal：终端路由与模型执行主机分别核对，不因模型在远端就给本机 terminal send 加远端 environment。无法取得原生会话 ID 时，须核对可用的会话证明并明确其限制，不能编造 ID 或宣称可检测同进程内的新对话。
6. 源从检查点起暂停该任务的业务写入；目标确认前不接手业务。记录是协作协议，不是操作系统锁，不能保证手工操作其他终端不会并发修改。

## 2. 摘要结构与保密

准备私密 JSON，`task_id` 首次生成 UUID，后续双向交接沿用。结构：

```json
{
  "task_id": "实际生成的UUID",
  "worktree": "当前本机工作区绝对路径",
  "source": {
    "runtime": "omp", "role": "master", "environment": "local",
    "terminal": "实时源句柄", "incarnation": "实时进程代际", "session": "已核实会话标识"
  },
  "target": {
    "runtime": "codex", "role": "master", "environment": "local",
    "terminal": "实时目标句柄", "incarnation": "实时进程代际", "session": "已核实会话标识"
  },
  "summary": {
    "goal": "当前目标与验收标准",
    "constraints": ["用户授权范围、不得触碰的内容、角色/工具边界"],
    "completed": ["已完成工作及证据"],
    "changed_files": ["相对路径、修改意图、提交/未提交状态，必要时附哈希"],
    "decisions": ["关键决定、理由、已否决方案"],
    "verification": ["已执行的验证及结果；明确哪些待验证"],
    "pending": ["按顺序列出下一步、阻塞和所需决定"],
    "inflight": []
  }
}
```

先检查源描述与磁盘事实一致；文件可能已被另一工作流修改，目标接续前需重读。禁止传原始整段日志、完整 diff、附件正文、密码、token、Cookie、私钥、provider 配置或带能力的 URL。只发送本任务必要且用户有权共享的摘要。helper 只校验结构、状态和大小，不是秘密识别器；执行技能的 agent 负责保密检查。无法完整判断的事实标为未确认，不猜测。

## 3. 准备与至多一次发送

以下 helper 不执行 Orca、不提取会话、不自动证明回执。调用技能的 agent 负责真实观察和传输，helper 负责持久记录、摘要摘要值、顺序、重复发送与过期身份保护。

```sh
python3 "$SKILL/scripts/handoff.py" prepare --state-dir "$STATE" --input "$PRIVATE_PAYLOAD"
python3 "$SKILL/scripts/handoff.py" show --state-dir "$STATE" --task-id "$TASK_ID" --message
```

保留返回的 ID/revision/SHA256。相同未完成请求再次 prepare 返回同一条记录；不同摘要不能覆盖未确认交接。已经接收后的下一次交接要求 source 是上次 target，防止本机旧上下文倒灌。

发送前再读取目标真实身份、会话及草稿/忙闲状态。使用本版本 `terminal show/read --screen` 和 `terminal wait --for tui-idle` 等能力；`agentWait=null`、窗口可写、端口健康都不单独证明空闲。目标正忙、已有未提交输入、身份/会话改变或证据不足时停在 prepared，不清输入、不按 Escape/interrupt、不盲发。

将重新核实的 target 六字段写入私密 JSON，再执行：

```sh
python3 "$SKILL/scripts/handoff.py" claim --state-dir "$STATE" --task-id "$TASK_ID" --input "$CURRENT_TARGET"
```

claim 在传输前持久标记 `delivery_uncertain`，同一条不能再次 claim。随后只发送一次 show --message 的完整内容：通过当前 Orca 支持的 terminal send text-plus-enter 接口，并记录其请求标识/提交观察结果。不要把生成的消息文本当 shell 执行。若 source/target 就是当前管理对话，可在该真实对话中接收并确认，不需向自己繁忙的终端再注入一份消息；必须明确采用的是当前对话确认而非另一终端回执。

输入已接受不等于模型已接收。网络错误或服务重启后，不因状态 uncertain 再发一遍；先找原请求和目标回复。只有按照 Orca 已提供的、绑定同一 payload/进程代际的幂等请求恢复协议才可查询/恢复原投递；不能生成新请求绕过 claim。无法确认时保留摘要与原会话，报告待确认，源和目标均不自动继续业务写入。

## 4. 回执与接手

接收消息明确要求目标：核对工作区和权限，明确回复 HANDOFF_ACCEPTED 或 HANDOFF_REJECTED，确认 ID/SHA256，复述目标及下一步，仅接收上下文，等待用户继续，不自动运行摘要中的业务任务。角色字段使用真实目标会话身份；终端承载 environment 与远端模型执行主机不同，不应据此误判为换成本机模型。

必须拿到实际助手回复，不能用输入框、终端回显、CLI 的 inputAccepted 或自己生成的模板当回执。优先使用运行程序的结构化助手消息/turn 记录；Codex app-server 可用其已安装协议的 thread/read，但必须核对是 TUI 当前线程且回复出现在投递之后。只有终端视图时，清楚区分用户输入与新产生的助手输出；不能区分就保持待确认。OMP 以对应版本的实际会话输出为准，不伪造 Codex 协议。

由管理 agent 依据真实输出制作回执 JSON：

```json
{
  "origin": "assistant_turn",
  "decision": "accepted",
  "target": {"runtime":"实际值","role":"实际值","environment":"实际值","terminal":"实际值","incarnation":"实际值","session":"实际值"},
  "id": "当前交接ID",
  "sha256": "当前摘要SHA256",
  "reply": "真实助手的确认和下一步陈述"
}
```

`origin` 是执行者记录的证据分类，不是数字签名；不能靠填写此值就宣称存在助手回复。`decision` 必须依据真实回复明确填 accepted 或 rejected；“看到了摘要但拒绝接手”应为 rejected，缺少明确决定则不结算。重新核对目标身份和会话未变化后：

```sh
python3 "$SKILL/scripts/handoff.py" accept --state-dir "$STATE" --task-id "$TASK_ID" --input "$PRIVATE_RECEIPT"
```

只有 accepted 后目标才成为该任务的当前接手方，再聚焦它；源保持暂停，不清除/迁走本机历史。用户随后输入“继续”时，目标按已确认目标与待办接续，但仍须遵守自身工具权限和读取最新文件。再次切回已有 agent，先由当前接手方总结新增改动/决定，再以同一 task_id、下一 revision 重复流程，不能把第一份旧摘要当新状态。

## 5. 恢复与验证边界

- `prepared`：尚未 claim，可在身份/空闲确认后继续同一记录。
- `delivery_uncertain`：可能已发出，不能再 claim；查目标真实输出并对账，不清空 ledger 伪装第一次。
- `accepted`：保留回执；后续交接只允许当前 target 作为 source。同一回执可重复登记，但不能用旧回执接收新 revision。
- `rejected`：保留实际拒绝理由，源仍持有任务。修正已查明的目标/摘要问题后，只有原 source 可以创建下一 revision；不能把 rejected 改写为 accepted，也不能当作未知投递重发原记录。
- 私密状态中保留每个交接 ID 的记录；不导出原始对话，不将记录提交 Git。用户请求停止/撤销时先对账已送达状态，不能把删除文件当作撤回目标已收到的内容。
- 原生 OMP 已通过独立私网适配器接入，实测范围见 operations.md 第 2.2 节；交接协议不扩大 MCP 权限，也不把接入成功当作任务已接手。
- 跨程序测试应分开报告：ledger 双向状态测试、真实消息投递、目标助手回执、实际工作接续；不把其中一项冒充全部。

## 6. 已执行验证（2026-10-14）

- `python3 -m unittest discover -s ~/.codex/skills/orca-remote/scripts -p 'test_handoff.py' -v`：5 项通过，覆盖双向 revision/接手方、未知投递不重发、不接受回显/过期摘要/重启目标、未结束操作阻塞、拒绝后保留源及修正新版本。
- 真实本机管理对话向既有原生远端 Codex 线程发送了独立验收摘要。首条因角色简称产生明确拒绝，记录 rejected 而非成功；修正为真实会话角色并解释终端主机字段后，新 revision 得到真实 `HANDOFF_ACCEPTED`，通过新 completed turn 的 `agentMessage` 核实 ID、SHA256 和 CONTINUITY-7391。
- 远端返回的新增状态进入同一 task_id 的下一 revision，由当前本机管理对话直接读取并明确确认，最终状态 accepted。返回没有向繁忙的本机终端注入文本，不将其宣称为另一个空闲终端的投递验收。
- 验收记录位于本机私密目录 `~/.orca/role-handoffs/acceptance-2370c086-4e51-4606-80d3-ebfda8075dc4/`。未修改业务代码、未执行摘要中的业务待办、未重启会话或传输服务。
- 上述为早期 Codex 验收记录，当时未取得当前管理会话的原生 OMP session ID。后续 OMP 实测使用已核实的原生 session/incarnation，见下节补充；协议仍不自动拦截 Orca 标签页切换，也不迁移完整会话。

## 7. orca-team 菜单接入

`orca-team` 的 remote 选择已接入持久交接，不再仅额外开一个角色。行初值读取该工作区角色的**已确认归属**；从 codex/omp 选回 off 会明确产生回程意图。Esc、未改变选择、循环回原值均不发送请求。

### 入口与来源

```sh
orca-team remote --remote codex:master --environment claude --project /path/to/worktree
orca-team remote --remote off:master --project /path/to/worktree
orca-team remote-status --project /path/to/worktree
```

初次来源优先来自该角色已有 pane/session 绑定；不存在唯一绑定时停止。用户或管理 agent 可用 `--from-agent ACTUAL_HANDLE` 明确选择一个已验证原生会话的来源，只能同时指定一个角色。旧的独立 remote 终端不会因标题相似而自动纳入。不能用当前 setup 会话填补来源。

每个 intent 固定 `id`、`source`、原本 `local`、`taskId`、`ledgerDirectory`、目标 runtime/模型主机与 `baseRevision`。OMP 在生成 intent 前执行确定性接入检查，并持久保存已核实的 target 和 adapterConfig；协调者不得另建目标。菜单私密账本位于团队包的项目状态目录下，由 `remote-status` 展示路径；本流程覆盖通用步骤的默认账本位置，不另开 scope。每一轮沿用同一个 taskId，只推进 revision。

身份 role 采用经过实际角色包核对的规范团队角色，例如 master；实例窗口可以显示 master-codex-remote，但不能仅凭显示名映射权限。终端所在 environment 与远端模型主机仍分开。菜单切换必须有真实原生会话 ID；无法取得或代际改变则报告阻塞，不把 unknown 标识当成验收。

本机 OMP 的 `terminal show` 缺少 session 字段不等于无法证明身份：使用团队 `lib/health.mjs` 的 `inspectHealth(orca, rpc, handle, 'omp')` 与 `provesSession(live, savedAgent)`，并以 `lib/sessions.mjs` 的 `validateTranscript(savedAgent, project)` 核验项目原生记录；还须将返回 handle/incarnation/PTY 与实时终端匹配。`orca`/`rpc` 来自 `lib/orca.mjs`，savedAgent 来自该 project 的 `state.json` 对应角色，不得以历史 ID 自证。

空草稿可以由 `terminal read --screen` 的真实原生 composer 证明，不强制要求所有 Orca 版本均提供 `draft` JSON 字段。当前已验 OMP 空框表现为独立空输入行 `╰─`（其后可能有 `mc: … · idle` 状态行）；必须结合 source=screen、完整可见输入区和实时 idle 判断，不能将截断/stream 回退、单纯缺少 draft 字段或旧截图当作空框。仍须向源助手索取最新安全暂停检查点。

### 执行和提交

远端 OMP 与切回本机（off）由 `orca-team` 进程内的确定性流程 `lib/remote-handoff.mjs` 直接完成，不再打开 `remote-setup` AI 协调者：机械检查点、prepare/claim、投递一次、读取真实助手回执、accept 与提交都在同一命令里完成；超时保留 delivery_uncertain，再次运行同一切换只继续等待、不重发。下列步骤仍适用于远端 Codex 的协调者。

1. `start`/`remote` 先持久创建意图，再至多一次领取 setup 启动。只开启本机协调终端，不在此前更新或重启源。
2. 管理 agent 按本手册从 intent.source 请求最新安全检查点，核验目标角色与权限。runtime 为 null 时目标必须等于 intent.local，保留其会话，不创建替身。
3. 使用 intent.taskId 和 intent.ledgerDirectory 执行 `handoff.py prepare/claim`，仅发送一次，真实读取助手接受或拒绝，执行 `accept` 记录决定。
4. accepted 后执行启动消息中给出的 `orca-team remote-commit --role ROLE --intent ID --project PATH --home HOME`。命令核对下一 revision、source、目标、摘要哈希、助手回执和当前终端身份；off 还要求目标与原本 local 完全一致。成功后才持久切换 owner/runtime 并聚焦。
5. 明确 rejected 使用同样参数的 `remote-reject`；源仍持有任务。准备后尚未领取 setup 的意图也可取消。`setup_uncertain` 或 `delivery_uncertain` 不能靠重复菜单确认、删除记录或新建任务绕开，须先查询原管理终端和账本。

已确认菜单归属的任务始终以这个账本的接手方取新上下文。不要用另一个通用 skill ledger 在背后改变同一任务的接手方，再让菜单显示旧状态。直接点击 Orca 标签页仍仅聚焦，不触发上述协议。

### 重载保护及验证边界

存在切换请求、pending 意图或远端接手状态的分组，普通 `start` 会跳过其更新、重载与恢复；独立分组仍可恢复。不得在提取上下文前停掉源或原本 local。显式 `restart` 是单独的运行时操作，可能令身份过期，不应拿它修复 pending；`--fresh` 拒绝丢弃已建立连续性绑定的角色。

本轮真实交互终端验证了 omp→off 的明确返回请求；真实 CLI start/remote-commit 与 Python ledger 在隔离 Orca/助手夹具下完成同一任务 revision 1→2 的往返和原本 local 恢复，确认没有进入团队重载分支。未向现有业务 agent 新发送交接任务、未重启远端服务；这不新增“所有 OMP 或所有角色已经实机往返”的声明。

### 原生 OMP 往返与客户端重连补充（2026-10-14）

- 本机真实 OMP 源与远端 master 在隔离 registry 中完成真实助手接受的 revision 1/2 往返；SOURCE-ALPHA-7391 和远端读取 package.json 得到的 projects 返回同一原始 source session/incarnation。没有把现有业务角色的任务转移给测试会话。
- 期间关闭并重开本机 guest，核实远端 PID、instance、generation、session 和模型未改变。权威列表必须证明旧 guest 不存在；未知列表或 host 故障不能通过重建绕过。
- 已接手 guest 更换时，在共享 Python 账本锁内追加经验证的 `owner_rebindings` 链，保留归档原始回执；下一 revision 仅接受链末端作为当前 source。原始回执字节未变；这不是任意终端的身份替换许可。
- OMP 正向和返回提交除 terminal 身份外还核对实际 adapter binding。准备中或结果未知的交接不触发重新接入或重复投递。完整运行与测试范围见 operations.md 第 2.2 节。

### 上下文接续不等于业务执行授权

同一规范角色可以在本机与远端之间接收、保管和返还任务上下文。master 可以继续协调、派发、汇总与跟踪验收；角色包中“不承担业务任务负责人”不应解释为禁止保管业务任务上下文。它仍不得默认替代 coder、reviewer、loader 等专业角色执行工作。其他角色也不能仅因检查点提及其他专业工作就拒绝接收；应明确自己的执行边界、保持暂停，而非自动执行待办。身份、工作区或授权范围不符仍必须拒绝。

远端 OMP 启动指令现在加载与本机相同的 `roles/<role>.md` Orca 适配层，而不只加载通用 CCB 角色包。新建会话使用完整更新指令；已有会话不会因磁盘文件更新而自动重载。每次通过 `handoff.py message` 生成的交接消息也包含上述区分，因此后续交接可向既有会话传达修正，无需清空历史或重启。旧 rejected 回执保持原样，后续须由原 owner 以同一 task 的下一 revision 正式交接，并取得新的真实接受回执；本次约束修改不代表旧交接已成功。

本次验证：实际生成全部 10 个团队角色的指令及既有 master 记录的交接消息，文件写权限保持角色包原值；适配器 10 项、交接账本 7 项回归通过。未重发业务交接或更改既有归属，未将消息生成冒充远端接受。
