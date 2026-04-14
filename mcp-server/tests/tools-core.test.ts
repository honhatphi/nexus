// ─────────────────────────────────────────────────────────────
// Tests for query_graph, search_knowledge_base, get_impact_analysis,
// and check_staleness tools registered in tools/index.ts.
// Uses a lightweight McpServer + mock DB clients.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerTools } from "../src/tools/index.js";
import { createMockMemgraph, createMockChromaDB } from "./helpers.js";

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("registerTools — query_graph", () => {
  it("blocks mutation keywords", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph();
    const chromadb = createMockChromaDB();
    registerTools(server, memgraph as any, chromadb as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "query_graph",
      arguments: { cypher: "CREATE (n:Test)" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toContain("CREATE");

    await client.close();
  });

  it("executes valid read queries", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        ["MATCH", [{ name: "handle_request", service: "warehouse-2.0" }]],
      ]),
    );
    const chromadb = createMockChromaDB();
    registerTools(server, memgraph as any, chromadb as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "query_graph",
      arguments: { cypher: "MATCH (f:Function) RETURN f.name AS name LIMIT 1" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].name).toBe("handle_request");
    expect(parsed.count).toBe(1);

    await client.close();
  });

  it("blocks DELETE keyword", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph();
    const chromadb = createMockChromaDB();
    registerTools(server, memgraph as any, chromadb as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "query_graph",
      arguments: { cypher: "MATCH (n) DELETE n" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.error).toContain("DELETE");

    await client.close();
  });
});

describe("registerTools — search_knowledge_base", () => {
  it("calls hybrid search and returns results", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph();
    const chromadb = createMockChromaDB([
      {
        id: "fn:test:func1",
        document: "kafka producer",
        metadata: { name: "func1" },
        distance: 0.15,
      },
    ]);
    registerTools(server, memgraph as any, chromadb as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "search_knowledge_base",
      arguments: { query: "kafka producer", topK: 3, mode: "semantic" },
    });
    const parsed = parseResult(result as any);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.mode).toBe("semantic");

    await client.close();
  });
});

describe("registerTools — get_impact_analysis", () => {
  it("returns dependency info for a function", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        [
          "getImpact",
          [{ source: "handle_request", dependency: "validate", depth: 1 }],
        ],
      ]),
    );
    const chromadb = createMockChromaDB([
      {
        id: "fn:test:validate",
        document: "validate input",
        metadata: {},
        distance: 0.3,
      },
    ]);
    registerTools(server, memgraph as any, chromadb as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "get_impact_analysis",
      arguments: { name: "handle_request", maxDepth: 3 },
    });
    const parsed = parseResult(result as any);
    expect(parsed.target).toBe("handle_request");
    expect(parsed.dependencies).toHaveLength(1);
    expect(parsed.relatedCode).toHaveLength(1);

    await client.close();
  });
});
