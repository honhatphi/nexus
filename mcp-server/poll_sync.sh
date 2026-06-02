#!/usr/bin/env bash
set -euo pipefail

JOB=${1:-sync_1780289981990_5hplr7}
OUT=${2:-/tmp/nexus_sync_result.json}
URL=${3:-http://localhost:13100/mcp}
INTERVAL=${4:-5}

command -v jq >/dev/null 2>&1 || { echo "Please install jq"; exit 2; }

echo "Polling job ${JOB} -> writing final JSON to ${OUT}"
while true; do
  resp=$(curl -s -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"nexus_sync_status\",\"arguments\":{\"job_id\":\"${JOB}\"}}}" \
    "${URL}" 2>/dev/null || true)

  # try to extract data: lines then extract JSON text fields
  inner=$(printf '%s
' "$resp" | sed -n 's/^data: //p' | jq -r '.result.content[-1].text' 2>/dev/null || true)
 
   # Removed duplicate line that broke shell quoting
   # ' "$resp" | sed -n 's/^data: //p' | jq -r '.result.content[]?.text' 2>/dev/null | tail -n1 || true)

  if [ -z "$inner" ]; then
    echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") no status received, retrying..."
    sleep 2
    continue
  fi

  # write parsed JSON to OUT
  printf '%s
' "$inner" | jq . > "${OUT}"

  status=$(jq -r '.status // "unknown"' "${OUT}")
  phase=$(jq -r '.currentPhase // "unknown"' "${OUT}")
  doneCnt=$(jq -r '.phasesCompleted // 0' "${OUT}")
  totalCnt=$(jq -r '.phasesTotal // 0' "${OUT}")

  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") Job=${JOB} Status=${status} Phase=${phase} ${doneCnt}/${totalCnt}"

  if [ "$status" != "running" ]; then
    echo "Final result saved: ${OUT}"
    exit 0
  fi

  sleep "${INTERVAL}"
done
