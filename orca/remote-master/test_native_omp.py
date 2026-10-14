#!/usr/bin/env python3
"""Offline launcher boundary tests; never starts OMP, a model, or a service."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_omp as native


class NativeOMPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.control = self.base / 'control'
        self.sessions = self.base / 'sessions'
        self.cfg = {
            'role': 'master-omp-remote', 'root': '/local/authoritative/project',
            'control_dir': str(self.control), 'session_dir': str(self.sessions),
            'model': 'openai-codex/gpt-5.3-codex', 'thinking': 'high',
            'relay_port': 18780, 'local_url': 'http://100.64.0.10:18761/mcp',
            'token': 'private-token-never-output-1234',
            'role_prompt': 'Actual supplied role resource: coordinate without coding.',
        }
        home = patch.object(Path, 'home', return_value=self.base)
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        (self.base / '.omp' / 'agent').mkdir(parents=True)
        native.private_dir(self.control)
        native.private_dir(self.control / '.omp')
        native.private_dir(self.sessions)
        self.state = {
            'version': 1,
            'identity': {key: self.cfg[key] for key in ('role', 'root', 'control_dir', 'session_dir')},
            'pid': 4242, 'instanceId': 'instance-one', 'sessionId': 'session-one', 'sessionFile': None,
        }
        self.row = {
            'instanceId': 'instance-one', 'generation': 3, 'pid': 4242,
            'sessionId': 'session-one', 'cwd': str(self.control),
            'model': {'provider': 'openai-codex', 'id': 'gpt-5.3-codex'},
            'startedAt': 1234567, 'participants': 2, 'relayConnected': True,
            'inputRequired': False, 'busy': False, 'access': 'control',
        }
        self.url = 'http://127.0.0.1:18780/#ws://127.0.0.1:18780/r/room.' + 'A' * 64

    def persist_state(self, state=None):
        native.write_private(native.state_path(self.cfg), state or self.state)

    def persist_session(self, name='exact.jsonl', session_id='session-one', cwd=None):
        path = self.sessions / name
        native.write_private(path, json.dumps({'type': 'session_title', 'title': 'private'}) + '\n'
                             + json.dumps({'type': 'session', 'id': session_id,
                                           'cwd': cwd or str(self.control)}) + '\n')
        return path

    def test_isolated_plugin_root_keeps_existing_auth_and_still_rejects_new_plugins(self):
        original = self.base / '.omp'
        (original / 'agent').mkdir(parents=True, exist_ok=True)
        (original / 'plugins' / 'node_modules').mkdir(parents=True)
        with patch.object(Path, 'home', return_value=self.base), patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(native.LauncherError):
                native.require_plugin_free(self.cfg, native.omp_environment())
            env = native.omp_environment(dict(self.cfg, isolate_plugins=True))
            self.assertEqual(env['PI_CODING_AGENT_DIR'], str(original / 'agent'))
            native.require_plugin_free(self.cfg, env)
            isolated = self.base / env['PI_CONFIG_DIR']
            self.assertFalse((isolated / 'agent').exists())
            (isolated / 'plugins' / 'node_modules').mkdir(parents=True)
            with self.assertRaises(native.LauncherError):
                native.require_plugin_free(self.cfg, env)

    def test_requires_explicit_exact_model_and_thinking(self):
        for update in ({'model': ''}, {'model': 'gpt-5'}, {'model': 'openai/*'},
                       {'model': 'openai/gpt-5:high'}, {'thinking': ''}, {'thinking': 'guess'}):
            with self.subTest(update=update), self.assertRaises(native.LauncherError):
                native.host_config(dict(self.cfg, **update))

    def test_accepts_unmounted_local_root_without_reading_it(self):
        self.assertEqual(native.host_config(self.cfg), self.cfg)

    def test_rejects_public_or_credential_bearing_mcp(self):
        for url in ('http://example.com:18761/mcp', 'http://8.8.8.8:18761/mcp',
                    'http://secret@100.64.0.10:18761/mcp',
                    'http://100.64.0.10:18761/mcp?token=secret'):
            with self.subTest(url=url), self.assertRaises(native.LauncherError):
                native.host_config(dict(self.cfg, local_url=url))

    def test_rejects_control_in_local_worktree(self):
        with self.assertRaises(native.LauncherError):
            native.host_config(dict(self.cfg, control_dir=self.cfg['root'] + '/control'))

    def test_rejects_invalid_relay_port_and_token_injection(self):
        for update in ({'relay_port': True}, {'relay_port': 0}, {'relay_port': 65536},
                       {'token': 'secret\r\nX-Injected: true'}, {'token': '${OTHER_SECRET}'}):
            with self.subTest(update=update), self.assertRaises(native.LauncherError):
                native.host_config(dict(self.cfg, **update))

    def test_private_files_and_parent_boundaries(self):
        path = self.base / 'config.json'
        native.write_private(path, {'token': self.cfg['token']})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        os.chmod(path, 0o644)
        with self.assertRaises(native.LauncherError):
            native.read_private(path)
        os.chmod(path, 0o600)
        link = self.base / 'link.json'
        link.symlink_to(path)
        for operation in (lambda: native.read_private(link), lambda: native.write_private(link, {})):
            with self.assertRaises(native.LauncherError):
                operation()
        self.assertEqual(json.loads(path.read_text()), {'token': self.cfg['token']})

    def test_prepares_only_private_mcp_and_process_overlay(self):
        overlay, prompt = native.prepare_host(self.cfg)
        config = json.loads((self.control / '.omp/mcp.json').read_text())
        self.assertEqual(list(config['mcpServers']), ['local-worktree'])
        self.assertEqual(config['mcpServers']['local-worktree'], {
            'type': 'http', 'url': self.cfg['local_url'],
            'headers': {'Authorization': 'Bearer ' + self.cfg['token']},
        })
        self.assertEqual(os.readlink(self.control / 'mcp.json'), '.omp/mcp.json')
        settings = json.loads(overlay.read_text())
        self.assertEqual(settings['collab'], {
            'autoStart': 'control', 'relayUrl': 'ws://127.0.0.1:18780', 'webUrl': '',
        })
        for provider in ('native', 'codex', 'claude', 'omp-plugins', 'agent-plugins'):
            self.assertIn(provider, settings['disabledProviders'])
        self.assertNotIn('mcp-json', settings['disabledProviders'])
        self.assertNotIn('modelRoles', settings)
        self.assertIn(self.cfg['role_prompt'], prompt.read_text())
        self.assertIn(self.cfg['root'], prompt.read_text())
        self.assertNotIn(self.cfg['token'], prompt.read_text())
        for path in (overlay, prompt, self.control / '.omp/mcp.json'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_refuses_unrelated_fallback_configuration(self):
        for filename in ('mcp.json', '.mcp.json'):
            path = self.control / filename
            native.write_private(path, {'unrelated': True})
            with self.assertRaises(native.LauncherError):
                native.prepare_host(self.cfg)
            self.assertEqual(json.loads(path.read_text()), {'unrelated': True})
            path.unlink()

    def test_interactive_command_disables_builtins_without_rpc(self):
        overlay, prompt = native.prepare_host(self.cfg)
        args = native.host_arguments(self.cfg, '/native/omp', overlay, prompt, None)
        for flag in ('--no-tools', '--no-lsp', '--no-extensions', '--no-rules', '--no-skills'):
            self.assertIn(flag, args)
        for flag in ('--print', '--mode', '--continue', '--resume'):
            self.assertNotIn(flag, args)
        self.assertNotIn(self.cfg['token'], ' '.join(args))
        self.assertNotIn(self.cfg['role_prompt'], ' '.join(args))
        self.assertEqual(args[args.index('--provider') + 1], 'openai-codex')

    def test_resume_uses_exact_recorded_header_not_latest(self):
        exact = self.persist_session()
        self.persist_session('9999-newest.jsonl', 'unrelated-session')
        overlay, prompt = native.prepare_host(self.cfg)
        args = native.host_arguments(self.cfg, '/native/omp', overlay, prompt, self.state)
        self.assertEqual(args[args.index('--resume') + 1], str(exact))

    def test_missing_or_ambiguous_session_cannot_resume(self):
        overlay, prompt = native.prepare_host(self.cfg)
        with self.assertRaises(native.LauncherError):
            native.host_arguments(self.cfg, '/native/omp', overlay, prompt, self.state)
        self.persist_session()
        self.persist_session('duplicate.jsonl')
        with self.assertRaises(native.LauncherError):
            native.host_arguments(self.cfg, '/native/omp', overlay, prompt, self.state)

    def test_session_header_and_recorded_path_must_match(self):
        path = self.persist_session(cwd='/wrong/control')
        with self.assertRaises(native.LauncherError):
            native.session_file(self.cfg, 'session-one')
        path.unlink()
        self.persist_session()
        overlay, prompt = native.prepare_host(self.cfg)
        with self.assertRaises(native.LauncherError):
            native.host_arguments(self.cfg, '/native/omp', overlay, prompt,
                                  dict(self.state, sessionFile=str(self.sessions / 'other.jsonl')))

    def test_snapshot_filters_by_exact_control_and_launch_pid(self):
        rows = [dict(self.row, cwd='/other'), dict(self.row, pid=999), self.row]
        result = native.select_snapshot(self.cfg, self.state, {'version': 1, 'hosts': rows})
        self.assertEqual(result['instanceId'], self.row['instanceId'])
        self.assertIsNone(native.select_snapshot(self.cfg, self.state, {'version': 1, 'hosts': rows[:2]}))

    def test_snapshot_refuses_ambiguous_or_changed_identity(self):
        variants = [[self.row, self.row], [dict(self.row, sessionId='new-session')],
                    [dict(self.row, instanceId='reused-pid')]]
        for rows in variants:
            with self.subTest(rows=rows), self.assertRaises(native.LauncherError):
                native.select_snapshot(self.cfg, self.state, {'version': 1, 'hosts': rows})

    def test_snapshot_does_not_leak_capabilities_or_invent_idle(self):
        row = dict(self.row, sessionName=self.url, url=self.url, token=self.cfg['token'])
        row['model'] = dict(row['model'], apiKey=self.cfg['token'])
        del row['busy']
        result = native.select_snapshot(self.cfg, self.state, {'version': 1, 'hosts': [row]})
        self.assertIsNone(result['busy'])
        self.assertNotIn(self.url, json.dumps(result))
        self.assertNotIn(self.cfg['token'], json.dumps(result))

    def test_snapshot_records_lazy_and_then_persisted_session(self):
        state = dict(self.state, instanceId=None, sessionId=None)
        self.persist_state(state)
        with patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native, 'run_json', return_value={'version': 1, 'hosts': [self.row]}):
            self.assertEqual(native.snapshot(self.cfg)['host']['sessionId'], 'session-one')
            self.assertIsNone(native.load_state(self.cfg)['sessionFile'])
            exact = self.persist_session()
            native.snapshot(self.cfg)
            self.assertEqual(native.load_state(self.cfg)['sessionFile'], str(exact))

    def test_recorded_role_identity_cannot_be_rebound(self):
        self.persist_state()
        with self.assertRaises(native.LauncherError):
            native.load_state(dict(self.cfg, role='different-role'))

    def test_link_rejects_rotation_before_and_during_fetch(self):
        output = self.base / 'join.json'
        with patch.object(native, 'snapshot', return_value={'host': self.row}), \
             patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native, 'run_json') as run:
            with self.assertRaises(native.LauncherError):
                native.fetch_link(self.cfg, 'instance-one', 2, output)
            run.assert_not_called()
            run.return_value = {'version': 1, 'instanceId': 'instance-one', 'generation': 4,
                                'access': 'control', 'url': self.url}
            with self.assertRaises(native.LauncherError):
                native.fetch_link(self.cfg, 'instance-one', 3, output)
        self.assertFalse(output.exists())

    def test_link_capture_is_private_and_silent(self):
        output = self.base / 'join.json'
        stdout = io.StringIO()
        with patch.object(native, 'snapshot', return_value={'host': self.row}), \
             patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native, 'run_json', return_value={
                 'version': 1, 'instanceId': 'instance-one', 'generation': 3,
                 'access': 'control', 'url': self.url}), contextlib.redirect_stdout(stdout):
            native.fetch_link(self.cfg, 'instance-one', 3, output)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(native.read_private(output), {
            'join_url': self.url, 'control_dir': str(self.base / 'native-guest')})
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_join_rejects_public_relay_read_only_and_nested_redirects(self):
        for url in ('room.' + 'A' * 64, self.url.replace('127.0.0.1', 'my.omp.sh'),
                    self.url[:-64] + 'A' * 43, self.url.replace('/#ws:', '/?token=secret#ws:'),
                    self.url.replace('#ws:', '#https:')):
            with self.subTest(url=url), self.assertRaises(native.LauncherError):
                native.validate_join_url(url)
        with self.assertRaises(native.LauncherError):
            native.validate_join_url(self.url, 18779)

    def test_client_execs_native_join_without_printing(self):
        stdout = io.StringIO()
        with patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native.os, 'execve') as execute, contextlib.redirect_stdout(stdout):
            native.client({'join_url': self.url, 'control_dir': str(self.control)})
        self.assertEqual(execute.call_args.args[:2], ('/native/omp', ['/native/omp', 'join', self.url]))
        self.assertEqual(stdout.getvalue(), '')

    def test_client_effective_overlay_blocks_ambient_discovery_and_auto_hosting(self):
        ambient = self.base / 'ambient.yml'
        native.write_private(ambient, {
            'enabledProviders': ['native', 'mcp-json', 'omp-plugins'],
            'collab': {'autoStart': 'control'}, 'mcp': {'enableProjectConfig': True},
        })
        plugins = self.base / '.omp/plugins/node_modules'
        plugins.mkdir(parents=True)
        (self.base / '.omp').chmod(0o700)
        native.write_private(self.base / '.omp/mcp.json', {
            'mcpServers': {'ambient-secret': {'command': 'must-not-start'}}})
        with patch.dict(os.environ, {'PI_CONFIG_FILES': str(ambient)}), \
             patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native.os, 'execve') as execute:
            native.client({'join_url': self.url, 'control_dir': str(self.control)})
        execute.assert_called_once()
        executable, argv, environment = execute.call_args.args
        self.assertEqual((executable, argv), ('/native/omp', ['/native/omp', 'join', self.url]))
        overlay = Path(environment['PI_CONFIG_FILES'])
        self.assertEqual(overlay.parent, self.control)
        self.assertNotEqual(overlay, ambient)
        effective = json.loads(overlay.read_text())
        self.assertEqual(effective['collab']['autoStart'], 'off')
        self.assertEqual(effective['mcp']['enableProjectConfig'], False)
        self.assertEqual(effective['enabledProviders'], [])
        for provider in ('native', 'mcp-json', 'omp-plugins', 'agent-plugins', 'claude-plugins'):
            self.assertIn(provider, effective['disabledProviders'])
        isolated_root = self.base / environment['PI_CONFIG_DIR']
        self.assertTrue(isolated_root.is_relative_to(self.control))
        self.assertFalse((isolated_root / 'plugins/node_modules').exists())
        self.assertTrue(Path(environment['XDG_DATA_HOME']).is_relative_to(self.control))
        self.assertEqual(environment['PI_CODING_AGENT_DIR'], str(self.base / '.omp/agent'))
        self.assertEqual(overlay.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.control.stat().st_mode & 0o777, 0o700)
        self.assertTrue(plugins.is_dir())

    def test_client_refuses_nonprivate_control_without_exec(self):
        self.control.chmod(0o755)
        with patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native.os, 'execve') as execute:
            with self.assertRaises(native.LauncherError):
                native.client({'join_url': self.url, 'control_dir': str(self.control)})
        execute.assert_not_called()

    def test_failures_do_not_echo_child_output_or_secret_config(self):
        secret = self.url + self.cfg['token']
        with patch.object(native.subprocess, 'run', side_effect=OSError(secret)):
            with self.assertRaises(native.LauncherError) as error:
                native.run_json(['/native/omp'], str(self.control), {})
            self.assertNotIn(secret, str(error.exception))
        path = self.base / 'client.json'
        native.write_private(path, {'join_url': secret})
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(native.main(['client', '--config', str(path)]), 1)
        self.assertNotIn(secret, stderr.getvalue())

    def test_environment_preserves_auth_root_but_not_ambient_overlay(self):
        with patch.dict(os.environ, {'PI_CONFIG_DIR': '.omp', 'PI_CONFIG_FILES': '/unrelated.yml',
                                     'OMP_PROFILE': 'existing-auth-profile'}):
            env = native.omp_environment()
        self.assertNotIn('PI_CONFIG_FILES', env)
        self.assertEqual(env['PI_CONFIG_DIR'], '.omp')
        self.assertEqual(env['OMP_PROFILE'], 'existing-auth-profile')

    def test_installed_plugin_bypass_fails_closed_without_loading(self):
        home = self.base / 'home'
        home.mkdir(mode=0o700)
        with patch.object(native.Path, 'home', return_value=home):
            native.require_plugin_free(self.cfg, {})
            modules = home / '.omp/plugins/node_modules'
            modules.mkdir(parents=True)
            with self.assertRaisesRegex(native.LauncherError, 'plugin tools bypass'):
                native.require_plugin_free(self.cfg, {})
            self.assertTrue(modules.is_dir())

    def test_unavailable_model_never_launches_or_changes_recorded_identity(self):
        self.persist_state()
        with patch.object(native, 'require_plugin_free'), \
             patch.object(native, 'omp_executable', return_value='/native/omp'), \
             patch.object(native, 'run_json', return_value={'models': []}), \
             patch.object(native.os, 'execve') as execute:
            with self.assertRaisesRegex(native.LauncherError, 'model is unavailable'):
                native.host(self.cfg)
            execute.assert_not_called()
        self.assertEqual(native.load_state(self.cfg), self.state)


if __name__ == '__main__':
    unittest.main()
