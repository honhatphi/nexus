// ─────────────────────────────────────────────────────────────
// Port: ArtifactStore — large output storage abstraction.
// Fully implemented in PR 5 — Artifact Store.
// ─────────────────────────────────────────────────────────────

import type { ArtifactRef, ArtifactKind } from "../contracts/artifact.js";

export interface StoreArtifactInput {
  kind: ArtifactKind;
  content: string;
  taskId?: string;
  workspaceId?: string;
}

export interface ArtifactExcerpt {
  artifactId: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export interface ArtifactStore {
  store(input: StoreArtifactInput): Promise<ArtifactRef>;
  getSummary(artifactId: string): Promise<ArtifactRef | null>;
  getExcerpt(
    artifactId: string,
    startLine?: number,
    endLine?: number,
  ): Promise<ArtifactExcerpt | null>;
}
