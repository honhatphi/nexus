// ─────────────────────────────────────────────────────────────
// mcp-response.ts — shared MCP response builders
// Centralises JSON.stringify and error shaping so tool handlers
// stay readable and consistent.
// ─────────────────────────────────────────────────────────────

type TextContent = { type: "text"; text: string };

export interface McpResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: true;
}

/** Successful JSON response. */
export function mcpJson(data: unknown): McpResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Error response. Accepts an Error, string, or any thrown value.
 *  Extra fields are merged into the JSON body for additional context. */
export function mcpError(
  error: unknown,
  extra?: Record<string, unknown>,
): McpResult {
  const body: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/** Plain-text response (non-JSON). Use sparingly. */
export function mcpText(text: string): McpResult {
  return { content: [{ type: "text", text }] };
}
