#!/usr/bin/env python3
"""Install a selected configuration scope from this checkout, without Git writes."""
import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('ccb', 'orca'), required=True)
    parser.add_argument('--force', action='store_true', help='back up and replace managed local files')
    parser.add_argument('--quick-commands', action='store_true')
    parser.add_argument('--shell-profile', type=Path, help='append a backed-up managed Orca entry block')
    args = parser.parse_args()
    if sum(arg == '--target' or arg.startswith('--target=') for arg in sys.argv[1:]) != 1:
        parser.error('select exactly one --target')
    if (args.quick_commands or args.shell_profile) and args.target != 'orca':
        parser.error('Orca entry options require --target orca')
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('sync', root / 'codex/hooks/sync-codex-setting.py')
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
    sync.TARGET = args.target
    sync.REMOTE_REPO = root
    sync.INCLUDE_UNTRACKED = True
    sync.validate_remote_layout()
    if args.force:
        sync.force_sync_managed_files()
    else:
        sync.merge_managed_files()
    if args.target == 'orca':
        command = ['node', str(sync.ORCA_HOME / 'bin/orca-team.mjs'), 'install', '--home', str(sync.ORCA_HOME)]
        if args.quick_commands:
            command.append('--quick-commands')
        if args.shell_profile:
            command.extend(['--shell-profile', str(args.shell_profile.expanduser().resolve())])
        subprocess.run(command, check=True)
    else:
        sync.install_packaged_roles()
        sync.install_required_roles()
    print(f'Installed {args.target} and common configuration. No commit or push.')


if __name__ == '__main__':
    main()
