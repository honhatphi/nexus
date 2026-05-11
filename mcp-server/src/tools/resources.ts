// ─────────────────────────────────────────────────────────────
// MCP Resources & Process Flows Tool
// Registers lightweight MCP resources for token-efficient
// context retrieval, plus the get_process_flows tool.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemgraphClient } from "../clients/memgraph.js";
import { checkAllStaleness } from "./index.js";

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
        const forwardServiceFilter = service
          ? "AND start.service = $service AND end.service = $service"
          : "";
        const backwardServiceFilter = service
          ? "AND entry.service = $service AND target.service = $service"
          : "";

        // Forward traces: function → leaf (no outgoing CALLS)
        const forwardTraces = await memgraph.query(
          `MATCH path = (start:Function {name: $name})-[:CALLS*1..${max_depth}]->(end:Function)
           WHERE start <> end
             ${forwardServiceFilter}
           WITH path, end, size(nodes(path))-1 AS depth
           OPTIONAL MATCH (end)-[:CALLS]->(next:Function)
           WITH path, depth, next
           WHERE next IS NULL
           UNWIND nodes(path) AS n
           WITH path, depth, collect(n.name) AS steps, collect(n.file) AS files
           RETURN steps, files, depth
           ORDER BY depth DESC
           LIMIT 5`,
          { name: function_name, service: service ?? "" },
        );

        // Backward traces: entry point (no incoming CALLS) → function
        const backwardTraces = await memgraph.query(
          `MATCH path = (entry:Function)-[:CALLS*1..${max_depth}]->(target:Function {name: $name})
           WHERE entry <> target
             ${backwardServiceFilter}
           WITH path, entry, size(nodes(path))-1 AS depth
           OPTIONAL MATCH (prev:Function)-[:CALLS]->(entry)
           WITH path, depth, prev
           WHERE prev IS NULL
           UNWIND nodes(path) AS n
           WITH path, depth, collect(n.name) AS steps, collect(n.file) AS files
           RETURN steps, files, depth
           ORDER BY depth DESC
           LIMIT 5`,
          { name: function_name, service: service ?? "" },
        );

        // Check if function is a known process entry point
        let processes: Record<string, unknown>[] = [];
        try {
          const procs = await memgraph.query(
            `MATCH (p:Process)
             WHERE p.entryPoint = $name
             RETURN p.name AS processName, p.stepCount AS stepCount`,
            { name: function_name },
          );
          for (const proc of procs) {
            const members = await memgraph.query(
              `MATCH (f:Function)-[:STEP_IN_PROCESS]->(p:Process {name: $pname})
               RETURN collect(f.name) AS members`,
              { pname: proc.processName as string },
            );
            processes.push({
              processName: proc.processName,
              stepCount: proc.stepCount,
              members: members[0]?.members ?? [],
            });
          }
        } catch {
          // Process nodes may not exist — not critical
        }

        const staleness = await checkAllStaleness(memgraph);

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
                  ...(staleness.length > 0
                    ? { stalenessWarnings: staleness }
                    : {}),
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
