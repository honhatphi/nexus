// ─────────────────────────────────────────────────────────────
// MCP Resources & Process Flows Tool
// Registers lightweight MCP resources for token-efficient
// context retrieval, plus the get_process_flows tool.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemgraphClient } from "../clients/memgraph.js";

// ── get_process_flows Tool ───────────────────────────────────

export function registerProcessFlowsTool(
  server: McpServer,
  memgraph: MemgraphClient,
): void {
  server.tool(
    "get_process_flows",
    "Discover execution flows through a function — traces the call chain from entry points to terminal functions. Use to understand how a function fits into larger workflows.",
    {
      function_name: z.string().describe("Function name to trace flows for."),
      service: z
        .string()
        .optional()
        .describe("Optional service name to scope the search."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(15)
        .default(10)
        .describe(
          "Maximum traversal depth in the call graph (1–15, default 10).",
        ),
    },
    async ({ function_name, service, max_depth }) => {
      try {
        const serviceFilter = service
          ? "AND start.service = $service AND end.service = $service"
          : "";

        // Forward traces: function → terminal
        const forwardTraces = await memgraph.query(
          `MATCH path = (start:Function {name: $name})-[:CALLS*1..${max_depth}]->(end:Function)
           WHERE NOT (end)-[:CALLS]->(:Function)
             AND start <> end
             ${serviceFilter}
           RETURN [n IN nodes(path) | n.name] AS steps,
                  [n IN nodes(path) | n.file] AS files,
                  length(path) AS depth
           ORDER BY depth DESC
           LIMIT 5`,
          { name: function_name, service: service ?? "" },
        );

        // Backward traces: entry point → function
        const backwardTraces = await memgraph.query(
          `MATCH path = (entry:Function)-[:CALLS*1..${max_depth}]->(target:Function {name: $name})
           WHERE NOT ()-[:CALLS]->(entry)
             AND entry <> target
             ${serviceFilter}
           RETURN [n IN nodes(path) | n.name] AS steps,
                  [n IN nodes(path) | n.file] AS files,
                  length(path) AS depth
           ORDER BY depth DESC
           LIMIT 5`,
          { name: function_name, service: service ?? "" },
        );

        // Check if function is a known process entry point
        const processes = await memgraph.query(
          `MATCH (p:Process {entryPoint: $name})
           OPTIONAL MATCH (f:Function)-[r:STEP_IN_PROCESS]->(p)
           RETURN p.name AS processName,
                  p.stepCount AS stepCount,
                  collect(f.name) AS members
           ORDER BY p.stepCount DESC`,
          { name: function_name },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  function: function_name,
                  service: service ?? "all",
                  forwardFlows: forwardTraces.map((t) => ({
                    steps: t.steps,
                    files: t.files,
                    depth: t.depth,
                  })),
                  backwardFlows: backwardTraces.map((t) => ({
                    steps: t.steps,
                    files: t.files,
                    depth: t.depth,
                  })),
                  processes: processes.map((p) => ({
                    name: p.processName,
                    stepCount: p.stepCount,
                    members: p.members,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── MCP Resources ────────────────────────────────────────────

export function registerResources(
  server: McpServer,
  memgraph: MemgraphClient,
): void {
  // 1. nexus://services — List all indexed services with sync status
  server.resource(
    "nexus-services",
    "nexus://services",
    {
      description:
        "List all indexed services with sync status and staleness info",
    },
    async () => {
      const services = await memgraph.query(`
        MATCH (s:Service)
        OPTIONAL MATCH (s)<-[:BELONGS_TO]-(f:File)
        WITH s, count(f) AS fileCount
        OPTIONAL MATCH (fn:Function {service: s.name})
        WITH s, fileCount, count(fn) AS funcCount
        RETURN s.name AS name,
               s.lastSyncAt AS lastSync,
               s.lastSyncCommit AS commit,
               s.lastSyncFileCount AS syncFileCount,
               fileCount,
               funcCount
        ORDER BY s.name
      `);

      return {
        contents: [
          {
            uri: "nexus://services",
            text: JSON.stringify(services, null, 2),
          },
        ],
      };
    },
  );

  // 2. nexus://overview/{service} — Service overview with stats
  server.resource(
    "nexus-service-overview",
    "nexus://overview/{service}",
    {
      description:
        "Service overview with file, function, class, and infra counts",
    },
    async (uri) => {
      const service = uri.pathname.split("/").pop() ?? "";

      const stats = await memgraph.query(
        `MATCH (fn:Function {service: $service})
         WITH count(fn) AS funcCount
         OPTIONAL MATCH (c:Class {service: $service})
         WITH funcCount, count(c) AS classCount
         OPTIONAL MATCH (f:File)-[:BELONGS_TO]->(s:Service {name: $service})
         WITH funcCount, classCount, count(f) AS fileCount
         OPTIONAL MATCH (:Function {service: $service})-[r:CALLS]->()
         WITH funcCount, classCount, fileCount, count(r) AS callEdges
         OPTIONAL MATCH (:Function {service: $service})-[:USES]->(i)
         RETURN funcCount, classCount, fileCount, callEdges, count(i) AS infraPatterns`,
        { service },
      );

      const languages = await memgraph.query(
        `MATCH (fn:Function {service: $service})
         RETURN DISTINCT fn.language AS language, count(fn) AS count
         ORDER BY count DESC`,
        { service },
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              { service, stats: stats[0] ?? {}, languages },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 3. nexus://clusters/{service} — Community clusters
  server.resource(
    "nexus-service-clusters",
    "nexus://clusters/{service}",
    { description: "Auto-detected community clusters for a service" },
    async (uri) => {
      const service = uri.pathname.split("/").pop() ?? "";

      const clusters = await memgraph.query(
        `MATCH (c:Community {service: $service})<-[:MEMBER_OF]-(f:Function)
         RETURN c.name AS community,
                c.memberCount AS memberCount,
                collect(f.name) AS members
         ORDER BY c.memberCount DESC`,
        { service },
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ service, clusters }, null, 2),
          },
        ],
      };
    },
  );

  // 4. nexus://flows/{service} — Execution flows / process traces
  server.resource(
    "nexus-service-flows",
    "nexus://flows/{service}",
    { description: "Execution flows (process traces) for a service" },
    async (uri) => {
      const service = uri.pathname.split("/").pop() ?? "";

      const processes = await memgraph.query(
        `MATCH (p:Process {service: $service})
         OPTIONAL MATCH (f:Function)-[r:STEP_IN_PROCESS]->(p)
         WITH p, f, r
         ORDER BY r.step
         RETURN p.name AS process,
                p.entryPoint AS entryPoint,
                p.stepCount AS stepCount,
                collect(f.name) AS steps
         ORDER BY p.stepCount DESC`,
        { service },
      );

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ service, processes }, null, 2),
          },
        ],
      };
    },
  );
}
