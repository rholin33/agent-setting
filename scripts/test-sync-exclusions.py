#!/usr/bin/env python3
"""Regression checks for local-only skills and generated Pi settings."""

import os
import runpy
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SETTINGS = '{"packages": [], "theme": "dark"}\n'
EXCLUDED_SKILL = Path("skills/cad-fill-dimension-report/SKILL.md")
AGENT_SETTINGS = Path("agents/master/provider-state/pi/home/settings.json")


class SyncExclusionsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-setting-exclusions-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.codex = self.base / "codex-home"
        self.pi = self.base / "pi-home"
        self.ccb = self.base / "ccb-home"
        self.project = self.base / "project"
        self.repo = self.codex / ".sync/codex-setting/remote"
        self.environment = {
            **os.environ,
            "CODEX_HOME": str(self.codex),
            "PI_CODING_AGENT_DIR": str(self.pi),
            "CCB_HOME": str(self.ccb),
            "AGENT_SETTING_PROJECT_ROOT": str(self.project),
        }
        environment_patch = patch.dict(os.environ, self.environment)
        environment_patch.start()
        self.addCleanup(environment_patch.stop)
        for home in (self.codex, self.pi):
            self.write(home / "AGENTS.md", "# Local instructions\n")
            self.write(home / "skills/keep/SKILL.md", "# Portable skill\n")
            self.write(home / EXCLUDED_SKILL, "# Local-only skill\n")
        for directory in (self.codex / "hooks", self.codex / "rules", self.repo / "ccb", self.repo / "pi/bin"):
            directory.mkdir(parents=True, exist_ok=True)
        self.write(self.pi / "settings.json", SETTINGS)
        self.write(self.pi / "bin/pi", "#!/bin/sh\nexit 0\n")
        self.write(self.ccb / "ccb.config", "{}\n")
        self.write(self.project / ".ccb/ccb.config", "{}\n")
        self.write(self.project / ".ccb/project.identity.json", '{"project_slug":"sample"}\n')
        self.write(self.project / ".ccb" / AGENT_SETTINGS, "local runtime settings\n")
        self.write(self.repo / "scripts/sync-local-config.sh", (ROOT / "scripts/sync-local-config.sh").read_text())
        self.write(self.repo / ".gitignore", (ROOT / ".gitignore").read_text())

    @staticmethod
    def write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def run_command(self, *command):
        result = subprocess.run(
            command, cwd=self.repo, env=self.environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def export(self):
        self.run_command("bash", str(self.repo / "scripts/sync-local-config.sh"))

    def load_hook(self):
        namespace = runpy.run_path(str(ROOT / "codex/hooks/sync-codex-setting.py"))
        return namespace["merge_managed_files"].__globals__

    def assert_local_files_preserved(self):
        for home in (self.codex, self.pi):
            self.assertEqual((home / EXCLUDED_SKILL).read_text(), "# Local-only skill\n")
        self.assertEqual(
            (self.project / ".ccb" / AGENT_SETTINGS).read_text(), "local runtime settings\n"
        )

    def test_repeated_export_skips_excluded_files(self):
        self.run_command("git", "init", "-q")
        for _ in range(2):
            self.export()
            for directory in ("codex", "pi"):
                self.assertFalse((self.repo / directory / EXCLUDED_SKILL).exists())
                self.assertTrue((self.repo / directory / "skills/keep/SKILL.md").exists())
            self.assertFalse((self.repo / "pi/projects").exists())
            self.assert_local_files_preserved()
        self.assertIsNone(self.load_hook()["get_project_pi_relative_root"]())

        self.write(self.project / "pi/settings.json", SETTINGS)
        self.export()
        self.assertEqual((self.repo / "pi/projects/sample/settings.json").read_text(), SETTINGS)
        self.assertFalse((self.repo / "pi/projects/sample/agents").exists())
        self.run_command(
            "git", "check-ignore", "codex/skills/cad-fill-dimension-report/SKILL.md",
            "pi/skills/cad-fill-dimension-report/SKILL.md",
            "pi/projects/sample/agents/master/provider-state/pi/home/settings.json",
        )

    def test_pull_and_force_skip_previously_tracked_exclusions(self):
        self.write(self.project / "pi/settings.json", SETTINGS)
        self.export()
        self.run_command("git", "init", "-q")
        for directory in ("codex", "pi"):
            self.write(self.repo / directory / EXCLUDED_SKILL, "# Must not restore\n")
        self.write(self.repo / "pi/projects/sample" / AGENT_SETTINGS, "not portable JSON\n")
        self.run_command("git", "add", "-f", "--", "codex", "pi", "ccb")
        hook = self.load_hook()
        remote_settings = Path("pi/projects/sample/settings.json")
        self.assertEqual(hook["get_local_managed_path"](remote_settings), self.project / "pi/settings.json")
        self.assertFalse(hook["is_project_pi_settings_path"](Path("pi/projects/sample") / AGENT_SETTINGS))
        with self.assertRaises(ValueError):
            hook["get_local_managed_path"](Path("pi/projects/sample") / AGENT_SETTINGS)
        hook["validate_remote_layout"]()

        for mode in ("merge_managed_files", "force_sync_managed_files"):
            with self.subTest(mode=mode):
                (self.project / "pi/settings.json").unlink()
                hook[mode]()
                self.assertEqual((self.project / "pi/settings.json").read_text(), SETTINGS)
                self.assert_local_files_preserved()
        managed = [str(path.relative_to(self.repo)) for path in hook["get_managed_remote_files"]()]
        self.assertFalse(any("cad-fill-dimension-report" in path or "/agents/" in path for path in managed))


if __name__ == "__main__":
    unittest.main()
