#!/usr/bin/env python3
"""Claude 侧的 worktree MCP 缓存代理（stdio）。

远端 Claude 原本直连本地 bridge.py 的 HTTP MCP，read_role 每次返回整屏终端快照，
master 反复轮询会让大量重复内容永久留在上下文里。本代理运行在 Claude 所在主机：
- read_role 只返回相对上次读取的新增行，读取游标持久化在调用方项目目录；
- 新增 wait_role，在代理内部轮询直到目标空闲或出现标记，轮询过程不进入模型上下文；
- 其余工具原样转发，权限边界仍由 bridge.py 执行。
"""
import argparse
import difflib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.request

UPSTREAM_TIMEOUT_SECONDS = 60
POLL_SECONDS = 5
DEFAULT_WAIT_SECONDS = 300
MAX_WAIT_SECONDS = 900
DEFAULT_STABLE_SECONDS = 20
FIRST_READ_LINES = 60
MAX_DELTA_LINES = 120
PADDING = re.compile(r" {4,}")

READ_ROLE_DESCRIPTION = (
    "Read a proven agent terminal in this LOCAL worktree. Returns only lines that are new since the last "
    "read_role/wait_role of this handle (cursor persists across sessions). Pass full=true to get the whole "
    "current screen, e.g. after context was compacted.")
WAIT_ROLE_TOOL = {
    "name": "wait_role",
    "description": (
        "Block until an agent terminal in this LOCAL worktree finishes, instead of polling read_role. "
        "until=idle returns once output changed and then stayed unchanged for stable_seconds; until=marker "
        "returns once new output contains marker. Returns only new lines since the last read. Use after "
        "send_role; do not loop read_role."),
    "inputSchema": {"type": "object", "additionalProperties": False, "required": ["handle"], "properties": {
        "handle": {"type": "string"},
        "until": {"type": "string", "enum": ["idle", "marker"]},
        "marker": {"type": "string"},
        "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": MAX_WAIT_SECONDS},
        "stable_seconds": {"type": "integer", "minimum": POLL_SECONDS, "maximum": MAX_WAIT_SECONDS},
    }},
}


def write_private_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(6))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(temp, path)


def new_lines(previous, current):
    """返回 current 中相对 previous 新增或改写的非空行。"""
    matcher = difflib.SequenceMatcher(None, previous, current, autojunk=False)
    added = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in ("insert", "replace"):
            added.extend(line for line in current[j1:j2] if line.strip())
    return added


