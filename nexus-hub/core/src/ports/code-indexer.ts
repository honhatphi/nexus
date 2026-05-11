// ─────────────────────────────────────────────────────────────
// Port: CodeIndexer — abstraction over the parse+sync pipeline.
// ─────────────────────────────────────────────────────────────

export interface SyncInput {
  servicePath: string;
  serviceId: string;
  excludePatterns?: string[];
  forceUpdate?: boolean;
}

export interface SyncSummary {
  filesScanned: number;
  filesChanged: number;
  symbolsIndexed: number;
  vectorsUpserted: number;
  durationMs: number;
}

export interface CodeIndexer {
  sync(input: SyncInput): Promise<SyncSummary>;
}
