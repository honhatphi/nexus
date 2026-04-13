#!/usr/bin/env bash
# ─── stop-services.sh ─────────────────────────────────────────────────────────
# Stop all Nexus background services started by start-services.sh.
# ─────────────────────────────────────────────────────────────────────────────

PID_DIR="/tmp/nexus/pids"

stop_service() {
  local name="$1"
  local pidfile="$PID_DIR/${name}.pid"
  [ -f "$pidfile" ] || return 0
  local pid
  pid=$(cat "$pidfile" 2>/dev/null) || return 0

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo "  ⏹  $name stopped"
  else
    echo "  ⚪ $name was not running"
  fi
  rm -f "$pidfile"
}

echo "Stopping Nexus services..."
stop_service mcp-server
stop_service socat-chromadb
stop_service socat-memgraph-bolt
stop_service socat-memgraph-lab
echo "Done."
