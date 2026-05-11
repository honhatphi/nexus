// ─────────────────────────────────────────────────────────────
// Adapter: MemgraphGraphStore — wraps any object with query/write
// methods (MemgraphClient) to implement the GraphStore port.
// ─────────────────────────────────────────────────────────────

import type { GraphStore } from "../ports/graph-store.js";

interface RawGraphClient {
  query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
  write(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

export class MemgraphGraphStore implements GraphStore {
  constructor(private readonly client: RawGraphClient) {}

  query(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    return this.client.query(cypher, params);
  }

  write(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    return this.client.write(cypher, params);
  }
}
