import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  parseSource,
  detectLanguage,
  EXTENSION_MAP,
} from "@nexus-hub/common-tools";
import type {
  ParseResult,
  FunctionInfo,
  InfraPattern,
  ClassInfo,
  DagInfo,
  DagTaskInfo,
} from "@nexus-hub/common-tools";
import { MemgraphClient } from "../clients/memgraph.js";
import { ChromaDBClient } from "../clients/chromadb.js";

// ── Helpers ──────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip common non-source dirs
      if (
        [
          "node_modules",
          ".git",
          "vendor",
          "dist",
          "__pycache__",
          ".venv",
        ].includes(entry.name)
      )
        continue;
      files.push(...(await collectSourceFiles(fullPath)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function buildFunctionSignature(fn: FunctionInfo): string {
  const params = fn.parameters
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(", ");
  const ret = fn.returnType ? ` → ${fn.returnType}` : "";
  return `${fn.name}(${params})${ret}`;
}

// ── Graph Upsert ─────────────────────────────────────────────

async function upsertToGraph(
  memgraph: MemgraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ nodesUpserted: number; relsCreated: number }> {
  let nodesUpserted = 0;
  let relsCreated = 0;

  // Ensure service & file nodes
  await memgraph.write(`MERGE (s:Service {name: $service})`, {
    service: serviceName,
  });
  await memgraph.write(
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

  for (const fn of parseResult.functions) {
    // Upsert function node
    await memgraph.write(
      `MERGE (f:Function {name: $name, file: $file, service: $service})
       SET f.language   = $language,
           f.returnType = $returnType,
           f.startLine  = $startLine,
           f.endLine    = $endLine,
           f.signature  = $signature,
           f.updatedAt  = timestamp()
       WITH f
       MERGE (fi:File {path: $file})
       MERGE (f)-[:DEFINED_IN]->(fi)`,
      {
        name: fn.name,
        file: parseResult.file,
        service: serviceName,
        language: parseResult.language,
        returnType: fn.returnType ?? "",
        startLine: fn.startLine,
        endLine: fn.endLine,
        signature: buildFunctionSignature(fn),
      },
    );
    nodesUpserted++;

    // Upsert call relationships
    for (const call of fn.calls) {
      await memgraph.write(
        `MERGE (caller:Function {name: $callerName, file: $callerFile, service: $service})
         MERGE (callee:Function {name: $calleeName})
         MERGE (caller)-[r:CALLS]->(callee)
         SET r.line = $line, r.updatedAt = timestamp()`,
        {
          callerName: fn.name,
          callerFile: parseResult.file,
          service: serviceName,
          calleeName: call.name,
          line: call.line,
        },
      );
      relsCreated++;
    }
  }

  return { nodesUpserted, relsCreated };
}

// ── Infrastructure Graph Upsert ──────────────────────────────

async function upsertInfraToGraph(
  memgraph: MemgraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ infraNodes: number; infraRels: number }> {
  let infraNodes = 0;
  let infraRels = 0;

  // Upsert class nodes + inheritance edges
  for (const cls of parseResult.classes) {
    await memgraph.write(
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

    // Create INHERITS edges
    for (const base of cls.bases) {
      await memgraph.write(
        `MERGE (child:Class {name: $childName, file: $file, service: $service})
         MERGE (parent:Class {name: $baseName})
         MERGE (child)-[r:INHERITS]->(parent)
         SET r.updatedAt = timestamp()`,
        {
          childName: cls.name,
          file: parseResult.file,
          service: serviceName,
          baseName: base,
        },
      );
      infraRels++;
    }

    // Link methods to their owning class
    for (const method of cls.methods) {
      await memgraph.write(
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

  // Map InfraKind → graph node label
  const INFRA_LABELS: Record<string, string> = {
    kafka_produce: "KafkaTopic",
    kafka_consume: "KafkaTopic",
    db_postgres: "Database",
    db_mongo: "Database",
    db_elasticsearch: "Database",
    http_request: "HTTPEndpoint",
  };

  const INFRA_EDGE: Record<string, string> = {
    kafka_produce: "PRODUCES_TO",
    kafka_consume: "CONSUMES_FROM",
    db_postgres: "CONNECTS_TO",
    db_mongo: "CONNECTS_TO",
    db_elasticsearch: "CONNECTS_TO",
    http_request: "HTTP_CALL",
  };

  const DB_TYPE: Record<string, string> = {
    db_postgres: "postgresql",
    db_mongo: "mongodb",
    db_elasticsearch: "elasticsearch",
  };

  // For each infra pattern, find the enclosing function and create edges
  for (const ip of parseResult.infraPatterns) {
    if (ip.kind === "class_inherit") continue; // handled above

    const label = INFRA_LABELS[ip.kind];
    const edge = INFRA_EDGE[ip.kind];
    if (!label || !edge) continue;

    // Find the function that contains this infra call (by line range)
    const ownerFn = parseResult.functions.find(
      (fn) => fn.startLine <= ip.line && ip.line <= fn.endLine,
    );

    // Create the infrastructure target node
    const dbType = DB_TYPE[ip.kind] ?? "";
    await memgraph.write(
      `MERGE (t:${label} {name: $target})
       SET t.type = $dbType, t.updatedAt = timestamp()`,
      { target: ip.target, dbType },
    );
    infraNodes++;

    if (ownerFn) {
      // Create edge from function → infra target
      const metaStr = ip.metadata ? JSON.stringify(ip.metadata) : "";
      await memgraph.write(
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
      infraRels++;
    } else {
      // File-level infra pattern (outside any function — e.g. module-level connection)
      await memgraph.write(
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

// ── Vector Upsert ────────────────────────────────────────────

async function upsertToVector(
  chromadb: ChromaDBClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<number> {
  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Record<string, string | number | boolean>[] = [];

  // Build a map: function name → infra patterns touching that function
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

  // Also embed classes as searchable documents
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
  await chromadb.upsert(ids, documents, metadatas);
  return ids.length;
}

// ── DAG Graph Upsert ─────────────────────────────────────────

async function upsertDagsToGraph(
  memgraph: MemgraphClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<{ nodesUpserted: number; relsCreated: number }> {
  let nodesUpserted = 0;
  let relsCreated = 0;

  for (const dag of parseResult.dags) {
    // DAG node
    await memgraph.write(
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
    await memgraph.write(
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
      // Task node + BELONGS_TO DAG
      await memgraph.write(
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

      // DEPENDS_ON edges (task → upstream task)
      for (const dep of task.dependencies) {
        await memgraph.write(
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

      // INVOKES edge: PythonOperator task → Python function
      if (task.pythonCallableName) {
        await memgraph.write(
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

// ── DAG Vector Upsert ────────────────────────────────────────

async function upsertDagsToVector(
  chromadb: ChromaDBClient,
  serviceName: string,
  parseResult: ParseResult,
): Promise<number> {
  if (parseResult.dags.length === 0) return 0;

  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Record<string, string | number | boolean>[] = [];

  for (const dag of parseResult.dags) {
    // Vector for the DAG itself
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

    // Vector for each task
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

  await chromadb.upsert(ids, documents, metadatas);
  return ids.length;
}

// ── Staleness Check ──────────────────────────────────────────

const hashCache = new Map<string, string>();

function isFileChanged(filePath: string, content: string): boolean {
  const newHash = contentHash(content);
  const oldHash = hashCache.get(filePath);
  hashCache.set(filePath, newHash);
  return oldHash !== newHash;
}

// ── MCP Tool Registration ────────────────────────────────────

export function registerSyncTool(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
): void {
  server.tool(
    "sync_service_knowledge",
    "Scan all source files in a service directory, extract functions/calls/types using tree-sitter, and upsert the knowledge into the shared Memgraph graph and ChromaDB vector store. Returns a summary report.",
    {
      service_path: z
        .string()
        .describe(
          "Absolute or workspace-relative path to the service folder (e.g. './services/api-gateway').",
        ),
      force_update: z
        .boolean()
        .default(false)
        .describe(
          "If true, re-process all files regardless of whether they changed. If false, skip unchanged files.",
        ),
    },
    async ({ service_path, force_update }) => {
      try {
        // Resolve absolute path
        const absPath = path.resolve(service_path);
        const serviceName = path.basename(absPath);

        // Validate directory exists
        const stat = await fs.stat(absPath);
        if (!stat.isDirectory()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `${absPath} is not a directory.`,
                }),
              },
            ],
            isError: true,
          };
        }

        // Collect source files
        const sourceFiles = await collectSourceFiles(absPath);

        // Counters
        let filesScanned = 0;
        let filesSkipped = 0;
        let totalFunctions = 0;
        let totalRelationships = 0;
        let totalVectors = 0;
        let totalClasses = 0;
        let totalInfraPatterns = 0;
        let totalInfraRels = 0;
        let totalDagNodes = 0;
        let totalDagRels = 0;
        let totalDagVectors = 0;
        const languagesSeen = new Set<string>();
        const errors: string[] = [];

        // Process each file
        for (const filePath of sourceFiles) {
          try {
            const content = await fs.readFile(filePath, "utf-8");

            // Skip unchanged files unless forced
            if (!force_update && !isFileChanged(filePath, content)) {
              filesSkipped++;
              continue;
            }

            const relPath = path.relative(absPath, filePath);
            const parseResult = await parseSource(filePath, content);

            // Override file path to service-relative for cleaner storage
            parseResult.file = `${serviceName}/${relPath}`;
            languagesSeen.add(parseResult.language);
            filesScanned++;

            if (parseResult.parseErrors.length > 0) {
              errors.push(
                ...parseResult.parseErrors.map((e) => `${relPath}: ${e}`),
              );
            }

            // Upsert DAGs to Graph + Vector (YAML files)
            if (parseResult.dags.length > 0) {
              const dagGraphResult = await upsertDagsToGraph(
                memgraph,
                serviceName,
                parseResult,
              );
              totalDagNodes += dagGraphResult.nodesUpserted;
              totalDagRels += dagGraphResult.relsCreated;

              const dagVectorCount = await upsertDagsToVector(
                chromadb,
                serviceName,
                parseResult,
              );
              totalDagVectors += dagVectorCount;
            }

            // Upsert functions to Graph (even if 0 functions, still create file node)
            if (parseResult.functions.length > 0) {
              const graphResult = await upsertToGraph(
                memgraph,
                serviceName,
                parseResult,
              );
              totalFunctions += graphResult.nodesUpserted;
              totalRelationships += graphResult.relsCreated;
            }

            // Upsert infrastructure patterns + classes to Graph
            if (
              parseResult.classes.length > 0 ||
              parseResult.infraPatterns.length > 0
            ) {
              const infraResult = await upsertInfraToGraph(
                memgraph,
                serviceName,
                parseResult,
              );
              totalClasses += parseResult.classes.length;
              totalInfraPatterns += parseResult.infraPatterns.length;
              totalInfraRels += infraResult.infraRels;
            }

            // Upsert to Vector (functions + classes)
            const vectorCount = await upsertToVector(
              chromadb,
              serviceName,
              parseResult,
            );
            totalVectors += vectorCount;
          } catch (fileErr) {
            const relPath = path.relative(absPath, filePath);
            const msg =
              fileErr instanceof Error ? fileErr.message : String(fileErr);
            errors.push(`${relPath}: ${msg}`);
            console.error(`[sync] Error processing ${relPath}:`, msg);
          }
        }

        const report = {
          service: serviceName,
          path: absPath,
          summary: `Synced ${totalFunctions} functions, ${totalClasses} classes, ${totalRelationships} call edges, ${totalInfraPatterns} infra patterns (${totalInfraRels} infra edges), ${totalDagNodes} DAG/task nodes (${totalDagRels} DAG edges). Languages: ${[...languagesSeen].join(", ") || "none"}`,
          details: {
            filesScanned,
            filesSkipped,
            totalFunctions,
            totalClasses,
            totalRelationships,
            totalInfraPatterns,
            totalInfraRels,
            totalDagNodes,
            totalDagRels,
            totalDagVectors,
            totalVectors,
            languages: [...languagesSeen],
            forceUpdate: force_update,
          },
          parseErrors: errors.length > 0 ? errors.slice(0, 20) : undefined,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error("[sync_service_knowledge] Error:", message, stack);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, stack }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
