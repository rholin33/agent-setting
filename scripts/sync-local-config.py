#!/usr/bin/env python3
"""Export one explicitly selected portable scope; never commit or push Git."""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sync_config", REPO_ROOT / "codex/hooks/sync-codex-setting.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def export_candidates():
    for prefix, home, files, directories in (
        (Path('codex'), sync.CODEX_HOME, sync.CODEX_MANAGED_FILES, sync.CODEX_MANAGED_DIRECTORIES),
        (Path('pi'), sync.PI_HOME, sync.PI_MANAGED_FILES, sync.PI_MANAGED_DIRECTORIES),
    ):
        for name in files:
            yield prefix / name, home / name
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
        for name in sync.ORCA_PACKAGE_FILES:
            yield Path('orca') / name, sync.ORCA_HOME / name
        for name in sync.ORCA_PACKAGE_DIRECTORIES:
            root = sync.ORCA_HOME / name
            if root.is_symlink():
                continue
            for source in root.rglob('*'):
                yield Path('orca') / source.relative_to(sync.ORCA_HOME), source


def export_configuration(destination: Path) -> int:
    count = 0
    for relative, source in export_candidates():
        if not source.is_file() or source.is_symlink() or not sync.is_portable_path(relative):
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
            sync.ensure_directory(target.parent)
            target.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        elif source.resolve() != target.resolve():
            sync.copy_with_parents(source, target)
        count += 1
    if sync.TARGET == 'orca':
        entry = REPO_ROOT / 'orca/bin/orca-team.mjs'
        if entry.is_file():
            result = subprocess.run(['node', str(entry), 'export-config', '--home', str(sync.ORCA_HOME),
                                     '--project', str(sync.get_project_root())],
                                    capture_output=True, text=True, encoding='utf-8', check=True)
            config = json.loads(result.stdout)
            if not isinstance(config, dict):
                raise ValueError('Orca export-config must return an object')
            target = destination / 'orca/project-configs' / sync.get_project_key() / 'config.json'
            if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
                raise ValueError(f'export destination contains a symlink: {target}')
            sync.ensure_directory(target.parent)
            target.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('ccb', 'orca'), action=sync.UniqueTarget, required=True)
    parser.add_argument('--push', action='store_true', required=True,
                        help='explicitly authorize exporting local files; Git commit/push remain separate')
    parser.add_argument('--repo', type=Path, default=REPO_ROOT)
    parser.add_argument('--project', type=Path)
    args = parser.parse_args()
    sync.TARGET = args.target
    sync.REMOTE_REPO = args.repo.resolve()
    if args.project:
        sync.os.environ[sync.PROJECT_ROOT_ENV] = str(args.project.resolve())
    print(f'Exported {export_configuration(args.repo.resolve())} files for {args.target}; no Git commit or push performed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
