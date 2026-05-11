// ─────────────────────────────────────────────────────────────
// Token Estimator — single source of truth for token math.
// All token estimation across the codebase should import from
// here rather than redeclaring CHARS_PER_TOKEN locally.
// ─────────────────────────────────────────────────────────────

/** Approximate bytes-per-token ratio for GPT-family models. */
export const CHARS_PER_TOKEN = 4;

/** Estimate the token count for a string using the char ratio. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert a token budget to the equivalent max character count. */
export function maxCharsForTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}