class Upstream:
    def __init__(self, mcp_config_path):
        server = json.loads(Path(mcp_config_path).read_text())["mcpServers"]["worktree"]
        self.url, self.headers = server["url"], dict(server.get("headers", {}))
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.next_id = 0

    def rpc(self, method, params=None):
        self.next_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}).encode()
        headers = dict(self.headers, **{"Content-Type": "application/json", "Accept": "application/json"})
        req = urllib.request.Request(self.url, data=body, headers=headers)
        with self.opener.open(req, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            reply = json.load(response)
        if "error" in reply:
            raise ValueError(reply["error"].get("message", "Upstream MCP error"))
        return reply["result"]

    def call(self, name, arguments):
        return self.rpc("tools/call", {"name": name, "arguments": arguments})


class RoleCursors:
    """每个终端最近一次交给模型的屏幕快照，持久化在调用方项目目录。"""

    def __init__(self, state_dir):
        self.path = Path(state_dir) / "role-cursors.json"
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {"handles": {}}

    def baseline(self, handle):
        return self.data["handles"].get(handle)

    def advance(self, handle, lines):
        self.data["handles"][handle] = {"lines": lines, "updated": int(time.time())}
        write_private_json(self.path, self.data)


class Proxy:
    def __init__(self, upstream, cursors, clock=time.monotonic, sleep=time.sleep):
        self.upstream, self.cursors, self.clock, self.sleep = upstream, cursors, clock, sleep

    def snapshot(self, handle):
        result = self.upstream.call("read_role", {"handle": handle})
        if result.get("isError"):
            raise ValueError(result["content"][0]["text"])
        terminal = json.loads(result["content"][0]["text"])["terminal"]
        # 终端快照会把多屏行拼成一行并用空格补齐列宽（实测单行约 4000 字符），压缩空白只丢对齐不丢内容
        return terminal.get("status"), [PADDING.sub("  ", line).rstrip() for line in terminal.get("tail") or []]

    def delta_report(self, handle, status, lines, full=False, **extra):
        base = self.cursors.baseline(handle)
        if full or base is None:
            shown = [line for line in lines if line.strip()]
            if not full:
                shown = shown[-FIRST_READ_LINES:]
            report = {"handle": handle, "status": status, "mode": "full" if full else "first_read", "lines": shown}
        else:
            added = new_lines(base["lines"], lines)
            report = {"handle": handle, "status": status, "mode": "delta", "since": base["updated"],
                      "unchanged": not added, "new_lines": added[-MAX_DELTA_LINES:]}
            if len(added) > MAX_DELTA_LINES:
                report["truncated_lines"] = len(added) - MAX_DELTA_LINES
        self.cursors.advance(handle, lines)
        report.update(extra)
        return report

    def read_role(self, args):
        status, lines = self.snapshot(args["handle"])
        return self.delta_report(args["handle"], status, lines, full=bool(args.get("full")))

    def wait_role(self, args):
        handle, until, marker = args["handle"], args.get("until", "idle"), args.get("marker")
        if until == "marker" and not (isinstance(marker, str) and marker):
            raise ValueError("until=marker requires a nonempty marker")
        timeout = min(int(args.get("timeout_seconds", DEFAULT_WAIT_SECONDS)), MAX_WAIT_SECONDS)
        stable = max(int(args.get("stable_seconds", DEFAULT_STABLE_SECONDS)), POLL_SECONDS)
        base = self.cursors.baseline(handle)
        base_lines = base["lines"] if base else []
        started = self.clock()
        status, start_lines = self.snapshot(handle)
        status, lines, last_change, changed = status, start_lines, started, False
        while True:
            if until == "marker" and any(marker in line for line in new_lines(base_lines, lines)):
                return self.delta_report(handle, status, lines, waited=round(self.clock() - started), outcome="marker")
            if until == "idle" and changed and self.clock() - last_change >= stable:
                return self.delta_report(handle, status, lines, waited=round(self.clock() - started), outcome="idle")
            if self.clock() - started >= timeout:
                return self.delta_report(handle, status, lines, waited=round(self.clock() - started), outcome="timeout")
            self.sleep(POLL_SECONDS)
            status, current = self.snapshot(handle)
            if current != lines:
                # 只把相对调用起点的变化计为“开始工作”，避免目标本来就空闲时立即返回
                changed = changed or current != start_lines
                last_change, lines = self.clock(), current

    def tools_list(self):
        tools = self.upstream.rpc("tools/list")["tools"]
        for tool in tools:
            if tool["name"] == "read_role":
                tool["description"] = READ_ROLE_DESCRIPTION
                tool["inputSchema"]["properties"]["full"] = {"type": "boolean"}
        if any(tool["name"] == "read_role" for tool in tools):
            tools.append(WAIT_ROLE_TOOL)
        return {"tools": tools}

    def tools_call(self, name, args):
        if name not in ("read_role", "wait_role"):
            return self.upstream.call(name, args)
        try:
            data = self.read_role(args) if name == "read_role" else self.wait_role(args)
        except (ValueError, KeyError, TypeError) as exc:
            return {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
        return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}

    def handle(self, message):
        method, params = message.get("method"), message.get("params") or {}
        if method == "initialize":
            return {"protocolVersion": params.get("protocolVersion", "2025-03-26"), "capabilities": {"tools": {}},
                    "serverInfo": {"name": "local-worktree-cache-proxy", "version": "1.0.0"}}
        if method == "ping":
            return {}
        if method == "tools/list":
            return self.tools_list()
        if method == "tools/call":
            return self.tools_call(params["name"], params.get("arguments") or {})
        raise LookupError(method)


def serve(proxy, stdin=sys.stdin, stdout=sys.stdout):
    # 串行处理：wait_role 阻塞期间其他调用排队，模型侧本来也会等齐并行结果
    for raw in stdin:
        if not raw.strip():
            continue
        message = json.loads(raw)
        if message.get("id") is None:
            continue
        try:
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": proxy.handle(message)}
        except LookupError:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Method not supported"}}
        except (OSError, ValueError, KeyError) as exc:
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "Upstream failed: " + str(exc)}}
        stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True, help="原 HTTP worktree mcp.json（含 bridge 地址与令牌）")
    parser.add_argument("--state-dir", required=True, help="调用方项目的持久化目录，例如 ~/Code/orca-remote/<项目>/.orca-mcp-cache/<角色>")
    args = parser.parse_args()
    serve(Proxy(Upstream(args.upstream), RoleCursors(args.state_dir)))


if __name__ == "__main__":
    main()
