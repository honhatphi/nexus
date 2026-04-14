import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { MemgraphClient } from "../clients/memgraph.js";
import { ChromaDBClient } from "../clients/chromadb.js";
import { hybridSearch, type SearchMode } from "../clients/search.js";

// ── Staleness Detection ──────────────────────────────────────

interface StalenessWarning {
  service: string;
  stale: boolean;
  lastSyncCommit: string;
  currentHead: string;
  commitsBehind: number;
  message: string;
}

export async function checkAllStaleness(
  memgraph: MemgraphClient,
): Promise<StalenessWarning[]> {
  const warnings: StalenessWarning[] = [];

  try {
    const services = await memgraph.query(
      `MATCH (s:Service) WHERE s.lastSyncCommit IS NOT NULL
       RETURN s.name AS name, s.lastSyncCommit AS commit`,
    );

    for (const svc of services) {
      const serviceName = svc.name as string;
      const lastCommit = svc.commit as string;

      // Try common service paths
      const paths = [
        `/workspace/services/${serviceName}`,
        `/workspace/${serviceName}`,
      ];

      for (const svcPath of paths) {
        try {
          const currentHead = execSync("git rev-parse HEAD", {
            cwd: svcPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();

          if (currentHead !== lastCommit) {
            let commitsBehind = 0;
            try {
              commitsBehind = parseInt(
                execSync(`git rev-list --count ${lastCommit}..${currentHead}`, {
                  cwd: svcPath,
                  encoding: "utf-8",
                  stdio: ["pipe", "pipe", "pipe"],
                }).trim(),
                10,
              );
            } catch {
              commitsBehind = -1;
            }

            warnings.push({
              service: serviceName,
              stale: true,
              lastSyncCommit: lastCommit.slice(0, 8),
              currentHead: currentHead.slice(0, 8),
              commitsBehind,
              message: `⚠️ ${serviceName} KB data is ${commitsBehind > 0 ? `${commitsBehind} commits` : "some commits"} behind HEAD. Consider re-syncing.`,
            });
          }
          break; // found the service path
        } catch {
          // path doesn't exist or no git, try next
        }
      }
    }
  } catch {
    // Staleness check failed silently — not critical
  }

  return warnings;
}

/**
 * Register all Nexus KB tools on the given MCP server instance.
 */
export function registerTools(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
): void {
  // ── 1. query_graph ─────────────────────────────────────────
  server.tool(
    "query_graph",
    "Execute a read-only Cypher query against the Memgraph knowledge graph to explore relationships between functions, modules, and files.",
    {
      cypher: z.string().describe("A Cypher READ query (MATCH … RETURN …)."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Optional parameter map for the Cypher query."),
    },
    async ({ cypher, params }) => {
      // Safety: block mutations
      const upper = cypher.toUpperCase();
      const mutationKeywords = [
        "CREATE",
        "MERGE",
        "DELETE",
        "DETACH",
        "SET",
        "REMOVE",
        "DROP",
      ];
      for (const kw of mutationKeywords) {
        if (upper.includes(kw)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Mutation keyword "${kw}" is not allowed. Only read queries are permitted.`,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const rows = await memgraph.query(cypher, params ?? {});
        const staleness = await checkAllStaleness(memgraph);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results: rows,
                  count: rows.length,
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

  // ── 2. search_knowledge_base ───────────────────────────────
  server.tool(
    "search_knowledge_base",
    "Search the Nexus Knowledge Base. Supports three modes: 'semantic' (ChromaDB vectors), 'keyword' (Memgraph text match), or 'hybrid' (both fused via Reciprocal Rank Fusion). Default is hybrid.",
    {
      query: z
        .string()
        .describe("Natural-language or code snippet to search for."),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of results to return (1–20, default 5)."),
      mode: z
        .enum(["hybrid", "semantic", "keyword"])
        .default("hybrid")
        .describe(
          "Search mode: 'hybrid' (BM25+semantic fused via RRF), 'semantic' (vector only), 'keyword' (graph text only). Default: hybrid.",
        ),
    },
    async ({ query, topK, mode }) => {
      try {
        const results = await hybridSearch(
          memgraph,
          chromadb,
          query,
          topK,
          mode as SearchMode,
        );
        const staleness = await checkAllStaleness(memgraph);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results,
                  count: results.length,
                  mode,
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

  // ── 3. get_impact_analysis ─────────────────────────────────
  server.tool(
    "get_impact_analysis",
    "Analyze the dependency graph for a given function or file. Returns all direct and transitive dependents so you can assess the blast radius before editing code. Supports confidence-based filtering.",
    {
      name: z.string().describe("Function name or file path to analyze."),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe(
          "Maximum traversal depth in the dependency graph (1–10, default 3).",
        ),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
          "Minimum relationship confidence threshold (0.0–1.0). Higher = fewer but more reliable results.",
        ),
    },
    async ({ name, maxDepth, min_confidence }) => {
      try {
        const deps = await memgraph.getImpact(name, maxDepth, min_confidence);
        const related = await chromadb.search(name, 3);
        const staleness = await checkAllStaleness(memgraph);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  target: name,
                  maxDepth,
                  minConfidence: min_confidence,
                  dependencies: deps,
                  dependencyCount: deps.length,
                  relatedCode: related,
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

  // ── 4. check_staleness ─────────────────────────────────────
  server.tool(
    "check_staleness",
    "Check if the Knowledge Base is up-to-date with the latest code changes. Compares the last sync commit against git HEAD for each service. Call this after committing, merging, or pulling code to see if a re-sync is needed.",
    {},
    async () => {
      try {
        const staleness = await checkAllStaleness(memgraph);

        if (staleness.length === 0) {
          // Check if any services exist at all
          const services = await memgraph.query(
            `MATCH (s:Service) RETURN s.name AS name, s.lastSyncAt AS lastSync`,
          );

          if (services.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "no_services",
                    message:
                      "No services indexed yet. Run sync_service_knowledge to get started.",
                  }),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "up_to_date",
                  message: "All service Knowledge Base data is current.",
                  services: services.map((s) => ({
                    name: s.name,
                    lastSync: s.lastSync,
                  })),
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "stale",
                  message: `${staleness.length} service(s) have stale KB data. Re-sync recommended.`,
                  staleServices: staleness,
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
