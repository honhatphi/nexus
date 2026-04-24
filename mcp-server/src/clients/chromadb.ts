import { ChromaClient, type Collection, type Metadata } from "chromadb";
import type { Config } from "../config.js";

export interface VectorSearchResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export class ChromaDBClient {
  private client: ChromaClient;
  private collectionName: string;
  private collection: Collection | null = null;

  constructor(config: Config["chromadb"]) {
    // Use `path` constructor (chromadb 3.x) — `ssl/host/port` is deprecated
    // and routes to a different base URL causing 404s with server 1.4.x
    this.client = new ChromaClient({
      path: config.url,
      ...(config.token
        ? { auth: { provider: "token", credentials: config.token } }
        : {}),
    } as ConstructorParameters<typeof ChromaClient>[0]);
    this.collectionName = config.collection;
  }

  private async getCollection(): Promise<Collection> {
    if (!this.collection) {
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
      });
    }
    return this.collection;
  }

  /** Semantic search: find code chunks similar to the query text. */
  async search(text: string, topK = 5): Promise<VectorSearchResult[]> {
    const collection = await this.getCollection();
    const results = await collection.query({
      queryTexts: [text],
      nResults: topK,
    });

    const items: VectorSearchResult[] = [];
    const ids = results.ids?.[0] ?? [];
    const docs = results.documents?.[0] ?? [];
    const metas = results.metadatas?.[0] ?? [];
    const distances = results.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      items.push({
        id: ids[i],
        document: docs[i] ?? "",
        metadata: (metas[i] as Record<string, unknown>) ?? {},
        distance: distances[i] ?? 0,
      });
    }
    return items;
  }

  /** Upsert documents into the collection. */
  async upsert(
    ids: string[],
    documents: string[],
    metadatas: Metadata[],
  ): Promise<void> {
    const collection = await this.getCollection();
    await collection.upsert({ ids, documents, metadatas });
  }

  /** Delete documents by IDs. */
  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = await this.getCollection();
    await collection.delete({ ids });
  }

  /**
   * Fetch metadata for a list of document IDs.
   * Returns only the IDs that exist in the collection.
   */
  async getByIds(
    ids: string[],
  ): Promise<Array<{ id: string; metadata: Record<string, unknown> }>> {
    if (ids.length === 0) return [];
    const collection = await this.getCollection();
    const result = await collection.get({
      ids,
      include: ["metadatas"] as any,
    });
    return (result.ids ?? []).map((id, i) => ({
      id,
      metadata: (result.metadatas?.[i] as Record<string, unknown> | null) ?? {},
    }));
  }

  /**
   * Increment hit_count for a list of ChromaDB document IDs and record
   * last_queried timestamp. Designed for fire-and-forget — swallows errors.
   *
   * This feeds the Learning Layer: frequently-queried chunks surface higher
   * in reranked search results (see applyHitCountBoost in search.ts).
   */
  async incrementHitCount(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const collection = await this.getCollection();
      const existing = await collection.get({
        ids,
        include: ["metadatas"] as any,
      });
      if (!existing.ids?.length) return;

      const nowIso = new Date().toISOString();
      const updatedMetadatas = (existing.metadatas ?? []).map((meta) => ({
        ...((meta as Record<string, unknown>) ?? {}),
        hit_count:
          (((meta as Record<string, unknown>)?.hit_count as number) ?? 0) + 1,
        last_queried: nowIso,
      }));

      await collection.update({
        ids: existing.ids,
        metadatas: updatedMetadatas,
      });
    } catch {
      // Non-critical — swallow errors silently
    }
  }

  /**
   * Bootstrap: ensure the collection exists, then verify it's reachable.
   * Safe to call multiple times — idempotent.
   * Throws if ChromaDB is unreachable or collection cannot be created.
   */
  async bootstrap(): Promise<void> {
    // getOrCreateCollection already creates if absent; just force the call
    this.collection = null; // reset so getCollection re-runs
    const col = await this.getCollection();
    // Verify by counting — throws if server is unresponsive
    await col.count();
  }

  /**
   * Health check: returns true if ChromaDB is reachable and collection is ready.
   * Never throws — returns false on any error.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.bootstrap();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
