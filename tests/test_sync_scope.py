import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sync_hook', ROOT / 'codex/hooks/sync-codex-setting.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
export_spec = importlib.util.spec_from_file_location('export_config', ROOT / 'scripts/sync-local-config.py')
exporter = importlib.util.module_from_spec(export_spec)
export_spec.loader.exec_module(exporter)


class SyncScopeTests(unittest.TestCase):
    def test_duplicate_targets_rejected(self):
        for module, argv in [(sync, ['hook', '--target', 'ccb', '--target', 'orca']),
                             (exporter, ['export', '--target', 'ccb', '--target', 'orca', '--push'])]:
            with patch('sys.argv', argv):
                with self.assertRaises(SystemExit) as raised:
                    module.main()
                self.assertEqual(raised.exception.code, 2)

    def test_explicit_project_key(self):
        with patch.dict(sync.os.environ, {'AGENT_SETTING_PROJECT_KEY': 'shared-project'}):
            self.assertEqual(sync.get_project_key(), 'shared-project')
        with patch.dict(sync.os.environ, {'AGENT_SETTING_PROJECT_KEY': '../escape'}):
            with self.assertRaises(ValueError):
                sync.get_project_key()

    def test_remote_identity_normalization(self):
        self.assertEqual(sync.normalize_remote_url('git@github.com:rholin33/agent-setting.git'),
                         sync.normalize_remote_url(sync.REMOTE_URL))

    def test_checkout_rejects_wrong_origin_before_pull(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.git').mkdir()
            with patch.object(sync, 'REMOTE_REPO', root), patch.object(sync, 'ensure_directory'), \
                 patch.object(sync, 'run_git', return_value='https://example.com/wrong.git') as git:
                with self.assertRaisesRegex(RuntimeError, 'origin'):
                    sync.update_remote_checkout()
                self.assertEqual(git.call_count, 1)

    def test_targets_are_exclusive(self):
        with patch.object(sync, 'TARGET', 'orca'):
            paths = sync.get_managed_remote_pathspecs()
            self.assertIn('orca', paths)
            self.assertNotIn('ccb/ccb.config', paths)
            self.assertFalse(any(path.startswith('pi/projects') for path in paths))
        with patch.object(sync, 'TARGET', 'ccb'):
            paths = sync.get_managed_remote_pathspecs()
            self.assertIn('ccb/ccb.config', paths)
            self.assertNotIn('orca', paths)

    def test_no_args_is_read_only(self):
        with patch('sys.argv', ['sync-hook']), patch.object(sync, 'ensure_directory') as mkdir:
            self.assertEqual(sync.main(), 0)
            mkdir.assert_not_called()

    def test_project_pi_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pi').mkdir()
            with patch.object(sync, 'TARGET', 'ccb'), patch.object(sync, 'get_project_root', return_value=root):
                relative = sync.get_project_pi_relative_root() / 'settings.json'
                self.assertEqual(sync.get_local_managed_path(relative), root / 'pi/settings.json')

    def test_exclusions(self):
        for path in ['orca/projects/a/state.json', 'orca/backups/x.json',
                     'orca/source/a/__pycache__/x.pyc', 'codex/skills/.system/a/SKILL.md',
                     'orca/auth.json', 'orca/source/a/token.json',
                     'codex/skills/cad-fill-dimension-report/SKILL.md',
                     'pi/projects/project/agents/test/provider-state/pi/home/settings.json']:
            self.assertFalse(sync.is_portable_path(Path(path)), path)
        self.assertTrue(sync.is_portable_path(Path('orca/source/coder/rules.md')))

    def test_explicit_failure_is_nonzero(self):
        with patch('sys.argv', ['sync-hook', '--target', 'orca']), \
             patch.object(sync, 'ensure_directory'), patch.object(sync, 'write_log'), \
             patch.object(sync, 'update_remote_checkout', side_effect=RuntimeError('offline')):
            self.assertEqual(sync.main(), 1)

    def test_export_only_selected_scope_without_seeding_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            homes = {name: root / name for name in ('codex', 'pi', 'ccb', 'orca')}
            for home in homes.values():
                home.mkdir()
            (homes['ccb'] / 'ccb.config').write_text('ccb-only')
            (homes['orca'] / 'team.json').write_text('{}')
            (homes['orca'] / 'projects/a').mkdir(parents=True)
            (homes['orca'] / 'projects/a/state.json').write_text('secret-session')
            project = root / 'project'
            project.mkdir()
            destination = root / 'export'
            with patch.multiple(exporter.sync, TARGET='orca', CODEX_HOME=homes['codex'],
                                PI_HOME=homes['pi'], CCB_HOME=homes['ccb'], ORCA_HOME=homes['orca']), \
                 patch.object(exporter.sync, 'get_project_root', return_value=project), \
                 patch.object(exporter.sync, 'get_project_key', return_value='fixture'), \
                 patch.object(exporter.subprocess, 'run', return_value=type('Result', (), {'stdout': '{"tabs": []}'})()):
                exporter.export_configuration(destination)
            self.assertTrue((destination / 'orca/team.json').is_file())
            self.assertFalse((destination / 'ccb').exists())
            self.assertFalse((destination / 'orca/projects').exists())
            self.assertFalse((project / '.ccb').exists())

    def test_snapshot_keeps_other_scope_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / 'remote'
            snapshot = root / 'snapshot'
            (remote / 'orca').mkdir(parents=True)
            (remote / 'orca/team.json').write_text('{}')
            (snapshot / 'ccb').mkdir(parents=True)
            baseline = snapshot / 'ccb/ccb.config'
            baseline.write_text('original-base')
            with patch.object(sync, 'REMOTE_REPO', remote), \
                 patch.object(sync, 'get_managed_remote_files', return_value=[remote / 'orca/team.json']):
                sync.copy_remote_snapshot(snapshot)
            self.assertEqual(baseline.read_text(), 'original-base')

    def test_conflict_does_not_advance_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for directory_name in ('remote', 'local', 'base'):
                (root / directory_name / 'codex').mkdir(parents=True)
            remote = root / 'remote/codex/AGENTS.md'
            local = root / 'local/codex/AGENTS.md'
            base = root / 'base/codex/AGENTS.md'
            remote.write_text('remote')
            local.write_text('local')
            base.write_text('base')
            with patch.multiple(sync, TARGET='orca', REMOTE_REPO=root / 'remote',
                                LAST_REMOTE=root / 'base', BACKUP_ROOT=root / 'backups'), \
                 patch.object(sync, 'get_managed_remote_files', return_value=[remote]), \
                 patch.object(sync, 'get_local_managed_path', return_value=local), \
                 patch.object(sync, 'merge_text_file', return_value=False), \
                 patch.object(sync, 'write_log'):
                with self.assertRaisesRegex(RuntimeError, 'unresolved sync conflicts'):
                    sync.merge_managed_files()
            self.assertEqual(base.read_text(), 'base')

    def test_export_requires_push(self):
        with patch('sys.argv', ['export', '--target', 'orca']), \
             patch.object(exporter, 'export_configuration') as export:
            with self.assertRaises(SystemExit) as raised:
                exporter.main()
            self.assertEqual(raised.exception.code, 2)
            export.assert_not_called()

    def test_json_conflict_keeps_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, base, remote = [root / name for name in ('local', 'base', 'remote')]
            local.write_text('{"value": "local"}\n')
            base.write_text('{"value": "base"}\n')
            remote.write_text('{"value": "remote"}\n')
            with patch.object(sync, 'MERGE_ROOT', root / 'merge'), patch.object(sync, 'write_log'):
                result = sync.merge_text_file(Path('orca/team.json'), local, base, remote, root / 'backup')
            self.assertFalse(result)
            self.assertEqual(local.read_text(), '{"value": "local"}\n')


if __name__ == '__main__':
    unittest.main()
