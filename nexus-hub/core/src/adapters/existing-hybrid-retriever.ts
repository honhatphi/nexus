// ─────────────────────────────────────────────────────────────
// Adapter: ExistingHybridRetriever — implements Retriever port
// using Reciprocal Rank Fusion (RRF) over GraphStore (keyword)
// and VectorStore (semantic). Mirrors logic from mcp-server
// clients/search.ts so both paths stay consistent.
// ─────────────────────────────────────────────────────────────

import type { GraphStore } from "../ports/graph-store.js";
import type { VectorStore } from "../ports/vector-store.js";
import type {
  Retriever,
  SearchInput,
  SearchResult,
} from "../ports/retriever.js";

const RRF_K = 60;

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

export class ExistingHybridRetriever implements Retriever {
  constructor(
    private readonly graph: GraphStore,
    private readonly vector: VectorStore,
  ) {}

  async search(input: SearchInput): Promise<SearchResult[]> {
    const { query, topK = 5, mode = "hybrid" } = input;

    const semanticResults: SearchResult[] = [];
    const keywordResults: SearchResult[] = [];

    if (mode === "hybrid" || mode === "semantic") {
      const vectorResults = await this.vector.search(query, topK);
      for (const r of vectorResults) {
        semanticResults.push({
          id: r.id,
          document: r.document,
          metadata: r.metadata,
          score: 0,
          source: "semantic",
        });
      }
    }

    if (mode === "hybrid" || mode === "keyword") {
      const kwResults = await this.keywordSearch(query, topK);
      keywordResults.push(...kwResults);
    }

    if (mode === "semantic") return semanticResults;
    if (mode === "keyword") return keywordResults;

    return this.mergeRRF(semanticResults, keywordResults, topK);
  }

  private async keywordSearch(
    query: string,
    topK: number,
  ): Promise<SearchResult[]> {
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
      LIMIT $topK
    `;
    const rows = await this.graph.query(cypher, {
      pattern: escapedQuery,
      topK,
    });

    return rows.map((row) => {
      const id = `${row.service}::${row.file}::${row.name}`;
      const document = [
        `[${row.label}] ${row.name}`,
        `File: ${row.file}`,
        row.docstring ? `Doc: ${row.docstring}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        id,
        document,
        metadata: row,
        score: 0,
        source: "keyword" as const,
      };
    });
  }

  private mergeRRF(
    semantic: SearchResult[],
    keyword: SearchResult[],
    topK: number,
  ): SearchResult[] {
    const scores = new Map<string, { item: SearchResult; score: number }>();

    semantic.forEach((item, idx) => {
      const s = rrfScore(idx + 1);
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += s;
      entry.item = { ...item, source: "both" };
      scores.set(item.id, entry);
    });

    keyword.forEach((item, idx) => {
      const s = rrfScore(idx + 1);
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += s;
      entry.item = {
        ...item,
        source: scores.has(item.id) ? "both" : "keyword",
      };
      scores.set(item.id, entry);
    });

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ item, score }) => ({ ...item, score }));
  }
}
