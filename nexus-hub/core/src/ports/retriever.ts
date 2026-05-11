// ─────────────────────────────────────────────────────────────
// Port: Retriever — hybrid semantic + keyword search abstraction.
// ─────────────────────────────────────────────────────────────

export type SearchMode = "hybrid" | "semantic" | "keyword";

export interface SearchResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
  source: "semantic" | "keyword" | "both";
}

export interface SearchInput {
  query: string;
  topK?: number;
  mode?: SearchMode;
  service?: string;
}

export interface Retriever {
  search(input: SearchInput): Promise<SearchResult[]>;
}
