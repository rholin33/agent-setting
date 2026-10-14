#!/usr/bin/env python3
"""Private, read-only native OMP control plane.

Run: python3 omp_control.py --config /absolute/private/control.json
The mode-0600 config contains bind, port, peer, token, and host_config. Both
addresses are literal Tailscale addresses; host_config is a fixed mode-0600
native host config inside its mode-0700 control_dir. No model keys cross this
service. Every request requires the exact peer and Authorization: Bearer TOKEN;
Origin and transfer-encoded requests are rejected. Request bodies are <=4 KiB.

GET /health -> {role, model, version, control_pid}
GET /snapshot -> native_omp.snapshot's {version, host} envelope
POST /link {instance_id, generation} -> {join_url, instance_id, generation, session}
POST /messages {offset} -> {session, offset, nextOffset, messages:[{role,text}]}
Offsets are byte positions at JSONL line boundaries, not message counts. Only
complete lines advance nextOffset; absent ephemeral files return the actual
pinned session and an empty page. Pages consume <=64 KiB of JSONL and encode to
<=64 KiB. An oversized entry fails explicitly, never truncates or skips text.
Restart the control service only deliberately: one service lifetime pins one
native session and, once available, its exact file identity. Errors contain
only fixed codes. HTTP access/error logs are disabled, including join links.
"""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading

import native_omp as native

MAX_BODY = 4096
MAX_PAGE = 64 * 1024


class ControlError(Exception):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code = code
        self.status = status


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def private_path(path, directory=False):
    path = Path(path)
    try:
        info = path.lstat()
        expected = 0o700 if directory else 0o600
        kind = stat.S_ISDIR if directory else stat.S_ISREG
        if (not path.is_absolute() or path.resolve() != path or
                info.st_uid != os.getuid() or not kind(info.st_mode) or
                stat.S_IMODE(info.st_mode) != expected):
            raise ControlError('invalid_config', 500)
    except OSError:
        raise ControlError('invalid_config', 500) from None
    return path


def tailnet_address(value):
    try:
        address = ipaddress.ip_address(value)
        network = ipaddress.ip_network('100.64.0.0/10' if address.version == 4 else 'fd7a:115c:a1e0::/48')
        if address not in network or str(address) != value:
            raise ValueError()
        return address
    except (ValueError, TypeError):
        raise ControlError('invalid_config', 500) from None


def load_config(path):
    path = private_path(Path(path).absolute())
    private_path(path.parent, directory=True)
    cfg = native.read_private(path)
    if set(cfg) != {'bind', 'port', 'peer', 'token', 'host_config'}:
        raise ControlError('invalid_config', 500)
    bind, peer = tailnet_address(cfg['bind']), tailnet_address(cfg['peer'])
    if bind.version != peer.version or type(cfg['port']) is not int or not 1 <= cfg['port'] <= 65535:
        raise ControlError('invalid_config', 500)
    if not isinstance(cfg['token'], str) or not re.fullmatch(r'[A-Za-z0-9._~+/-]{32,}=*', cfg['token']):
        raise ControlError('invalid_config', 500)
    if not isinstance(cfg['host_config'], str):
        raise ControlError('invalid_config', 500)
    host_path = private_path(cfg['host_config'])
    host = native.host_config(native.read_private(host_path))
    control = private_path(host['control_dir'], directory=True)
    if control not in host_path.parents:
        raise ControlError('invalid_config', 500)
    for parent in host_path.parents:
        private_path(parent, directory=True)
        if parent == control:
            break
    return cfg, host


def authorize(cfg, peer, headers):
    # Never honor forwarded addresses or cookies. Compare the opaque bearer even
    # for a bad peer, without including any request material in diagnostics.
    values = headers.get_all('Authorization', [])
    supplied = values[0] if len(values) == 1 else ''
    matches = hmac.compare_digest(supplied.encode('utf-8'), ('Bearer ' + cfg['token']).encode('utf-8'))
    if peer != cfg['peer'] or not matches or headers.get_all('Origin') is not None:
        raise ControlError('forbidden', 403)


