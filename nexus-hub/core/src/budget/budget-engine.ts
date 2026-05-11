// ─────────────────────────────────────────────────────────────
// Budget Engine (PR 8)
// TokenEstimator: estimates tokens from string content.
// BudgetPolicy: decides trim/block/pass based on policy.
// OutputLimiter: wraps tool output to respect token cap.
// ─────────────────────────────────────────────────────────────

import type { TokenBudget } from "../contracts/token-budget.js";
import type { ToolOutput } from "../contracts/tool-output.js";
import type { ArtifactRef } from "../contracts/artifact.js";
import type { BudgetEstimator } from "../ports/budget-estimator.js";

const CHARS_PER_TOKEN = 4;

// ── Token estimator ──────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateObjectTokens(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj) ?? "");
}

// ── Budget policy ────────────────────────────────────────────

export type BudgetAction = "pass" | "trim" | "offload";

export interface BudgetDecision {
  action: BudgetAction;
  estimatedTokens: number;
  /** Present when action === "trim": the max chars allowed */
  maxChars?: number;
}

export function evaluateBudget(
  content: string,
  budget: TokenBudget,
  maxOutputTokens = 1500,
): BudgetDecision {
  const estimated = estimateTokens(content);
  const allowed = Math.min(
    maxOutputTokens,
    budget.maxInputTokens - budget.reservedOutputTokens,
  );

  if (estimated <= allowed) {
    return { action: "pass", estimatedTokens: estimated };
  }
  if (estimated <= allowed * 10) {
    // Can trim inline
    return {
      action: "trim",
      estimatedTokens: estimated,
      maxChars: allowed * CHARS_PER_TOKEN,
    };
  }
  // Too large — should be stored as artifact
  return { action: "offload", estimatedTokens: estimated };
}

// ── Output limiter ────────────────────────────────────────────

export interface LimitedOutput<T> {
  toolOutput: ToolOutput<T>;
  offloaded: boolean;
}

/**
 * Wraps a tool result, trimming or flagging it according to token budget.
 * Callers can optionally pass a `storeArtifact` callback to offload large payloads.
 */
export async function limitOutput<T>(
  data: T,
  opts: {
    budget: TokenBudget;
    maxOutputTokens?: number;
    storeArtifact?: (content: string) => Promise<ArtifactRef>;
    omittedItems?: number;
  },
): Promise<LimitedOutput<T>> {
  const raw = JSON.stringify(data) ?? "";
  const decision = evaluateBudget(
    raw,
    opts.budget,
    opts.maxOutputTokens ?? 1500,
  );

  if (decision.action === "pass") {
    return {
      offloaded: false,
      toolOutput: {
        data,
        estimatedTokens: decision.estimatedTokens,
        truncated: false,
        omittedItems: opts.omittedItems,
      },
    };
  }

  if (decision.action === "trim" && decision.maxChars !== undefined) {
    const trimmed = raw.slice(0, decision.maxChars);
    let trimmedData: T;
    try {
      trimmedData = JSON.parse(trimmed + '"__truncated__"}') as T;
    } catch {
      trimmedData = (trimmed + "… [TRUNCATED]") as unknown as T;
    }
    return {
      offloaded: false,
      toolOutput: {
        data: trimmedData,
        estimatedTokens: estimateTokens(trimmed),
        truncated: true,
        omittedItems: opts.omittedItems,
      },
    };
  }

  // offload
  if (opts.storeArtifact) {
    const ref = await opts.storeArtifact(raw);
    return {
      offloaded: true,
      toolOutput: {
        data: {
          offloadedToArtifact: ref.id,
          summary: ref.summary,
        } as unknown as T,
        estimatedTokens: estimateTokens(ref.summary),
        truncated: false,
        artifactId: ref.id,
        omittedItems: opts.omittedItems,
      },
    };
  }

  // Fallback: trim heavily
  const maxChars = (opts.maxOutputTokens ?? 1500) * CHARS_PER_TOKEN;
  const trimmed = raw.slice(0, maxChars) + "… [OFFLOAD REQUIRED]";
  return {
    offloaded: false,
    toolOutput: {
      data: trimmed as unknown as T,
      estimatedTokens: estimateTokens(trimmed),
      truncated: true,
      omittedItems: opts.omittedItems,
    },
  };
}

// ── BudgetEstimator adapter ────────────────────────────────────

export class DefaultBudgetEstimator implements BudgetEstimator {
  estimate(content: string): number {
    return estimateTokens(content);
  }

  fits(content: string, budget: TokenBudget): boolean {
    const available = budget.maxInputTokens - budget.reservedOutputTokens;
    return this.estimate(content) <= available;
  }

  trim(
    content: string,
    maxTokens: number,
  ): { text: string; truncated: boolean } {
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (content.length <= maxChars) return { text: content, truncated: false };
    return {
      text: content.slice(0, maxChars) + "\n… [TRIMMED TO BUDGET]",
      truncated: true,
    };
  }
}
