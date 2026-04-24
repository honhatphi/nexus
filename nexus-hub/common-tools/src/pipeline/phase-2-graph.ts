// ─────────────────────────────────────────────────────────────
// Phase 2 — Graph Upsert
// Upserts parsed symbols, classes, infrastructure patterns,
// and DAGs into the graph database.
//
// Includes Phase 2 (confidence-based edges) from migration plan.
// ─────────────────────────────────────────────────────────────

import type { ParseResult, FunctionInfo, SymbolInfo } from "../types.js";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
  GraphClient,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────

function buildSignature(sym: SymbolInfo): string {
  const params = sym.params
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(", ");
  const ret = sym.returnType ? ` → ${sym.returnType}` : "";
  return `${sym.name}(${params})${ret}`;
}

function buildFunctionSignature(fn: FunctionInfo): string {
  const params = fn.parameters
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(", ");
  const ret = fn.returnType ? ` → ${fn.returnType}` : "";
  return `${fn.name}(${params})${ret}`;
}

// ── Confidence Scoring ───────────────────────────────────────

function computeCallConfidence(
  callerFile: string,
  calleeName: string,
  parseResult: ParseResult,
): { confidence: number; reason: string } {
  // Same-file call — check if callee is defined in this file
  const sameFile = parseResult.symbols.some((s) => s.name === calleeName);
  if (sameFile) {
    return { confidence: 0.95, reason: "same_file" };
  }

  // Method call (contains '.') — likely a resolved target
  if (calleeName.includes(".")) {
    return { confidence: 0.85, reason: "method_call" };
  }

  // Default — name-match only
  return { confidence: 0.7, reason: "name_match" };
}

// ── Graph Upsert: Symbols ────────────────────────────────────

async function upsertSymbolsToGraph(
  graph: GraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ nodesUpserted: number; relsCreated: number }> {
  let nodesUpserted = 0;
  let relsCreated = 0;

  // Service node
  await graph.write(`MERGE (s:Service {name: $service})`, {
    service: serviceName,
  });

  // File node + edge
  await graph.write(
    `MERGE (fi:File {path: $file})
     MERGE (s:Service {name: $service})
     MERGE (fi)-[:BELONGS_TO]->(s)
     SET fi.language = $language, fi.updatedAt = timestamp()`,
    {
      file: parseResult.file,
      service: serviceName,
      language: parseResult.language,
    },
  );

  for (const sym of parseResult.symbols) {
    const signature = buildSignature(sym);

    await graph.write(
      `MERGE (f:Function {name: $name, file: $file, service: $service})
       SET f.kind       = $kind,
           f.language   = $language,
           f.returnType = $returnType,
           f.startLine  = $startLine,
           f.endLine    = $endLine,
           f.signature  = $signature,
           f.docstring  = $docstring,
           f.updatedAt  = timestamp()
       WITH f
       MERGE (fi:File {path: $file})
       MERGE (f)-[:DEFINED_IN]->(fi)`,
      {
        name: sym.name,
        file: parseResult.file,
        service: serviceName,
        kind: sym.kind,
        language: parseResult.language,
        returnType: sym.returnType ?? "",
        startLine: sym.startLine,
        endLine: sym.endLine,
        signature,
        docstring: sym.docstring ?? "",
      },
    );
    nodesUpserted++;

    // CALLS edges with confidence
    for (const call of sym.calls) {
      const { confidence, reason } = computeCallConfidence(
        parseResult.file,
        call.name,
        parseResult,
      );

      await graph.write(
        `MERGE (caller:Function {name: $callerName, file: $callerFile, service: $service})
         MERGE (callee:Function {name: $calleeName})
         MERGE (caller)-[r:CALLS]->(callee)
         SET r.line = $line,
             r.confidence = $confidence,
             r.reason = $reason,
             r.updatedAt = timestamp()`,
        {
          callerName: sym.name,
          callerFile: parseResult.file,
          service: serviceName,
          calleeName: call.name,
          line: call.line,
          confidence,
          reason,
        },
      );
      relsCreated++;
    }
  }

  return { nodesUpserted, relsCreated };
}

// ── Graph Upsert: Classes & Infrastructure ───────────────────