class Control:
    def __init__(self, cfg, host, version):
        self.cfg = cfg
        self.host = host
        self.version = version
        self.lock = threading.Lock()
        self.session = None
        self.session_path = None
        self.file_identity = None

    def snapshot(self):
        result = native.snapshot(self.host)
        row = result.get('host')
        if row is None:
            return result
        session = row.get('sessionId')
        if not isinstance(session, str) or not session:
            raise ControlError('invalid_identity')
        if self.session is not None and self.session != session:
            raise ControlError('session_changed')
        self.session = session
        return result

    def current(self):
        row = self.snapshot()['host']
        if row is None:
            raise ControlError('host_unavailable', 503)
        return row

    @staticmethod
    def same_identity(before, after):
        if any(before.get(key) != after.get(key) for key in ('instanceId', 'generation', 'sessionId')):
            raise ControlError('identity_changed')

    def link(self, body):
        if (set(body) != {'instance_id', 'generation'} or
                not isinstance(body['instance_id'], str) or not body['instance_id'] or
                type(body['generation']) is not int or body['generation'] < 1):
            raise ControlError('invalid_request', 400)
        before = self.current()
        if before['instanceId'] != body['instance_id'] or before['generation'] != body['generation']:
            raise ControlError('stale_identity')
        fd, name = tempfile.mkstemp(prefix='.omp-control-link-', dir=self.host['control_dir'])
        os.close(fd)
        try:
            native.fetch_link(self.host, body['instance_id'], body['generation'], name)
            data = native.read_private(name)
            url = native.validate_join_url(data.get('join_url'), self.host['relay_port'])
            after = self.current()
            self.same_identity(before, after)
            return {'join_url': url, 'instance_id': after['instanceId'],
                    'generation': after['generation'], 'session': after['sessionId']}
        finally:
            os.unlink(name)

    def messages(self, body):
        if (set(body) != {'offset'} or type(body['offset']) is not int or
                not 0 <= body['offset'] <= sys.maxsize):
            raise ControlError('invalid_offset', 400)
        offset = body['offset']
        before = self.current()
        session = before['sessionId']
        page = {'session': session, 'offset': offset, 'nextOffset': offset, 'messages': []}
        path = native.session_file(self.host, session)
        if self.session_path is not None and path != self.session_path:
            raise ControlError('session_changed')
        if path is None:
            if offset:
                raise ControlError('invalid_offset', 400)
            self.same_identity(before, self.current())
            return page
        self.session_path = path
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            identity = (info.st_dev, info.st_ino)
            if not stat.S_ISREG(info.st_mode) or (self.file_identity is not None and identity != self.file_identity):
                raise ControlError('session_changed')
            self.file_identity = identity
            # Recheck the opened descriptor, not merely a path inspected earlier.
            self.check_header(stream, session)
            if offset > info.st_size:
                raise ControlError('invalid_offset', 400)
            if offset:
                stream.seek(offset - 1)
                if stream.read(1) != b'\n':
                    raise ControlError('invalid_offset', 400)
            stream.seek(offset)
            data = stream.read(MAX_PAGE + 1)
            position = 0
            while position < len(data):
                end = data.find(b'\n', position)
                if end == -1 or end + 1 > MAX_PAGE:
                    if position == 0 and len(data) > MAX_PAGE:
                        raise ControlError('entry_too_large', 413)
                    break
                line = data[position:end]
                try:
                    entry = json.loads(line)
                except (ValueError, UnicodeError):
                    raise ControlError('invalid_session_data') from None
                text = assistant_text(entry)
                old_next = page['nextOffset']
                page['nextOffset'] = offset + end + 1
                if text is not None:
                    page['messages'].append({'role': 'assistant', 'text': text})
                    if len(encoded(page)) > MAX_PAGE:
                        page['messages'].pop()
                        page['nextOffset'] = old_next
                        if position == 0:
                            raise ControlError('entry_too_large', 413)
                        break
                position = end + 1
            if os.fstat(stream.fileno()).st_size < info.st_size:
                raise ControlError('session_changed')
        self.same_identity(before, self.current())
        if native.session_file(self.host, session) != path:
            raise ControlError('session_changed')
        current_file = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(current_file.st_mode) or (current_file.st_dev, current_file.st_ino) != identity:
            raise ControlError('session_changed')
        return page

    def check_header(self, stream, session):
        for _ in range(8):
            line = stream.readline(native.MAX_CONFIG_BYTES + 1)
            if not line or len(line) > native.MAX_CONFIG_BYTES:
                break
            try:
                entry = json.loads(line)
            except (ValueError, UnicodeError):
                break
            if isinstance(entry, dict) and entry.get('type') == 'session':
                if entry.get('id') == session and entry.get('cwd') == self.host['control_dir']:
                    return
                break
        raise ControlError('session_changed')

    def dispatch(self, method, path, body):
        with self.lock:
            if method == 'GET' and path == '/health':
                return {'role': self.host['role'], 'model': self.host['model'],
                        'version': self.version, 'control_pid': os.getpid()}
            if method == 'GET' and path == '/snapshot':
                return self.snapshot()
            if method == 'POST' and path == '/link':
                return self.link(body)
            if method == 'POST' and path == '/messages':
                return self.messages(body)
            raise ControlError('not_found', 404)


