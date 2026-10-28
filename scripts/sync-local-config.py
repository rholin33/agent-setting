#!/usr/bin/env python3
"""Export one explicitly selected portable scope; never commit or push Git."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sync_config", REPO_ROOT / "codex/hooks/sync-codex-setting.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def agents_export_would_clobber(relative, content, destination) -> bool:
    """True when writing content would overwrite the other target's distinct variant."""
    other = next(target for target in ('ccb', 'orca') if target != sync.TARGET)
    other_path = destination / sync.codex_agents_variant_relative(other)
    own_path = destination / relative
    return other_path.is_file() and other_path.read_bytes() == content and own_path.is_file() and own_path.read_bytes() != content


def export_candidates():
    for prefix, home, files, directories in (
        (Path('codex'), sync.CODEX_HOME, sync.CODEX_MANAGED_FILES, sync.CODEX_MANAGED_DIRECTORIES),
        (Path('pi'), sync.PI_HOME, sync.PI_MANAGED_FILES, sync.PI_MANAGED_DIRECTORIES),
        (Path('claude'), sync.CLAUDE_HOME, sync.CLAUDE_MANAGED_FILES, sync.CLAUDE_MANAGED_DIRECTORIES),
    ):
        for name in files:
            relative = prefix / name
            if prefix == sync.CODEX_CONFIG_DIR and name == 'AGENTS.md':
                relative = sync.codex_agents_variant_relative(sync.TARGET)
            yield relative, home / name
        for directory in directories:
            root = home / directory
            if root.is_symlink():
                continue
            for source in root.rglob('*'):
                yield prefix / source.relative_to(home), source
    if sync.TARGET == 'ccb':
        yield sync.CCB_CONFIG_RELATIVE_PATH, sync.CCB_HOME / 'ccb.config'
        project_ccb = sync.get_project_ccb_relative_path()
        if project_ccb:
            yield project_ccb, sync.get_project_root() / '.ccb/ccb.config'
        project_pi = sync.get_project_pi_relative_root()
        if project_pi:
            yield project_pi / 'settings.json', sync.get_project_root() / 'pi/settings.json'
    else:
        yield sync.MAGIC_CONTEXT_RELATIVE, sync.MAGIC_CONTEXT_HOME / "magic-context.jsonc"
        for name in sync.ORCA_PACKAGE_FILES:
            yield Path('orca') / name, sync.ORCA_HOME / name
        for name in sync.ORCA_PACKAGE_DIRECTORIES:
            root = sync.ORCA_HOME / name
            if root.is_symlink():
                continue
            for source in root.rglob('*'):
                yield Path('orca') / source.relative_to(sync.ORCA_HOME), source


