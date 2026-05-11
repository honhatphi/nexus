// ─────────────────────────────────────────────────────────────
// JsonFileHashStore — persists file hashes to disk under
// ~/.nexus/workspaces/<workspaceId>/index-state/<repoId>.files.json
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import type { FileHashStore, FileIndexEntry } from "./file-hash-store.js";
import { nexusWorkspaceDir } from "../env.js";

interface IndexStateFile {
  workspaceId: string;
  repoId: string;
  updatedAt: string;
  files: Record<string, FileIndexEntry>;
}

export class JsonFileHashStore implements FileHashStore {
  private readonly filePath: string;
  private data: IndexStateFile;
  private dirty = false;

  constructor(workspaceId: string, repoId: string) {
    const dir = path.join(nexusWorkspaceDir(workspaceId), "index-state");
    this.filePath = path.join(dir, `${repoId}.files.json`);
    this.data = {
      workspaceId,
      repoId,
      updatedAt: new Date().toISOString(),
      files: {},
    };
  }

  /** Load existing index state from disk. Call once before using. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as IndexStateFile;
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  async get(absolutePath: string): Promise<FileIndexEntry | null> {
    return this.data.files[absolutePath] ?? null;
  }

  async set(absolutePath: string, entry: FileIndexEntry): Promise<void> {
    this.data.files[absolutePath] = entry;
    this.dirty = true;
  }

  /** Flush all pending writes to disk atomically. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.data.updatedAt = new Date().toISOString();
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }
}
