#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// doctor-codex-mcp.mjs
// Checks all pre-requisites for Nexus MCP local mode.
// Usage: node scripts/doctor-codex-mcp.mjs
// ─────────────────────────────────────────────────────────────

import { execSync } from "child_process";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";

let allOk = true;

function check(label, fn) {
  try {
    const result = fn();
    console.log(`  ${PASS}  ${label}${result ? ` — ${result}` : ""}`);
  } catch (err) {
    console.log(`  ${FAIL}  ${label} — ${err.message}`);
    allOk = false;
  }
}

function warn(label, fn) {
  try {
    const result = fn();
    console.log(`  ${PASS}  ${label}${result ? ` — ${result}` : ""}`);
  } catch (err) {
    console.log(`  ${WARN}  ${label} — ${err.message} (optional)`);
  }
}

// ── Env-configured endpoints ─────────────────────────────────
const chromadbUrl = process.env.CHROMADB_URL ?? "http://localhost:18000";
const memgraphUri = process.env.MEMGRAPH_URI ?? "bolt://localhost:17687";
const mcpPort = parseInt(process.env.MCP_SERVER_PORT ?? "13100", 10);

function parseHostPort(urlStr, defaultPort) {
  try {
    const u = new URL(urlStr);
    return { host: u.hostname, port: parseInt(u.port, 10) || defaultPort };
  } catch (e) {
    throw new Error(`Invalid URL '${urlStr}': ${e.message}`);
  }
}

const chromaAddr = parseHostPort(chromadbUrl, 8000);
const memgraphAddr = parseHostPort(memgraphUri, 7687);

console.log("\nNexus MCP — Doctor\n");

// ── Node.js ──────────────────────────────────────────────────
console.log("System:");
check("Node.js ≥ 18", () => {
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0], 10);
  if (major < 18) throw new Error(`Node ${v} < 18`);
  return `Node ${v}`;
});

check("Docker running", () => {
  execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
  return "ok";
});

// ── Infrastructure ───────────────────────────────────────────
console.log("\nInfrastructure:");
check(`Memgraph reachable (${memgraphUri})`, () => {
  execSync(`nc -z ${memgraphAddr.host} ${memgraphAddr.port}`, {
    stdio: "pipe",
    timeout: 2000,
  });
  return "ok";
});

check(`ChromaDB reachable (${chromadbUrl})`, () => {
  execSync(`nc -z ${chromaAddr.host} ${chromaAddr.port}`, {
    stdio: "pipe",
    timeout: 2000,
  });
  return "ok";
});

// ── MCP Server ────────────────────────────────────────────────
console.log("\nMCP Server:");

check(`MCP server health (http://localhost:${mcpPort}/health)`, () => {
  const raw = execSync(`curl -s http://localhost:${mcpPort}/health`, {
    stdio: "pipe",
    timeout: 3000,
  }).toString();
  const body = JSON.parse(raw);
  if (body.status !== "ok") throw new Error(`status=${body.status}`);
  return "ok";
});

check("MCP server dist built", () => {
  try {
    execSync("test -f mcp-server/dist/index.js", { stdio: "pipe" });
    return "dist/index.js exists";
  } catch {
    throw new Error("Run: cd mcp-server && npm run build");
  }
});

// ── Codex CLI ────────────────────────────────────────────────
console.log("\nCodex CLI:");
warn("codex CLI available", () => {
  const v = execSync("codex --version 2>/dev/null || echo notfound", {
    stdio: "pipe",
  })
    .toString()
    .trim();
  if (v === "notfound")
    throw new Error("not installed — npm install -g @openai/codex");
  return v;
});

warn("~/.codex/config.toml exists", () => {
  execSync("test -f ~/.codex/config.toml", { stdio: "pipe" });
  return "ok";
});

// ── Summary ──────────────────────────────────────────────────
console.log("");
if (allOk) {
  console.log("\x1b[32mAll checks passed — Nexus MCP is ready.\x1b[0m\n");
} else {
  console.log(
    "\x1b[31mSome checks failed. Fix the issues above, then rerun this script.\x1b[0m\n",
  );
  process.exit(1);
}
