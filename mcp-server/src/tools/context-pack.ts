// ─────────────────────────────────────────────────────────────
// MCP tool: nexus_build_context_pack (PR 6)
// Builds a budget-trimmed context pack for a given task.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextPackBuilder } from "@nexus-hub/core";
import type { Config } from "../config.js";

export function registerContextPackTool(
  server: McpServer,
  builder: ContextPackBuilder,
  defaultBudget: Config["budget"],
): void {
  server.tool(
    "nexus_build_context_pack",
    "Build a budget-trimmed context pack for a task. Runs hybrid search against the KB, selects the most relevant files/symbols, pulls the active task ledger (if taskId provided), and returns a structured pack with a manifest and instructions. Use this as the FIRST tool call for any coding or debugging task.",
    {
      workspace_id: z
        .string()
        .describe("Workspace or service ID being worked on."),
      task: z
        .string()
        .describe("Short description of the task (1-3 sentences)."),
      mode: z
        .enum(["ask", "code", "debug", "review", "migration"])
        .optional()
        .describe("Task mode — affects retrieval strategy. Default: code."),
      task_id: z
        .string()
        .optional()
        .describe(
          "Active task ID from nexus_open_task. If provided, includes ledger state in the pack.",
        ),
      max_input_tokens: z
        .number()
        .optional()
        .describe(
          `Token budget for the context pack (default: ${defaultBudget.maxInputTokens}).`,
        ),
      max_files: z
        .number()
        .optional()
        .describe("Maximum number of files/symbols to include (default: 8)."),
    },
    async ({
      workspace_id,
      task,
      mode,
      task_id,
      max_input_tokens,
      max_files,
    }) => {
      try {
        const pack = await builder.build({
          workspaceId: workspace_id,
          task,
          mode,
          taskId: task_id,
          budget: max_input_tokens
            ? {
                maxInputTokens: max_input_tokens,
                reservedOutputTokens: defaultBudget.reservedOutputTokens,
              }
            : undefined,
          preferences: max_files ? { maxFiles: max_files } : undefined,
        });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(pack, null, 2) },
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
