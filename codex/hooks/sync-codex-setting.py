#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

REMOTE_URL = "https://github.com/rholin33/agent-setting.git"
CODEX_CONFIG_DIR = Path("codex")
PI_CONFIG_DIR = Path("pi")
CCB_CONFIG_RELATIVE_PATH = Path("ccb/ccb.config")
CODEX_MANAGED_FILES = ("AGENTS.md",)
CODEX_MANAGED_DIRECTORIES = ("hooks", "rules", "skills")
PI_MANAGED_FILES = ("AGENTS.md", "settings.json")
PI_MANAGED_DIRECTORIES = ("skills", "bin")
ROLE_SOURCES_RELATIVE_PATH = Path("roles")
TEXT_EXTENSIONS = {
    ".md",
    ".txt",
    ".toml",
    ".json",
    ".yaml",
    ".yml",
    ".csv",
    ".py",
    ".ps1",
    ".sh",
    ".js",
    ".ts",
    ".cjs",
    ".mjs",
    ".css",
    ".html",
}


def get_codex_home() -> Path:
    configured_home = os.environ.get("CODEX_HOME")
    if configured_home:
        return Path(configured_home).expanduser()
    return Path.home() / ".codex"


def get_pi_home() -> Path:
    configured_home = os.environ.get("PI_CODING_AGENT_DIR")
    if configured_home:
        return Path(configured_home).expanduser()
    return Path.home() / ".pi" / "agent"


def get_ccb_home() -> Path:
    configured_home = os.environ.get("CCB_HOME")
    if configured_home:
        return Path(configured_home).expanduser()
    return Path.home() / ".ccb"


CODEX_HOME = get_codex_home()
PI_HOME = get_pi_home()
CCB_HOME = get_ccb_home()
SYNC_ROOT = CODEX_HOME / ".sync" / "codex-setting"
REMOTE_REPO = SYNC_ROOT / "remote"
LAST_REMOTE = SYNC_ROOT / "last-remote"
BACKUP_ROOT = SYNC_ROOT / "backups"
MERGE_ROOT = SYNC_ROOT / "merge-work"
LOG_PATH = CODEX_HOME / "log" / "agent-setting-sync.log"
ROLE_INSTALL_STATE_PATH = SYNC_ROOT / "installed-roles.json"
ROLE_INSTALL_TIMEOUT_SECONDS = 30
PI_PACKAGE_INSTALL_TIMEOUT_SECONDS = 45
PI_SETTINGS_RELATIVE_PATH = PI_CONFIG_DIR / "settings.json"


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_log(message: str) -> None:
    ensure_directory(LOG_PATH.parent)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with LOG_PATH.open("a", encoding="utf-8") as log_file:
        log_file.write(f"[{timestamp}] {message}\n")


