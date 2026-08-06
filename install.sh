#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PI_HOME="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CCB_HOME="${CCB_HOME:-$HOME/.ccb}"

mkdir -p \
  "$CODEX_HOME/skills" \
  "$CODEX_HOME/rules" \
  "$CODEX_HOME/hooks" \
  "$PI_HOME/skills" \
  "$CCB_HOME"

if command -v ccb >/dev/null 2>&1 && [[ -d "$ROOT/roles" ]]; then
  while IFS= read -r -d '' role_manifest; do
    role_source="$(dirname "$role_manifest")"
    ccb roles install --path "$role_source" --skip-tools
done < <(find "$ROOT/roles" -mindepth 2 -maxdepth 2 -name role.toml -print0)
fi

rsync -a \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/codex/skills/" "$CODEX_HOME/skills/"

rsync -a \
  --exclude '.DS_Store' \
  "$ROOT/codex/rules/" "$CODEX_HOME/rules/"

rsync -a \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/codex/hooks/" "$CODEX_HOME/hooks/"

rsync -a \
  --exclude '.DS_Store' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/pi/skills/" "$PI_HOME/skills/"

install -m 0644 "$ROOT/codex/AGENTS.md" "$CODEX_HOME/AGENTS.md"
install -m 0644 "$ROOT/codex/hooks.json" "$CODEX_HOME/hooks.json"
install -m 0644 "$ROOT/pi/AGENTS.md" "$PI_HOME/AGENTS.md"
install -m 0644 "$ROOT/pi/settings.json" "$PI_HOME/settings.json"
install -m 0600 "$ROOT/ccb/ccb.config" "$CCB_HOME/ccb.config"

if command -v pi >/dev/null 2>&1; then
  while IFS= read -r package_source; do
    [[ -n "$package_source" ]] || continue
    PI_CODING_AGENT_DIR="$PI_HOME" pi install "$package_source"
  done < <(
    python3 -c 'import json, sys; data=json.load(open(sys.argv[1], encoding="utf-8")); packages=data.get("packages", []); print("\n".join(p if isinstance(p, str) else p["source"] for p in packages))' \
      "$PI_HOME/settings.json"
  )
else
  printf '%s\n' 'pi not found; copied Pi settings and skipped extension installation.' >&2
fi

if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$ROOT" config core.hooksPath .githooks
  echo "Enabled repository pre-commit sync hook"
fi

echo "Installed Codex global config into $CODEX_HOME"
echo "Installed Pi global config into $PI_HOME"
echo "Installed CCB config into $CCB_HOME"
echo "Restart Codex and Pi to load new or changed configuration."
