#!/usr/bin/env node
/**
 * Nexus KB — Auto-sync caller
 *
 * Called by global git hooks (post-push, post-merge).
 * Sends sync_service_knowledge to the local MCP server via JSON-RPC 2.0.
 * Never throws — all errors are logged and silently swallowed so git is not disrupted.
 *
 * Usage: node ~/.nexus/sync-kb.mjs <absolute-repo-path>
 */

const servicePath = process.argv[2];
if (!servicePath) process.exit(0);
const forceUpdate = process.argv[3] === "force";

const MCP_URL = process.env.NEXUS_MCP_URL ?? "http://localhost:13100/mcp";
const TIMEOUT_MS = forceUpdate ? 300_000 : 60_000; // force=5min, incremental=60s
const LOG_PREFIX = `[nexus-kb ${new Date().toISOString()}]`;

/** Parse MCP StreamableHTTP response (JSON or SSE) */
function parseResponse(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // continue
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mcpPost(method, params, id) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse(await res.text());
}

async function run() {
  // 1. Handshake
  await mcpPost(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nexus-git-hook", version: "1.0" },
    },
    1,
  );

  // 2. Incremental sync — only re-parses files that changed since last sync
  const result = await mcpPost(
    "tools/call",
    {
      name: "sync_service_knowledge",
      arguments: {
        service_path: servicePath,
        force_update: forceUpdate, // false = incremental (default), true = full re-sync
      },
    },
    2,
  );

  const content = result?.result?.content?.[0]?.text;
  if (!content) {
    console.log(`${LOG_PREFIX} sync completed (no report returned)`);
    return;
  }

  // Print compact summary
  try {
    const report = JSON.parse(content);
    const phases = report.phases ?? [];
    const fs = phases.find((p) => p.phase === "filesystem")?.stats ?? {};
    const parse = phases.find((p) => p.phase === "parse")?.stats ?? {};
    const totalFiles = fs.totalFiles ?? "?";
    const changedFiles = fs.changedFiles ?? "?";
    const skippedFiles = fs.skippedFiles ?? "?";
    const filesParsed = parse.filesParsed ?? "?";
    console.log(
      `${LOG_PREFIX} sync ok | path=${servicePath} total=${totalFiles} changed=${changedFiles} skipped=${skippedFiles} parsed=${filesParsed}`,
    );
  } catch {
    console.log(`${LOG_PREFIX} sync ok | ${content.slice(0, 120)}`);
  }
}

run().catch((err) => {
  // MCP unavailable or network error — log only, never exit non-zero
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`${LOG_PREFIX} warning: MCP unreachable — ${msg}`);
  console.log(
    `${LOG_PREFIX} KB will be stale until next push/pull or manual sync`,
  );
});
