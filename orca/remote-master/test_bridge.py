import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from unittest.mock import patch

from bridge import BridgeServer, Workspace, request


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'docs').mkdir()
        (self.root / 'docs/task.md').write_text('original')
        (self.root / '.env').write_text('PRIVATE')
        (self.root / 'untracked.md').write_text('PRIVATE')
        (self.root / 'link.md').symlink_to('/etc/hosts')
        subprocess.run(['git', '-C', str(self.root), 'add', 'docs/task.md', '.env', 'link.md'], check=True)
        self.cfg = {'root': str(self.root), 'orca': 'orca', 'bind': '127.0.0.1', 'peer': '127.0.0.1',
                    'port': 0, 'token': 'test-only-value', 'bootstrapped': True}
        self.ws = Workspace(self.cfg)

    def tearDown(self):
        self.temp.cleanup()

    def test_sensitive_untracked_absolute_traversal_and_symlinks_are_denied(self):
        for path in ['.env', 'untracked.md', 'link.md', '/etc/hosts', '../outside', '.git/config', 'deploy/test.json']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.ws.tool('read_file', {'path': path})
        self.assertEqual(self.ws.tool('list_files', {}), {'files': ['docs/task.md'], 'truncated': False})

    def test_document_conflicts_and_scope_preserve_existing_content(self):
        with self.assertRaises(ValueError):
            self.ws.tool('write_document', {'path': 'docs/task.md', 'content': 'bad', 'expected_sha256': 'absent'})
        self.assertEqual((self.root / 'docs/task.md').read_text(), 'original')
        with self.assertRaises(ValueError):
            self.ws.tool('write_document', {'path': 'package.json', 'content': '{}', 'expected_sha256': 'absent'})
        self.ws.tool('write_document', {'path': 'docs/task.md', 'content': 'revised',
                     'expected_sha256': hashlib.sha256(b'original').hexdigest()})
        self.assertEqual((self.root / 'docs/task.md').read_text(), 'revised')

    def test_source_editing_is_opt_in_and_preserves_unrelated_bytes(self):
        args = {'path': 'example.ts', 'content': 'export const value = 1;\n', 'expected_sha256': 'absent'}
        with self.assertRaises(ValueError):
            self.ws.tool('write_file', args)
        writer = Workspace(dict(self.cfg, code_write_enabled=True))
        created = writer.tool('write_file', args)
        self.assertIn('example.ts', writer.tool('list_files', {})['files'])
        self.assertEqual(writer.tool('read_file', {'path': 'example.ts'})['sha256'], created['sha256'])
        changed = writer.tool('edit_file', {'path': 'example.ts', 'old_text': '= 1;', 'new_text': '= 2;', 'expected_sha256': created['sha256']})
        self.assertEqual((self.root / 'example.ts').read_bytes(), b'export const value = 2;\n')
        with self.assertRaises(ValueError):
            writer.tool('write_file', dict(args, expected_sha256=created['sha256']))
        self.assertEqual(writer.tool('read_file', {'path': 'example.ts'})['sha256'], changed['sha256'])

    def test_code_permission_does_not_allow_ignored_secrets_or_ambiguous_edits(self):
        writer = Workspace(dict(self.cfg, code_write_enabled=True))
        (self.root / '.gitignore').write_text('ignored.ts\n')
        for name in ('.npmrc', 'auth.json'):
            (self.root / name).write_text('private test fixture')
            with self.subTest(path=name), self.assertRaises(ValueError):
                writer.tool('read_file', {'path': name})
        for path in ['.env', 'ignored.ts', '../outside', 'link.md', '.npmrc', 'AGENTS.md']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                writer.tool('write_file', {'path': path, 'content': 'no', 'expected_sha256': 'absent'})
        created = writer.tool('write_file', {'path': 'repeat.ts', 'content': 'let a = 1; let b = 1;\n', 'expected_sha256': 'absent'})
        with self.assertRaises(ValueError):
            writer.tool('edit_file', {'path': 'repeat.ts', 'old_text': '1', 'new_text': '2', 'expected_sha256': created['sha256']})
        self.assertEqual((self.root / 'repeat.ts').read_text(), 'let a = 1; let b = 1;\n')

    def test_shell_other_workspace_and_unknown_handles_are_denied(self):
        self.ws.roles = lambda: [{'handle': 'shell', 'worktreePath': str(self.root)},
                                {'handle': 'agent', 'agentIdentity': 'omp', 'worktreePath': str(self.root)}]
        for handle in ['shell', 'foreign', 'invented']:
            with self.subTest(handle=handle), self.assertRaises(ValueError):
                self.ws.tool('send_role', {'handle': handle, 'text': 'do work'})
        with self.assertRaises(ValueError):
            self.ws.tool('send_role', {'handle': 'agent', 'text': '\x03'})
        with self.assertRaises(ValueError):
            self.ws.tool('run_shell', {'command': 'whoami'})

    def test_untracked_read_does_not_grant_source_writes(self):
        reader = Workspace(dict(self.cfg, read_untracked=True, document_roots=['todo_list']))
        self.assertIn('untracked.md', reader.tool('list_files', {})['files'])
        with self.assertRaises(ValueError):
            reader.tool('write_file', {'path': 'source.ts', 'content': 'no', 'expected_sha256': 'absent'})
        (self.root / 'todo_list').mkdir()
        reader.tool('write_document', {'path': 'todo_list/master.md', 'content': 'coordination', 'expected_sha256': 'absent'})
        self.assertEqual(reader.tool('read_file', {'path': 'todo_list/master.md'})['content'], '1: coordination')
        with self.assertRaises(ValueError):
            reader.tool('read_file', {'path': '.env'})

    def test_role_inventory_normalizes_paths_and_excludes_other_workspaces(self):
        with patch.object(self.ws, 'orca', return_value={'truncated': False, 'terminals': [
            {'handle': 'same', 'worktreePath': str(self.root) + '/.'},
            {'handle': 'foreign', 'worktreePath': str(self.root.parent)},
            {'handle': 'missing'}]}):
            self.assertEqual([r['handle'] for r in self.ws.roles()], ['same'])

    def test_read_only_denies_mutations_before_dispatch(self):
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        reader = Workspace(dict(self.cfg, read_only=True, code_write_enabled=True))
        with patch.object(reader, 'orca') as orca:
            for name in ('write_document', 'write_file', 'edit_file', 'send_role', 'run_shell'):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'read.only'):
                    reader.tool(name, {'path': 'docs/task.md', 'content': 'changed',
                        'expected_sha256': hashlib.sha256(b'original').hexdigest(),
                        'old_text': 'original', 'new_text': 'changed', 'handle': 'agent', 'text': 'do work'})
            orca.assert_not_called()
        self.assertEqual((self.root / 'docs/task.md').read_text(), 'original')
        info = reader.tool('workspace_info', {})
        self.assertEqual(info['write_scope'], 'Read-only; no writes or task dispatch')
        self.assertEqual(reader.tool('read_file', {'path': 'docs/task.md'})['content'], '1: original')
        self.assertIn('docs/task.md', reader.tool('list_files', {})['files'])
        reader.roles = lambda: [{'handle': 'agent', 'agentIdentity': 'omp', 'worktreePath': str(self.root)}]
        self.assertEqual(reader.tool('list_roles', {})[0]['handle'], 'agent')
        with patch.object(reader, 'orca', return_value={'text': 'read evidence'}) as orca:
            self.assertEqual(reader.tool('read_role', {'handle': 'agent'}), {'text': 'read evidence'})
            orca.assert_called_once_with(['terminal', 'read', '--terminal', 'agent'])

    def test_read_only_http_hides_and_rejects_mutations(self):
        for read_only in (True, False, None):
            with self.subTest(read_only=read_only):
                cfg = dict(self.cfg, code_write_enabled=True)
                if read_only is not None:
                    cfg['read_only'] = read_only
                server = BridgeServer(cfg, 'local', self.root / 'private.json')
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = 'http://127.0.0.1:' + str(server.server_port) + '/mcp'
                def rpc(method, params=None):
                    return request(url, cfg['token'], {'jsonrpc': '2.0', 'id': 1,
                        'method': method, 'params': params or {}})['result']
                try:
                    names = {tool['name'] for tool in rpc('tools/list')['tools']}
                    readers = {'workspace_info', 'list_files', 'read_file', 'list_roles', 'read_role'}
                    mutations = {'write_document', 'write_file', 'edit_file', 'send_role'}
                    self.assertEqual(names, readers if read_only else readers | mutations)
                    if read_only:
                        with patch.object(server.workspace, 'orca') as orca:
                            for name in mutations:
                                result = rpc('tools/call', {'name': name, 'arguments': {}})
                                self.assertTrue(result['isError'])
                                self.assertIn('read-only', result['content'][0]['text'])
                            orca.assert_not_called()
                        result = rpc('tools/call', {'name': 'read_file', 'arguments': {'path': 'docs/task.md'}})
                        self.assertNotIn('isError', result)
                        self.assertEqual((self.root / 'docs/task.md').read_text(), 'original')
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_live_http_auth_and_mcp_read_boundary(self):
        server = BridgeServer(self.cfg, 'local', self.root / 'private.json')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                request(url + '/health', 'wrong')
            self.assertEqual(denied.exception.code, 403)
            with self.assertRaises(urllib.error.HTTPError) as paired:
                request(url + '/bootstrap', data={})
            self.assertEqual(paired.exception.code, 403)
            init = request(url + '/mcp', self.cfg['token'], {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'})
            self.assertEqual(init['result']['serverInfo']['name'], 'local-worktree-master')
            def read(path):
                return request(url + '/mcp', self.cfg['token'], {'jsonrpc': '2.0', 'id': 2,
                    'method': 'tools/call', 'params': {'name': 'read_file', 'arguments': {'path': path}}})['result']
            self.assertEqual(json.loads(read('docs/task.md')['content'][0]['text'])['content'], '1: original')
            self.assertTrue(read('.env')['isError'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
