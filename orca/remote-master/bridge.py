#!/usr/bin/env python3
"""Scoped local MCP tools and a remote Claude Code conversation transport.

Only the named Tailscale peer can authenticate. No arbitrary shell tool exists.
The remote broker runs Claude Code; the local console never runs a model.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 1024 * 1024
TOOLS = [
    ("workspace_info", "Return the exact LOCAL worktree, git branch and role identity.", {}),
    ("list_files", "List tracked, non-sensitive LOCAL project files under a relative prefix.", {"prefix": {"type": "string"}}),
    ("read_file", "Read a tracked non-sensitive LOCAL project file, with SHA256 for optimistic writes.", {"path": {"type": "string"}, "start": {"type": "integer"}, "count": {"type": "integer"}}),
    ("write_document", "Write a LOCAL Markdown coordination document in docs/ or .codex/. expected_sha256 is required; use absent for a new file. No source/config/shell writes.", {"path": {"type": "string"}, "content": {"type": "string"}, "expected_sha256": {"type": "string"}}),
    ("list_roles", "List live Orca terminals in this LOCAL worktree only. Does not start or change roles.", {}),
    ("read_role", "Read a proven agent terminal in this LOCAL worktree. No other workspace access.", {"handle": {"type": "string"}}),
    ("send_role", "Send an explicitly user-authorized task to an existing agent in this LOCAL worktree. Never use for shells or assumed handles.", {"handle": {"type": "string"}, "text": {"type": "string"}}),
]
READ_ONLY_TOOLS = frozenset(("workspace_info", "list_files", "read_file", "list_roles", "read_role"))

CODE_TOOLS = [
    ("write_file", "Create or replace a non-sensitive, non-ignored LOCAL project text file. expected_sha256 is required; use absent only for a new file. Does not delete files or create directories.", {"path": {"type": "string"}, "content": {"type": "string"}, "expected_sha256": {"type": "string"}}),
    ("edit_file", "Replace exactly one literal old_text occurrence in a LOCAL source file, preserving all other bytes. Requires the SHA256 from read_file; stale hashes are rejected.", {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}, "expected_sha256": {"type": "string"}}),
]


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(6))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(temp, path)


def request(url, token=None, data=None, timeout=30):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None if data is None else json.dumps(data).encode()
    if body is not None:
        headers["Content-Type"] = "application/json"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=timeout) as response:
        return json.load(response)


class Workspace:
    def __init__(self, config):
        self.config = config
        self.root = Path(config["root"]).resolve(strict=True)
        self.write_lock = threading.Lock()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], timeout=15)

    def permitted(self, relative):
        p = Path(relative)
        if p.is_absolute() or not p.parts or any(x in ("..", ".git", ".orca", ".ccb", "storage", "node_modules", "deploy") for x in p.parts):
            raise ValueError("Path is outside the permitted project scope")
        for part in p.parts:
            low = part.lower()
            if low in (".npmrc", ".yarnrc", ".netrc", "auth.json") or low.startswith((".env", "docker-compose")) or any(x in low for x in ("credential", "private-key", "id_rsa", "id_ed25519")) or low.endswith((".pem", ".key", ".p12", ".pfx")):
                raise ValueError("Sensitive path denied")
        current = self.root
        for part in p.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Symbolic links are not exposed")
        if not current.resolve().is_relative_to(self.root):
            raise ValueError("Path escapes workspace")
        return current

    def tracked(self):
        args = ["ls-files", "-z", "--cached"]
        if self.config.get("code_write_enabled") or self.config.get("read_untracked"):
            args += ["--others", "--exclude-standard"]
        names = self.git(*args).decode().split("\0")
        allowed = []
        for name in names:
            if not name:
                continue
            try:
                self.permitted(name)
                allowed.append(name)
            except ValueError:
                pass
        return allowed

    def orca(self, args):
        env = {k: v for k, v in os.environ.items() if k not in ("ORCA_PAIRING_CODE", "ORCA_ENVIRONMENT")}
        proc = subprocess.run([self.config["orca"], *args, "--json"], cwd=self.root, env=env,
                              capture_output=True, text=True, encoding="utf-8", timeout=40)
        result = json.loads(proc.stdout)
        if not result.get("ok"):
            raise ValueError("Local Orca operation failed; inspect locally")
        return result["result"]

    def roles(self):
        data = self.orca(["terminal", "list", "--worktree", "path:" + str(self.root)])
        if data.get("truncated") is not False:
            raise ValueError("Incomplete terminal inventory")
        return [t for t in data["terminals"] if t.get("worktreePath") and
                Path(t["worktreePath"]).resolve() == self.root]

    def tool(self, name, a):
        if self.config.get("read_only") and name not in READ_ONLY_TOOLS:
            raise ValueError("This bridge is read-only; writes and task dispatch are forbidden")
        if name == "workspace_info":
            code = bool(self.config.get("code_write_enabled"))
            return {"root": str(self.root), "branch": self.git("branch", "--show-current").decode().strip(),
                    "head": self.git("rev-parse", "HEAD").decode().strip(), "role": self.config.get("role", "master-remote"),
                    "execution": "Remote model; these tools operate only on the local worktree",
                    "write_scope": "Read-only; no writes or task dispatch" if self.config.get("read_only") else
                    ("Non-sensitive, non-ignored project source/text files; hash-checked writes" if code else
                     "Markdown coordination documents under " + ", ".join(self.config.get("document_roots", ["docs", ".codex"]))), "arbitrary_shell": False}
        if name == "list_files":
            prefix = a.get("prefix", "")
            if not isinstance(prefix, str):
                raise ValueError("prefix must be a string")
            files = [p for p in self.tracked() if p.startswith(prefix)]
            return {"files": files[:600], "truncated": len(files) > 600}
        if name == "read_file":
            relative = a["path"]
            path = self.permitted(relative)
            if relative not in self.tracked():
                raise ValueError("Only tracked project files can be read")
            if path.stat().st_size > MAX_BODY:
                raise ValueError("File exceeds read limit")
            raw = path.read_bytes()
            lines = raw.decode("utf-8").splitlines()
            start, count = a.get("start", 1), a.get("count", 120)
            if type(start) is not int or type(count) is not int or start < 1 or not 1 <= count <= 300:
                raise ValueError("Invalid line range")
            return {"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "total_lines": len(lines),
                    "content": "\n".join(f"{i + 1}: {lines[i]}" for i in range(start - 1, min(len(lines), start - 1 + count)))}
        if name in ("write_document", "write_file", "edit_file"):
            code_tool = name != "write_document"
            if code_tool and not self.config.get("code_write_enabled"):
                raise ValueError("Source editing is not authorized on this bridge")
            path = self.permitted(a["path"])
            rel = Path(a["path"])
            document_roots = set(self.config.get("document_roots", ["docs", ".codex"])) & {"docs", ".codex", "todo_list", "undo_list"}
            if not code_tool and (rel.parts[0] not in document_roots or path.suffix != ".md"):
                raise ValueError("Only Markdown coordination documents may be written")
            if code_tool:
                if rel.parts[0] in (".github", ".gitlab", ".husky") or path.name in (".npmrc", ".yarnrc", ".netrc", "AGENTS.md", "CLAUDE.md"):
                    raise ValueError("Credential, CI and agent-policy files require separate authorization")
                ignored = subprocess.run(["git", "-C", str(self.root), "check-ignore", "--no-index", "-q", "--", str(rel)], timeout=15)
                if ignored.returncode != 1:
                    raise ValueError("Ignored or unverifiable paths are not writable")
            if not path.parent.is_dir():
                raise ValueError("Parent must already exist")
            with self.write_lock:
                if path.exists() and (not path.is_file() or path.stat().st_nlink != 1 or path.stat().st_size > MAX_BODY):
                    raise ValueError("Only bounded, single-link regular files may be written")
                raw = path.read_bytes() if path.exists() else None
                before = hashlib.sha256(raw).hexdigest() if raw is not None else "absent"
                if not hmac.compare_digest(before, a["expected_sha256"]):
                    raise ValueError("Document changed; reread before writing")
                if name == "edit_file":
                    old, new = a["old_text"], a["new_text"]
                    if raw is None or not isinstance(old, str) or not old or not isinstance(new, str):
                        raise ValueError("An existing text file and nonempty old_text are required")
                    text = raw.decode("utf-8")
                    if text.count(old) != 1:
                        raise ValueError("old_text must match exactly once; reread before editing")
                    content = text.replace(old, new, 1)
                else:
                    content = a["content"]
                if not isinstance(content, str) or len(content.encode("utf-8")) > 512 * 1024 or "\0" in content:
                    raise ValueError("Text file exceeds write limit or contains binary data")
                if raw is not None:
                    raw.decode("utf-8")
                    if b"\0" in raw:
                        raise ValueError("Binary files are not writable")
                self.permitted(a["path"])
                flags = os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
                if raw is None:
                    flags |= os.O_CREAT | os.O_EXCL
                fd = os.open(path, flags, 0o644)
                with os.fdopen(fd, "wb") as f:
                    f.write(content.encode("utf-8"))
                    f.truncate()
            return {"path": a["path"], "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}
        if name == "list_roles":
            return [{k: t.get(k) for k in ("handle", "title", "agentIdentity", "connected", "writable", "worktreePath")} for t in self.roles()]
        if name in ("read_role", "send_role"):
            handle = a["handle"]
            matches = [t for t in self.roles() if t["handle"] == handle and t.get("agentIdentity") in ("omp", "claude", "codex", "pi")]
            if len(matches) != 1 or handle in self.config.get("excluded_handles", []):
                raise ValueError("Target is not a permitted live agent in this worktree")
            if name == "read_role":
                return self.orca(["terminal", "read", "--terminal", handle])
            text = a["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > 16000 or any(ord(c) < 32 and c not in "\n\t" for c in text):
                raise ValueError("Invalid task text")
            return self.orca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"])
        raise ValueError("Unknown or forbidden tool")


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config, mode, config_path):
        self.config, self.mode, self.config_path = config, mode, config_path
        self.workspace = Workspace(config) if mode == "local" else None
        self.turns, self.lock, self.active = {}, threading.Lock(), False
        self.audit = []
        self.bootstrapped = bool(config.get("bootstrapped"))
        super().__init__((config["bind"], config["port"]), Handler)

    def execute(self, turn_id, prompt):
        turn = self.turns[turn_id]
        try:
            c = self.config
            state_path = Path(self.config_path).with_name("session.json")
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
            command = [c["claude"], "--print", "--output-format", "json", "--tools", "",
                       "--strict-mcp-config", "--mcp-config", c["mcp_path"],
                       "--allowedTools", "mcp__worktree__*", "--setting-sources", "user",
                       "--settings", '{"disableAllHooks":true}', "--system-prompt", c["role_prompt"]]
            if state.get("session_id"):
                command += ["--resume", state["session_id"]]
            proc = subprocess.Popen(command, cwd=c["control_dir"], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            turn["pid"] = proc.pid
            try:
                stdout, _stderr = proc.communicate(prompt, timeout=600)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise ValueError("Remote Claude timed out; no automatic retry")
            result = json.loads(stdout)
            if result.get("session_id"):
                private_json(state_path, {"session_id": result["session_id"]})
            turn.update(status="failed" if result.get("is_error") or proc.returncode else "completed",
                        text=result.get("result", "No response text"), duration_ms=result.get("duration_ms"),
                        session_id=result.get("session_id"))
        except Exception as exc:
            turn.update(status="failed", text=str(exc) if isinstance(exc, ValueError) else "Remote execution failed; inspect engine locally")
        finally:
            with self.lock:
                self.active = False
            turn["event"].set()


class Handler(BaseHTTPRequestHandler):
    server_version = "ScopedMasterBridge/1"

    def log_message(self, *_args):
        pass

    def reply(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed(self, bootstrap=False):
        c = self.server.config
        if self.client_address[0] not in (c["peer"], c["bind"]):
            return False
        if self.headers.get("Origin"):
            return False
        if bootstrap:
            return self.client_address[0] == c["peer"] and not self.server.bootstrapped
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + c["token"])

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {"error": "Forbidden"})
        if self.path == "/health":
            return self.reply(200, {"mode": self.server.mode, "ready": True, "active": self.server.active})
        if self.path == "/audit" and self.server.mode == "local":
            return self.reply(200, {"events": self.server.audit[-100:]})
        if self.path.startswith("/turn/") and self.server.mode == "remote":
            turn = self.server.turns.get(self.path[6:])
            if not turn:
                return self.reply(404, {"error": "Unknown request; do not automatically replay"})
            turn["event"].wait(20)
            return self.reply(200, {k: v for k, v in turn.items() if k != "event"})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        bootstrap = self.path == "/bootstrap" and self.server.mode == "local"
        if not self.allowed(bootstrap):
            return self.reply(403, {"error": "Forbidden"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {"error": "Invalid body length"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Expected JSON object")
            if bootstrap:
                with self.server.lock:
                    if self.server.bootstrapped:
                        return self.reply(409, {"error": "Already paired"})
                    self.server.bootstrapped = True
                    self.server.config["bootstrapped"] = True
                    private_json(self.server.config_path, self.server.config)
                c = self.server.config
                return self.reply(200, {"token": c["token"], "role_prompt": c["role_prompt"],
                                       "local_url": f'http://{c["bind"]}:{c["port"]}', "peer": c["bind"]})
            if self.path == "/turn" and self.server.mode == "remote":
                ident, prompt = body.get("id"), body.get("prompt")
                if not isinstance(ident, str) or str(uuid.UUID(ident)) != ident or not isinstance(prompt, str) or not 0 < len(prompt) <= 32000:
                    raise ValueError("Invalid turn")
                with self.server.lock:
                    if ident in self.server.turns:
                        return self.reply(200, {"id": ident, "accepted": True, "replayed": True})
                    if self.server.active:
                        return self.reply(409, {"error": "Claude is busy; do not resend automatically"})
                    self.server.active = True
                    self.server.turns[ident] = {"id": ident, "status": "running", "event": threading.Event()}
                threading.Thread(target=self.server.execute, args=(ident, prompt), daemon=True).start()
                return self.reply(202, {"id": ident, "accepted": True})
            if self.path != "/mcp" or self.server.mode != "local":
                return self.reply(404, {"error": "Not found"})
            ident, method = body.get("id"), body.get("method")
            if ident is None:
                return self.reply(202, {})
            if method == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "local-worktree-master", "version": "1.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                definitions = TOOLS + (CODE_TOOLS if self.server.config.get("code_write_enabled") else [])
                if self.server.config.get("read_only"):
                    definitions = [item for item in definitions if item[0] in READ_ONLY_TOOLS]
                result = {"tools": [{"name": n, "description": d, "inputSchema": {"type": "object", "properties": p, "additionalProperties": False}} for n, d, p in definitions]}
            elif method == "tools/call":
                params = body["params"]
                name = params["name"]
                try:
                    data = self.server.workspace.tool(name, params.get("arguments", {}))
                    result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}
                    ok = True
                except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
                    result = {"isError": True, "content": [{"type": "text", "text": str(exc) if isinstance(exc, ValueError) else "Tool failed; invalid input or unavailable local resource"}]}
                    ok = False
                self.server.audit.append({"time": int(time.time()), "tool": name, "ok": ok})
            else:
                return self.reply(200, {"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": "Method not supported"}})
            self.reply(200, {"jsonrpc": "2.0", "id": ident, "result": result})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "Invalid request"})


def remote_bootstrap(local_url, bind, port):
    import shutil
    cfg = request(local_url + "/bootstrap", data={})
    home = Path.home() / ".orca" / "remote-master-fix-bug"
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    mcp = home / "mcp.json"
    private_json(mcp, {"mcpServers": {"worktree": {"type": "http", "url": local_url + "/mcp",
                  "headers": {"Authorization": "Bearer " + cfg["token"]}}}})
    cfg.update(bind=bind, port=port, claude=shutil.which("claude"), control_dir=str(home), mcp_path=str(mcp))
    if not cfg["claude"]:
        raise SystemExit("Claude Code is unavailable")
    path = home / "engine.json"
    private_json(path, cfg)
    print(f"Remote Claude engine ready on {bind}:{port}; no repository copy", flush=True)
    BridgeServer(cfg, "remote", path).serve_forever()


def converse(config_path):
    cfg = json.loads(Path(config_path).read_text())
    url = cfg["remote_url"]
    request(url + "/health", cfg["token"])
    pending_path = Path(config_path).with_name("pending-turn.json")
    role = cfg.get("role", "master-remote")
    provider = cfg.get("provider_label", "Claude Code")
    print(role + " | " + provider + " on " + cfg["peer"])
    print("Local worktree: " + cfg["root"])
    print(cfg.get("scope_label", "Scoped MCP: project reading, Markdown documents, existing worktree agent messaging. No shell."))
    print("/exit closes this console. /recover retrieves an interrupted turn without re-submitting it.")
    while True:
        try:
            text = input("\n" + role + "> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nConsole closed; engine and tool bridge retained.")
            return
        if text == "/exit":
            return
        if not text:
            continue
        try:
            if text == "/recover":
                ident = json.loads(pending_path.read_text())["id"]
            else:
                if pending_path.exists() and json.loads(pending_path.read_text()).get("pending"):
                    print("Previous request outcome unknown. Use /recover; no duplicate request was sent.")
                    continue
                ident = str(uuid.uuid4())
                private_json(pending_path, {"id": ident, "pending": True})
                request(url + "/turn", cfg["token"], {"id": ident, "prompt": text})
            print("Remote " + provider + " is working…", flush=True)
            while True:
                result = request(url + "/turn/" + ident, cfg["token"], timeout=30)
                if result["status"] != "running":
                    break
            private_json(pending_path, {"id": ident, "pending": False})
            print(result.get("text", "No response"))
            if result["status"] != "completed":
                print("[Remote request failed; no automatic retry]")
        except Exception:
            print("Connection/request result unavailable. Use /recover to inspect the SAME request; no automatic replay.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["local", "remote", "bootstrap", "console"])
    parser.add_argument("--config")
    parser.add_argument("--local-url")
    parser.add_argument("--bind")
    parser.add_argument("--port", type=int, default=18762)
    args = parser.parse_args()
    if args.mode == "bootstrap":
        return remote_bootstrap(args.local_url, args.bind, args.port)
    if args.mode == "console":
        return converse(args.config)
    config = json.loads(Path(args.config).read_text())
    server = BridgeServer(config, args.mode, args.config)
    print(f"{args.mode} bridge ready on {config['bind']}:{config['port']}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
