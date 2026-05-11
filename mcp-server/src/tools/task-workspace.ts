// ─────────────────────────────────────────────────────────────
// MCP tools: Task Workspace (PR 12)
// nexus_spawn_task_workspace, nexus_get_task_workspace,
// nexus_apply_task_patch
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { ContextPackBuilder } from "@nexus-hub/core";
import {
  TaskWorkspaceManager,
  PatchGenerator,
  RepoDetector,
  nexusWorkspaceDir,
} from "@nexus-hub/core";
import type { Config } from "../config.js";

export function registerTaskWorkspaceTools(
  server: McpServer,
  contextPackBuilder: ContextPackBuilder,
  config: Config,
): void {
  // ── nexus_spawn_task_workspace ─────────────────────────────
  server.registerTool(
    "nexus_spawn_task_workspace",
    {
      description: [
        "Create an isolated task workspace for a task.",
        "Selected files are copied from the real repo into an isolated directory.",
        "Codex should work only with selected-files/ inside the workspace.",
      ].join(" "),
      inputSchema: {
        task_id: z
          .string()
          .describe("Unique task identifier (e.g. from nexus_open_task)."),
        task: z.string().describe("Natural language description of the task."),
        context_pack_id: z
          .string()
          .optional()
          .describe(
            "Existing context pack ID to use. If omitted, a fresh one is built.",
          ),
        workspace_id: z
          .string()
          .optional()
          .describe(
            "Nexus workspace ID (default: NEXUS_WORKSPACE_ID env or 'default').",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Repo directory (default: process.cwd())."),
        selected_files: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit relative file paths to include in the workspace. If omitted, derived from context pack manifest.",
          ),
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes absolute local paths (workspaceDir, agentsMd, contextPackMd) in the response.",
          ),
      },
    },
    async ({
      task_id,
      task,
      context_pack_id,
      workspace_id,
      cwd,
      selected_files,
      debug = false,
    }) => {
      try {
        const startDir =
          cwd ?? process.env.NEXUS_WORKSPACE_ROOT ?? process.cwd();
        const detected = await RepoDetector.detect(startDir);
        if (!detected) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Could not detect a Git repo at cwd.",
                }),
              },
            ],
            isError: true,
          };
        }

        // Load or build context pack
        let contextPack;
        if (context_pack_id) {
          const wid = workspace_id ?? config.workspaceId;
          const packPath = path.join(
            nexusWorkspaceDir(wid),
            "context-packs",
            `${context_pack_id}.json`,
          );
          const { default: fs } = await import("node:fs/promises");
          const raw = await fs.readFile(packPath, "utf8");
          contextPack = JSON.parse(raw);
        } else {
          contextPack = await contextPackBuilder.build({
            workspaceId: workspace_id ?? config.workspaceId,
            task,
            budget: {
              maxInputTokens: config.taskWorkspace.maxInputTokens,
              reservedOutputTokens: config.budget.reservedOutputTokens,
            },
          });
        }

        const info = await TaskWorkspaceManager.spawn({
          taskId: task_id,
          repoRoot: detected.repoRoot,
          contextPack,
          selectedFiles: selected_files,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  taskId: task_id,
                  selectedFiles: info.selectedFiles,
                  createdAt: info.createdAt,
                  hint: `Task workspace ready. Use taskId '${task_id}' with nexus_get_task_workspace or nexus_apply_task_patch.`,
                  ...(debug
                    ? {
                        localWorkspaceDir: info.workspaceDir,
                        agentsMd: info.agentsMdPath,
                        contextPackMd: info.contextPackMdPath,
                        cdHint: `cd "${info.workspaceDir}" && codex`,
                      }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_get_task_workspace ───────────────────────────────
  server.registerTool(
    "nexus_get_task_workspace",
    {
      description:
        "Get info about an existing task workspace (selected files, paths, created at).",
      inputSchema: {
        task_id: z.string().describe("Task identifier."),
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes absolute local paths (workspaceDir, repoRoot, agentsMd, contextPackMd) in the response.",
          ),
      },
    },
    async ({ task_id, debug = false }) => {
      try {
        const info = await TaskWorkspaceManager.getInfo(task_id);
        if (!info) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `No workspace found for task '${task_id}'.`,
                }),
              },
            ],
            isError: true,
          };
        }
        const response = {
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
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(response, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_apply_task_patch ─────────────────────────────────
  server.registerTool(
    "nexus_apply_task_patch",
    {
      description: [
        "Generate a unified diff of all changes made inside a task workspace",
        "and return it. The caller is responsible for applying the patch or",
        "copying files to the real repo.",
        "By default returns a summary; set include_full_diff=true for the raw unified diff.",
      ].join(" "),
      inputSchema: {
        task_id: z.string().describe("Task identifier."),
        include_full_diff: z
          .boolean()
          .optional()
          .describe("Include the full unified diff text (default: false)."),
      },
    },
    async ({ task_id, include_full_diff = false }) => {
      try {
        const info = await TaskWorkspaceManager.getInfo(task_id);
        if (!info) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `No workspace found for task '${task_id}'.`,
                }),
              },
            ],
            isError: true,
          };
        }

        const generated = await PatchGenerator.generate(info);

        const summary = {
          taskId: generated.taskId,
          filesChanged: generated.patches.length,
          totalLinesAdded: generated.totalLinesAdded,
          totalLinesRemoved: generated.totalLinesRemoved,
          files: generated.patches.map((p) => ({
            path: p.relativePath,
            linesAdded: p.linesAdded,
            linesRemoved: p.linesRemoved,
          })),
          ...(include_full_diff ? { unifiedDiff: generated.unifiedDiff } : {}),
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
