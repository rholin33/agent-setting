"""Focused stdlib tests; upstream loopback stand-in is injected only in tests.

Run from this directory: python3 -m unittest -v test_collab_tunnel
No private token or full native Collab link is used by these tests.
"""
import asyncio
import contextlib
import os
import tempfile
import unittest
from unittest.mock import patch

import collab_tunnel as transport

TOKEN = "test-only-private-tunnel-bearer-0123456789"
BASE = {"bind": "127.0.0.1", "port": 0, "remote_host": "100.64.0.10", "remote_port": 18781, "token": TOKEN}
UPGRADE = (b"GET /r/native_omp_room_123?role=host HTTP/1.1\r\n"
           b"Host: 127.0.0.1:18780\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
           b"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n")
RESPONSE = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"


class ConfigTests(unittest.TestCase):
    def test_no_public_or_arbitrary_forwarding(self):
        for bind in ["0.0.0.0", "::1", "127.0.0.2", "100.64.0.10"]:
            with self.assertRaises(ValueError):
                transport.validate_config({**BASE, "bind": bind})
        for host in ["127.0.0.1", "localhost", "8.8.8.8", "100.128.0.1", "example.com"]:
            with self.assertRaises(ValueError):
                transport.validate_config({**BASE, "remote_host": host})
        for token in ["short", TOKEN + "\r\nInjected: yes"]:
            with self.assertRaises(ValueError):
                transport.validate_config({**BASE, "token": token})

    def test_config_requires_private_owned_regular_file(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "config.json")
            with open(path, "w") as handle:
                json.dump(BASE, handle)
            os.chmod(path, 0o600)
            self.assertEqual(transport.read_config(path).token, TOKEN)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                transport.read_config(path)
            os.chmod(path, 0o600)
            link = os.path.join(directory, "linked.json")
            os.symlink(path, link)
            with self.assertRaises(OSError):
                transport.read_config(link)

    def test_replaces_all_authorization_without_changing_target(self):
        source = UPGRADE + b"Authorization: old\r\naUtHoRiZaTiOn: another\r\n\r\n"
        result = transport.upgrade_header(source, TOKEN)
        self.assertTrue(result.startswith(UPGRADE))
        self.assertEqual(result.lower().count(b"authorization:"), 1)
        self.assertIn(b"Authorization: Bearer " + TOKEN.encode(), result)
        self.assertNotIn(b"another", result)

    def test_rejects_non_native_targets_and_header_smuggling(self):
        for source in [
            UPGRADE.replace(b"GET /r/native_omp_room_123?role=host", b"CONNECT example.com:443"),
            UPGRADE.replace(b"/r/native_omp_room_123?role=host", b"/r/native_omp_room_123.secret?role=host"),
            UPGRADE + b" folded: value\r\n",
            UPGRADE + b"Content-Length: 1\r\n",
            UPGRADE + b"Transfer-Encoding: chunked\r\n",
            UPGRADE + b"Host: second\r\n",
            UPGRADE + b"X-Bad: hello\x00world\r\n",
        ]:
            with self.assertRaises(ValueError):
                transport.upgrade_header(source + b"\r\n", TOKEN)


class TunnelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.upstream_headers = asyncio.Queue()
        self.upstream_closed = asyncio.Queue()
        self.upstream_writers = set()
        self.upstream_tasks = set()
        self.original_connect = asyncio.open_connection
        self.upstream = await asyncio.start_server(self.accept_upstream, "127.0.0.1", 0)
        upstream_port = self.upstream.sockets[0].getsockname()[1]
        self.config = transport.validate_config({**BASE, "remote_port": upstream_port})

        async def connect_upstream(host, port, **kwargs):
            self.assertEqual((host, port), (self.config.remote_host, self.config.remote_port))
            return await self.original_connect("127.0.0.1", upstream_port, **kwargs)

        self.redirect = patch("collab_tunnel.asyncio.open_connection", side_effect=connect_upstream)
        self.redirect.start()
        self.tunnel = await transport.Tunnel(self.config).start()
        self.port = self.tunnel.server.sockets[0].getsockname()[1]
        self.clients = []

    def accept_upstream(self, reader, writer):
        self.upstream_writers.add(writer)
        task = asyncio.create_task(self.serve_upstream(reader, writer))
        self.upstream_tasks.add(task)
        task.add_done_callback(self.upstream_tasks.discard)

    async def serve_upstream(self, reader, writer):
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            await self.upstream_headers.put(header)
            writer.write(RESPONSE)
            await writer.drain()
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
        except (OSError, asyncio.IncompleteReadError):
            pass
        finally:
            self.upstream_writers.discard(writer)
            await transport.close_writer(writer)
            await self.upstream_closed.put(True)

    async def asyncTearDown(self):
        for writer in self.clients:
            await transport.close_writer(writer)
        await self.tunnel.close()
        self.upstream.close()
        await self.upstream.wait_closed()
        for writer in list(self.upstream_writers):
            await transport.close_writer(writer)
        if self.upstream_tasks:
            await asyncio.gather(*list(self.upstream_tasks), return_exceptions=True)
        self.redirect.stop()

    async def connect(self, upgrade=True):
        reader, writer = await self.original_connect("127.0.0.1", self.port)
        self.clients.append(writer)
        if upgrade:
            writer.write(UPGRADE + b"Authorization: discard\r\n\r\n")
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2), RESPONSE)
        return reader, writer

    async def test_injects_bearer_and_preserves_full_duplex_bytes(self):
        reader, writer = await self.connect()
        header = await asyncio.wait_for(self.upstream_headers.get(), 2)
        self.assertEqual(header, UPGRADE + b"Authorization: Bearer " + TOKEN.encode() + b"\r\n\r\n")
        payload = bytes(range(256)) * 1024
        writer.write(payload)
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(len(payload)), 2), payload)
        upstream_writer = next(iter(self.upstream_writers))
        upstream_writer.write(b"unsolicited upstream bytes")
        await upstream_writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(26), 2), b"unsolicited upstream bytes")

    async def test_pipelined_websocket_bytes_are_not_lost(self):
        reader, writer = await self.connect(upgrade=False)
        writer.write(UPGRADE + b"\r\n" + b"\x82\x03abc")
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2), RESPONSE)
        self.assertEqual(await asyncio.wait_for(reader.readexactly(5), 2), b"\x82\x03abc")

    async def test_client_disconnect_closes_upstream_and_handlers(self):
        _, writer = await self.connect()
        await transport.close_writer(writer)
        await asyncio.wait_for(self.upstream_closed.get(), 2)
        await asyncio.wait_for(asyncio.gather(*list(self.tunnel.tasks)), 2)

    async def test_upstream_disconnect_closes_client(self):
        reader, _ = await self.connect()
        await transport.close_writer(next(iter(self.upstream_writers)))
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
        await asyncio.wait_for(asyncio.gather(*list(self.tunnel.tasks)), 2)

    async def test_shutdown_closes_established_and_partial_headers(self):
        established, _ = await self.connect()
        partial, writer = await self.connect(upgrade=False)
        writer.write(b"GET /r/")
        await writer.drain()
        await self.tunnel.close()
        self.assertEqual(await asyncio.wait_for(established.read(), 2), b"")
        with contextlib.suppress(ConnectionResetError):
            self.assertEqual(await asyncio.wait_for(partial.read(), 2), b"")

    async def test_oversized_header_is_rejected_without_upstream(self):
        reader, writer = await self.connect(upgrade=False)
        writer.write(UPGRADE + b"X-Large: " + b"x" * transport.HEADER_LIMIT + b"\r\n\r\n")
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), 2)
        self.assertTrue(response.startswith(b"HTTP/1.1 502"))
        self.assertTrue(self.upstream_headers.empty())

    async def test_header_timeout_closes_connection_without_upstream(self):
        with patch("collab_tunnel.read_header", side_effect=asyncio.TimeoutError):
            reader, _ = await self.connect(upgrade=False)
            self.assertTrue((await asyncio.wait_for(reader.read(), 2)).startswith(b"HTTP/1.1 502"))
        self.assertTrue(self.upstream_headers.empty())


if __name__ == "__main__":
    unittest.main()
