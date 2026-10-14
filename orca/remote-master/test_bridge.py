import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error

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