def collect_configuration(destination: Path) -> dict[Path, bytes]:
    """Collect and validate the complete live scope without writing anything."""
    pending = {}
    for relative, source in export_candidates():
        if (not source.is_file() or source.is_symlink() or relative.name.lower() == '.ds_store'
                or not sync.is_portable_path(relative)):
            continue
        # Never follow a linked parent into credentials or another installation.
        if any(parent.is_symlink() for parent in source.parents):
            continue
        target = destination / relative
        if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
            raise ValueError(f'export destination contains a symlink: {target}')
        if relative.parts[:2] == ('orca', 'project-configs'):
            config = sync.load_json_object(source)
            for key in ('workspace', 'project', 'projectPath', 'state', 'sessions'):
                config.pop(key, None)
            content = (json.dumps(config, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
        else:
            content = source.read_bytes()
        if sync.codex_agents_variant_target(relative) is not None and agents_export_would_clobber(relative, content, destination):
            print(f'Warning: global Codex AGENTS.md matches the other target variant; skipped {relative} to preserve it.')
            continue
        sync.validate_managed_content(relative, content)
        pending[relative] = content
    if sync.TARGET == 'orca':
        pin = destination / 'orca/runtime.json'
        if pin.is_file():
            sync.orca_runtime_module().read_pin(destination)
            pending[Path('orca/runtime.json')] = pin.read_bytes()
        entry = sync.ORCA_HOME / 'bin/orca-team.mjs'
        directory = sync.get_orca_project_directory()
        has_project_config = (directory / 'config.json').is_file() or (directory / 'team.json').is_file()
        if entry.is_file() and has_project_config:
            result = subprocess.run(['node', str(entry), 'export-config', '--home', str(sync.ORCA_HOME),
                                     '--project', str(sync.get_project_root())],
                                    capture_output=True, text=True, encoding='utf-8', check=True)
            config = json.loads(result.stdout)
            if not isinstance(config, dict):
                raise ValueError('Orca export-config must return an object')
            for key in ('workspace', 'project', 'projectPath', 'state', 'sessions'):
                config.pop(key, None)
            target = destination / 'orca/project-configs' / sync.get_project_key() / 'config.json'
            if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
                raise ValueError(f'export destination contains a symlink: {target}')
            relative = target.relative_to(destination)
            content = (json.dumps(config, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
            sync.validate_managed_content(relative, content)
            pending[relative] = content
    return pending


def export_configuration(destination: Path, pending=None) -> int:
    if pending is None:
        pending = collect_configuration(destination)
    for relative, content in pending.items():
        target = destination / relative
        sync.ensure_directory(target.parent)
        target.write_bytes(content)
    return len(pending)


def git(repo: Path, *args: str, content=None, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], input=content,
                          capture_output=True, check=check)


def head(repo: Path):
    result = git(repo, 'rev-parse', '--verify', 'HEAD', check=False)
    return result.stdout.decode().strip() if result.returncode == 0 else None


def manifest_path(repo: Path) -> Path:
    directory = git(repo, 'rev-parse', '--absolute-git-dir').stdout.decode('utf-8').strip()
    return Path(directory) / 'agent-setting-export.json'


def source_digests(pending):
    return {path.as_posix(): hashlib.sha256(content).hexdigest()
            for path, content in sorted(pending.items())}


def write_manifest(repo: Path, pending, base) -> None:
    # Hash with Git's clean filters, including Windows line ending conversion.
    blobs = {path.as_posix(): git(repo, 'hash-object', '--stdin',
                                '--path=' + path.as_posix(), content=content).stdout.decode().strip()
             for path, content in sorted(pending.items())}
    # Existing repositories may retain CRLF blobs that Git add leaves unchanged.
    raw_blobs = {path.as_posix(): git(repo, 'hash-object', '--stdin', '--no-filters',
                                    content=content).stdout.decode().strip()
                 for path, content in sorted(pending.items())}
    manifest = {'version': 1, 'target': sync.TARGET, 'repo': str(repo.resolve()),
                'project': str(sync.get_project_root().resolve()), 'base': base,
                'sources': source_digests(pending), 'blobs': blobs, 'raw_blobs': raw_blobs}
    path = manifest_path(repo)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def verify_complete(repo: Path, committed=False) -> int:
    path = manifest_path(repo)
    if not path.is_file():
        raise ValueError('Missing export manifest; run a full explicit --push export first.')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or manifest.get('target') != sync.TARGET:
        raise ValueError('Export manifest version/target mismatch; re-export the selected target.')
    if manifest.get('repo') != str(repo.resolve()) or manifest.get('project') != str(sync.get_project_root().resolve()):
        raise ValueError('Export manifest repository/project mismatch; use the original export context.')
    current = head(repo)
    base = manifest['base']
    if committed:
        if not current:
            raise ValueError('No committed HEAD to verify.')
        parents = git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.decode().split()[1:]
        if current != base and parents != ([base] if base else []):
            raise ValueError('Export base changed; review and re-export before publishing.')
    elif current != base:
        raise ValueError('Export base changed; review and re-export before staging.')

    live = source_digests(collect_configuration(repo))
    old = manifest['sources']
    problems = [f'source changed (re-export required): {name}'
                for name in sorted(live.keys() | old.keys()) if live.get(name) != old.get(name)]
    entries = {}
    if committed:
        output = git(repo, 'ls-tree', '-r', '-z', 'HEAD').stdout
    else:
        output = git(repo, 'ls-files', '--stage', '-z').stdout
    for record in output.split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        fields = metadata.decode().split()
        mode, oid, stage = (fields[0], fields[2], '0') if committed else fields
        if stage == '0' and mode in ('100644', '100755'):
            entries[name.decode('utf-8')] = oid
    label = 'HEAD' if committed else 'index'
    for name, expected in manifest['blobs'].items():
        acceptable = {expected, manifest.get('raw_blobs', {}).get(name, expected)}
        if entries.get(name) not in acceptable:
            problems.append(f'{label} missing or different: {name}')
    if problems:
        raise ValueError('Incomplete full export:\n' + '\n'.join(problems))
    return len(manifest['blobs'])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('ccb', 'orca'), action=sync.UniqueTarget, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--push', action='store_true',
                        help='explicitly authorize exporting local files; Git commit/push remain separate')
    mode.add_argument('--verify-index', action='store_true', help='verify the full export in the Git index, read-only')
    mode.add_argument('--verify-head', action='store_true', help='verify the full export in HEAD before pushing, read-only')
    parser.add_argument('--repo', type=Path, default=REPO_ROOT)
    parser.add_argument('--project', type=Path)
    args = parser.parse_args()
    sync.TARGET = args.target
    sync.REMOTE_REPO = args.repo.resolve()
    if args.project:
        sync.os.environ[sync.PROJECT_ROOT_ENV] = str(args.project.resolve())
    repo = args.repo.resolve()
    try:
        if args.push:
            if args.target == 'orca' and (repo / 'orca/runtime.json').is_file():
                print('Orca runtime:', sync.orca_runtime_module().check(repo, sync.ORCA_HOME))
            manifest_path(repo)  # Require a Git checkout before any export writes.
            base = head(repo)
            pending = collect_configuration(repo)
            count = export_configuration(repo, pending)
            write_manifest(repo, pending, base)
            print(f'Exported {count} files for {args.target}; manifest: {manifest_path(repo)}; no Git commit or push performed.')
        else:
            if args.target == 'orca' and (repo / 'orca/runtime.json').is_file():
                print('Orca runtime:', sync.orca_runtime_module().check(repo, sync.ORCA_HOME))
            count = verify_complete(repo, committed=args.verify_head)
            print(f'Complete {args.target} export verified: {count} files in {"HEAD" if args.verify_head else "index"}; no Git commit or push performed.')
    except (ValueError, SyntaxError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
