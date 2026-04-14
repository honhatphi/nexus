// ─────────────────────────────────────────────────────────────
// Hybrid Search — BM25 (graph text index) + Semantic (vector)
// with Reciprocal Rank Fusion (RRF) for result merging.
// ─────────────────────────────────────────────────────────────

import type { MemgraphClient } from "./memgraph.js";
import type { ChromaDBClient, VectorSearchResult } from "./chromadb.js";

export type SearchMode = "hybrid" | "semantic" | "keyword";

export interface HybridSearchResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
  source: "semantic" | "keyword" | "both";
}

/**
 * RRF constant. Higher K gives more weight to lower-ranked results.
 * K=60 is the standard value from the original RRF paper.
 */
const RRF_K = 60;

/**
 * Compute Reciprocal Rank Fusion score for a single result.
 * score = 1 / (K + rank), where rank is 1-based.
 */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Keyword search via Memgraph — uses Cypher text matching
 * on Function and Class nodes' name, file, and docstring.
 */
async function keywordSearch(
  memgraph: MemgraphClient,
  query: string,
  topK: number,
): Promise<
  Array<{ id: string; document: string; metadata: Record<string, unknown> }>
> {
  // Escape special regex characters in the query
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cypher = `
    MATCH (n)
    WHERE (n:Function OR n:Class OR n:File)
      AND (
        toLower(n.name) CONTAINS toLower($pattern)
        OR toLower(n.file) CONTAINS toLower($pattern)
        OR toLower(coalesce(n.docstring, '')) CONTAINS toLower($pattern)
      )
    RETURN
      coalesce(n.name, '') AS name,
      coalesce(n.file, '') AS file,
      coalesce(n.docstring, '') AS docstring,
      coalesce(n.service, '') AS service,
      labels(n)[0] AS label
    LIMIT ${Math.trunc(topK)}
  `;

  const rows = await memgraph.query(cypher, {
    pattern: escapedQuery,
  });

  return rows.map((row) => ({
    id: `${row.label}:${row.file}:${row.name}`,
    document: [
      `[${row.label}] ${row.name}`,
      row.file ? `File: ${row.file}` : "",
      row.docstring ? `Doc: ${String(row.docstring).slice(0, 200)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      name: row.name as string,
      file: row.file as string,
      service: row.service as string,
      type: row.label as string,
    },
  }));
}

/**
 * Merge semantic and keyword results using Reciprocal Rank Fusion.
 */
function fuseResults(
  semanticResults: VectorSearchResult[],
  keywordResults: Array<{
    id: string;
    document: string;
    metadata: Record<string, unknown>;
  }>,
  topK: number,
): HybridSearchResult[] {
  const scoreMap = new Map<
    string,
    {
      document: string;
      metadata: Record<string, unknown>;
      score: number;
      source: Set<string>;
    }
  >();

  // Add semantic results with RRF scores
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const key = r.id;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore(i + 1);
      existing.source.add("semantic");
    } else {
      scoreMap.set(key, {
        document: r.document,
        metadata: r.metadata,
        score: rrfScore(i + 1),
        source: new Set(["semantic"]),
      });
    }
  }

  // Add keyword results with RRF scores
  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const key = r.id;
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore(i + 1);
      existing.source.add("keyword");
    } else {
      scoreMap.set(key, {
        document: r.document,
        metadata: r.metadata,
        score: rrfScore(i + 1),
        source: new Set(["keyword"]),
      });
    }
  }

  // Sort by fused score (descending)
  const sorted = Array.from(scoreMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK);

  return sorted.map(([id, data]) => ({
    id,
    document: data.document,
    metadata: data.metadata,
    score: data.score,
    source:
      data.source.size === 2
        ? ("both" as const)
        : data.source.has("semantic")
          ? ("semantic" as const)
          : ("keyword" as const),
  }));
}

/**
 * Execute a hybrid search combining semantic (ChromaDB) and keyword
 * (Memgraph text) search results using Reciprocal Rank Fusion.
 */
export async function hybridSearch(
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
  query: string,
  topK: number,
  mode: SearchMode = "hybrid",
): Promise<HybridSearchResult[]> {
  if (mode === "semantic") {
    const results = await chromadb.search(query, topK);
    return results.map((r, i) => ({
      id: r.id,
      document: r.document,
      metadata: r.metadata,
      score: 1 - r.distance, // convert distance to similarity
      source: "semantic" as const,
    }));
  }

  if (mode === "keyword") {
    const results = await keywordSearch(memgraph, query, topK);
    return results.map((r, i) => ({
      ...r,
      score: rrfScore(i + 1),
      source: "keyword" as const,
    }));
  }

  // Hybrid mode: run both in parallel, then fuse
  const [semanticResults, keywordResultsList] = await Promise.all([
    chromadb.search(query, topK),
    keywordSearch(memgraph, query, topK),
  ]);

  return fuseResults(semanticResults, keywordResultsList, topK);
}
