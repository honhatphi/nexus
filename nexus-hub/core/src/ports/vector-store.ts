// ─────────────────────────────────────────────────────────────
// Port: VectorStore — abstraction over the vector database
// (ChromaDB in production, in-memory stub for tests).
// ─────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export interface VectorStore {
  search(text: string, topK?: number): Promise<VectorSearchResult[]>;
  upsert(
    ids: string[],
    documents: string[],
    metadatas: Record<string, unknown>[],
  ): Promise<void>;
}
