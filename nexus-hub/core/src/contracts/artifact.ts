// ─────────────────────────────────────────────────────────────
// Contract: Artifact — reference to a stored large output.
// Full content is kept on disk; only summary goes into prompts.
// ─────────────────────────────────────────────────────────────

export type ArtifactKind =
  | "test_log"
  | "diff"
  | "query_result"
  | "terminal_output"
  | "raw_context";

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  summary: string;
  path: string;
  sizeBytes: number;
  estimatedTokens?: number;
}
