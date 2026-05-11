// ─────────────────────────────────────────────────────────────
// FileArtifactStore — persists raw outputs to disk under
// ~/.nexus/workspaces/<workspaceId>/artifacts/<id>
// Keeps large outputs out of the prompt context.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRef, ArtifactKind } from "../contracts/artifact.js";
import type {
  ArtifactStore,
  StoreArtifactInput,
  ArtifactExcerpt,
} from "../ports/artifact-store.js";
import { nexusWorkspaceDir } from "../env.js";

const CHARS_PER_TOKEN = 4; // approximate

export class FileArtifactStore implements ArtifactStore {
  private readonly baseDir: string;

  constructor(workspaceId: string) {
    this.baseDir = path.join(nexusWorkspaceDir(workspaceId), "artifacts");
  }

  private artifactDir(id: string): string {
    return path.join(this.baseDir, id);
  }

  private async ensureDir(id: string): Promise<void> {
    await fs.mkdir(this.artifactDir(id), { recursive: true });
  }

  async store(input: StoreArtifactInput): Promise<ArtifactRef> {
    const id = `artifact_${input.kind}_${randomUUID().slice(0, 8)}`;
    await this.ensureDir(id);

    const contentPath = path.join(this.artifactDir(id), "content.txt");
    const metaPath = path.join(this.artifactDir(id), "meta.json");

    await fs.writeFile(contentPath, input.content, "utf-8");

    const sizeBytes = Buffer.byteLength(input.content, "utf-8");
    const estimatedTokens = Math.ceil(sizeBytes / CHARS_PER_TOKEN);

    const summary = this.buildSummary(input.kind, input.content);

    const ref: ArtifactRef = {
      id,
      kind: input.kind,
      summary,
      path: contentPath,
      sizeBytes,
      estimatedTokens,
    };

    await fs.writeFile(metaPath, JSON.stringify(ref, null, 2), "utf-8");
    return ref;
  }

  async getSummary(artifactId: string): Promise<ArtifactRef | null> {
    try {
      const metaPath = path.join(this.artifactDir(artifactId), "meta.json");
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as ArtifactRef;
    } catch {
      return null;
    }
  }

  async getExcerpt(
    artifactId: string,
    startLine = 1,
    endLine = 50,
  ): Promise<ArtifactExcerpt | null> {
    try {
      const contentPath = path.join(
        this.artifactDir(artifactId),
        "content.txt",
      );
      const raw = await fs.readFile(contentPath, "utf-8");
      const lines = raw.split("\n");
      const totalLines = lines.length;

      const start = Math.max(1, startLine);
      const end = Math.min(totalLines, endLine);
      const slice = lines.slice(start - 1, end).join("\n");

      return {
        artifactId,
        content: slice,
        startLine: start,
        endLine: end,
        totalLines,
      };
    } catch {
      return null;
    }
  }

  // ── Reducers — build compact summaries per artifact kind ────

  private buildSummary(kind: ArtifactKind, content: string): string {
    switch (kind) {
      case "test_log":
        return this.summarizeTestLog(content);
      case "diff":
        return this.summarizeDiff(content);
      case "terminal_output":
        return this.summarizeTerminalOutput(content);
      default: {
        const lines = content.split("\n");
        return `${lines.length} lines of ${kind}`;
      }
    }
  }

  private summarizeTestLog(content: string): string {
    const failurePattern = /FAIL|Error:|✗|✕|× /;
    const lines = content.split("\n");
    const failures = lines.filter((l) => failurePattern.test(l)).slice(0, 5);
    const total = lines.length;
    if (failures.length === 0)
      return `Test log: ${total} lines, no failures detected`;
    return `Test log: ${total} lines. Failures: ${failures.map((l) => l.trim()).join(" | ")}`;
  }

  private summarizeDiff(content: string): string {
    const added = (content.match(/^\+[^+]/gm) ?? []).length;
    const removed = (content.match(/^-[^-]/gm) ?? []).length;
    const files = (content.match(/^diff --git/gm) ?? []).length;
    return `Diff: ${files} file(s) changed, +${added} -${removed} lines`;
  }

  private summarizeTerminalOutput(content: string): string {
    const lines = content.split("\n");
    const errorLines = lines
      .filter((l) => /error|Error|ERROR|fail|FAIL/.test(l))
      .slice(0, 3);
    if (errorLines.length > 0) {
      return `Terminal output (${lines.length} lines). Errors: ${errorLines.map((l) => l.trim()).join(" | ")}`;
    }
    return `Terminal output: ${lines.length} lines`;
  }
}
