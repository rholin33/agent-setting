import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('orca_runtime', ROOT / 'codex/hooks/orca_runtime.py')
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.home = self.root / 'home'
        self.config = self.root / 'config'
        self.config.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', str(self.root / 'no-hooks'))
        self.git('remote', 'add', 'origin', self.runtime.REPOSITORY)
        self.write(self.source / 'bin/orca-team.mjs', b'// entry\n')
        self.write(self.source / 'lib/test.mjs', b'// v1\n')
        self.write(self.source / 'team.json', b'[]\n')
        self.write(self.source / 'roles/master.md', b'example\n')
        self.write(self.source / 'source/tool.py', b'# resource\n')
        self.git('add', '.')
        self.git('commit', '-m', 'fixture')
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', self.sha)
        self.pin = {'version': 1, 'repository': self.runtime.REPOSITORY, 'commit': self.sha}
        self.write(self.config / 'orca/runtime.json', json.dumps(self.pin).encode())

    @staticmethod
    def write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], stderr=subprocess.DEVNULL).decode().strip()

    def install(self):
        return self.runtime.install(self.config, self.home, source=self.source, offline=True)

    def test_pin_requires_canonical_remote_and_exact_commit(self):
        for key, value in [('repository', 'https://evil.invalid/repo'), ('commit', 'main'), ('version', 2)]:
            self.write(self.config / 'orca/runtime.json', json.dumps({**self.pin, key: value}).encode())
            with self.assertRaises(ValueError): self.runtime.read_pin(self.config)

    def test_fresh_and_repeat_install_preserve_config_and_state(self):
        self.write(self.home / 'team.json', b'personal')
        self.write(self.home / 'roles/master.md', b'personal role')
        self.write(self.home / 'projects/test/state.json', b'active session')
        self.install()
        self.install()
        self.assertEqual((self.home / 'lib/test.mjs').read_bytes(), b'// v1\n')
        self.assertEqual((self.home / 'team.json').read_bytes(), b'personal')
        self.assertEqual((self.home / 'roles/master.md').read_bytes(), b'personal role')
        self.assertEqual((self.home / 'projects/test/state.json').read_bytes(), b'active session')

    def test_update_refuses_unpublished_edits_before_any_write(self):
        self.install()
        self.write(self.home / 'lib/test.mjs', b'// local edit\n')
        with self.assertRaisesRegex(RuntimeError, 'local runtime'):
            self.install()
        self.assertEqual((self.home / 'lib/test.mjs').read_bytes(), b'// local edit\n')

    def test_new_runtime_source_is_not_silently_ignored(self):
        self.install()
        self.write(self.home / 'lib/new.mjs', b'// unpublished\n')
        with self.assertRaisesRegex(RuntimeError, 'lib/new.mjs'):
            self.install()

    def test_update_checks_main_but_installs_pin(self):
        self.git('commit', '--allow-empty', '-m', 'new upstream')
        latest = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', latest)
        result = self.install()
        self.assertEqual(result['commit'], self.sha)
        self.assertEqual(result['latest'], latest)
        self.assertTrue(result['update_available'])

    def test_upgrade_backs_up_old_code_and_preserves_config(self):
        self.install()
        self.write(self.source / 'lib/test.mjs', b'// v2\n')
        self.git('add', 'lib/test.mjs'); self.git('commit', '-m', 'v2')
        sha = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', sha)
        self.write(self.config / 'orca/runtime.json', json.dumps({**self.pin, 'commit': sha}).encode())
        self.install()
        self.assertEqual((self.home / 'lib/test.mjs').read_bytes(), b'// v2\n')
        self.assertTrue(any(p.read_bytes() == b'// v1\n' for p in (self.home / 'backups').rglob('test.mjs')))

    def test_export_collects_full_runtime_but_not_configuration(self):
        self.install()
        self.write(self.home / 'lib/new.mjs', b'// new\n')
        self.write(self.home / 'remote-master/runtime/auth.json', b'{}')
        self.runtime.export(self.config, self.home, source=self.source, offline=True)
        self.assertEqual((self.source / 'lib/new.mjs').read_bytes(), b'// new\n')
        self.assertFalse((self.source / 'remote-master/runtime').exists())
        self.assertEqual((self.source / 'team.json').read_bytes(), b'[]\n')

    def test_runtime_partial_stage_is_rejected_and_published_pin_updates(self):
        self.install()
        self.write(self.home / 'lib/new.mjs', b'// new\n')
        self.runtime.export(self.config, self.home, source=self.source, offline=True)
        with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
            self.runtime.verify_export(self.source)
        self.git('add', 'lib/new.mjs')
        self.runtime.verify_export(self.source)
        self.git('commit', '-m', 'publish new runtime')
        self.runtime.verify_export(self.source, committed=True)
        sha = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', sha)
        self.runtime.pin_published(self.config, self.home, self.source, offline=True)
        self.assertEqual(self.runtime.read_pin(self.config)['commit'], sha)

    def test_upstream_only_change_reconciles_after_full_review(self):
        self.install()
        self.write(self.source / 'lib/test.mjs', b'// upstream\n')
        self.git('add', 'lib/test.mjs'); self.git('commit', '-m', 'upstream')
        sha = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/origin/main', sha)
        self.runtime.export(self.config, self.home, source=self.source, offline=True)
        self.runtime.verify_export(self.source, committed=True)
        self.runtime.pin_published(self.config, self.home, self.source, offline=True)
        self.assertEqual((self.home / 'lib/test.mjs').read_bytes(), b'// upstream\n')

    def test_online_check_fetches_upstream_even_when_pin_is_unchanged(self):
        self.install()
        calls = []
        original = self.runtime.git
        def command(source, *args, **kwargs):
            calls.append(args)
            return b'' if args[:1] == ('fetch',) else original(source, *args, **kwargs)
        with patch.object(self.runtime, 'git', side_effect=command):
            report = self.runtime.check(self.config, self.home, self.source)
        self.assertIn(('fetch', 'origin', 'main'), calls)
        self.assertTrue(report['upstream_checked'])


if __name__ == '__main__':
    unittest.main()
