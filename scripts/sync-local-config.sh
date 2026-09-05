#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PI_HOME="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CCB_HOME="${CCB_HOME:-$HOME/.ccb}"
PROJECT_ROOT="${AGENT_SETTING_PROJECT_ROOT:-$PWD}"
CODEX_ROOT="$ROOT/codex"
PI_ROOT="$ROOT/pi"
PROJECT_CCB_DIR="$PROJECT_ROOT/.ccb"
PROJECT_CCB_CONFIG="$PROJECT_CCB_DIR/ccb.config"
PROJECT_PI_DIR="$PROJECT_ROOT/pi"
PROJECT_PI_SETTINGS="$PROJECT_PI_DIR/settings.json"
PROJECT_CCB_SOURCE="$PROJECT_CCB_CONFIG"
project_ccb_is_global=false
if [[ -e "$PROJECT_CCB_CONFIG" && -e "$CCB_HOME/ccb.config" && "$PROJECT_CCB_CONFIG" -ef "$CCB_HOME/ccb.config" ]]; then
  project_ccb_is_global=true
fi

require_directory() {
  if [[ ! -d "$1" ]]; then
    printf 'Missing directory: %s\n' "$1" >&2
    exit 1
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    printf 'Missing file: %s\n' "$1" >&2
    exit 1
  fi
}

validate_pi_settings_file() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
with path.open(encoding="utf-8") as handle:
    settings = json.load(handle)
if not isinstance(settings, dict):
    raise SystemExit(f"{path} must contain a JSON object")
packages = settings.get("packages", [])
if not isinstance(packages, list):
    raise SystemExit(f"{path}: packages must be an array")
for index, package in enumerate(packages):
    if isinstance(package, str) and package:
        continue
    if isinstance(package, dict) and isinstance(package.get("source"), str) and package["source"]:
        continue
    raise SystemExit(f"{path}: packages[{index}] is not a valid package source")
PY
}

if ! command -v rsync >/dev/null 2>&1; then
  printf '%s\n' 'rsync is required to export local Codex and Pi configuration' >&2
  exit 1
fi

project_ccb_remote=""
project_pi_remote=""
project_key=""
project_scope_allowed=true
if [[ -z "${AGENT_SETTING_PROJECT_ROOT:-}" && "$PROJECT_ROOT" == "$ROOT" ]]; then
  project_scope_allowed=false
fi
if [[ "$project_scope_allowed" == true && "$PROJECT_ROOT" != "$ROOT" ]]; then
  project_key="$(python3 - "$PROJECT_ROOT" <<'PY'
import hashlib
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).expanduser().resolve()
for identity_path in (
    root / ".ccb" / "project.identity.json",
    root / "ccb" / "project.identity.json",
):
    try:
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        continue
    project_slug = identity.get("project_slug")
    if isinstance(project_slug, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", project_slug):
        print(project_slug)
        break
else:
    project_name = re.sub(r"[^A-Za-z0-9._-]+", "-", root.name).strip("-._") or "project"
    project_digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]
    print(f"{project_name}-{project_digest}")
PY
  )"
  if [[ "$project_ccb_is_global" != true ]]; then
    project_ccb_remote="$ROOT/ccb/projects/$project_key/ccb.config"
  fi
  if [[ -d "$PROJECT_PI_DIR" ]]; then
    project_pi_remote="$ROOT/pi/projects/$project_key"
  fi
fi

# A project config is portable even before CCB has generated `.ccb/`; seed the
# local path from the project-specific or global config during export.
if [[ -n "$project_ccb_remote" && ! -f "$PROJECT_CCB_CONFIG" ]]; then
  if [[ -f "$project_ccb_remote" ]]; then
    PROJECT_CCB_SOURCE="$project_ccb_remote"
  else
    PROJECT_CCB_SOURCE="$CCB_HOME/ccb.config"
  fi
  mkdir -p "$PROJECT_CCB_DIR"
  install -m 0600 "$PROJECT_CCB_SOURCE" "$PROJECT_CCB_CONFIG"
  PROJECT_CCB_SOURCE="$PROJECT_CCB_CONFIG"
fi

require_directory "$CODEX_HOME/hooks"
require_directory "$CODEX_HOME/rules"
require_directory "$CODEX_HOME/skills"
require_file "$CODEX_HOME/AGENTS.md"

require_directory "$PI_HOME/skills"
require_directory "$PI_HOME/bin"
require_file "$PI_HOME/bin/pi"
require_file "$PI_HOME/AGENTS.md"
require_file "$PI_HOME/settings.json"
require_file "$CCB_HOME/ccb.config"

validate_pi_settings_file "$PI_HOME/settings.json"

if [[ -f "$PROJECT_PI_SETTINGS" ]]; then
  validate_pi_settings_file "$PROJECT_PI_SETTINGS"
fi

mkdir -p "$CODEX_ROOT" "$PI_ROOT"

rsync -a --delete \
  --exclude '.system/' \
  --exclude '/cad-fill-dimension-report/' \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  --exclude 'coverage*.json' \
  "$CODEX_HOME/skills/" "$CODEX_ROOT/skills/"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  "$CODEX_HOME/rules/" "$CODEX_ROOT/rules/"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  "$CODEX_HOME/hooks/" "$CODEX_ROOT/hooks/"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  --exclude '/cad-fill-dimension-report/' \
  "$PI_HOME/skills/" "$PI_ROOT/skills/"

install -m 0755 "$PI_HOME/bin/pi" "$PI_ROOT/bin/pi"

install -m 0644 "$CODEX_HOME/AGENTS.md" "$CODEX_ROOT/AGENTS.md"
install -m 0644 "$PI_HOME/AGENTS.md" "$PI_ROOT/AGENTS.md"
install -m 0644 "$PI_HOME/settings.json" "$PI_ROOT/settings.json"
install -m 0600 "$CCB_HOME/ccb.config" "$ROOT/ccb/ccb.config"

if [[ -n "$project_ccb_remote" && -f "$PROJECT_CCB_SOURCE" && "$project_ccb_is_global" != true ]]; then
  mkdir -p "$(dirname "$project_ccb_remote")"
  install -m 0600 "$PROJECT_CCB_SOURCE" "$project_ccb_remote"
fi

if [[ -n "$project_pi_remote" ]]; then
  if [[ -f "$PROJECT_PI_SETTINGS" ]]; then
    mkdir -p "$project_pi_remote"
    install -m 0644 "$PROJECT_PI_SETTINGS" "$project_pi_remote/settings.json"
  fi
fi

printf '%s\n' 'Exported local global configuration:'
printf '%s\n' '  codex/AGENTS.md codex/hooks/ codex/rules/ codex/skills/'
printf '%s\n' '  pi/AGENTS.md pi/settings.json pi/skills/ pi/bin/pi'
printf '%s\n' '  ccb/ccb.config'
if [[ -d "$PROJECT_CCB_DIR" && "$project_ccb_is_global" != true ]]; then
  printf '%s\n' "  ${project_ccb_remote#"$ROOT/"}"
fi
if [[ -n "$project_pi_remote" ]]; then
  if [[ -f "$PROJECT_PI_SETTINGS" ]]; then
    printf '%s\n' "  ${project_pi_remote#"$ROOT/"}/settings.json"
  fi
fi
