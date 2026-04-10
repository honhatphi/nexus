import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { parseSource, detectLanguage, EXTENSION_MAP } from "@nexus-hub/common-tools";
import type { ParseResult } from "@nexus-hub/common-tools";

/**
 * Register the `parse_code` MCP tool.
 * Accepts a file path OR raw source code & parses it with tree-sitter.
 */
export function registerParserTool(server: McpServer): void {
  server.tool(
    "parse_code",
    `Parse a source file (.go, .py, .php, .ts/.tsx) using tree-sitter and extract functions, parameters, return types, and function calls into a unified JSON schema. Supported extensions: ${Object.keys(EXTENSION_MAP).join(", ")}`,
    {
      filePath: z
        .string()
        .optional()
        .describe("Absolute path to the source file to parse. If provided, source is read from disk."),
      source: z
        .string()
        .optional()
        .describe("Raw source code string. Required if filePath is not provided."),
      language: z
        .enum(["go", "python", "php", "typescript"])
        .optional()
        .describe("Explicit language override. Auto-detected from filePath extension if omitted."),
    },
    async ({ filePath, source, language }) => {
      try {
        // Resolve source code
        let code = source;
        let resolvedPath = filePath ?? "inline";

        if (filePath && !source) {
          code = await fs.readFile(filePath, "utf-8");
        }

        if (!code) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Either filePath or source must be provided." }),
            }],
            isError: true,
          };
        }

        // If language is explicitly set but filePath has no matching extension,
        // create a synthetic path so detectLanguage works
        if (language && !detectLanguage(resolvedPath)) {
          const extMap: Record<string, string> = {
            go: ".go",
            python: ".py",
            php: ".php",
            typescript: ".ts",
          };
          resolvedPath = `inline${extMap[language]}`;
        }

        const result = parseSource(resolvedPath, code);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: String(err) }),
          }],
          isError: true,
        };
      }
    }
  );
}
