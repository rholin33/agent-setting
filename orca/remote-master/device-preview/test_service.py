import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import service


class Boundaries(unittest.TestCase):
    def test_live_stdio_handshake_and_fixed_terminal(self):
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {
                'name': 'task_operation', 'arguments': {'operation': 'terminal_probe'}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'unsupported'}]
        result = subprocess.run([__import__('sys').executable, str(service.SOURCE / 'service.py')],
            input=''.join(json.dumps(r)+'\n' for r in requests), text=True, capture_output=True, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[1]['result']['tools'][0]['name'], 'task_operation')
        probe = json.loads(responses[2]['result']['content'][0]['text'])
        self.assertEqual(probe['cwd'], str(service.Service().root))
        self.assertEqual(responses[3]['id'], 4)
        self.assertEqual(responses[3]['error']['code'], -32601)

    def test_business_and_unknown_commands_never_spawn(self):
        s = service.Service()
        with patch.object(service, 'run') as runner:
            for op in ['download', 'extract', 'login', 'preview', 'upload', 'bash', 'publish', 'submit']:
                with self.subTest(op=op), self.assertRaises(service.Denied):
                    s.call(op)
            runner.assert_not_called()

    def test_paths_links_and_hardlinks(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'real').write_text('x')
            (root / 'link').symlink_to(root / 'real')
            os.link(root / 'real', root / 'hard')
            for name in ['../escape', '/etc/passwd', 'link', 'hard', 'real']:
                with self.subTest(name=name), self.assertRaises(service.Denied):
                    service.scoped(root, name)

    def test_malicious_archives_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name, kind in [('../escape', tarfile.REGTYPE),
                               ('preview-project/link', tarfile.SYMTYPE),
                               ('preview-project/device', tarfile.CHRTYPE),
                               ('other/file', tarfile.REGTYPE)]:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w') as archive:
                    member = tarfile.TarInfo(name); member.type = kind
                    archive.addfile(member)
                data.seek(0)
                with tarfile.open(fileobj=data) as archive, self.assertRaises(service.Denied):
                    service.safe_members(archive, root)
                self.assertEqual(list(root.iterdir()), [])

    def test_rpc_rejects_extra_arguments(self):
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05'}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
                'name': 'task_operation', 'arguments': {'operation': 'terminal_probe', 'argv': ['rm']}}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {
                'name': 'task_operation', 'arguments': {'operation': 'preview'}}}]
        result = subprocess.run([__import__('sys').executable, str(service.SOURCE / 'service.py')],
            input=''.join(json.dumps(r)+'\n' for r in requests), text=True, capture_output=True, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(responses[1]['result']['isError'])
        self.assertTrue(responses[2]['result']['isError'])


if __name__ == '__main__':
    unittest.main()
