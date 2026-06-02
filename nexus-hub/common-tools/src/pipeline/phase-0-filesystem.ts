// ─────────────────────────────────────────────────────────────
// Phase 0 — Filesystem discovery + diff detection
// Scans service directory, collects source files, checks
// content hashes for staleness.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { EXTENSION_MAP } from "../types.js";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
  FileEntry,
} from "./types.js";

const SKIP_DIRS = new Set([
  // General
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  "coverage",
  // Python
  "__pycache__",
  ".venv",
  // Dart / Flutter
  ".dart_tool",
  ".pub-cache",
  // Android / Java
  ".gradle",
  ".cxx",
  ".externalNativeBuild",
  // iOS / macOS / Swift
  "Pods",
  "DerivedData",
  ".swiftpm",
  // Nexus tooling (avoid self-indexing)
  ".codegraph",
]);

const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

/** In-memory hash cache — fallback when no persistent hashStore is injected. */
const hashCache = new Map<string, string>();

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectSourceFiles(fullPath)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export const filesystemPhase: PipelinePhase = {
  name: "filesystem",
  order: 0,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    const filePaths = await collectSourceFiles(ctx.servicePath);
    const store = deps.hashStore;

    for (const absPath of filePaths) {
      try {
        const content = await fs.readFile(absPath, "utf-8");
        const relPath = path.relative(ctx.servicePath, absPath);
        const hash = contentHash(content);

        // Determine staleness: prefer persistent store, fall back to in-memory cache
        let oldHash: string | undefined;
        if (store) {
          const existing = await store.get(absPath);
          oldHash = existing?.contentHash;
        } else {
          oldHash = hashCache.get(absPath);
        }

        const changed = ctx.forceUpdate || oldHash !== hash;

        // Write back to whichever store is active
        if (store) {
          await store.set(absPath, {
            contentHash: hash,
            lastIndexedAt: new Date().toISOString(),
          });
        } else {
          hashCache.set(absPath, hash);
        }

        const entry: FileEntry = {
          absolutePath: absPath,
          relativePath: relPath,
          content,
          contentHash: hash,
          changed,
        };

        ctx.sourceFiles.push(entry);
        if (changed) {
          ctx.changedFiles.push(entry);
        } else {
          ctx.stats.filesSkipped++;
        }
      } catch (err) {
        const relPath = path.relative(ctx.servicePath, absPath);
        errors.push(
          `${relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Flush persistent store after scanning all files
    if (store) {
      await store.flush();
    }

    return {
      phase: "filesystem",
      success: true,
      stats: {
        totalFiles: ctx.sourceFiles.length,
        changedFiles: ctx.changedFiles.length,
        skippedFiles: ctx.stats.filesSkipped,
      },
      errors,
      durationMs: 0,
    };
  },
};
