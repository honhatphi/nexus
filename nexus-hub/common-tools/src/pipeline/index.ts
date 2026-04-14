// ─────────────────────────────────────────────────────────────
// PipelineEngine — Orchestrates sequential execution of phases.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PipelineReport,
  PhaseResult,
} from "./types.js";

export class PipelineEngine {
  private phases: PipelinePhase[] = [];

  register(phase: PipelinePhase): this {
    this.phases.push(phase);
    this.phases.sort((a, b) => a.order - b.order);
    return this;
  }

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PipelineReport> {
    const results: PhaseResult[] = [];

    for (const phase of this.phases) {
      const start = Date.now();
      try {
        const result = await phase.run(ctx, deps);
        result.durationMs = Date.now() - start;
        results.push(result);

        if (!result.success) {
          ctx.errors.push(
            ...result.errors.map((e) => ({
              phase: phase.name,
              message: e,
            })),
          );
        }
      } catch (err) {
        const durationMs = Date.now() - start;
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          phase: phase.name,
          success: false,
          stats: {},
          errors: [errorMsg],
          durationMs,
        });
        ctx.errors.push({ phase: phase.name, message: errorMsg });
      }
    }

    const totalDurationMs = Date.now() - ctx.startedAt;
    const languages = [...ctx.stats.languages];
    const allErrors = ctx.errors.map((e) => `[${e.phase}] ${e.message}`);

    const summary = [
      `Synced ${ctx.stats.totalSymbols} functions`,
      `${ctx.stats.totalClasses} classes`,
      `${ctx.stats.totalRelationships} call edges`,
      `${ctx.stats.totalInfraPatterns} infra patterns (${ctx.stats.totalInfraRels} infra edges)`,
      `${ctx.stats.totalDagNodes} DAG/task nodes (${ctx.stats.totalDagRels} DAG edges)`,
      `${ctx.stats.totalVectors} vectors`,
    ].join(", ");

    return {
      service: ctx.serviceName,
      path: ctx.servicePath,
      success: allErrors.length === 0,
      summary: `${summary}. Languages: ${languages.join(", ") || "none"}.`,
      phases: results,
      details: {
        filesScanned: ctx.stats.filesScanned,
        filesSkipped: ctx.stats.filesSkipped,
        totalSymbols: ctx.stats.totalSymbols,
        totalClasses: ctx.stats.totalClasses,
        totalRelationships: ctx.stats.totalRelationships,
        totalInfraPatterns: ctx.stats.totalInfraPatterns,
        totalInfraRels: ctx.stats.totalInfraRels,
        totalDagNodes: ctx.stats.totalDagNodes,
        totalDagRels: ctx.stats.totalDagRels,
        totalDagVectors: ctx.stats.totalDagVectors,
        totalVectors: ctx.stats.totalVectors,
        languages,
        forceUpdate: ctx.forceUpdate,
        gitCommitHash: ctx.gitCommitHash,
        durationMs: totalDurationMs,
      },
      errors: allErrors.length > 0 ? allErrors.slice(0, 20) : [],
    };
  }
}
