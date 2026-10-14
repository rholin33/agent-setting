#!/usr/bin/env python3
"""Native interactive OMP Collab launcher; no conversation or credential relay.

CLI: host|snapshot|client --config PRIVATE_JSON
     link --config HOST_JSON --instance-id ID --generation N --output PRIVATE_JSON

The root mcp.json symlink is deliberate: disabling the native discovery provider
also disables its inseparable user MCP scope. The project-only mcp-json provider
reads this link to our private .omp/mcp.json; all other discovery providers are
disabled by a process-only YAML overlay. Native model/auth storage stays in place.
A session identity is recorded from the launched PID's live Collab registry row,
then pinned to its exact persisted JSONL header, never the newest session file.
An empty session may not have a JSONL yet; restarting that identity fails closed.

Protocol references: OMP docs/collab.md, docs/mcp-config.md, docs/config-usage.md;
src/cli/collab-cli.ts (no external generation flag), src/discovery/mcp-json.ts,
src/capability/index.ts and src/main.ts (--no-tools preserves MCP discovery).
"""
import argparse
import base64
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


class LauncherError(Exception):
    """Only fixed, nonsecret diagnostics may cross the launcher boundary."""


# These are discovery IDs, not model-provider IDs. Keep aligned with installed OMP.
DISABLED_DISCOVERY = [
    'native', 'omp-plugins', 'claude', 'agent-plugins', 'claude-plugins',
    'codex', 'agents', 'gemini', 'opencode', 'cursor', 'windsurf', 'cline',
    'github', 'vscode', 'agents-md', 'claude-md', 'custom-context-files',
    'managed-skills', 'skillshare', 'ssh', 'builtin-defaults',
]
MAX_CONFIG_BYTES = 1024 * 1024


