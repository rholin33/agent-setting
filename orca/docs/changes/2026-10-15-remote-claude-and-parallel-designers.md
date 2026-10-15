# 2026-10-15：远端 Claude 修复与双 designer 配置

## 本次解决的问题

| 问题 | 原因与最终行为 |
| --- | --- |
| 启用 remote Claude 失败后本机角色已被停止或切换 CLI | 增加 Claude 环境预检，并移到本机 CLI 切换之前。缺失、歧义或无效环境明确报错。添加主机后仍需核对真实连接及工作区访问。 |
| 菜单支持与运行程序不一致，master 仍在本机继续工作 | 菜单、参数和归属登记支持 Claude；只有真实助手回执及身份验证通过后才提交交接。现场确认 master、archi 在远端使用 Opus，保留原本本机源会话暂停状态。 |
| 远端只在顶部标签页出现，或挂在远端项目下 | 在调用 orca-team 的本机项目创建交互终端，连接原远端 Claude PTY。启动、复用及 remote-commit 都聚焦本地入口，任务归属仍保存在远端 owner 记录。 |
| 远端访问本地项目时权限或路径不匹配 | MCP 增加只读约束、显式未跟踪文件读取、Markdown 根目录白名单、Windows 路径规范化和 UTF-8 兼容。 |
| designer 只有一个前端席位 | 新增 designer2，designer 分组等分为两个独立窗格，master 提示要求按文件或模块并行分工并汇总验收。 |

## 新增和更新的可移植配置

- team.json、omp-models.json、roles/designer2.md：designer2 与 designer 使用相同 frontend_engineer 职责、OMP 和 local/gemini-3.8-flash-high。
- layout.json：默认 designer 分组包含 designer、designer2，vertical、ratio=0.5。
- project-configs/industrial-drawing-translator-bc74519a/config.json：当前项目布局，包含双 designer；其他已初始化项目保留自己的布局。
- roles/master.md：发现真实角色入口，明确文件所有权、接口、验收与独立报告，避免同时编辑同一文件。
- orca-remote 技能及 Claude 参考文档：补充原生身份验证、私有绑定、本地项目入口与双向交接。
- Claude 终端传输与身份验证代码、MCP 边界测试、菜单和启动测试。

本地常规配置与远端执行归属独立。本次导出的本地 master/archi/reviewer 使用 OMP pay/gpt-6.1-sol；现场远端 master/archi 使用 Claude Opus。本次发布不会把运行中的远端 owner 改回本机，远端 owner 也不作为可移植配置上传。新机器需要重新配对并完成真实交接。

## 验证结果

现场验收：master、archi 显示在当前项目的 main / Local Windows 清单，保留原远端终端与会话；原生进程、PTY、cwd、会话记录确认模型 claude-opus-5-5。两个 designer 均可见，designer2 真实回复就绪，远端 master 已通过受限 MCP 识别；重复启动复用原会话。

发布前自动检查（Windows Node.js 24，Python 桥接测试使用 WSL）：

- `node --test --test-reporter=tap tests/*.test.mjs`：401 项，381 通过，20 失败。相较已安装版本的 32 项失败，新增失败 0；已修正 12 项旧菜单循环断言，并补充 Claude 往返和通用标题测试。
- 剩余 20 项均出现在此前失败记录中，主要涉及 URL.pathname 生成 /C:/... 的 Windows 路径夹具，以及 Python 包装器测试中的 POSIX 文件权限假设。本次发布未扩大到这些兼容性测试修整，全套测试尚未全绿。
- `python3 -m unittest discover -s orca/remote-master -p test_bridge.py -v`：10/10 通过，涵盖认证、只读拒绝、路径边界及写入范围。
- `python scripts/test-sync-exclusions.py`：2/2 通过。
- 发布前检查 Git 空白错误与精确提交文件，扫描敏感值及运行时资料。

## 发布边界与后续限制

仅同步代码、角色提示、布局和说明。排除无关 Claude 技能、Pi 设置、CLI 更新器等本地变更；原始导出另作本机备份。配对密钥、模型凭据、服务地址、会话 ID、原始对话、日志、项目 state、pane 和 owner ledger 不上传。本次同步不启动或重启业务角色。

Claude 原生探测当前针对已验证的 macOS 主机与 Opus 模型；新机器的环境、受限 MCP、binding 与 pending 引用仍需协调者准备。远端 master 使用 list_roles/read_role/send_role，完整本地编排 inbox/ACK/dispatch 迁移未实现。可选标签固定警告仍可能出现，不影响已验收的双 designer 窗格。

详细说明：[远端 Claude](../features/remote-claude.md)、[双 designer](../features/parallel-designers.md)、[远端启动](../features/remote-startup.md)。
