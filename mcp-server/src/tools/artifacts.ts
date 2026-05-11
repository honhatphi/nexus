// ─────────────────────────────────────────────────────────────
// MCP tools: Artifact Store (PR 5)
// nexus_store_artifact, nexus_get_artifact_summary,
// nexus_get_artifact_excerpt
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArtifactService } from "@nexus-hub/core";

export function registerArtifactTools(
  server: McpServer,
  artifacts: ArtifactService,
): void {
  // ── nexus_store_artifact ───────────────────────────────────
  server.registerTool("nexus_store_artifact", {
    description: "Store large output (test logs, diffs, terminal output, query results) as an artifact so it does not occupy the prompt context. Returns a compact summary and an artifactId for later retrieval.",
    inputSchema: {
      kind: z
        .enum([
          "test_log",
          "diff",
          "query_result",
          "terminal_output",
          "raw_context",
        ])
        .describe("Type of content being stored."),
      content: z.string().describe("Full raw content to store."),
      task_id: z
        .string()
        .optional()
        .describe("Optional task ID to associate this artifact with."),
    },
  }, async ({ kind, content, task_id }) => {
      try {
        const result = await artifacts.storeArtifact({
          kind,
          content,
          taskId: task_id,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
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
    });

  // ── nexus_get_artifact_summary ─────────────────────────────
  server.registerTool("nexus_get_artifact_summary", {
    description: "Get the compact summary and metadata for a stored artifact without fetching its full content.",
    inputSchema: {
      artifact_id: z
        .string()
        .describe("Artifact ID returned by nexus_store_artifact."),
    },
  }, async ({ artifact_id }) => {
      try {
        const ref = await artifacts.getArtifactSummary(artifact_id);
        if (!ref) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Artifact "${artifact_id}" not found.`,
                }),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(ref, null, 2) },
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
    });

  // ── nexus_get_artifact_excerpt ─────────────────────────────
  server.registerTool("nexus_get_artifact_excerpt", {
    description: "Retrieve a line-range excerpt from a stored artifact. Capped at maxTokens to prevent context overflow. Use this for targeted inspection of test failures, diffs, or query results.",
    inputSchema: {
      artifact_id: z.string().describe("Artifact ID to read from."),
      start_line: z
        .number()
        .optional()
        .describe("1-based start line (default: 1)."),
      end_line: z
        .number()
        .optional()
        .describe("Inclusive end line (default: start_line + 49)."),
      max_tokens: z
        .number()
        .optional()
        .describe("Token cap for the excerpt (default: 1500)."),
    },
  }, async ({ artifact_id, start_line, end_line, max_tokens }) => {
      try {
        const endDefault = start_line ? start_line + 49 : 50;
        const excerpt = await artifacts.getArtifactExcerpt(
          artifact_id,
          start_line,
          end_line ?? endDefault,
          max_tokens,
        );
        if (!excerpt) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Artifact "${artifact_id}" not found.`,
                }),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(excerpt, null, 2) },
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
    });
}
