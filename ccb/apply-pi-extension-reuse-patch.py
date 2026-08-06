#!/usr/bin/env python3
"""Patch CCB's Pi launcher to reuse the global Pi extension store.

CCB isolates each provider's HOME. Its Pi launcher copies settings.json into
that private HOME, so Pi otherwise reinstalls all configured npm extensions for
every agent. This patch keeps config/session isolation but symlinks only the
extension store (~/.pi/agent/npm) into each managed Pi HOME.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "def _reuse_global_pi_extensions(home_dir: Path) -> None:"
CALL_OLD = "    session_dir.mkdir(parents=True, exist_ok=True)\n    return {\n"
CALL_NEW = "    session_dir.mkdir(parents=True, exist_ok=True)\n    _reuse_global_pi_extensions(home_dir)\n    return {\n"
ANCHOR = "\ndef _path_from_prepared(prepared_state: dict[str, object], key: str) -> Path:\n"
HELPER = r'''
def _reuse_global_pi_extensions(home_dir: Path) -> None:
    """Reuse Pi's completed global extension store inside CCB's private home."""
    source = Path.home() / ".pi" / "agent" / "npm"
    target = home_dir / "npm"
    if not (source.is_dir() and (source / "node_modules").is_dir()):
        return
    try:
        if target.is_symlink():
            if target.resolve() == source.resolve():
                return
            target.unlink()
        elif target.exists():
            backup = home_dir / ".ccb-global-pi-npm-backup"
            if not backup.exists():
                target.rename(backup)
            else:
                return
        target.symlink_to(source, target_is_directory=True)
    except OSError:
        # Sharing is an optimization; Pi can fall back to its normal installer.
        return

'''


def launcher_path() -> Path:
    explicit_python = os.environ.get("CCB_PYTHON", "").strip()
    candidates = [Path(explicit_python)] if explicit_python else []
    ccb_bin = Path(os.popen("command -v ccb").read().strip())
    if ccb_bin.is_file():
        # The local CCB launcher is a shell wrapper whose exec target is the
        # release venv's Python binary. Parse it without assuming symlinks.
        for line in ccb_bin.read_text(encoding="utf-8", errors="replace").splitlines():
            if "CCB_PYTHON=" in line:
                _, value = line.split("CCB_PYTHON=", 1)
                candidate = Path(value.strip().strip('"').strip("'"))
                if candidate.name == "python" and candidate.is_file():
                    candidates.append(candidate)
            elif line.lstrip().startswith("exec "):
                for token in line.replace('"', " ").split():
                    candidate = Path(token)
                    if candidate.name == "python" and candidate.is_file():
                        candidates.append(candidate)
    for python_bin in candidates:
        # Do not resolve the venv interpreter: it commonly resolves to the
        # base interpreter outside the release tree. Its lexical path carries
        # the CCB release location we need.
        release_root = python_bin.parent.parent.parent
        path = release_root / "lib/provider_backends/pi/launcher.py"
        if path.is_file():
            return path
    raise RuntimeError("CCB Pi launcher was not found; set CCB_PYTHON to CCB's release venv Python")


def main() -> int:
    path = launcher_path()
    source = path.read_text(encoding="utf-8")
    if MARKER in source and "_reuse_global_pi_extensions(home_dir)" in source:
        print(f"Pi extension reuse patch already present: {path}")
        return 0
    if CALL_OLD not in source or ANCHOR not in source:
        raise RuntimeError(f"unsupported CCB Pi launcher layout: {path}")
    patched = source.replace(CALL_OLD, CALL_NEW, 1).replace(ANCHOR, "\n" + HELPER + ANCHOR, 1)
    compile(patched, str(path), "exec")
    path.write_text(patched, encoding="utf-8")
    print(f"Applied Pi extension reuse patch: {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"Pi extension reuse patch failed: {error}", file=sys.stderr)
        raise SystemExit(1)
