/**
 * Integration test for NEW tools — augment, get_symbol_context,
 * detect_changes, get_process_flows, check_staleness.
 * Requires: MCP server running + KB already synced.
 * Usage: node test-new-tools.mjs
 */

const MCP_URL = "http://localhost:3100/mcp";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function parseSSE(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return JSON.parse(text);
}

let callId = 0;
async function call(method, params) {
  callId++;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }),
  });
  const text = await res.text();
  return parseSSE(text);
}

function getContent(result) {
  if (result.result?.content?.[0]?.text) {
    return JSON.parse(result.result.content[0].text);
  }
  return result;
}

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name} ${detail}`);
    failed++;
  }
}

async function main() {
  // 0. Initialize
  await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-new-tools", version: "1.0" },
  });

  // ── 1. check_staleness ───────────────────────────────────
  console.log("\n=== 1. check_staleness ===");
  const staleResult = await call("tools/call", {
    name: "check_staleness",
    arguments: {},
  });
  const staleData = getContent(staleResult);
  assert(
    "returns services array",
    Array.isArray(staleData.services) || staleData.message !== undefined,
  );
  console.log(`  → ${JSON.stringify(staleData).slice(0, 200)}`);

  // ── 2. augment ───────────────────────────────────────────
  console.log("\n=== 2. augment — pattern search ===");
  const augResult = await call("tools/call", {
    name: "augment",
    arguments: { pattern: "send", limit: 3 },
  });
  const augData = getContent(augResult);
  assert("has pattern field", augData.pattern === "send");
  assert("has matches count", typeof augData.matches === "number");
  assert("symbols is array", Array.isArray(augData.symbols));
  if (augData.symbols.length > 0) {
    const sym = augData.symbols[0];
    assert("symbol has name", typeof sym.name === "string");
    assert("symbol has file", sym.file !== undefined, `got: ${sym.file}`);
    assert(
      "symbol has service",
      sym.service !== undefined,
      `got: ${sym.service}`,
    );
    assert("symbol has callers array", Array.isArray(sym.callers));
    assert("symbol has callees array", Array.isArray(sym.callees));
  }
  console.log(`  → Found ${augData.matches} symbols`);

  // ── 3. augment with service scope ────────────────────────
  console.log("\n=== 3. augment — scoped to warehouse-2.0 ===");
  const augScopedResult = await call("tools/call", {
    name: "augment",
    arguments: { pattern: "extract", service: "warehouse-2.0", limit: 5 },
  });
  const augScopedData = getContent(augScopedResult);
  assert("scoped search works", typeof augScopedData.matches === "number");
  if (augScopedData.symbols?.length > 0) {
    assert(
      "all symbols from correct service",
      augScopedData.symbols.every((s) => s.service === "warehouse-2.0"),
    );
  }
  console.log(`  → Found ${augScopedData.matches} symbols in warehouse-2.0`);

  // ── 4. get_symbol_context ────────────────────────────────
  console.log("\n=== 4. get_symbol_context — 360° view ===");

  // First find a function name to look up
  const fnResult = await call("tools/call", {
    name: "query_graph",
    arguments: {
      cypher:
        "MATCH (f:Function {service: 'warehouse-2.0'}) RETURN f.name AS name LIMIT 1",
    },
  });
  const fnData = getContent(fnResult);
  const funcName = fnData.results?.[0]?.name;

  if (funcName) {
    console.log(`  → Looking up: ${funcName}`);
    const ctxResult = await call("tools/call", {
      name: "get_symbol_context",
      arguments: { name: funcName, service: "warehouse-2.0" },
    });
    const ctxData = getContent(ctxResult);

    assert("has symbol info", ctxData.symbol?.name === funcName);
    assert("has callers", ctxData.callers !== undefined);
    assert("has callees", ctxData.callees !== undefined);
    assert("has community", ctxData.community !== undefined);
    assert("has processes", ctxData.processes !== undefined);
    assert("has heritage", ctxData.heritage !== undefined);
    assert("has infrastructure", ctxData.infrastructure !== undefined);

    console.log(
      `  → Callers: ${ctxData.callers?.count ?? 0}, Callees: ${ctxData.callees?.count ?? 0}`,
    );
    if (ctxData.community?.length > 0) {
      console.log(`  → Community: ${ctxData.community[0].name}`);
    }
  } else {
    console.log("  ⚠️ No functions found in KB — skip get_symbol_context test");
  }

  // ── 5. get_symbol_context — not found ────────────────────
  console.log("\n=== 5. get_symbol_context — unknown symbol ===");
  const notFoundResult = await call("tools/call", {
    name: "get_symbol_context",
    arguments: { name: "this_function_does_not_exist_xyz" },
  });
  const notFoundData = getContent(notFoundResult);
  assert(
    "returns error for unknown symbol",
    notFoundData.error?.includes("not found"),
  );
  assert("suggests alternative", notFoundData.suggestion !== undefined);

  // ── 6. get_process_flows ─────────────────────────────────
  console.log("\n=== 6. get_process_flows ===");
  if (funcName) {
    const flowResult = await call("tools/call", {
      name: "get_process_flows",
      arguments: { function_name: funcName, max_depth: 5 },
    });
    const flowData = getContent(flowResult);
    if (flowData.error) {
      console.log(`  ⚠️ Error: ${flowData.error}`);
      assert(
        "get_process_flows returned data (not error)",
        false,
        flowData.error,
      );
    } else {
      assert("has function field", flowData.function === funcName);
      assert("has forwardFlows", Array.isArray(flowData.forwardFlows));
      assert("has backwardFlows", Array.isArray(flowData.backwardFlows));
      assert("has processes", Array.isArray(flowData.processes));
      console.log(
        `  → Forward: ${flowData.forwardFlows.length}, Backward: ${flowData.backwardFlows.length}, Processes: ${flowData.processes.length}`,
      );
    }
  }

  // ── 7. detect_changes ────────────────────────────────────
  console.log("\n=== 7. detect_changes ===");
  const detectResult = await call("tools/call", {
    name: "detect_changes",
    arguments: {
      service_path: "/workspace/services/warehouse-2.0",
      ref: "HEAD~1",
    },
  });
  const detectData = getContent(detectResult);
  assert(
    "returns analysis or no-changes",
    detectData.analysis !== undefined || detectData.message !== undefined,
  );
  if (detectData.analysis) {
    assert("has risk summary", detectData.riskSummary !== undefined);
    console.log(
      `  → Changed files: ${detectData.totalChangedFiles}, Risk: ${JSON.stringify(detectData.riskSummary)}`,
    );
  } else {
    console.log(`  → ${detectData.message}`);
  }

  // ── 8. search_knowledge_base (hybrid mode) ───────────────
  console.log("\n=== 8. search_knowledge_base — hybrid ===");
  const searchResult = await call("tools/call", {
    name: "search_knowledge_base",
    arguments: { query: "kafka producer", topK: 3, mode: "hybrid" },
  });
  const searchData = getContent(searchResult);
  assert("has results array", Array.isArray(searchData.results));
  assert("has count", typeof searchData.count === "number");
  assert("mode is hybrid", searchData.mode === "hybrid");
  console.log(`  → Found ${searchData.count} results`);

  // ── Summary ──────────────────────────────────────────────
  console.log("\n" + "═".repeat(50));
  console.log(
    `RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`,
  );
  console.log("═".repeat(50));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
