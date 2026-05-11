// ─────────────────────────────────────────────────────────────
// Contract: ToolOutput<T> — standard envelope for all MCP tool
// responses once the Budget Engine (PR 8) is active.
// ─────────────────────────────────────────────────────────────

export interface ToolOutput<T = unknown> {
  data: T;
  estimatedTokens: number;
  truncated: boolean;
  omittedItems?: number;
  artifactId?: string | null;
}
