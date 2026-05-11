#!/bin/bash
# Nexus MCP Server — startup script
# Used by launchd (com.nexus.mcp-server.plist) and manual starts.
# Reads env vars from ../.env when the file exists; individual
# exports below act as fallbacks for values not in .env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEXUS_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$NEXUS_ROOT/.env"

export PATH="/Users/CPS-MKT1-D02072/.nvm/versions/node/v24.13.0/bin:$PATH"
export NODE_ENV="${NODE_ENV:-production}"

# Load .env (skip comment lines and blank lines)
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key="${key// /}"
    # Only export if not already set in environment
    [[ -z "${!key+x}" ]] && export "$key=$value"
  done < <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
fi

# Fallbacks (used only when neither .env nor shell env has the var)
export MEMGRAPH_URI="${MEMGRAPH_URI:-bolt://localhost:17687}"
export CHROMADB_URL="${CHROMADB_URL:-http://localhost:18000}"
export CHROMADB_COLLECTION="${CHROMADB_COLLECTION:-nexus_codebase}"
export MCP_SERVER_PORT="${MCP_SERVER_PORT:-13100}"
export NEXUS_WORKSPACE_ID="${NEXUS_WORKSPACE_ID:-default}"
export NEXUS_DEFAULT_MAX_INPUT_TOKENS="${NEXUS_DEFAULT_MAX_INPUT_TOKENS:-12000}"
export NEXUS_DEFAULT_RESERVED_TOKENS="${NEXUS_DEFAULT_RESERVED_TOKENS:-3000}"
export NEXUS_TASK_MAX_INPUT_TOKENS="${NEXUS_TASK_MAX_INPUT_TOKENS:-16000}"
export NEXUS_ENABLE_LEGACY_TOOLS="${NEXUS_ENABLE_LEGACY_TOOLS:-0}"

cd "$NEXUS_ROOT/mcp-server"
exec node dist/index.js