def run_git(arguments: list[str]) -> str:
    result = subprocess.run(
        ["git", *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(arguments)} failed: {result.stdout}")
    return result.stdout


def get_relative_path(base_path: Path, path: Path) -> Path:
    return path.resolve().relative_to(base_path.resolve())


def get_managed_remote_pathspecs() -> list[str]:
    return [
        *[str(CODEX_CONFIG_DIR / name) for name in CODEX_MANAGED_FILES],
        *[str(CODEX_CONFIG_DIR / name) for name in CODEX_MANAGED_DIRECTORIES],
        *[str(PI_CONFIG_DIR / name) for name in PI_MANAGED_FILES],
        *[str(PI_CONFIG_DIR / name) for name in PI_MANAGED_DIRECTORIES],
        str(CCB_CONFIG_RELATIVE_PATH),
    ]


def get_managed_remote_files() -> list[Path]:
    output = run_git(["-C", str(REMOTE_REPO), "ls-files", "--", *get_managed_remote_pathspecs()])
    files: list[Path] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        file_path = REMOTE_REPO / line.strip()
        if file_path.is_file():
            files.append(file_path)
    return files


def get_local_managed_path(relative_path: Path) -> Path:
    if relative_path == CCB_CONFIG_RELATIVE_PATH:
        return CCB_HOME / "ccb.config"

    if relative_path.parts and relative_path.parts[0] == CODEX_CONFIG_DIR.name:
        return CODEX_HOME.joinpath(*relative_path.parts[1:])

    if relative_path.parts and relative_path.parts[0] == PI_CONFIG_DIR.name:
        return PI_HOME.joinpath(*relative_path.parts[1:])

    raise ValueError(f"unsupported managed path: {relative_path}")


def copy_with_parents(source: Path, destination: Path) -> None:
    ensure_directory(destination.parent)
    shutil.copy2(source, destination)


def copy_remote_to_local(relative_path: Path, remote_path: Path) -> None:
    local_path = get_local_managed_path(relative_path)
    copy_with_parents(remote_path, local_path)
    if relative_path == CCB_CONFIG_RELATIVE_PATH:
        local_path.chmod(0o600)


def backup_local_file(relative_path: Path, backup_directory: Path) -> None:
    local_path = get_local_managed_path(relative_path)
    if local_path.is_file():
        copy_with_parents(local_path, backup_directory / relative_path)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True

    with path.open("rb") as file:
        sample = file.read(8192)
    return b"\0" not in sample


def copy_remote_snapshot(destination_root: Path) -> None:
    ensure_directory(destination_root)
    for remote_file in get_managed_remote_files():
        relative_path = get_relative_path(REMOTE_REPO, remote_file)
        copy_with_parents(remote_file, destination_root / relative_path)


def update_remote_checkout() -> None:
    ensure_directory(SYNC_ROOT)
    if (REMOTE_REPO / ".git").is_dir():
        if (REMOTE_REPO / ".git/shallow").is_file():
            run_git(["-C", str(REMOTE_REPO), "fetch", "--unshallow", "origin"])
        run_git(["-C", str(REMOTE_REPO), "pull", "--ff-only"])
        return

    if REMOTE_REPO.exists() and any(REMOTE_REPO.iterdir()):
        raise RuntimeError(f"remote checkout exists but is not a git repo: {REMOTE_REPO}")

    run_git(["clone", REMOTE_URL, str(REMOTE_REPO)])


def validate_remote_layout() -> None:
    required_paths = [
        REMOTE_REPO / CODEX_CONFIG_DIR / "AGENTS.md",
        REMOTE_REPO / CODEX_CONFIG_DIR / "hooks",
        REMOTE_REPO / CODEX_CONFIG_DIR / "rules",
        REMOTE_REPO / CODEX_CONFIG_DIR / "skills",
        REMOTE_REPO / PI_CONFIG_DIR / "AGENTS.md",
        REMOTE_REPO / PI_CONFIG_DIR / "settings.json",
        REMOTE_REPO / PI_CONFIG_DIR / "skills",
        REMOTE_REPO / PI_CONFIG_DIR / "bin" / "pi",
    ]
    missing = [str(path.relative_to(REMOTE_REPO)) for path in required_paths if not path.exists()]
    if missing:
        raise RuntimeError(f"remote configuration is incomplete; missing: {', '.join(missing)}")

    if not any((REMOTE_REPO / PI_CONFIG_DIR / "skills").rglob("SKILL.md")):
        raise RuntimeError("remote pi/skills has no SKILL.md")

    load_pi_settings(REMOTE_REPO / PI_CONFIG_DIR / "settings.json")


def install_packaged_roles() -> None:
    ccb_executable = shutil.which("ccb")
    roles_root = REMOTE_REPO / ROLE_SOURCES_RELATIVE_PATH
    if not ccb_executable or not roles_root.is_dir():
        return

    installed_roles = load_installed_role_state()
    for manifest_path in sorted(roles_root.glob("*/role.toml")):
        try:
            result = subprocess.run(
                [ccb_executable, "roles", "install", "--path", str(manifest_path.parent), "--skip-tools"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=ROLE_INSTALL_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            write_log(f"Packaged Role installation timed out: {manifest_path.parent.name}")
            continue
        if result.returncode != 0:
            write_log(f"Packaged Role installation failed: {manifest_path.parent.name} (exit {result.returncode})")
            continue
        role_id = manifest_path.parent.name
        installed_roles.add(role_id)
        save_installed_role_state(installed_roles)
        write_log(f"installed packaged CCB Role: {role_id}")


def get_required_roles() -> list[str]:
    manifest_path = REMOTE_REPO / "ccb/roles.json"
    if not manifest_path.is_file():
        return []

    with manifest_path.open(encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)

    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported CCB role manifest schema")

    roles = manifest.get("roles")
    if not isinstance(roles, list) or not all(
        isinstance(role, str) and role.startswith("agentroles.") for role in roles
    ):
        raise ValueError("invalid CCB role manifest")
    return list(dict.fromkeys(roles))


def load_installed_role_state() -> set[str]:
    if not ROLE_INSTALL_STATE_PATH.is_file():
        return set()

    try:
        with ROLE_INSTALL_STATE_PATH.open(encoding="utf-8") as state_file:
            state = json.load(state_file)
    except (OSError, json.JSONDecodeError):
        return set()

    roles = state.get("roles", [])
    if not isinstance(roles, list):
        return set()
    return {role for role in roles if isinstance(role, str)}


def save_installed_role_state(roles: set[str]) -> None:
    ensure_directory(ROLE_INSTALL_STATE_PATH.parent)
    temporary_path = ROLE_INSTALL_STATE_PATH.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps({"schema_version": 1, "roles": sorted(roles)}, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(ROLE_INSTALL_STATE_PATH)


def install_required_roles() -> None:
    ccb_executable = shutil.which("ccb")
    if not ccb_executable:
        write_log("ccb not found; skipped Role installation")
        return

    installed_roles = load_installed_role_state()
    for role in get_required_roles():
        if role in installed_roles:
            continue

        try:
            result = subprocess.run(
                [ccb_executable, "roles", "install", role, "--skip-tools"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=ROLE_INSTALL_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            write_log(f"Role installation timed out: {role}")
            continue

        if result.returncode != 0:
            write_log(f"Role installation failed: {role} (exit {result.returncode})")
            continue

        installed_roles.add(role)
        save_installed_role_state(installed_roles)
        write_log(f"installed CCB Role: {role}")


def merge_text_file(
    relative_path: Path,
    local_path: Path,
    base_path: Path,
    remote_path: Path,
    backup_directory: Path,
) -> bool:
    ensure_directory(MERGE_ROOT)
    with tempfile.TemporaryDirectory(dir=MERGE_ROOT) as work_directory:
        work_path = Path(work_directory)
        ours = work_path / "ours"
        base = work_path / "base"
        theirs = work_path / "theirs"
        shutil.copy2(local_path, ours)
        shutil.copy2(base_path, base)
        shutil.copy2(remote_path, theirs)

        result = subprocess.run(
            ["git", "merge-file", "--union", str(ours), str(base), str(theirs)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if result.returncode != 0:
            copy_with_parents(remote_path, backup_directory / f"{relative_path}.remote")
            write_log(f"merge conflict kept local file: {relative_path}")
            return False

        backup_local_file(relative_path, backup_directory)
        shutil.copy2(ours, local_path)
        write_log(f"merged text file: {relative_path}")
        return True


def load_json_object(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as settings_file:
        settings = json.load(settings_file)
    if not isinstance(settings, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return settings


def get_pi_package_sources(settings: dict[str, Any], path: Path) -> list[str]:
    packages = settings.get("packages", [])
    if not isinstance(packages, list):
        raise ValueError(f"{path}: packages must be an array")

    sources: list[str] = []
    for index, package in enumerate(packages):
        if isinstance(package, str) and package:
            source = package
        elif isinstance(package, dict) and isinstance(package.get("source"), str) and package["source"]:
            source = package["source"]
        else:
            raise ValueError(f"{path}: packages[{index}] must be a source string or object")
        if source not in sources:
            sources.append(source)
    return sources


def load_pi_settings(path: Path) -> dict[str, Any]:
    settings = load_json_object(path)
    get_pi_package_sources(settings, path)
    return settings


def merge_pi_settings_file(
    relative_path: Path,
    local_path: Path,
    base_path: Path,
    remote_path: Path,
    backup_directory: Path,
) -> bool:
    remote_settings = load_pi_settings(remote_path)

    if not local_path.exists():
        copy_remote_to_local(relative_path, remote_path)
        write_log(f"copied missing remote pi settings: {relative_path}")
        return True

    try:
        local_settings = load_pi_settings(local_path)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        backup_local_file(relative_path, backup_directory)
        copy_remote_to_local(relative_path, remote_path)
        write_log(f"replaced invalid local pi settings ({error}): {relative_path}")
        return True

    if hash_file(local_path) == hash_file(remote_path):
        return False

    if not base_path.is_file():
        write_log(f"kept local pi settings because no baseline exists: {relative_path}")
        return False

    try:
        base_settings = load_pi_settings(base_path)
    except (OSError, json.JSONDecodeError, ValueError):
        base_settings = {}

    merged: dict[str, Any] = {}
    sentinel = object()
    keys = set(base_settings) | set(local_settings) | set(remote_settings)
    remote_owned_keys = {"packages", "skills", "extensions", "prompts", "themes"}

    for key in keys:
        base_value = base_settings.get(key, sentinel)
        local_value = local_settings.get(key, sentinel)
        remote_value = remote_settings.get(key, sentinel)

        if local_value == base_value:
            chosen = remote_value
        elif remote_value == base_value or local_value == remote_value:
            chosen = local_value
        elif key in remote_owned_keys:
            chosen = remote_value
            write_log(f"kept remote pi resource setting on conflict: {relative_path}#{key}")
        else:
            chosen = local_value
            write_log(f"kept local pi setting on conflict: {relative_path}#{key}")

        if chosen is not sentinel:
            merged[key] = chosen

    if merged == local_settings:
        return False

    backup_local_file(relative_path, backup_directory)
    ensure_directory(local_path.parent)
    local_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_log(f"merged pi settings: {relative_path}")
    return True


def validate_local_pi_configuration() -> list[str]:
    required_paths = [PI_HOME / "AGENTS.md", PI_HOME / "settings.json", PI_HOME / "skills", PI_HOME / "bin" / "pi"]
    missing = [str(path) for path in required_paths if not path.exists()]
    if missing:
        raise RuntimeError(f"local pi configuration is incomplete; missing: {', '.join(missing)}")

    if not any((PI_HOME / "skills").rglob("SKILL.md")):
        raise RuntimeError(f"local pi skills directory has no SKILL.md: {PI_HOME / 'skills'}")

    settings = load_pi_settings(PI_HOME / "settings.json")
    return get_pi_package_sources(settings, PI_HOME / "settings.json")


def get_pi_installed_status(pi_executable: str) -> dict[str, bool]:
    environment = os.environ.copy()
    environment["PI_CODING_AGENT_DIR"] = str(PI_HOME)
    result = subprocess.run(
        [pi_executable, "list"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
        timeout=PI_PACKAGE_INSTALL_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        write_log(f"pi list failed (exit {result.returncode}); will attempt package installation")
        return {}

    status: dict[str, bool] = {}
    current_source: str | None = None
    for line in result.stdout.splitlines():
        value = line.strip()
        if value.startswith(("npm:", "git:", "http://", "https://", "ssh://")):
            current_source = value.removesuffix(" (filtered)")
            status[current_source] = False
            continue
        if current_source and value.startswith("/"):
            status[current_source] = Path(value).is_dir()
    return status


def install_pi_extensions() -> None:
    try:
        package_sources = validate_local_pi_configuration()
    except (OSError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        write_log(f"skipped pi extension installation: {error}")
        return

    pi_executable = shutil.which("pi")
    if not pi_executable:
        write_log("pi not found; skipped pi extension installation")
        return

    try:
        installed_status = get_pi_installed_status(pi_executable)
    except (OSError, subprocess.TimeoutExpired) as error:
        write_log(f"could not inspect pi extensions: {error}")
        installed_status = {}

    environment = os.environ.copy()
    environment["PI_CODING_AGENT_DIR"] = str(PI_HOME)
    for source in package_sources:
        if installed_status.get(source, False):
            continue

        try:
            result = subprocess.run(
                [pi_executable, "install", source],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                timeout=PI_PACKAGE_INSTALL_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            write_log(f"pi extension installation timed out: {source}")
            continue

        if result.returncode != 0:
            write_log(f"pi extension installation failed: {source} (exit {result.returncode})")
            continue
        write_log(f"installed pi extension: {source}")


def merge_managed_files() -> None:
    backup_directory = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    changed_count = 0

    for remote_file in get_managed_remote_files():
        relative_path = get_relative_path(REMOTE_REPO, remote_file)
        local_path = get_local_managed_path(relative_path)
        base_path = LAST_REMOTE / relative_path

        if local_path.is_dir():
            write_log(f"kept local directory because remote path is file: {relative_path}")
            continue

        if relative_path == PI_SETTINGS_RELATIVE_PATH:
            if merge_pi_settings_file(relative_path, local_path, base_path, remote_file, backup_directory):
                changed_count += 1
            continue

        if not local_path.exists():
            copy_remote_to_local(relative_path, remote_file)
            changed_count += 1
            write_log(f"copied missing remote file: {relative_path}")
            continue

        if relative_path == CCB_CONFIG_RELATIVE_PATH:
            if hash_file(local_path) != hash_file(remote_file):
                backup_local_file(relative_path, backup_directory)
                copy_remote_to_local(relative_path, remote_file)
                changed_count += 1
                write_log(f"updated CCB config from remote: {relative_path}")
            elif local_path.stat().st_mode & 0o777 != 0o600:
                local_path.chmod(0o600)
                changed_count += 1
                write_log(f"fixed CCB config permissions: {relative_path}")
            continue

        if not base_path.is_file():
            write_log(f"kept local file because no baseline exists: {relative_path}")
            continue

        local_hash = hash_file(local_path)
        remote_hash = hash_file(remote_file)
        base_hash = hash_file(base_path)

        if local_hash == remote_hash:
            continue

        if local_hash == base_hash:
            backup_local_file(relative_path, backup_directory)
            copy_remote_to_local(relative_path, remote_file)
            changed_count += 1
            write_log(f"updated unchanged local file from remote: {relative_path}")
            continue

        if remote_hash == base_hash:
            continue

        if is_text_file(local_path) and is_text_file(base_path) and is_text_file(remote_file):
            if merge_text_file(relative_path, local_path, base_path, remote_file, backup_directory):
                changed_count += 1
            continue

        copy_with_parents(remote_file, backup_directory / f"{relative_path}.remote")
        write_log(f"kept local binary file and saved remote copy: {relative_path}")

    copy_remote_snapshot(LAST_REMOTE)
    write_log(f"sync finished; changed files: {changed_count}")


def force_sync_managed_files() -> None:
    """Replace local managed files with the validated remote configuration."""
    backup_directory = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S-force")
    changed_count = 0

    for remote_file in get_managed_remote_files():
        relative_path = get_relative_path(REMOTE_REPO, remote_file)
        local_path = get_local_managed_path(relative_path)

        if local_path.is_dir():
            write_log(f"force sync kept local directory because remote path is file: {relative_path}")
            continue

        if local_path.is_file() and hash_file(local_path) == hash_file(remote_file):
            if relative_path == CCB_CONFIG_RELATIVE_PATH and local_path.stat().st_mode & 0o777 != 0o600:
                local_path.chmod(0o600)
                changed_count += 1
                write_log(f"force sync fixed CCB config permissions: {relative_path}")
            continue

        if local_path.exists():
            backup_local_file(relative_path, backup_directory)
        copy_remote_to_local(relative_path, remote_file)
        changed_count += 1
        write_log(f"force-updated local file from remote: {relative_path}")

    copy_remote_snapshot(LAST_REMOTE)
    write_log(f"force sync finished; changed files: {changed_count}")


def _debounce(seconds: int = 86400, force: bool = False) -> bool:
    """Return True if we should skip (ran recently)."""
    lock_file = SYNC_ROOT / ".last_run"
    try:
        if force:
            lock_file.touch()
            return False
        if lock_file.is_file():
            elapsed = datetime.now().timestamp() - lock_file.stat().st_mtime
            if elapsed < seconds:
                return True
        lock_file.touch()
        return False
    except OSError:
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Synchronize global Codex, Pi, and CCB configuration")
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace local managed files with the validated remote configuration",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        ensure_directory(SYNC_ROOT)
        ensure_directory(BACKUP_ROOT)
        ensure_directory(MERGE_ROOT)

        if _debounce(force=args.force):
            return 0

        if not shutil.which("git"):
            write_log("git not found; skipped")
            return 0

        update_remote_checkout()
        validate_remote_layout()

        if not (LAST_REMOTE / CODEX_CONFIG_DIR / "AGENTS.md").is_file():
            copy_remote_snapshot(LAST_REMOTE)
            write_log("initialized remote baseline")

        if args.force:
            force_sync_managed_files()
        else:
            merge_managed_files()
        install_packaged_roles()
        install_required_roles()
        install_pi_extensions()
    except Exception as error:
        write_log(f"sync failed: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
