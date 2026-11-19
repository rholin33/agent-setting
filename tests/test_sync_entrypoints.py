import json
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
        skill = (ROOT / 'codex/skills/agent-setting-sync/SKILL.md').read_text(encoding='utf-8')
        self.assertIn('Require exactly one target', skill)
        self.assertIn('An explicit target push request authorizes the publication workflow', skill)
        normalized = ' '.join(skill.split())
        self.assertIn('Confirmation to merge alone does not authorize pushing', normalized)
        self.assertIn('Do NOT apply remote files to the live', normalized)

    def test_fresh_orca_install_isolated_home(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), CODEX_HOME=str(home / 'codex'),
                       PI_CODING_AGENT_DIR=str(home / 'pi'), CCB_HOME=str(home / 'ccb'),
                       CLAUDE_CONFIG_DIR=str(home / 'claude'), GEMINI_HOME=str(home / 'gemini'),
                       ORCA_TEAM_HOME=str(home / 'orca'), AGENT_SETTING_PROJECT_ROOT=str(home))
            source = pathlib.Path(os.environ.get('ORCA_SOURCE_REPO', str(pathlib.Path.home() / '.codex/.sync/orca-team/source')))
            env['ORCA_SOURCE_REPO'] = str(source)
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/install-config.py'), '--target', 'orca', '--offline'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((home / 'orca/bin/orca-team.mjs').is_file())
            self.assertEqual(json.loads((home / '.gemini/antigravity-cli/settings.json').read_bytes()),
                             {'toolPermission': 'always-proceed'})
            self.assertTrue((home / 'orca/bin/orca-team.ps1').is_file())
            self.assertEqual(sum(file.is_file() for file in (home / 'orca/source').rglob('*')),
                             sum(file.is_file() for file in (source / 'source').rglob('*')))
            self.assertTrue((home / 'orca/remote-master/omp_adapter.py').is_file())
            self.assertFalse((home / 'orca/remote-master/runtime').exists())
            self.assertFalse((home / 'ccb').exists())
            self.assertFalse((home / '.ccb').exists())


class OrcaRulesInstallTests(unittest.TestCase):
    def test_rules_install_preserves_native_content_and_unrelated_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            homes = {name: home / name for name in ('codex', 'pi', 'omp', 'claude')}
            for name in ('codex', 'pi', 'omp'):
                homes[name].mkdir()
                (homes[name] / 'AGENTS.md').write_text('# Local instructions\n\nKeep this local rule.\n', encoding='utf-8')
                (homes[name] / 'settings.json').write_bytes(b'{"local":true}\n')
            env = dict(os.environ, CODEX_HOME=str(homes['codex']), PI_CODING_AGENT_DIR=str(homes['pi']),
                       OMP_AGENT_DIR=str(homes['omp']), CLAUDE_CONFIG_DIR=str(homes['claude']),
                       GEMINI_HOME=str(home / 'gemini'),
                       ORCA_TEAM_HOME=str(home / 'orca'), CCB_HOME=str(home / 'ccb'), PYTHONUTF8='1')
            command = [sys.executable, '-B', str(ROOT / 'scripts/install-config.py'), '--target', 'orca', '--rules-only']
            first = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            installed = {}
            for name in ('codex', 'pi', 'omp'):
                target = homes[name] / 'AGENTS.md'
                installed[name] = target.read_bytes()
                self.assertIn(b'Keep this local rule.', installed[name])
                self.assertIn('## Orca 任务派发约束', installed[name].decode('utf-8'))
                self.assertEqual((homes[name] / 'settings.json').read_bytes(), b'{"local":true}\n')
            second = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            for name in installed:
                self.assertEqual((homes[name] / 'AGENTS.md').read_bytes(), installed[name])
            backups = list((homes['codex'] / '.sync/codex-setting/backups').glob('orca-rules-*/*-AGENTS.md'))
            self.assertEqual(len(backups), 3)
            self.assertTrue(all(p.read_text() == '# Local instructions\n\nKeep this local rule.\n' for p in backups))
            self.assertFalse((home / 'orca').exists())
            self.assertFalse((home / 'ccb').exists())

    def test_rules_install_rejects_other_targets_before_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/install-config.py'),
                                     '--target', 'ccb', '--rules-only'], env=dict(os.environ, CODEX_HOME=str(home / 'codex')),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((home / 'codex').exists())


if __name__ == '__main__':
    unittest.main()
