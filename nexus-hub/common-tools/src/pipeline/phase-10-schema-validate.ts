// ─────────────────────────────────────────────────────────────
// Phase 10 — Schema Validation (Phase B3)
// Scans the graph after sync and flags nodes missing required
// canonical fields (schemaVersion, firstSeenAt, lastSeenAt, source).
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";
import { CANONICAL_NODE_LABELS, SCHEMA_VERSION } from "./schema-registry.js";

interface SchemaViolation {
  label: string;
  name: string;
  service: string;
  missingFields: string[];
}

export const schemaValidationPhase: PipelinePhase = {
  name: "schema-validate",
  order: 100,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const start = Date.now();
    const violations: SchemaViolation[] = [];

    for (const label of CANONICAL_NODE_LABELS) {
      const rows = await deps.graph.query(
        `MATCH (n:${label} {service: $service})
         WHERE n.schemaVersion IS NULL
            OR n.firstSeenAt IS NULL
            OR n.lastSeenAt IS NULL
            OR n.source IS NULL
         RETURN
           coalesce(n.name, n.path, '') AS name,
           n.schemaVersion AS sv,
           n.firstSeenAt   AS firstSeenAt,
           n.lastSeenAt    AS lastSeenAt,
           n.source        AS source
         LIMIT 100`,
        { service: ctx.serviceName },
      );

      for (const row of rows) {
        const missing: string[] = [];
        if (!row.sv) missing.push("schemaVersion");
        if (!row.firstSeenAt) missing.push("firstSeenAt");
        if (!row.lastSeenAt) missing.push("lastSeenAt");
        if (!row.source) missing.push("source");

        if (missing.length > 0) {
          violations.push({
            label,
            name: String(row.name ?? ""),
            service: ctx.serviceName,
            missingFields: missing,
          });
        }
      }
    }

    // Also verify schema version consistency
    const wrongVersion = await deps.graph.query(
      `MATCH (n {service: $service})
       WHERE n.schemaVersion IS NOT NULL AND n.schemaVersion <> $sv
       RETURN count(n) AS cnt`,
      { service: ctx.serviceName, sv: SCHEMA_VERSION },
    );
    const staleCount = Number(
      (wrongVersion[0]?.cnt as { low?: number })?.low ??
        wrongVersion[0]?.cnt ??
        0,
    );

    const stats = {
      labelsChecked: CANONICAL_NODE_LABELS.length,
      violationsFound: violations.length,
      staleSchemaVersion: staleCount,
    };

    if (violations.length > 0) {
      console.warn(
        `[schema-validate] ${violations.length} nodes missing required fields in service "${ctx.serviceName}". ` +
          `Run sync with force_update=true to backfill.`,
      );
    }

    return {
      phase: "schema-validate",
      success: true, // non-blocking — violations are warnings, not failures
      durationMs: Date.now() - start,
      stats,
      errors:
        violations.length > 0
          ? [`${violations.length} schema violation(s) — see stats for details`]
          : [],
    };
  },
};
