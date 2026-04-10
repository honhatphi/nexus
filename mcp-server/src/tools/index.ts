import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemgraphClient } from "../clients/memgraph.js";
import { ChromaDBClient } from "../clients/chromadb.js";

/**
 * Register all Nexus KB tools on the given MCP server instance.
 */
export function registerTools(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient
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
      const mutationKeywords = ["CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP"];
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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results: rows, count: rows.length }, null, 2),
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
    }
  );

  // ── 2. search_knowledge_base ───────────────────────────────
  server.tool(
    "search_knowledge_base",
    "Semantic search over the Nexus Knowledge Base via ChromaDB. Returns the most similar code snippets, patterns, and architectural decisions to the given query.",
    {
      query: z.string().describe("Natural-language or code snippet to search for."),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of results to return (1–20, default 5)."),
    },
    async ({ query, topK }) => {
      try {
        const results = await chromadb.search(query, topK);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results, count: results.length }, null, 2),
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
    }
  );

  // ── 3. get_impact_analysis ─────────────────────────────────
  server.tool(
    "get_impact_analysis",
    "Analyze the dependency graph for a given function or file. Returns all direct and transitive dependents so you can assess the blast radius before editing code.",
    {
      name: z
        .string()
        .describe("Function name or file path to analyze."),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Maximum traversal depth in the dependency graph (1–10, default 3)."),
    },
    async ({ name, maxDepth }) => {
      try {
        const deps = await memgraph.getImpact(name, maxDepth);
        // Enrich with vector context — find code related to the target
        const related = await chromadb.search(name, 3);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  target: name,
                  maxDepth,
                  dependencies: deps,
                  dependencyCount: deps.length,
                  relatedCode: related,
                },
                null,
                2
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
    }
  );
}
