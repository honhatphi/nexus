// ─────────────────────────────────────────────────────────────
// Port: BudgetEstimator — token counting and budget enforcement.
// Fully implemented in PR 8 — Budget Engine.
// ─────────────────────────────────────────────────────────────

import type { TokenBudget } from "../contracts/token-budget.js";

export interface BudgetEstimator {
  estimate(text: string): number;
  fits(text: string, budget: TokenBudget): boolean;
  trim(text: string, maxTokens: number): { text: string; truncated: boolean };
}
