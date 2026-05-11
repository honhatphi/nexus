// ─────────────────────────────────────────────────────────────
// File hash store — persistent incremental index (PR 9)
// ─────────────────────────────────────────────────────────────

/** Per-file index entry stored on disk. */
export interface FileIndexEntry {
  contentHash: string;
  lastIndexedCommit?: string;
  lastIndexedAt: string;
}

/** Minimal interface for hash-based change detection. */
export interface FileHashStore {
  get(absolutePath: string): Promise<FileIndexEntry | null>;
  set(absolutePath: string, entry: FileIndexEntry): Promise<void>;
  flush(): Promise<void>;
}

/** In-memory implementation — used for testing and as fallback. */
export class InMemoryFileHashStore implements FileHashStore {
  private readonly cache = new Map<string, FileIndexEntry>();

  async get(absolutePath: string): Promise<FileIndexEntry | null> {
    return this.cache.get(absolutePath) ?? null;
  }

  async set(absolutePath: string, entry: FileIndexEntry): Promise<void> {
    this.cache.set(absolutePath, entry);
  }

  async flush(): Promise<void> {
    // no-op
  }
}
