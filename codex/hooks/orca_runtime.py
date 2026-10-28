"""Pinned Orca source installation and publication checks, without agent restarts."""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

REPOSITORY = 'https://github.com/rholin33/orca-team.git'
DIRECTORIES = {'bin', 'lib', 'source', 'tests', 'docs', 'remote-master'}
FILES = {'package.json', 'README.md', 'FILE-INVENTORY.json'}
RECEIPT = '.runtime-install.json'


def git(source, *args, content=None):
    result = subprocess.run(['git', '-C', str(source), *args], input=content, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace').strip())
    return result.stdout


def read_pin(config):
    pin = json.loads((Path(config) / 'orca/runtime.json').read_text(encoding='utf-8'))
    if (pin.get('version') != 1 or pin.get('repository') != REPOSITORY
            or not re.fullmatch('[0-9a-f]{40}', pin.get('commit', ''))):
        raise ValueError('Invalid Orca runtime pin: canonical repository and full commit required')
    return pin


def source_path():
    codex = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    return Path(os.environ.get('ORCA_SOURCE_REPO', str(codex / '.sync/orca-team/source'))).expanduser()


def runtime_path(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    if any(p.lower() in {'.git', 'node_modules', 'runtime', 'backups', '__pycache__', 'sessions', 'credentials', 'logs'} for p in path.parts):
        return False
    if re.search(r'\.(bak|backup)([.-]|$)', path.name.lower()):
        return False
    if path.name.lower() in {'.ds_store', '.env', 'auth.json', 'credentials.json', 'state.json', 'token.json'} or path.suffix in {'.pyc', '.log', '.lock', '.db', '.sqlite'}:
        return False
    if path.as_posix() in {'bin/orca-team', 'bin/orca-team.ps1'}:
        return False
    if path.parts[0] == 'remote-master' and path.suffix not in {'.py', '.ts'}:
        return path.as_posix() in {'remote-master/device-preview/' + p for p in ('README.md', 'role.md', 'policy.json')}
    return path.parts[0] in DIRECTORIES or path.as_posix() in FILES


def prepare(config, source=None, offline=False, allow_dirty=False):
    pin = read_pin(config)
    source = Path(source or source_path()).resolve()
    if not (source / '.git').exists():
        if offline:
            raise RuntimeError('Pinned Orca source cache missing; online sync required')
        source.parent.mkdir(parents=True, exist_ok=True)
        account = subprocess.run(['git', '-C', str(config), 'config', '--get',
                                  'credential.https://github.com.username'], capture_output=True).stdout.decode().strip()
        options = ['-c', 'credential.https://github.com.username=' + account] if account else []
        result = subprocess.run(['git', *options, 'clone', REPOSITORY, str(source)], capture_output=True)
        if result.returncode:
            raise RuntimeError('Orca source clone failed: ' + result.stderr.decode('utf-8', errors='replace'))
        if account:
            git(source, 'config', 'credential.https://github.com.username', account)
    if git(source, 'remote', 'get-url', 'origin').decode().strip() != REPOSITORY:
        raise RuntimeError('Orca source origin mismatch')
    if not allow_dirty and git(source, 'status', '--porcelain').strip():
        raise RuntimeError('Orca source checkout has unpublished changes; review/publish before sync')
    if not offline:
        git(source, 'fetch', 'origin', 'main')
    latest = git(source, 'rev-parse', 'refs/remotes/origin/main').decode().strip()
    git(source, 'merge-base', '--is-ancestor', 'HEAD', latest)
    git(source, 'merge-base', '--is-ancestor', pin['commit'], latest)
    return source, pin, {'commit': pin['commit'], 'latest': latest,
                         'update_available': latest != pin['commit'], 'upstream_checked': not offline}


def snapshot(source, commit):
    records = git(source, 'ls-tree', '-r', '-z', commit).split(b'\0')
    selected = {}
    for record in filter(None, records):
        metadata, raw = record.split(b'\t', 1)
        mode, kind, oid = metadata.split()
        name = raw.decode('utf-8')
        if runtime_path(name):
            if mode not in {b'100644', b'100755'} or kind != b'blob':
                raise ValueError('Runtime contains a non-regular file: ' + name)
            selected[name] = oid
    if 'bin/orca-team.mjs' not in selected:
        raise ValueError('Pinned runtime has no command entry')
    stream = git(source, 'cat-file', '--batch', content=b'\n'.join(selected.values()) + b'\n')
    offset = 0
    contents = {}
    for name in selected:
        end = stream.index(b'\n', offset)
        size = int(stream[offset:end].split()[2])
        contents[name] = stream[end + 1:end + 1 + size]
        offset = end + size + 2
    return contents


def live_files(home):
    home = Path(home)
    result = {}
    for name in DIRECTORIES | FILES:
        root = home / name
        for path in ([root] if root.is_file() else root.rglob('*')):
            relative = path.relative_to(home).as_posix()
            if path.is_file() and runtime_path(relative):
                if path.is_symlink() or any(p.is_symlink() for p in path.parents):
                    raise ValueError('Linked runtime path: ' + relative)
                result[relative] = path.read_bytes()
    return result


def digest(content):
    # Code deployments may have native line endings; binary resources stay exact.
    return hashlib.sha256(content if b'\0' in content else content.replace(b'\r\n', b'\n')).hexdigest()


def assert_matches(home, expected):
    live = live_files(home)
    differences = [name for name in sorted(live.keys() | expected.keys())
                   if name not in live or name not in expected or digest(live[name]) != digest(expected[name])]
    if differences:
        raise RuntimeError('Unpublished local runtime changes:\n' + '\n'.join(differences))


def check(config, home, source=None, offline=False):
    source, pin, report = prepare(config, source, offline)
    assert_matches(home, snapshot(source, pin['commit']))
    return report


def install(config, home, source=None, offline=False):
    source, pin, report = prepare(config, source, offline)
    home = Path(home)
    pending = snapshot(source, pin['commit'])
    receipt_file = home / RECEIPT
    live = live_files(home)
    prior = json.loads(receipt_file.read_text(encoding='utf-8')) if receipt_file.exists() else None
    expected = prior['files'] if prior else {name: digest(content) for name, content in pending.items()}
    problems = [name for name, content in live.items() if expected.get(name) != digest(content)]
    if prior:
        problems += [name for name in expected if name not in live]
    if problems:
        raise RuntimeError('Unpublished local runtime changes:\n' + '\n'.join(sorted(set(problems))))
    # Preflight every target before modifying the installation.
    for name in pending:
        target = home / name
        if target.is_symlink() or any(p.is_symlink() for p in target.parents):
            raise ValueError('Linked runtime destination: ' + name)
    backup = home / 'backups' / ('runtime-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    for name in live.keys() - pending.keys():
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(home / name), str(target))
    for name, content in pending.items():
        target = home / name
        if target.exists() and target.read_bytes() == content:
            continue
        if target.exists():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    receipt_file.write_text(json.dumps({**pin, 'files': {n: digest(c) for n, c in pending.items()}}, indent=2) + '\n', encoding='utf-8')
    return report


def export(config, home, source=None, offline=False):
    source, pin, report = prepare(config, source, offline, allow_dirty=True)
    if git(source, 'branch', '--show-current').decode().strip() != 'main':
        raise RuntimeError('Runtime export requires source main branch')
    # Refuse to overwrite independent source development or diverged history.
    if git(source, 'status', '--porcelain').strip():
        raise RuntimeError('Runtime source is dirty; merge source edits before exporting live code')
    git(source, 'merge', '--ff-only', 'refs/remotes/origin/main')
    live = live_files(home)
    if 'bin/orca-team.mjs' not in live:
        raise RuntimeError('Local runtime entry missing')
    base = snapshot(source, pin['commit'])
    upstream = snapshot(source, report['latest'])
    pending = {}
    for name in sorted(base.keys() | upstream.keys() | live.keys()):
        b, remote, local = base.get(name), upstream.get(name), live.get(name)
        equivalent = lambda a, z: a is None and z is None or a is not None and z is not None and digest(a) == digest(z)
        if equivalent(local, b): chosen = remote
        elif equivalent(remote, b) or equivalent(local, remote): chosen = local
        else: raise RuntimeError('Runtime merge decision required: ' + name)
        if chosen is None:
            raise RuntimeError('Runtime deletion requires explicit review: ' + name)
        pending[name] = chosen
    for name, content in pending.items():
        target = source / name
        if target.is_symlink() or any(p.is_symlink() for p in target.parents):
            raise ValueError('Linked source destination: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (source / '.git/agent-setting-runtime-export.json').write_text(json.dumps({
        'base': report['latest'], 'files': {n: digest(c) for n, c in pending.items()},
        'live': {n: digest(c) for n, c in live.items()}}, indent=2), encoding='utf-8')
    return {**report, 'exported': len(pending), 'source': str(source)}


