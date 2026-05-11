// ─────────────────────────────────────────────────────────────
// Regression tests: MCP response builders must not leak
// absolute local paths when debug=false.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  taskWorkspaceView,
  spawnTaskWorkspaceView,
  workspaceStatusView,
  resolveWorkspaceView,
  syncCurrentRepoView,
} from "../src/utils/safe-response.js";

// ── Fixtures ──────────────────────────────────────────────────

const ABS_PATH = "/Users/dev/projects/my-repo";

const mockInfo = {
  taskId: "task-001",
  selectedFiles: ["src/index.ts", "src/utils.ts"],
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceDir: `${ABS_PATH}/.nexus/task-workspaces/task-001`,
  repoRoot: ABS_PATH,
  agentsMdPath: `${ABS_PATH}/.nexus/task-workspaces/task-001/AGENTS.md`,
  contextPackMdPath: `${ABS_PATH}/.nexus/task-workspaces/task-001/context-pack.md`,
};

function containsAbsPath(obj: unknown): boolean {
  const json = JSON.stringify(obj);
  return (
    json.includes("/Users/") ||
    json.includes("/home/") ||
    json.includes("C:\\\\") ||
    json.includes(ABS_PATH)
  );
}

/** Regression guard: raw TaskWorkspaceInfo keys must never appear in response JSON. */
function leaksRawInfoKeys(obj: unknown): boolean {
  const json = JSON.stringify(obj);
  return (
    json.includes('"workspaceDir"') ||
    json.includes('"agentsMdPath"') ||
    json.includes('"contextPackMdPath"')
  );
}

// ── taskWorkspaceView ─────────────────────────────────────────

describe("taskWorkspaceView", () => {
  it("debug=false: does not contain absolute paths", () => {
    const result = taskWorkspaceView(mockInfo, false);
    expect(containsAbsPath(result)).toBe(false);
  });

  it("debug=false: does not include workspaceDir, repoRoot, agentsMd, contextPackMd", () => {
    const result = taskWorkspaceView(mockInfo, false);
    expect(result).not.toHaveProperty("localWorkspaceDir");
    expect(result).not.toHaveProperty("repoRoot");
    expect(result).not.toHaveProperty("agentsMd");
    expect(result).not.toHaveProperty("contextPackMd");
    expect(result).not.toHaveProperty("cdHint");
  });

  it("debug=false: still contains safe fields", () => {
    const result = taskWorkspaceView(mockInfo, false);
    expect(result).toHaveProperty("taskId", "task-001");
    expect(result).toHaveProperty("selectedFiles");
    expect(result).toHaveProperty("createdAt");
    expect(result).toHaveProperty("hint");
  });

  it("debug=false: does not leak raw TaskWorkspaceInfo keys in JSON", () => {
    const result = taskWorkspaceView(mockInfo, false);
    expect(leaksRawInfoKeys(result)).toBe(false);
  });

  it("debug=true: includes local debug fields", () => {
    const result = taskWorkspaceView(mockInfo, true);
    expect(result).toHaveProperty("localWorkspaceDir");
    expect(result).toHaveProperty("repoRoot", ABS_PATH);
    expect(result).toHaveProperty("agentsMd");
    expect(result).toHaveProperty("contextPackMd");
    expect(result).toHaveProperty("cdHint");
    expect(containsAbsPath(result)).toBe(true);
  });

  it("debug=true: does not leak raw TaskWorkspaceInfo keys in JSON", () => {
    const result = taskWorkspaceView(mockInfo, true);
    expect(leaksRawInfoKeys(result)).toBe(false);
  });
});

// ── spawnTaskWorkspaceView ────────────────────────────────────

describe("spawnTaskWorkspaceView", () => {
  it("debug=false: does not contain absolute paths", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, false);
    expect(containsAbsPath(result)).toBe(false);
  });

  it("debug=false: does not include localWorkspaceDir or debug fields", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, false);
    expect(result).not.toHaveProperty("localWorkspaceDir");
    expect(result).not.toHaveProperty("agentsMd");
    expect(result).not.toHaveProperty("contextPackMd");
    expect(result).not.toHaveProperty("cdHint");
  });

  it("debug=false: still contains safe fields", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, false);
    expect(result).toHaveProperty("taskId", "task-001");
    expect(result).toHaveProperty("selectedFiles");
    expect(result).toHaveProperty("createdAt");
    expect(result).toHaveProperty("hint");
  });

  it("debug=false: does not leak raw TaskWorkspaceInfo keys in JSON", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, false);
    expect(leaksRawInfoKeys(result)).toBe(false);
  });

  it("debug=true: includes local debug fields", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, true);
    expect(result).toHaveProperty("localWorkspaceDir");
    expect(result).toHaveProperty("agentsMd");
    expect(result).toHaveProperty("contextPackMd");
    expect(result).toHaveProperty("cdHint");
    expect(containsAbsPath(result)).toBe(true);
  });

  it("debug=true: does not leak raw TaskWorkspaceInfo keys in JSON", () => {
    const result = spawnTaskWorkspaceView("task-001", mockInfo, true);
    expect(leaksRawInfoKeys(result)).toBe(false);
  });
});

