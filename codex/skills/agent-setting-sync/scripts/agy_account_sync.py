#!/usr/bin/env python3
"""Cockpit 切换 Antigravity 账号后，重启本机所有 agy 进程，让它们改用新账号（仅 macOS）。

背景：agy 只从钥匙串读账号；运行中的进程把旧账号的刷新令牌留在内存里，
刷新时会把旧账号写回钥匙串，覆盖 Cockpit 刚写入的新账号。
所以切号后必须尽快重启全部 agy 进程，单靠重新切号或只重启部分进程都不够。

用法：
  agy_account_sync.py --install    安装 LaunchAgent（监视 Cockpit 账号文件，并每 5 分钟兜底检查）
  agy_account_sync.py --uninstall  卸载 LaunchAgent
  agy_account_sync.py --status     查看安装状态、目标账号和各 agy 进程的账号
  agy_account_sync.py              账号有变化才执行（LaunchAgent 调用）
  agy_account_sync.py --force      不管账号是否变化，都执行重启和核对
  agy_account_sync.py --dry-run    只列出将要做的事，不动任何进程
  agy_account_sync.py --pids 1,2   只处理指定进程（用于演练）

可用环境变量覆盖路径：COCKPIT_ACCOUNT_FILE、AGY_LOG_DIR、ORCA_TEAM_HOME、AGY_ACCOUNT_SYNC_HOME。
需要 Python 3.9+（兼容 macOS 自带的 /usr/bin/python3）。
"""
import argparse
import fcntl
import hashlib
import json
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
ACCOUNT_FILE = Path(os.environ.get("COCKPIT_ACCOUNT_FILE", HOME / ".cockpit_tools/current_account.json"))
AGY_LOG_DIR = Path(os.environ.get("AGY_LOG_DIR", HOME / ".gemini/antigravity-cli/log"))
ORCA_TEAM_HOME = Path(os.environ.get("ORCA_TEAM_HOME", HOME / ".orca/roles/ccb-team"))
STATE_DIR = Path(os.environ.get("AGY_ACCOUNT_SYNC_HOME", HOME / ".local/share/agy-account-sync"))
STATE_FILE = STATE_DIR / "state.json"
LOCK_FILE = STATE_DIR / "run.lock"
LOG_FILE = STATE_DIR / "sync.log"
LABEL = "com.agent-setting.agy-account-sync"
LEGACY_LABELS = ("com.gs.agy-account-sync",)
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

DEBOUNCE_SECONDS = 3
CHECK_INTERVAL_SECONDS = 300
# 等得越久，旧进程刷新令牌把旧账号写回钥匙串的概率越大，所以只给很短的空闲窗口
IDLE_WAIT_SECONDS = 30
IDLE_SAMPLE_SECONDS = 3
IDLE_CPU_PERCENT = 3.0
LOG_QUIET_SECONDS = 45
EXIT_WAIT_SECONDS = 15
VERIFY_WAIT_SECONDS = 120
LOG_MATCH_SECONDS = 3
ORCA_START_TIMEOUT_SECONDS = 600


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def sh(args, timeout=60):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def mask(email):
    if not email or "@" not in email:
        return email or "?"
    name, domain = email.split("@", 1)
    return f"{name[:4]}…@{domain}"


def account():
    data = json.loads(ACCOUNT_FILE.read_text())
    return data["email"], data.get("updated_at")


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except FileNotFoundError:
        return {}


def save_state(email, failed=None):
    data = {"email": email, "updated": int(time.time())}
    if failed:
        data["failed"] = failed
    STATE_FILE.write_text(json.dumps(data))


def notify(title, body):
    sh(["/usr/bin/osascript", "-e", f"display notification {json.dumps(body)} with title {json.dumps(title)}"])


def ps_field(pid, field):
    return sh(["/bin/ps", "-o", f"{field}=", "-p", str(pid)]).stdout.strip()


def host_of(pid):
    current = pid
    for _ in range(10):
        current = int(ps_field(current, "ppid") or 1)
        if current <= 1:
            return "unknown"
        comm = ps_field(current, "comm")
        if "orca/daemon-host" in comm:
            return "orca"
        if "Terminal.app" in comm:
            return "terminal"
    return "unknown"