const INFRA_LABELS: Record<string, string> = {
  kafka_produce: "KafkaTopic",
  kafka_consume: "KafkaTopic",
  db_postgres: "Database",
  db_mongo: "Database",
  db_elasticsearch: "Database",
  http_request: "HTTPEndpoint",
  http_route_define: "APIRoute",
  grpc_call: "GRPCEndpoint",
  grpc_serve: "GRPCEndpoint",
};

const INFRA_EDGE: Record<string, string> = {
  kafka_produce: "PRODUCES_TO",
  kafka_consume: "CONSUMES_FROM",
  db_postgres: "CONNECTS_TO",
  db_mongo: "CONNECTS_TO",
  db_elasticsearch: "CONNECTS_TO",
  http_request: "HTTP_CALL",
  http_route_define: "EXPOSES",
  grpc_call: "GRPC_CALL",
  grpc_serve: "GRPC_HANDLES",
};

const DB_TYPE: Record<string, string> = {
  db_postgres: "postgresql",
  db_mongo: "mongodb",
  db_elasticsearch: "elasticsearch",
};

async function upsertInfraToGraph(
  graph: GraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ infraNodes: number; infraRels: number }> {
  let infraNodes = 0;
  let infraRels = 0;

  // Classes + inheritance
  for (const cls of parseResult.classes) {
    await graph.write(
      `MERGE (c:Class {name: $name, file: $file, service: $service})
       SET c.startLine = $startLine, c.endLine = $endLine,
           c.docstring = $docstring, c.updatedAt = timestamp()
       WITH c
       MERGE (fi:File {path: $file})
       MERGE (c)-[:DEFINED_IN]->(fi)`,
      {
        name: cls.name,
        file: parseResult.file,
        service: serviceName,
        startLine: cls.startLine,
        endLine: cls.endLine,
        docstring: cls.docstring ?? "",
      },
    );
    infraNodes++;

    for (const base of cls.bases) {
      await graph.write(
        `MERGE (child:Class {name: $childName, file: $file, service: $service})
         MERGE (parent:Class {name: $baseName})
         MERGE (child)-[r:INHERITS]->(parent)
         SET r.confidence = $confidence, r.updatedAt = timestamp()`,
        {
          childName: cls.name,
          file: parseResult.file,
          service: serviceName,
          baseName: base,
          confidence: 0.9,
        },
      );
      infraRels++;
    }

    for (const method of cls.methods) {
      await graph.write(
        `MATCH (f:Function {name: $methodName, file: $file, service: $service})
         MERGE (c:Class {name: $className, file: $file, service: $service})
         MERGE (f)-[r:METHOD_OF]->(c)
         SET r.updatedAt = timestamp()`,
        {
          methodName: method,
          file: parseResult.file,
          service: serviceName,
          className: cls.name,
        },
      );
      infraRels++;
    }
  }

  // Infrastructure patterns
  for (const ip of parseResult.infraPatterns) {
    if (ip.kind === "class_inherit") continue;

    const label = INFRA_LABELS[ip.kind];
    const edge = INFRA_EDGE[ip.kind];
    if (!label || !edge) continue;

    const ownerFn = parseResult.functions.find(
      (fn) => fn.startLine <= ip.line && ip.line <= fn.endLine,
    );

    const dbType = DB_TYPE[ip.kind] ?? "";

    // APIRoute nodes carry path + method + service as identity/properties
    if (ip.kind === "http_route_define") {
      const method = ip.metadata?.method ?? "GET";
      await graph.write(
        `MERGE (t:APIRoute {path: $path, method: $method, service: $service})
         SET t.name = $path,
             t.operationId = $operationId,
             t.source = $source,
             t.updatedAt = timestamp()`,
        {
          path: ip.target,
          method,
          service: serviceName,
          operationId: ip.metadata?.operationId ?? "",
          source: ip.metadata?.source ?? "code",
        },
      );
    } else if (ip.kind === "grpc_call" || ip.kind === "grpc_serve") {
      // GRPCEndpoint: identity by name + service (the gRPC service name, not microservice)
      const grpcService = ip.metadata?.service ?? ip.target;
      await graph.write(
        `MERGE (t:GRPCEndpoint {name: $name, service: $grpcService})
         SET t.updatedAt = timestamp()`,
        { name: ip.target, grpcService },
      );
    } else {
      await graph.write(
        `MERGE (t:${label} {name: $target})
         SET t.type = $dbType, t.updatedAt = timestamp()`,
        { target: ip.target, dbType },
      );
    }
    infraNodes++;

    if (ownerFn) {
      const metaStr = ip.metadata ? JSON.stringify(ip.metadata) : "";
      if (ip.kind === "http_route_define") {
        const method = ip.metadata?.method ?? "GET";
        await graph.write(
          `MATCH (f:Function {name: $fnName, file: $file, service: $service})
           MATCH (t:APIRoute {path: $path, method: $method, service: $service})
           MERGE (f)-[r:EXPOSES]->(t)
           SET r.line = $line, r.updatedAt = timestamp()`,
          {
            fnName: ownerFn.name,
            file: parseResult.file,
            service: serviceName,
            path: ip.target,
            method,
            line: ip.line,
          },
        );
      } else if (ip.kind === "grpc_call" || ip.kind === "grpc_serve") {
        const grpcService = ip.metadata?.service ?? ip.target;
        const grpcEdge = ip.kind === "grpc_call" ? "GRPC_CALL" : "GRPC_HANDLES";
        await graph.write(
          `MATCH (f:Function {name: $fnName, file: $file, service: $service})
           MATCH (t:GRPCEndpoint {name: $name, service: $grpcService})
           MERGE (f)-[r:${grpcEdge}]->(t)
           SET r.line = $line, r.updatedAt = timestamp()`,
          {
            fnName: ownerFn.name,
            file: parseResult.file,
            service: serviceName,
            name: ip.target,
            grpcService,
            line: ip.line,
          },
        );
      } else {
        await graph.write(
          `MATCH (f:Function {name: $fnName, file: $file, service: $service})
           MATCH (t:${label} {name: $target})
           MERGE (f)-[r:${edge}]->(t)
           SET r.line = $line, r.detail = $detail, r.metadata = $metadata,
               r.updatedAt = timestamp()`,
          {
            fnName: ownerFn.name,
            file: parseResult.file,
            service: serviceName,
            target: ip.target,
            line: ip.line,
            detail: ip.detail,
            metadata: metaStr,
          },
        );
      }
      infraRels++;
    } else {
      await graph.write(
        `MATCH (fi:File {path: $file})
         MATCH (t:${label} {name: $target})
         MERGE (fi)-[r:${edge}]->(t)
         SET r.line = $line, r.detail = $detail, r.updatedAt = timestamp()`,
        {
          file: parseResult.file,
          target: ip.target,
          line: ip.line,
          detail: ip.detail,
        },
      );
      infraRels++;
    }
  }

  return { infraNodes, infraRels };
}

