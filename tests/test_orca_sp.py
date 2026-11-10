import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OrcaSpTests(unittest.TestCase):
    def test_profile_templates_are_in_orca_scope_and_runtime_state_is_not(self):
        sync = load('sp_sync', ROOT / 'codex/hooks/sync-codex-setting.py')
        with patch.object(sync, 'TARGET', 'orca'):
            for name in ('sp-team.json', 'sp-layout.json'):
                self.assertIn(name, sync.ORCA_PACKAGE_FILES)
                self.assertTrue(sync.is_portable_path(Path('orca') / name))
                sync.validate_managed_content(Path('orca') / name, (ROOT / 'orca' / name).read_bytes())
            self.assertTrue(sync.is_portable_path(Path('orca/roles/sp-master.md')))
            self.assertFalse(sync.is_portable_path(Path('orca/profiles/sp/profile.json')))
        roles = json.loads((ROOT / 'orca/sp-team.json').read_text())
        self.assertEqual([role['name'] for role in roles], ['master', 'archi', 'designer'])
        self.assertEqual(roles[2]['modelSource'], 'omp-gemini-4-argon')

    def test_generated_launchers_do_not_enter_runtime_export(self):
        runtime = load('sp_runtime', ROOT / 'codex/hooks/orca_runtime.py')
        for name in ('bin/orca-sp', 'bin/orca-sp.ps1', 'bin/orca-team', 'bin/orca-team.ps1'):
            self.assertFalse(runtime.runtime_path(name), name)
        self.assertTrue(runtime.runtime_path('bin/orca-sp.mjs'))


if __name__ == '__main__':
    unittest.main()
