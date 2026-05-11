// ─────────────────────────────────────────────────────────────
// Tests for augment and get_symbol_context tools.
// These are the key new features from GitNexus migration.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerAugmentTool } from "../src/tools/augment.js";
import { registerContextTool } from "../src/tools/context.js";
import { createMockMemgraph } from "./helpers.js";

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

// ─── augment ─────────────────────────────────────────────────

describe("augment tool", () => {
  it("returns matching symbols with context", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        // Symbol search
        [
          "toLower(n.name) CONTAINS toLower($pattern)",
          [
            {
              name: "handle_request",
              file: "handler.py",
              service: "warehouse-2.0",
              type: "Function",
            },
          ],
        ],
        // Callers
        [
          "CALLS.*target",
          [{ target: "handle_request", callers: ["main_flow"] }],
        ],
        // Callees
        [
          "CALLS.*callee",
          [{ source: "handle_request", callees: ["validate"] }],
        ],
        // Processes
        [
          "STEP_IN_PROCESS",
          [{ symbol: "handle_request", processes: ["etl_flow"] }],
        ],
        // Community
        [
          "MEMBER_OF",
          [{ symbol: "handle_request", community: "request-handlers" }],
        ],
      ]),
    );
    registerAugmentTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "augment",
      arguments: { pattern: "handle", limit: 5 },
    });
    const parsed = parseResult(result as any);

    expect(parsed.pattern).toBe("handle");
    expect(parsed.matches).toBe(1);
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0].name).toBe("handle_request");
    expect(parsed.symbols[0].service).toBe("warehouse-2.0");

    await client.close();
  });

  it("returns empty when no matches found", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(); // No responses → empty results
    registerAugmentTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "augment",
      arguments: { pattern: "nonexistent" },
    });
    const parsed = parseResult(result as any);

    expect(parsed.matches).toBe(0);
    expect(parsed.symbols).toEqual([]);

    await client.close();
  });

  it("scopes search by service", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        [
          "toLower(n.name) CONTAINS toLower($pattern)",
          [
            {
              name: "sync_data",
              file: "sync.py",
              service: "warehouse-2.0",
              type: "Function",
            },
          ],
        ],
      ]),
    );
    registerAugmentTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "augment",
      arguments: { pattern: "sync", service: "warehouse-2.0", limit: 3 },
    });
    const parsed = parseResult(result as any);

    expect(parsed.matches).toBe(1);
    // Verify service parameter was passed to Memgraph
    const searchCall = memgraph.calls.find((c) =>
      c.cypher.includes("toLower(n.name) CONTAINS toLower($pattern)"),
    );
    expect(searchCall?.params?.service).toBe("warehouse-2.0");

    await client.close();
  });
});

// ─── get_symbol_context ──────────────────────────────────────

describe("get_symbol_context tool", () => {
  it("returns 360-degree context for a symbol", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        // Symbol info (first query with n.name = $name)
        [
          "labels(n)",
          [
            {
              name: "handle_request",
              file: "handler.py",
              service: "warehouse-2.0",
              language: "python",
              startLine: 10,
              endLine: 25,
              params: "request",
              returnType: "Response",
              type: "Function",
            },
          ],
        ],
        // Callers
        [
          "caller.*CALLS.*target",
          [
            {
              name: "main_flow",
              file: "main.py",
              service: "warehouse-2.0",
              type: "Function",
              confidence: 1.0,
              reason: "",
            },
          ],
        ],
        // Callees
        [
          "source.*CALLS.*callee",
          [
            {
              name: "validate",
              file: "utils.py",
              service: "warehouse-2.0",
              type: "Function",
              confidence: 0.9,
              reason: "static",
            },
          ],
        ],
        // Community
        [
          "MEMBER_OF.*Community",
          [
            {
              communityName: "request-handlers",
              memberCount: 5,
              service: "warehouse-2.0",
            },
          ],
        ],
        // Process
        [
          "STEP_IN_PROCESS",
          [
            {
              processName: "etl_daily",
              entryPoint: "main_flow",
              stepCount: 4,
              stepPosition: 2,
            },
          ],
        ],
        // Heritage — extends/implements/children (empty is fine)
        ["EXTENDS.*parent", []],
        ["IMPLEMENTS.*iface", []],
        ["child.*EXTENDS", []],
        // Infra
        ["USES", []],
        // Staleness (via checkAllStaleness → Service query)
        ["lastSyncCommit", []],
      ]),
    );
    registerContextTool(server, { graph: memgraph } as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "get_symbol_context",
      arguments: { name: "handle_request" },
    });
    const parsed = parseResult(result as any);

    expect(parsed.symbol.name).toBe("handle_request");
    expect(parsed.symbol.file).toBe("handler.py");
    expect(parsed.symbol.language).toBe("python");

    await client.close();
  });

  it("returns error when symbol not found", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(); // all queries return []
    registerContextTool(server, { graph: memgraph } as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "get_symbol_context",
      arguments: { name: "nonexistent_func" },
    });
    const parsed = parseResult(result as any);

    expect(parsed.error).toContain("nonexistent_func");
    expect(parsed.suggestion).toBeDefined();

    await client.close();
  });
});
