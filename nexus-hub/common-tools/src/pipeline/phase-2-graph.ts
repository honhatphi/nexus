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
import { SCHEMA_VERSION } from "./schema-registry.js";
import { recordCandidatePattern } from "./candidate-pattern.js";

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
  await graph.write(
    `MERGE (s:Service {name: $service})
     ON CREATE SET s.firstSeenAt = timestamp(), s.source = 'code'
     SET s.schemaVersion = $sv, s.lastSeenAt = timestamp()`,
    { service: serviceName, sv: SCHEMA_VERSION },
  );

  // File node + edge
  await graph.write(
    `MERGE (fi:File {path: $file, service: $service})
     ON CREATE SET fi.firstSeenAt = timestamp(), fi.source = 'code'
     SET fi.schemaVersion = $sv, fi.lastSeenAt = timestamp(),
         fi.language = $language
     WITH fi
     MERGE (s:Service {name: $service})
     MERGE (fi)-[:BELONGS_TO]->(s)`,
    {
      file: parseResult.file,
      service: serviceName,
      language: parseResult.language,
      sv: SCHEMA_VERSION,
    },
  );

  if (parseResult.symbols.length === 0) {
    return { nodesUpserted, relsCreated };
  }

  // ── Batch: all Function nodes in one UNWIND write ────────
  // Reduces N individual Memgraph round-trips to 1 per file.
  const symbolRows = parseResult.symbols.map((sym) => ({
    name: sym.name,
    file: parseResult.file,
    service: serviceName,
    kind: sym.kind,
    language: parseResult.language,
    returnType: sym.returnType ?? "",
    startLine: sym.startLine,
    endLine: sym.endLine,
    signature: buildSignature(sym),
    docstring: sym.docstring ?? "",
    sv: SCHEMA_VERSION,
  }));

  await graph.write(
    `UNWIND $symbols AS sym
     MERGE (f:Function {name: sym.name, file: sym.file, service: sym.service})
     ON CREATE SET f.firstSeenAt = timestamp(), f.source = 'code'
     SET f.schemaVersion = sym.sv,
         f.lastSeenAt  = timestamp(),
         f.kind        = sym.kind,
         f.language    = sym.language,
         f.returnType  = sym.returnType,
         f.startLine   = sym.startLine,
         f.endLine     = sym.endLine,
         f.signature   = sym.signature,
         f.docstring   = sym.docstring
     WITH f, sym
     MERGE (fi:File {path: sym.file, service: sym.service})
     MERGE (f)-[:DEFINED_IN]->(fi)`,
    { symbols: symbolRows },
  );
  nodesUpserted += symbolRows.length;

  // ── Batch: all CALLS edges in one UNWIND write ────────────
  type CallRow = {
    callerName: string;
    callerFile: string;
    service: string;
    calleeName: string;
    line: number;
    confidence: number;
    reason: string;
  };
  const callRows: CallRow[] = [];

  for (const sym of parseResult.symbols) {
    for (const call of sym.calls) {
      const { confidence, reason } = computeCallConfidence(
        parseResult.file,
        call.name,
        parseResult,
      );
      callRows.push({
        callerName: sym.name,
        callerFile: parseResult.file,
        service: serviceName,
        calleeName: call.name,
        line: call.line,
        confidence,
        reason,
      });
    }
  }

  if (callRows.length > 0) {
    await graph.write(
      `UNWIND $calls AS c
       MERGE (caller:Function {name: c.callerName, file: c.callerFile, service: c.service})
       MERGE (callee:Function {name: c.calleeName})
       MERGE (caller)-[r:CALLS]->(callee)
       SET r.line = c.line,
           r.confidence = c.confidence,
           r.reason = c.reason,
           r.updatedAt = timestamp()`,
      { calls: callRows },
    );
    relsCreated += callRows.length;
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
  rabbitmq_publish: "MessageQueue",
  rabbitmq_consume: "MessageQueue",
  redis_publish: "MessageChannel",
  redis_subscribe: "MessageChannel",
  sqs_send: "MessageQueue",
  sqs_receive: "MessageQueue",
  nats_publish: "MessageChannel",
  nats_subscribe: "MessageChannel",
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
  rabbitmq_publish: "PUBLISHES_TO",
  rabbitmq_consume: "CONSUMES_FROM",
  redis_publish: "PUBLISHES_TO",
  redis_subscribe: "SUBSCRIBES_TO",
  sqs_send: "SENDS_TO",
  sqs_receive: "RECEIVES_FROM",
  nats_publish: "PUBLISHES_TO",
  nats_subscribe: "SUBSCRIBES_TO",
};

