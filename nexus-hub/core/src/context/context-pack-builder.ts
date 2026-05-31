// ─────────────────────────────────────────────────────────────
// ContextPackBuilder v1 — deterministic, no LLM.
// Strategy: Hybrid search KB → score → trim to budget → pack.
// ─────────────────────────────────────────────────────────────

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
import { defaultMaxInputTokens, defaultReservedTokens } from "../env.js";
import { ContextPackStore } from "./context-pack-store.js";
import { ContextSectionRenderer } from "./context-section-renderer.js";
import { estimateTokens } from "../budget/token-estimator.js";

const DEFAULT_MAX_FILES = 8;

// Instructions injected into every context pack.
// Keep these authoritative — the agent MUST follow them.
const INSTRUCTIONS: string[] = [
  "RULE: Do NOT read files directly using file read tools. Use nexus_get_code_snippet for items in the manifest only.",
  "RULE: Do NOT search the filesystem with grep/find/rg. The KB is your only source of code context.",
  "If this pack has status=kb_empty, run nexus_sync_current_repo first and retry nexus_build_context_pack. Do NOT proceed.",
  "Call nexus_get_code_snippet only for items listed in the manifest (guarded by manifest ID).",
  "Update ledger after each meaningful step with nexus_update_ledger.",
  "Store large outputs (logs, diffs) with nexus_store_artifact.",
];

// Instructions returned when KB has no data for the workspace.
// These BLOCK the agent from doing anything until the repo is synced.
const KB_EMPTY_INSTRUCTIONS: string[] = [
  "STOP. The Knowledge Base has NO data for this workspace.",
  "REQUIRED: Call nexus_sync_current_repo with the repo path to index it first.",
  "After sync job completes (poll nexus_sync_status), call nexus_build_context_pack again.",
  "DO NOT read files, grep, or search the filesystem. Wait for KB to be populated.",
  "DO NOT attempt to answer the task until this context pack returns manifest items.",
];

export class ContextPackBuilder {
  private readonly store = new ContextPackStore();
  private readonly renderer = new ContextSectionRenderer();

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

    // ── Phase 3: Enrich file_capsule items with actual content ─
    // Delegate to ContextSectionRenderer.
    const { sections, tokensUsed: snippetTokens } =
      await this.renderer.buildSnippetSections(
        manifest,
        budget.maxInputTokens - usedTokens,
      );
    usedTokens += snippetTokens;

    // ── Phase 4: Add task ledger section if taskId given ─────

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

    // ── Phase 5: Add repo capsule for high-level orientation ─
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

    // ── Phase 6: Detect KB empty state ───────────────────────
    // manifest contains only ledger items if search+repoCapsule both returned
    // nothing — the KB has no vectors/graph nodes for this workspace yet.
    // Return blocking instructions so the agent stops and syncs first.
    const nonLedgerItems = manifest.filter((m) => m.type !== "ledger");
    const kbEmpty = nonLedgerItems.length === 0;

    const finalInstructions = kbEmpty ? KB_EMPTY_INSTRUCTIONS : INSTRUCTIONS;

    // ── Phase 7: Persist context pack locally ────────────────
    const packId = `ctxpack_${randomUUID().slice(0, 8)}`;
    const pack: ContextPack = {
      id: packId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      task: input.task,
      mode,
      budget,
      estimatedTokens: usedTokens,
      manifest,
      sections: kbEmpty
        ? [
            {
              id: "kb_empty_warning",
              title: "⚠️ KB Empty — Sync Required",
              content: [
                `The Knowledge Base has no indexed data for workspace: ${input.workspaceId}`,
                ``,
                `To fix:`,
                `1. Call nexus_sync_current_repo with the repo path (e.g. cwd: "/path/to/repo")`,
                `2. Poll nexus_sync_status with the returned jobId until status=done`,
                `3. Call nexus_build_context_pack again with the same task`,
                ``,
                `Do NOT read source files directly while waiting.`,
              ].join("\n"),
              estimatedTokens: 60,
            },
            ...sections,
          ]
        : sections,
      artifacts: [],
      instructions: finalInstructions,
      createdAt: new Date().toISOString(),
    };
    await this.store.save(input.workspaceId, pack);

    return pack;
  }

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
}
