#!/usr/bin/env python3
"""Codex execution adapter for the existing scoped worktree MCP bridge.

Uses the remote machine's configured Codex launcher and provider in place;
never copies provider credentials or changes the global Codex configuration.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from bridge import BridgeServer, private_json


RESTRICTED_FEATURES = (
    'shell_tool', 'unified_exec', 'apply_patch_freeform', 'js_repl',
    'multi_agent', 'multi_agent_v2', 'multi_agent_mode', 'hooks',
    'codex_hooks', 'plugin_hooks', 'code_mode', 'powershell',
)


def codex_command(config, session_id=None):
    # Invoke the user's existing shell function, not a different PATH-selected
    # binary. Its Node version/provider setup remains on the remote machine.
    args = ['/bin/zsh', '-lic', 'codex "$@"', 'master-codex-remote', 'exec',
            '--json', '--skip-git-repo-check', '--ignore-rules', '--color', 'never']
    overrides = {
        'sandbox_mode': 'read-only',
        'approval_policy': 'never',
        'web_search': 'disabled',
        'developer_instructions': config['role_prompt'],
    }
    for key, value in overrides.items():
        args += ['-c', key + '=' + json.dumps(value, ensure_ascii=False)]
    # Replace the MCP table for this invocation instead of importing unrelated
    # user/project MCP servers. The bearer is read from an environment variable,
    # never placed in process arguments.
    mcp = '{worktree={url=' + json.dumps(config['local_url'] + '/mcp')
    mcp += ',bearer_token_env_var="MASTER_WORKTREE_MCP_TOKEN",required=true'
    mcp += ',default_tools_approval_mode="approve",enabled_tools=['
    mcp += '"workspace_info","list_files","read_file","write_document",'
    mcp += '"list_roles","read_role","send_role"'
    if config.get('code_write_enabled'):
        mcp += ',"write_file","edit_file"'
    mcp += ']}}'
    args += ['-c', 'mcp_servers=' + mcp]
    for name in RESTRICTED_FEATURES:
        if name in config['supported_features']:
            args += ['-c', 'features.' + name + '=false']
    if session_id:
        args += ['resume', session_id, '-']
    else:
        args += ['-']
    return args


def decode_events(stdout):
    result = {'session_id': None, 'text': '', 'completed': False, 'failed': False, 'tool_calls': []}
    messages = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # Remote shell startup banners are not Codex events.
        if not isinstance(event, dict):
            continue
        kind = event.get('type')
        if kind == 'thread.started':
            result['session_id'] = event.get('thread_id')
        elif kind == 'turn.completed':
            result['completed'] = True
        elif kind in ('turn.failed', 'error'):
            result['failed'] = True
        elif kind == 'item.completed':
            item = event.get('item', {})
            if item.get('type') == 'agent_message':
                messages.append(item.get('text', ''))
            elif item.get('type') == 'mcp_tool_call':
                result['tool_calls'].append({'server': item.get('server'), 'tool': item.get('tool'), 'status': item.get('status')})
    result['text'] = '\n\n'.join(messages)
    return result


class CodexServer(BridgeServer):
    def execute(self, turn_id, prompt):
        turn = self.turns[turn_id]
        started = time.monotonic()
        try:
            # A resumed Codex thread retains its initial developer instructions.
            # Expanded authority needs a fresh thread; preserve the old history.
            filename = 'session-code.json' if self.config.get('code_write_enabled') else 'session.json'
            state_path = Path(self.config_path).with_name(filename)
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
            env = dict(os.environ, MASTER_WORKTREE_MCP_TOKEN=self.config['token'])
            # Codex may discover the macOS system proxy even without proxy
            # environment variables. Only the two authorized tailnet peers
            # bypass it; model-provider egress retains the user's settings.
            for key in ('NO_PROXY', 'no_proxy'):
                peers = self.config['peer'] + ',' + self.config['bind']
                env[key] = ','.join(filter(None, (env.get(key, ''), peers)))
            proc = subprocess.Popen(codex_command(self.config, state.get('session_id')),
                                    cwd=self.config['control_dir'], env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, start_new_session=True)
            turn['pid'] = proc.pid
            try:
                stdout, stderr = proc.communicate(prompt, timeout=600)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.communicate()
                raise ValueError('Remote Codex timed out; no automatic retry')
            result = decode_events(stdout)
            sid = result['session_id'] or state.get('session_id')
            if sid:
                private_json(state_path, {'session_id': sid})
            passed = proc.returncode == 0 and result['completed'] and not result['failed'] and bool(result['text'])
            diagnostic = None
            if not passed:
                # Fixed categories only: never forward raw stderr, URLs, prompts
                # or provider response bodies into the console or diagnostics.
                text = (stdout + stderr).lower()
                if 'unauthorized' in text or '401' in text or 'not logged in' in text:
                    diagnostic = 'remote_authentication'
                elif 'unexpected argument' in text or 'invalid value' in text or 'unknown variant' in text:
                    diagnostic = 'cli_configuration'
                elif 'mcp' in text and ('failed' in text or 'error' in text):
                    diagnostic = 'mcp_connection'
                else:
                    diagnostic = 'remote_execution'
            turn.update(status='completed' if passed else 'failed',
                        text=result['text'] if passed else 'Remote Codex request failed; category: ' + diagnostic,
                        session_id=sid, duration_ms=int((time.monotonic() - started) * 1000),
                        provider='codex', tool_calls=result['tool_calls'], exit_code=proc.returncode)
        except Exception as exc:
            turn.update(status='failed', text=str(exc) if isinstance(exc, ValueError) else 'Remote Codex execution unavailable')
        finally:
            with self.lock:
                self.active = False
            turn['event'].set()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    if 'shell_tool' not in cfg['supported_features']:
        raise SystemExit('Cannot enforce Codex shell-tool restriction')
    server = CodexServer(cfg, 'remote', args.config)
    print(f"Remote Codex master ready on {cfg['bind']}:{cfg['port']}", flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
