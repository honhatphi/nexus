// ─────────────────────────────────────────────────────────────
// Port: GraphStore — abstraction over the graph database
// (Memgraph in production, in-memory stub for tests).
// ─────────────────────────────────────────────────────────────

export interface GraphStore {
  query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;

  write(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}
