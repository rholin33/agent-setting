---
name: gencom
description: 根据 Git diff 生成提交信息（严格遵循项目风格）
allowed-tools: Bash(git diff:*), Bash(git branch:*), Bash(git log:*)
---

# 提交信息生成器

每次执行时**必须**实时获取暂存区最新状态，不要使用缓存或假设。

## 实时获取信息

```bash
# 暂存文件列表
STAGED_FILES=!`git diff --cached --name-only`

# 变更统计
STATS=!`git diff --cached --stat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json' ':(exclude)yarn.lock' ':(exclude)bun.lockb'`

# 具体变更内容（全部显示）
DIFF=!`git diff --cached -- . ':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json' ':(exclude)yarn.lock' ':(exclude)bun.lockb'`

# 当前分支
BRANCH=!`git branch --show-current`

# 最近提交记录（分析风格）
RECENT_COMMITS=!`git log --oneline -10 --ignore-missing HEAD`
```

## 忽略规则

避免扫描以下锁文件：

- pnpm-lock.yaml
- package-lock.json
- yarn.lock
- bun.lockb

## 生成规则

### 0. 前置检查

- `STAGED_FILES` 为空时，直接告知"暂存区没有变更"，不要生成提交信息。
- 只描述暂存区的变更，不要把未暂存或未跟踪的文件写进去。

### 1. 先归纳当前仓库的提交风格

风格以 `RECENT_COMMITS` 为准，不要套用其他项目的约定。从最近 5-10 条记录中归纳：

- 前缀形式：emoji、Conventional Commits（`feat:`、`fix(scope):`）、方括号标签，或者没有前缀
- 标题语言和标点（中文或英文）
- 标题长度和措辞习惯（动词开头、名词短语等）
- 是否带正文，正文用什么格式

多数提交风格一致时严格沿用。风格混杂时跟随最近的多数。

### 2. 没有可参考的历史时

仓库没有提交或历史风格无法判断时，使用下方的 GitMoji 规范：

1. **标题**：emoji 前缀加简短描述（< 50 字），语言跟随仓库文档和代码注释
2. **正文**：使用 `- ` 列表，每条描述一个具体变更

### 3. 通用要求

- 标题准确概括本次变更的主要目的；涉及多类变更时，按主要变更选择类型
- 每条正文对应 diff 中真实存在的变更，不要编造或夸大
- emoji 用 Unicode 字符（✨），不用 `:sparkles:` 这种短代码

### 4. GitMoji 规范（补充）

| 类型 | 图标 | 用途         |
| ---- | ---- | ------------ |
| 功能 | ✨   | 新特性       |
|      | 🚀   | 部署相关     |
|      | ⚡   | 性能优化     |
| Bug  | 🐛   | 修复 Bug     |
|      | 🚑️   | 紧急热修复   |
|      | 🔒   | 安全修复     |
| 文档 | 📝   | 写文档       |
|      | 📚   | 更新文档     |
| 样式 | 💄   | UI/样式更新  |
|      | 🎨   | 代码格式化   |
| 重构 | ♻️   | 代码重构     |
|      | 🔄   | 重构代码     |
| 测试 | ✅   | 更新测试     |
| 依赖 | ➕   | 添加依赖     |
|      | ➖   | 删除依赖     |
|      | ⬆️   | 升级依赖     |
| 构建 | 📦   | 构建/包更新  |
|      | 🔧   | 配置修改     |
| 清理 | 🔥   | 删除代码     |
|      | 🗑️   | 删除废弃代码 |

## 输出要求

**必须使用 markdown 代码块格式输出**，将提交信息包裹在 ```markdown 代码块中，不要直接输出渲染后的文本。

示例输出格式：

```markdown
✅ 新增 SelectColor 组件测试

- 添加渲染测试：验证 select 元素和 label 文本
- 添加用户交互测试：验证点击后显示 3 个选项
```

注意：

- 不要展示获取的 git 信息内容（STAGED_FILES、DIFF 等）
- 只输出最终的提交信息，且必须在代码块中
