#!/usr/bin/env node
/**
 * arch-diff.mjs
 * Compares two architecture snapshots and outputs a human-readable delta.
 *
 * Usage:
 *   node scripts/arch-diff.mjs <before.json> <after.json>
 *   node scripts/arch-diff.mjs \
 *     docs/architecture/snapshots/baseline.json \
 *     docs/architecture/snapshots/pr1.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function readSnapshot(filePath) {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(abs, "utf8"));
}

function diffArrays(label, before, after) {
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  const added = [...afterSet].filter((x) => !beforeSet.has(x));
  const removed = [...beforeSet].filter((x) => !afterSet.has(x));
  const unchanged = [...beforeSet].filter((x) => afterSet.has(x));

  const lines = [];
  for (const x of added) lines.push(`  + ${label}: ${x}`);
  for (const x of removed) lines.push(`  - ${label}: ${x}`);
  if (unchanged.length > 0 && added.length === 0 && removed.length === 0) {
    lines.push(`  = ${label}: ${unchanged.length} unchanged`);
  }
  return lines;
}

function diffValue(label, before, after) {
  if (before === after) return [`  = ${label}: ${JSON.stringify(before)}`];
  return [`  ! ${label}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node arch-diff.mjs <before.json> <after.json>");
    process.exit(1);
  }

  const [beforePath, afterPath] = args;
  const before = readSnapshot(beforePath);
  const after = readSnapshot(afterPath);

  console.log("Architecture delta:");
  console.log(
    `  before: ${beforePath} (${before.capturedAt ?? "?"}, commit: ${before.commit ?? "?"})`,
  );
  console.log(
    `  after:  ${afterPath} (${after.capturedAt ?? "?"}, commit: ${after.commit ?? "?"})`,
  );
  console.log("");

  // MCP tools
  const toolLines = diffArrays("MCP tool", before.mcp?.tools, after.mcp?.tools);
  if (toolLines.length > 0) {
    console.log("MCP Tools:");
    toolLines.forEach((l) => console.log(l));
    console.log("");
  }

  // Core modules
  const coreLines = diffArrays(
    "Core module",
    before.core?.modules,
    after.core?.modules,
  );
  if (coreLines.length > 0) {
    console.log("Nexus Core Modules:");
    coreLines.forEach((l) => console.log(l));
    console.log("");
  }

  // Core existence
  if (before.core?.exists !== after.core?.exists) {
    console.log("Nexus Core:");
    console.log(
      `  ! core.exists: ${before.core?.exists} → ${after.core?.exists}`,
    );
    console.log("");
  }

  // Packages
  const packageLines = [];
  const pkgKeys = new Set([
    ...Object.keys(before.packages ?? {}),
    ...Object.keys(after.packages ?? {}),
  ]);
  for (const k of pkgKeys) {
    const bv = before.packages?.[k];
    const av = after.packages?.[k];
    if (bv == null && av != null) packageLines.push(`  + package ${k}: ${av}`);
    else if (bv != null && av == null)
      packageLines.push(`  - package ${k}: ${bv}`);
    else if (bv !== av) packageLines.push(`  ! package ${k}: ${bv} → ${av}`);
    else packageLines.push(`  = package ${k}: ${av}`);
  }
  if (packageLines.length > 0) {
    console.log("Packages:");
    packageLines.forEach((l) => console.log(l));
    console.log("");
  }

  // AGENTS.md
  if (before.agentsFile !== after.agentsFile) {
    console.log("Codex Integration:");
    console.log(`  ! AGENTS.md: ${before.agentsFile} → ${after.agentsFile}`);
    console.log("");
  }

  // codex config
  if (before.codexConfig !== after.codexConfig) {
    console.log("Codex Config:");
    console.log(
      `  ! .codex/config.example.toml: ${before.codexConfig} → ${after.codexConfig}`,
    );
    console.log("");
  }

  // Summary
  const addedTools = (after.mcp?.tools ?? []).filter(
    (t) => !(before.mcp?.tools ?? []).includes(t),
  );
  const removedTools = (before.mcp?.tools ?? []).filter(
    (t) => !(after.mcp?.tools ?? []).includes(t),
  );
  const addedModules = (after.core?.modules ?? []).filter(
    (m) => !(before.core?.modules ?? []).includes(m),
  );

  console.log("Summary:");
  if (addedTools.length > 0)
    console.log(`  + ${addedTools.length} MCP tool(s) added`);
  if (removedTools.length > 0)
    console.log(`  - ${removedTools.length} MCP tool(s) removed`);
  if (addedModules.length > 0)
    console.log(`  + ${addedModules.length} Core module(s) added`);
  if (
    addedTools.length === 0 &&
    removedTools.length === 0 &&
    addedModules.length === 0
  ) {
    console.log("  = No structural changes detected");
  }
}

main();
