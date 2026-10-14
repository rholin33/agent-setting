#!/usr/bin/env python3
"""Loopback-only native OMP upgrade tunnel; the relay bearer never enters links.

Run: python3 collab_tunnel.py --config /private/tunnel.json (owner mode 0600).
Both machines must configure the same loopback port. Only the HTTP Upgrade
Authorization header changes; WebSocket bytes (including E2E payloads) do not.
"""
import argparse
import asyncio
import contextlib
import ipaddress
import json
import os
import re
import signal
import stat
import sys
from dataclasses import dataclass

HEADER_LIMIT = 16384
HEADER_TIMEOUT = 10
WRITE_TIMEOUT = 30
MAX_CONNECTIONS = 128
CHUNK_SIZE = 65536
TAILNET = ipaddress.IPv4Network("100.64.0.0/10")
REQUEST = re.compile(rb"GET /r/[A-Za-z0-9_-]{10,64}\?role=(?:host|guest) HTTP/1\.1")
HEADER_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


@dataclass(frozen=True)
class TunnelConfig:
    bind: str
    port: int
    remote_host: str
    remote_port: int
    token: str


def validate_config(value):
    if not isinstance(value, dict):
        raise ValueError("invalid tunnel configuration")
    try:
        c = TunnelConfig(**value)
        remote = ipaddress.IPv4Address(c.remote_host)
    except (TypeError, ValueError):
        raise ValueError("invalid tunnel configuration") from None
    if (c.bind != "127.0.0.1" or remote not in TAILNET
            or type(c.port) is not int or not 0 <= c.port <= 65535
            or type(c.remote_port) is not int or not 1 <= c.remote_port <= 65535
            or not isinstance(c.token, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{32,256}", c.token) is None):
        raise ValueError("invalid tunnel configuration")
    return c


def read_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or info.st_size > HEADER_LIMIT):
            raise ValueError("configuration must be a private owner-owned file")
        return validate_config(json.load(handle))


async def read_header(reader):
    header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT)
    if len(header) > HEADER_LIMIT:
        raise ValueError("header too large")
    return header


def upgrade_header(header, token):
    """Accept only native Collab upgrades, removing every supplied bearer."""
    lines = header[:-4].split(b"\r\n")
    if not REQUEST.fullmatch(lines[0]):
        raise ValueError("invalid upgrade")
    headers = []
    values = {}
    for line in lines[1:]:
        name, separator, value = line.partition(b":")
        if (not separator or not HEADER_NAME.fullmatch(name)
                or any(byte < 32 and byte != 9 or byte == 127 for byte in value)):
            raise ValueError("invalid header")
        lower = name.lower()
        value = value.strip()
        if lower == b"authorization":
            continue
        if lower in values:
            raise ValueError("duplicate header")
        values[lower] = value
        headers.append(name + b": " + value)
    if (values.get(b"upgrade", b"").lower() != b"websocket"
            or b"upgrade" not in [part.strip().lower() for part in values.get(b"connection", b"").split(b",")]
            or values.get(b"sec-websocket-version") != b"13"
            or b"sec-websocket-key" not in values or b"host" not in values
            or b"content-length" in values or b"transfer-encoding" in values):
        raise ValueError("invalid upgrade")
    headers.append(b"Authorization: Bearer " + token.encode("ascii"))
    return b"\r\n".join([lines[0], *headers, b"", b""])


async def close_writer(writer):
    if writer is not None:
        writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.wait_closed(), 2)


async def copy_stream(reader, writer):
    while True:
        data = await reader.read(CHUNK_SIZE)
        if not data:
            return
        writer.write(data)
        await asyncio.wait_for(writer.drain(), WRITE_TIMEOUT)


class Tunnel:
    def __init__(self, config):
        self.config = validate_config(vars(config))
        self.server = None
        self.tasks = set()
        self.writers = set()
        self.stopping = False

    async def start(self):
        self.server = await asyncio.start_server(
            self.accept, self.config.bind, self.config.port,
            limit=HEADER_LIMIT, backlog=MAX_CONNECTIONS)
        return self

    def accept(self, reader, writer):
        peer = writer.get_extra_info("peername")
        if self.stopping or not peer or peer[0] != "127.0.0.1" or len(self.tasks) >= MAX_CONNECTIONS:
            writer.close()
            return
        self.writers.add(writer)
        task = asyncio.create_task(self.handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        task.add_done_callback(lambda _: self.writers.discard(writer))

    async def handle(self, reader, writer):
        upstream = None
        pumps = []
        upgraded = False
        try:
            header = upgrade_header(await read_header(reader), self.config.token)
            remote_reader, upstream = await asyncio.wait_for(
                asyncio.open_connection(self.config.remote_host, self.config.remote_port, limit=HEADER_LIMIT),
                HEADER_TIMEOUT)
            upstream.write(header)
            await asyncio.wait_for(upstream.drain(), WRITE_TIMEOUT)
            response = await read_header(remote_reader)
            if not response.split(b"\r\n", 1)[0].startswith(b"HTTP/1.1 101 "):
                raise ValueError("upstream rejected upgrade")
            writer.write(response)
            await asyncio.wait_for(writer.drain(), WRITE_TIMEOUT)
            upgraded = True
            pumps = [asyncio.create_task(copy_stream(reader, upstream)),
                     asyncio.create_task(copy_stream(remote_reader, writer))]
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            if not upgraded:
                with contextlib.suppress(Exception):
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    await asyncio.wait_for(writer.drain(), 2)
        finally:
            for task in pumps:
                task.cancel()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
            await asyncio.gather(close_writer(upstream), close_writer(writer))

    async def close(self):
        self.stopping = True
        if self.server:
            self.server.close()
        writers = list(self.writers)
        for writer in writers:
            writer.close()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(close_writer(writer) for writer in writers))
        if self.server:
            await self.server.wait_closed()


async def run(config):
    tunnel = await Tunnel(config).start()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    print("private collab tunnel ready", flush=True)
    try:
        await stopped.wait()
    finally:
        await tunnel.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(read_config(args.config)))
    except (Exception, KeyboardInterrupt):
        print("private collab tunnel failed; check private configuration and Tailscale connectivity", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
