// ─────────────────────────────────────────────────────────────
// Tests for detect_changes and get_process_flows tools.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerDetectChangesTool } from "../src/tools/detect-changes.js";
import { registerProcessFlowsTool } from "../src/tools/resources.js";
import { createMockMemgraph } from "./helpers.js";

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

// ─── detect_changes ──────────────────────────────────────────

describe("detect_changes tool", () => {
  it("returns no-changes message when git diff is empty", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph();
    registerDetectChangesTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // Use a non-existent path to force empty git diff
    const result = await client.callTool({
      name: "detect_changes",
      arguments: { service_path: "/tmp/nonexistent-service", ref: "HEAD~1" },
    });
    const parsed = parseResult(result as any);

    expect(parsed.message).toContain("No changes");

    await client.close();
  });
});

// ─── get_process_flows ───────────────────────────────────────

describe("get_process_flows tool", () => {
  it("returns forward and backward flows", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(
      new Map([
        // Forward traces
        [
          "start:Function.*CALLS",
          [
            {
              steps: ["handle_request", "validate", "save"],
              files: ["handler.py", "utils.py", "db.py"],
              depth: 2,
            },
          ],
        ],
        // Backward traces
        [
          "entry:Function.*CALLS.*target:Function",
          [
            {
              steps: ["main_flow", "route", "handle_request"],
              files: ["main.py", "router.py", "handler.py"],
              depth: 2,
            },
          ],
        ],
        // Process membership
        [
          "Process.*entryPoint",
          [
            {
              processName: "etl_daily_stock",
              stepCount: 5,
              members: ["extract", "transform", "load"],
            },
          ],
        ],
        // Staleness
        ["lastSyncCommit", []],
      ]),
    );
    registerProcessFlowsTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "get_process_flows",
      arguments: { function_name: "handle_request", max_depth: 5 },
    });
    const parsed = parseResult(result as any);

    expect(parsed.function).toBe("handle_request");
    expect(parsed.forwardFlows).toBeDefined();
    expect(parsed.backwardFlows).toBeDefined();
    expect(parsed.processes).toBeDefined();

    await client.close();
  });

  it("returns empty flows when function has no call chains", async () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const memgraph = createMockMemgraph(new Map([["lastSyncCommit", []]]));
    registerProcessFlowsTool(server, memgraph as any);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "get_process_flows",
      arguments: { function_name: "isolated_func" },
    });
    const parsed = parseResult(result as any);

    expect(parsed.function).toBe("isolated_func");
    expect(parsed.forwardFlows).toEqual([]);
    expect(parsed.backwardFlows).toEqual([]);
    expect(parsed.processes).toEqual([]);

    await client.close();
  });
});
