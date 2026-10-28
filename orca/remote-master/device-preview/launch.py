#!/usr/bin/env python3
"""Standalone co session; never alters or resumes the reviewer host."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE.parent))
from native_omp import DISABLED_DISCOVERY, omp_environment, require_plugin_free, private_dir, write_private
from service import Service, policy, orca


def run_id(value):
    if isinstance(value, dict):
        for key in ('runId', 'run_id'):
            if isinstance(value.get(key), str):
                return value[key]
        if isinstance(value.get('run'), dict):
            return value['run'].get('id') or run_id(value['run'])
    return None


def prepare():
    cfg = policy()
    control = private_dir(Path.home() / '.orca/device-preview-session-20261022')
    sessions = private_dir(control / 'sessions')
    env = omp_environment({'control_dir': str(control), 'isolate_plugins': True})
    require_plugin_free({'control_dir': str(control)}, env)
    overlay = control / 'overlay.json'
    write_private(overlay, {'disabledProviders': DISABLED_DISCOVERY, 'enabledProviders': [],
                          'mcp': {'enableProjectConfig': True}})
    write_private(control / 'mcp.json', {'mcpServers': {'device-preview': {
        'type': 'stdio', 'command': sys.executable,
        'args': [str(SOURCE / 'service.py'), '--session', str(control / 'binding.json')],
        'timeout': 60000}}})
    # Capture the test model selection without copying its role or runtime config.
    team = json.loads((SOURCE.parent.parent / 'team.json').read_text())
    test = next(row for row in team if row['name'] == 'test')
    argv = [str(Path.home() / '.local/bin/omp'), '--cwd', str(control),
            '--config', str(overlay), '--model', test['model'], '--thinking', test['thinking'],
            '--session-dir', str(sessions), '--system-prompt', str(SOURCE / 'role.md'),
            '--append-system-prompt', '', '--no-tools', '--no-lsp', '--no-extensions',
            '--no-rules', '--no-skills', '--no-title']
    return control, env, argv


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    control, env, argv = prepare()
    if args.prepare:
        print(json.dumps({'prepared': True, 'control': str(control), 'argv': argv}))
    else:
        # This process runs INSIDE its newly created Orca terminal. Never borrow --from.
        binding = control / 'binding.json'
        if binding.exists():
            raise SystemExit('Existing task session binding; inspect before creating another session')
        intent = control / 'run-intent.json'
        if intent.exists():
            raise SystemExit('Run creation uncertain; inspect before retry')
        write_private(intent, {'objective': 'Device preview configuration capability verification only'})
        created = orca(['orchestration', 'run-create', '--objective',
                        'Device preview configuration capability verification only'], control)
        identifier = run_id(created)
        if not identifier:
            write_private(control / 'run-receipt.json', created)
            raise SystemExit('Run receipt needs inspection; no second creation attempted')
        write_private(binding, {'run_id': identifier, 'nonce': secrets.token_hex(8)})
        env['OMP_MCP_REQUIRE_READY'] = '1'
        os.chdir(control)
        os.execve(argv[0], argv, env)
