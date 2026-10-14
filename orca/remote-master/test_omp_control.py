#!/usr/bin/env python3
"""Focused private control protocol tests; no OMP or listening service is started.

Run from remote-master: python3 -m unittest -v test_omp_control.py
"""
import copy
from email.message import Message
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import native_omp as native
import omp_control as control


class FakeSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, value):
        pass


class ControlTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.directory = self.base / 'control'
        self.directory.mkdir(mode=0o700)
        home = patch.object(Path, 'home', return_value=self.base)
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.sessions = self.base / 'sessions'
        self.sessions.mkdir(mode=0o700)
        self.host = {
            'role': 'master', 'model': 'pay/gpt-6-astra', 'thinking': 'high',
            'token': 'm' * 40, 'role_prompt': 'Exact role instructions',
            'root': str(self.base / 'worktree'), 'control_dir': str(self.directory),
            'session_dir': str(self.sessions), 'relay_port': 18444,
            'local_url': 'http://127.0.0.1:18445/mcp',
        }
        self.host_path = self.directory / 'host.json'
        native.write_private(self.host_path, self.host)
        self.cfg = {'bind': '100.64.0.2', 'port': 18446, 'peer': '100.64.0.1',
                    'token': 's' * 40, 'host_config': str(self.host_path)}
        self.config_path = self.directory / 'control.json'
        native.write_private(self.config_path, self.cfg)
        self.row = {'instanceId': 'native-instance', 'generation': 3, 'sessionId': 'exact-session',
                    'pid': 4242, 'cwd': str(self.directory), 'relayConnected': True}
        self.service = control.Control(self.cfg, self.host, '18.10.2')
        self.header = self.line({'type': 'session', 'id': self.row['sessionId'],
                                 'cwd': str(self.directory)})
        self.path = self.sessions / 'recorded.jsonl'
        snapshot = patch.object(native, 'snapshot', side_effect=lambda cfg: {
            'version': 1, 'host': copy.deepcopy(self.row)})
        snapshot.start()
        self.addCleanup(snapshot.stop)

    @staticmethod
    def line(value):
        return json.dumps(value, ensure_ascii=False).encode('utf-8') + b'\n'

    def message(self, text, role='assistant'):
        return self.line({'type': 'message', 'message': {'role': role, 'content': [
            {'type': 'thinking', 'thinking': 'NEVER_EXPORT'},
            {'type': 'toolCall', 'name': 'secret_tool', 'arguments': {'token': 'NEVER_EXPORT'}},
            {'type': 'text', 'text': text}], 'usage': {'cost': 'NEVER_EXPORT'}}})

    def persist(self, content):
        self.path.write_bytes(content)
        self.path.chmod(0o600)

    def assert_code(self, code, function, *args):
        with self.assertRaises(control.ControlError) as raised:
            function(*args)
        self.assertEqual(raised.exception.code, code)

    def request(self, method='GET', path='/health', body=b'', headers=None, peer=None, auth=True):
        fields = [('Host', 'private-control'), ('Content-Length', str(len(body)))]
        if auth:
            fields.append(('Authorization', 'Bearer ' + self.cfg['token']))
        fields.extend(headers or [])
        request = f'{method} {path} HTTP/1.1\r\n'.encode()
        request += ''.join(f'{key}: {value}\r\n' for key, value in fields).encode() + b'\r\n' + body
        connection = FakeSocket(request)
        control.Handler(connection, (peer or self.cfg['peer'], 55444), SimpleNamespace(control=self.service))
        head, payload = bytes(connection.output).split(b'\r\n\r\n', 1)
        status = int(head.split(b' ', 2)[1])
        return status, json.loads(payload) if payload else None, head

    def test_native_version_accepts_actual_cli_banner(self):
        for banner in ('omp/18.10.2', '18.10.2', 'omp 18.10.2'):
            with self.subTest(banner=banner), \
                 patch.object(native, 'omp_executable', return_value='/native/omp'), \
                 patch.object(control.subprocess, 'run', return_value=SimpleNamespace(
                     stdout=(banner + '\n').encode(), stderr=b'', returncode=0)) as run:
                version = control.native_version(self.host)
            self.assertEqual(version, banner)
            self.assertEqual(run.call_args.args[0], ['/native/omp', '--version'])
            self.assertEqual(run.call_args.kwargs['cwd'], str(self.directory))
            self.service = control.Control(self.cfg, self.host, version)
            status, body, _ = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(body['version'], banner)

    def test_native_version_rejects_error_output_without_echoing(self):
        cases = [
            (0, b'Error: failed to load private config NEVER_EXPORT\n'),
            (0, b'omp/18.10.2\nError: NEVER_EXPORT\n'),
            (1, b'omp/18.10.2\n'),
            (0, b''),
        ]
        for returncode, stdout in cases:
            with self.subTest(returncode=returncode, stdout=stdout), \
                 patch.object(native, 'omp_executable', return_value='/native/omp'), \
                 patch.object(control.subprocess, 'run', return_value=SimpleNamespace(
                     stdout=stdout, stderr=b'NEVER_EXPORT', returncode=returncode)):
                with self.assertRaises(control.ControlError) as raised:
                    control.native_version(self.host)
            self.assertEqual(raised.exception.code, 'version_unavailable')
            self.assertEqual(raised.exception.status, 503)
            self.assertNotIn('NEVER_EXPORT', str(raised.exception))

    def test_private_config_and_exact_host_location(self):
        cfg, host = control.load_config(self.config_path)
        self.assertEqual(cfg, self.cfg)
        self.assertEqual(host, self.host)
        self.config_path.chmod(0o644)
        self.assert_code('invalid_config', control.load_config, self.config_path)
        self.config_path.chmod(0o600)
        self.directory.chmod(0o755)
        self.assert_code('invalid_config', control.load_config, self.config_path)
        self.directory.chmod(0o700)
        outside = self.base / 'host.json'
        native.write_private(outside, self.host)
        native.write_private(self.config_path, dict(self.cfg, host_config=str(outside)))
        self.assert_code('invalid_config', control.load_config, self.config_path)

    def test_config_refuses_non_tailnet_or_relative_host(self):
        for update in ({'bind': '0.0.0.0'}, {'peer': '127.0.0.1'}, {'port': True},
                       {'host_config': 'host.json'}, {'token': 'short'}):
            with self.subTest(update=update):
                native.write_private(self.config_path, dict(self.cfg, **update))
                self.assert_code('invalid_config', control.load_config, self.config_path)

    def test_exact_peer_bearer_and_no_origin_on_every_route(self):
        for method, route in [('GET', '/health'), ('GET', '/snapshot'), ('POST', '/link'),
                              ('POST', '/messages'), ('DELETE', '/health'), ('GET', '/unknown')]:
            for extra in ({'auth': False}, {'peer': '100.64.0.3'},
                          {'headers': [('Origin', 'null')]},
                          {'headers': [('Authorization', 'Bearer wrong')]}):
                with self.subTest(method=method, route=route, extra=extra):
                    status, body, _ = self.request(method, route, **extra)
                    self.assertEqual(status, 403)
                    self.assertEqual(body, {'error': 'forbidden'})
        status, _, _ = self.request(auth=False, headers=[('Authorization', 'bearer ' + self.cfg['token'])])
        self.assertEqual(status, 403)
        status, _, _ = self.request(peer='100.64.0.3', headers=[('X-Forwarded-For', self.cfg['peer'])])
        self.assertEqual(status, 403)

    def test_bearer_uses_constant_time_comparison(self):
        headers = Message()
        headers['Authorization'] = 'Bearer ' + self.cfg['token']
        with patch.object(control.hmac, 'compare_digest', wraps=control.hmac.compare_digest) as compare:
            control.authorize(self.cfg, self.cfg['peer'], headers)
        compare.assert_called_once()

    def test_http_health_snapshot_and_sanitized_failures(self):
        status, data, head = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(data, {'role': 'master', 'model': 'pay/gpt-6-astra',
                                'version': '18.10.2', 'control_pid': os.getpid()})
        self.assertIn(b'Cache-Control: no-store', head)
        status, data, _ = self.request(path='/snapshot')
        self.assertEqual(data, {'version': 1, 'host': self.row})
        with patch.object(self.service, 'dispatch', side_effect=RuntimeError('NEVER_EXPORT')):
            status, data, _ = self.request()
        self.assertEqual(status, 500)
        self.assertEqual(data, {'error': 'control_failure'})
        with patch.object(self.service, 'dispatch', side_effect=native.LauncherError('NEVER_EXPORT')):
            status, data, _ = self.request()
        self.assertEqual(status, 409)
        self.assertEqual(data, {'error': 'native_state_unavailable'})
        status, data, _ = self.request(path='/health?token=NEVER_EXPORT')
        self.assertEqual((status, data), (404, {'error': 'not_found'}))

    def test_http_body_limits_and_fixed_routes(self):
        for body, headers, expected in [(b'x' * (control.MAX_BODY + 1), [], 413),
                                        (b'{}', [('Transfer-Encoding', 'chunked')], 400),
                                        (b'{}', [('Content-Length', '2')], 400),
                                        (b'not json', [], 400), (b'[]', [], 400)]:
            status, _, _ = self.request('POST', '/messages', body, headers)
            self.assertEqual(status, expected)
        for route in ('/start', '/stop', '/shell', '/messages?path=/etc/passwd'):
            status, data, _ = self.request('POST', route, b'{}')
            self.assertEqual((status, data), (404, {'error': 'not_found'}))
        status, _, _ = self.request('POST', '/messages', b'{"offset":0,"path":"/etc/passwd"}')
        self.assertEqual(status, 400)

    def test_absent_ephemeral_session_is_real_and_offset_zero_only(self):
        self.assertEqual(self.service.messages({'offset': 0}), {
            'session': 'exact-session', 'offset': 0, 'nextOffset': 0, 'messages': []})
        self.assert_code('invalid_offset', self.service.messages, {'offset': 1})
        self.row['sessionId'] = 'replacement-session'
        self.assert_code('session_changed', self.service.messages, {'offset': 0})

    def test_session_changes_during_read_are_rejected(self):
        self.persist(self.header + self.message('visible'))
        changed = dict(self.row, sessionId='replacement-session')
        with patch.object(native, 'snapshot', side_effect=[{'host': self.row}, {'host': changed}]):
            self.assert_code('session_changed', self.service.messages, {'offset': 0})

    def test_file_replacement_disappearance_and_wrong_header_are_rejected(self):
        self.persist(self.header + self.message('first'))
        self.service.messages({'offset': 0})
        other = self.sessions / 'replacement'
        other.write_bytes(self.path.read_bytes())
        other.replace(self.path)
        self.assert_code('session_changed', self.service.messages, {'offset': 0})
        self.path.unlink()
        self.assert_code('session_changed', self.service.messages, {'offset': 0})
        self.persist(self.line({'type': 'session', 'id': 'other', 'cwd': str(self.directory)}))
        self.assert_code('session_changed', self.service.messages, {'offset': 0})

    def test_same_path_replacement_during_read_is_rejected(self):
        content = self.header + self.message('original')
        self.persist(content)
        calls = 0

        def snapshot(cfg):
            nonlocal calls
            calls += 1
            if calls == 2:
                replacement = self.sessions / 'replacement'
                replacement.write_bytes(content)
                replacement.replace(self.path)
            return {'host': dict(self.row)}

        with patch.object(native, 'snapshot', side_effect=snapshot):
            self.assert_code('session_changed', self.service.messages, {'offset': 0})

    def test_offset_bounds_and_byte_line_boundaries(self):
        content = self.header + self.message('你好')
        self.persist(content)
        for offset in (-1, True, 0.5, '0', None, len(content) + 1, 1, len(self.header) + 1, 2 ** 64):
            with self.subTest(offset=offset):
                self.assert_code('invalid_offset', self.service.messages, {'offset': offset})
        page = self.service.messages({'offset': len(self.header)})
        self.assertEqual(page['nextOffset'], len(content))
        self.assertEqual(page['messages'], [{'role': 'assistant', 'text': '你好'}])
        self.assertEqual(self.service.messages({'offset': len(content)})['messages'], [])

    def test_complete_appended_assistant_entries_only(self):
        user = self.message('private user', 'user')
        tool = self.message('private tool', 'toolResult')
        assistant = self.message('你好\nanswer')
        partial = self.message('second')
        prefix = self.header + user + tool + assistant
        self.persist(prefix + partial[:-1])
        page = self.service.messages({'offset': 0})
        self.assertEqual(page['nextOffset'], len(prefix))
        self.assertEqual(page['messages'], [{'role': 'assistant', 'text': '你好\nanswer'}])
        self.assertNotIn('NEVER_EXPORT', json.dumps(page))
        waiting = self.service.messages({'offset': page['nextOffset']})
        self.assertEqual(waiting['messages'], [])
        self.assertEqual(waiting['nextOffset'], page['nextOffset'])
        with self.path.open('ab') as stream:
            stream.write(b'\n')
        appended = self.service.messages({'offset': page['nextOffset']})
        self.assertEqual(appended['messages'], [{'role': 'assistant', 'text': 'second'}])
        self.assertEqual(appended['nextOffset'], len(prefix) + len(partial))

    def test_pages_preserve_whole_lines_and_output_cap(self):
        lines = [self.message(str(index) + 'x' * 14000) for index in range(7)]
        content = self.header + b''.join(lines)
        self.persist(content)
        offset = 0
        all_messages = []
        boundaries = {len(self.header)}
        cursor = len(self.header)
        for line in lines:
            cursor += len(line)
            boundaries.add(cursor)
        while offset < len(content):
            page = self.service.messages({'offset': offset})
            self.assertLessEqual(len(control.encoded(page)), control.MAX_PAGE)
            self.assertLessEqual(page['nextOffset'] - offset, control.MAX_PAGE)
            self.assertIn(page['nextOffset'], boundaries)
            self.assertGreater(page['nextOffset'], offset)
            offset = page['nextOffset']
            all_messages.extend(page['messages'])
        self.assertEqual([row['text'][0] for row in all_messages], list('0123456'))

    def test_oversized_and_malformed_entries_are_not_skipped(self):
        self.persist(self.header + self.message('x' * control.MAX_PAGE))
        self.assert_code('entry_too_large', self.service.messages, {'offset': len(self.header)})
        self.persist(self.header + b'not-json\n')
        self.assert_code('invalid_session_data', self.service.messages, {'offset': len(self.header)})

    def test_link_revalidates_identity_and_removes_private_capture(self):
        url = 'http://127.0.0.1:18444/#ws://127.0.0.1:18444/r/room.' + 'A' * 64
        captures = []

        def capture(cfg, instance, generation, output):
            captures.append(Path(output))
            self.assertEqual(Path(output).stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(output).parent, self.directory)
            native.write_private(output, {'join_url': url})

        with patch.object(native, 'fetch_link', side_effect=capture):
            result = self.service.link({'instance_id': 'native-instance', 'generation': 3})
        self.assertEqual(result, {'join_url': url, 'instance_id': 'native-instance',
                                  'generation': 3, 'session': 'exact-session'})
        self.assertTrue(captures)
        self.assertFalse(captures[0].exists())
        self.assert_code('stale_identity', self.service.link, {'instance_id': 'native-instance', 'generation': 2})
        with patch.object(native, 'fetch_link', side_effect=capture), patch.object(
                native, 'snapshot', side_effect=[{'host': self.row}, {'host': dict(self.row, generation=4)}]):
            self.assert_code('identity_changed', self.service.link, {'instance_id': 'native-instance', 'generation': 3})
        self.assertFalse(captures[-1].exists())


if __name__ == '__main__':
    unittest.main()
