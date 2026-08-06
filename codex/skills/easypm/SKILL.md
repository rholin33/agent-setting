---
name: easypm
description: Use this skill when the user wants to log in to EasyPM, verify or clear an EasyPM session, select or bind an EasyPM project, list projects with fuzzy search, create EasyPM work items or add labour logs to existing work items with saveLabourLog man-hour records, maintain local Markdown progress records, or install a git pre-push hook that records pushed commits as EasyPM tasks with estimated effort.
---

# EasyPM

## User-Facing Language

Default to Chinese for all user-facing replies and prompts when using this skill.

When the user only invokes `$easypm` or otherwise loads the skill without a specific operation, reply in Chinese with this menu:

```text
EasyPM skill 已加载。

你想执行哪类操作：登录、查看会话、选择/绑定项目、查询项目、查看进行中任务、新增任务、完成任务/更新工时，还是安装 git hook？
```

Keep CLI command names in monospace when helpful, but describe actions in Chinese. For example, say `登录` before `login`, `查看会话` before `session`, `新增任务` before `new-task`, and `完成任务/更新工时` before `finish-task` or `update-effort`.

When required task fields are missing, ask in Chinese. For example: `请提供任务标题和预估工时，例如：生产环境部署，4小时。`

## Overview

Use this skill to connect local work to EasyPM. It supports login/session management, project selection, repository-level project binding, global project tracking, local Markdown progress files, manual task creation, and a git hook that creates an EasyPM task from commit content.

## Quick Start

Use the helper script:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py login
python3 ~/.codex/skills/easypm/scripts/easypm.py projects --query "<name>"
python3 ~/.codex/skills/easypm/scripts/easypm.py select-project --query "<name>"
python3 ~/.codex/skills/easypm/scripts/easypm.py bind --query "<name>"
python3 ~/.codex/skills/easypm/scripts/easypm.py working-tasks
python3 ~/.codex/skills/easypm/scripts/easypm.py new-task --task-type test --title "<title>" --effort 2
python3 ~/.codex/skills/easypm/scripts/easypm.py add-labour --work-guid "<guid>" --effort 2 --labour-type test
python3 ~/.codex/skills/easypm/scripts/easypm.py finish-task --work-no 20 --effort 2 --labour-type test
python3 ~/.codex/skills/easypm/scripts/easypm.py install-hook
```

Credentials are never stored by the script. Prefer environment variables:

```bash
export EASYPM_ACCOUNT="..."
export EASYPM_PASSWORD="..."
```

If they are not set, the script prompts interactively.

## Login And Session

Run `login` before other operations when you want to explicitly verify credentials:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py login
python3 ~/.codex/skills/easypm/scripts/easypm.py session
python3 ~/.codex/skills/easypm/scripts/easypm.py logout
```

The script caches only the EasyPM token and user id in `~/.easypm/session.json` with user-only file permissions. It never writes the password to disk. Use `login --fresh` to replace a cached token.

## Project Selection And Binding

When invoked inside a git repository, first check `.easypm/config.json`. If it contains a bound `projectGuid`, use that project by default. If no binding exists, run `bind --query "<project name>"` after the user chooses a project; this writes `.easypm/config.json` and creates/updates `.easypm/PROGRESS.md`.

When invoked outside a git repository, use global state under `~/.easypm/`: selected projects are recorded in `~/.easypm/projects.json`, and progress is maintained in `~/.easypm/PROGRESS.md`.

Use `select-project` for the normal global workflow. It first searches locally cached projects, then fetches from EasyPM when `--refresh` is supplied or no cached project matches. The selected project is written to the current context config and added to the global project list.

## Stability And Retry Discipline

EasyPM network calls are relatively fragile. For normal labour logging, minimize API calls and avoid broad retries.

- Do not run exploratory project searches when the current conversation already gives a clear `projectNo`, `projectGuid`, or repeatedly used project mapping.
- Prefer one exact project query first, such as `projects --query "宿迁学院"`; avoid broad fallback queries unless the exact query returns no result.
- Use `select-project --project-no "<no>"` without `--refresh` when the project was just queried or selected recently. Use `--refresh` only when the local cache may be stale, the project was not found, or ambiguity must be resolved.
- Use `working-tasks --json` when matching tasks for writes. It returns `workGuid`; copy that GUID into the write command.
- Prefer `add-labour --work-guid "<guid>"` over `--work-no`. `--work-no` forces an extra task-list lookup and is more likely to fail on unstable network calls.
- If a network/TLS/timeout error happens before a write result is printed, retry at most once with a narrower command. For `add-labour`, retry with `--work-guid` if available.
- If the retry also fails, stop and report the exact unrecorded item; do not keep retrying.
- If an EasyPM command returns JSON with `created`, `updated`, or `labourLog`, treat it as successful and do not retry.

