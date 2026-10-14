#!/usr/bin/env python3
"""Launch the official Codex remote TUI/app-server; no conversation relay."""
import argparse
import json
import os
from pathlib import Path
import select
import socket
import socketserver

from codex_engine import codex_command


class TailnetForwarder(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ForwardConnection(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(self.server.target, timeout=10) as upstream:
                self.request.settimeout(30)
                upstream.settimeout(30)
                peers = {self.request: upstream, upstream: self.request}
                while True:
                    readable, _, _ = select.select(list(peers), [], [])
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        peers[source].sendall(data)
        except OSError:
            pass  # The native client observes connection loss and owns recovery.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('server', 'client', 'tunnel'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--token-sha256')
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    native_port = cfg.get('native_port', 18766)
    tunnel_port = cfg.get('tunnel_port', 18767)
    if any(type(port) is not int or not 1 <= port <= 65535 for port in (native_port, tunnel_port)):
        parser.error('native_port and tunnel_port must be integers from 1 to 65535')
    role = cfg.get('role', 'master-codex-remote')
    if args.mode == 'tunnel':
        # Codex permits bearer auth on loopback WS. The onward hop is encrypted
        # by Tailscale; app-server still authenticates every WebSocket handshake.
        with TailnetForwarder(('127.0.0.1', tunnel_port), ForwardConnection) as server:
            server.target = (cfg['peer'], native_port)
            print(f'Native Codex tailnet tunnel ready on 127.0.0.1:{tunnel_port}', flush=True)
            server.serve_forever()
        return
    if args.mode == 'server':
        # Reuse the exact established MCP/role restrictions, not user credentials.
        if not args.token_sha256 or len(args.token_sha256) != 64:
            parser.error('server requires a SHA256 capability-token digest')
        configured = codex_command(cfg)
        overrides = [configured[i + 1] for i, value in enumerate(configured) if value == '-c']
        command = ['/bin/zsh', '-lic', 'codex "$@"', role, 'app-server']
        for override in overrides:
            command.extend(['-c', override])
        command.extend(['-c', 'approval_policy="on-request"', '--listen',
                        'ws://' + cfg['bind'] + ':' + str(native_port), '--ws-auth', 'capability-token',
                        '--ws-token-sha256', args.token_sha256])
        os.environ['MASTER_WORKTREE_MCP_TOKEN'] = cfg['token']
        for key in ('NO_PROXY', 'no_proxy'):
            os.environ[key] = ','.join(filter(None, (os.environ.get(key, ''), cfg['peer'], cfg['bind'])))
        os.chdir(cfg['control_dir'])
    else:
        os.environ['MASTER_CODEX_REMOTE_TOKEN'] = cfg['token']
        for key in ('NO_PROXY', 'no_proxy'):
            os.environ[key] = ','.join(filter(None, (os.environ.get(key, ''), cfg['peer'], '127.0.0.1', 'localhost')))
        command = ['/bin/zsh', '-lic', 'command codex "$@"', role,
                   '--remote', cfg['url'], '--remote-auth-token-env', 'MASTER_CODEX_REMOTE_TOKEN',
                   '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
                   '--cd', cfg['remote_cwd']]
    os.execv(command[0], command)


if __name__ == '__main__':
    main()
