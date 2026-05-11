// ─────────────────────────────────────────────────────────────
// PatchGenerator (PR 12)
// Generates a unified diff between the task workspace
// selected-files and the originals in the real repo.
// Uses git diff when available; falls back to line-by-line
// text comparison.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import type { TaskWorkspaceInfo } from "./task-workspace-manager.js";

export interface FilePatch {
  relativePath: string;
  patch: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface GeneratedPatch {
  taskId: string;
  patches: FilePatch[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  unifiedDiff: string;
}

function countDiffLines(patch: string): { added: number; removed: number } {
  const lines = patch.split("\n");
  return {
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .length,
    removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---"))
      .length,
  };
}

/** Simple unified diff via git diff --no-index. */
function gitDiff(
  originalPath: string,
  modifiedPath: string,
  relPath: string,
): string | null {
  try {
    return execSync(
      `git diff --no-index --unified=3 "${originalPath}" "${modifiedPath}"`,
      { stdio: "pipe" },
    ).toString();
  } catch (err: unknown) {
    // git diff exits 1 when there are differences — that's fine
    const result = (err as { stdout?: Buffer }).stdout;
    if (result) {
      // Rewrite header to use relative paths
      return result
        .toString()
        .replace(/^--- .+$/m, `--- a/${relPath}`)
        .replace(/^\+\+\+ .+$/m, `+++ b/${relPath}`);
    }
    return null;
  }
}

export class PatchGenerator {
  static async generate(info: TaskWorkspaceInfo): Promise<GeneratedPatch> {
    const selectedDir = path.join(info.workspaceDir, "selected-files");
    const patches: FilePatch[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    const allParts: string[] = [];

    for (const relFile of info.selectedFiles) {
      const linkPath = path.join(selectedDir, relFile);
      const originalPath = path.isAbsolute(relFile)
        ? relFile
        : path.join(info.repoRoot, relFile);

      // Resolve the symlink to get the actual file path after edits
      let resolvedLink: string;
      try {
        resolvedLink = await fs.realpath(linkPath);
      } catch {
        continue;
      }

      // Read both versions to check if changed
      let original = "";
      let modified = "";
      try {
        original = await fs.readFile(originalPath, "utf8");
      } catch {
        // Original gone — treat as empty
      }
      try {
        modified = await fs.readFile(resolvedLink, "utf8");
      } catch {
        continue;
      }

      if (original === modified) continue;

      const patch = gitDiff(originalPath, resolvedLink, relFile) ?? "";
      if (!patch) continue;

      const { added, removed } = countDiffLines(patch);
      patches.push({
        relativePath: relFile,
        patch,
        linesAdded: added,
        linesRemoved: removed,
      });
      totalAdded += added;
      totalRemoved += removed;
      allParts.push(patch);
    }

    return {
      taskId: info.taskId,
      patches,
      totalLinesAdded: totalAdded,
      totalLinesRemoved: totalRemoved,
      unifiedDiff: allParts.join("\n"),
    };
  }
}
