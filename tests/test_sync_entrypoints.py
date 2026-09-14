import pathlib
import subprocess
import sys
import os
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class EntrypointTests(unittest.TestCase):
    def test_installer_requires_target_before_mutation(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/install-config.py')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--target', result.stderr)

    def test_precommit_never_exports_or_stages(self):
        hook = (ROOT / '.githooks/pre-commit').read_text()
        self.assertNotIn('sync-local-config', hook)
        self.assertNotIn('git add', hook)
        self.assertIn('git diff --cached --check', hook)

    def test_skill_requires_target_and_explicit_push(self):
        skill = (ROOT / 'codex/skills/agent-setting-sync/SKILL.md').read_text()
        self.assertIn('Require exactly one target', skill)
        self.assertIn('Only the literal explicit push request', skill)
        self.assertIn('Do NOT apply remote files to the live', skill)

    def test_fresh_orca_install_isolated_home(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            env = dict(os.environ, CODEX_HOME=str(home / 'codex'),
                       PI_CODING_AGENT_DIR=str(home / 'pi'), CCB_HOME=str(home / 'ccb'),
                       ORCA_TEAM_HOME=str(home / 'orca'), AGENT_SETTING_PROJECT_ROOT=str(home))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/install-config.py'), '--target', 'orca'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((home / 'orca/bin/orca-team.mjs').is_file())
            self.assertTrue((home / 'orca/bin/orca-team.ps1').is_file())
            self.assertEqual(sum(file.is_file() for file in (home / 'orca/source').rglob('*')), 199)
            self.assertFalse((home / 'ccb').exists())
            self.assertFalse((home / '.ccb').exists())


if __name__ == '__main__':
    unittest.main()
