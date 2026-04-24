// ─────────────────────────────────────────────────────────────
// augment — MCP tool for PreToolUse enrichment.
// Given a search pattern (function name, keyword, regex), returns
// compact graph context: matching symbols with their callers,
// callees, and process membership. Designed to run fast (~500ms)
// so agents can enrich every search with graph intelligence.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemgraphClient } from "../clients/memgraph.js";
import { promoteCandidate, rejectCandidate } from "@nexus-hub/common-tools";

/**
 * Compact context shape returned by augment — optimized for
 * minimal token usage in agent conversations.
 */
interface AugmentedSymbol {
  name: string;
  type: string;
  file: string;
  service: string;
  callers: string[];
  callees: string[];
  processes: string[];
  community: string | null;
}

export function registerAugmentTool(
  server: McpServer,
  memgraph: MemgraphClient,
): void {
  server.tool(
    "augment",
    "Enrich a search pattern with graph context. Given a function/class name or keyword, returns matching symbols with their callers, callees, process flows, and community — in a compact format optimized for agent context enrichment. Designed to be fast (~500ms). Use as a lightweight alternative to get_symbol_context when you need quick info for multiple matches.",
    {
      pattern: z
        .string()
        .min(2)
        .describe(
          "Search pattern — function name, class name, or keyword (min 2 chars). Matched against symbol names via case-insensitive contains.",
        ),
      service: z
        .string()
        .optional()
        .describe("Optional service name to scope the search."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe(
          "Maximum number of matching symbols to enrich (1–10, default 5).",
        ),
      action: z
        .enum([
          "search",
          "promoteCandidate",
          "rejectCandidate",
          "listCandidates",
        ])
        .default("search")
        .describe(
          "'search' (default): symbol enrichment. " +
            "'promoteCandidate': approve a CandidatePattern (requires candidateId + approvedAs). " +
            "'rejectCandidate': reject a CandidatePattern (requires candidateId + reason). " +
            "'listCandidates': list all pending CandidatePatterns for a service.",
        ),
      candidateId: z
        .string()
        .optional()
        .describe("CandidatePattern id for promote/reject actions."),
      approvedAs: z
        .string()
        .optional()
        .describe("InfraKind to promote the candidate to."),
      reason: z
        .string()
        .optional()
        .describe("Rejection reason for rejectCandidate action."),
    },
    async ({
      pattern,
      service,
      limit,
      action,
      candidateId,
      approvedAs,
      reason,
    }) => {
      try {
        // D3: Candidate management actions
        if (action === "promoteCandidate") {
          if (!candidateId || !approvedAs) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error:
                      "candidateId and approvedAs are required for promoteCandidate",
                  }),
                },
              ],
              isError: true,
            };
          }
          const graphClient = {
            write: (c: string, p?: Record<string, unknown>) =>
              memgraph.write(c, p ?? {}),
            query: (c: string, p?: Record<string, unknown>) =>
              memgraph.query(c, p ?? {}),
          };
          const result = await promoteCandidate(
            graphClient,
            candidateId,
            approvedAs,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  action: "promoteCandidate",
                  candidateId,
                  approvedAs,
                  ...result,
                }),
              },
            ],
          };
        }

        if (action === "rejectCandidate") {
          if (!candidateId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "candidateId is required for rejectCandidate",
                  }),
                },
              ],
              isError: true,
            };
          }
          const graphClient = {
            write: (c: string, p?: Record<string, unknown>) =>
              memgraph.write(c, p ?? {}),
            query: (c: string, p?: Record<string, unknown>) =>
              memgraph.query(c, p ?? {}),
          };
          const result = await rejectCandidate(
            graphClient,
            candidateId,
            reason ?? "",
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  action: "rejectCandidate",
                  candidateId,
                  ...result,
                }),
              },
            ],
          };
        }

        if (action === "listCandidates") {
          const rows = await memgraph.query(
            `MATCH (cp:CandidatePattern)
             WHERE $service = '' OR cp.service = $service
             RETURN cp.id AS id, cp.service AS service, cp.file AS file,
                    cp.pattern AS pattern, cp.status AS status,
                    cp.confidence AS confidence, cp.detectedAt AS detectedAt
             ORDER BY cp.detectedAt DESC
             LIMIT 50`,
            { service: service ?? "" },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  action: "listCandidates",
                  count: rows.length,
                  candidates: rows,
                }),
              },
            ],
          };
        }

        // Default: symbol enrichment search
        // Escape special regex characters
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const svcFilter = service ? "AND n.service = $service" : "";

        // 1. Find matching symbols — case-insensitive contains via toLower
        const matches = await memgraph.query(
          `MATCH (n)
           WHERE (n:Function OR n:Class OR n:Method)
             AND toLower(n.name) CONTAINS toLower($pattern)
             ${svcFilter}
           RETURN n.name AS name,
                  n.file AS file,
                  n.service AS service,
                  labels(n)[0] AS type
           LIMIT ${Math.trunc(limit)}`,
          {
            pattern: escaped,
            service: service ?? "",
          },
        );

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  pattern,
                  matches: 0,
                  symbols: [],
                }),
              },
            ],
          };
        }

        // 2. For each match, get compact context in batch
        const names = matches.map((m) => m.name as string);

        // Callers (who calls any matched symbol?)
        const callerRows = await memgraph.query(
          `MATCH (caller)-[:CALLS]->(target)
           WHERE target.name IN $names
             ${service ? "AND target.service = $service" : ""}
           RETURN target.name AS target,
                  collect(DISTINCT caller.name)[..3] AS callers`,
          { names, service: service ?? "" },
        );

        // Callees (what do matched symbols call?)
        const calleeRows = await memgraph.query(
          `MATCH (source)-[:CALLS]->(callee)
           WHERE source.name IN $names
             ${service ? "AND source.service = $service" : ""}
           RETURN source.name AS source,
                  collect(DISTINCT callee.name)[..3] AS callees`,
          { names, service: service ?? "" },
        );

        // Process membership
        const processRows = await memgraph.query(
          `MATCH (n)-[:STEP_IN_PROCESS]->(p:Process)
           WHERE n.name IN $names
             ${service ? "AND n.service = $service" : ""}
           RETURN n.name AS symbol,
                  collect(DISTINCT p.name)[..2] AS processes`,
          { names, service: service ?? "" },
        );

        // Community membership
        const communityRows = await memgraph.query(
          `MATCH (n)-[:MEMBER_OF]->(c:Community)
           WHERE n.name IN $names
             ${service ? "AND n.service = $service" : ""}
           RETURN n.name AS symbol,
                  c.name AS community`,
          { names, service: service ?? "" },
        );

        // Build lookup maps
        const callerMap = new Map<string, string[]>();
        for (const row of callerRows) {
          callerMap.set(row.target as string, row.callers as string[]);
        }

        const calleeMap = new Map<string, string[]>();
        for (const row of calleeRows) {
          calleeMap.set(row.source as string, row.callees as string[]);
        }

        const processMap = new Map<string, string[]>();
        for (const row of processRows) {
          processMap.set(row.symbol as string, row.processes as string[]);
        }

        const communityMap = new Map<string, string>();
        for (const row of communityRows) {
          communityMap.set(row.symbol as string, row.community as string);
        }

        // 3. Assemble compact results
        const symbols: AugmentedSymbol[] = matches.map((m) => {
          const n = m.name as string;
          return {
            name: n,
            type: m.type as string,
            file: m.file as string,
            service: m.service as string,
            callers: callerMap.get(n) ?? [],
            callees: calleeMap.get(n) ?? [],
            processes: processMap.get(n) ?? [],
            community: communityMap.get(n) ?? null,
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                pattern,
                matches: symbols.length,
                symbols,
              }),
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
