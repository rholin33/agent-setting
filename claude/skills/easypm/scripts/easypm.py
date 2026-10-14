#!/usr/bin/env python3
"""EasyPM helper CLI used by the easypm Codex skill."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
import uuid
from difflib import SequenceMatcher


BASE_URL = os.environ.get("EASYPM_BASE_URL", "https://easypm2.jingtengtech.com")
GLOBAL_DIR = Path.home() / ".easypm"
SESSION_FILE = GLOBAL_DIR / "session.json"
GLOBAL_PROJECTS_FILE = GLOBAL_DIR / "projects.json"
GLOBAL_PROGRESS_FILE = GLOBAL_DIR / "PROGRESS.md"

STATUS = {
    "new": 0,
    "accept": 1,
    "working": 2,
    "finished": 3,
    "verifing": 4,
    "re-open": 5,
    "re-work": 6,
    "reject": 99,
    "close": 100,
}

STATUS_NAMES = {value: key for key, value in STATUS.items()}

TASK_TYPES = {
    "design": "设计",
    "test": "测试",
    "deploy": "部署",
    "travel": "出差",
    "other": "其他",
}

LABOUR_TYPES = {
    1: "meeting",
    2: "discuss",
    3: "program",
    4: "model",
    5: "UI",
    6: "doc",
    7: "test",
    8: "deploy",
    9: "training",
    10: "support",
    11: "demo",
}

TASK_LABOUR_TYPES = {
    "design": 4,
    "test": 7,
    "deploy": 8,
    "travel": 9,
    "other": 10,
    "commit": 3,
}

LABOUR_TYPE_ALIASES = {
    "meeting": 1,
    "会议": 1,
    "discuss": 2,
    "discussion": 2,
    "沟通": 2,
    "讨论": 2,
    "program": 3,
    "develop": 3,
    "development": 3,
    "code": 3,
    "coding": 3,
    "commit": 3,
    "开发": 3,
    "编码": 3,
    "model": 4,
    "design": 4,
    "设计": 4,
    "建模": 4,
    "ui": 5,
    "界面": 5,
    "doc": 6,
    "document": 6,
    "docs": 6,
    "文档": 6,
    "test": 7,
    "testing": 7,
    "测试": 7,
    "deploy": 8,
    "deployment": 8,
    "部署": 8,
    "training": 9,
    "travel": 9,
    "出差": 9,
    "培训": 9,
    "support": 10,
    "other": 10,
    "其他": 10,
    "支持": 10,
    "demo": 11,
    "演示": 11,
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        return default


def write_json(path: Path, value, private: bool = False) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if private:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def api_post(path: str, body=None, token: str | None = None):
    data = json.dumps(body or {}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(data)),
    }
    if token:
        headers["Authorization"] = token
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, json.loads(raw) if raw else None, raw
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        return error.code, parsed, raw


def data_of(parsed):
    if isinstance(parsed, dict) and "data" in parsed:
        return parsed["data"]
    if isinstance(parsed, dict) and "result" in parsed:
        result = parsed["result"]
        if isinstance(result, dict) and "data" in result:
            return result["data"]
        if isinstance(result, dict) and "item" in result:
            return result["item"]
        return result
    return parsed


def decode_jwt_payload(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode()).decode())
    except Exception:
        return {}


def cached_session() -> dict | None:
    session = read_json(SESSION_FILE, {})
    token = session.get("token")
    if not token:
        return None
    payload = decode_jwt_payload(token)
    exp = payload.get("exp")
    if exp and dt.datetime.now(dt.timezone.utc).timestamp() < exp - 60:
        return session
    return None


def login() -> dict:
    session = cached_session()
    if session:
        return session

    account = os.environ.get("EASYPM_ACCOUNT")
    password = os.environ.get("EASYPM_PASSWORD")
    if not account:
        account = input("EasyPM 账号: ").strip()
    if not password:
        password = getpass.getpass("EasyPM 密码: ")

    status, parsed, raw = api_post("/api/handleAuthentication", {"accountId": account, "pass": password})
    payload = data_of(parsed) or {}
    token = payload.get("token") or payload.get("accessToken") or payload.get("access_token")
    user_id = payload.get("userId")
    if status != 200 or not token or not user_id:
        raise SystemExit(f"EasyPM 登录失败: HTTP {status} {raw[:160]}")

    jwt_payload = decode_jwt_payload(token)
    session = {
        "token": token,
        "userId": user_id,
        "accountId": account,
        "expiresAt": dt.datetime.fromtimestamp(jwt_payload["exp"], dt.timezone.utc).isoformat()
        if jwt_payload.get("exp")
        else None,
        "savedAt": now_iso(),
    }
    write_json(SESSION_FILE, session, private=True)
    return session


def clear_session() -> None:
    try:
        SESSION_FILE.unlink()
    except FileNotFoundError:
        pass


def session_summary(session: dict | None) -> dict:
    if not session:
        return {"loggedIn": False, "sessionFile": str(SESSION_FILE)}
    token = session.get("token") or ""
    return {
        "loggedIn": True,
        "accountId": session.get("accountId"),
        "userIdPrefix": f"{str(session.get('userId', ''))[:8]}..." if session.get("userId") else None,
        "expiresAt": session.get("expiresAt"),
        "tokenPresent": bool(token),
        "sessionFile": str(SESSION_FILE),
    }


def login_command(args) -> None:
    if args.fresh:
        clear_session()
    session = login()
    print(json.dumps(session_summary(session), ensure_ascii=False, indent=2))


def session_command(args) -> None:
    session = cached_session()
    print(json.dumps(session_summary(session), ensure_ascii=False, indent=2))


def logout_command(args) -> None:
    clear_session()
    print(json.dumps({"loggedOut": True, "sessionFile": str(SESSION_FILE)}, ensure_ascii=False, indent=2))


def git_root(start: Path | None = None) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(start or Path.cwd()),
            text=True,
            capture_output=True,
            check=True,
        )
        return Path(result.stdout.strip())
    except Exception:
        return None


def context(repo: str | None = None) -> dict:
    root = Path(repo).resolve() if repo else git_root()
    if root:
        state_dir = root / ".easypm"
        return {
            "scope": "repo",
            "repo": root,
            "state_dir": state_dir,
            "config_file": state_dir / "config.json",
            "tasks_file": state_dir / "tasks.json",
            "progress_file": state_dir / "PROGRESS.md",
        }
    return {
        "scope": "global",
        "repo": None,
        "state_dir": GLOBAL_DIR,
        "config_file": GLOBAL_DIR / "current.json",
        "tasks_file": GLOBAL_DIR / "tasks.json",
        "progress_file": GLOBAL_PROGRESS_FILE,
    }


def normalize_project(project: dict) -> dict:
    keys = [
        "projectNo",
        "projectGuid",
        "projectName",
        "ownerName",
        "closed",
        "endDate",
        "percentage",
        "totalEffort",
        "doneEffort",
    ]
    return {key: project.get(key) for key in keys}


def fetch_projects(token: str) -> list[dict]:
    status, parsed, raw = api_post("/api/getAllProjectsWithProcess", {}, token)
    projects = data_of(parsed)
    if status != 200 or not isinstance(projects, list):
        raise SystemExit(f"项目列表获取失败: HTTP {status} {raw[:200]}")
    normalized = [normalize_project(project) for project in projects]
    state = read_json(GLOBAL_PROJECTS_FILE, {})
    state["fetchedAt"] = now_iso()
    state["projects"] = normalized
    write_json(GLOBAL_PROJECTS_FILE, state)
    return normalized


def project_score(project: dict, query: str) -> float:
    haystack = f"{project.get('projectNo', '')} {project.get('projectName', '')} {project.get('ownerName', '')}".lower()
    needle = query.lower().strip()
    if not needle:
        return 1.0
    if needle in haystack:
        return 2.0 + len(needle) / max(len(haystack), 1)
    return SequenceMatcher(None, needle, haystack).ratio()


def filter_projects(projects: list[dict], query: str | None) -> list[dict]:
    if not query:
        return projects
    scored = [(project_score(project, query), project) for project in projects]
    return [project for score, project in sorted(scored, key=lambda item: item[0], reverse=True) if score >= 0.25]


def cached_projects() -> list[dict]:
    return read_json(GLOBAL_PROJECTS_FILE, {}).get("projects") or []


def remember_selected_project(ctx: dict, project: dict) -> None:
    config = read_json(ctx["config_file"], {})
    config["scope"] = ctx["scope"]
    config["selectedAt"] = now_iso()
    config["project"] = project
    write_json(ctx["config_file"], config)
    remember_global_project(project, selected=True)
    ensure_progress(ctx, project)


def select_project(projects: list[dict], args) -> dict:
    if getattr(args, "project_guid", None):
        match = [p for p in projects if p.get("projectGuid") == args.project_guid]
    elif getattr(args, "project_no", None):
        match = [p for p in projects if str(p.get("projectNo")) == str(args.project_no)]
    else:
        match = filter_projects(projects, getattr(args, "query", None))

    if not match:
        raise SystemExit("没有匹配到 EasyPM 项目。")
    if len(match) == 1:
        return match[0]
    if not sys.stdin.isatty():
        raise SystemExit("匹配到多个项目，请使用 --project-guid 或 --project-no 重新运行。")

    for index, project in enumerate(match[:20], start=1):
        print(f"{index:>2}. P{project.get('projectNo')} {project.get('projectName')} ({project.get('ownerName')})")
    selected = input("请选择项目序号: ").strip()
    try:
        return match[int(selected) - 1]
    except Exception:
        raise SystemExit("项目选择无效。")


def project_from_context(ctx: dict) -> dict:
    config = read_json(ctx["config_file"], {})
    project = config.get("project")
    if not project:
        raise SystemExit("当前未绑定 EasyPM 项目。请运行：easypm.py bind --query <项目名称>")
    return project


def remember_global_project(project: dict, selected: bool = False) -> None:
    state = read_json(GLOBAL_PROJECTS_FILE, {})
    projects = state.get("projects") or []
    by_guid = {project.get("projectGuid"): project for project in projects if project.get("projectGuid")}
    by_guid[project["projectGuid"]] = project
    state["projects"] = list(by_guid.values())
    if selected:
        state["selectedProjectGuid"] = project["projectGuid"]
    write_json(GLOBAL_PROJECTS_FILE, state)


def bind_project(args) -> dict:
    session = login()
    projects = fetch_projects(session["token"])
    project = select_project(projects, args)
    ctx = context(args.repo)
    config = {
        "scope": ctx["scope"],
        "boundAt": now_iso(),
        "project": project,
    }
    write_json(ctx["config_file"], config)
    remember_global_project(project, selected=ctx["scope"] == "global")
    ensure_progress(ctx, project)
    print(json.dumps({"bound": project, "scope": ctx["scope"], "progress": str(ctx["progress_file"])}, ensure_ascii=False, indent=2))
    return project


def select_project_command(args) -> None:
    ctx = context(args.repo)
    session = login()
    projects = cached_projects()
    if args.refresh or not projects:
        projects = fetch_projects(session["token"])
    matches = filter_projects(projects, args.query)
    if not matches and args.query:
        projects = fetch_projects(session["token"])
        matches = filter_projects(projects, args.query)
    project = select_project(matches or projects, args)
    remember_selected_project(ctx, project)
    print(json.dumps({"selected": project, "scope": ctx["scope"], "progress": str(ctx["progress_file"])}, ensure_ascii=False, indent=2))


def safe_task(work: dict) -> dict:
    return {
        "workGuid": work.get("workGuid"),
        "workNo": work.get("workNo"),
        "projectGuid": work.get("projectGuid"),
        "title": work.get("title"),
        "status": work.get("status"),
        "statusName": STATUS_NAMES.get(work.get("status"), str(work.get("status"))),
        "effort": work.get("effort"),
        "displayName": work.get("displayName"),
        "statusUser": work.get("statusUser"),
    }


def project_work_items(token: str, project_guid: str) -> list[dict]:
    status, parsed, raw = api_post("/api/getProjectWorks", {"projectGuid": project_guid}, token)
    if status != 200:
        raise SystemExit(f"项目任务获取失败: HTTP {status} {raw[:200]}")
    data = data_of(parsed)
    return flatten_work_items(data if isinstance(data, list) else [])


def working_tasks(args) -> list[dict]:
    session = login()
    ctx = context(args.repo)
    project = project_from_context(ctx)
    tasks = [
        task
        for task in project_work_items(session["token"], project["projectGuid"])
        if not task.get("isDeleted") and task.get("status") == STATUS["working"]
    ]
    if args.json:
        print(json.dumps([safe_task(task) for task in tasks], ensure_ascii=False, indent=2))
    else:
        print("| Work No | Title | Effort | Owner | Guid |")
        print("|---:|---|---:|---|---|")
        for task in tasks:
            print(
                f"| {markdown_escape(task.get('workNo'))} | {markdown_escape(task.get('title'))} | "
                f"{markdown_escape(task.get('effort'))} | {markdown_escape(task.get('displayName'))} | {task.get('workGuid')} |"
            )
    return tasks


def choose_work_guid(token: str, project: dict, args, status_value: int | None = None) -> str:
    if args.work_guid:
        return args.work_guid
    tasks = [
        task
        for task in project_work_items(token, project["projectGuid"])
        if not task.get("isDeleted") and (status_value is None or task.get("status") == status_value)
    ]
    if args.work_no is not None:
        for task in tasks:
            if str(task.get("workNo")) == str(args.work_no):
                return task["workGuid"]
        raise SystemExit(f"当前项目中没有 workNo={args.work_no} 的任务。")
    if not sys.stdin.isatty():
        raise SystemExit("请指定 --work-guid 或 --work-no。")
    for index, task in enumerate(tasks[:30], start=1):
        status_name = STATUS_NAMES.get(task.get("status"), task.get("status"))
        print(f"{index:>2}. #{task.get('workNo')} [{status_name}] {task.get('title')} effort={task.get('effort')}")
    selected = input("请选择任务序号: ").strip()
    try:
        return tasks[int(selected) - 1]["workGuid"]
    except Exception:
        raise SystemExit("任务选择无效。")


def finish_task(args) -> None:
    session = login()
    ctx = context(args.repo)
    project = project_from_context(ctx)
    work_guid = choose_work_guid(session["token"], project, args, STATUS["working"])
    effort = args.effort
    if effort is None and sys.stdin.isatty():
        raw = input("工时（留空则保持原值）: ").strip()
        effort = float(raw) if raw else None
    updated = set_work_status(
        session["token"],
        session["userId"],
        work_guid,
        STATUS["finished"],
        args.comment or "finished",
        effort,
    )
    if effort is not None:
        updated["effort"] = effort
        labour_type = resolve_labour_type(args.labour_type, None, updated.get("keyword"))
        labour_log = save_labour_log(
            session["token"],
            session["userId"],
            project,
            updated,
            labour_type,
            effort,
            args.comment or updated.get("title") or "finished",
            updated.get("content") or args.comment or updated.get("title") or "finished",
            args.labour_date,
        )
        updated["_labourLog"] = labour_log
    append_progress(ctx, project, updated, source="finish-task")
    print(json.dumps({"finished": safe_task(updated), "labourLog": safe_labour_log(updated.get("_labourLog"))}, ensure_ascii=False, indent=2))


def update_effort(args) -> None:
    session = login()
    ctx = context(args.repo)
    project = project_from_context(ctx)
    work_guid = choose_work_guid(session["token"], project, args)
    current = get_work_item(session["token"], work_guid)
    if not current:
        raise SystemExit("未找到任务。")
    current["effort"] = args.effort
    status_code, parsed, raw = api_post("/api/saveWorkItem", {"item": current}, session["token"])
    if status_code != 200:
        raise SystemExit(f"保存任务失败: HTTP {status_code} {raw[:200]}")
    updated = get_work_item(session["token"], work_guid) or current
    labour_type = resolve_labour_type(args.labour_type, None, updated.get("keyword"))
    labour_log = save_labour_log(
        session["token"],
        session["userId"],
        project,
        updated,
        labour_type,
        args.effort,
        args.comment or updated.get("title") or "update effort",
        updated.get("content") or args.comment or updated.get("title") or "update effort",
        args.labour_date,
    )
    updated["_labourLog"] = labour_log
    append_progress(ctx, project, updated, source="update-effort")
    print(json.dumps({"updated": safe_task(updated), "labourLog": safe_labour_log(labour_log)}, ensure_ascii=False, indent=2))


def add_labour(args) -> None:
    session = login()
    ctx = context(args.repo)
    project = project_from_context(ctx)
    work_guid = choose_work_guid(session["token"], project, args)
    current = get_work_item(session["token"], work_guid)
    if not current:
        raise SystemExit("未找到任务。")
    labour_type = resolve_labour_type(args.labour_type, None, current.get("keyword"))
    content = args.comment or current.get("title") or "add labour"
    labour_log = save_labour_log(
        session["token"],
        session["userId"],
        project,
        current,
        labour_type,
        args.effort,
        content,
        current.get("content") or content,
        args.labour_date,
    )
    current["_labourLog"] = labour_log
    current["_labourType"] = labour_type
    append_progress(ctx, project, current, source="add-labour")
    print(json.dumps({"updated": safe_task(current), "labourLog": safe_labour_log(labour_log)}, ensure_ascii=False, indent=2))


def set_effort(args) -> None:
    session = login()
    if args.work_guid:
        work_guid = args.work_guid
    else:
        ctx = context(args.repo)
        project = project_from_context(ctx)
        work_guid = choose_work_guid(session["token"], project, args)
    current = get_work_item(session["token"], work_guid)
    if not current:
        raise SystemExit("未找到任务。")
    current["effort"] = args.effort
    status_code, parsed, raw = api_post("/api/saveWorkItem", {"item": current}, session["token"])
    if status_code != 200:
        raise SystemExit(f"保存任务失败: HTTP {status_code} {raw[:200]}")
    updated = get_work_item(session["token"], work_guid) or current
    print(json.dumps({"updated": safe_task(updated)}, ensure_ascii=False, indent=2))


def interactive_task_args(args):
    if not args.task_type and sys.stdin.isatty():
        print("任务类型:")
        for index, (key, label) in enumerate(TASK_TYPES.items(), start=1):
            print(f"{index}. {label} ({key})")
        raw = input("请选择类型序号，或输入自定义类型: ").strip()
        keys = list(TASK_TYPES.keys())
        if raw.isdigit() and 1 <= int(raw) <= len(keys):
            args.task_type = keys[int(raw) - 1]
        else:
            args.task_type = raw or "other"
    if not args.title and sys.stdin.isatty():
        args.title = input("任务标题: ").strip()
    if args.description is None and sys.stdin.isatty():
        args.description = input("任务描述: ").strip()
    if args.effort is None and sys.stdin.isatty():
        args.effort = float(input("预估工时: ").strip())
    if not args.title:
        raise SystemExit("非交互模式下必须提供 --title。")
    if args.effort is None:
        raise SystemExit("非交互模式下必须提供 --effort。")
    type_label = TASK_TYPES.get(args.task_type, args.task_type or TASK_TYPES["other"])
    if not args.title.startswith(f"[{type_label}]"):
        args.title = f"[{type_label}] {args.title}"
    if args.description is None:
        args.description = args.title
    return args


def resolve_labour_type(value=None, task_type: str | None = None, keyword: str | None = None) -> int:
    raw = str(value).strip() if value is not None else ""
    if raw:
        if raw.isdigit():
            labour_type = int(raw)
            if labour_type in LABOUR_TYPES:
                return labour_type
        alias = LABOUR_TYPE_ALIASES.get(raw.lower())
        if alias:
            return alias
        raise SystemExit(f"未知 labourType: {value}。可用值：{', '.join(f'{k}={v}' for k, v in LABOUR_TYPES.items())}")
    for candidate in (task_type, keyword):
        if not candidate:
            continue
        key = str(candidate).strip().lower()
        if key in TASK_LABOUR_TYPES:
            return TASK_LABOUR_TYPES[key]
        if key in LABOUR_TYPE_ALIASES:
            return LABOUR_TYPE_ALIASES[key]
    return TASK_LABOUR_TYPES["other"]


def upgrade_progress_file(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    changed = False
    upgraded = []
    for line in lines:
        if line == "| Date | Work No | Status | Effort | Title | Source |":
            upgraded.append("| Date | Work No | Status | Effort | Labour Type | Man Hour | Title | Source |")
            changed = True
            continue
        if line == "|---|---:|---|---:|---|---|":
            upgraded.append("|---|---:|---|---:|---|---:|---|---|")
            changed = True
            continue
        if line == "| Date | Project | Work No | Status | Effort | Title | Source |":
            upgraded.append("| Date | Project | Work No | Status | Effort | Labour Type | Man Hour | Title | Source |")
            changed = True
            continue
        if line == "|---|---|---:|---|---:|---|---|":
            upgraded.append("|---|---|---:|---|---:|---|---:|---|---|")
            changed = True
            continue
        if line.startswith("|") and line.endswith("|") and "---" not in line:
            parts = line.split("|")
            if len(parts) == 8:
                parts = parts[:5] + ["  ", "  "] + parts[5:]
                line = "|".join(parts)
                changed = True
            elif len(parts) == 9:
                parts = parts[:6] + ["  ", "  "] + parts[6:]
                line = "|".join(parts)
                changed = True
        upgraded.append(line)
    if changed:
        path.write_text("\n".join(upgraded) + "\n", encoding="utf-8")


def safe_labour_log(log: dict | None) -> dict | None:
    if not log:
        return None
    labour_type = log.get("labourType")
    return {
        "labourGuid": log.get("labourGuid"),
        "labourType": labour_type,
        "labourTypeName": LABOUR_TYPES.get(labour_type, str(labour_type)),
        "manHour": log.get("manHour"),
        "labourDate": log.get("labourDate"),
    }


def save_labour_log(
    token: str,
    user_id: str,
    project: dict,
    task: dict,
    labour_type: int,
    man_hour: float,
    content: str,
    memo: str | None = None,
    labour_date: str | None = None,
) -> dict:
    item = {
        "labourGuid": str(uuid.uuid4()),
        "projectGuid": project["projectGuid"],
        "workGuid": task["workGuid"],
        "labourDate": labour_date or now_iso(),
        "userGuid": user_id,
        "content": content,
        "memo": memo or content,
        "labourType": labour_type,
        "manHour": man_hour,
        "isDeleted": False,
    }
    status_code, parsed, raw = api_post("/api/saveLabourLog", {"item": item}, token)
    if status_code != 200:
        raise SystemExit(f"saveLabourLog failed: HTTP {status_code} {raw[:200]}")
    saved = data_of(parsed)
    if isinstance(saved, dict):
        return saved
    return item


def new_task(args) -> dict:
    args = interactive_task_args(args)
    args.status = "working"
    args.keyword = args.keyword or args.task_type or "other"
    args.work_type = args.work_type or 100
    args.priority = args.priority or 4
    args.labour_type = resolve_labour_type(args.labour_type, args.task_type, args.keyword)
    if args.confirm and sys.stdin.isatty():
        print(json.dumps({
            "title": args.title,
            "description": args.description,
            "effort": args.effort,
            "status": args.status,
            "keyword": args.keyword,
            "labourType": args.labour_type,
            "labourTypeName": LABOUR_TYPES.get(args.labour_type),
        }, ensure_ascii=False, indent=2))
        answer = input("是否创建该任务？[y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            raise SystemExit("已取消。")
    task = create_task(args, source="manual")
    print(json.dumps({"created": safe_task(task), "labourLog": safe_labour_log(task.get("_labourLog"))}, ensure_ascii=False, indent=2))
    return task


def markdown_escape(value) -> str:
    return str(value if value is not None else "").replace("|", "\\|").replace("\n", " ")


def ensure_progress(ctx: dict, project: dict | None = None) -> None:
    path = ctx["progress_file"]
    ensure_dir(path.parent)
    if path.exists():
        upgrade_progress_file(path)
        return
    if ctx["scope"] == "repo":
        project = project or project_from_context(ctx)
        text = textwrap.dedent(
            f"""\
            # EasyPM Progress

            Scope: repository
            Project: P{project.get('projectNo')} {project.get('projectName')}
            ProjectGuid: {project.get('projectGuid')}
            Created: {now_iso()}

            ## Tasks

            | Date | Work No | Status | Effort | Labour Type | Man Hour | Title | Source |
            |---|---:|---|---:|---|---:|---|---|
            """
        )
    else:
        text = textwrap.dedent(
            f"""\
            # EasyPM Global Progress

            Created: {now_iso()}

            ## Tasks

            | Date | Project | Work No | Status | Effort | Labour Type | Man Hour | Title | Source |
            |---|---|---:|---|---:|---|---:|---|---|
            """
        )
    path.write_text(text, encoding="utf-8")


def append_progress(ctx: dict, project: dict, task: dict, source: str | None = None) -> None:
    ensure_progress(ctx, project)
    status_name = STATUS_NAMES.get(task.get("status"), str(task.get("status")))
    date = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    effort = task.get("effort") if task.get("effort") is not None else ""
    labour_log = task.get("_labourLog") if isinstance(task.get("_labourLog"), dict) else {}
    labour_type = labour_log.get("labourType") or task.get("_labourType") or ""
    labour_type_name = LABOUR_TYPES.get(labour_type, str(labour_type)) if labour_type else ""
    man_hour = labour_log.get("manHour") if labour_log.get("manHour") is not None else ""
    work_no = task.get("workNo") or ""
    title = markdown_escape(task.get("title"))
    source = markdown_escape(source or task.get("source") or "")
    if ctx["scope"] == "repo":
        row = f"| {date} | {work_no} | {status_name} | {effort} | {labour_type_name} | {man_hour} | {title} | {source} |\n"
    else:
        project_label = markdown_escape(f"P{project.get('projectNo')} {project.get('projectName')}")
        row = f"| {date} | {project_label} | {work_no} | {status_name} | {effort} | {labour_type_name} | {man_hour} | {title} | {source} |\n"
    with ctx["progress_file"].open("a", encoding="utf-8") as handle:
        handle.write(row)


def flatten_work_items(items: list[dict], out: list[dict] | None = None) -> list[dict]:
    out = out or []
    for item in items or []:
        out.append(item)
        children = item.get("workItems")
        if isinstance(children, list):
            flatten_work_items(children, out)
    return out


def get_work_item(token: str, work_guid: str) -> dict | None:
    status, parsed, _ = api_post("/api/getWorkItemById", {"workGuid": work_guid}, token)
    if status != 200:
        return None
    data = data_of(parsed)
    return data if isinstance(data, dict) else None


def add_status_log(token: str, user_id: str, work_guid: str, status_value: int, comment: str) -> None:
    item = {
        "logGuid": str(uuid.uuid4()),
        "workGuid": work_guid,
        "logDate": now_iso(),
        "actualEffort": 0,
        "status": status_value,
        "userGuid": user_id,
        "comment": comment,
    }
    api_post("/api/addWorkLog", {"item": item}, token)


def set_work_status(token: str, user_id: str, work_guid: str, target_status: int, comment: str, effort: float | None = None) -> dict:
    current = get_work_item(token, work_guid) or {}
    current_status = current.get("status")
    if current_status == target_status:
        return current
    paths = {
        1: [1],
        2: [1, 2],
        3: [1, 2, 3],
        100: [1, 2, 3, 100],
    }
    for status_value in paths.get(target_status, [target_status]):
        current = get_work_item(token, work_guid) or {}
        if current.get("status") == status_value:
            continue
        add_status_log(token, user_id, work_guid, status_value, comment)
    return get_work_item(token, work_guid) or {}


def create_task(args, source: str | None = None, source_commit: str | None = None) -> dict:
    session = login()
    ctx = context(args.repo)
    project = project_from_context(ctx)
    token = session["token"]
    user_id = session["userId"]
    status_value = STATUS[args.status]
    item = {
        "workGuid": str(uuid.uuid4()),
        "projectGuid": project["projectGuid"],
        "title": args.title,
        "content": args.description or args.title,
        "contentImages": "",
        "keyword": args.keyword,
        "isDeleted": False,
        "workType": int(args.work_type),
        "priority": int(args.priority),
        "status": 0,
        "effort": args.effort,
    }
    if source_commit:
        item["sourceCommit"] = source_commit

    status_code, parsed, raw = api_post("/api/saveWorkItem", {"item": item}, token)
    if status_code != 200:
        raise SystemExit(f"saveWorkItem failed: HTTP {status_code} {raw[:200]}")
    created = data_of(parsed)
    if isinstance(created, dict) and isinstance(created.get("item"), dict):
        created = created["item"]
    if not isinstance(created, dict):
        created = item

    if status_value != 0:
        created = set_work_status(token, user_id, item["workGuid"], status_value, args.description or args.title, args.effort)
    if not created:
        created = item
    if "workGuid" not in created:
        created["workGuid"] = item["workGuid"]

    labour_type = resolve_labour_type(
        getattr(args, "labour_type", None),
        getattr(args, "task_type", None),
        getattr(args, "keyword", None),
    )
    labour_log = save_labour_log(
        token,
        user_id,
        project,
        created,
        labour_type,
        float(args.effort),
        args.title,
        args.description or args.title,
        getattr(args, "labour_date", None),
    )
    created["_labourLog"] = labour_log
    created["_labourType"] = labour_type

    append_progress(ctx, project, created, source=source)
    remember_task(ctx, created, source_commit)
    return created


def remember_task(ctx: dict, task: dict, source_commit: str | None = None) -> None:
    state = read_json(ctx["tasks_file"], {"tasks": []})
    labour_log = task.get("_labourLog") if isinstance(task.get("_labourLog"), dict) else {}
    entry = {
        "createdAt": now_iso(),
        "workGuid": task.get("workGuid"),
        "workNo": task.get("workNo"),
        "title": task.get("title"),
        "status": task.get("status"),
        "effort": task.get("effort"),
        "labourGuid": labour_log.get("labourGuid"),
        "labourType": labour_log.get("labourType") or task.get("_labourType"),
        "manHour": labour_log.get("manHour"),
        "sourceCommit": source_commit,
    }
    state.setdefault("tasks", []).append(entry)
    write_json(ctx["tasks_file"], state)


def task_exists_for_commit(ctx: dict, commit_hash: str) -> bool:
    state = read_json(ctx["tasks_file"], {"tasks": []})
    return any(task.get("sourceCommit") == commit_hash for task in state.get("tasks", []))


def estimate_effort(interval_seconds: int | None) -> float:
    if interval_seconds is None:
        return 1
    hours = max(interval_seconds / 3600, 0)
    if hours <= 1:
        return 1
    if hours <= 2:
        return 2
    if hours <= 4:
        return 4
    if hours <= 6:
        return 6
    default_long = os.environ.get("EASYPM_DEFAULT_LONG_EFFORT")
    if default_long:
        return float(default_long)
    if sys.stdin.isatty():
        return float(input(f"提交间隔为 {hours:.1f} 小时，请输入工时: ").strip())
    raise SystemExit("提交间隔超过 6 小时；请设置 EASYPM_DEFAULT_LONG_EFFORT，或手动创建任务。")


def git_output(repo: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=str(repo), text=True, capture_output=True, check=True)
    return result.stdout


def zero_oid(value: str | None) -> bool:
    return bool(value) and set(value.strip()) == {"0"}


def commit_parent_time(repo: Path, commit_hash: str) -> int | None:
    parents = git_output(repo, ["show", "-s", "--format=%P", commit_hash]).strip().split()
    if not parents:
        return None
    try:
        return int(git_output(repo, ["show", "-s", "--format=%ct", parents[0]]).strip())
    except Exception:
        return None


def commit_subject_body(repo: Path, commit_hash: str) -> tuple[str, str]:
    raw = git_output(repo, ["show", "-s", "--format=%s%n%b", commit_hash]).splitlines()
    subject = raw[0] if raw else commit_hash[:12]
    body = "\n".join(raw[1:]).strip()
    return subject, body


def commit_changed_files(repo: Path, commit_hash: str) -> str:
    return git_output(repo, ["show", "--name-status", "--format=", commit_hash]).strip()


def create_commit_task(repo: Path, commit_hash: str) -> dict:
    ctx = context(str(repo))
    if ctx["scope"] != "repo":
        raise SystemExit("push-task 必须在 git 仓库内运行。")
    if task_exists_for_commit(ctx, commit_hash):
        return {"skipped": "commit-already-recorded", "commit": commit_hash}

    commit_time = int(git_output(repo, ["show", "-s", "--format=%ct", commit_hash]).strip())
    parent_time = commit_parent_time(repo, commit_hash)
    interval = commit_time - parent_time if parent_time is not None else None
    effort = estimate_effort(interval)
    subject, body = commit_subject_body(repo, commit_hash)
    changed = commit_changed_files(repo, commit_hash)
    description = body or f"Commit: {subject}"
    if changed:
        description += "\n\nChanged files:\n" + changed

    class TaskArgs:
        pass

    task_args = TaskArgs()
    task_args.repo = str(repo)
    task_args.title = subject
    task_args.description = description
    task_args.status = "finished"
    task_args.effort = effort
    task_args.keyword = "commit"
    task_args.labour_type = TASK_LABOUR_TYPES["commit"]
    task_args.labour_date = None
    task_args.work_type = 100
    task_args.priority = 4
    task = create_task(task_args, source=commit_hash[:12], source_commit=commit_hash)
    return {
        "created": task.get("workGuid"),
        "workNo": task.get("workNo"),
        "commit": commit_hash,
        "effort": effort,
        "labourLog": safe_labour_log(task.get("_labourLog")),
    }


def collect_pushed_commits(repo: Path, ref_lines: list[str]) -> list[str]:
    commits: list[str] = []
    seen: set[str] = set()
    for line in ref_lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        _local_ref, local_sha, _remote_ref, remote_sha = parts[:4]
        if zero_oid(local_sha):
            continue
        if zero_oid(remote_sha):
            rev_args = ["rev-list", "--reverse", local_sha]
        else:
            rev_args = ["rev-list", "--reverse", f"{remote_sha}..{local_sha}"]
        for commit_hash in git_output(repo, rev_args).splitlines():
            commit_hash = commit_hash.strip()
            if not commit_hash or commit_hash in seen:
                continue
            seen.add(commit_hash)
            commits.append(commit_hash)
    return commits


def push_task(args) -> dict:
    ctx = context(args.repo)
    if ctx["scope"] != "repo":
        raise SystemExit("push-task 必须在 git 仓库内运行。")
    repo = ctx["repo"]
    ref_lines = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
    commits = collect_pushed_commits(repo, ref_lines)
    if not commits:
        latest = git_output(repo, ["log", "-1", "--format=%H"]).strip()
        commits = [latest] if latest else []

    results = []
    for commit_hash in commits:
        try:
            results.append(create_commit_task(repo, commit_hash))
        except SystemExit as exc:
            if "提交间隔超过 6 小时" in str(exc):
                raise
            results.append({"commit": commit_hash, "error": str(exc)})

    payload = {"commits": results}
    print(json.dumps(payload, ensure_ascii=False))
    return payload


def commit_task(args) -> dict:
    return push_task(args)


def install_hook(args) -> None:
    ctx = context(args.repo)
    if ctx["scope"] != "repo":
        raise SystemExit("install-hook 必须在 git 仓库内运行。")
    project_from_context(ctx)
    repo = ctx["repo"]
    hook = repo / ".git" / "hooks" / "pre-push"
    script = Path(__file__).resolve()
    block = textwrap.dedent(
        f"""\
        #!/bin/sh
        # EASYPM_HOOK_START
        REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
        if [ -n "$REPO_ROOT" ]; then
          mkdir -p "$REPO_ROOT/.easypm"
          python3 "{script}" push-task --repo "$REPO_ROOT" >> "$REPO_ROOT/.easypm/hook.log" 2>&1 || true
        fi
        # EASYPM_HOOK_END
        """
    )
    if hook.exists():
        text = hook.read_text(encoding="utf-8", errors="replace")
        if "EASYPM_HOOK_START" in text:
            print(json.dumps({"installed": str(hook), "changed": False}))
            return
        if not args.force:
            raise SystemExit("pre-push hook 已存在。请使用 --force 重新运行，脚本会先备份再安装 EasyPM hook。")
        backup = hook.with_name("pre-push.easypm-backup")
        backup.write_text(text, encoding="utf-8")
        block += f'\nHOOK_DIR="$(dirname "$0")"\n[ -x "$HOOK_DIR/pre-push.easypm-backup" ] && "$HOOK_DIR/pre-push.easypm-backup" "$@"\n'
    hook.write_text(block, encoding="utf-8")
    hook.chmod(hook.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(json.dumps({"installed": str(hook), "changed": True}))


def print_projects(args) -> None:
    session = login()
    projects = fetch_projects(session["token"])
    projects = filter_projects(projects, args.query)
    if args.limit:
        projects = projects[: args.limit]
    if args.json:
        print(json.dumps(projects, ensure_ascii=False, indent=2))
        return
    print("| No | Project | Owner | Status | Progress | Guid |")
    print("|---:|---|---|---|---:|---|")
    for project in projects:
        status = "已关闭" if project.get("closed") else "进行中"
        progress = project.get("percentage")
        progress_text = f"{float(progress):.1f}%" if isinstance(progress, (int, float)) else ""
        print(
            f"| {markdown_escape(project.get('projectNo'))} | {markdown_escape(project.get('projectName'))} | "
            f"{markdown_escape(project.get('ownerName'))} | {status} | {progress_text} | {project.get('projectGuid')} |"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Codex 使用的 EasyPM 辅助工具。")
    parser.add_argument("--repo", help="指定仓库根目录，代替自动检测。")
    sub = parser.add_subparsers(dest="command", required=True)

    login_parser = sub.add_parser("login", help="登录 EasyPM，并缓存 token；不会保存密码。")
    login_parser.add_argument("--fresh", action="store_true", help="忽略并替换已缓存的 EasyPM 会话。")

    sub.add_parser("session", help="查看当前缓存的 EasyPM 登录状态。")
    sub.add_parser("logout", help="删除已缓存的 EasyPM 会话 token。")

    projects = sub.add_parser("projects", help="查询 EasyPM 项目，可按关键词模糊过滤。")
    projects.add_argument("--query", help="按项目名称、编号或负责人模糊查询。")
    projects.add_argument("--limit", type=int, default=50)
    projects.add_argument("--json", action="store_true")

    select_project_parser = sub.add_parser("select-project", help="选择已有/已缓存项目，或拉取并添加新的 EasyPM 项目。")
    select_project_parser.add_argument("--query", help="按项目名称、编号或负责人模糊查询。")
    select_project_parser.add_argument("--project-guid")
    select_project_parser.add_argument("--project-no")
    select_project_parser.add_argument("--refresh", action="store_true", help="选择前先拉取最新项目列表。")

    bind = sub.add_parser("bind", help="将当前仓库或全局上下文绑定到 EasyPM 项目。")
    bind.add_argument("--query", help="按项目名称、编号或负责人模糊查询。")
    bind.add_argument("--project-guid")
    bind.add_argument("--project-no")

    task = sub.add_parser("add-task", help="在已绑定项目中创建 EasyPM 任务。")
    task.add_argument("--title", required=True)
    task.add_argument("--description", default="")
    task.add_argument("--status", choices=sorted(STATUS), default="working")
    task.add_argument("--effort", type=float, default=1)
    task.add_argument("--keyword")
    task.add_argument("--labour-type", help="实际工时类型，可用数字 1-11 或别名，如 program/test/deploy。")
    task.add_argument("--labour-date", help="工时日期，默认当前时间。")
    task.add_argument("--work-type", type=int, default=100)
    task.add_argument("--priority", type=int, default=4)

    new_task_parser = sub.add_parser("new-task", help="在已选项目中创建进行中任务，可交互填写。")
    new_task_parser.add_argument("--task-type", choices=sorted(TASK_TYPES), help="design/test/deploy/travel/other 分别对应设计/测试/部署/出差/其他。")
    new_task_parser.add_argument("--title")
    new_task_parser.add_argument("--description")
    new_task_parser.add_argument("--effort", type=float)
    new_task_parser.add_argument("--keyword")
    new_task_parser.add_argument("--labour-type", help="覆盖默认 labourType；design 默认 model(4)，test=7，deploy=8，travel=9，other=10。")
    new_task_parser.add_argument("--labour-date", help="工时日期，默认当前时间。")
    new_task_parser.add_argument("--work-type", type=int, default=100)
    new_task_parser.add_argument("--priority", type=int, default=4)
    new_task_parser.add_argument("--confirm", action="store_true", help="创建前确认任务内容。")

    working = sub.add_parser("working-tasks", help="列出已选项目中的进行中任务。")
    working.add_argument("--json", action="store_true")

    finish = sub.add_parser("finish-task", help="将进行中任务流转为已完成，并可记录实际工时。")
    finish.add_argument("--work-guid")
    finish.add_argument("--work-no")
    finish.add_argument("--effort", type=float)
    finish.add_argument("--comment", default="")
    finish.add_argument("--labour-type", help="实际工时类型，可用数字 1-11 或别名。")
    finish.add_argument("--labour-date", help="工时日期，默认当前时间。")

    effort = sub.add_parser("update-effort", help="更新已有任务预估工时，并记录一条实际工时。")
    effort.add_argument("--work-guid")
    effort.add_argument("--work-no")
    effort.add_argument("--effort", type=float, required=True)
    effort.add_argument("--comment", default="")
    effort.add_argument("--labour-type", help="实际工时类型，可用数字 1-11 或别名。")
    effort.add_argument("--labour-date", help="工时日期，默认当前时间。")

    labour = sub.add_parser("add-labour", help="在已有任务下追加实际工时，不修改任务预估工时。")
    labour.add_argument("--work-guid")
    labour.add_argument("--work-no")
    labour.add_argument("--effort", type=float, required=True, help="实际工时。")
    labour.add_argument("--comment", default="")
    labour.add_argument("--labour-type", help="实际工时类型，可用数字 1-11 或别名。")
    labour.add_argument("--labour-date", help="工时日期，默认当前时间。")

    set_effort_parser = sub.add_parser("set-effort", help="仅更新已有任务预估工时，不记录实际工时。")
    set_effort_parser.add_argument("--work-guid")
    set_effort_parser.add_argument("--work-no")
    set_effort_parser.add_argument("--effort", type=float, required=True, help="任务预估工时。")

    hook = sub.add_parser("install-hook", help="为当前仓库安装 pre-push hook。")
    hook.add_argument("--force", action="store_true")

    sub.add_parser("commit-task", help=argparse.SUPPRESS)
    sub.add_parser("push-task", help=argparse.SUPPRESS)

    args = parser.parse_args()
    if args.command == "login":
        login_command(args)
    elif args.command == "session":
        session_command(args)
    elif args.command == "logout":
        logout_command(args)
    elif args.command == "projects":
        print_projects(args)
    elif args.command == "select-project":
        select_project_command(args)
    elif args.command == "bind":
        bind_project(args)
    elif args.command == "add-task":
        created = create_task(args)
        print(json.dumps({"created": safe_task(created), "labourLog": safe_labour_log(created.get("_labourLog"))}, ensure_ascii=False, indent=2))
    elif args.command == "new-task":
        new_task(args)
    elif args.command == "working-tasks":
        working_tasks(args)
    elif args.command == "finish-task":
        finish_task(args)
    elif args.command == "update-effort":
        update_effort(args)
    elif args.command == "add-labour":
        add_labour(args)
    elif args.command == "set-effort":
        set_effort(args)
    elif args.command == "install-hook":
        install_hook(args)
    elif args.command == "commit-task":
        commit_task(args)
    elif args.command == "push-task":
        push_task(args)


if __name__ == "__main__":
    main()
