// ─────────────────────────────────────────────────────────────
// RepoDetector (PR 3)
// Detects current repo root + repoId from Git metadata.
// ─────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

export interface DetectedRepo {
  repoRoot: string;
  repoId: string;
  /** Branch name or null if detached HEAD */
  branch: string | null;
  /** HEAD commit hash or null */
  commit: string | null;
}

function runGit(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString().trim();
}

export class RepoDetector {
  /**
   * Detect the repo root and derive a repoId from `startDir`.
   * Falls back gracefully if git is not available.
   */
  static async detect(startDir: string): Promise<DetectedRepo | null> {
    try {
      const repoRoot = runGit("rev-parse --show-toplevel", startDir);

      // Derive repoId: prefer package.json name → git remote base name → dir basename
      let repoId = path.basename(repoRoot);
      try {
        const pkgPath = path.join(repoRoot, "package.json");
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name) {
          repoId = pkg.name.replace(/^@[^/]+\//, ""); // strip scope prefix
        }
      } catch {
        // no package.json — try git remote
        try {
          const remoteUrl = runGit("remote get-url origin", repoRoot);
          const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/);
          if (match) repoId = match[1];
        } catch {
          // fallback: basename already set
        }
      }

      let branch: string | null = null;
      try {
        branch = runGit("rev-parse --abbrev-ref HEAD", repoRoot);
        if (branch === "HEAD") branch = null; // detached
      } catch {
        // ignore
      }

      let commit: string | null = null;
      try {
        commit = runGit("rev-parse --short HEAD", repoRoot);
      } catch {
        // ignore
      }

      return { repoRoot, repoId, branch, commit };
    } catch {
      return null;
    }
  }
}