## Ambiguous Choices

If the user's project or task description can match more than one project or task, stop and ask the user to choose before taking any write action.

For project ambiguity, list the candidate projects with `projectNo`, `projectName`, owner, status, progress, and `projectGuid`. Do not select a project or create/update labour until the user chooses one.

For task ambiguity, list the candidate tasks with `workNo`, title, status, effort, owner, and `workGuid`. Do not create a new task or add labour until the user chooses an existing task or confirms that none of the candidates should be used.

Only proceed automatically when there is exactly one clear active match. If there are closed and active matches, prefer the active match only when it is clearly the same project/task requested; otherwise ask.

## Existing Task First Rule

Before creating a task for a project, first check whether a matching task already exists in that project.

Use this workflow for each project/task request:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py select-project --project-no "<no>"
python3 ~/.codex/skills/easypm/scripts/easypm.py working-tasks --json
```

Compare the requested work with existing task titles, task type prefixes, and keywords. Treat close semantic matches as existing tasks, for example "部署调试" can match an existing deployment/debugging task for the same project.

If a matching task exists, do not run `new-task`. Add the requested day's labour to the existing task instead:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py add-labour --work-guid "<workGuid>" --effort 2 --labour-type deploy --labour-date "<YYYY-MM-DD>"
```

Use the requested actual man-hours as `--effort`, choose the labour type from the work being recorded, and pass the requested labour date explicitly when the user says today/yesterday or gives a date. `add-labour` records actual labour only and does not change the task's planned effort. Only create a new task when no suitable existing task is found.

## Global Project Operations

After selecting a project, use:

```bash
python3 ~/.codex/skills/easypm/scripts/easypm.py working-tasks --json
python3 ~/.codex/skills/easypm/scripts/easypm.py finish-task --work-no "<no>" --effort 2 --labour-type test
python3 ~/.codex/skills/easypm/scripts/easypm.py add-labour --work-guid "<guid>" --effort 2 --labour-type program
python3 ~/.codex/skills/easypm/scripts/easypm.py update-effort --work-guid "<guid>" --effort 4 --labour-type program
python3 ~/.codex/skills/easypm/scripts/easypm.py new-task --task-type design --title "<title>" --effort 2 --confirm
```

`new-task` creates a `working` task and records actual effort in EasyPM. Supported task types are `design`/设计, `test`/测试, `deploy`/部署, `travel`/出差, and `other`/其他. In interactive mode the script asks for task type, title, description, and effort.

## Task Creation

Creating a task is always a two-step EasyPM operation:

1. Call `saveWorkItem` to create the work item and set its status through status logs.
2. Call `saveLabourLog` to record the actual man-hours for that work item.

Default `labourType` mapping: `design=4 model`, `test=7 test`, `deploy=8 deploy`, `travel=9 training`, `other=10 support`, and git commit hook entries use `3 program`. Use `--labour-type` to override with a numeric type or alias such as `program`, `test`, or `deploy`.

EasyPM work item status values include `new=0`, `accept=1`, `working=2`, `finished=3`, and `close=100`. To create a working task, the script creates the work item, then advances it through EasyPM status logs to `working`.

The local `PROGRESS.md` records work item status plus the labour type and actual `manHour`, so local progress and EasyPM labour reports stay aligned.

For API details, read `references/api.md` only when changing endpoint behavior or troubleshooting.

## Git Hook Workflow

Run `install-hook` inside a git repo. The hook runs on `git push`, reads the commits being pushed, estimates effort from the interval since each commit's parent, and creates `finished` tasks in the bound EasyPM project.

Hook-created tasks are saved as `finished` and record labour through `saveLabourLog` with `labourType=3 program`. Each pushed commit becomes one task.

Effort buckets are:

- `<=1h`: `1`
- `<=2h`: `2`
- `<=4h`: `4`
- `<=6h`: `6`
- `>6h`: requires manual input unless `EASYPM_DEFAULT_LONG_EFFORT` is set

The hook appends each created task to the local progress Markdown file.
