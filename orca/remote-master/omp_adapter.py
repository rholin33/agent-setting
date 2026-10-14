#!/usr/bin/env python3
"""Deterministic, private native OMP provisioning through the paired Orca host.
No model credentials cross machines. All process handles are persisted before
progressing; ambiguous creates are never replayed. Collab owns the native TUI.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
import bridge
import native_omp

HERE = Path(__file__).resolve().parent
FILES = ('native_omp.py', 'collab_tunnel.py', 'omp_control.py')


def private(path, value):
    bridge.private_json(path, value)


def call(*args):
    env = {k: v for k, v in os.environ.items() if k not in ('ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE')}
    result = subprocess.run([shutil.which('orca') or 'orca', *args, '--json'], env=env,
                            capture_output=True, text=True, timeout=60)
    try:
        data = json.loads(result.stdout)
        if not data.get('ok'):
            raise ValueError()
        return data['result']
    except (ValueError, KeyError):
        raise RuntimeError('Orca operation failed: ' + ' '.join(args[:2])) from None


def request(url, token=None, data=None):
    return bridge.request(url, token, data, timeout=20)


def eventually(action, description, timeout=60):
    deadline = time.monotonic() + timeout
    while True:
        try:
            value = action()
            if value:
                return value
        except (OSError, ValueError, RuntimeError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError(description + '; existing processes retained, no automatic recreation')
        time.sleep(0.5)


def tailnet(value):
    address = ipaddress.ip_address(value)
    if address.version != 4 or address not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('A literal IPv4 Tailscale address is required')
    return str(address)


def discover(environment):
    rows = call('environment', 'list')['environments']
    matches = [r for r in rows if not environment or environment in (r['name'], r['id'])]
    if len(matches) != 1:
        raise RuntimeError('Select exactly one paired remote environment')
    selected = matches[0]
    endpoints = [e for e in selected['endpoints'] if e['id'] == selected.get('preferredEndpointId')]
    if len(endpoints) != 1:
        raise RuntimeError('Paired environment has no unique preferred endpoint')
    peer = tailnet(urllib.parse.urlsplit(endpoints[0]['endpoint']).hostname)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((peer, 9))
        local = tailnet(sock.getsockname()[0])
    terminals = call('terminal', 'list', '--environment', selected['name'])['terminals']
    roots = {r.get('worktreePath') for r in terminals if r.get('connected') and r.get('worktreePath')}
    if len(roots) != 1:
        raise RuntimeError('Remote execution worktree is ambiguous; configure one explicit environment')
    return selected['name'], local, peer, roots.pop()


def role_prompt(req):
    home = Path(req['home'])
    catalog = json.loads((home / 'team.json').read_text())
    rows = [r for r in catalog if r['name'] == req['role']]
    if len(rows) != 1:
        raise RuntimeError('Unknown configured team role')
    package = rows[0]['role'].split('.')[-1]
    import tomllib
    root = home / 'source' / package
    role = tomllib.loads((root / 'role.toml').read_text())
    chunks = ['Canonical team role: ' + req['role'], (root / 'role.toml').read_text()]
    for filename in role.get('contents', {}).get('memory', []):
        file = (root / filename).resolve()
        if not file.is_relative_to(root.resolve()):
            raise RuntimeError('Role resource escapes its package')
        chunks.append(file.read_text())
    overlay_root = (home / 'roles').resolve()
    overlay = (overlay_root / (req['role'] + '.md')).resolve()
    if not overlay.is_relative_to(overlay_root):
        raise RuntimeError('Team role overlay escapes its directory')
    chunks.append('Orca team host adaptation (same role on local and remote hosts):\n'
                  + overlay.read_text().replace('{{TEAM_ROOT}}', str(home)))
    chunks.append('Context custody is distinct from execution permission. A verified handoff '
                  'to the same canonical role may carry business history and pending actions '
                  'without authorizing their execution. Do not reject solely because the host '
                  'is remote or a checkpoint mentions work assigned to other specialists. '
                  'Keep all actual role, identity, worktree and tool restrictions; report '
                  'unavailable execution capabilities and preserve pending work without acting.')
    chunks.append('Do not start business work until a verified context handoff is accepted. '
                  'Preserve the role boundary and the source task decisions. Never infer a new task from this startup.')
    return '\n\n'.join(chunks), bool(role.get('permissions', {}).get('write_files'))


def create(state, key, command, environment=None):
    path = Path(state['state_file'])
    if key in state['terminals']:
        item = state['terminals'][key]
        args = ['terminal', 'show', '--terminal', item['handle']]
        if item.get('environment'):
            args += ['--environment', item['environment']]
        current = call(*args)['terminal']
        if not current.get('connected') or current.get('incarnationId') != item['incarnation']:
            raise RuntimeError(key + ' process identity changed; explicit recovery required')
        return item
    if state.get('creating'):
        raise RuntimeError('Uncertain terminal creation: ' + state['creating'] + '; reconcile before retry')
    state['creating'] = key
    private(path, state)
    args = ['terminal', 'create', '--worktree', 'path:' + (state['remote_worktree'] if environment else state['project']),
            '--title', state['role'] + '-omp-' + key, '--command', command]
    if environment:
        args += ['--environment', environment]
    terminal = call(*args)['terminal']
    if not terminal.get('handle') or not terminal.get('incarnationId'):
        raise RuntimeError('Created process lacks a verifiable terminal identity')
    item = {'handle': terminal['handle'], 'incarnation': terminal['incarnationId'], 'environment': environment}
    state['terminals'][key] = item
    state.pop('creating')
    private(path, state)
    return item


class ProvisionHandler(bridge.Handler):
    def do_POST(self):
        if self.path == '/bootstrap':
            if not self.allowed(True):
                return self.reply(403, {'error': 'forbidden'})
            with self.server.lock:
                if self.server.bootstrapped:
                    return self.reply(409, {'error': 'already_provisioned'})
                self.server.bootstrapped = True
                self.server.config['bootstrapped'] = True
                private(self.server.config_path, self.server.config)
            return self.reply(200, self.server.config['package'])
        if self.path == '/installed':
            if not self.allowed():
                return self.reply(403, {'error': 'forbidden'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length < 16384:
                    raise ValueError()
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError()
                private(Path(self.server.config_path).with_name('installed.json'), body)
                return self.reply(200, {'saved': True})
            except (ValueError, OSError):
                return self.reply(400, {'error': 'invalid_install_receipt'})
        super().do_POST()


def serve(config_path):
    cfg = native_omp.read_private(config_path)
    server = ThreadingHTTPServer((cfg['bind'], cfg['port']), ProvisionHandler)
    server.daemon_threads = True
    server.config, server.mode, server.config_path = cfg, 'local', config_path
    server.workspace = bridge.Workspace(cfg)
    server.lock, server.audit, server.active = threading.Lock(), [], False
    server.bootstrapped = bool(cfg.get('bootstrapped'))
    print('Scoped OMP workspace service ready', flush=True)
    server.serve_forever()


INSTALLER = r'''
import json,os,pathlib,shutil,subprocess,urllib.request
url=LOCAL_URL
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def req(path,data,token=None):
 headers={'Content-Type':'application/json'}
 if token: headers['Authorization']='Bearer '+token
 with opener.open(urllib.request.Request(url+path,json.dumps(data).encode(),headers),timeout=30) as r: return json.load(r)
pkg=req('/bootstrap',{})
root=pathlib.Path.home()/'.orca'/'omp-runtime'/pkg['id']
root.mkdir(parents=True,exist_ok=True,mode=0o700)
os.chmod(root,0o700)
def put(name,value):
 p=root/name
 if p.is_symlink(): raise RuntimeError('Unsafe provision target')
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f: f.write(value if isinstance(value,str) else json.dumps(value))
try:
 for name,text in pkg['files'].items(): put(name,text)
 host=pkg['host']; host['control_dir']=str(root); host['session_dir']=str(root/'sessions')
 put('host.json',host); put('tunnel.json',pkg['tunnel'])
 control=pkg['control'];control['host_config']=str(root/'host.json');put('control.json',control)
 import sys;sys.path.insert(0,str(root));import native_omp
 native_omp.host_config(host);native_omp.require_plugin_free(host,native_omp.omp_environment(host))
 overlay,prompt=native_omp.prepare_host(host)
 models=native_omp.run_json([native_omp.omp_executable(),'models','ls','--json','--no-extensions','--config',str(overlay)],str(root),native_omp.omp_environment(host))
 if not any(x.get('provider','')+'/'+x.get('id','')==host['model'] for x in models.get('models',[])):raise RuntimeError('Selected model unavailable')
 req('/installed',{'ready':True,'root':str(root),'python':shutil.which('python3'),'omp':shutil.which('omp')},host['token'])
 print('OMP private installation and model check passed')
except Exception as e:
 req('/installed',{'ready':False,'error':type(e).__name__},pkg['host']['token'])
 print('OMP installation refused; inspect private configuration locally')
 raise SystemExit(1)
'''


def command(executable, script, *args):
    return shlex.join([str(executable), str(script), *map(str, args)])


def thinking_level(state):
    """Read only the uniquely bound guest replica, never infer from footer glyphs."""
    directory = Path(state['state_file']).parent / 'native-guest/native-profile/collab'
    candidates = []
    for path in directory.glob('*.jsonl'):
        if path.is_symlink():
            raise RuntimeError('OMP_READINESS:thinking_replica')
        with path.open() as stream:
            header = json.loads(stream.readline())
            if header.get('parentSession') != state['host_identity']['sessionId']:
                continue
            level = None
            for line in stream:
                if not line.endswith('\n'):
                    break
                entry = json.loads(line)
                if entry.get('type') == 'thinking_level_change':
                    level = entry.get('configured') or entry.get('thinkingLevel')
            candidates.append(level)
    if len(candidates) != 1 or candidates[0] not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'):
        raise RuntimeError('OMP_READINESS:thinking_replica')
    return candidates[0]


def sync_thinking(state, target):
    """Cycle the documented host shortcut; acknowledge only replicated native state."""
    if target not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'):
        raise RuntimeError('OMP_READINESS:thinking_unsupported')
    verify(state['state_file'])
    current = thinking_level(state)
    pending = state.get('thinkingChange')
    if pending and (pending['target'] != target or current == pending['before']):
        raise RuntimeError('OMP_READINESS:thinking_uncertain')
    seen = set()
    while current != target:
        if current in seen or len(seen) >= 8:
            raise RuntimeError('OMP_READINESS:thinking_unsupported')
        seen.add(current)
        before = bound_host(state)
        if before.get('busy') is not False or before.get('inputRequired') is not False:
            raise RuntimeError('OMP_READINESS:thinking_busy')
        host = state['terminals']['host']
        args = ['--terminal', host['handle'], '--environment', state['environment']]
        live = call('terminal', 'show', *args)['terminal']
        if not live.get('connected') or live.get('incarnationId') != host['incarnation']:
            raise RuntimeError('OMP_READINESS:thinking_identity')
        screen = call('terminal', 'read', *args, '--screen')['terminal']
        lines = screen.get('tail', [])
        if (screen.get('source') != 'screen' or not isinstance(lines, list) or
                not lines or lines[-1].strip() != '╰─' or screen.get('draft')):
            raise RuntimeError('OMP_READINESS:thinking_draft')
        state['thinkingChange'] = {'target': target, 'before': current}
        private(Path(state['state_file']), state)
        # Never use a slash-command guess: unknown commands can become model prompts.
        call('terminal', 'send', *args, '--text', '\x1b[Z')
        try:
            observed = eventually(lambda: (value if (value := thinking_level(state)) != current else None),
                                  'OMP_READINESS:thinking_uncertain', timeout=5)
        except (OSError, ValueError, RuntimeError):
            raise RuntimeError('OMP_READINESS:thinking_uncertain') from None
        after = bound_host(state)
        if after.get('pid') != before.get('pid'):
            raise RuntimeError('OMP_READINESS:thinking_identity')
        current = observed
        state['thinking'] = current
        state.pop('thinkingChange', None)
        private(Path(state['state_file']), state)
    state['thinking'] = current
    state.pop('thinkingChange', None)
    private(Path(state['state_file']), state)


def ensure(req):
    project = str(Path(req['project']).resolve(strict=True))
    if not req.get('role') or not req.get('model') or '/' not in req['model']:
        raise ValueError('Explicit role and provider/model are required')
    ident = hashlib.sha256((project + '\0' + req['role']).encode()).hexdigest()[:16]
    directory = Path(req['home']) / 'remote-master' / 'runtime' / ('omp-' + ident)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    state_path = directory / 'adapter.json'
    with (directory / 'provision.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if state_path.exists():
            state = native_omp.read_private(state_path)
            if any(state[k] != v for k, v in {'project': project, 'role': req['role']}.items()):
                raise RuntimeError('OMP_READINESS:binding_mismatch')
            if state['model'] != req['model']:
                raise RuntimeError('OMP_READINESS:model_mismatch')
            if state.get('endpoint'):
                inventory = call('terminal', 'list', '--worktree', 'path:' + project)
                if not isinstance(inventory.get('terminals'), list):
                    raise RuntimeError('Local client inventory is unavailable')
                if any(row.get('handle') == state['endpoint']['terminal'] for row in inventory['terminals']):
                    if state['thinking'] != (req['thinking'] or 'off') or state.get('thinkingChange'):
                        sync_thinking(state, req['thinking'] or 'off')
                    return verify(state_path)
                # A successful authoritative absence check allows only a new UI
                # for the very same host process, generation and conversation.
                bound_host(state)
                state['previousEndpoint'] = state.pop('endpoint')
                state.setdefault('retired', []).append(state['terminals'].pop('guest'))
                private(state_path, state)
        else:
            environment, local, peer, remote_worktree = discover(req.get('environment'))
            prompt, writes = role_prompt(req)
            # Stable private role port block; collisions fail instead of touching other services.
            base = 22000 + (int(ident[:4], 16) % 300) * 4
            mcp_token, relay_token, control_token = (secrets.token_urlsafe(32) for _ in range(3))
            state = {'version': 1, 'state_file': str(state_path), 'id': ident, 'project': project,
                     'role': req['role'], 'model': req['model'], 'thinking': req['thinking'] or 'off',
                     'environment': environment, 'local': local, 'peer': peer, 'remote_worktree': remote_worktree,
                     'base': base, 'control_token': control_token, 'terminals': {}}
            tunnel = {'bind': '127.0.0.1', 'port': base, 'remote_host': local, 'remote_port': base + 1, 'token': relay_token}
            host = {'role': req['role'], 'root': project, 'model': req['model'], 'thinking': state['thinking'],
                    'relay_port': base, 'local_url': f'http://{local}:{base+2}/mcp', 'token': mcp_token, 'role_prompt': prompt, 'isolate_plugins': True}
            control = {'bind': peer, 'port': base + 3, 'peer': local, 'token': control_token}
            package = {'id': ident, 'files': {name: (HERE / name).read_text() for name in FILES},
                       'host': host, 'tunnel': tunnel, 'control': control}
            private(directory / 'workspace.json', {'bind': local, 'port': base+2, 'peer': peer, 'token': mcp_token,
                    'root': project, 'role': req['role'], 'role_prompt': prompt, 'code_write_enabled': writes,
                    'orca': shutil.which('orca'), 'package': package})
            private(directory / 'relay.json', {'bind': local, 'port': base+1, 'peers': [local, peer],
                    'token_sha256': hashlib.sha256(relay_token.encode()).hexdigest()})
            private(directory / 'tunnel.json', tunnel)
            private(state_path, state)
        py = sys.executable
        create(state, 'workspace', command(py, HERE / 'omp_adapter.py', 'serve', '--config', directory / 'workspace.json'))
        cfg = native_omp.read_private(directory / 'workspace.json')
        eventually(lambda: request(f'http://{state["local"]}:{state["base"]+2}/health', cfg['token']), 'Workspace bridge unavailable')
        if not (directory / 'installed.json').exists():
            code = INSTALLER.replace('LOCAL_URL', repr(f'http://{state["local"]}:{state["base"]+2}'))
            create(state, 'install', shlex.join(['python3', '-c', code]), state['environment'])
        installed = eventually(lambda: native_omp.read_private(directory / 'installed.json') if (directory / 'installed.json').exists() else None, 'Remote installation has no receipt', 100)
        if not installed.get('ready'):
            raise RuntimeError('Remote OMP native preparation refused; original source remains owner')
        remote = Path(installed['root'])
        create(state, 'relay', command(shutil.which('bun') or 'bun', HERE / 'private_collab_relay.ts', '--config', directory / 'relay.json'))
        create(state, 'local-tunnel', command(py, HERE / 'collab_tunnel.py', '--config', directory / 'tunnel.json'))
        create(state, 'remote-tunnel', command(installed['python'], remote / 'collab_tunnel.py', '--config', remote / 'tunnel.json'), state['environment'])
        create(state, 'control', command(installed['python'], remote / 'omp_control.py', '--config', remote / 'control.json'), state['environment'])
        control_url = f'http://{state["peer"]}:{state["base"]+3}'
        eventually(lambda: request(control_url + '/health', state['control_token']), 'Remote control service unavailable')
        create(state, 'host', command(installed['python'], remote / 'native_omp.py', 'host', '--config', remote / 'host.json'), state['environment'])
        host = eventually(lambda: request(control_url + '/snapshot', state['control_token']).get('host'), 'Native OMP host not published', 100)
        if not host.get('relayConnected') or host.get('access') != 'control' or host.get('model') != dict(zip(('provider','id'), state['model'].split('/',1))):
            raise RuntimeError('Native OMP connection/model was not proven')
        identity = {key: host[key] for key in ('sessionId', 'instanceId', 'generation')}
        if state.get('host_identity') and state['host_identity'] != identity:
            raise RuntimeError('Pinned native host changed before guest attachment')
        state['host_identity'] = identity
        private(state_path, state)
        link = request(control_url + '/link', state['control_token'], {'instance_id': host['instanceId'], 'generation': host['generation']})
        if link.get('session') != host['sessionId'] or link.get('instance_id') != host['instanceId'] or link.get('generation') != host['generation']:
            raise RuntimeError('Native link identity changed')
        native_omp.validate_join_url(link['join_url'], state['base'])
        private(directory / 'join.json', {'join_url': link['join_url'], 'control_dir': str(directory / 'native-guest')})
        guest = create(state, 'guest', command(py, HERE / 'native_omp.py', 'client', '--config', directory / 'join.json'))
        def guest_ready():
            row = call('terminal', 'show', '--terminal', guest['handle'])['terminal']
            snap = request(control_url + '/snapshot', state['control_token']).get('host')
            return snap if row.get('agentIdentity') == 'omp' and snap and (snap.get('participants') or 0) > 1 else None
        host = eventually(guest_ready, 'Native local OMP guest did not join', 60)
        check_host(state, host)
        state['endpoint'] = {'runtime': 'omp', 'role': state['role'], 'environment': 'local',
                             'terminal': guest['handle'], 'incarnation': guest['incarnation'],
                             'session': host['sessionId'], 'adapterConfig': str(state_path)}
        private(state_path, state)
        if state['thinking'] != (req['thinking'] or 'off') or state.get('thinkingChange'):
            sync_thinking(state, req['thinking'] or 'off')
        return state['endpoint']


def check_host(state, host):
    if not host or any(host.get(k) != v for k, v in state['host_identity'].items()) or not host.get('relayConnected') or host.get('access') != 'control':
        raise RuntimeError('Bound remote OMP session changed or disconnected')
    if host.get('model') != dict(zip(('provider', 'id'), state['model'].split('/', 1))):
        raise RuntimeError('Bound remote OMP model changed')
    return host


def bound_host(state):
    return check_host(state, request(f'http://{state["peer"]}:{state["base"]+3}/snapshot', state['control_token']).get('host'))


def verify(config_path):
    state = native_omp.read_private(config_path)
    endpoint = state['endpoint']
    row = call('terminal', 'show', '--terminal', endpoint['terminal'])['terminal']
    if not row.get('connected') or row.get('incarnationId') != endpoint['incarnation'] or row.get('agentIdentity') != 'omp' or str(Path(row.get('worktreePath','')).resolve()) != state['project']:
        raise RuntimeError('Bound local guest identity changed')
    bound_host(state)
    return endpoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('ensure','verify','serve'))
    parser.add_argument('--request')
    parser.add_argument('--config')
    args = parser.parse_args()
    if args.mode == 'serve':
        serve(args.config)
    else:
        value = ensure(native_omp.read_private(args.request)) if args.mode == 'ensure' else verify(args.config)
        print(json.dumps(value))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, native_omp.LauncherError) as exc:
        # All locally raised errors are bounded nonsecret diagnostics. Network bodies are never echoed.
        print('OMP adapter failed: ' + type(exc).__name__ + ': ' + (str(exc) if isinstance(exc, (RuntimeError, native_omp.LauncherError)) else 'prerequisite or transport unavailable'), file=sys.stderr)
        sys.exit(1)
