#!/usr/bin/env node
/**
 * Smoke test — local-first MCP flow (no Codex / Copilot required).
 *
 * Checks every prerequisite and gate-checks the MCP server health endpoint.
 * Optionally calls nexus_resolve_workspace when the server is already running.
 *
 * Usage:
 *   node scripts/smoke-local-first.mjs
 *   MCP_URL=http://localhost:13100 node scripts/smoke-local-first.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_URL = process.env.MCP_URL ?? "http://localhost:13100";
const DIST = path.join(ROOT, "mcp-server", "dist", "index.js");

let passed = 0;
let failed = 0;

// ── Helpers ───────────────────────────────────────────────────

function ok(label) {
  console.log(`  ✔  ${label}`);
  passed++;
}

function fail(label, hint) {
  console.error(`  ✖  ${label}`);
  if (hint) console.error(`     → ${hint}`);
  failed++;
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function mcpCall(method, params, id = 1) {
  const result = await fetchJson(`${MCP_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!result.ok) return null;
  // Parse SSE or plain JSON
  for (const line of result.body.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        /* fall through */
      }
    }
  }
  try {
    return JSON.parse(result.body);
  } catch {
    return null;
  }
}

// ── Gate 1: Build artefact ────────────────────────────────────

section("Build artefact");
if (fs.existsSync(DIST)) {
  ok(`mcp-server/dist/index.js exists`);
} else {
  fail(
    `mcp-server/dist/index.js not found`,
    "Run: cd mcp-server && npm run build",
  );
}

// ── Gate 2: Environment ───────────────────────────────────────

section("Environment");
const wsRoot = process.env.NEXUS_WORKSPACE_ROOT;
if (wsRoot) {
  if (fs.existsSync(wsRoot)) {
    ok(`NEXUS_WORKSPACE_ROOT exists: ${wsRoot}`);
  } else {
    fail(
      `NEXUS_WORKSPACE_ROOT set but path does not exist: ${wsRoot}`,
      "Update the env var to a valid directory.",
    );
  }
} else {
  ok(`NEXUS_WORKSPACE_ROOT not set — tools will fall back to process.cwd()`);
}

// ── Gate 3: Workspace manifest ────────────────────────────────

section("Workspace manifest");
const searchRoots = [wsRoot, process.cwd(), ROOT].filter(Boolean);
let manifestFound = false;
for (const dir of searchRoots) {
  const candidate = path.join(dir, ".nexus", "workspace.yaml");
  if (fs.existsSync(candidate)) {
    ok(`.nexus/workspace.yaml found at ${candidate}`);
    manifestFound = true;
    break;
  }
}
if (!manifestFound) {
  fail(
    ".nexus/workspace.yaml not found",
    "Run: nexus_resolve_workspace (via MCP) or create it manually.",
  );
}

// ── Gate 4: MCP server health ─────────────────────────────────

section("MCP server health");
const health = await fetchJson(`${MCP_URL}/health`);
if (health.ok) {
  let parsed;
  try {
    parsed = JSON.parse(health.body);
  } catch {
    parsed = {};
  }
  if (parsed.status === "ok") {
    ok(`Health endpoint responded: ${health.body}`);
  } else {
    fail(
      `Health endpoint returned unexpected body: ${health.body}`,
      "Check server logs.",
    );
  }
} else if (health.status === 0) {
  fail(
    `Cannot reach ${MCP_URL}/health — server not running or wrong port`,
    [
      "Start infra:  docker compose up memgraph chromadb -d",
      "Start server: cd mcp-server && node dist/index.js",
    ].join("\n     → "),
  );
} else {
  fail(
    `Health check returned HTTP ${health.status}`,
    `Response: ${health.body}`,
  );
}

// ── Gate 5: MCP initialize (only if health passed) ───────────

section("MCP protocol");
const initResp = await mcpCall("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "1.0" },
});

if (initResp?.result?.serverInfo) {
  ok(
    `MCP initialize OK — server: ${initResp.result.serverInfo.name} v${initResp.result.serverInfo.version}`,
  );

  // ── Gate 6: Tool listing ────────────────────────────────────
  const toolsResp = await mcpCall("tools/list", {}, 2);
  const tools = toolsResp?.result?.tools ?? [];
  const LOCAL_FIRST_TOOLS = [
    "nexus_resolve_workspace",
    "nexus_sync_current_repo",
    "nexus_build_context_pack",
    "nexus_spawn_task_workspace",
    "nexus_get_task_workspace",
    "nexus_apply_task_patch",
  ];
  const registered = new Set(tools.map((t) => t.name));
  section("Local-first tool registration");
  for (const name of LOCAL_FIRST_TOOLS) {
    if (registered.has(name)) {
      ok(name);
    } else {
      fail(name, "Tool not registered — check server startup logs.");
    }
  }

  // ── Gate 7: nexus_resolve_workspace smoke call ──────────────
  section("nexus_resolve_workspace (smoke call)");
  const cwd = wsRoot ?? process.cwd();
  const resolveResp = await mcpCall(
    "tools/call",
    { name: "nexus_resolve_workspace", arguments: { cwd, debug: false } },
    3,
  );
  const resolveContent = resolveResp?.result?.content?.[0]?.text;
  if (resolveContent) {
    let resolveData;
    try {
      resolveData = JSON.parse(resolveContent);
    } catch {
      resolveData = null;
    }
    if (resolveData?.workspaceId) {
      ok(`nexus_resolve_workspace → workspaceId: ${resolveData.workspaceId}`);
    } else if (resolveData?.isError || resolveResp?.result?.isError) {
      fail(
        `nexus_resolve_workspace returned error: ${resolveContent}`,
        "Run with workspace_id to initialise.",
      );
    } else {
      ok(
        `nexus_resolve_workspace responded (raw): ${resolveContent.slice(0, 120)}`,
      );
    }
  } else {
    fail(
      "nexus_resolve_workspace returned no content",
      "Check server logs for errors.",
    );
  }
} else if (initResp === null) {
  ok("MCP server not running — protocol checks skipped");
} else {
  fail(
    "MCP initialize failed",
    `Response: ${JSON.stringify(initResp).slice(0, 200)}`,
  );
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log("─".repeat(50));
if (failed > 0) {
  console.error("\nSome checks failed. See hints above.");
  process.exit(1);
} else {
  console.log("\nAll smoke checks passed.");
}
