// ─────────────────────────────────────────────────────────────
// safe-response.ts — path-sanitising view functions
// Extracts only safe (non-absolute-path) fields from internal
// structs when debug=false. Pass debug=true for full paths.
// ─────────────────────────────────────────────────────────────

import type { TaskWorkspaceInfo } from "@nexus-hub/core";

// ── Task workspace views ──────────────────────────────────────

export function taskWorkspaceView(
  info: TaskWorkspaceInfo,
  debug = false,
): Record<string, unknown> {
  return {
    taskId: info.taskId,
    selectedFiles: info.selectedFiles,
    createdAt: info.createdAt,
    hint: `Use nexus_apply_task_patch with taskId '${info.taskId}' to inspect changes.`,
    ...(debug
      ? {
          localWorkspaceDir: info.workspaceDir,
          repoRoot: info.repoRoot,
          agentsMd: info.agentsMdPath,
          contextPackMd: info.contextPackMdPath,
          cdHint: `cd "${info.workspaceDir}" && codex`,
        }
      : {}),
  };
}

export function spawnTaskWorkspaceView(
  taskId: string,
  info: TaskWorkspaceInfo,
  debug = false,
): Record<string, unknown> {
  return {
    taskId,
    selectedFiles: info.selectedFiles,
    createdAt: info.createdAt,
    hint: `Task workspace ready. Use taskId '${taskId}' with nexus_get_task_workspace or nexus_apply_task_patch.`,
    ...(debug
      ? {
          localWorkspaceDir: info.workspaceDir,
          agentsMd: info.agentsMdPath,
          contextPackMd: info.contextPackMdPath,
          cdHint: `cd "${info.workspaceDir}" && codex`,
        }
      : {}),
  };
}

// ── Workspace status view ─────────────────────────────────────

export function workspaceStatusView(
  workspaceId: string,
  workspaceRoot: string,
  currentRepo: Record<string, unknown> | null,
  repos: Record<string, unknown>[],
  debug = false,
): Record<string, unknown> {
  return {
    workspaceId,
    ...(debug ? { workspaceRoot } : {}),
    currentRepo,
    repos,
  };
}

// ── Resolve workspace view ────────────────────────────────────

export function resolveWorkspaceView(
  workspaceId: string,
  reposRegistered: number,
  root: string,
  manifestPath: string,
  debug = false,
): Record<string, unknown> {
  return {
    workspaceId,
    reposRegistered,
    ...(debug ? { workspaceRoot: root, manifestPath } : {}),
  };
}

// ── Sync current repo view ────────────────────────────────────

export function syncCurrentRepoView(
  repoId: string,
  repoRoot: string,
  branch: string | null | undefined,
  commit: string | null | undefined,
  addedToManifest: boolean,
  syncResult: unknown,
  debug = false,
): Record<string, unknown> {
  return {
    repo: {
      repoId,
      ...(debug ? { repoRoot } : {}),
      branch,
      commit,
      addedToManifest,
    },
    sync: syncResult,
  };
}
