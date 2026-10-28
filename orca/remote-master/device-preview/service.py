#!/usr/bin/env python3
"""Task-only stdio MCP. No shell strings, arbitrary paths, or caller-supplied argv."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tarfile
import urllib.request

SOURCE = Path(__file__).resolve().parent
OPERATIONS = ('capabilities', 'terminal_probe', 'package_sha256', 'boundary_check',
              'orca_roundtrip', 'islogin', 'download', 'extract', 'login', 'preview', 'qr_image')
BUSINESS = {'download', 'extract', 'login', 'preview'}


class Denied(ValueError):
    pass


def policy():
    cfg = json.loads((SOURCE / 'policy.json').read_text())
    if set(cfg) != {'version', 'role', 'task_relative', 'cli_relative',
                    'package_sha256', 'business_enabled', 'download_url'}:
        raise Denied('Unexpected policy fields')
    if (cfg['version'] != 1 or cfg['role'] != 'revisited-device-preview'
            or cfg['task_relative'] != 'Code/orca-remote/Revisited/device-preview-20261021'
            or cfg['cli_relative'] != 'Applications/wechatwebdevtools.app/Contents/MacOS/cli'
            or type(cfg['business_enabled']) is not bool
            or not re.fullmatch('[0-9a-f]{64}', cfg['package_sha256'])):
        raise Denied('Policy identity mismatch')
    return cfg


def scoped(root, relative):
    p = Path(relative)
    if p.is_absolute() or '..' in p.parts or not p.parts:
        raise Denied('Path outside task')
    target = root / p
    for item in [root, *root.parents, target, *target.parents]:
        if item.is_symlink():
            raise Denied('Symlink refused')
    if not target.resolve().is_relative_to(root.resolve()):
        raise Denied('Path outside task')
    if target.exists() and target.is_file() and target.stat().st_nlink != 1:
        raise Denied('Hardlink refused')
    return target


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def run(argv, cwd, timeout=20):
    # Do not inherit model tokens, shell startup files or loader overrides.
    env = {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
           'TMPDIR': '/tmp', 'LANG': 'en_US.UTF-8'}
    for key, value in os.environ.items():
        if key.startswith('ORCA_') and key not in {'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE'}:
            env[key] = value
    with subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True) as proc:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # CLI wrapper spawns node; stop only this invocation's process group.
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.communicate()
            raise
        return subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)


def orca(argv, cwd):
    executable = os.environ.get('ORCA_CLI_COMMAND', '/opt/homebrew/bin/orca')
    result = run([executable, *argv, '--json'], cwd)
    data = json.loads(result.stdout)
    if result.returncode or not data.get('ok'):
        raise Denied('Orca operation failed: ' + str(data.get('error', {}).get('code', 'unknown')))
    return data.get('result', {})


def safe_members(archive, root):
    members = archive.getmembers()
    if len(members) > 20000 or sum(m.size for m in members) > 512 * 1024 * 1024:
        raise Denied('Archive exceeds task limits')
    names = set()
    for member in members:
        target = scoped(root, member.name)
        if not (member.isdir() or member.isfile()) or member.name in names:
            raise Denied('Archive link, device or duplicate refused')
        if not Path(member.name).parts or Path(member.name).parts[0] != 'preview-project':
            raise Denied('Unexpected archive root')
        names.add(member.name)
        if target.exists():
            raise Denied('Extraction would overwrite existing files')
    return members


class Service:
    def __init__(self, session=None):
        self.cfg = policy()
        self.root = Path.home() / self.cfg['task_relative']
        self.cli = Path.home() / self.cfg['cli_relative']
        self.session = session

    def call(self, op):
        if op not in OPERATIONS:
            raise Denied('Operation not permitted')
        if op in BUSINESS and not self.cfg['business_enabled']:
            raise Denied('Business execution is disabled for configuration verification')
        package = scoped(self.root, 'preview-project.tgz')
        if op == 'capabilities':
            return {'role': self.cfg['role'], 'root': str(self.root),
                    'cli_exists': self.cli.is_file(), 'business_enabled': self.cfg['business_enabled'],
                    'operations': OPERATIONS, 'arbitrary_shell': False,
                    'upload_publish_submit': False}
        if op == 'terminal_probe':
            result = run(['/bin/pwd', '-P'], self.root)
            if result.returncode or result.stdout.strip() != str(self.root):
                raise Denied('Task cwd probe failed')
            return {'argv': ['/bin/pwd', '-P'], 'cwd': result.stdout.strip(), 'exit_code': 0}
        if op == 'package_sha256':
            actual = digest(package)
            return {'sha256': actual, 'matches_local_baseline': actual == self.cfg['package_sha256'],
                    'sender_checksum_verified': False}
        if op == 'boundary_check':
            for name in ['../outside', '/etc/passwd', '../../hainanpolicy']:
                try:
                    scoped(self.root, name)
                except Denied:
                    continue
                raise Denied('Boundary check failed')
            return {'traversal_denied': True, 'absolute_path_denied': True,
                    'upload_not_exposed': 'upload' not in OPERATIONS}
        if op == 'orca_roundtrip':
            if not self.session:
                raise Denied('Session binding unavailable')
            state = json.loads(self.session.read_text())
            current = orca(['orchestration', 'run-current'], self.root)
            if state['run_id'] not in json.dumps(current):
                raise Denied('Run binding changed')
            marker = 'device-preview-capability-check-' + state['nonce']
            receipt_file = self.session.parent / 'message-receipt.json'
            if not receipt_file.exists():
                # Persist intention first. Unknown delivery must not be blindly retried.
                pending = self.session.parent / 'message-intent.json'
                if pending.exists():
                    raise Denied('Message delivery uncertain; reconcile before retry')
                pending.write_text(json.dumps({'marker': marker}))
                sent = orca(['orchestration', 'send', '--to', 'run:' + state['run_id'],
                             '--type', 'status', '--subject', marker,
                             '--body', 'Configuration capability check only; no preview executed.'], self.root)
                receipt_file.write_text(json.dumps(sent))
            inbox = orca(['orchestration', 'check', '--peek'], self.root)
            found = marker in json.dumps(inbox)
            return {'run_id': state['run_id'], 'durably_enqueued': True,
                    'found_in_own_inbox': found, 'remote_coordinator_delivery_verified': False}
        if op == 'download':
            # Exact URL is administrator-controlled, not model supplied; no credentials or redirects.
            from urllib.parse import urlsplit
            url = self.cfg['download_url']
            if not isinstance(url, str):
                raise Denied('No approved download URL configured')
            parsed = urlsplit(url)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise Denied('Download requires an approved credential-free HTTPS URL')
            if package.exists():
                raise Denied('Refusing to overwrite package')
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    raise Denied('Redirect denied')
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(url, timeout=30) as response:
                payload = response.read(64 * 1024 * 1024 + 1)
            if len(payload) > 64 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != self.cfg['package_sha256']:
                raise Denied('Package size/checksum mismatch')
            with package.open('xb') as out:
                out.write(payload)
            return {'downloaded': True, 'sha256_verified': True}
        if op == 'extract':
            if digest(package) != self.cfg['package_sha256']:
                raise Denied('Package checksum mismatch')
            with tarfile.open(package, 'r:gz') as archive:
                members = safe_members(archive, self.root)
                for member in members:
                    path = scoped(self.root, member.name)
                    if member.isdir():
                        path.mkdir(parents=True, exist_ok=True)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with path.open('xb') as out, archive.extractfile(member) as src:
                            out.write(src.read())
                        path.chmod(0o600)
            return {'extracted': True}
        if op == 'qr_image':
            data = scoped(self.root, 'preview-qr.png').read_bytes()
            if len(data) > 2 * 1024 * 1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise Denied('Not a bounded PNG')
            return {'png_base64': base64.b64encode(data).decode()}
        if op in {'islogin', 'login', 'preview'}:
            if not self.cli.is_file() or not os.access(self.cli, os.X_OK):
                raise Denied('WeChat CLI unavailable')
            argv = [str(self.cli), op]
            if op in {'login', 'preview'}:
                output = scoped(self.root, 'login-qr.png' if op == 'login' else 'preview-qr.png')
                argv += ['--qr-format', 'image', '--qr-output', str(output)]
            if op == 'preview':
                project = scoped(self.root, 'preview-project')
                for entry in project.rglob('*'):
                    scoped(self.root, str(entry.relative_to(self.root)))
                    if not (entry.is_file() or entry.is_dir()):
                        raise Denied('Special project file refused')
                argv += ['--project', str(project)]
            try:
                result = run(argv, self.root, 45)
            except subprocess.TimeoutExpired:
                return {'ok': False, 'reason': 'CLI timed out; service port or interaction may be required'}
            output = result.stdout + result.stderr
            if 'service port disabled' in output.lower() or '服务端口已关闭' in output:
                return {'ok': False, 'reason': 'IDE service port disabled; not enabled by this tool'}
            # Do not expose raw CLI logs, account identifiers, or provider output.
            return {'exit_code': result.returncode, 'ok': result.returncode == 0}
        raise Denied('Operation not implemented')


def serve(service):
    audit = service.session.parent / 'protocol-audit.jsonl' if service.session else None
    if audit:
        with audit.open('a') as out:
            out.write(json.dumps({'event': 'start', 'pid': os.getpid()}) + '\n')
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            break
        framed = line.lower().startswith(b'content-length:')
        if framed:
            length = int(line.split(b':', 1)[1])
            if length > 65536:
                raise Denied('Request too large')
            while sys.stdin.buffer.readline().strip():
                pass
            line = sys.stdin.buffer.read(length)
        def emit(value):
            payload = json.dumps(value).encode()
            if framed:
                sys.stdout.buffer.write(b'Content-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
            else:
                sys.stdout.buffer.write(payload + b'\n')
            sys.stdout.buffer.flush()
        try:
            request = json.loads(line)
            if audit:
                with audit.open('a') as out:
                    out.write(json.dumps({'event': 'request', 'method': request.get('method'), 'has_id': 'id' in request}) + '\n')
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': request.get('params', {}).get('protocolVersion', '2024-11-05'),
                          'capabilities': {'tools': {}}, 'serverInfo': {'name': 'device-preview', 'version': '1.0'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'task_operation', 'description': 'Fixed task operations only; no arbitrary shell. Business gate is off during configuration validation.',
                          'inputSchema': {'type': 'object', 'properties': {'operation': {'type': 'string', 'enum': list(OPERATIONS)}},
                                          'required': ['operation'], 'additionalProperties': False}}]}
            elif method == 'tools/call':
                params = request.get('params', {})
                args = params.get('arguments', {})
                try:
                    if params.get('name') != 'task_operation' or set(args) != {'operation'}:
                        raise Denied('Unexpected tool or arguments')
                    value = service.call(args['operation'])
                    result = {'content': [{'type': 'text', 'text': json.dumps(value)}]}
                except (Denied, OSError, ValueError, subprocess.SubprocessError):
                    result = {'isError': True, 'content': [{'type': 'text', 'text': 'Operation denied or unavailable; no permission expansion performed.'}]}
            elif method == 'ping':
                result = {}
            else:
                emit({'jsonrpc': '2.0', 'id': request['id'], 'error': {
                    'code': -32601, 'message': 'Method not found'}})
                continue
            emit({'jsonrpc': '2.0', 'id': request['id'], 'result': result})
        except (ValueError, KeyError, TypeError):
            emit({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request'}})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate', action='store_true')
    parser.add_argument('--session', type=Path)
    args = parser.parse_args()
    if args.validate:
        cfg = policy()
        print(json.dumps({'valid': True, 'role': cfg['role'], 'business_enabled': cfg['business_enabled']}))
    else:
        serve(Service(args.session))
