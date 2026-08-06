#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PI_HOME="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CCB_HOME="${CCB_HOME:-$HOME/.ccb}"
CODEX_ROOT="$ROOT/codex"
PI_ROOT="$ROOT/pi"

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

if ! command -v rsync >/dev/null 2>&1; then
  printf '%s\n' 'rsync is required to export local Codex and Pi configuration' >&2
  exit 1
fi

require_directory "$CODEX_HOME/hooks"
require_directory "$CODEX_HOME/rules"
require_directory "$CODEX_HOME/skills"
require_file "$CODEX_HOME/AGENTS.md"

require_directory "$PI_HOME/skills"
require_file "$PI_HOME/AGENTS.md"
require_file "$PI_HOME/settings.json"
require_file "$CCB_HOME/ccb.config"

python3 - "$PI_HOME/settings.json" <<'PY'
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

mkdir -p "$CODEX_ROOT" "$PI_ROOT"

rsync -a --delete \
  --exclude '.system/' \
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
  "$PI_HOME/skills/" "$PI_ROOT/skills/"

install -m 0644 "$CODEX_HOME/AGENTS.md" "$CODEX_ROOT/AGENTS.md"
install -m 0644 "$PI_HOME/AGENTS.md" "$PI_ROOT/AGENTS.md"
install -m 0644 "$PI_HOME/settings.json" "$PI_ROOT/settings.json"
install -m 0600 "$CCB_HOME/ccb.config" "$ROOT/ccb/ccb.config"

printf '%s\n' 'Exported local global configuration:'
printf '%s\n' '  codex/AGENTS.md codex/hooks/ codex/rules/ codex/skills/'
printf '%s\n' '  pi/AGENTS.md pi/settings.json pi/skills/'
printf '%s\n' '  ccb/ccb.config'
