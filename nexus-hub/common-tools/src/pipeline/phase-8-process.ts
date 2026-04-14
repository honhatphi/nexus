// ─────────────────────────────────────────────────────────────
// Phase 8 — Process Tracing (Execution Flows)
// Detects entry points (high outgoing CALLS, low incoming),
// traces BFS paths to terminal functions, and upserts
// Process nodes + STEP_IN_PROCESS edges into the graph.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────

const MAX_ENTRY_POINTS = 30;
const MAX_TRACE_DEPTH = 10;
const MAX_TRACES_PER_ENTRY = 4;

// ── Phase Definition ─────────────────────────────────────────

export const processTracingPhase: PipelinePhase = {
  name: "process-tracing",
  order: 8,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    // 1. Detect entry points — functions with many outgoing CALLS but few incoming
    const candidates = await deps.graph.query(
      `MATCH (f:Function {service: $service})
       OPTIONAL MATCH (f)-[:CALLS|ASYNC_TRIGGERS]->()
       WITH f, count(*) AS outgoing
       OPTIONAL MATCH ()-[:CALLS|ASYNC_TRIGGERS]->(f)
       WITH f, outgoing, count(*) AS incoming
       WHERE outgoing > 0 AND incoming <= 1
       RETURN f.name AS name, f.file AS file,
              outgoing, incoming,
              outgoing - incoming * 0.5 AS score
       ORDER BY score DESC
       LIMIT ${MAX_ENTRY_POINTS}`,
      { service: ctx.serviceName },
    );

    if (candidates.length === 0) {
      return {
        phase: "process-tracing",
        success: true,
        stats: { skipped: 1, reason_no_entry_points: 1 },
        errors: [],
        durationMs: 0,
      };
    }

    // 2. Clear old process data for this service
    try {
      await deps.graph.write(
        `MATCH (p:Process {service: $service})
         DETACH DELETE p`,
        { service: ctx.serviceName },
      );
    } catch {
      // Ignore if none exist
    }

    let processesCreated = 0;
    let stepsCreated = 0;

    // 3. For each entry point, trace execution paths via BFS
    for (const entry of candidates) {
      const entryName = entry.name as string;
      const entryFile = entry.file as string;

      try {
        // Find paths from entry to terminal functions (no further outgoing CALLS)
        const traces = await deps.graph.query(
          `MATCH path = (start:Function {name: $name, file: $file, service: $service})
                 -[:CALLS|ASYNC_TRIGGERS*1..${MAX_TRACE_DEPTH}]->(end:Function)
           WHERE NOT (end)-[:CALLS|ASYNC_TRIGGERS]->(:Function {service: $service})
             AND start <> end
           RETURN [n IN nodes(path) | n.name] AS steps,
                  [n IN nodes(path) | n.file] AS files,
                  length(path) AS depth
           ORDER BY depth DESC
           LIMIT ${MAX_TRACES_PER_ENTRY}`,
          {
            name: entryName,
            file: entryFile,
            service: ctx.serviceName,
          },
        );

        if (traces.length === 0) continue;

        // Use the longest trace as the representative process
        const longestTrace = traces[0];
        const steps = longestTrace.steps as string[];
        const processName = `${ctx.serviceName}::${entryName}`;

        // Upsert Process node
        await deps.graph.write(
          `MERGE (p:Process {name: $processName, service: $service})
           SET p.entryPoint = $entryFunc,
               p.entryFile = $entryFile,
               p.stepCount = $stepCount,
               p.traceCount = $traceCount,
               p.updatedAt = timestamp()`,
          {
            processName,
            service: ctx.serviceName,
            entryFunc: entryName,
            entryFile,
            stepCount: steps.length,
            traceCount: traces.length,
          },
        );
        processesCreated++;

        // Upsert STEP_IN_PROCESS edges
        for (let i = 0; i < steps.length; i++) {
          await deps.graph.write(
            `MATCH (f:Function {name: $funcName, service: $service})
             MATCH (p:Process {name: $processName, service: $service})
             MERGE (f)-[r:STEP_IN_PROCESS]->(p)
             SET r.step = $stepOrder`,
            {
              funcName: steps[i],
              service: ctx.serviceName,
              processName,
              stepOrder: i,
            },
          );
          stepsCreated++;
        }

        // Store in context
        ctx.processes.push({
          name: processName,
          entryPoint: entryName,
          steps,
        });
      } catch (err) {
        errors.push(
          `Trace ${entryName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phase: "process-tracing",
      success: true,
      stats: {
        entryPointCandidates: candidates.length,
        processesCreated,
        stepsCreated,
      },
      errors,
      durationMs: 0,
    };
  },
};
