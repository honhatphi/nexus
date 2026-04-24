#!/usr/bin/env bash
# ─── Nexus KB — Install Global Git Hooks ─────────────────────────────────────
# Cài 1 lần trên máy — tự động sync KB sau mỗi git push và git pull.
# Áp dụng cho MỌI repo trên máy qua git config --global core.hooksPath
#
# Usage: bash scripts/install-global-hooks.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEXUS_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_HOOKS_DIR="${SCRIPT_DIR}/global-hooks"

NEXUS_DIR="${HOME}/.nexus"
HOOKS_DIR="${NEXUS_DIR}/hooks"
LOG_FILE="${NEXUS_DIR}/sync.log"

echo ""
echo "  Nexus KB — Global Hook Installer"
echo "  ─────────────────────────────────"
echo ""

# ── 1. Create directories ────────────────────────────────────
mkdir -p "$HOOKS_DIR"
touch "$LOG_FILE"
echo "  ✓ Created ${NEXUS_DIR}/"

# ── 2. Copy hook scripts ─────────────────────────────────────
cp "${SRC_HOOKS_DIR}/post-push"  "${HOOKS_DIR}/post-push"
cp "${SRC_HOOKS_DIR}/post-merge" "${HOOKS_DIR}/post-merge"
cp "${SRC_HOOKS_DIR}/sync-kb.mjs" "${NEXUS_DIR}/sync-kb.mjs"

chmod +x "${HOOKS_DIR}/post-push" "${HOOKS_DIR}/post-merge"
echo "  ✓ Installed hooks → ${HOOKS_DIR}/"
echo "  ✓ Installed sync-kb.mjs → ${NEXUS_DIR}/sync-kb.mjs"

# ── 3. Set global git hooksPath ──────────────────────────────
git config --global core.hooksPath "${HOOKS_DIR}"
echo "  ✓ git config --global core.hooksPath → ${HOOKS_DIR}"

# ── 4. Protect the Nexus repo ────────────────────────────────
# The Nexus repo has its own hooks (commit-msg, pre-commit) in scripts/.
# Set per-repo hooksPath so the global setting doesn't override them.
if [ -d "${NEXUS_REPO_DIR}/.git" ]; then
  git -C "${NEXUS_REPO_DIR}" config core.hooksPath "./scripts"
  echo "  ✓ Nexus repo protected → core.hooksPath=./scripts (commit-msg, pre-commit intact)"
fi

# ── 5. Print status ──────────────────────────────────────────
echo ""
echo "  Done! Auto-sync active for every repo on this machine."
echo ""
echo "  How it works:"
echo "    git push  → KB sync in background (incremental)"
echo "    git pull  → KB sync in background (incremental, only new files)"
echo ""
echo "  Config:"
MCP_URL="${NEXUS_MCP_URL:-http://localhost:13100}"
echo "    MCP endpoint : ${MCP_URL}/mcp"
echo "    Logs         : ${LOG_FILE}"
echo "    Hooks dir    : ${HOOKS_DIR}"
echo ""
echo "  Override MCP URL:"
echo "    export NEXUS_MCP_URL=http://your-host:port"
echo ""
