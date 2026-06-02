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
  // ── RabbitMQ ────────────────────────────────────────────────────
  // Python: channel.basic_publish(exchange, routing_key, body)
  {
    pattern: /\.basic_publish$|channel\.publish$/,
    kind: "rabbitmq_publish",
    targetArg: 1, // routing_key is arg 1
    fallbackTarget: "<routing-key>",
    detailTemplate: "RabbitMQ publish to: {target}",
  },
  // Python: channel.basic_consume(queue, callback)
  {
    pattern: /\.basic_consume$|channel\.consume$/,
    kind: "rabbitmq_consume",
    targetArg: 0,
    fallbackTarget: "<queue>",
    detailTemplate: "RabbitMQ consume from: {target}",
  },
  // JS/TS: channel.sendToQueue(queue, content) — amqplib
  {
    pattern: /\.sendToQueue$/,
    kind: "rabbitmq_publish",
    targetArg: 0,
    fallbackTarget: "<queue>",
    detailTemplate: "RabbitMQ publish to: {target}",
  },
  // ── Redis Pub/Sub ──────────────────────────────────────────
  // Python: redis_client.publish(channel, message)
  {
    pattern: /redis\.publish$|r\.publish$|client\.publish$/,
    kind: "redis_publish",
    targetArg: 0,
    fallbackTarget: "<channel>",
    detailTemplate: "Redis publish to channel: {target}",
  },
  // Python/JS: pubsub.subscribe(channel) / client.subscribe(channel)
  {
    pattern: /pubsub\.subscribe$|\.psubscribe$|redis\.subscribe$/,
    kind: "redis_subscribe",
    targetArg: 0,
    fallbackTarget: "<channel>",
    detailTemplate: "Redis subscribe to channel: {target}",
  },
  // JS/TS: subscriber.subscribe(channel) — ioredis / node-redis
  {
    pattern: /subscriber\.subscribe$|sub\.subscribe$/,
    kind: "redis_subscribe",
    targetArg: 0,
    fallbackTarget: "<channel>",
    detailTemplate: "Redis subscribe to channel: {target}",
  },
  // ── AWS SQS ──────────────────────────────────────────────────
  // Python boto3: sqs.send_message(QueueUrl=..., MessageBody=...)
  {
    pattern: /\.send_message$|sqs\.send_message$/,
    kind: "sqs_send",
    targetArg: 0,
    fallbackTarget: "<queue-url>",
    detailTemplate: "SQS send to: {target}",
    metadataKeys: ["QueueUrl"],
  },
  // Python boto3: sqs.receive_message(QueueUrl=...)
  {
    pattern: /\.receive_message$|sqs\.receive_message$/,
    kind: "sqs_receive",
    targetArg: 0,
    fallbackTarget: "<queue-url>",
    detailTemplate: "SQS receive from: {target}",
    metadataKeys: ["QueueUrl"],
  },
  // JS/TS AWS SDK v3: SendMessageCommand, ReceiveMessageCommand
  {
    pattern: /new SendMessageCommand$|SQSClient\.send$/,
    kind: "sqs_send",
    targetArg: 0,
    fallbackTarget: "<queue-url>",
    detailTemplate: "SQS send: {target}",
  },
  {
    pattern: /new ReceiveMessageCommand$/,
    kind: "sqs_receive",
    targetArg: 0,
    fallbackTarget: "<queue-url>",
    detailTemplate: "SQS receive: {target}",
  },
  // ── NATS ────────────────────────────────────────────────────────
  // JS/TS: nc.publish(subject, data)
  {
    pattern: /nc\.publish$|nats\.publish$|js\.publish$/,
    kind: "nats_publish",
    targetArg: 0,
    fallbackTarget: "<subject>",
    detailTemplate: "NATS publish to: {target}",
  },
  // JS/TS: nc.subscribe(subject, handler)
  {
    pattern: /nc\.subscribe$|nats\.subscribe$|js\.subscribe$/,
    kind: "nats_subscribe",
    targetArg: 0,
    fallbackTarget: "<subject>",
    detailTemplate: "NATS subscribe to: {target}",
  },
  // Go: nc.Publish(subject, data) / nc.Subscribe(subject, handler)
  {
    pattern: /nc\.Publish$|conn\.Publish$/,
    kind: "nats_publish",
    targetArg: 0,
    fallbackTarget: "<subject>",
    detailTemplate: "NATS publish to: {target}",
  },
  {
    pattern: /nc\.Subscribe$|conn\.Subscribe$/,
    kind: "nats_subscribe",
    targetArg: 0,
    fallbackTarget: "<subject>",
    detailTemplate: "NATS subscribe to: {target}",
  },

  // ── Firebase / Flutter ─────────────────────────────────
  // Firestore
  {
    pattern: /FirebaseFirestore\.instance$|FirebaseFirestore$/,
    kind: "firebase_firestore",
    fallbackTarget: "firestore",
    detailTemplate: "Initializes Firestore instance",
  },
  {
    pattern: /\.collection$|\.collectionGroup$/,
    kind: "firebase_firestore",
    targetArg: 0,
    fallbackTarget: "<collection>",
    detailTemplate: "Firestore collection: {target}",
  },
  {
    pattern: /\.doc$|\.document$/,
    kind: "firebase_firestore",
    targetArg: 0,
    fallbackTarget: "<doc>",
    detailTemplate: "Firestore document: {target}",
  },
  {
    pattern: /\.snapshots$|\.get$|\.set$|\.update$|\.delete$/,
    kind: "firebase_firestore",
    fallbackTarget: "firestore",
    detailTemplate: "Firestore operation: {target}",
  },

  // Firebase Auth
  {
    pattern: /FirebaseAuth\.instance$|FirebaseAuth$/,
    kind: "firebase_auth",
    fallbackTarget: "firebase_auth",
    detailTemplate: "Initializes Firebase Auth",
  },
  {
    pattern:
      /\.signInWithEmailAndPassword$|\.createUserWithEmailAndPassword$|\.signInAnonymously$|\.signInWithCredential$|\.signInWithPopup$|\.signOut$/,
    kind: "firebase_auth",
    fallbackTarget: "auth",
    detailTemplate: "Firebase Auth operation: {target}",
  },

  // Firebase Storage
  {
    pattern: /FirebaseStorage\.instance$|FirebaseStorage$/,
    kind: "firebase_storage",
    fallbackTarget: "firebase_storage",
    detailTemplate: "Initializes Firebase Storage",
  },
  {
    pattern: /\.putFile$|\.putData$|\.putString$|\.getDownloadURL$/,
    kind: "firebase_storage",
    fallbackTarget: "storage",
    detailTemplate: "Firebase Storage operation: {target}",
  },

  // Firebase Messaging (FCM)
  {
    pattern: /FirebaseMessaging\.instance$|FirebaseMessaging$/,
    kind: "firebase_messaging",
    fallbackTarget: "fcm",
    detailTemplate: "Initializes Firebase Messaging (FCM)",
  },
  {
    pattern:
      /\.getToken$|\.subscribeToTopic$|\.unsubscribeFromTopic$|FirebaseMessaging\.onMessage$|FirebaseMessaging\.onBackgroundMessage$/,
    kind: "firebase_messaging",
    fallbackTarget: "fcm",
    detailTemplate: "FCM operation: {target}",
  },

  // Firebase Realtime Database
  {
    pattern: /FirebaseDatabase\.instance$|FirebaseDatabase$/,
    kind: "firebase_realtime_db",
    fallbackTarget: "realtime_db",
    detailTemplate: "Initializes Firebase Realtime Database",
  },
  {
    pattern: /DatabaseReference$|\.onValue$|\.onChildAdded$/,
    kind: "firebase_realtime_db",
    fallbackTarget: "realtime_db",
    detailTemplate: "Realtime DB operation: {target}",
  },

  // Firebase Crashlytics
  {
    pattern: /FirebaseCrashlytics\.instance$|FirebaseCrashlytics$/,
    kind: "firebase_crashlytics",
    fallbackTarget: "crashlytics",
    detailTemplate: "Initializes Firebase Crashlytics",
  },
  {
    pattern: /\.recordError$|\.recordFlutterFatalError$|\.log$/,
    kind: "firebase_crashlytics",
    fallbackTarget: "crashlytics",
    detailTemplate: "Crashlytics report: {target}",
  },

  // Firebase Analytics
  {
    pattern: /FirebaseAnalytics\.instance$|FirebaseAnalytics$/,
    kind: "firebase_analytics",
    fallbackTarget: "analytics",
    detailTemplate: "Initializes Firebase Analytics",
  },
  {
    pattern: /\.logEvent$|\.setUserId$|\.setCurrentScreen$/,
    kind: "firebase_analytics",
    targetArg: 0,
    fallbackTarget: "<event>",
    detailTemplate: "Analytics event: {target}",
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

  // Dart: selector-based call AST — uses a separate scanner
  if (_language === "dart") {
    patterns.push(...detectDartFirebasePatterns(root));
  }

  // Deduplicate only exact duplicate detections from the same AST call.
  const seen = new Set<string>();
  return patterns.filter((p) => {
    const key = `${p.kind}::${p.target}::${p.line}`;
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

// ── Dart / Firebase pattern detection ────────────────────────
// Dart uses a selector-chain AST (not call_expression), so Firebase APIs
// are detected via two passes:
//   1. argument_part scan: catch method calls (runs first so .find() returns specific patterns)
//   2. Identifier scan: catch Firebase class name references (instance access, property refs)

function detectDartFirebasePatterns(root: SyntaxNode): InfraPattern[] {
  const patterns: InfraPattern[] = [];

  // Pass 1 — Firebase method calls via argument_part reconstruction
  // Runs FIRST so that .find() returns the more specific method-call pattern
  const METHOD_RULES: Array<{
    pattern: RegExp;
    kind: InfraKind;
    targetArg?: number;
    fallback: string;
    template: string;
  }> = [
    {
      pattern: /\.collection$|\.collectionGroup$/,
      kind: "firebase_firestore",
      targetArg: 0,
      fallback: "<collection>",
      template: "Firestore collection: {target}",
    },
    {
      pattern: /\.doc$|\.document$/,
      kind: "firebase_firestore",
      targetArg: 0,
      fallback: "<doc>",
      template: "Firestore document: {target}",
    },
    {
      pattern: /\.snapshots$|\.get$|\.set$|\.update$|\.delete$/,
      kind: "firebase_firestore",
      fallback: "firestore",
      template: "Firestore operation: {target}",
    },
    {
      pattern:
        /\.signInWithEmailAndPassword$|\.createUserWithEmailAndPassword$|\.signInAnonymously$|\.signOut$/,
      kind: "firebase_auth",
      fallback: "auth",
      template: "Firebase Auth operation: {target}",
    },
    {
      pattern: /\.putFile$|\.putData$|\.putString$|\.getDownloadURL$/,
      kind: "firebase_storage",
      fallback: "storage",
      template: "Firebase Storage operation: {target}",
    },
    {
      pattern: /\.getToken$|\.subscribeToTopic$|\.unsubscribeFromTopic$/,
      kind: "firebase_messaging",
      fallback: "fcm",
      template: "FCM operation: {target}",
    },
    {
      pattern: /\.recordError$/,
      kind: "firebase_crashlytics",
      fallback: "crashlytics",
      template: "Crashlytics report: {target}",
    },
    {
      pattern: /\.logEvent$|\.setUserId$|\.setCurrentScreen$/,
      kind: "firebase_analytics",
      targetArg: 0,
      fallback: "<event>",
      template: "Analytics event: {target}",
    },
  ];

  for (const argPart of findAll(root, ["argument_part"])) {
    const selectorNode = argPart.parent; // "selector"
    if (!selectorNode) continue;
    const chain = selectorNode.parent;
    if (!chain) continue;

    // Reconstruct callee: collect identifiers and unconditional_assignable_selectors
    // in the chain before this selectorNode, skipping argument_part selectors
    const calleeParts: string[] = [];
    for (let i = 0; i < chain.childCount; i++) {
      const child = chain.child(i);
      if (!child) continue;
      if (child.id === selectorNode.id) break;
      if (child.type === "identifier" || child.type === "type_identifier") {
        calleeParts.push(child.text);
      } else if (child.type === "selector") {
        const accessor = child.firstNamedChild;
        if (accessor?.type === "unconditional_assignable_selector") {
          calleeParts.push(accessor.text.trim()); // e.g. ".instance", ".collection"
        }
        // skip selector(argument_part) — already-called intermediate results
      }
    }
    const callee = calleeParts.join("");
    if (!callee) continue;

    for (const rule of METHOD_RULES) {
      if (!rule.pattern.test(callee)) continue;

      let target = rule.fallback;
      if (rule.targetArg === 0) {
        const argsNode = argPart.namedChildren.find(
          (c) => c?.type === "arguments",
        );
        if (argsNode) {
          const firstArg = argsNode.namedChildren.find(
            (c) => c?.type === "argument",
          );
          if (firstArg) {
            const strNodes = findAll(firstArg, ["string_literal"]);
            if (strNodes.length > 0) {
              target = strNodes[0].text.replace(/^['"]|['"]$/g, "");
            } else {
              target = firstArg.text.trim();
            }
          }
        }
      } else {
        // No explicit targetArg: use the method name from callee as a meaningful target
        const method = callee.match(/\.(\w+)$/)?.[1];
        if (method) target = method;
      }

      patterns.push({
        kind: rule.kind,
        target,
        detail: rule.template.replace("{target}", target),
        line: argPart.startPosition.row + 1,
      });
      break;
    }
  }

  // Pass 2 — Firebase class identifier references (instance access, property refs)
  const FIREBASE_IDS: Record<
    string,
    { kind: InfraKind; target: string; detail: string }
  > = {
    FirebaseFirestore: {
      kind: "firebase_firestore",
      target: "firestore",
      detail: "Initializes Firestore instance",
    },
    FirebaseAuth: {
      kind: "firebase_auth",
      target: "firebase_auth",
      detail: "Initializes Firebase Auth",
    },
    FirebaseStorage: {
      kind: "firebase_storage",
      target: "firebase_storage",
      detail: "Initializes Firebase Storage",
    },
    FirebaseMessaging: {
      kind: "firebase_messaging",
      target: "fcm",
      detail: "Initializes Firebase Messaging (FCM)",
    },
    FirebaseDatabase: {
      kind: "firebase_realtime_db",
      target: "realtime_db",
      detail: "Initializes Firebase Realtime Database",
    },
    FirebaseCrashlytics: {
      kind: "firebase_crashlytics",
      target: "crashlytics",
      detail: "Initializes Firebase Crashlytics",
    },
    FirebaseAnalytics: {
      kind: "firebase_analytics",
      target: "analytics",
      detail: "Initializes Firebase Analytics",
    },
    // Additional property-access patterns (no parentheses in Dart)
    DatabaseReference: {
      kind: "firebase_realtime_db",
      target: "realtime_db",
      detail: "Realtime DB reference",
    },
    onValue: {
      kind: "firebase_realtime_db",
      target: "realtime_db",
      detail: "Realtime DB stream: onValue",
    },
    onChildAdded: {
      kind: "firebase_realtime_db",
      target: "realtime_db",
      detail: "Realtime DB stream: onChildAdded",
    },
    recordFlutterFatalError: {
      kind: "firebase_crashlytics",
      target: "crashlytics",
      detail: "Crashlytics: Flutter fatal error handler",
    },
  };

  const seenId = new Set<string>(); // deduplicate per kind+line
  for (const id of findAll(root, ["identifier"])) {
    const info = FIREBASE_IDS[id.text];
    if (!info) continue;
    const key = `${info.kind}:${id.startPosition.row}`;
    if (seenId.has(key)) continue;
    seenId.add(key);
    patterns.push({ ...info, line: id.startPosition.row + 1 });
  }

  return patterns;
}
