// ─────────────────────────────────────────────────────────────
// Phase 4 — Metadata (Git commit tracking + staleness)
// Records the current git HEAD commit hash on the Service node
// so subsequent queries can detect stale data.
// ─────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

// ── Git Helpers ──────────────────────────────────────────────

function getGitHead(servicePath: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: servicePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

// ── Staleness Types (exported for use in MCP tools) ──────────

export interface StalenessInfo {
  stale: boolean;
  lastSyncCommit: string;
  currentHead: string;
  commitsBehind: number;
  message: string;
}

export function getCommitCount(from: string, to: string, cwd: string): number {
  try {
    return parseInt(
      execSync(`git rev-list --count ${from}..${to}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
      10,
    );
  } catch {
    return -1;
  }
}

// ── Phase Definition ─────────────────────────────────────────

export const metadataPhase: PipelinePhase = {
  name: "metadata",
  order: 4,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const commitHash = getGitHead(ctx.servicePath);
    ctx.gitCommitHash = commitHash;

    if (commitHash) {
      await deps.graph.write(
        `MERGE (s:Service {name: $service})
         SET s.lastSyncCommit = $commitHash,
             s.lastSyncAt = timestamp(),
             s.lastSyncFileCount = $fileCount`,
        {
          service: ctx.serviceName,
          commitHash,
          fileCount: ctx.stats.filesScanned,
        },
      );
    } else {
      // No git — still record sync time
      await deps.graph.write(
        `MERGE (s:Service {name: $service})
         SET s.lastSyncAt = timestamp(),
             s.lastSyncFileCount = $fileCount`,
        {
          service: ctx.serviceName,
          fileCount: ctx.stats.filesScanned,
        },
      );
    }

    return {
      phase: "metadata",
      success: true,
      stats: {
        gitAvailable: commitHash ? 1 : 0,
      },
      errors: [],
      durationMs: 0,
    };
  },
};