// Queue/channel type labels for MessageQueue nodes
const QUEUE_TYPE: Record<string, string> = {
  rabbitmq_publish: "rabbitmq",
  rabbitmq_consume: "rabbitmq",
  redis_publish: "redis",
  redis_subscribe: "redis",
  sqs_send: "sqs",
  sqs_receive: "sqs",
  nats_publish: "nats",
  nats_subscribe: "nats",
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

  // ── Batch: Classes + inheritance + method edges ─────────
  if (parseResult.classes.length > 0) {
    const classRows = parseResult.classes.map((cls) => ({
      name: cls.name,
      file: parseResult.file,
      service: serviceName,
      startLine: cls.startLine,
      endLine: cls.endLine,
      docstring: cls.docstring ?? "",
      sv: SCHEMA_VERSION,
    }));

    await graph.write(
      `UNWIND $classes AS cls
       MERGE (c:Class {name: cls.name, file: cls.file, service: cls.service})
       ON CREATE SET c.firstSeenAt = timestamp(), c.source = 'code'
       SET c.schemaVersion = cls.sv, c.lastSeenAt = timestamp(),
           c.startLine = cls.startLine, c.endLine = cls.endLine,
           c.docstring = cls.docstring
       WITH c, cls
       MERGE (fi:File {path: cls.file, service: cls.service})
       MERGE (c)-[:DEFINED_IN]->(fi)`,
      { classes: classRows },
    );
    infraNodes += classRows.length;

    type InheritRow = {
      childName: string;
      file: string;
      service: string;
      baseName: string;
    };
    const inheritRows: InheritRow[] = [];
    for (const cls of parseResult.classes) {
      for (const base of cls.bases) {
        inheritRows.push({
          childName: cls.name,
          file: parseResult.file,
          service: serviceName,
          baseName: base,
        });
      }
    }
    if (inheritRows.length > 0) {
      await graph.write(
        `UNWIND $inherits AS ih
         MERGE (child:Class {name: ih.childName, file: ih.file, service: ih.service})
         MERGE (parent:Class {name: ih.baseName})
         MERGE (child)-[r:INHERITS]->(parent)
         SET r.confidence = 0.9, r.updatedAt = timestamp()`,
        { inherits: inheritRows },
      );
      infraRels += inheritRows.length;
    }

    type MethodRow = {
      methodName: string;
      file: string;
      service: string;
      className: string;
    };
    const methodRows: MethodRow[] = [];
    for (const cls of parseResult.classes) {
      for (const method of cls.methods) {
        methodRows.push({
          methodName: method,
          file: parseResult.file,
          service: serviceName,
          className: cls.name,
        });
      }
    }
    if (methodRows.length > 0) {
      await graph.write(
        `UNWIND $methods AS m
         MATCH (f:Function {name: m.methodName, file: m.file, service: m.service})
         MERGE (c:Class {name: m.className, file: m.file, service: m.service})
         MERGE (f)-[r:METHOD_OF]->(c)
         SET r.updatedAt = timestamp()`,
        { methods: methodRows },
      );
      infraRels += methodRows.length;
    }
  }

  // Infrastructure patterns
  for (const ip of parseResult.infraPatterns) {
    if (ip.kind === "class_inherit") continue;

    const label = INFRA_LABELS[ip.kind];
    const edge = INFRA_EDGE[ip.kind];
    if (!label || !edge) {
      // D2: Unknown pattern — record as CandidatePattern for human review
      await recordCandidatePattern(graph, {
        service: serviceName,
        file: parseResult.file,
        line: ip.line,
        pattern: ip.kind,
        rawCode: ip.target,
        confidence: 0.3,
        status: "pending",
      }).catch(() => {}); // never crash the pipeline
      continue;
    }

    const ownerFn = parseResult.functions.find(
      (fn) => fn.startLine <= ip.line && ip.line <= fn.endLine,
    );

    const dbType = DB_TYPE[ip.kind] ?? "";

    // APIRoute nodes carry path + method + service as identity/properties
    if (ip.kind === "http_route_define") {
      const method = ip.metadata?.method ?? "GET";
      await graph.write(
        `MERGE (t:APIRoute {path: $path, method: $method, service: $service})
         ON CREATE SET t.firstSeenAt = timestamp()
         SET t.schemaVersion = $sv,
             t.lastSeenAt  = timestamp(),
             t.name        = $path,
             t.operationId = $operationId,
             t.source      = $source`,
        {
          path: ip.target,
          method,
          service: serviceName,
          operationId: ip.metadata?.operationId ?? "",
          source: ip.metadata?.source ?? "code",
          sv: SCHEMA_VERSION,
        },
      );
    } else if (ip.kind === "grpc_call" || ip.kind === "grpc_serve") {
      // GRPCEndpoint: identity by name + service (the gRPC service name, not microservice)
      const grpcService = ip.metadata?.service ?? ip.target;
      await graph.write(
        `MERGE (t:GRPCEndpoint {name: $name, service: $grpcService})
         ON CREATE SET t.firstSeenAt = timestamp(), t.source = 'grpc_proto'
         SET t.schemaVersion = $sv, t.lastSeenAt = timestamp()`,
        { name: ip.target, grpcService, sv: SCHEMA_VERSION },
      );
    } else if (QUEUE_TYPE[ip.kind]) {
      // MessageQueue / MessageChannel — include broker type
      const queueType = QUEUE_TYPE[ip.kind];
      await graph.write(
        `MERGE (t:${label} {name: $target, type: $queueType})
         ON CREATE SET t.firstSeenAt = timestamp(), t.source = 'code'
         SET t.schemaVersion = $sv, t.lastSeenAt = timestamp()`,
        { target: ip.target, queueType, sv: SCHEMA_VERSION },
      );
    } else {
      await graph.write(
        `MERGE (t:${label} {name: $target})
         ON CREATE SET t.firstSeenAt = timestamp(), t.source = 'code'
         SET t.type = $dbType, t.schemaVersion = $sv, t.lastSeenAt = timestamp()`,
        { target: ip.target, dbType, sv: SCHEMA_VERSION },
      );
    }
    infraNodes++;

    if (ownerFn) {
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
        const metaStr = ip.metadata ? JSON.stringify(ip.metadata) : "";
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
  if (parseResult.dags.length === 0) {
    return { nodesUpserted: 0, relsCreated: 0 };
  }

  let nodesUpserted = 0;
  let relsCreated = 0;

  // ── Batch: all DAG nodes + Service/File edges in one UNWIND ──
  const dagRows = parseResult.dags.map((dag) => ({
    dagName: dag.name,
    service: serviceName,
    file: parseResult.file,
    schedule: dag.scheduleInterval ?? "",
    description: dag.description ?? "",
    owner: dag.owner ?? "",
    concurrency: dag.concurrency ?? 0,
    language: parseResult.language,
  }));

  await graph.write(
    `UNWIND $dags AS d
     MERGE (dag:DAG {name: d.dagName, service: d.service})
     SET dag.file             = d.file,
         dag.scheduleInterval = d.schedule,
         dag.description      = d.description,
         dag.owner            = d.owner,
         dag.concurrency      = d.concurrency,
         dag.updatedAt        = timestamp()
     WITH dag, d
     MERGE (s:Service {name: d.service})
     MERGE (s)-[:CONTAINS]->(dag)`,
    { dags: dagRows },
  );
  nodesUpserted += dagRows.length;

  // File node — only one write per parseResult (not per DAG)
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

  // ── Collect Task/dep/invokes rows across all DAGs ─────────────
  type TaskRow = {
    taskName: string;
    dagName: string;
    service: string;
    operator: string;
    pyFile: string;
    pyName: string;
    bashCmd: string;
    sql: string;
    pgConnId: string;
    retries: number;
    timeout: number;
    file: string;
  };
  type DepRow = {
    taskName: string;
    dagName: string;
    service: string;
    depName: string;
  };
  type InvokesRow = {
    taskName: string;
    dagName: string;
    service: string;
    funcName: string;
    pyFile: string;
  };

  const taskRows: TaskRow[] = [];
  const depRows: DepRow[] = [];
  const invokesRows: InvokesRow[] = [];

  for (const dag of parseResult.dags) {
    for (const task of dag.tasks) {
      taskRows.push({
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
      });

      for (const dep of task.dependencies) {
        depRows.push({
          taskName: task.name,
          dagName: dag.name,
          service: serviceName,
          depName: dep,
        });
      }

      if (task.pythonCallableName) {
        invokesRows.push({
          taskName: task.name,
          dagName: dag.name,
          service: serviceName,
          funcName: task.pythonCallableName,
          pyFile: task.pythonCallableFile ?? "",
        });
      }
    }
  }

  // ── Batch: all Task nodes in one UNWIND write ─────────────────
  if (taskRows.length > 0) {
    await graph.write(
      `UNWIND $tasks AS t
       MERGE (task:Task {name: t.taskName, dag: t.dagName, service: t.service})
       SET task.operator             = t.operator,
           task.pythonCallableFile   = t.pyFile,
           task.pythonCallableName   = t.pyName,
           task.bashCommand          = t.bashCmd,
           task.sql                  = t.sql,
           task.postgresConnId       = t.pgConnId,
           task.retries              = t.retries,
           task.executionTimeoutSecs = t.timeout,
           task.file                 = t.file,
           task.updatedAt            = timestamp()
       WITH task, t
       MERGE (d:DAG {name: t.dagName, service: t.service})
       MERGE (task)-[:BELONGS_TO]->(d)`,
      { tasks: taskRows },
    );
    nodesUpserted += taskRows.length;
  }

  // ── Batch: all DEPENDS_ON edges in one UNWIND write ───────────
  if (depRows.length > 0) {
    await graph.write(
      `UNWIND $deps AS d
       MERGE (t:Task {name: d.taskName, dag: d.dagName, service: d.service})
       MERGE (upstream:Task {name: d.depName, dag: d.dagName, service: d.service})
       MERGE (t)-[r:DEPENDS_ON]->(upstream)
       SET r.updatedAt = timestamp()`,
      { deps: depRows },
    );
    relsCreated += depRows.length;
  }

  // ── Batch: all INVOKES edges in one UNWIND write ──────────────
  if (invokesRows.length > 0) {
    await graph.write(
      `UNWIND $invokes AS iv
       MERGE (t:Task {name: iv.taskName, dag: iv.dagName, service: iv.service})
       MERGE (f:Function {name: iv.funcName})
       MERGE (t)-[r:INVOKES]->(f)
       SET r.callableFile = iv.pyFile, r.updatedAt = timestamp()`,
      { invokes: invokesRows },
    );
    relsCreated += invokesRows.length;
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
