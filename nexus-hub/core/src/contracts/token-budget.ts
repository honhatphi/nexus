// ─────────────────────────────────────────────────────────────
// Contract: TokenBudget — token allocation for context packs.
// ─────────────────────────────────────────────────────────────

export interface TokenBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
}

export const DEFAULT_BUDGET: TokenBudget = {
  maxInputTokens: 12_000,
  reservedOutputTokens: 3_000,
};

export const MAX_BUDGET: TokenBudget = {
  maxInputTokens: 24_000,
  reservedOutputTokens: 4_000,
};
