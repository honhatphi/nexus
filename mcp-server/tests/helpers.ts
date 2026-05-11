// ─────────────────────────────────────────────────────────────
// Shared mock clients for MCP server tool tests.
// No Docker or real DB connections required.
// ─────────────────────────────────────────────────────────────

import type { MemgraphClient } from "../src/clients/memgraph.js";
import type {
  ChromaDBClient,
  VectorSearchResult,
} from "../src/clients/chromadb.js";

type QueryResponse = Record<string, unknown>[];

/**
 * Create a mock MemgraphClient that returns canned responses
 * based on Cypher pattern matching.
 */
export function createMockMemgraph(
  responses: Map<string | RegExp, QueryResponse> = new Map(),
): MemgraphClient & {
  calls: { method: string; cypher: string; params?: Record<string, unknown> }[];
} {
  const calls: {
    method: string;
    cypher: string;
    params?: Record<string, unknown>;
  }[] = [];

  function findResponse(cypher: string): QueryResponse {
    for (const [key, value] of responses) {
      if (typeof key === "string" && cypher.includes(key)) return value;
      if (key instanceof RegExp && key.test(cypher)) return value;
    }
    return [];
  }

  return {
    calls,
    async query(cypher: string, params?: Record<string, unknown>) {
      calls.push({ method: "query", cypher, params });
      return findResponse(cypher);
    },
    async write(cypher: string, params?: Record<string, unknown>) {
      calls.push({ method: "write", cypher, params });
      return findResponse(cypher);
    },
    async getImpact(name: string, maxDepth?: number, minConfidence?: number) {
      calls.push({
        method: "query",
        cypher: "getImpact",
        params: { name, maxDepth, minConfidence },
      });
      return findResponse("getImpact");
    },
    async close() {},
  } as unknown as MemgraphClient & { calls: typeof calls };
}

/**
 * Create a mock ChromaDBClient that returns canned vector search results.
 */
export function createMockChromaDB(
  searchResults: VectorSearchResult[] = [],
): ChromaDBClient & { upserted: { ids: string[]; documents: string[] }[] } {
  const upserted: { ids: string[]; documents: string[] }[] = [];

  return {
    upserted,
    async search(_text: string, _topK?: number) {
      return searchResults;
    },
    async upsert(ids: string[], documents: string[], _metadatas: unknown[]) {
      upserted.push({ ids, documents });
    },
    async deleteByIds(_ids: string[]) {},
    async incrementHitCount(_ids: string[]) {},
    async getByIds(_ids: string[]) {
      return [];
    },
  } as unknown as ChromaDBClient & { upserted: typeof upserted };
}
