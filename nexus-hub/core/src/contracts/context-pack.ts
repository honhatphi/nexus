// ─────────────────────────────────────────────────────────────
// Contract: ContextPack — the primary response object from
// nexus_build_context_pack. Contains a scored, budget-trimmed
// set of context items for the requesting agent.
// ─────────────────────────────────────────────────────────────

import type { TokenBudget } from "./token-budget.js";
import type { ArtifactRef } from "./artifact.js";

export type ContextMode = "ask" | "code" | "debug" | "review" | "migration";

export type ContextFreshness = "fresh" | "stale" | "unknown";

export type ContextItemType =
  | "repo_capsule"
  | "module_capsule"
  | "file_capsule"
  | "symbol_context"
  | "code_snippet"
  | "ledger"
  | "artifact_summary";

export interface ContextManifestItem {
  id: string;
  type: ContextItemType;
  source: string;
  reason: string;
  estimatedTokens: number;
  freshness: ContextFreshness;
  commit?: string;
}

export interface ContextSection {
  id: string;
  title: string;
  content: string;
  estimatedTokens: number;
}

export interface ContextPack {
  id: string;
  workspaceId: string;
  taskId?: string;
  task: string;
  mode: ContextMode;
  budget: TokenBudget;
  estimatedTokens: number;
  manifest: ContextManifestItem[];
  sections: ContextSection[];
  artifacts: ArtifactRef[];
  instructions: string[];
  createdAt: string;
}

// ── Build input ───────────────────────────────────────────────

export interface ContextPackPreferences {
  includeRawCode?: boolean;
  preferCapsules?: boolean;
  maxFiles?: number;
}

export interface BuildContextPackInput {
  workspaceId: string;
  task: string;
  mode?: ContextMode;
  taskId?: string;
  budget?: Partial<TokenBudget>;
  preferences?: ContextPackPreferences;
}
