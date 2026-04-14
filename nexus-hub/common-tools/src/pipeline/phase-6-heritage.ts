// ─────────────────────────────────────────────────────────────
// Phase 6 — Heritage Detection
// Analyzes class inheritance (extends) and interface implementation
// (implements) across parsed files. Upserts EXTENDS / IMPLEMENTS
// edges into the graph with confidence scoring.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
  HeritageEdge,
} from "./types.js";

// ── Heritage Extraction ──────────────────────────────────────

/**
 * Build a lookup map: className → file (service-relative path).
 * Used to resolve parent classes to files.
 */
function buildClassIndex(ctx: PipelineContext): Map<string, string> {
  const index = new Map<string, string>();
  for (const [, parseResult] of ctx.parseResults) {
    for (const cls of parseResult.classes) {
      index.set(cls.name, parseResult.file);
    }
  }
  return index;
}

/**
 * Determine if a base class name looks like an interface.
 * Heuristic: starts with "I" followed by uppercase (C#/TS convention),
 * or explicitly detected by language-specific patterns.
 */
function isLikelyInterface(baseName: string, language: string): boolean {
  if (language === "csharp" || language === "typescript") {
    // IFoo, IDisposable, IService...
    return /^I[A-Z]/.test(baseName);
  }
  return false;
}

// ── Phase Definition ─────────────────────────────────────────

export const heritagePhase: PipelinePhase = {
  name: "heritage-detection",
  order: 6,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let edgesCreated = 0;

    const classIndex = buildClassIndex(ctx);

    for (const [, parseResult] of ctx.parseResults) {
      for (const cls of parseResult.classes) {
        if (cls.bases.length === 0) continue;

        for (const baseName of cls.bases) {
          // Skip built-in / primitive bases
          if (baseName === "object" || baseName === "Object") continue;

          const kind: "extends" | "implements" = isLikelyInterface(
            baseName,
            parseResult.language,
          )
            ? "implements"
            : "extends";

          const parentFile = classIndex.get(baseName) ?? null;
          const confidence = parentFile ? 0.9 : 0.7;

          const edge: HeritageEdge = {
            childClass: cls.name,
            childFile: parseResult.file,
            parentClass: baseName,
            parentFile,
            kind,
            confidence,
          };
          ctx.heritageEdges.push(edge);

          try {
            // Ensure parent class node exists
            await deps.graph.write(
              `MERGE (child:Class {name: $childName, file: $childFile})
               MERGE (parent:Class {name: $parentName})
               ${parentFile ? "SET parent.file = $parentFile" : ""}
               MERGE (child)-[r:${kind === "extends" ? "EXTENDS" : "IMPLEMENTS"}]->(parent)
               SET r.confidence = $confidence,
                   r.updatedAt = timestamp()`,
              {
                childName: cls.name,
                childFile: parseResult.file,
                parentName: baseName,
                parentFile: parentFile ?? "",
                confidence,
              },
            );
            edgesCreated++;
          } catch (err) {
            errors.push(
              `${cls.name} → ${baseName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    return {
      phase: "heritage-detection",
      success: true,
      stats: {
        totalHeritageEdges: ctx.heritageEdges.length,
        extendsEdges: ctx.heritageEdges.filter((e) => e.kind === "extends")
          .length,
        implementsEdges: ctx.heritageEdges.filter(
          (e) => e.kind === "implements",
        ).length,
        resolvedParents: ctx.heritageEdges.filter((e) => e.parentFile !== null)
          .length,
        edgesCreated,
      },
      errors,
      durationMs: 0,
    };
  },
};
