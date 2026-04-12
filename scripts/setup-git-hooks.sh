#!/usr/bin/env bash
# ─── setup-git-hooks.sh ───────────────────────────────────────────────────────
# Install Git hooks from /scripts/ into .git/hooks/
# Run automatically via devcontainer postCreateCommand
# ─────────────────────────────────────────────────────────────────────────────

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo /workspace)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

echo "🔧 Installing Git hooks from $SCRIPTS_DIR → $HOOKS_DIR"

install_hook() {
  local name="$1"
  local src="$SCRIPTS_DIR/$name"
  local dst="$HOOKS_DIR/$name"

  if [ ! -f "$src" ]; then
    echo "  ⚠️  Hook script not found: $src"
    return
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "  ✅ Installed: $name"
}

install_hook "commit-msg"
install_hook "pre-commit"

echo "✅ Git hooks installed."
