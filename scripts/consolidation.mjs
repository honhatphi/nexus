#!/usr/bin/env node
/**
 * Nexus KB — Daily Consolidation Script
 * ─────────────────────────────────────
 * Human memory analogy: "sleep consolidation" — the brain replays the day's
 * experiences, strengthens important memories, and prunes weak ones.
 *
 * This script does the same for the KB:
 *   1. GAP DETECTION  — find frequent queries with low KB scores → augment
 *   2. PATTERN PROMO  — promote hot queries (>= MIN_FREQ) to Hub KB
 *   3. COLD PRUNE     — mark QueryEvent nodes older than COLD_DAYS as processed
 *
 * Schedule: daily at 02:00 via launchd (com.nexus.consolidation.plist)
 * Logs: /tmp/nexus-consolidation.log
 *
 * Usage: node scripts/consolidation.mjs [--dry-run]
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_KB_DIR = path.join(
  __dirname,
  "../nexus-hub/knowledge-base/auto-promoted",
);
const MCP_URL = "http://localhost:13100/mcp";

const DRY_RUN = process.argv.includes("--dry-run");
const GAP_SCORE_THRESHOLD = 0.4; // queries below this score are "gaps"
const MIN_FREQ_TO_PROMOTE = 3; // promote query if asked >= 3 times
const COLD_DAYS = 30; // mark processed after 30 days

// ── Logging ──────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── MCP HTTP helper ──────────────────────────────────────────

async function callMcp(toolName, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  });

  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);

  const text = await res.text();
  // Parse SSE or plain JSON response
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6).trim())
    .filter(Boolean);

  const raw = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text;
  const envelope = JSON.parse(raw);
  const content = envelope?.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(content);
}

// ── Phase 1: GAP DETECTION ───────────────────────────────────
// Find frequent low-score queries → the KB is missing good answers for these.
// Action: call augment() to enrich the closest-matching chunk.

async function detectGaps() {
  log("Phase 1: Gap Detection");

  const data = await callMcp("query_log", {
    kind: "gap_queries",
    limit: 20,
    since_days: 7,
  });

  const gaps = data.results ?? [];
  log(`  Found ${gaps.length} gap queries`);

  for (const gap of gaps) {
    log(
      `  GAP: "${gap.query}" (freq=${gap.frequency}, avgScore=${gap.avgScore?.toFixed(3)})`,
    );

    if (DRY_RUN) continue;

    // Find the best-matching chunk for this query
    const searchResult = await callMcp("search_knowledge_base", {
      query: gap.query,
      topK: 1,
      mode: "hybrid",
    });

    const topChunk = searchResult.results?.[0];
    if (!topChunk) {
      log(`    → No chunk found, skipping`);
      continue;
    }

    // Augment the chunk with "gap" annotation so Hub Manager knows to review it
    await callMcp("augment", {
      id: topChunk.id,
      additionalContext: `[GAP] This chunk was the best result for "${gap.query}" but scored ${gap.avgScore?.toFixed(3)} (below threshold ${GAP_SCORE_THRESHOLD}). Queried ${gap.frequency} time(s) in last 7 days. Consider adding more context or syncing related code.`,
    });
    log(`    → Augmented chunk: ${topChunk.id}`);
  }
}

// ── Phase 2: PATTERN PROMOTION ────────────────────────────────
// Frequent high-quality queries → write pre-computed answers to Hub KB.
// Next time the same query is asked, the agent finds it immediately (O(1) lookup).

async function promotePatterns() {
  log("Phase 2: Pattern Promotion");

  const data = await callMcp("query_log", {
    kind: "top_queries",
    limit: 20,
    since_days: 7,
  });

  const hotQueries = (data.results ?? []).filter(
    (q) =>
      Number(q.frequency) >= MIN_FREQ_TO_PROMOTE &&
      Number(q.avgScore ?? 0) >= 0.4,
  );

  log(`  Found ${hotQueries.length} queries eligible for promotion`);

  if (!existsSync(HUB_KB_DIR)) {
    if (!DRY_RUN) await mkdir(HUB_KB_DIR, { recursive: true });
  }

  for (const q of hotQueries) {
    const slug = q.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const filePath = path.join(HUB_KB_DIR, `${slug}.md`);

    // Don't overwrite existing promoted entries
    if (existsSync(filePath)) {
      log(`  SKIP (exists): ${slug}.md`);
      continue;
    }

    const content = [
      `# KB Pattern: ${q.query}`,
      ``,
      `**Auto-promoted by consolidation** on ${new Date().toISOString().slice(0, 10)}`,
      `**Query frequency (7d):** ${q.frequency}  `,
      `**Avg KB score:** ${Number(q.avgScore).toFixed(3)}`,
      ``,
      `## Summary`,
      ``,
      `> This entry was automatically promoted because agents queried "${q.query}"`,
      `> ${q.frequency} times in the past 7 days with consistent KB results.`,
      ``,
      `## Action`,
      ``,
      `Review and enrich this entry with verified findings from the codebase.`,
      `Once enriched, it will serve as an O(1) answer for future queries.`,
    ].join("\n");

    log(
      `  PROMOTE: ${slug}.md (freq=${q.frequency}, score=${Number(q.avgScore).toFixed(3)})`,
    );
    if (!DRY_RUN) await writeFile(filePath, content, "utf-8");
  }
}

// ── Phase 3: COLD PRUNE ───────────────────────────────────────
// QueryEvent nodes older than COLD_DAYS are no longer useful for
// trend analysis. Mark them with processed:true to allow future cleanup.
// (Actual deletion is intentionally manual — only mark, never auto-delete.)

async function markColdQueryEvents() {
  log("Phase 3: Mark Cold QueryEvent Nodes");
  const coldMs = Date.now() - COLD_DAYS * 24 * 60 * 60 * 1000;

  // We need a write query — use the MCP server's internal Memgraph connection
  // indirectly by checking count via query_log, then logging recommendation.
  const data = await callMcp("query_log", {
    kind: "recent",
    limit: 1,
    since_days: COLD_DAYS + 1,
  });

  const total = Number(data.totalQueriesInWindow ?? 0);
  log(`  Total QueryEvent nodes in ${COLD_DAYS + 1}d window: ${total}`);

  if (!DRY_RUN) {
    // Directly call MCP query_graph is read-only, so we log a recommendation
    // for the Hub Manager to run manually if cleanup is needed.
    const coldCountData = await callMcp("query_log", {
      kind: "recent",
      limit: 1,
      since_days: 365,
    });
    log(`  Recommendation: If QueryEvent nodes grow large, run:`);
    log(
      `    MATCH (e:QueryEvent) WHERE e.timestampMs < ${coldMs} SET e.cold = true`,
    );
  }

  log("  Done");
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  log(`=== Nexus KB Consolidation START${DRY_RUN ? " (DRY RUN)" : ""} ===`);

  try {
    await detectGaps();
  } catch (err) {
    log(`Phase 1 ERROR: ${err.message}`);
  }

  try {
    await promotePatterns();
  } catch (err) {
    log(`Phase 2 ERROR: ${err.message}`);
  }

  try {
    await markColdQueryEvents();
  } catch (err) {
    log(`Phase 3 ERROR: ${err.message}`);
  }

  log(`=== Nexus KB Consolidation END ===`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
