import io
import json
from pathlib import Path
import tempfile
import unittest

from mcp_cache_proxy import POLL_SECONDS, Proxy, RoleCursors, new_lines, serve


class FakeUpstream:
    """按调用顺序回放终端快照；最后一帧之后保持不变。"""

    def __init__(self, frames):
        self.frames, self.reads, self.forwarded = list(frames), 0, []

    def call(self, name, arguments):
        if name != "read_role":
            self.forwarded.append((name, arguments))
            return {"content": [{"type": "text", "text": "{}"}]}
        frame = self.frames[min(self.reads, len(self.frames) - 1)]
        self.reads += 1
        payload = {"terminal": {"handle": arguments["handle"], "status": "running", "tail": frame}}
        return {"content": [{"type": "text", "text": json.dumps(payload)}]}

    def rpc(self, method, params=None):
        return {"tools": [{"name": "read_role", "description": "x", "inputSchema": {"type": "object", "properties": {"handle": {}}}},
                          {"name": "read_file", "description": "y", "inputSchema": {"type": "object", "properties": {}}}]}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class CacheProxy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "orca-remote" / "proj" / ".orca-mcp-cache" / "master"

    def tearDown(self):
        self.temp.cleanup()

    def proxy(self, frames):
        clock = FakeClock()
        return Proxy(FakeUpstream(frames), RoleCursors(self.state), clock=clock, sleep=clock.sleep), clock

    def test_delta_only_returns_new_lines(self):
        self.assertEqual(new_lines(["a", "b", "spin 1"], ["a", "b", "c", "", "spin 2"]), ["c", "spin 2"])

    def test_read_role_returns_delta_and_cursor_survives_restart(self):
        proxy, _ = self.proxy([["boot", "ready"], ["boot", "ready", "task done"]])
        self.assertEqual(proxy.read_role({"handle": "t1"})["mode"], "first_read")
        second = proxy.read_role({"handle": "t1"})
        self.assertEqual(second["new_lines"], ["task done"])
        # 新代理进程从持久化目录恢复游标
        restarted = Proxy(FakeUpstream([["boot", "ready", "task done"]]), RoleCursors(self.state))
        self.assertTrue(restarted.read_role({"handle": "t1"})["unchanged"])
        self.assertEqual(oct((self.state / "role-cursors.json").stat().st_mode & 0o777), "0o600")

    def test_full_read_returns_whole_screen(self):
        proxy, _ = self.proxy([["a", "b"]])
        proxy.read_role({"handle": "t1"})
        self.assertEqual(proxy.read_role({"handle": "t1", "full": True})["lines"], ["a", "b"])

    def test_wait_idle_requires_change_then_stability(self):
        frames = [["idle"], ["idle"], ["work 1"], ["work 2"], ["result"], ["result"], ["result"], ["result"], ["result"]]
        proxy, clock = self.proxy(frames)
        proxy.read_role({"handle": "t1"})
        report = proxy.wait_role({"handle": "t1", "stable_seconds": 3 * POLL_SECONDS})
        self.assertEqual(report["outcome"], "idle")
        self.assertIn("result", report["new_lines"])
        self.assertEqual(clock.now, 6 * POLL_SECONDS)

    def test_wait_times_out_when_target_never_changes(self):
        proxy, _ = self.proxy([["idle"]])
        proxy.read_role({"handle": "t1"})
        report = proxy.wait_role({"handle": "t1", "timeout_seconds": 30})
        self.assertEqual((report["outcome"], report["unchanged"]), ("timeout", True))

    def test_wait_marker_ignores_already_seen_output(self):
        proxy, _ = self.proxy([["DONE old"], ["DONE old"], ["DONE old", "working"], ["DONE old", "working", "DONE new"]])
        proxy.read_role({"handle": "t1"})
        report = proxy.wait_role({"handle": "t1", "until": "marker", "marker": "DONE"})
        self.assertEqual((report["outcome"], report["new_lines"]), ("marker", ["working", "DONE new"]))

    def test_stdio_lists_wait_role_and_forwards_other_tools(self):
        proxy, _ = self.proxy([["x"]])
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_file", "arguments": {"path": "a"}}},
                    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "wait_role", "arguments": {"handle": "t1", "until": "marker"}}}]
        out = io.StringIO()
        serve(proxy, io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n"), out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2, 3, 4])
        self.assertIn("wait_role", [t["name"] for t in replies[1]["result"]["tools"]])
        self.assertEqual(proxy.upstream.forwarded, [("read_file", {"path": "a"})])
        self.assertTrue(replies[3]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
