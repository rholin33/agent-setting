#!/usr/bin/env python3
"""Offline adapter state-machine regressions; no process or network is started.

Only Orca/HTTP transport boundaries are replaced. Provision locks, private files,
ensure/create/verify and identity checks execute their production implementations.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_omp as native
import omp_adapter as adapter


class AdapterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.project = self.home / 'project'
        self.project.mkdir()
        self.req = {'project': str(self.project), 'home': str(self.home),
                    'role': 'master', 'model': 'pay/gpt-6-astra', 'thinking': 'high'}
        ident = hashlib.sha256((str(self.project) + '\0master').encode()).hexdigest()[:16]
        self.directory = self.home / 'remote-master/runtime' / ('omp-' + ident)
        self.directory.mkdir(parents=True, mode=0o700)
        self.state_path = self.directory / 'adapter.json'
        self.host = {'sessionId': 'same-conversation', 'instanceId': 'same-native-process',
                     'generation': 3, 'relayConnected': True, 'access': 'control',
                     'model': {'provider': 'pay', 'id': 'gpt-6-astra'}, 'participants': 2}
        self.endpoint = {'runtime': 'omp', 'role': 'master', 'environment': 'local',
                         'terminal': 'old-guest', 'incarnation': 'old-guest-incarnation',
                         'session': self.host['sessionId'], 'adapterConfig': str(self.state_path)}
        terminals = {}
        for key in ('workspace', 'relay', 'local-tunnel', 'remote-tunnel', 'control', 'host', 'guest'):
            handle = 'old-guest' if key == 'guest' else key
            terminals[key] = {'handle': handle, 'incarnation': handle + '-incarnation',
                              'environment': 'paired-host' if key in ('remote-tunnel', 'control', 'host') else None}
        self.state = {'version': 1, 'state_file': str(self.state_path), 'id': ident,
                      'project': str(self.project), 'role': 'master',
                      'model': self.req['model'], 'thinking': 'high',
                      'environment': 'paired-host', 'local': '100.64.0.1', 'peer': '100.64.0.2',
                      'remote_worktree': '/remote/worktree', 'base': 22400,
                      'control_token': 'synthetic-control-token', 'terminals': terminals,
                      'endpoint': copy.deepcopy(self.endpoint),
                      'host_identity': {key: self.host[key] for key in ('sessionId', 'instanceId', 'generation')}}
        adapter.private(self.state_path, self.state)
        adapter.private(self.directory / 'workspace.json', {'token': 'synthetic-workspace-token'})
        adapter.private(self.directory / 'installed.json', {
            'ready': True, 'root': '/remote/private-runtime', 'python': '/remote/python3'})
        self.rows = {item['handle']: {'handle': item['handle'], 'incarnationId': item['incarnation'],
                    'connected': True, 'agentIdentity': 'omp' if key == 'guest' else None,
                    'worktreePath': str(self.project)} for key, item in terminals.items()}
        self.inventory = {'terminals': [copy.deepcopy(self.rows['old-guest'])]}
        self.calls = []
        self.requests = []
        self.created = []
        self.create_failure = None
        self.snapshot_changes = {}
        self.snapshot_count = 0
        self.url = 'http://127.0.0.1:22400/#ws://127.0.0.1:22400/r/room.' + 'A' * 64
        for replacement in (
            patch.object(Path, 'home', return_value=self.home),
            patch.dict(os.environ, {}, clear=True),
            patch.object(adapter, 'call', side_effect=self.orca),
            patch.object(adapter, 'request', side_effect=self.http),
            patch.object(adapter.subprocess, 'run', side_effect=AssertionError('Unexpected real subprocess')),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)

    def saved(self):
        return native.read_private(self.state_path)

    def close_guest(self):
        self.inventory = {'terminals': []}
        self.rows.pop('old-guest', None)

    def orca(self, *args):
        self.calls.append(args)
        if args[:2] == ('terminal', 'list'):
            self.assertEqual(args, ('terminal', 'list', '--worktree', 'path:' + str(self.project)))
            if isinstance(self.inventory, Exception):
                raise self.inventory
            return copy.deepcopy(self.inventory)
        if args[:2] == ('terminal', 'show'):
            return {'terminal': copy.deepcopy(self.rows[args[args.index('--terminal') + 1]])}
        if args[:2] == ('terminal', 'create'):
            durable = self.saved()
            self.assertEqual(durable['creating'], 'guest', 'Intent must precede the external side effect')
            self.assertNotIn('guest', durable['terminals'])
            self.assertNotIn('endpoint', durable)
            self.assertEqual(args[args.index('--title') + 1], 'master-omp-guest')
            self.assertEqual(args[args.index('--worktree') + 1], 'path:' + str(self.project))
            self.assertNotIn('--environment', args)
            row = {'handle': 'rejoined-guest', 'incarnationId': 'new-guest-incarnation',
                   'connected': True, 'agentIdentity': 'omp', 'worktreePath': str(self.project)}
            self.created.append(copy.deepcopy(row))
            self.rows[row['handle']] = row
            if self.create_failure:
                raise self.create_failure
            return {'terminal': copy.deepcopy(row)}
        self.fail('Unexpected Orca operation: ' + repr(args[:2]))

    def http(self, url, token=None, data=None):
        self.requests.append((url, data))
        if url == 'http://100.64.0.1:22402/health':
            self.assertEqual(token, 'synthetic-workspace-token')
            return {'ready': True}
        self.assertEqual(token, self.state['control_token'])
        if url == 'http://100.64.0.2:22403/health':
            return {'ready': True}
        if url == 'http://100.64.0.2:22403/snapshot':
            self.snapshot_count += 1
            self.host.update(self.snapshot_changes.get(self.snapshot_count, {}))
            return {'host': copy.deepcopy(self.host)}
        if url == 'http://100.64.0.2:22403/link':
            self.assertEqual(data, {'instance_id': self.host['instanceId'], 'generation': self.host['generation']})
            return {'join_url': self.url, 'session': self.host['sessionId'], 'instance_id': self.host['instanceId'], 'generation': self.host['generation']}
        self.fail('Unexpected HTTP operation')

    def test_existing_live_client_is_verified_without_recreation(self):
        before = self.state_path.read_bytes()
        self.assertEqual(adapter.ensure(self.req), self.endpoint)
        self.assertEqual(adapter.verify(self.state_path), self.endpoint)
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertEqual(self.created, [])

    def test_closed_client_rejoins_exact_host_once_and_persists_private_control(self):
        self.close_guest()
        result = adapter.ensure(self.req)
        expected = dict(self.endpoint, terminal='rejoined-guest', incarnation='new-guest-incarnation')
        self.assertEqual(result, expected)
        saved = self.saved()
        self.assertEqual(saved['endpoint'], expected)
        self.assertEqual(saved['host_identity'], self.state['host_identity'])
        self.assertEqual(saved['previousEndpoint'], self.endpoint)
        self.assertEqual(saved['retired'], [self.state['terminals']['guest']])
        for key in set(self.state['terminals']) - {'guest'}:
            self.assertEqual(saved['terminals'][key], self.state['terminals'][key])
        self.assertNotIn('creating', saved)
        join = native.read_private(self.directory / 'join.json')
        self.assertEqual(join, {'join_url': self.url, 'control_dir': str(self.directory / 'native-guest')})
        self.assertEqual((self.directory / 'join.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.created), 1)
        self.inventory = {'terminals': [copy.deepcopy(self.rows['rejoined-guest'])]}
        self.assertEqual(adapter.ensure(self.req), expected)
        self.assertEqual(adapter.verify(self.state_path), expected)
        self.assertEqual(len(self.created), 1)

    def test_inventory_failure_is_not_authoritative_absence(self):
        for inventory in (RuntimeError('inventory unavailable'), {}, {'terminals': None}, {'terminals': {}}):
            with self.subTest(inventory=inventory):
                self.inventory = inventory
                before = self.state_path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'inventory'):
                    adapter.ensure(self.req)
                self.assertEqual(self.state_path.read_bytes(), before)
                self.assertEqual(self.created, [])
                self.assertEqual(self.requests, [])

    def test_live_mismatched_client_is_never_recreated(self):
        original = copy.deepcopy(self.rows['old-guest'])
        for change in ({'incarnationId': 'different'}, {'agentIdentity': 'codex'},
                       {'worktreePath': '/wrong-project'}, {'connected': False}):
            with self.subTest(change=change):
                self.rows['old-guest'] = dict(original, **change)
                before = self.state_path.read_bytes()
                for operation in (lambda: adapter.ensure(self.req), lambda: adapter.verify(self.state_path)):
                    with self.assertRaisesRegex(RuntimeError, 'local guest identity changed'):
                        operation()
                self.assertEqual(self.state_path.read_bytes(), before)
                self.assertEqual(self.created, [])
                self.assertEqual(self.requests, [])

    def test_closed_client_cannot_rejoin_changed_native_identity_or_model(self):
        self.close_guest()
        original = copy.deepcopy(self.host)
        for change in ({'generation': 4}, {'sessionId': 'other-session'}, {'instanceId': 'other-instance'},
                       {'model': {'provider': 'pay', 'id': 'different-model'}},
                       {'relayConnected': False}, {'access': 'read'}):
            with self.subTest(change=change):
                self.host = dict(original, **change)
                before = self.state_path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'Bound remote OMP'):
                    adapter.ensure(self.req)
                self.assertEqual(self.state_path.read_bytes(), before)
                self.assertEqual(self.created, [])
        self.assertFalse(any(url.endswith('/link') for url, _ in self.requests))

    def test_verify_rejects_changed_native_binding_with_live_guest(self):
        original = copy.deepcopy(self.host)
        for change in ({'generation': 4}, {'sessionId': 'other-session'}, {'instanceId': 'other-instance'},
                       {'model': {'provider': 'pay', 'id': 'different-model'}}):
            with self.subTest(change=change):
                self.host = dict(original, **change)
                with self.assertRaisesRegex(RuntimeError, 'Bound remote OMP'):
                    adapter.verify(self.state_path)
        self.assertEqual(self.saved(), self.state)
        self.assertEqual(self.created, [])

    def test_explicit_model_change_cannot_replace_binding(self):
        with self.assertRaises(RuntimeError):
            adapter.ensure(dict(self.req, model='pay/other-model'))
        self.assertEqual(self.saved(), self.state)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.requests, [])

    def test_lost_create_receipt_keeps_durable_uncertainty_and_never_resends(self):
        self.close_guest()
        self.create_failure = RuntimeError('create response lost')
        with self.assertRaisesRegex(RuntimeError, 'create response lost'):
            adapter.ensure(self.req)
        uncertain = self.saved()
        self.assertEqual(uncertain['creating'], 'guest')
        self.assertEqual(uncertain['host_identity'], self.state['host_identity'])
        self.assertNotIn('endpoint', uncertain)
        self.assertNotIn('guest', uncertain['terminals'])
        self.create_failure = None
        with self.assertRaisesRegex(RuntimeError, 'Uncertain terminal creation'):
            adapter.ensure(self.req)
        self.assertEqual(self.saved(), uncertain)
        self.assertEqual(len(self.created), 1)

    def test_missing_create_identity_remains_uncertain_on_retry(self):
        self.close_guest()
        original_call = self.orca

        def missing_identity(*args):
            response = original_call(*args)
            if args[:2] == ('terminal', 'create'):
                response['terminal'].pop('incarnationId')
            return response

        with patch.object(adapter, 'call', side_effect=missing_identity):
            with self.assertRaisesRegex(RuntimeError, 'verifiable terminal identity'):
                adapter.ensure(self.req)
            with self.assertRaisesRegex(RuntimeError, 'Uncertain terminal creation'):
                adapter.ensure(self.req)
        self.assertEqual(self.saved()['creating'], 'guest')
        self.assertEqual(len(self.created), 1)

    def test_native_binding_change_during_reconnect_cannot_be_committed(self):
        original_host = copy.deepcopy(self.host)
        for snapshot_number in (2, 3):
            for change in ({'generation': 4}, {'sessionId': 'other-session'},
                           {'instanceId': 'other-instance'},
                           {'model': {'provider': 'pay', 'id': 'different-model'}}):
                with self.subTest(snapshot=snapshot_number, change=change):
                    adapter.private(self.state_path, self.state)
                    self.close_guest()
                    self.host = copy.deepcopy(original_host)
                    self.snapshot_count = 0
                    self.snapshot_changes = {snapshot_number: change}
                    self.created.clear()
                    with self.assertRaises(RuntimeError):
                        adapter.ensure(self.req)
                    saved = self.saved()
                    self.assertEqual(saved['host_identity'], self.state['host_identity'])
                    self.assertNotIn('endpoint', saved)
                    if snapshot_number == 2:
                        self.assertEqual(self.created, [])

    def thinking_fixture(self):
        self.host.update(busy=False, inputRequired=False, pid=42)
        replica = self.directory / 'native-guest/native-profile/collab/current.jsonl'
        replica.parent.mkdir(parents=True)
        replica.write_text(json.dumps({'type': 'session', 'parentSession': 'same-conversation'}) + '\n'
                           + json.dumps({'type': 'thinking_level_change', 'thinkingLevel': 'high'}) + '\n')
        self.req['thinking'] = 'xhigh'
        self.draft = False
        self.send_error = False
        self.key_count = 0

        def transport(*args):
            if args[:2] == ('terminal', 'read'):
                return {'terminal': {'source': 'screen', 'tail': ['╰─' + ('draft' if self.draft else '')]}}
            if args[:2] == ('terminal', 'send'):
                self.key_count += 1
                self.assertEqual(args[-2:], ('--text', '\x1b[Z'))
                if self.send_error:
                    raise RuntimeError('Uncertain transport')
                with replica.open('a') as stream:
                    stream.write(json.dumps({'type': 'thinking_level_change', 'thinkingLevel': 'xhigh', 'configured': 'xhigh'}) + '\n')
                return {'send': {'accepted': True}}
            return self.orca(*args)

        mock = patch.object(adapter, 'call', side_effect=transport)
        mock.start()
        self.addCleanup(mock.stop)
        return replica

    def test_thinking_change_retains_native_and_guest_identity(self):
        self.thinking_fixture()
        endpoint = adapter.ensure(self.req)
        self.assertEqual(endpoint, self.endpoint)
        saved = self.saved()
        self.assertEqual(saved['thinking'], 'xhigh')
        self.assertEqual(saved['host_identity'], self.state['host_identity'])
        self.assertEqual(saved['terminals'], self.state['terminals'])
        self.assertNotIn('thinkingChange', saved)
        self.assertEqual(self.key_count, 1)
        adapter.ensure(self.req)
        self.assertEqual(self.key_count, 1)

    def test_busy_or_nonempty_composer_blocks_thinking_mutation(self):
        self.thinking_fixture()
        self.host['busy'] = True
        with self.assertRaisesRegex(RuntimeError, 'thinking_busy'):
            adapter.ensure(self.req)
        self.host['busy'] = False
        self.draft = True
        with self.assertRaisesRegex(RuntimeError, 'thinking_draft'):
            adapter.ensure(self.req)
        self.assertEqual(self.key_count, 0)
        self.assertEqual(self.saved()['thinking'], 'high')

    def test_uncertain_thinking_delivery_is_not_repeated(self):
        replica = self.thinking_fixture()
        self.send_error = True
        with self.assertRaisesRegex(RuntimeError, 'Uncertain transport'):
            adapter.ensure(self.req)
        with self.assertRaisesRegex(RuntimeError, 'thinking_uncertain'):
            adapter.ensure(self.req)
        self.assertEqual(self.key_count, 1)
        # A subsequently observed native result settles the existing operation.
        with replica.open('a') as stream:
            stream.write(json.dumps({'type': 'thinking_level_change', 'thinkingLevel': 'xhigh'}) + '\n')
        self.assertEqual(adapter.ensure(self.req), self.endpoint)
        self.assertEqual(self.key_count, 1)
        self.assertNotIn('thinkingChange', self.saved())

    def test_other_session_replica_cannot_authorize_thinking_change(self):
        replica = self.thinking_fixture()
        replica.write_text(json.dumps({'type': 'session', 'parentSession': 'wrong-session'}) + '\n')
        with self.assertRaisesRegex(RuntimeError, 'thinking_replica'):
            adapter.ensure(self.req)
        self.assertEqual(self.key_count, 0)


if __name__ == '__main__':
    unittest.main()
