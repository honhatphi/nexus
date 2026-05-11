// ─────────────────────────────────────────────────────────────
// Adapter: ChromadbVectorStore — wraps any object with search/upsert
// methods (ChromaDBClient) to implement the VectorStore port.
// ─────────────────────────────────────────────────────────────

import type { VectorStore, VectorSearchResult } from "../ports/vector-store.js";

interface RawVectorClient {
  search(text: string, topK?: number): Promise<VectorSearchResult[]>;
  upsert(
    ids: string[],
    documents: string[],
    metadatas: Record<string, unknown>[],
  ): Promise<void>;
}

export class ChromadbVectorStore implements VectorStore {
  constructor(private readonly client: RawVectorClient) {}

  search(text: string, topK?: number): Promise<VectorSearchResult[]> {
    return this.client.search(text, topK);
  }

  upsert(
    ids: string[],
    documents: string[],
    metadatas: Record<string, unknown>[],
  ): Promise<void> {
    return this.client.upsert(ids, documents, metadatas);
  }
}
