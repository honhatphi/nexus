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
    const options: Record<string, unknown> = { path: config.url };
    if (config.token) {
      options.auth = {
        provider: "token",
        credentials: config.token,
      };
    }
    this.client = new ChromaClient(options as ConstructorParameters<typeof ChromaClient>[0]);
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
    metadatas: Metadata[]
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
}
