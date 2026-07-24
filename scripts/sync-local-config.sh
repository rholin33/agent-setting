#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CCB_HOME="${CCB_HOME:-$HOME/.ccb}"

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
  printf '%s\n' 'rsync is required to export local Codex configuration' >&2
  exit 1
fi

require_directory "$CODEX_HOME/hooks"
require_directory "$CODEX_HOME/rules"
require_directory "$CODEX_HOME/skills"
require_file "$CODEX_HOME/AGENTS.md"
require_file "$CCB_HOME/ccb.config"

rsync -a --delete \
  --exclude '.system/' \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  "$CODEX_HOME/skills/" "$ROOT/skills/"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  "$CODEX_HOME/rules/" "$ROOT/rules/"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.coverage' \
  "$CODEX_HOME/hooks/" "$ROOT/hooks/"

install -m 0644 "$CODEX_HOME/AGENTS.md" "$ROOT/AGENTS.md"
install -m 0600 "$CCB_HOME/ccb.config" "$ROOT/ccb/ccb.config"

printf '%s\n' 'Exported local global configuration:'
printf '%s\n' '  AGENTS.md ccb/ccb.config hooks/ rules/ skills/'
