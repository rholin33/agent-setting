#!/usr/bin/env python3
"""Install a selected configuration scope from this checkout, without Git writes."""
import argparse
import importlib.util
import subprocess
import sys
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

RULE_HEADING = '## Orca 任务派发约束'


def rule_section(text):
    match = re.search(r'^' + re.escape(RULE_HEADING) + r'\n.*?(?=^#{1,2} |\Z)', text, re.M | re.S)
    if not match:
        raise ValueError('Orca dispatch rule section is missing')
    return match.group().strip() + '\n'


def install_orca_rules(root, sync):
    section = rule_section((root / 'codex/AGENTS.orca.md').read_text(encoding='utf-8'))
    if rule_section((root / 'pi/AGENTS.md').read_text(encoding='utf-8')) != section:
        raise ValueError('Codex and Pi Orca dispatch rules differ')
    omp = Path(os.environ.get('OMP_AGENT_DIR', str(Path.home() / '.omp/agent'))).expanduser()
    homes = [(sync.CODEX_HOME, 'codex'), (sync.PI_HOME, 'pi'), (omp, 'pi'),
             (sync.CLAUDE_HOME, 'claude')]
    pending = {}
    for home, source in homes:
        if source != 'claude':
            target = home / 'AGENTS.md'
            text = target.read_text(encoding='utf-8-sig') if target.exists() else ''
            pattern = r'^' + re.escape(RULE_HEADING) + r'\n.*?(?=^#{1,2} |\Z)'
            updated = re.sub(pattern, lambda _: section + '\n', text, flags=re.M | re.S) if RULE_HEADING in text else section + '\n' + text
            pending[target] = updated.encode('utf-8')
        skill = root / source / 'skills/agent-setting-sync/SKILL.md'
        pending[home / 'skills/agent-setting-sync/SKILL.md'] = skill.read_bytes()
    for target in pending:
        if any(p.is_symlink() or getattr(p, 'is_junction', lambda: False)() for p in (target, *target.parents)):
            raise ValueError('Linked rule destination refused: ' + str(target))
    backup = sync.BACKUP_ROOT / ('orca-rules-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    for index, (target, content) in enumerate(pending.items()):
        if target.exists() and target.read_bytes() == content:
            continue
        if target.exists():
            backup.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup / (str(index) + '-' + target.name))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if target.read_bytes() != content:
            raise RuntimeError('Rule installation verification failed: ' + str(target))
        print('Installed rule/skill:', target)
    print('Rule backup:', backup)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('ccb', 'orca'), required=True)
    parser.add_argument('--force', action='store_true', help='back up and replace managed local files')
    parser.add_argument('--offline', action='store_true', help='use an already verified pinned source cache; upstream freshness is not checked')
    parser.add_argument('--rules-only', action='store_true', help='install Orca dispatch rules and sync skill only; preserve runtime and other configuration')
    parser.add_argument('--quick-commands', action='store_true')
    parser.add_argument('--shell-profile', type=Path, help='append a backed-up managed Orca entry block')
    args = parser.parse_args()
    if sum(arg == '--target' or arg.startswith('--target=') for arg in sys.argv[1:]) != 1:
        parser.error('select exactly one --target')
    if (args.quick_commands or args.shell_profile) and args.target != 'orca':
        parser.error('Orca entry options require --target orca')
    if args.rules_only and (args.target != 'orca' or args.force or args.offline or args.quick_commands or args.shell_profile):
        parser.error('--rules-only requires --target orca without other installation modes')
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('sync', root / 'codex/hooks/sync-codex-setting.py')
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
    sync.TARGET = args.target
    sync.REMOTE_REPO = root
    sync.INCLUDE_UNTRACKED = True
    if args.rules_only:
        install_orca_rules(root, sync)
        print('Installed Orca rules only. Runtime and other configuration unchanged; no commit or push.')
        return
    sync.validate_remote_layout()
    if args.target == 'orca':
        print('Orca runtime:', sync.orca_runtime_module().install(root, sync.ORCA_HOME, offline=args.offline))
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
