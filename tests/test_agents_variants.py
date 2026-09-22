import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "sync-local-config-under-test", ROOT / "scripts" / "sync-local-config.py"
)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
sync = exporter.sync


class AgentsVariantTests(unittest.TestCase):
    def test_pathspec_selects_only_the_target_variant(self):
        with patch.object(sync, "TARGET", "orca"):
            paths = sync.get_managed_remote_pathspecs()
            self.assertIn("codex/AGENTS.orca.md", paths)
            self.assertNotIn("codex/AGENTS.ccb.md", paths)
            self.assertNotIn("codex/AGENTS.md", paths)
        with patch.object(sync, "TARGET", "ccb"):
            paths = sync.get_managed_remote_pathspecs()
            self.assertIn("codex/AGENTS.ccb.md", paths)
            self.assertNotIn("codex/AGENTS.orca.md", paths)

    def test_variant_maps_to_global_codex_agents_md(self):
        with patch.object(sync, "TARGET", "orca"):
            mapped = sync.get_local_managed_path(Path("codex/AGENTS.orca.md"))
            self.assertEqual(mapped, sync.CODEX_HOME / "AGENTS.md")
            with self.assertRaisesRegex(ValueError, "outside selected target"):
                sync.get_local_managed_path(Path("codex/AGENTS.ccb.md"))
        with patch.object(sync, "TARGET", "ccb"):
            self.assertEqual(
                sync.get_local_managed_path(Path("codex/AGENTS.ccb.md")),
                sync.CODEX_HOME / "AGENTS.md",
            )

    def test_variant_helpers_reject_unknown_and_plain_paths(self):
        with self.assertRaisesRegex(ValueError, "unknown AGENTS.md variant"):
            sync.codex_agents_variant_relative("gemini")
        self.assertIsNone(sync.codex_agents_variant_target(Path("codex/AGENTS.md")))
        self.assertEqual(sync.codex_agents_variant_target(Path("codex/AGENTS.ccb.md")), "ccb")
        self.assertIsNone(sync.codex_agents_variant_target(Path("ccb/AGENTS.ccb.md")))

    def test_export_yields_only_target_variant(self):
        with patch.object(sync, "TARGET", "orca"), patch.object(sync, "CODEX_HOME", Path("/nowhere")):
            mapping = dict(exporter.export_candidates())
        self.assertIn(Path("codex/AGENTS.orca.md"), mapping)
        self.assertNotIn(Path("codex/AGENTS.md"), mapping)
        self.assertNotIn(Path("codex/AGENTS.ccb.md"), mapping)
        self.assertEqual(mapping[Path("codex/AGENTS.orca.md")], Path("/nowhere") / "AGENTS.md")

    def test_export_skips_when_global_matches_other_variant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "codex").mkdir()
            (root / "codex" / "AGENTS.ccb.md").write_bytes(b"ccb content")
            (root / "codex" / "AGENTS.orca.md").write_bytes(b"orca original")
            home = root / "home"
            home.mkdir()
            (home / "AGENTS.md").write_bytes(b"ccb content")
            with patch.object(sync, "TARGET", "orca"), \
                    patch.object(sync, "CODEX_HOME", home), \
                    patch.object(sync, "CODEX_MANAGED_DIRECTORIES", ()), \
                    patch.object(sync, "PI_MANAGED_FILES", ()), \
                    patch.object(sync, "PI_MANAGED_DIRECTORIES", ()), \
                    patch.object(sync, "ORCA_HOME", root / "orca"), \
                    patch.object(exporter, "REPO_ROOT", root / "repo"), \
                    patch.object(sync, "get_project_root", return_value=root / "project"), \
                    patch.object(sync, "get_project_key", return_value="projectkey"):
                count = exporter.export_configuration(root)
            self.assertEqual(count, 0)
            self.assertEqual((root / "codex" / "AGENTS.orca.md").read_bytes(), b"orca original")

    def test_merge_uses_legacy_base_for_variant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("remote", "local", "base", "backups", "merge"):
                (root / name).mkdir()
            (root / "remote" / "codex").mkdir()
            (root / "base" / "codex").mkdir()
            remote = root / "remote" / "codex" / "AGENTS.orca.md"
            local = root / "local" / "AGENTS.md"
            legacy = root / "base" / "codex" / "AGENTS.md"
            remote.write_text("remote new")
            local.write_text("base content")
            legacy.write_text("base content")
            with patch.multiple(
                sync, TARGET="orca", REMOTE_REPO=root / "remote",
                LAST_REMOTE=root / "base", BACKUP_ROOT=root / "backups",
                MERGE_ROOT=root / "merge",
            ), patch.object(sync, "get_managed_remote_files", return_value=[remote]), \
               patch.object(sync, "get_local_managed_path", return_value=local), \
               patch.object(sync, "seed_missing_project_ccb_config", return_value=False), \
               patch.object(sync, "write_log"):
                sync.merge_managed_files()
            self.assertEqual(local.read_text(), "remote new")