def log_file_for(start):
    """agy 每次启动写一个 cli-YYYYMMDD_HHMMSS.log，按启动时间匹配。"""
    best = None
    for path in AGY_LOG_DIR.glob("cli-*.log"):
        match = re.match(r"cli-(\d{8}_\d{6})\.log$", path.name)
        if match:
            delta = abs((datetime.strptime(match.group(1), "%Y%m%d_%H%M%S") - start).total_seconds())
            if delta <= LOG_MATCH_SECONDS and (best is None or delta < best[0]):
                best = (delta, path)
    return best[1] if best else None


def log_values(path, pattern):
    return re.findall(pattern, path.read_text(errors="replace")) if path else []


def agy_processes():
    """列出所有 agy CLI 进程及其宿主（Orca 座位、Terminal.app 标签页或未知）。"""
    procs = []
    for pid in [int(p) for p in sh(["/usr/bin/pgrep", "-x", "agy"]).stdout.split()]:
        lstart = ps_field(pid, "lstart")
        if not lstart:
            continue
        cwd_out = sh(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"]).stdout
        start = datetime.strptime(lstart, "%a %b %d %H:%M:%S %Y")
        argv = ps_field(pid, "command")
        log_path = log_file_for(start)
        emails = log_values(log_path, r"applyAuthResult: email=([^,\s]+)")
        conv = re.search(r"--conversation[ =]([0-9a-f-]{36})", argv)
        convs = log_values(log_path, r"cascade_id:([0-9a-f-]{36})")
        procs.append({
            "pid": pid, "argv": argv, "start": start, "log": log_path,
            "tty": "/dev/" + ps_field(pid, "tty"),
            "cwd": next((line[1:] for line in cwd_out.splitlines() if line.startswith("n")), ""),
            "host": host_of(pid),
            "email": emails[-1] if emails else None,
            "conversation": conv.group(1) if conv else (convs[-1] if convs else None),
        })
    return procs


def is_idle(proc):
    """空闲 = 没有子进程、CPU 低，且 agy 日志近期没有写入；找不到日志时按忙处理。"""
    if not proc["log"]:
        return False
    cpu = float(ps_field(proc["pid"], "%cpu") or 0)
    children = sh(["/usr/bin/pgrep", "-P", str(proc["pid"])]).stdout.split()
    quiet = time.time() - proc["log"].stat().st_mtime >= LOG_QUIET_SECONDS
    return cpu < IDLE_CPU_PERCENT and not children and quiet


def wait_idle(procs):
    deadline = time.time() + IDLE_WAIT_SECONDS
    pending = {p["pid"]: p for p in procs}
    while pending and time.time() < deadline:
        # 连续两次采样都空闲才算空闲，避免碰上两次调用之间的间隙
        idle_now = [pid for pid, proc in pending.items() if is_idle(proc)]
        time.sleep(IDLE_SAMPLE_SECONDS)
        for pid in idle_now:
            if is_idle(pending[pid]):
                del pending[pid]
    return set(pending)


def stop(pid):
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + EXIT_WAIT_SECONDS
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.5)
    return False


def relaunch_terminal(proc):
    model = re.search(r"--model[ =](\S+)", proc["argv"])
    parts = ["agy"] + ([f"--model {model.group(1)}"] if model else [])
    parts += [f"--conversation {proc['conversation']}"] if proc["conversation"] else []
    script = f'''tell application "Terminal"
  repeat with w in windows
    repeat with t in (tabs of w)
      if (get tty of t) is "{proc['tty']}" then
        do script {json.dumps(" ".join(parts))} in t
        return "ok"
      end if
    end repeat
  end repeat
  return "missing"
end tell'''
    try:
        return sh(["/usr/bin/osascript", "-e", script]).stdout.strip() == "ok"
    except subprocess.TimeoutExpired:
        # Terminal 卡住时只记为该标签失败，不能中断其余恢复
        return False


def orca_launcher(project):
    """项目登记在 SP 档案下用 orca-sp，否则用 orca-team；哈希规则与 orca-team 的 platform.mjs 一致。"""
    digest = hashlib.sha256(project.encode()).hexdigest()[:16]
    for registry, name in ((ORCA_TEAM_HOME / "profiles/sp/projects", "orca-sp"), (ORCA_TEAM_HOME / "projects", "orca-team")):
        if (registry / digest).is_dir() and (ORCA_TEAM_HOME / "bin" / name).exists():
            return ORCA_TEAM_HOME / "bin" / name
    return None


