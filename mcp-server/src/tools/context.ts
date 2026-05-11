// ─────────────────────────────────────────────────────────────
// get_symbol_context — MCP tool that provides a 360-degree view
// of a symbol (function, class, method) in a single call.
// Returns callers, callees, community, processes, heritage,
// and infrastructure patterns — replacing 3-4 separate tool calls.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { INexusCore } from "@nexus-hub/core";
import { checkAllStaleness } from "./index.js";

export function registerContextTool(server: McpServer, core: INexusCore): void {
  server.registerTool("get_symbol_context", {
    description: "Get a 360-degree view of a symbol (function, class, or method) in a single call. Returns: callers (who calls it), callees (what it calls), community membership, process/execution flows, class heritage (extends/implements), and infrastructure patterns. Use this instead of multiple separate queries.",
    inputSchema: {
      name: z
        .string()
        .describe("Symbol name to look up (function, class, or method)."),
      service: z
        .string()
        .optional()
        .describe("Optional service name to scope the lookup."),
    },
  }, async ({ name, service }) => {
      try {
        const graph = core.graph;
        const svcFilter = service ? "AND n.service = $service" : "";
        const svcParam = service ?? "";

        // 1. Symbol info
        const symbols = await graph.query(
          `MATCH (n)
           WHERE (n:Function OR n:Class OR n:Method)
             AND n.name = $name ${svcFilter}
           RETURN n.name AS name,
                  n.file AS file,
                  n.service AS service,
                  n.language AS language,
                  n.startLine AS startLine,
                  n.endLine AS endLine,
                  n.params AS params,
                  n.returnType AS returnType,
                  labels(n)[0] AS type
           LIMIT 5`,
          { name, service: svcParam },
        );

        if (symbols.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Symbol "${name}" not found in Knowledge Base.${service ? ` (service: ${service})` : ""}`,
                  suggestion: "Try search_knowledge_base for a fuzzy match.",
                }),
              },
            ],
          };
        }

        // Use first match for scoped queries
        const primary = symbols[0];

        // 2. Callers (who calls this symbol?) — fan-in
        const callers = await graph.query(
          `MATCH (caller)-[r:CALLS]->(target)
           WHERE target.name = $name ${svcFilter ? "AND target.service = $service" : ""}
           RETURN DISTINCT
             caller.name AS name,
             caller.file AS file,
             caller.service AS service,
             labels(caller)[0] AS type,
             coalesce(r.confidence, 1.0) AS confidence,
             coalesce(r.reason, '') AS reason
           ORDER BY confidence DESC
           LIMIT 15`,
          { name, service: svcParam },
        );

        // 3. Callees (what does this symbol call?) — fan-out
        const callees = await graph.query(
          `MATCH (source)-[r:CALLS]->(callee)
           WHERE source.name = $name ${svcFilter ? "AND source.service = $service" : ""}
           RETURN DISTINCT
             callee.name AS name,
             callee.file AS file,
             callee.service AS service,
             labels(callee)[0] AS type,
             coalesce(r.confidence, 1.0) AS confidence,
             coalesce(r.reason, '') AS reason
           ORDER BY confidence DESC
           LIMIT 15`,
          { name, service: svcParam },
        );

        // 4. Community membership
        const communities = await graph.query(
          `MATCH (n)-[:MEMBER_OF]->(c:Community)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN c.name AS communityName,
                  c.memberCount AS memberCount,
                  c.service AS service
           LIMIT 3`,
          { name, service: svcParam },
        );

        // 5. Process / execution flow membership
        const processes = await graph.query(
          `MATCH (n)-[r:STEP_IN_PROCESS]->(p:Process)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN p.name AS processName,
                  p.entryPoint AS entryPoint,
                  p.stepCount AS stepCount,
                  r.step AS stepPosition
           ORDER BY p.stepCount DESC
           LIMIT 5`,
          { name, service: svcParam },
        );

        // 6. Heritage (extends / implements) — for classes
        const extendsParents = await graph.query(
          `MATCH (n)-[r:EXTENDS]->(parent)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN parent.name AS name,
                  parent.file AS file,
                  coalesce(r.confidence, 1.0) AS confidence`,
          { name, service: svcParam },
        );

        const implementsInterfaces = await graph.query(
          `MATCH (n)-[r:IMPLEMENTS]->(iface)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN iface.name AS name,
                  iface.file AS file,
                  coalesce(r.confidence, 1.0) AS confidence`,
          { name, service: svcParam },
        );

        const children = await graph.query(
          `MATCH (child)-[:EXTENDS]->(n)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN child.name AS name,
                  child.file AS file
           LIMIT 10`,
          { name, service: svcParam },
        );

        // 7. Infrastructure patterns
        const infra = await graph.query(
          `MATCH (n)-[r:USES]->(i)
           WHERE n.name = $name ${svcFilter ? "AND n.service = $service" : ""}
           RETURN i.kind AS kind, i.target AS target
           LIMIT 10`,
          { name, service: svcParam },
        );

        // 8. Staleness check (uses raw memgraph via index tool shim)
        const staleness = await checkAllStaleness(core.graph);

        const result: Record<string, unknown> = {
          symbol: {
            name: primary.name,
            type: primary.type,
            file: primary.file,
            service: primary.service,
            language: primary.language,
            location:
              primary.startLine != null
                ? { startLine: primary.startLine, endLine: primary.endLine }
                : undefined,
            params: primary.params ?? undefined,
            returnType: primary.returnType ?? undefined,
          },
          callers: {
            count: callers.length,
            items: callers.map((c) => ({
              name: c.name,
              file: c.file,
              service: c.service,
              type: c.type,
              confidence: c.confidence,
              ...(c.reason ? { reason: c.reason } : {}),
            })),
          },
          callees: {
            count: callees.length,
            items: callees.map((c) => ({
              name: c.name,
              file: c.file,
              service: c.service,
              type: c.type,
              confidence: c.confidence,
              ...(c.reason ? { reason: c.reason } : {}),
            })),
          },
          community:
            communities.length > 0
              ? communities.map((c) => ({
                  name: c.communityName,
                  memberCount: c.memberCount,
                  service: c.service,
                }))
              : [],
          processes:
            processes.length > 0
              ? processes.map((p) => ({
                  name: p.processName,
                  entryPoint: p.entryPoint,
                  stepCount: p.stepCount,
                  stepPosition: p.stepPosition,
                }))
              : [],
          heritage: {
            extends: extendsParents.map((e) => ({
              name: e.name,
              file: e.file,
              confidence: e.confidence,
            })),
            implements: implementsInterfaces.map((i) => ({
              name: i.name,
              file: i.file,
              confidence: i.confidence,
            })),
            children: children.map((c) => ({
              name: c.name,
              file: c.file,
            })),
          },
          infrastructure: infra.map((i) => ({
            kind: i.kind,
            target: i.target,
          })),
        };

        // Add multi-match warning if name is ambiguous
        if (symbols.length > 1) {
          result.ambiguousMatches = symbols.map((s) => ({
            name: s.name,
            type: s.type,
            file: s.file,
            service: s.service,
          }));
        }

        if (staleness.length > 0) {
          result.stalenessWarnings = staleness;
        }

        // Cap output to ~8000 tokens to prevent context overflow
        const MAX_OUTPUT_CHARS = 8000 * 4;
        const raw = JSON.stringify(result, null, 2);
        const text =
          raw.length > MAX_OUTPUT_CHARS
            ? raw.slice(0, MAX_OUTPUT_CHARS) +
              "\n... [truncated — use nexus_get_code_snippet for file content]"
            : raw;

        return {
          content: [
            {
              type: "text" as const,
              text,
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
    });
}
