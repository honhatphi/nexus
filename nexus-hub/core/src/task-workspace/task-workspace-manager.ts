// ─────────────────────────────────────────────────────────────
// TaskWorkspaceManager (PR 12)
// Creates an isolated task workspace under
// ~/.nexus/tasks/<taskId>/workspace/ with selected files
// symlinked from the real repo. Codex runs inside and only
// sees what was selected.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import type { ContextPack } from "../contracts/context-pack.js";
import { nexusDataDir } from "../env.js";

export interface SpawnWorkspaceInput {
  taskId: string;
  repoRoot: string;
  contextPack: ContextPack;
  /** Explicit list of files to include (relative to repoRoot). If omitted, derived from contextPack manifest. */
  selectedFiles?: string[];
}

export interface TaskWorkspaceInfo {
  taskId: string;
  workspaceDir: string;
  repoRoot: string;
  selectedFiles: string[];
  agentsMdPath: string;
  contextPackMdPath: string;
  createdAt: string;
}

const WORKSPACE_AGENTS_MD = `# Nexus Task Workspace

This is an isolated task workspace. Only the files in \`selected-files/\` are available.
Files are **copied** from the real repo — edits here do NOT affect the original repo directly.

## Workflow

1. Read \`context-pack.md\` for context about this task.
2. Edit files in \`selected-files/\` freely — they are isolated copies.
3. When done, call \`nexus_apply_task_patch\` to generate a unified diff of your changes.
4. Review the diff, then apply it to the real repo with \`git apply\` or the patch tool.

## Rules

- Do NOT read files outside \`selected-files/\`.
- Do NOT run \`git commit\` from this directory.
- Store large outputs with \`nexus_store_artifact\`.
`;

export class TaskWorkspaceManager {
  static tasksDir(): string {
    return path.join(nexusDataDir(), "tasks");
  }

  static workspaceDir(taskId: string): string {
    return path.join(TaskWorkspaceManager.tasksDir(), taskId, "workspace");
  }

  static infoPath(taskId: string): string {
    return path.join(
      TaskWorkspaceManager.tasksDir(),
      taskId,
      "workspace-info.json",
    );
  }

  /** Create the isolated workspace for a task. */
  static async spawn(input: SpawnWorkspaceInput): Promise<TaskWorkspaceInfo> {
    const wsDir = TaskWorkspaceManager.workspaceDir(input.taskId);
    const selectedDir = path.join(wsDir, "selected-files");
    await fs.mkdir(selectedDir, { recursive: true });
    await fs.mkdir(path.join(wsDir, "artifacts"), { recursive: true });

    // Derive selected files from manifest or explicit list
    const relFiles =
      input.selectedFiles ??
      input.contextPack.manifest
        .filter((m) => m.type === "file_capsule" || m.type === "symbol_context")
        .map((m) => m.source)
        .filter((s) => s && !s.startsWith("http"));

    const symlinked: string[] = [];

    for (const relFile of relFiles) {
      const absSource = path.isAbsolute(relFile)
        ? relFile
        : path.join(input.repoRoot, relFile);

      try {
        await fs.access(absSource);
      } catch {
        // File doesn't exist — skip
        continue;
      }

      const linkPath = path.join(selectedDir, relFile);
      await fs.mkdir(path.dirname(linkPath), { recursive: true });

      // Copy file for true isolation — edits do not touch the real repo.
      // PatchGenerator diffs the copy against the original to produce patches.
      try {
        await fs.copyFile(absSource, linkPath);
      } catch {
        continue;
      }
      symlinked.push(relFile);
    }

    // Write AGENTS.md
    const agentsMdPath = path.join(wsDir, "AGENTS.md");
    await fs.writeFile(agentsMdPath, WORKSPACE_AGENTS_MD, "utf8");

    // Write context-pack.md
    const contextPackMdPath = path.join(wsDir, "context-pack.md");
    const contextMd = TaskWorkspaceManager.renderContextPackMd(
      input.contextPack,
    );
    await fs.writeFile(contextPackMdPath, contextMd, "utf8");

    const info: TaskWorkspaceInfo = {
      taskId: input.taskId,
      workspaceDir: wsDir,
      repoRoot: input.repoRoot,
      selectedFiles: symlinked,
      agentsMdPath,
      contextPackMdPath,
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(
      TaskWorkspaceManager.infoPath(input.taskId),
      JSON.stringify(info, null, 2),
      "utf8",
    );

    return info;
  }

  /** Read info for an existing workspace. */
  static async getInfo(taskId: string): Promise<TaskWorkspaceInfo | null> {
    try {
      const raw = await fs.readFile(
        TaskWorkspaceManager.infoPath(taskId),
        "utf8",
      );
      return JSON.parse(raw) as TaskWorkspaceInfo;
    } catch {
      return null;
    }
  }

  /** Remove the workspace directory (does not affect the real repo). */
  static async teardown(taskId: string): Promise<void> {
    const dir = path.join(TaskWorkspaceManager.tasksDir(), taskId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  private static renderContextPackMd(pack: ContextPack): string {
    const lines = [
      `# Context Pack: ${pack.id}`,
      ``,
      `**Task**: ${pack.task}`,
      `**Mode**: ${pack.mode}`,
      `**EstimatedTokens**: ${pack.estimatedTokens}`,
      ``,
      `## Instructions`,
      ...pack.instructions.map((i) => `- ${i}`),
      ``,
      `## Manifest`,
      ``,
    ];

    for (const item of pack.manifest) {
      lines.push(`- \`${item.id}\` (${item.type})`);
      lines.push(`  - source: ${item.source}`);
      lines.push(`  - reason: ${item.reason}`);
      lines.push(`  - tokens: ~${item.estimatedTokens}`);
    }

    if (pack.sections.length) {
      lines.push(``, `## Context Sections`);
      for (const s of pack.sections) {
        lines.push(``, `### ${s.title}`, ``, s.content);
      }
    }

    return lines.join("\n") + "\n";
  }
}