def recover_orca(project):
    launcher = orca_launcher(project)
    if not launcher:
        log(f"{project} 没有登记在 {ORCA_TEAM_HOME} 的任何 Orca 档案下")
        return False
    try:
        result = sh([str(launcher), "start", "--no-pick", "--no-repair", "--project", project], ORCA_START_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        log(f"{launcher.name} start --project {project} 超时")
        return False
    tail = "\n".join(line for line in result.stdout.splitlines() if "Warning" not in line)[-600:]
    log(f"{launcher.name} start --project {project} 退出码 {result.returncode}\n{tail}")
    return result.returncode == 0


def verify(since, expected_count):
    """等新进程启动并登录，返回启动时间晚于 since 的进程。"""
    deadline = time.time() + VERIFY_WAIT_SECONDS
    while True:
        fresh = [p for p in agy_processes() if p["start"] >= since]
        if (len(fresh) >= expected_count and all(p["email"] for p in fresh)) or time.time() >= deadline:
            return fresh
        time.sleep(5)


def run(args):
    expected, stamp = account()
    state = load_state()
    failed = state.get("failed") or {}
    if not args.force and state.get("email") == expected:
        return 0
    if not args.force and failed.get("email") == expected and failed.get("stamp") == stamp:
        # 同一次切号已经失败过：不再每 5 分钟重复杀进程，等用户在 Cockpit 里重新切换
        return 0
    log(f"目标账号 {mask(expected)}（上次 {mask(state.get('email'))}）")
    procs = agy_processes()
    if args.pids:
        wanted = {int(p) for p in args.pids.split(",")}
        procs = [p for p in procs if p["pid"] in wanted]
    for proc in procs:
        log(f"pid {proc['pid']} host={proc['host']} tty={proc['tty']} cwd={proc['cwd']} "
            f"账号={mask(proc['email'])} 会话={proc['conversation'] or '-'}")
    if args.dry_run:
        return 0

    # 上次切到同一账号失败（旧进程把旧账号写回了钥匙串），这次不再等空闲，立即重启
    retry = failed.get("email") == expected
    busy = set() if retry else wait_idle(procs)
    log("上次切到该账号失败，跳过空闲等待" if retry else f"空闲等待结束，仍忙：{sorted(busy) or '无'}")

    since = datetime.now().replace(microsecond=0)
    problems = [f"pid {p['pid']} 未能退出" for p in procs if not stop(p["pid"])]
    time.sleep(2)
    relaunched = 0
    # 先恢复 Orca 座位：它们承载编排任务，不能被 Terminal 标签的故障拖住
    for project in sorted({p["cwd"] for p in procs if p["host"] == "orca"}):
        if not recover_orca(project):
            problems.append(f"Orca 座位恢复失败：{project}")
        relaunched += sum(1 for p in procs if p["host"] == "orca" and p["cwd"] == project)
    for proc in procs:
        if proc["host"] == "terminal" and relaunch_terminal(proc):
            relaunched += 1
        elif proc["host"] != "orca":
            resume = f"agy --conversation {proc['conversation']}" if proc["conversation"] else "agy"
            problems.append(f"{proc['tty']}（{proc['host']}）未能自动重开，请在 {proc['cwd']} 运行 {resume}")

    fresh = verify(since, relaunched)
    wrong = [p for p in fresh if p["email"] != expected]
    if len(fresh) < relaunched:
        problems.append(f"应重开 {relaunched} 个，实际只起来 {len(fresh)} 个")
    problems += [f"pid {p['pid']} 登录为 {mask(p['email'])}" for p in wrong]
    for proc in fresh:
        log(f"新 pid {proc['pid']} host={proc['host']} 账号={mask(proc['email'])}")
    if problems:
        log("未完全成功：" + "；".join(problems))
        notify("agy 切号未完全成功", "；".join(problems)[:200])
        if wrong and not args.pids:
            # 钥匙串已被写回旧账号；记下这次失败，避免定时检查反复重启
            save_state(state.get("email"), {"email": expected, "stamp": stamp})
            notify("agy 仍是旧账号", "请在 Cockpit 里再切换一次目标账号")
        return 1
    if not args.pids:
        save_state(expected)
    log(f"完成：{len(fresh)} 个 agy 进程已切到 {mask(expected)}")
    notify("agy 已切换账号", f"{len(fresh)} 个进程已改用 {mask(expected)}")
    return 0


def launchctl(*args):
    return sh(["/bin/launchctl", *args])


def install():
    domain = f"gui/{os.getuid()}"
    # LaunchAgent 不继承登录 shell 的 PATH；把安装时能找到的 node/orca 目录写进去
    dirs = [str(Path(found).parent) for found in (shutil.which("node"), shutil.which("orca")) if found]
    orca_app = Path("/Applications/Orca.app/Contents/Resources/bin")
    dirs += [str(orca_app)] if orca_app.is_dir() else []
    env = {"PATH": ":".join(dict.fromkeys(dirs + SYSTEM_PATH.split(":")))}
    for name in ("COCKPIT_ACCOUNT_FILE", "AGY_LOG_DIR", "ORCA_TEAM_HOME", "AGY_ACCOUNT_SYNC_HOME"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    for label in (*LEGACY_LABELS, LABEL):
        launchctl("bootout", f"{domain}/{label}")
    for label in LEGACY_LABELS:
        legacy = PLIST.with_name(f"{label}.plist")
        if legacy.exists():
            legacy.rename(STATE_DIR / f"{label}.plist.bak")
            log(f"旧 LaunchAgent 已停用，备份到 {STATE_DIR / (label + '.plist.bak')}")
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plistlib.dumps({
        "Label": LABEL,
        # 优先用系统入口 /usr/bin/python3：sys.executable 可能是随 CLT 升级而变的真实路径
        "ProgramArguments": [shutil.which("python3", path="/usr/bin") or sys.executable, str(Path(__file__).resolve())],
        "WatchPaths": [str(ACCOUNT_FILE)],
        "StartInterval": CHECK_INTERVAL_SECONDS,
        "EnvironmentVariables": env,
        "StandardOutPath": str(LOG_FILE),
        "StandardErrorPath": str(LOG_FILE),
        "WorkingDirectory": str(HOME),
    }))
    if not load_state() and ACCOUNT_FILE.exists():
        save_state(account()[0])
        log(f"已记录基线账号 {mask(account()[0])}")
    result = launchctl("bootstrap", domain, str(PLIST))
    if result.returncode != 0:
        log(f"launchctl bootstrap 失败：{result.stderr.strip()}")
        return 1
    log(f"已安装 {PLIST}，PATH={env['PATH']}")
    return 0


def uninstall():
    launchctl("bootout", f"gui/{os.getuid()}/{LABEL}")
    if PLIST.exists():
        PLIST.unlink()
    log(f"已卸载 {LABEL}；状态与日志保留在 {STATE_DIR}")
    return 0


def status():
    loaded = launchctl("print", f"gui/{os.getuid()}/{LABEL}").returncode == 0
    print(f"LaunchAgent {LABEL}：{'已加载' if loaded else '未加载'}（{PLIST}）")
    if ACCOUNT_FILE.exists():
        print(f"Cockpit 目标账号：{mask(account()[0])}；已同步账号：{mask(load_state().get('email'))}")
    for proc in agy_processes():
        print(f"pid {proc['pid']} host={proc['host']} 账号={mask(proc['email'])} cwd={proc['cwd']}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Cockpit 切号后重启 agy 进程")
    group = parser.add_mutually_exclusive_group()
    for flag in ("--install", "--uninstall", "--status"):
        group.add_argument(flag, action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pids")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("agy_account_sync 目前只支持 macOS（依赖 launchd、osascript 和钥匙串）", file=sys.stderr)
        return 2
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if args.install or args.uninstall or args.status:
        return install() if args.install else uninstall() if args.uninstall else status()
    with open(LOCK_FILE, "w") as lock:
        # 同一时刻只跑一份；Cockpit 切号可能连续写几次文件
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not args.dry_run:
            time.sleep(DEBOUNCE_SECONDS)
        return run(args)


if __name__ == "__main__":
    sys.exit(main())
