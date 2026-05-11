#!/usr/bin/env node
/**
 * arch-snapshot.mjs
 * Captures current Nexus architecture state as JSON snapshot.
 * Used to compare architecture before/after each PR.
 *
 * Usage:
 *   node scripts/arch-snapshot.mjs
 *   node scripts/arch-snapshot.mjs > docs/architecture/snapshots/baseline.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function readJson(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function extractMcpTools() {
  // Parse tool registrations from mcp-server/src/tools/index.ts
  const toolsIndex = resolve(ROOT, "mcp-server/src/tools/index.ts");
  if (!existsSync(toolsIndex)) return [];

  const src = readFileSync(toolsIndex, "utf8");

  // Extract tool names from server.tool("tool_name", ...) patterns
  const toolPattern = /server\.tool\(\s*["'`]([^"'`]+)["'`]/g;
  const tools = [];
  let m;
  while ((m = toolPattern.exec(src)) !== null) {
    tools.push(m[1]);
  }

  // Also check other tool files
  const toolFiles = [
    "mcp-server/src/tools/context.ts",
    "mcp-server/src/tools/augment.ts",
    "mcp-server/src/tools/detect-changes.ts",
    "mcp-server/src/tools/parse-code.ts",
    "mcp-server/src/tools/sync-service.ts",
    "mcp-server/src/tools/resources.ts",
    "mcp-server/src/tools/scan-risks.ts",
  ];

  for (const f of toolFiles) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    let match;
    const re = /server\.tool\(\s*["'`]([^"'`]+)["'`]/g;
    while ((match = re.exec(content)) !== null) {
      if (!tools.includes(match[1])) tools.push(match[1]);
    }
  }

  return tools.sort();
}

function extractCoreModules() {
  const coreSrc = resolve(ROOT, "nexus-hub/core/src");
  if (!existsSync(coreSrc)) return [];

  const modules = [];
  const dirs = [
    "nexus-core.ts",
    "ports",
    "adapters",
    "contracts",
    "workspace",
    "memory",
    "artifacts",
    "budget",
    "context",
    "index-state",
    "task-workspace",
  ];

  for (const d of dirs) {
    if (existsSync(resolve(coreSrc, d))) {
      modules.push(d.replace(".ts", ""));
    }
  }

  return modules;
}

function getPackageVersion(relPath) {
  const pkg = readJson(relPath);
  return pkg ? pkg.version : null;
}

import { execSync } from "node:child_process";

function getGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    commit: getGitCommit(),
    mcp: {
      endpoint: "/mcp",
      port: 13100,
      tools: extractMcpTools(),
    },
    packages: {
      "mcp-server": getPackageVersion("mcp-server/package.json"),
      "common-tools": getPackageVersion("nexus-hub/common-tools/package.json"),
      core: getPackageVersion("nexus-hub/core/package.json"),
      cli: getPackageVersion("nexus-hub/cli/package.json"),
    },
    stores: {
      graph: "memgraph",
      vector: "chromadb",
    },
    core: {
      exists: existsSync(resolve(ROOT, "nexus-hub/core")),
      modules: extractCoreModules(),
    },
    legacyToolsFlag: "NEXUS_ENABLE_LEGACY_TOOLS",
    legacyToolsEnabled: process.env.NEXUS_ENABLE_LEGACY_TOOLS === "1",
    agentsFile: existsSync(resolve(ROOT, "AGENTS.md")),
    codexConfig: existsSync(resolve(ROOT, ".codex/config.example.toml")),
  };

  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
