// ─────────────────────────────────────────────────────────────
// Infrastructure Pattern Detection
// Scans AST call nodes for known infrastructure patterns
// (Kafka, PostgreSQL, MongoDB, Elasticsearch, HTTP).
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { InfraPattern, InfraKind } from "../types.js";
import { findAll } from "./ast-helpers.js";

// ── Rule definition ──────────────────────────────────────────

interface InfraRule {
  /** Regex matched against the full callee expression (e.g. "producer.produce") */
  pattern: RegExp;
  kind: InfraKind;
  /** Which positional argument (0-based) or keyword arg name holds the target */
  targetArg?: number | string;
  /** Fallback target label when we can't extract the arg */
  fallbackTarget: string;
  /** Human-readable description template. {target} is replaced. */
  detailTemplate: string;
  /** Extra keyword arguments to capture as metadata */
  metadataKeys?: string[];
}

// ── Known infrastructure patterns ────────────────────────────

const INFRA_RULES: InfraRule[] = [
  // ── Kafka Produce ──────────────────────────────────────
  {
    pattern: /\.produce$|\.send_async$|\.batch_produce$|MessageProducer/,
    kind: "kafka_produce",
    targetArg: 0,
    fallbackTarget: "<topic>",
    detailTemplate: "Produces to Kafka topic: {target}",
  },
  {
    pattern: /KafkaProducer$/,
    kind: "kafka_produce",
    fallbackTarget: "<kafka>",
    detailTemplate: "Creates Kafka producer",
  },
  // ── Kafka Consume ──────────────────────────────────────
  {
    pattern:
      /\.consume_batch$|\.sequential_consume$|MessageConsumer\.from_config|\.consume$|consume_cdc_messages/,
    kind: "kafka_consume",
    targetArg: "topic",
    fallbackTarget: "<topic>",
    detailTemplate: "Consumes from Kafka topic: {target}",
    metadataKeys: ["group_id"],
  },
  {
    pattern: /KafkaConsumer$/,
    kind: "kafka_consume",
    targetArg: 0,
    fallbackTarget: "<kafka>",
    detailTemplate: "Creates Kafka consumer for: {target}",
    metadataKeys: ["group_id"],
  },
  // ── PostgreSQL ─────────────────────────────────────────
  {
    pattern: /psycopg2\.connect$|PostgresHook$/,
    kind: "db_postgres",
    targetArg: "postgres_conn_id",
    fallbackTarget: "postgres",
    detailTemplate: "Connects to PostgreSQL: {target}",
  },
  {
    pattern: /execute_values$|\.execute$|\.executemany$/,
    kind: "db_postgres",
    fallbackTarget: "postgres",
    detailTemplate: "Executes SQL on PostgreSQL",
  },
  // ── MongoDB ────────────────────────────────────────────
  {
    pattern: /MongoHook$/,
    kind: "db_mongo",
    targetArg: "conn_id",
    fallbackTarget: "mongo",
    detailTemplate: "Connects to MongoDB: {target}",
  },
  {
    pattern: /\.insert_many$|\.insert_one$|\.find$|\.update_many$|\.aggregate$/,
    kind: "db_mongo",
    targetArg: "mongo_collection",
    fallbackTarget: "mongo",
    detailTemplate: "MongoDB operation on: {target}",
  },
  // ── Elasticsearch ──────────────────────────────────────
  {
    pattern: /^Elastic$|Elasticsearch$/,
    kind: "db_elasticsearch",
    targetArg: "index",
    fallbackTarget: "elasticsearch",
    detailTemplate: "Connects to Elasticsearch index: {target}",
  },
  {
    pattern: /helpers\.bulk$|\.search$|\.get_pit$|\.index$/,
    kind: "db_elasticsearch",
    fallbackTarget: "elasticsearch",
    detailTemplate: "Elasticsearch operation: {target}",
  },
  // ── HTTP (Python) ───────────────────────────────────────
  {
    pattern:
      /requests\.post$|requests\.get$|requests\.put$|requests\.patch$|requests\.delete$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "HTTP request to: {target}",
  },
  // ── BE Route Definitions (must be BEFORE generic HTTP client rules) ──
  // Express / Fastify / Hapi (JS/TS): router.get, app.post, server.put ...
  {
    pattern:
      /^(app|router|server|fastify|route)\.(get|post|put|patch|delete|use|all)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "Exposes route: {target}",
  },
  // FastAPI / Flask / APIRouter (Python): @app.get, @router.post ...
  {
    pattern:
      /^(app|router|blueprint|api|bp)\.(get|post|put|patch|delete|route)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "FastAPI/Flask route: {target}",
  },
  // NestJS decorators: @Get('/path'), @Post(), @Controller('prefix')
  {
    pattern: /^(Get|Post|Put|Patch|Delete|All|Controller|Head|Options)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "NestJS route: {target}",
  },
  // Spring Boot (Java): @GetMapping, @PostMapping, @RequestMapping
  {
    pattern:
      /^(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "Spring route: {target}",
  },
  // Laravel (PHP): Route::get('/path', ...)
  {
    pattern: /^Route\.(get|post|put|patch|delete|any|match)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "Laravel route: {target}",
  },
  // ASP.NET (C#): [HttpGet], [HttpPost], [Route]
  {
    pattern: /^(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)$/,
    kind: "http_route_define",
    targetArg: 0,
    fallbackTarget: "<path>",
    detailTemplate: "ASP.NET route: {target}",
  },
  // ── HTTP (JS/TS — fetch) ────────────────────────────────
  {
    pattern: /^fetch$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "fetch to: {target}",
  },
  // ── HTTP (JS/TS — axios explicit) ──────────────────────
  {
    pattern: /^axios\.(get|post|put|patch|delete|request|head|options)$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "axios HTTP call to: {target}",
  },
  // ── HTTP (JS/TS — ky) ──────────────────────────────────
  {
    pattern: /^ky\.(get|post|put|patch|delete)$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "ky HTTP call to: {target}",
  },
  // ── HTTP (JS/TS — got) ─────────────────────────────────
  {
    pattern: /^got\.(get|post|put|patch|delete)$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "got HTTP call to: {target}",
  },
  // ── HTTP (Node.js built-in) ────────────────────────────
  {
    pattern: /^https?\.request$|^https?\.get$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "Node.js HTTP request to: {target}",
  },
  // ── HTTP (JS/TS — generic axios instance, MUST be last) ──────────
  // Catches apiClient.get('/path'), this.http.post('/path').
  // Placed AFTER route_define rules to avoid false positives on router.get, app.post etc.
  {
    pattern: /^(this\.)?(\w+\.)?(get|post|put|patch|delete)$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "HTTP call to: {target}",
  }, // ── gRPC Client (caller side) ─────────────────────────────────────
  // Python: stub.SomeMethod(), grpc.insecure_channel(), pb2_grpc.XxxStub()
  {
    pattern: /stub\.\w+$|grpc\.insecure_channel$|pb2_grpc\.\w+Stub$/,
    kind: "grpc_call",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC call to: {target}",
  },
  // Go: pb.NewXxxClient(), conn.SomeMethod()
  {
    pattern: /pb\.New\w+Client$|grpc\.Dial$/,
    kind: "grpc_call",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC call to: {target}",
  },
  // Java: stub.someMethod(), ManagedChannelBuilder.forAddress()
  {
    pattern: /ManagedChannelBuilder$|stub\.\w+$|channel\.newCall$/,
    kind: "grpc_call",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC call to: {target}",
  },
  // TypeScript/JS: new XxxClient(), grpc.Client
  {
    pattern: /new \w+Client$|new \w+ServiceClient$/,
    kind: "grpc_call",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC call to: {target}",
  },
  // ── gRPC Server (handler side) ────────────────────────────────────
  // NestJS: @GrpcMethod('ServiceName', 'MethodName')
  {
    pattern: /^GrpcMethod$|^GrpcStreamMethod$/,
    kind: "grpc_serve",
    targetArg: 0,
    fallbackTarget: "<grpc-method>",
    detailTemplate: "gRPC handler for: {target}",
    metadataKeys: ["service"],
  },
  // Python: servicer base class implementation — detected via class inherit, matched by method name
  // Go: server.RegisterXxxServer() — registers a gRPC handler
  {
    pattern: /\.RegisterXxx\w+Server$|pb\.Register\w+Server$/,
    kind: "grpc_serve",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC server registers: {target}",
  },
  // Java Spring: @GrpcService class-level (simulated as method call in some frameworks)
  {
    pattern: /^GrpcService$|^GrpcGlobalServerInterceptor$/,
    kind: "grpc_serve",
    targetArg: 0,
    fallbackTarget: "<grpc-service>",
    detailTemplate: "gRPC service: {target}",
  },
];

// ── Detection ────────────────────────────────────────────────

/**
 * Scan the entire file AST for infrastructure patterns.
 * Works for all supported languages but infra rules are tuned for Python patterns.
 */
export function detectInfraPatterns(
  root: SyntaxNode,
  _language: string,
): InfraPattern[] {
  const patterns: InfraPattern[] = [];

  // Python uses "call" nodes; others use "call_expression"
  const callNodes = findAll(root, [
    "call",
    "call_expression",
    "function_call_expression",
  ]);

  for (const callNode of callNodes) {
    const fnNode =
      callNode.childForFieldName("function") ?? callNode.firstChild;
    if (!fnNode) continue;
    const callee = fnNode.text.trim();

    for (const rule of INFRA_RULES) {
      if (!rule.pattern.test(callee)) continue;

      const argsNode = callNode.childForFieldName("arguments");
      let target = rule.fallbackTarget;
      const metadata: Record<string, string> = {};

      if (argsNode) {
        if (typeof rule.targetArg === "number") {
          target =
            extractPositionalStringArg(argsNode, rule.targetArg) ??
            rule.fallbackTarget;
        } else if (typeof rule.targetArg === "string") {
          target =
            extractKeywordStringArg(argsNode, rule.targetArg) ??
            rule.fallbackTarget;
        }

        if (rule.metadataKeys) {
          for (const key of rule.metadataKeys) {
            const val = extractKeywordStringArg(argsNode, key);
            if (val) metadata[key] = val;
          }
        }
      }

      // Extract HTTP method from callee for route/request kinds
      if (rule.kind === "http_route_define" || rule.kind === "http_request") {
        const HTTP_METHODS = [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
          "ALL",
          "USE",
        ];
        const calleeParts = callee.split(".");
        const lastPart = calleeParts[calleeParts.length - 1].toUpperCase();
        if (HTTP_METHODS.includes(lastPart)) {
          metadata.method = lastPart;
        }
      }

      patterns.push({
        kind: rule.kind,
        target,
        detail: rule.detailTemplate.replace("{target}", target),
        line: callNode.startPosition.row + 1,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      break; // one rule per call node
    }
  }

  // Deduplicate: same kind+target within the same file → keep first occurrence
  const seen = new Set<string>();
  return patterns.filter((p) => {
    const key = `${p.kind}::${p.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Argument extraction helpers ──────────────────────────────

function extractPositionalStringArg(
  argsNode: SyntaxNode,
  index: number,
): string | null {
  let posIdx = 0;
  for (const child of argsNode.namedChildren) {
    if (!child) continue;
    if (
      child.type === "keyword_argument" ||
      child.type === "spread_element" ||
      child.type === "dictionary_splat" ||
      child.type === "list_splat"
    )
      continue;
    if (posIdx === index) {
      return extractStringValue(child);
    }
    posIdx++;
  }
  return null;
}

function extractKeywordStringArg(
  argsNode: SyntaxNode,
  keyName: string,
): string | null {
  for (const child of argsNode.namedChildren) {
    if (!child) continue;
    if (child.type === "keyword_argument") {
      const nameNode = child.childForFieldName("name");
      const valueNode = child.childForFieldName("value");
      if (nameNode && nameNode.text.trim() === keyName && valueNode) {
        return extractStringValue(valueNode);
      }
    }
  }
  return null;
}

function extractStringValue(node: SyntaxNode): string | null {
  if (node.type === "string") {
    const inner = node.text
      .replace(/^[bruf]*['"]{1,3}/i, "")
      .replace(/['"]{1,3}$/i, "");
    return inner || null;
  }
  // JS/TS template literal: `${BASE}/api/path` → return raw text for partial matching
  if (node.type === "template_string" || node.type === "template_literal") {
    // Extract static parts (string_fragment nodes)
    const fragments: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === "string_fragment" || child.type === "string_content") {
        fragments.push(child.text);
      }
    }
    const joined = fragments.join("*");
    return joined || node.text.replace(/^`|`$/g, "") || null;
  }
  // JS/TS string fragment (inside template)
  if (node.type === "string_fragment" || node.type === "string_content") {
    return node.text || null;
  }
  if (node.type === "list") {
    const items: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      const val = extractStringValue(child);
      if (val) items.push(val);
    }
    return items.length > 0 ? items.join(",") : null;
  }
  if (node.type === "call" || node.type === "call_expression") {
    const fn = node.childForFieldName("function") ?? node.firstChild;
    if (fn && /getenv|environ\.get/.test(fn.text)) {
      const args = node.childForFieldName("arguments");
      if (args) return extractPositionalStringArg(args, 0);
    }
  }
  if (node.type === "identifier" || node.type === "attribute") {
    return `$${node.text.trim()}`;
  }
  return null;
}
