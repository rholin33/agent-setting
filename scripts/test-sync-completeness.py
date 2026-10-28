#!/usr/bin/env python3
"""Exercise full-export verification against real, isolated Git indexes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/sync-local-config.py'
SKILL = 'codex/skills/obsidian-cli/SKILL.md'
REFERENCE = 'codex/skills/obsidian-cli/references/使用.md'


class CompletenessTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='sync-complete-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.env = dict(os.environ, PYTHONUTF8='1',
                        CODEX_HOME=str(self.base / 'codex'),
                        PI_CODING_AGENT_DIR=str(self.base / 'pi'),
                        CLAUDE_CONFIG_DIR=str(self.base / 'claude'),
                        CCB_HOME=str(self.base / 'ccb'),
                        ORCA_TEAM_HOME=str(self.base / 'orca'),
                        XDG_CONFIG_HOME=str(self.base / 'config'),
                        AGENT_SETTING_PROJECT_ROOT=str(self.base / 'project'))
        self.git('init', '-q')
        self.git('config', 'user.name', 'Sync test')
        self.git('config', 'user.email', 'sync@example.invalid')
        self.git('config', 'core.autocrlf', 'true')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', str(self.base / 'no-hooks'))
        self.git('commit', '--allow-empty', '-qm', 'baseline')
        self.write(self.base / SKILL, b'# Obsidian\r\n')
        self.write(self.base / REFERENCE, '# Reference\n'.encode())
        self.write(self.base / 'codex/skills/obsidian-cli/auth.json', b'{}')
        self.write(self.base / 'codex/skills/obsidian-cli/runtime/data.json', b'{}')
        self.write(self.base / 'codex/skills/obsidian-cli/.DS_Store', b'OS metadata')

    @staticmethod
    def write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def run_cmd(self, *args):
        return subprocess.run(args, cwd=self.repo, env=self.env,
                              capture_output=True, text=True, encoding='utf-8')

    def git(self, *args):
        result = self.run_cmd('git', *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def sync(self, mode, target='orca'):
        return self.run_cmd(sys.executable, str(SCRIPT), '--target', target,
                            '--repo', str(self.repo), mode)

    def export(self):
        result = self.sync('--push')
        self.assertEqual(result.returncode, 0, result.stderr)

    def stage_all(self):
        self.git('add', '--', SKILL, REFERENCE)

    def assert_rejected(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)

    def test_omitted_new_skill_and_reference_are_reported(self):
        self.export()
        result = self.sync('--verify-index')
        self.assert_rejected(result, SKILL)
        self.assertIn(REFERENCE, result.stderr)

    def test_complete_index_and_commit_pass_with_git_line_endings(self):
        self.export()
        self.stage_all()
        result = self.sync('--verify-index')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git('commit', '-qm', 'full export')
        result = self.sync('--verify-head')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.repo / 'codex/skills/obsidian-cli/auth.json').exists())
        self.assertFalse((self.repo / 'codex/skills/obsidian-cli/runtime').exists())
        self.assertFalse((self.repo / 'codex/skills/obsidian-cli/.DS_Store').exists())

    def test_correct_worktree_does_not_hide_stale_index(self):
        self.export()
        self.write(self.repo / SKILL, b'# Old\n')
        self.stage_all()
        self.write(self.repo / SKILL, b'# Obsidian\r\n')
        self.assert_rejected(self.sync('--verify-index'), SKILL)

    def test_stash_and_subset_commit_cannot_lose_manifest(self):
        self.export()
        self.git('stash', 'push', '-u', '-m', 'full export')
        self.write(self.repo / 'orca/README.md', b'# Only a subset\n')
        self.git('add', '--', 'orca/README.md')
        self.assert_rejected(self.sync('--verify-index'), SKILL)
        self.git('commit', '-qm', 'partial export')
        self.assert_rejected(self.sync('--verify-head'), SKILL)

    def test_new_live_skill_requires_fresh_export(self):
        self.export()
        self.stage_all()
        path = 'codex/skills/obsidian-markdown/SKILL.md'
        self.write(self.base / path, b'# New skill\n')
        self.assert_rejected(self.sync('--verify-index'), path)

    def test_changed_live_content_requires_fresh_export(self):
        self.export()
        self.stage_all()
        self.write(self.base / SKILL, b'# Updated\n')
        self.assert_rejected(self.sync('--verify-index'), 'source changed')

    def test_missing_manifest_and_wrong_target_fail(self):
        self.assert_rejected(self.sync('--verify-index'), 'manifest')
        self.export()
        self.assert_rejected(self.sync('--verify-index', target='ccb'), 'target')

    def test_changed_base_requires_fresh_export(self):
        self.export()
        self.stage_all()
        self.git('commit', '--allow-empty', '-qm', 'changed base')
        self.assert_rejected(self.sync('--verify-index'), 'base')

    def test_ccb_full_export_also_requires_common_skills(self):
        result = self.sync('--push', target='ccb')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_rejected(self.sync('--verify-index', target='ccb'), SKILL)
        self.stage_all()
        result = self.sync('--verify-index', target='ccb')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unchanged_files_need_no_new_commit(self):
        self.export()
        self.stage_all()
        self.git('commit', '-qm', 'full export')
        self.export()
        result = self.sync('--verify-index')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.sync('--verify-head')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_crlf_blob_is_valid_without_renormalizing(self):
        self.git('config', 'core.autocrlf', 'false')
        self.export()
        self.stage_all()
        self.git('commit', '-qm', 'legacy CRLF blobs')
        self.git('config', 'core.autocrlf', 'true')
        self.export()
        result = self.sync('--verify-index')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_verification_does_not_restore_or_stage_worktree(self):
        self.export()
        self.stage_all()
        self.write(self.repo / SKILL, b'# Unstaged review\n')
        before = self.git('write-tree')
        result = self.sync('--verify-index')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('write-tree'), before)
        self.assertEqual((self.repo / SKILL).read_bytes(), b'# Unstaged review\n')


if __name__ == '__main__':
    unittest.main()