// ── Graph Upsert: DAGs ───────────────────────────────────────

async function upsertDagsToGraph(
  graph: GraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ nodesUpserted: number; relsCreated: number }> {
  let nodesUpserted = 0;
  let relsCreated = 0;

  for (const dag of parseResult.dags) {
    await graph.write(
      `MERGE (d:DAG {name: $dagName, service: $service})
       SET d.file            = $file,
           d.scheduleInterval = $schedule,
           d.description     = $description,
           d.owner           = $owner,
           d.concurrency     = $concurrency,
           d.updatedAt       = timestamp()
       WITH d
       MERGE (s:Service {name: $service})
       MERGE (s)-[:CONTAINS]->(d)`,
      {
        dagName: dag.name,
        service: serviceName,
        file: parseResult.file,
        schedule: dag.scheduleInterval ?? "",
        description: dag.description ?? "",
        owner: dag.owner ?? "",
        concurrency: dag.concurrency ?? 0,
      },
    );
    nodesUpserted++;

    // File node
    await graph.write(
      `MERGE (fi:File {path: $file})
       MERGE (s:Service {name: $service})
       MERGE (fi)-[:BELONGS_TO]->(s)
       SET fi.language = $language, fi.updatedAt = timestamp()`,
      {
        file: parseResult.file,
        service: serviceName,
        language: parseResult.language,
      },
    );

    for (const task of dag.tasks) {
      await graph.write(
        `MERGE (t:Task {name: $taskName, dag: $dagName, service: $service})
         SET t.operator              = $operator,
             t.pythonCallableFile    = $pyFile,
             t.pythonCallableName    = $pyName,
             t.bashCommand           = $bashCmd,
             t.sql                   = $sql,
             t.postgresConnId        = $pgConnId,
             t.retries               = $retries,
             t.executionTimeoutSecs  = $timeout,
             t.file                  = $file,
             t.updatedAt             = timestamp()
         WITH t
         MERGE (d:DAG {name: $dagName, service: $service})
         MERGE (t)-[:BELONGS_TO]->(d)`,
        {
          taskName: task.name,
          dagName: dag.name,
          service: serviceName,
          operator: task.operator,
          pyFile: task.pythonCallableFile ?? "",
          pyName: task.pythonCallableName ?? "",
          bashCmd: task.bashCommand ?? "",
          sql: task.sql ?? "",
          pgConnId: task.postgresConnId ?? "",
          retries: task.retries ?? 0,
          timeout: task.executionTimeoutSecs ?? 0,
          file: parseResult.file,
        },
      );
      nodesUpserted++;

      for (const dep of task.dependencies) {
        await graph.write(
          `MERGE (t:Task {name: $taskName, dag: $dagName, service: $service})
           MERGE (upstream:Task {name: $depName, dag: $dagName, service: $service})
           MERGE (t)-[r:DEPENDS_ON]->(upstream)
           SET r.updatedAt = timestamp()`,
          {
            taskName: task.name,
            dagName: dag.name,
            service: serviceName,
            depName: dep,
          },
        );
        relsCreated++;
      }

      if (task.pythonCallableName) {
        await graph.write(
          `MERGE (t:Task {name: $taskName, dag: $dagName, service: $service})
           MERGE (f:Function {name: $funcName})
           MERGE (t)-[r:INVOKES]->(f)
           SET r.callableFile = $pyFile, r.updatedAt = timestamp()`,
          {
            taskName: task.name,
            dagName: dag.name,
            service: serviceName,
            funcName: task.pythonCallableName,
            pyFile: task.pythonCallableFile ?? "",
          },
        );
        relsCreated++;
      }
    }
  }

  return { nodesUpserted, relsCreated };
}

