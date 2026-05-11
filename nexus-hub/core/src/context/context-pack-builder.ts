// ─────────────────────────────────────────────────────────────
// ContextPackBuilder v1 — deterministic, no LLM.
// Strategy: Hybrid search KB → score → trim to budget → pack.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GraphStore } from "../ports/graph-store.js";
import type { Retriever } from "../ports/retriever.js";
import type { MemoryStore } from "../ports/memory-store.js";
import type {
  ContextPack,
  ContextManifestItem,
  ContextSection,
  ContextMode,
  BuildContextPackInput,
} from "../contracts/context-pack.js";
import type { TokenBudget } from "../contracts/token-budget.js";
import {
  nexusWorkspaceDir,
  defaultMaxInputTokens,
  defaultReservedTokens,
} from "../env.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_FILES = 8;
const INSTRUCTIONS: string[] = [
  "Use this context pack before reading additional files.",
  "Call nexus_get_code_snippet only for items listed in the manifest.",
  "Update ledger after each meaningful step with nexus_update_ledger.",
  "Store large outputs (logs, diffs) with nexus_store_artifact.",
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class ContextPackBuilder {
  constructor(
    private readonly graph: GraphStore,
    private readonly retriever: Retriever,
    private readonly memory?: MemoryStore,
  ) {}

  async build(input: BuildContextPackInput): Promise<ContextPack> {
    const budget: TokenBudget = {
      maxInputTokens: input.budget?.maxInputTokens ?? defaultMaxInputTokens(),
      reservedOutputTokens:
        input.budget?.reservedOutputTokens ?? defaultReservedTokens(),
    };

    const maxFiles = input.preferences?.maxFiles ?? DEFAULT_MAX_FILES;
    const mode: ContextMode = input.mode ?? "code";

    // ── Phase 1: Hybrid search for relevant symbols/files ────
    const searchResults = await this.retriever.search({
      query: input.task,
      topK: maxFiles * 2,
      mode: "hybrid",
    });

    // ── Phase 2: Pull file/symbol metadata from graph ────────
    const manifest: ContextManifestItem[] = [];
    let usedTokens = 0;

    for (const result of searchResults) {
      if (manifest.length >= maxFiles) break;

      const source = (result.metadata.file as string) ?? result.id;
      const service = (result.metadata.service as string) ?? input.workspaceId;
      const symbolName = result.metadata.name as string | undefined;

      const itemType = symbolName ? "symbol_context" : "file_capsule";
      const displayId = symbolName
        ? `symbol:${service}/${symbolName}`
        : `file:${source}`;

      const estimatedTokens = estimateTokens(result.document);

      if (usedTokens + estimatedTokens > budget.maxInputTokens) break;

      manifest.push({
        id: displayId,
        type: itemType,
        source,
        reason: `Score ${result.score.toFixed(3)} via ${result.source} search`,
        estimatedTokens,
        freshness: "unknown",
      });

      usedTokens += estimatedTokens;
    }

    // ── Phase 3: Add task ledger section if taskId given ─────
    const sections: ContextSection[] = [];

    if (input.taskId && this.memory) {
      const ledger = await this.memory.getTask(input.taskId);
      if (ledger) {
        const ledgerText = [
          `Objective: ${ledger.objective}`,
          `State: ${ledger.currentState}`,
          ledger.constraints.length
            ? `Constraints: ${ledger.constraints.join(", ")}`
            : "",
          ledger.touchedFiles.length
            ? `Touched: ${ledger.touchedFiles.join(", ")}`
            : "",
          ledger.nextActions.length
            ? `Next: ${ledger.nextActions.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        const tokenCount = estimateTokens(ledgerText);

        if (usedTokens + tokenCount <= budget.maxInputTokens) {
          sections.push({
            id: "ledger",
            title: "Task Ledger",
            content: ledgerText,
            estimatedTokens: tokenCount,
          });
          usedTokens += tokenCount;

          manifest.push({
            id: `ledger:${input.taskId}`,
            type: "ledger",
            source: "task-ledger",
            reason: "Active task state",
            estimatedTokens: tokenCount,
            freshness: "fresh",
          });
        }
      }
    }

    // ── Phase 4: Add repo capsule for high-level orientation ─
    const repoCapsule = await this.buildRepoCapsule(input.workspaceId);
    if (repoCapsule) {
      const tokenCount = estimateTokens(repoCapsule);
      if (usedTokens + tokenCount <= budget.maxInputTokens) {
        sections.push({
          id: "repo_capsule",
          title: "Repository Overview",
          content: repoCapsule,
          estimatedTokens: tokenCount,
        });

        manifest.unshift({
          id: `repo:${input.workspaceId}`,
          type: "repo_capsule",
          source: input.workspaceId,
          reason: "High-level service map",
          estimatedTokens: tokenCount,
          freshness: "unknown",
        });

        usedTokens += tokenCount;
      }
    }

    // ── Phase 5: Persist context pack locally ────────────────
    const packId = `ctxpack_${randomUUID().slice(0, 8)}`;
    await this.persist(input.workspaceId, packId, {
      id: packId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      task: input.task,
      mode,
      budget,
      estimatedTokens: usedTokens,
      manifest,
      sections,
      artifacts: [],
      instructions: INSTRUCTIONS,
      createdAt: new Date().toISOString(),
    });

    return {
      id: packId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      task: input.task,
      mode,
      budget,
      estimatedTokens: usedTokens,
      manifest,
      sections,
      artifacts: [],
      instructions: INSTRUCTIONS,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────

  private async buildRepoCapsule(workspaceId: string): Promise<string | null> {
    try {
      const services = await this.graph.query(
        `MATCH (s:Service)
         RETURN s.name AS name, s.language AS language,
                s.path AS path, s.lastSyncCommit AS commit
         LIMIT 10`,
      );

      if (services.length === 0) return null;

      const lines = [
        `Workspace: ${workspaceId}`,
        `Services (${services.length}):`,
        ...services.map(
          (s) =>
            `  - ${s.name}${s.language ? ` [${s.language}]` : ""}${s.path ? ` @ ${s.path}` : ""}`,
        ),
      ];
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  private async persist(
    workspaceId: string,
    packId: string,
    pack: ContextPack,
  ): Promise<void> {
    try {
      const dir = path.join(nexusWorkspaceDir(workspaceId), "context-packs");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `${packId}.json`),
        JSON.stringify(pack, null, 2),
      );
    } catch {
      // non-critical — persistence failure doesn't block tool response
    }
  }
}
