// ─────────────────────────────────────────────────────────────
// ArtifactService — orchestrates storage and retrieval of large
// outputs. Used by MCP tool handlers for nexus_store_artifact,
// nexus_get_artifact_summary, nexus_get_artifact_excerpt.
// ─────────────────────────────────────────────────────────────

import type { ArtifactRef, ArtifactKind } from "../contracts/artifact.js";
import type {
  ArtifactStore,
  StoreArtifactInput,
  ArtifactExcerpt,
} from "../ports/artifact-store.js";
import { CHARS_PER_TOKEN } from "../budget/token-estimator.js";

const DEFAULT_MAX_TOKENS = 1_500;

export interface StoreResult {
  artifactId: string;
  kind: ArtifactKind;
  summary: string;
  sizeBytes: number;
  estimatedTokens: number;
  instruction: string;
}

export class ArtifactService {
  constructor(private readonly store: ArtifactStore) {}

  async storeArtifact(input: StoreArtifactInput): Promise<StoreResult> {
    const ref = await this.store.store(input);
    return {
      artifactId: ref.id,
      kind: ref.kind,
      summary: ref.summary,
      sizeBytes: ref.sizeBytes,
      estimatedTokens: ref.estimatedTokens ?? 0,
      instruction: `Use nexus_get_artifact_excerpt with artifactId="${ref.id}" to view specific lines.`,
    };
  }

  async getArtifactSummary(artifactId: string): Promise<ArtifactRef | null> {
    return this.store.getSummary(artifactId);
  }

  async getArtifactExcerpt(
    artifactId: string,
    startLine?: number,
    endLine?: number,
    maxTokens = DEFAULT_MAX_TOKENS,
  ): Promise<
    (ArtifactExcerpt & { truncated: boolean; instruction?: string }) | null
  > {
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    const excerpt = await this.store.getExcerpt(artifactId, startLine, endLine);
    if (!excerpt) return null;

    if (excerpt.content.length <= maxChars) {
      return { ...excerpt, truncated: false };
    }

    const truncated = excerpt.content.slice(0, maxChars);
    const truncatedLines = truncated.split("\n").length;

    return {
      ...excerpt,
      content: truncated,
      endLine: excerpt.startLine + truncatedLines - 1,
      truncated: true,
      instruction: `Output truncated at ${maxTokens} tokens. Request next lines starting from line ${excerpt.startLine + truncatedLines}.`,
    };
  }
}