// ── Phase Definition ─────────────────────────────────────────

export const graphUpsertPhase: PipelinePhase = {
  name: "graph-upsert",
  order: 2,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    for (const [, parseResult] of ctx.parseResults) {
      try {
        // DAGs
        if (parseResult.dags.length > 0) {
          const dagResult = await upsertDagsToGraph(
            deps.graph,
            ctx.serviceName,
            parseResult,
          );
          ctx.stats.totalDagNodes += dagResult.nodesUpserted;
          ctx.stats.totalDagRels += dagResult.relsCreated;
        }

        // Symbols
        if (parseResult.symbols.length > 0) {
          const graphResult = await upsertSymbolsToGraph(
            deps.graph,
            ctx.serviceName,
            parseResult,
          );
          ctx.stats.totalSymbols += graphResult.nodesUpserted;
          ctx.stats.totalRelationships += graphResult.relsCreated;
        }

        // Classes & Infrastructure
        if (
          parseResult.classes.length > 0 ||
          parseResult.infraPatterns.length > 0
        ) {
          const infraResult = await upsertInfraToGraph(
            deps.graph,
            ctx.serviceName,
            parseResult,
          );
          ctx.stats.totalClasses += parseResult.classes.length;
          ctx.stats.totalInfraPatterns += parseResult.infraPatterns.length;
          ctx.stats.totalInfraRels += infraResult.infraRels;
        }
      } catch (err) {
        errors.push(
          `${parseResult.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phase: "graph-upsert",
      success: errors.length === 0,
      stats: {
        symbols: ctx.stats.totalSymbols,
        classes: ctx.stats.totalClasses,
        relationships: ctx.stats.totalRelationships,
        infraRels: ctx.stats.totalInfraRels,
        dagNodes: ctx.stats.totalDagNodes,
        dagRels: ctx.stats.totalDagRels,
      },
      errors,
      durationMs: 0,
    };
  },
};