def private_dir(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise LauncherError('Private directory must be owned by this user with mode 0700')
    if path.resolve() != path.absolute():
        raise LauncherError('Private directory must not traverse symlinks')
    return path


def read_private(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise LauncherError('Private JSON must be owner-only and a regular file')
            text = stream.read(MAX_CONFIG_BYTES + 1)
        if len(text) > MAX_CONFIG_BYTES:
            raise LauncherError('Private JSON exceeds size limit')
        result = json.loads(text)
        if not isinstance(result, dict):
            raise LauncherError('Private JSON must contain an object')
        return result
    except (OSError, ValueError, UnicodeError):
        raise LauncherError('Cannot read private JSON') from None


def write_private(path, value):
    path = Path(path)
    private_dir(path.parent)
    if path.is_symlink():
        raise LauncherError('Refusing symlink private output')
    fd, temporary = tempfile.mkstemp(prefix='.native-omp-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def text_field(cfg, key):
    value = cfg.get(key)
    if not isinstance(value, str) or not value.strip() or '\0' in value:
        raise LauncherError('Missing or invalid required text field: ' + key)
    return value


def absolute_field(cfg, key):
    value = text_field(cfg, key)
    if not Path(value).is_absolute() or str(Path(value)) != value or '..' in Path(value).parts:
        raise LauncherError('Path field must be normalized and absolute: ' + key)
    return Path(value)


def host_config(cfg):
    for key in ('role', 'model', 'thinking', 'token', 'role_prompt'):
        text_field(cfg, key)
    root = absolute_field(cfg, 'root')
    control = absolute_field(cfg, 'control_dir')
    sessions = absolute_field(cfg, 'session_dir')
    if control == root or root in control.parents or sessions == root or root in sessions.parents:
        raise LauncherError('Remote control and session directories must be outside the local worktree')
    if sessions == control:
        raise LauncherError('A separate session directory is required')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[^\s*?\[\]@:,]+', cfg['model']):
        raise LauncherError('Model must be an exact provider/model selector without effort or wildcards')
    if cfg['thinking'] not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'):
        raise LauncherError('Unsupported explicit thinking level')
    port = cfg.get('relay_port')
    if type(port) is not int or not 1 <= port <= 65535:
        raise LauncherError('relay_port must be an integer from 1 to 65535')
    if not re.fullmatch(r'[A-Za-z0-9._~+/-]{16,}=*', cfg['token']):
        raise LauncherError('MCP bearer token must be a nonempty opaque token')
    try:
        url = urlsplit(text_field(cfg, 'local_url'))
        address = ipaddress.ip_address(url.hostname or '')
        if url.scheme != 'http' or url.username or url.password or url.query or url.fragment or not url.port:
            raise ValueError()
        if not (address.is_loopback or address in ipaddress.ip_network('100.64.0.0/10')):
            raise ValueError()
    except ValueError:
        raise LauncherError('MCP URL must be exact loopback or Tailscale HTTP with an explicit port') from None
    return cfg


def omp_environment(cfg=None):
    env = dict(os.environ)
    # Prevent a caller's process-only overlays from adding configuration here.
    env.pop('PI_CONFIG_FILES', None)
    if cfg and cfg.get('isolate_plugins'):
        home = Path.home()
        previous_root = home / env.get('PI_CONFIG_DIR', '.omp')
        profile = env.get('OMP_PROFILE', env.get('PI_PROFILE', '')).strip()
        if profile and profile != 'default':
            if not re.fullmatch(r'[A-Za-z0-9_-]+', profile):
                raise LauncherError('Invalid source auth profile')
            previous_agent = previous_root / 'profiles' / profile / 'agent'
        else:
            previous_agent = Path(env.get('PI_CODING_AGENT_DIR', str(previous_root / 'agent')))
        if not previous_agent.is_absolute() or not previous_agent.is_dir():
            raise LauncherError('Existing remote auth directory is unavailable')
        isolated = private_dir(Path(cfg['control_dir']) / 'native-profile')
        if not isolated.is_relative_to(home):
            raise LauncherError('Isolated native profile must be inside remote home')
        env['PI_CONFIG_DIR'] = str(isolated.relative_to(home))
        env['PI_CODING_AGENT_DIR'] = str(previous_agent)
        env['XDG_DATA_HOME'] = str(private_dir(Path(cfg['control_dir']) / 'native-xdg'))
        env.pop('OMP_PROFILE', None)
        env.pop('PI_PROFILE', None)
    for key in ('NO_PROXY', 'no_proxy'):
        env[key] = ','.join(filter(None, (env.get(key, ''), '127.0.0.1', 'localhost', '100.64.0.0/10')))
    return env


def omp_executable():
    executable = shutil.which('omp')
    if not executable:
        raise LauncherError('Native OMP executable is unavailable on PATH')
    return executable


def run_json(arguments, cwd, env):
    # Never propagate child stdout/stderr or CalledProcessError (link-bearing argv).
    try:
        result = subprocess.run(arguments, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30, check=False)
        if result.returncode or len(result.stdout) > 8 * MAX_CONFIG_BYTES:
            raise LauncherError('Native OMP metadata command failed')
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (OSError, ValueError, subprocess.SubprocessError):
        raise LauncherError('Native OMP metadata command failed') from None


def state_path(cfg):
    return Path(cfg['control_dir']) / '.omp' / 'native-state.json'


@contextlib.contextmanager
def state_lock(cfg):
    path = Path(cfg['control_dir']) / '.omp' / 'native-state.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def load_state(cfg):
    path = state_path(cfg)
    if not path.exists():
        return None
    state = read_private(path)
    identity = {key: cfg[key] for key in ('role', 'root', 'control_dir', 'session_dir')}
    if state.get('identity') != identity or state.get('version') != 1:
        raise LauncherError('Recorded host identity does not match configuration')
    return state


def session_file(cfg, session_id):
    """Only the exact native session header binds a file; filenames are not trusted."""
    matches = []
    directory = Path(cfg['session_dir'])
    for path in directory.glob('*.jsonl'):
        if path.is_symlink() or path.resolve().parent != directory.resolve():
            raise LauncherError('Session directory contains an unsafe session path')
        try:
            with path.open(encoding='utf-8') as stream:
                # OMP may prepend a title slot before the session header.
                for _ in range(8):
                    line = stream.readline(MAX_CONFIG_BYTES + 1)
                    if not line:
                        break
                    if len(line) > MAX_CONFIG_BYTES:
                        raise LauncherError('Session header exceeds size limit')
                    entry = json.loads(line)
                    if entry.get('type') == 'session':
                        if entry.get('id') == session_id:
                            if entry.get('cwd') != cfg['control_dir']:
                                raise LauncherError('Recorded session has a different working directory')
                            matches.append(path)
                        break
        except (OSError, ValueError, AttributeError, UnicodeError):
            raise LauncherError('Cannot inspect native session identity') from None
    if len(matches) > 1:
        raise LauncherError('Ambiguous persisted session identity')
    return str(matches[0]) if matches else None


def require_plugin_free(cfg, env):
    """Installed plugin tools bypass --no-extensions and disabledProviders.

    Native OMP has no CLI switch for that loader while keeping MCP enabled.
    Refuse plugin-bearing roots instead of claiming an unenforced sandbox. This
    checks a conservative superset of default/profile/XDG roots, read-only.
    """
    config_name = env.get('PI_CONFIG_DIR') or '.omp'
    if Path(config_name).is_absolute() or '..' in Path(config_name).parts:
        raise LauncherError('Cannot prove plugin isolation for non-relative PI_CONFIG_DIR')
    profile = env.get('OMP_PROFILE', env.get('PI_PROFILE', '')).strip()
    if profile == 'default':
        profile = ''
    if profile and not re.fullmatch(r'[A-Za-z0-9_-]+', profile):
        raise LauncherError('Cannot prove plugin isolation for this profile name')
    roots = [Path.home() / config_name]
    if env.get('XDG_DATA_HOME'):
        xdg = Path(env['XDG_DATA_HOME'])
        if not xdg.is_absolute():
            raise LauncherError('Cannot prove plugin isolation for relative XDG_DATA_HOME')
        roots.append(xdg / 'omp')
    if profile:
        roots += [root / 'profiles' / profile for root in tuple(roots)]
    roots.append(Path(cfg['control_dir']) / '.omp')
    for root in roots:
        modules = root / 'plugins' / 'node_modules'
        if modules.exists() or modules.is_symlink():
            raise LauncherError('Native OMP installed plugin tools bypass CLI isolation; a plugin-free existing auth profile is required')


def prepare_host(cfg):
    control = private_dir(cfg['control_dir'])
    private_dir(cfg['session_dir'])
    omp_dir = private_dir(control / '.omp')
    # The fallback provider also scans .mcp.json; reject instead of importing it.
    if (control / '.mcp.json').exists() or (control / '.mcp.json').is_symlink():
        raise LauncherError('Neutral control directory contains an unrelated MCP source')
    fallback = control / 'mcp.json'
    if fallback.is_symlink():
        if os.readlink(fallback) != '.omp/mcp.json':
            raise LauncherError('Neutral MCP link is not launcher-owned')
    elif fallback.exists():
        raise LauncherError('Refusing to replace existing MCP configuration')
    else:
        fallback.symlink_to('.omp/mcp.json')
    write_private(omp_dir / 'mcp.json', {'mcpServers': {'local-worktree': {
        'type': 'http', 'url': cfg['local_url'],
        'headers': {'Authorization': 'Bearer ' + cfg['token']},
    }}})
    # JSON is a YAML subset; OMP requires config.yml-style mapping overlays.
    overlay = omp_dir / 'native-overlay.yml'
    write_private(overlay, {
        'collab': {'autoStart': 'control', 'relayUrl': 'ws://127.0.0.1:' + str(cfg['relay_port']), 'webUrl': ''},
        'disabledProviders': DISABLED_DISCOVERY, 'enabledProviders': [],
        'mcp': {'enableProjectConfig': True},
    })
    prompt = omp_dir / 'native-role-prompt.txt'
    write_private(prompt, cfg['role_prompt'] + '\n\n'
        + 'Execution boundary for role ' + cfg['role'] + ':\n'
        + 'The authoritative LOCAL worktree root is ' + cfg['root'] + '.\n'
        + 'You are executing on a remote machine in a neutral control directory, not that worktree.\n'
        + 'All project filesystem reads, searches, edits, and commands MUST use only the local-worktree MCP server.\n'
        + 'Never treat remote paths as a worktree copy. Do not clone or mirror source.\n'
        + 'If local-worktree MCP is unavailable, report the unavailable capability; do not substitute remote tools.\n')
    return overlay, prompt


def host_arguments(cfg, executable, overlay, prompt, state):
    provider, model_id = cfg['model'].split('/', 1)
    args = [executable, '--cwd', cfg['control_dir'], '--config', str(overlay),
            '--provider', provider, '--model', model_id, '--thinking', cfg['thinking'],
            '--session-dir', cfg['session_dir'], '--system-prompt', str(prompt),
            '--append-system-prompt', '', '--no-tools', '--no-lsp', '--no-extensions',
            '--no-rules', '--no-skills', '--no-title']
    if state and state.get('sessionId'):
        path = session_file(cfg, state['sessionId'])
        if not path or (state.get('sessionFile') and state['sessionFile'] != path):
            raise LauncherError('Recorded native session is not durably available for exact resume')
        args.extend(['--resume', path])
    return args


def host(cfg):
    host_config(cfg)
    require_plugin_free(cfg, omp_environment(cfg))
    control = private_dir(cfg['control_dir'])
    omp_dir = private_dir(control / '.omp')
    # Keep ownership across exec; no second launcher can replace live config/state.
    lock_fd = os.open(omp_dir / 'native-host.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        raise LauncherError('This configured host is already running') from None
    try:
        overlay, prompt = prepare_host(cfg)
        executable, env = omp_executable(), omp_environment(cfg)
        inventory = run_json([executable, 'models', 'ls', '--json', '--no-extensions',
                              '--config', str(overlay)], cfg['control_dir'], env)
        if not any(isinstance(row, dict) and row.get('provider', '') + '/' + row.get('id', '') == cfg['model']
                   for row in inventory.get('models', [])):
            raise LauncherError('Explicit model is unavailable in the remote native OMP inventory')
        with state_lock(cfg):
            previous = load_state(cfg)
            args = host_arguments(cfg, executable, overlay, prompt, previous)
            write_private(state_path(cfg), {
                'version': 1, 'identity': {key: cfg[key] for key in ('role', 'root', 'control_dir', 'session_dir')},
                'pid': os.getpid(), 'instanceId': None,
                'sessionId': previous.get('sessionId') if previous else None,
                'sessionFile': previous.get('sessionFile') if previous else None,
            })
        os.set_inheritable(lock_fd, True)
        os.chdir(control)
        os.execve(executable, args, env)
    finally:
        os.close(lock_fd)


def select_snapshot(cfg, state, data):
    if data.get('version') != 1 or not isinstance(data.get('hosts'), list):
        raise LauncherError('Unsupported native Collab registry response')
    candidates = [row for row in data['hosts'] if isinstance(row, dict)
                  and row.get('cwd') == cfg['control_dir'] and row.get('pid') == state.get('pid')]
    if len(candidates) > 1:
        raise LauncherError('Ambiguous native Collab host identity')
    if not candidates:
        return None
    row = candidates[0]
    if state.get('instanceId') and row.get('instanceId') != state['instanceId']:
        raise LauncherError('Native Collab instance identity changed')
    if state.get('sessionId') and row.get('sessionId') != state['sessionId']:
        raise LauncherError('Native Collab session identity changed')
    if not isinstance(row.get('sessionId'), str) or not row['sessionId'] or not isinstance(row.get('instanceId'), str):
        raise LauncherError('Native Collab host has invalid identity metadata')
    if type(row.get('generation')) is not int or row['generation'] < 1:
        raise LauncherError('Native Collab host has invalid generation metadata')
    # Explicit allowlist: no session names, links, keys, endpoints or arbitrary fields.
    result = {key: row.get(key) for key in ('instanceId', 'generation', 'pid', 'sessionId', 'cwd',
              'startedAt', 'participants', 'relayConnected', 'inputRequired', 'access')}
    result['busy'] = row.get('busy') if type(row.get('busy')) is bool else None
    model = row.get('model')
    result['model'] = ({key: model.get(key) for key in ('provider', 'id')}
                       if isinstance(model, dict) else None)
    return result


def snapshot(cfg):
    host_config(cfg)
    with state_lock(cfg):
        state = load_state(cfg)
        if not state:
            return {'version': 1, 'host': None}
        data = run_json([omp_executable(), 'collab', 'list', '--json'],
                        cfg['control_dir'], omp_environment(cfg))
        selected = select_snapshot(cfg, state, data)
        if selected:
            state.update(instanceId=selected['instanceId'], sessionId=selected['sessionId'])
            durable = session_file(cfg, selected['sessionId'])
            if state.get('sessionFile') and durable != state['sessionFile']:
                raise LauncherError('Recorded session file identity changed')
            state['sessionFile'] = durable
            write_private(state_path(cfg), state)
        return {'version': 1, 'host': selected}


def validate_join_url(value, expected_port=None):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 33 for c in value):
        raise LauncherError('Invalid private Collab link')
    try:
        outer = urlsplit(value)
        link = urlsplit(outer.fragment) if outer.scheme == 'http' and outer.fragment else outer
        for url in (outer, link):
            if url.scheme not in ('http', 'ws') or url.hostname != '127.0.0.1' or not url.port:
                raise ValueError()
            if url.username or url.password or url.query or (expected_port and url.port != expected_port):
                raise ValueError()
        if link.fragment or (outer != link and (outer.path not in ('', '/') or outer.port != link.port)):
            raise ValueError()
        match = re.fullmatch(r'/r/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)', link.path)
        if not match or len(base64.urlsafe_b64decode(match[2] + '=' * (-len(match[2]) % 4))) != 48:
            raise ValueError()
    except (ValueError, TypeError):
        raise LauncherError('Private link must be a native full-control loopback Collab URL') from None
    return value


def fetch_link(cfg, instance_id, generation, output):
    """Capture a capability privately, rejecting CLI's internally re-listed successor."""
    selected = snapshot(cfg)['host']
    if not selected or selected['instanceId'] != instance_id or selected['generation'] != generation:
        raise LauncherError('Selected native Collab generation is stale')
    data = run_json([omp_executable(), 'collab', 'link', instance_id, '--json'],
                    cfg['control_dir'], omp_environment(cfg))
    if data.get('version') != 1 or data.get('instanceId') != instance_id or data.get('generation') != generation:
        raise LauncherError('Selected native Collab generation is stale')
    if data.get('access') != 'control':
        raise LauncherError('Native Collab host did not grant control access')
    url = validate_join_url(data.get('url'), cfg['relay_port'])
    write_private(output, {'join_url': url, 'control_dir': str(Path(output).parent / 'native-guest')})


def client(cfg):
    url = validate_join_url(cfg.get('join_url'))
    executable = omp_executable()
    control = private_dir(cfg['control_dir'])
    overlay = control / 'guest-overlay.yml'
    write_private(overlay, {'disabledProviders': [*DISABLED_DISCOVERY, 'mcp-json'],
                            'enabledProviders': [], 'mcp': {'enableProjectConfig': False},
                            'collab': {'autoStart': 'off'}})
    env = omp_environment({'isolate_plugins': True, 'control_dir': str(control)})
    require_plugin_free({'control_dir': str(control)}, env)
    env['PI_CONFIG_FILES'] = str(overlay)
    # Native join accepts only argv. Do not print, log, or shell-interpolate it.
    os.execve(executable, [executable, 'join', url], env)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('host', 'snapshot', 'client', 'link'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--instance-id')
    parser.add_argument('--generation', type=int)
    parser.add_argument('--output')
    args = parser.parse_args(argv)
    try:
        cfg = read_private(args.config)
        if args.mode == 'host':
            host(cfg)
        elif args.mode == 'snapshot':
            print(json.dumps(snapshot(cfg), ensure_ascii=False))
        elif args.mode == 'client':
            client(cfg)
        else:
            if not args.instance_id or args.generation is None or args.generation < 1 or not args.output:
                raise LauncherError('link requires instance-id, positive generation and private output')
            fetch_link(cfg, args.instance_id, args.generation, args.output)
        return 0
    except LauncherError as error:
        print('Native OMP: ' + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        # Native/process/file errors may contain capability URLs or tokens.
        print('Native OMP operation failed; private details were suppressed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
