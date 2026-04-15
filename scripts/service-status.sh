#!/usr/bin/env bash
# service-status.sh — Nexus Services Status
# Usage:  sv
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
exec node "$SCRIPT_DIR/service-status.js" "$WORKSPACE_DIR"
