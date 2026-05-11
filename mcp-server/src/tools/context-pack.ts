// ─────────────────────────────────────────────────────────────
// MCP tool: nexus_build_context_pack (PR 6)
// Builds a budget-trimmed context pack for a given task.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextPackBuilder } from "@nexus-hub/core";
import { WorkspaceResolver, defaultWorkspaceId } from "@nexus-hub/core";
import type { Config } from "../config.js";
import { mcpError, mcpText } from "../utils/mcp-response.js";

export function registerContextPackTool(
  server: McpServer,
  builder: ContextPackBuilder,
  defaultBudget: Config["budget"],
): void {
  server.registerTool(
    "nexus_build_context_pack",
    {
      description:
        "Build a budget-trimmed context pack for a task. Runs hybrid search against the KB, selects the most relevant files/symbols, pulls the active task ledger (if taskId provided), and returns a structured pack with a manifest and instructions. Use this as the FIRST tool call for any coding or debugging task.",
      inputSchema: {
        workspace_id: z
          .string()
          .optional()
          .describe(
            "Workspace or service ID. Optional — if omitted, resolved from .nexus/workspace.yaml manifest, NEXUS_WORKSPACE_ROOT env var, or process.cwd().",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Directory to search for .nexus/workspace.yaml manifest. Only used when workspace_id is omitted.",
          ),
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
    },
    async ({
      workspace_id,
      cwd,
      task,
      mode,
      task_id,
      max_input_tokens,
      max_files,
    }) => {
      try {
        // ── Zero-config workspace resolution ──────────────────
        let resolvedWorkspaceId = workspace_id;
        let workspaceHint: string | undefined;

        if (!resolvedWorkspaceId) {
          const startDir =
            cwd ?? process.env.NEXUS_WORKSPACE_ROOT ?? process.cwd();
          const found = await WorkspaceResolver.findWorkspaceRoot(startDir);
          if (found) {
            const manifest = await WorkspaceResolver.readManifest(
              found.manifestPath,
            );
            resolvedWorkspaceId = manifest.workspaceId;
          } else {
            resolvedWorkspaceId = defaultWorkspaceId();
            workspaceHint = `No .nexus/workspace.yaml found from '${startDir}'. Using fallback workspaceId '${resolvedWorkspaceId}'. Run nexus_resolve_workspace to initialise a workspace manifest.`;
          }
        }

        const pack = await builder.build({
          workspaceId: resolvedWorkspaceId,
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

        // Return compact summary: instructions + manifest + sections.
        // Avoid returning the full raw JSON blob which can exceed token budget.
        const CHARS_PER_TOKEN = 4;
        const outputBudgetChars =
          defaultBudget.reservedOutputTokens * CHARS_PER_TOKEN;
        const packWithHint = workspaceHint
          ? { ...pack, _warning: workspaceHint }
          : pack;
        const finalOut = JSON.stringify(packWithHint, null, 2);
        const text =
          finalOut.length > outputBudgetChars
            ? finalOut.slice(0, outputBudgetChars) +
              `\n... [truncated — ${Math.ceil(finalOut.length / CHARS_PER_TOKEN)} estimated tokens total. Use nexus_get_code_snippet for file content.]`
            : finalOut;

        return mcpText(text);
      } catch (err) {
        return mcpError(err);
      }
    },
  );
}