def pin_published(config, home, source=None, offline=False):
    source, old_pin, report = prepare(config, source, offline)
    sha = git(source, 'rev-parse', 'HEAD').decode().strip()
    if sha != report['latest']:
        raise RuntimeError('Source HEAD is not verified origin/main; publish source first')
    expected = snapshot(source, sha)
    try:
        assert_matches(home, expected)
    except RuntimeError:
        manifest = json.loads((source / '.git/agent-setting-runtime-export.json').read_text(encoding='utf-8'))
        if manifest['files'] != {n: digest(c) for n, c in expected.items()} or manifest['live'] != {n: digest(c) for n, c in live_files(home).items()}:
            raise RuntimeError('Runtime changed since review; export/review again before pinning')
        backup = Path(home) / 'backups' / ('published-runtime-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        for name, content in expected.items():
            target = Path(home) / name
            if target.exists() and digest(target.read_bytes()) == digest(content): continue
            if target.exists():
                saved = backup / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        assert_matches(home, expected)
    pin = {**old_pin, 'commit': sha}
    (Path(config) / 'orca/runtime.json').write_text(json.dumps(pin, indent=2) + '\n', encoding='utf-8')
    (Path(home) / RECEIPT).write_text(json.dumps({**pin, 'files': {n: digest(c) for n, c in expected.items()}}, indent=2) + '\n', encoding='utf-8')
    return {**report, 'commit': sha, 'update_available': False}


def verify_export(source=None, committed=False):
    source = Path(source or source_path())
    manifest = json.loads((source / '.git/agent-setting-runtime-export.json').read_text(encoding='utf-8'))
    tree = 'HEAD' if committed else git(source, 'write-tree').decode().strip()
    actual = {n: digest(c) for n, c in snapshot(source, tree).items()}
    if actual != manifest['files']:
        raise RuntimeError('Incomplete runtime export in ' + tree)
    return {'verified': len(actual), 'tree': tree}