def assistant_text(entry):
    if not isinstance(entry, dict) or entry.get('type') != 'message':
        return None
    message = entry.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        return None
    content = message.get('content')
    if isinstance(content, str):
        return content or None
    if not isinstance(content, list):
        return None
    text = ''.join(block['text'] for block in content if isinstance(block, dict)
                   and block.get('type') == 'text' and isinstance(block.get('text'), str))
    return text or None


class Handler(BaseHTTPRequestHandler):
    server_version = 'OMPControl'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler otherwise echoes paths/verbs in HTML errors.
        self.respond(code, {'error': 'invalid_http'})

    def respond(self, status, value):
        data = encoded(value)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        if self.command != 'HEAD':
            self.wfile.write(data)

    def parse_request(self):
        if not super().parse_request():
            return False
        try:
            authorize(self.server.control.cfg, self.client_address[0], self.headers)
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get_all('Transfer-Encoding') is not None or len(lengths) > 1:
                raise ControlError('invalid_request', 400)
            if lengths and (not re.fullmatch(r'[0-9]{1,10}', lengths[0]) or int(lengths[0]) > MAX_BODY):
                raise ControlError('body_too_large', 413)
            self.body_length = int(lengths[0]) if lengths else 0
            if self.command == 'GET' and self.body_length:
                raise ControlError('invalid_request', 400)
        except ControlError as error:
            self.respond(error.status, {'error': error.code})
            return False
        return True

    def handle_request(self):
        try:
            body = {}
            if self.command == 'POST':
                raw = self.rfile.read(self.body_length)
                if len(raw) != self.body_length:
                    raise ControlError('invalid_request', 400)
                try:
                    body = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise ControlError('invalid_request', 400) from None
                if not isinstance(body, dict):
                    raise ControlError('invalid_request', 400)
            result = self.server.control.dispatch(self.command, self.path, body)
            self.respond(200, result)
        except ControlError as error:
            self.respond(error.status, {'error': error.code})
        except native.LauncherError:
            self.respond(409, {'error': 'native_state_unavailable'})
        except Exception:
            self.respond(500, {'error': 'control_failure'})

    do_GET = handle_request
    do_POST = handle_request


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Tracebacks may contain bearer headers, capabilities or private paths.
        pass


def native_version(host):
    result = subprocess.run([native.omp_executable(), '--version'], cwd=host['control_dir'],
                            env=native.omp_environment(), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    value = result.stdout.decode('utf-8').strip()
    if result.returncode or not re.fullmatch(r'(?:omp(?:/|\s+))?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', value):
        raise ControlError('version_unavailable', 503)
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args(argv)
    try:
        cfg, host = load_config(args.config)
        control = Control(cfg, host, native_version(host))
        server_type = Server
        if ipaddress.ip_address(cfg['bind']).version == 6:
            class IPv6Server(Server):
                address_family = socket.AF_INET6
            server_type = IPv6Server
        with server_type((cfg['bind'], cfg['port']), Handler) as server:
            server.control = control
            server.serve_forever()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        print('{"error":"control_start_failed"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
