// ─────────────────────────────────────────────────────────────
// Workspace Manifest types (PR 3)
// Reads/writes .nexus/workspace.yaml
// ─────────────────────────────────────────────────────────────

export interface WorkspaceManifest {
  version: 1;
  workspaceId: string;
  displayName?: string;
  repos: RepoEntry[];
  indexing?: IndexingConfig;
  context?: ContextConfig;
}

export interface RepoEntry {
  repoId: string;
  relativePath: string;
  tags?: string[];
}

export interface IndexingConfig {
  exclude?: string[];
}

export interface ContextConfig {
  defaultBudgetTokens?: number;
  maxBudgetTokens?: number;
}

/** Local runtime state — not committed to git. */
export interface WorkspaceState {
  workspaceId: string;
  workspaceRoot: string;
  repos: Record<
    string,
    {
      absolutePath: string;
      relativePath: string;
      lastIndexedCommit?: string;
      lastIndexedAt?: string;
    }
  >;
}
