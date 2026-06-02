#!/usr/bin/env bash
set -euo pipefail
MCP_URL=${MCP_URL:-http://localhost:13100/mcp}
res=$(curl -sS -X POST "$MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nexus_sync_status","arguments":{}}}')
data=$(printf "%s" "$res" | sed -n 's/^data: //p' | tr -d '\r\n')
raw=$(printf "%s" "$data" | jq -r '.result.content[0].text' 2>/dev/null || true)
if [ -z "${raw}" ] || [ "${raw}" = "null" ]; then
  echo "No sync status data returned from MCP"
  exit 1
fi
# Parse entire raw string as JSON in one go
parsed=$(printf '%s' "$raw" | jq -R -s 'fromjson? // .')
# Determine iteration source
if printf '%s' "$parsed" | jq -e 'has("jobs")' >/dev/null 2>&1; then
  entries=$(printf '%s' "$parsed" | jq -c '.jobs[]')
elif printf '%s' "$parsed" | jq -e 'type=="array"' >/dev/null 2>&1; then
  entries=$(printf '%s' "$parsed" | jq -c '.[]')
else
  entries=$(printf '%s' "$parsed" | jq -c '.')
fi
# Iterate and print concise summary
printf '%s' "$entries" | while read -r job; do
  jobId=$(echo "$job" | jq -r '.jobId // .job_id // empty')
  service=$(echo "$job" | jq -r '.service // empty')
  status=$(echo "$job" | jq -r '.status // empty')
  filesTotal=$(echo "$job" | jq -r '.filesTotal // .files_total // empty')
  filesChanged=$(echo "$job" | jq -r '.filesChanged // .files_changed // empty')
  symbolsIndexed=$(echo "$job" | jq -r '.symbolsIndexed // .symbols_indexed // empty')
  durationMs=$(echo "$job" | jq -r '.durationMs // empty')
  errors=$(echo "$job" | jq -r 'if (.errors|type)=="array" then (.errors|length) elif .errors==null then 0 else 1 end')
  printf "%-36s %-18s %-8s files:%6s changed:%6s symbols:%6s dur:%6sms errors:%s\n" "$jobId" "$service" "$status" "$filesTotal" "$filesChanged" "$symbolsIndexed" "$durationMs" "$errors"
done
