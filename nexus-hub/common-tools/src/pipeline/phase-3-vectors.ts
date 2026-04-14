// ─────────────────────────────────────────────────────────────
// Phase 3 — Vector Upsert
// Upserts symbol, class, and DAG documents into ChromaDB.
// ─────────────────────────────────────────────────────────────

import type { FunctionInfo, ParseResult } from "../types.js";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
  VectorClient,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────

function buildFunctionSignature(fn: FunctionInfo): string {
  const params = fn.parameters
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(", ");
  const ret = fn.returnType ? ` → ${fn.returnType}` : "";
  return `${fn.name}(${params})${ret}`;
}

// ── Vector Upsert: Functions + Classes ───────────────────────

async function upsertToVector(
  vectors: VectorClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<number> {
  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Record<string, string | number | boolean>[] = [];

  // Build function → infra mapping
  const fnInfraMap = new Map<string, string[]>();
  for (const ip of parseResult.infraPatterns) {
    const ownerFn = parseResult.functions.find(
      (fn) => fn.startLine <= ip.line && ip.line <= fn.endLine,
    );
    if (ownerFn) {
      const list = fnInfraMap.get(ownerFn.name) ?? [];
      list.push(ip.detail);
      fnInfraMap.set(ownerFn.name, list);
    }
  }

  for (const fn of parseResult.functions) {
    const id = `${serviceName}::${parseResult.file}::${fn.name}::L${fn.startLine}`;
    const signature = buildFunctionSignature(fn);
    const callsList = fn.calls.map((c) => c.name).join(", ");
    const infraList = fnInfraMap.get(fn.name)?.join("; ") ?? "";
    const doc = [
      `[${parseResult.language}] ${signature}`,
      `File: ${parseResult.file}`,
      `Lines: ${fn.startLine}-${fn.endLine}`,
      callsList ? `Calls: ${callsList}` : "",
      infraList ? `Infrastructure: ${infraList}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    ids.push(id);
    documents.push(doc);
    metadatas.push({
      service: serviceName,
      file: parseResult.file,
      language: parseResult.language,
      functionName: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      hasInfra: infraList.length > 0,
    });
  }

  // Classes
  for (const cls of parseResult.classes) {
    const id = `${serviceName}::${parseResult.file}::class::${cls.name}::L${cls.startLine}`;
    const doc = [
      `[${parseResult.language}] class ${cls.name}`,
      cls.bases.length > 0 ? `Inherits: ${cls.bases.join(", ")}` : "",
      `File: ${parseResult.file}`,
      `Lines: ${cls.startLine}-${cls.endLine}`,
      cls.methods.length > 0 ? `Methods: ${cls.methods.join(", ")}` : "",
      cls.docstring ? `Doc: ${cls.docstring.slice(0, 200)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    ids.push(id);
    documents.push(doc);
    metadatas.push({
      service: serviceName,
      file: parseResult.file,
      language: parseResult.language,
      className: cls.name,
      bases: cls.bases.join(","),
      startLine: cls.startLine,
      endLine: cls.endLine,
    });
  }

  if (ids.length === 0) return 0;
  await vectors.upsert(ids, documents, metadatas);
  return ids.length;
}

// ── Vector Upsert: DAGs ──────────────────────────────────────

async function upsertDagsToVector(
  vectors: VectorClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<number> {
  if (parseResult.dags.length === 0) return 0;

  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Record<string, string | number | boolean>[] = [];

  for (const dag of parseResult.dags) {
    const dagId = `${serviceName}::${parseResult.file}::dag::${dag.name}`;
    const taskList = dag.tasks.map((t) => t.name).join(", ");
    const dagDoc = [
      `[yaml] DAG: ${dag.name}`,
      `File: ${parseResult.file}`,
      dag.description ? `Description: ${dag.description}` : "",
      dag.scheduleInterval ? `Schedule: ${dag.scheduleInterval}` : "",
      `Tasks: ${taskList}`,
    ]
      .filter(Boolean)
      .join("\n");

    ids.push(dagId);
    documents.push(dagDoc);
    metadatas.push({
      service: serviceName,
      file: parseResult.file,
      language: "yaml",
      functionName: dag.name,
      kind: "dag",
      startLine: 0,
      endLine: 0,
    });

    for (const task of dag.tasks) {
      const taskId = `${serviceName}::${parseResult.file}::task::${task.name}`;
      const deps =
        task.dependencies.length > 0
          ? `Dependencies: ${task.dependencies.join(", ")}`
          : "";
      const operatorShort = task.operator.split(".").pop() ?? task.operator;

      const taskDoc = [
        `[yaml] Task: ${task.name} (${operatorShort})`,
        `DAG: ${dag.name}`,
        `File: ${parseResult.file}`,
        `Operator: ${task.operator}`,
        task.pythonCallableName ? `Calls: ${task.pythonCallableName}` : "",
        task.pythonCallableFile
          ? `Callable file: ${task.pythonCallableFile}`
          : "",
        task.bashCommand ? `Bash command: ${task.bashCommand}` : "",
        task.sql ? `SQL: ${task.sql}` : "",
        task.postgresConnId
          ? `Postgres connection: ${task.postgresConnId}`
          : "",
        deps,
        task.opKwargs ? `Op kwargs: ${JSON.stringify(task.opKwargs)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      ids.push(taskId);
      documents.push(taskDoc);
      metadatas.push({
        service: serviceName,
        file: parseResult.file,
        language: "yaml",
        functionName: task.name,
        kind: "task",
        startLine: 0,
        endLine: 0,
        hasInfra: !!(task.postgresConnId || task.bashCommand),
      });
    }
  }

  await vectors.upsert(ids, documents, metadatas);
  return ids.length;
}

// ── Phase Definition ─────────────────────────────────────────

export const vectorUpsertPhase: PipelinePhase = {
  name: "vector-upsert",
  order: 3,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    for (const [, parseResult] of ctx.parseResults) {
      try {
        // DAG vectors
        if (parseResult.dags.length > 0) {
          const dagVectorCount = await upsertDagsToVector(
            deps.vectors,
            ctx.serviceName,
            parseResult,
          );
          ctx.stats.totalDagVectors += dagVectorCount;
        }

        // Function + class vectors
        const vectorCount = await upsertToVector(
          deps.vectors,
          ctx.serviceName,
          parseResult,
        );
        ctx.stats.totalVectors += vectorCount;
      } catch (err) {
        errors.push(
          `${parseResult.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phase: "vector-upsert",
      success: errors.length === 0,
      stats: {
        vectors: ctx.stats.totalVectors,
        dagVectors: ctx.stats.totalDagVectors,
      },
      errors,
      durationMs: 0,
    };
  },
};