// ── workspaceStatusView ───────────────────────────────────────

describe("workspaceStatusView", () => {
  const repos = [{ repoId: "my-repo", relativePath: "." }];
  const currentRepo = { repoId: "my-repo", branch: "main" };

  it("debug=false: does not contain workspaceRoot", () => {
    const result = workspaceStatusView(
      "ws-1",
      ABS_PATH,
      currentRepo,
      repos,
      false,
    );
    expect(result).not.toHaveProperty("workspaceRoot");
    expect(containsAbsPath(result)).toBe(false);
  });

  it("debug=false: still returns workspaceId, repos, currentRepo", () => {
    const result = workspaceStatusView(
      "ws-1",
      ABS_PATH,
      currentRepo,
      repos,
      false,
    );
    expect(result).toHaveProperty("workspaceId", "ws-1");
    expect(result).toHaveProperty("repos");
    expect(result).toHaveProperty("currentRepo");
  });

  it("debug=true: includes workspaceRoot", () => {
    const result = workspaceStatusView(
      "ws-1",
      ABS_PATH,
      currentRepo,
      repos,
      true,
    );
    expect(result).toHaveProperty("workspaceRoot", ABS_PATH);
    expect(containsAbsPath(result)).toBe(true);
  });
});

// ── resolveWorkspaceView ──────────────────────────────────────

describe("resolveWorkspaceView", () => {
  const manifestPath = `${ABS_PATH}/.nexus/workspace.yaml`;

  it("debug=false: does not contain workspaceRoot or manifestPath", () => {
    const result = resolveWorkspaceView(
      "ws-1",
      3,
      ABS_PATH,
      manifestPath,
      false,
    );
    expect(result).not.toHaveProperty("workspaceRoot");
    expect(result).not.toHaveProperty("manifestPath");
    expect(containsAbsPath(result)).toBe(false);
  });

  it("debug=false: returns workspaceId and reposRegistered", () => {
    const result = resolveWorkspaceView(
      "ws-1",
      3,
      ABS_PATH,
      manifestPath,
      false,
    );
    expect(result).toHaveProperty("workspaceId", "ws-1");
    expect(result).toHaveProperty("reposRegistered", 3);
  });

  it("debug=true: includes workspaceRoot and manifestPath", () => {
    const result = resolveWorkspaceView(
      "ws-1",
      3,
      ABS_PATH,
      manifestPath,
      true,
    );
    expect(result).toHaveProperty("workspaceRoot", ABS_PATH);
    expect(result).toHaveProperty("manifestPath", manifestPath);
  });
});

// ── syncCurrentRepoView ───────────────────────────────────────

describe("syncCurrentRepoView", () => {
  const syncResult = { indexed: 12, skipped: 0 };

  it("debug=false: does not contain repoRoot", () => {
    const result = syncCurrentRepoView(
      "my-repo",
      ABS_PATH,
      "main",
      "abc123",
      false,
      syncResult,
      false,
    );
    const repo = result.repo as Record<string, unknown>;
    expect(repo).not.toHaveProperty("repoRoot");
    expect(containsAbsPath(result)).toBe(false);
  });

  it("debug=false: still returns repoId, branch, commit", () => {
    const result = syncCurrentRepoView(
      "my-repo",
      ABS_PATH,
      "main",
      "abc123",
      false,
      syncResult,
      false,
    );
    const repo = result.repo as Record<string, unknown>;
    expect(repo).toHaveProperty("repoId", "my-repo");
    expect(repo).toHaveProperty("branch", "main");
    expect(repo).toHaveProperty("commit", "abc123");
    expect(result).toHaveProperty("sync");
  });

  it("debug=true: includes repoRoot", () => {
    const result = syncCurrentRepoView(
      "my-repo",
      ABS_PATH,
      "main",
      "abc123",
      false,
      syncResult,
      true,
    );
    const repo = result.repo as Record<string, unknown>;
    expect(repo).toHaveProperty("repoRoot", ABS_PATH);
    expect(containsAbsPath(result)).toBe(true);
  });

  it("handles null branch and commit gracefully", () => {
    const result = syncCurrentRepoView(
      "my-repo",
      ABS_PATH,
      null,
      null,
      false,
      syncResult,
      false,
    );
    const repo = result.repo as Record<string, unknown>;
    expect(repo.branch).toBeNull();
    expect(repo.commit).toBeNull();
    expect(containsAbsPath(result)).toBe(false);
  });
});
