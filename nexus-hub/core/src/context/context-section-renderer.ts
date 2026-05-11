// ─────────────────────────────────────────────────────────────
// ContextSectionRenderer — reads file snippets and builds
// ContextSection objects for a context pack.
// Behaviour preserved from ContextPackBuilder v1:
//   - max 80 lines per file
//   - budget-gated (remaining chars)
//   - NEXUS_WORKSPACE_ROOT env fallback for relative paths
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import type {
  ContextManifestItem,
  ContextSection,
} from "../contracts/context-pack.js";
import { SourceResolver } from "./source-resolver.js";
import { CHARS_PER_TOKEN, estimateTokens } from "../budget/token-estimator.js";

const MAX_SNIPPET_LINES = 80;

export class ContextSectionRenderer {
  private readonly resolver = new SourceResolver();

  /**
   * Attempt to read up to `maxLines` lines from a file.
   * Candidate paths are resolved via SourceResolver (absolute-first,
   * then NEXUS_WORKSPACE_ROOT, then cwd).
   */
  async readFileSnippet(
    filePath: string,
    maxLines: number,
    budgetChars: number,
  ): Promise<string | null> {
    const candidates = this.resolver.resolveCandidates(filePath);
    for (const p of candidates) {
      try {
        const content = await fs.readFile(p, "utf8");
        const lines = content.split("\n");
        let result = "";
        for (const line of lines.slice(0, maxLines)) {
          const next = result + line + "\n";
          if (next.length > budgetChars) break;
          result = next;
        }
        return result || null;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  /**
   * Build snippet sections for all eligible manifest items,
   * respecting the remaining token budget.
   *
   * Returns the new sections and the number of tokens consumed.
   */
  async buildSnippetSections(
    manifest: ContextManifestItem[],
    budgetTokens: number,
  ): Promise<{ sections: ContextSection[]; tokensUsed: number }> {
    const sections: ContextSection[] = [];
    let tokensUsed = 0;

    for (const item of manifest) {
      if (tokensUsed >= budgetTokens) break;
      if (item.type !== "file_capsule" && item.type !== "symbol_context")
        continue;
      if (!item.source || item.source.startsWith("http")) continue;

      const remainingChars = (budgetTokens - tokensUsed) * CHARS_PER_TOKEN;
      const snippet = await this.readFileSnippet(
        item.source,
        MAX_SNIPPET_LINES,
        remainingChars,
      );
      if (!snippet) continue;

      const tokenCount = estimateTokens(snippet);
      if (tokensUsed + tokenCount > budgetTokens) break;

      sections.push({
        id: `snippet:${item.id}`,
        title: `File: ${item.source}`,
        content: snippet,
        estimatedTokens: tokenCount,
      });
      // Update manifest item to reflect actual content size
      item.estimatedTokens = tokenCount;
      tokensUsed += tokenCount;
    }

    return { sections, tokensUsed };
  }
}
