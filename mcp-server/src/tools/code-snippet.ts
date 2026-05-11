// ─────────────────────────────────────────────────────────────
// MCP tool: nexus_get_code_snippet (PR 7)
// Returns a line-range excerpt from a file listed in the
// context pack manifest. Enforces the manifest guard —
// callers must have a contextPackId and a sourceId that
// appears in its manifest before reading raw file content.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContextPack } from "@nexus-hub/core";
import { nexusWorkspaceDir } from "@nexus-hub/core";
import { mcpJson, mcpError } from "../utils/mcp-response.js";

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

async function loadContextPack(
  workspaceId: string,
  packId: string,
): Promise<ContextPack | null> {
  try {
    const filePath = path.join(
      nexusWorkspaceDir(workspaceId),
      "context-packs",
      `${packId}.json`,
    );
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as ContextPack;
  } catch {
    return null;
  }
}

export function registerCodeSnippetTool(
  server: McpServer,
  defaultWorkspaceId: string,
): void {
  server.registerTool(
    "nexus_get_code_snippet",
    {
      description:
        "Read a line-range excerpt from a file that is listed in the context pack manifest. Always provide contextPackId and sourceId — this enforces the manifest guard and prevents unbounded file reads. Token-capped at maxTokens (default 1500).",
      inputSchema: {
        workspace_id: z
          .string()
          .optional()
          .describe(
            `Workspace ID owning the context pack (default: ${defaultWorkspaceId}).`,
          ),
        context_pack_id: z
          .string()
          .describe("Context pack ID returned by nexus_build_context_pack."),
        source_id: z
          .string()
          .describe(
            "A sourceId (file path) listed in the context pack manifest.",
          ),
        file_root: z
          .string()
          .optional()
          .describe(
            "Absolute path used to resolve relative source paths (e.g. the repo root). Falls back to NEXUS_WORKSPACE_ROOT env var, then process.cwd().",
          ),
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
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes the resolved absolute file path in the response (for developer debugging only).",
          ),
      },
    },
    async ({
      workspace_id,
      context_pack_id,
      source_id,
      file_root,
      start_line = 1,
      end_line,
      max_tokens = 1500,
      debug = false,
    }) => {
      const resolvedWorkspace = workspace_id ?? defaultWorkspaceId;
      // ── Manifest guard ──────────────────────────────────────
      const pack = await loadContextPack(resolvedWorkspace, context_pack_id);
      if (!pack) {
        return mcpError(`Context pack "${context_pack_id}" not found.`);
      }

      const inManifest = pack.manifest.some(
        (item) =>
          item.source === source_id ||
          item.id === source_id ||
          item.id.endsWith(`/${source_id}`),
      );

      if (!inManifest) {
        const manifestSources = pack.manifest.map((m) => m.source);
        return mcpError(
          `"${source_id}" is not in the context pack manifest.`,
          {
            hint: "Call nexus_build_context_pack first, or check the manifest for valid sourceIds.",
            manifestSources,
          },
        );
      }

      // ── Resolve file path from manifest item ───────────────
      // Use the manifest item's actual source field (may differ from
      // source_id when caller used the display id like "file:svc/path").
      const manifestItem = pack.manifest.find(
        (item) =>
          item.source === source_id ||
          item.id === source_id ||
          item.id.endsWith(`/${source_id}`),
      );
      const actualSource = manifestItem?.source ?? source_id;

      // Resolve relative paths against file_root → NEXUS_WORKSPACE_ROOT → cwd
      const resolvedRoot =
        file_root ?? process.env.NEXUS_WORKSPACE_ROOT ?? process.cwd();
      const resolvedPath = path.isAbsolute(actualSource)
        ? actualSource
        : path.resolve(resolvedRoot, actualSource);

      // ── Read file ───────────────────────────────────────────
      try {
        const raw = await fs.readFile(resolvedPath, "utf8");
        const allLines = raw.split("\n");

        const effectiveEnd =
          end_line ?? Math.min(start_line + 49, allLines.length);
        const slice = allLines.slice(start_line - 1, effectiveEnd);

        // Token cap truncation
        let result = "";
        for (const line of slice) {
          const next = result + line + "\n";
          if (estimateTokens(next) > max_tokens) break;
          result = next;
        }

        const truncated = result.length < slice.join("\n").length;

        return mcpJson({
          source: actualSource,
          ...(debug ? { resolvedPath } : {}),
          startLine: start_line,
          endLine: effectiveEnd,
          estimatedTokens: estimateTokens(result),
          truncated,
          content: result,
        });
      } catch (err) {
        return mcpError(err, { source: source_id });
      }
    },
  );
}
