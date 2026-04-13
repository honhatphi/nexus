/**
 * Quick integration test — calls sync_service_knowledge via MCP protocol.
 * Usage: node test-sync.mjs
 */

const MCP_URL = "http://localhost:3100/mcp";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Parse SSE response → extract JSON-RPC result */
function parseSSE(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return JSON.parse(text);
}

async function call(method, params, id = 1) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  return parseSSE(text);
}

async function main() {
  // 1. Initialize
  console.log("=== 1. Initialize MCP session ===");
  const init = await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0" },
  });
  console.log("Server:", init.result?.serverInfo);

  // 2. List tools
  console.log("\n=== 2. List tools ===");
  const tools = await call("tools/list", {}, 2);
  for (const t of tools.result?.tools ?? []) {
    console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}...`);
  }

  // 3. Call sync_service_knowledge
  console.log("\n=== 3. sync_service_knowledge (warehouse-2.0) ===");
  const syncResult = await call(
    "tools/call",
    {
      name: "sync_service_knowledge",
      arguments: {
        service_path: "/workspace/services/warehouse-2.0",
        force_update: false,
      },
    },
    3,
  );

  if (syncResult.result?.content) {
    for (const c of syncResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(syncResult, null, 2));
  }

  // 4. Quick query_graph check
  console.log("\n=== 4. Verify graph — count functions ===");
  const graphResult = await call(
    "tools/call",
    {
      name: "query_graph",
      arguments: {
        cypher:
          "MATCH (f:Function)-[:DEFINED_IN]->(fi:File)-[:BELONGS_TO]->(s:Service) RETURN s.name AS service, count(f) AS functions",
      },
    },
    4,
  );
  if (graphResult.result?.content) {
    for (const c of graphResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(graphResult, null, 2));
  }

  // 4b. Count infrastructure relationships
  console.log("\n=== 4b. Infrastructure — Kafka topics ===");
  const kafkaResult = await call(
    "tools/call",
    {
      name: "query_graph",
      arguments: {
        cypher:
          "MATCH (f:Function)-[r:PRODUCES_TO|CONSUMES_FROM]->(t:KafkaTopic) RETURN type(r) AS relation, t.name AS topic, collect(f.name) AS functions",
      },
    },
    6,
  );
  if (kafkaResult.result?.content) {
    for (const c of kafkaResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(kafkaResult, null, 2));
  }

  console.log("\n=== 4c. Infrastructure — DB connections ===");
  const dbResult = await call(
    "tools/call",
    {
      name: "query_graph",
      arguments: {
        cypher:
          "MATCH (f:Function)-[r:CONNECTS_TO]->(d:Database) RETURN d.name AS database, d.type AS type, count(f) AS functions",
      },
    },
    7,
  );
  if (dbResult.result?.content) {
    for (const c of dbResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(dbResult, null, 2));
  }

  console.log("\n=== 4d. Classes — inheritance ===");
  const classResult = await call(
    "tools/call",
    {
      name: "query_graph",
      arguments: {
        cypher:
          "MATCH (c:Class)-[:INHERITS]->(base:Class) RETURN c.name AS class, base.name AS inherits, c.file AS file LIMIT 20",
      },
    },
    8,
  );
  if (classResult.result?.content) {
    for (const c of classResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(classResult, null, 2));
  }

  console.log("\n=== 4e. CALLS relationships (top 10) ===");
  const callsResult = await call(
    "tools/call",
    {
      name: "query_graph",
      arguments: {
        cypher:
          "MATCH (caller:Function)-[r:CALLS]->(callee:Function) RETURN caller.name AS caller, callee.name AS callee, r.line AS line LIMIT 10",
      },
    },
    9,
  );
  if (callsResult.result?.content) {
    for (const c of callsResult.result.content) {
      console.log(c.text);
    }
  } else {
    console.log(JSON.stringify(callsResult, null, 2));
  }

  // 5. Quick search_knowledge_base check
  console.log("\n=== 5. search_knowledge_base — 'kafka producer' ===");
  const searchResult = await call(
    "tools/call",
    {
      name: "search_knowledge_base",
      arguments: {
        query: "kafka producer config",
        topK: 3,
      },
    },
    5,
  );
  if (searchResult.result?.content) {
    for (const c of searchResult.result.content) {
      const parsed = JSON.parse(c.text);
      console.log(`Found ${parsed.count} results`);
      for (const r of parsed.results ?? []) {
        console.log(`  - ${r.id} (distance: ${r.distance?.toFixed(3)})`);
      }
    }
  } else {
    console.log(JSON.stringify(searchResult, null, 2));
  }
}

main().catch(console.error);
