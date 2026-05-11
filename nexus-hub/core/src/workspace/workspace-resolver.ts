// ─────────────────────────────────────────────────────────────
// WorkspaceResolver (PR 3)
// Walks upward from a directory to find .nexus/workspace.yaml
// and reads/writes the manifest + local state files.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkspaceManifest,
  WorkspaceState,
  RepoEntry,
} from "./workspace-manifest.js";
import { nexusWorkspaceDir } from "../env.js";

const MANIFEST_REL = path.join(".nexus", "workspace.yaml");

// Minimal YAML serialiser (no external dep) — only handles our manifest shape.
function serializeManifest(m: WorkspaceManifest): string {
  const lines: string[] = [
    `version: ${m.version}`,
    `workspaceId: ${m.workspaceId}`,
  ];
  if (m.displayName) lines.push(`displayName: ${m.displayName}`);
  lines.push("", "repos:");
  const sorted = [...m.repos].sort((a, b) => a.repoId.localeCompare(b.repoId));
  for (const r of sorted) {
    lines.push(`  - repoId: ${r.repoId}`);
    lines.push(`    relativePath: ${r.relativePath}`);
    if (r.tags?.length) {
      lines.push(`    tags: [${r.tags.join(", ")}]`);
    }
  }
  if (m.indexing?.exclude?.length) {
    lines.push("", "indexing:", "  exclude:");
    for (const e of m.indexing.exclude) lines.push(`    - ${e}`);
  }
  if (m.context) {
    lines.push("", "context:");
    if (m.context.defaultBudgetTokens)
      lines.push(`  defaultBudgetTokens: ${m.context.defaultBudgetTokens}`);
    if (m.context.maxBudgetTokens)
      lines.push(`  maxBudgetTokens: ${m.context.maxBudgetTokens}`);
  }
  return lines.join("\n") + "\n";
}

// Minimal YAML parser — only handles the flat/list shape we emit.
function parseManifest(raw: string): WorkspaceManifest {
  const manifest: Partial<WorkspaceManifest> & { repos: RepoEntry[] } = {
    version: 1,
    workspaceId: "",
    repos: [],
  };
  const lines = raw.split("\n");
  let inRepos = false;
  let currentRepo: Partial<RepoEntry> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("workspaceId:"))
      manifest.workspaceId = trimmed.split(":")[1].trim();
    else if (trimmed.startsWith("displayName:"))
      manifest.displayName = trimmed.split(":").slice(1).join(":").trim();
    else if (trimmed === "repos:") inRepos = true;
    else if (inRepos && trimmed.startsWith("- repoId:")) {
      if (currentRepo?.repoId) manifest.repos.push(currentRepo as RepoEntry);
      currentRepo = { repoId: trimmed.split(":")[1].trim() };
    } else if (inRepos && trimmed.startsWith("relativePath:") && currentRepo) {
      currentRepo.relativePath = trimmed.split(":")[1].trim();
    } else if (inRepos && trimmed.startsWith("tags:") && currentRepo) {
      const tagStr = trimmed
        .replace("tags:", "")
        .trim()
        .replace(/[\[\]]/g, "");
      currentRepo.tags = tagStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (trimmed === "indexing:" || trimmed === "context:") {
      inRepos = false;
      if (currentRepo?.repoId) {
        manifest.repos.push(currentRepo as RepoEntry);
        currentRepo = null;
      }
    }
  }
  if (currentRepo?.repoId) manifest.repos.push(currentRepo as RepoEntry);
  return manifest as WorkspaceManifest;
}

export class WorkspaceResolver {
  /**
   * Walk upward from `startDir` to find .nexus/workspace.yaml.
   * Returns { root, manifestPath } or null.
   */
  static async findWorkspaceRoot(
    startDir: string,
  ): Promise<{ root: string; manifestPath: string } | null> {
    let dir = path.resolve(startDir);
    const { root } = path.parse(dir);

    while (true) {
      const candidate = path.join(dir, MANIFEST_REL);
      try {
        await fs.access(candidate);
        return { root: dir, manifestPath: candidate };
      } catch {
        // not found, go up
      }
      if (dir === root) return null;
      dir = path.dirname(dir);
    }
  }

  /** Read and parse the manifest at manifestPath. */
  static async readManifest(manifestPath: string): Promise<WorkspaceManifest> {
    const raw = await fs.readFile(manifestPath, "utf8");
    return parseManifest(raw);
  }

  /**
   * Write a manifest file atomically (tmp + rename).
   * Repos are sorted alphabetically — diff stays minimal.
   */
  static async writeManifest(
    manifestPath: string,
    manifest: WorkspaceManifest,
  ): Promise<void> {
    const dir = path.dirname(manifestPath);
    await fs.mkdir(dir, { recursive: true });
    const yaml = serializeManifest(manifest);
    const tmp = `${manifestPath}.tmp`;
    await fs.writeFile(tmp, yaml, "utf8");
    await fs.rename(tmp, manifestPath);
  }

  /** Create an empty workspace.yaml at workspaceRoot/.nexus/workspace.yaml. */
  static async initManifest(
    workspaceRoot: string,
    workspaceId: string,
    displayName?: string,
  ): Promise<WorkspaceManifest> {
    const manifest: WorkspaceManifest = {
      version: 1,
      workspaceId,
      displayName,
      repos: [],
      indexing: {
        exclude: [
          "node_modules/**",
          "dist/**",
          "build/**",
          ".git/**",
          ".venv/**",
          "__pycache__/**",
        ],
      },
      context: {
        defaultBudgetTokens: 12000,
        maxBudgetTokens: 24000,
      },
    };
    const manifestPath = path.join(workspaceRoot, MANIFEST_REL);
    await WorkspaceResolver.writeManifest(manifestPath, manifest);
    return manifest;
  }

  // ── Local state (under $NEXUS_DATA_DIR/workspaces/<id>/) ───────────

  static localStateDir(workspaceId: string): string {
    return nexusWorkspaceDir(workspaceId);
  }

  static localStatePath(workspaceId: string): string {
    return path.join(
      WorkspaceResolver.localStateDir(workspaceId),
      "workspace-state.json",
    );
  }

  static async readLocalState(
    workspaceId: string,
  ): Promise<WorkspaceState | null> {
    try {
      const raw = await fs.readFile(
        WorkspaceResolver.localStatePath(workspaceId),
        "utf8",
      );
      return JSON.parse(raw) as WorkspaceState;
    } catch {
      return null;
    }
  }

  static async writeLocalState(state: WorkspaceState): Promise<void> {
    const dir = WorkspaceResolver.localStateDir(state.workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = WorkspaceResolver.localStatePath(state.workspaceId);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, filePath);
  }
}
