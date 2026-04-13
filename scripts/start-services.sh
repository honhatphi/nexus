#!/usr/bin/env bash
# ─── start-services.sh ────────────────────────────────────────────────────────
# Robust startup for Nexus devcontainer.
# Starts socat proxies + MCP server with auto-restart supervision.
# Idempotent — safe to re-run (kills stale processes first).
#
# Called by: postStartCommand in devcontainer.json
# Logs:     /tmp/nexus/*.log
# PIDs:     /tmp/nexus/pids/*.pid
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

NEXUS_RUN="/tmp/nexus"
PID_DIR="$NEXUS_RUN/pids"
mkdir -p "$PID_DIR"

# ═══════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════

stop_service() {
  local name="$1"
  local pidfile="$PID_DIR/${name}.pid"
  [ -f "$pidfile" ] || return 0
  local pid
  pid=$(cat "$pidfile" 2>/dev/null) || return 0

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    # Wait for graceful shutdown
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    # Force kill if still alive
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pidfile"
}

# Start a process with auto-restart supervision.
# The supervisor shell tracks the child PID and forwards SIGTERM.
start_service() {
  local name="$1"; shift
  local logfile="$NEXUS_RUN/${name}.log"
  local pidfile="$PID_DIR/${name}.pid"

  stop_service "$name"

  # Rotate log — keep last 200 lines
  if [ -f "$logfile" ]; then
    tail -200 "$logfile" > "$logfile.rotated" 2>/dev/null && mv "$logfile.rotated" "$logfile" || true
  fi

  (
    _child=0
    _cleanup() {
      [ "$_child" -ne 0 ] && kill "$_child" 2>/dev/null
      exit 0
    }
    trap _cleanup TERM INT

    while true; do
      echo "[$(date '+%H:%M:%S')] ▶ ${name} starting"
      "$@" &
      _child=$!
      wait "$_child" 2>/dev/null || true
      _child=0
      echo "[$(date '+%H:%M:%S')] ✖ ${name} exited — restarting in 3s"
      sleep 3
    done
  ) >> "$logfile" 2>&1 &
  echo $! > "$pidfile"
}

wait_tcp() {
  local host="$1" port="$2" label="$3" timeout="${4:-30}"
  for i in $(seq 1 "$timeout"); do
    if (echo > "/dev/tcp/$host/$port") 2>/dev/null; then
      echo "  ✅ $label"
      return 0
    fi
    sleep 1
  done
  echo "  ⚠️  $label — not reachable after ${timeout}s"
  return 1
}

wait_http() {
  local url="$1" label="$2" timeout="${3:-15}"
  for i in $(seq 1 "$timeout"); do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo "  ✅ $label"
      return 0
    fi
    sleep 1
  done
  echo "  ⚠️  $label — not responding after ${timeout}s (check /tmp/nexus/)"
  return 1
}

# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║    🚀 Nexus DevContainer — Starting...       ║"
echo "╚══════════════════════════════════════════════╝"

# ── 1. Docker socket permissions ──────────────────────────────
if [ -S /var/run/docker.sock ]; then
  sudo chmod 666 /var/run/docker.sock 2>/dev/null \
    && echo "  ✅ Docker socket permissions OK" \
    || echo "  ⚠️  Docker socket chmod failed (non-critical)"
fi

# ── 2. Wait for infrastructure (container DNS) ───────────────
echo ""
echo "📡 Checking infrastructure..."
wait_tcp memgraph 7687 "Memgraph (bolt://memgraph:7687)" 30
wait_tcp chromadb 8000 "ChromaDB (http://chromadb:8000)" 30

# ── 3. Socat proxies: localhost → container DNS ──────────────
# These let VS Code extensions + CLI tools use localhost addresses
echo ""
echo "🔌 Starting localhost proxies..."
start_service socat-chromadb      socat TCP-LISTEN:8000,fork,reuseaddr TCP:chromadb:8000
start_service socat-memgraph-bolt socat TCP-LISTEN:7687,fork,reuseaddr TCP:memgraph:7687
start_service socat-memgraph-lab  socat TCP-LISTEN:3000,fork,reuseaddr TCP:memgraph:3000
echo "  ✅ localhost:8000 → ChromaDB"
echo "  ✅ localhost:7687 → Memgraph Bolt"
echo "  ✅ localhost:3000 → Memgraph Lab"

# ── 4. MCP Server ─────────────────────────────────────────────
echo ""
echo "🔧 Starting MCP Server..."

# Auto-build if dist is missing (first start or clean rebuild)
if [ ! -f /workspace/mcp-server/dist/index.js ]; then
  echo "  📦 Build artifacts missing — building common-tools + mcp-server..."
  (
    npm --prefix /workspace/nexus-hub/common-tools install --silent 2>&1 && \
    npm --prefix /workspace/mcp-server install --silent 2>&1 && \
    npm --prefix /workspace/nexus-hub/common-tools run build 2>&1 && \
    npm --prefix /workspace/mcp-server run build 2>&1
  ) > "$NEXUS_RUN/build.log" 2>&1

  if [ -f /workspace/mcp-server/dist/index.js ]; then
    echo "  ✅ Build completed"
  else
    echo "  ❌ Build FAILED — check /tmp/nexus/build.log"
    echo "     Manual fix: npm --prefix /workspace/nexus-hub/common-tools run build && npm --prefix /workspace/mcp-server run build"
  fi
fi

if [ -f /workspace/mcp-server/dist/index.js ]; then
  start_service mcp-server node /workspace/mcp-server/dist/index.js
  wait_http "http://localhost:3100/health" "MCP Server (http://localhost:3100)" 15
else
  echo "  ❌ MCP Server NOT started — no build artifacts"
fi

# ── 5. Summary ────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  📋 Service Endpoints                        ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  MCP Server  │ http://localhost:3100/mcp     ║"
echo "║  ChromaDB    │ http://localhost:8000         ║"
echo "║  Memgraph    │ bolt://localhost:7687         ║"
echo "║  Memgraph UI │ http://localhost:3000         ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Logs → /tmp/nexus/*.log                     ║"
echo "║  Re-run → bash /workspace/scripts/start-services.sh ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
