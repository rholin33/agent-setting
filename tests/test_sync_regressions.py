import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('export_regressions', ROOT / 'scripts/sync-local-config.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
sync = exporter.sync


class SyncRegressionTests(unittest.TestCase):
    def test_text_conflict_keeps_local_and_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = Path('codex/AGENTS.md')
            remote = root / 'remote' / relative
            local = root / 'local' / relative
            baseline = root / 'base' / relative
            for file, content in ((remote, 'remote\n'), (local, 'local\n'), (baseline, 'base\n')):
                file.parent.mkdir(parents=True)
                file.write_bytes(content.encode('utf-8'))
            with patch.multiple(sync, TARGET='orca', REMOTE_REPO=root / 'remote',
                                LAST_REMOTE=root / 'base', BACKUP_ROOT=root / 'backups',
                                MERGE_ROOT=root / 'merge'), \
                 patch.object(sync, 'get_managed_remote_files', return_value=[remote]), \
                 patch.object(sync, 'get_local_managed_path', return_value=local), \
                 patch.object(sync, 'write_log'):
                with self.assertRaisesRegex(RuntimeError, 'unresolved sync conflicts'):
                    sync.merge_managed_files()
            self.assertEqual(local.read_bytes(), b'local\n')
            self.assertEqual(baseline.read_bytes(), b'base\n')
            self.assertEqual(len(list((root / 'backups').rglob('AGENTS.md.remote'))), 1)

    def test_nonoverlapping_changes_merge_across_line_endings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, baseline, remote = [root / name for name in ('local', 'base', 'remote')]
            baseline.write_bytes(b'first\n\nseparator\n\nlast\n')
            local.write_bytes(b'local\r\n\r\nseparator\r\n\r\nlast\r\n')
            remote.write_bytes(b'first\n\nseparator\n\nremote\n')
            with patch.object(sync, 'MERGE_ROOT', root / 'merge'), \
                 patch.object(sync, 'get_local_managed_path', return_value=local), \
                 patch.object(sync, 'write_log'):
                self.assertTrue(sync.merge_text_file(Path('codex/AGENTS.md'), local, baseline, remote, root / 'backup'))
            self.assertEqual(local.read_text(), 'local\n\nseparator\n\nremote\n')

    def test_export_rejects_corrupt_content_before_any_write(self):
        corruptions = {
            'codex/hooks/sync-codex-setting.py': b'from __future__ import annotations\nvalue = 1\nfrom __future__ import annotations\n',
            'codex/skills/example/SKILL.md': b'---\nname: example\n---\n# First\n---\nname: example\n---\n# Second\n',
            'pi/settings.json': b'{broken',
        }
        for relative, content in corruptions.items():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                valid = root / 'valid'
                valid.write_text('# Instructions\n', encoding='utf-8')
                invalid = root / 'invalid'
                invalid.write_bytes(content)
                destination = root / 'export'
                with patch.object(exporter, 'export_candidates', return_value=iter([
                    (Path('codex/AGENTS.md'), valid), (Path(relative), invalid),
                ])), patch.object(sync, 'TARGET', 'ccb'):
                    with self.assertRaises((ValueError, SyntaxError)):
                        exporter.export_configuration(destination)
                self.assertFalse(destination.exists())
                self.assertEqual(invalid.read_bytes(), content)

    def test_machine_artifacts_are_excluded(self):
        for relative in ('pi/bin/rg.exe', 'pi/bin/fd.exe', 'codex/rules/default.rules',
                         'codex/hooks/sync-codex-setting.ps1',
                         'codex/skills/ui-styling/scripts/tests/coverage-ui.json',
                         'codex/skills/ui-ux-pro-max/local-legacy.md',
                         'codex/skills/ui-ux-pro-max/data/local-legacy-vue-guidelines.csv',
                         'pi/skills/sample/models.json', 'codex/skills/sample/.env.local'):
            with self.subTest(relative=relative):
                self.assertFalse(sync.is_portable_path(Path(relative)))
        self.assertTrue(sync.is_portable_path(Path('pi/bin/pi')))

    def test_invalid_python_merge_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, baseline, remote = [root / name for name in ('local', 'base', 'remote')]
            baseline.write_bytes(b'from __future__ import annotations\nvalue = 1\n')
            local.write_bytes(b'from __future__ import annotations\nvalue = 2\n')
            remote.write_bytes(b'from __future__ import annotations\nvalue = 1\n\n\nfrom __future__ import annotations\n')
            before = local.read_bytes()
            with patch.object(sync, 'MERGE_ROOT', root / 'merge'), patch.object(sync, 'write_log'):
                self.assertFalse(sync.merge_text_file(Path('codex/hooks/example.py'), local, baseline, remote, root / 'backup'))
            self.assertEqual(local.read_bytes(), before)

    def test_only_real_project_layouts_are_exported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            project.mkdir()
            with patch.object(exporter, 'export_candidates', return_value=[]), \
                 patch.multiple(sync, TARGET='orca', ORCA_HOME=root / 'orca'), \
                 patch.object(sync, 'get_project_root', return_value=project), \
                 patch.object(sync, 'get_project_key', return_value='fixture'), \
                 patch.object(exporter.subprocess, 'run', return_value=type('Result', (), {'stdout': '{"tabs": []}'})()):
                destination = root / 'export'
                exporter.export_configuration(destination)
                self.assertFalse((destination / 'orca/project-configs').exists())
                layout = project / '.orca/team.json'
                layout.parent.mkdir()
                layout.write_text('{"workspace": "private", "tabs": []}', encoding='utf-8')
                exporter.export_configuration(destination)
                exported = destination / 'orca/project-configs/fixture/config.json'
                self.assertEqual(json.loads(exported.read_text()), {'tabs': []})


if __name__ == '__main__':
    unittest.main()
