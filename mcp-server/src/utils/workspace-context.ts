// ─────────────────────────────────────────────────────────────
// Shared workspace / directory resolution helpers.
// Used by all MCP tools that accept an optional `cwd` or
// `workspace_id` to provide consistent zero-config behaviour.
// ─────────────────────────────────────────────────────────────

import { WorkspaceResolver, defaultWorkspaceId } from "@nexus-hub/core";

/**
 * Resolve the starting directory for workspace/repo detection.
 *
 * Priority:
 *   1. `cwd` argument (explicit caller value)
 *   2. `NEXUS_WORKSPACE_ROOT` env var
 *   3. `process.cwd()`
 */
export function resolveStartDir(cwd?: string): string {
  return cwd ?? process.env.NEXUS_WORKSPACE_ROOT ?? process.cwd();
}

/**
 * Resolve a workspace ID from tool input, walking up to find
 * `.nexus/workspace.yaml` when no explicit ID is given.
 *
 * Returns:
 *   - `workspaceId` — always a non-empty string
 *   - `startDir`    — the directory that was searched
 *   - `warning`     — set when falling back to the default ID
 */
export async function resolveWorkspaceFromInput(input: {
  workspaceId?: string;
  cwd?: string;
  fallbackWorkspaceId?: string;
}): Promise<{ workspaceId: string; startDir: string; warning?: string }> {
  const startDir = resolveStartDir(input.cwd);

  if (input.workspaceId) {
    return { workspaceId: input.workspaceId, startDir };
  }

  const found = await WorkspaceResolver.findWorkspaceRoot(startDir);
  if (found) {
    const manifest = await WorkspaceResolver.readManifest(found.manifestPath);
    return { workspaceId: manifest.workspaceId, startDir };
  }

  const fallback = input.fallbackWorkspaceId ?? defaultWorkspaceId();
  return {
    workspaceId: fallback,
    startDir,
    warning: `No .nexus/workspace.yaml found from '${startDir}'. Using fallback workspaceId '${fallback}'. Run nexus_resolve_workspace to initialise a workspace manifest.`,
  };
}
