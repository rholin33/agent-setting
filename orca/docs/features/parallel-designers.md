# 双前端角色

## 功能概述

在 designer 分组新增 designer2，供 master 把互不依赖的前端任务分配给两个独立会话。保留 designer 的身份、历史和已有任务。

## 启动与交互

在目标项目执行 `orca-team start --group designer`，打开或复用两个等分窗格。designer2 沿用 frontend_engineer 职责、OMP 和 `local/gemini-3.8-flash-high` 模型。布局使用 `agents: ["designer", "designer2"]`、`direction: "vertical"`、`ratio: 0.5` 和 `displayTitle: "designer · designer2"`。

## 派发约定

master 从当前项目实时终端清单定位两个角色，分配前明确文件或模块所有权、接口和验收条件。共享组件与公共样式由一个角色负责；不得并发编辑同一文件。两个角色保留独立会话和任务身份，各自报告改动、验证及阻塞，master 汇总验收。已运行任务应在协调好的检查点拆分。

## 配置与持久化

新增 team.json / omp-models.json 的 designer2 条目与 roles/designer2.md，更新默认 layout.json、master 提示和 industrial-drawing-translator 的可移植项目布局。复用既有启动器，运行时 state.json 由其在本机生成，不进入同步仓库。无业务 API、数据库或产品前端变更。

## 验证状态

现场确认双窗格正常，原 designer 终端及进程未替换，designer2 使用独立会话并真实回复就绪，响应模型为 gemini-3.8-flash-high。远端 master 通过现有 MCP 确认识别 designer2。重复执行带 `--no-pick --no-repair` 的 designer 分组启动，两个角色均复用，无额外新建或重启。

启动测试已更新到默认 11 个角色，并检查 designer + designer2 快捷入口。发布检查结果见 [本次变更记录](../changes/2026-10-15-remote-claude-and-parallel-designers.md)。

## 限制

已初始化的其他项目保留各自布局，需要显式把 designer2 加入其 designer 分组。当前 Orca 版本的可选标签固定操作仍可能警告；双窗格与会话已验证。新增角色不会自行拆分或执行业务任务；master 按任务权限安排，远端 MCP 的编排权限不随角色数量扩大。
