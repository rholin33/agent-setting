#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CCB_HOME="${CCB_HOME:-$HOME/.ccb}"

mkdir -p "$CODEX_HOME/skills" "$CODEX_HOME/rules" "$CODEX_HOME/hooks" "$CCB_HOME"

rsync -a \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/skills/" "$CODEX_HOME/skills/"

rsync -a \
  --exclude '.DS_Store' \
  "$ROOT/rules/" "$CODEX_HOME/rules/"

rsync -a \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/hooks/" "$CODEX_HOME/hooks/"

install -m 0644 "$ROOT/AGENTS.md" "$CODEX_HOME/AGENTS.md"
install -m 0644 "$ROOT/hooks.json" "$CODEX_HOME/hooks.json"
install -m 0600 "$ROOT/ccb/ccb.config" "$CCB_HOME/ccb.config"

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$ROOT" config core.hooksPath .githooks
  echo "Enabled repository pre-commit sync hook"
fi

echo "Installed Codex global config into $CODEX_HOME"
echo "Installed CCB config into $CCB_HOME"
echo "Restart Codex to load new or changed skills and hooks."
