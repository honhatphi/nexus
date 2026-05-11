// ─────────────────────────────────────────────────────────────
// Architecture Fingerprint (Phase D1)
// Detects frameworks, transports, datastores, deployment mode
// and languages from the parsed service content.
// ─────────────────────────────────────────────────────────────

import type { PipelineContext } from "./types.js";

export interface ServiceFingerprint {
  frameworks: string[];
  transports: string[];
  datastores: string[];
  deployment: "docker_compose" | "k8s" | "unknown";
  languages: string[];
}

// ── Detection Patterns ────────────────────────────────────────

const FRAMEWORK_PATTERNS: Record<string, RegExp[]> = {
  express: [/\brequire\(['"]express['"]\)/, /from ['"]express['"]/],
  nestjs: [/from ['"]@nestjs\//],
  fastapi: [/from fastapi import/, /FastAPI\(\)/],
  django: [/from django/, /django\.urls/],
  flask: [/from flask import/, /Flask\(__name__\)/],
  spring: [/@SpringBootApplication/, /@RestController/],
  gin: [/gin\.Default\(\)/, /gin\.New\(\)/],
  fiber: [/fiber\.New\(\)/],
  laravel: [/use Illuminate\\/, /artisan/],
  airflow: [/from airflow/, /DAG\(/, /PythonOperator/],
};

const DATASTORE_PATTERNS: Record<string, RegExp[]> = {
  postgres: [/postgres|postgresql|pg\.Pool|psycopg2|asyncpg/i],
  mongodb: [/mongodb|mongoose|pymongo|MongoClient/i],
  elasticsearch: [/elasticsearch|elastic_search|Elasticsearch/i],
  redis: [/redis\.Redis|aioredis|ioredis|redis\.from_url/i],
  mysql: [/mysql|pymysql|aiomysql/i],
};

const TRANSPORT_PATTERNS: Record<string, RegExp[]> = {
  http: [/axios|fetch\(|requests\.get|requests\.post|httpx/i],
  grpc: [/grpc\.|proto\.load|stub\.|GrpcModule/i],
  kafka: [/KafkaProducer|kafka\.producer|confluent_kafka|aiokafka/i],
  rabbitmq: [/pika\.BlockingConnection|amqp|RabbitmqModule/i],
  redis_pub: [/\.publish\(|redis.*pubsub/i],
  sqs: [/boto3.*sqs|SQSClient|send_message/i],
  nats: [/nats\.connect|NatsModule/i],
};

// ── Fingerprint Builder ───────────────────────────────────────

export function buildFingerprint(ctx: PipelineContext): ServiceFingerprint {
  const languages = Array.from(ctx.stats.languages);
  const frameworks = new Set<string>();
  const transports = new Set<string>();
  const datastores = new Set<string>();
  let deployment: ServiceFingerprint["deployment"] = "unknown";

  for (const [, parseResult] of ctx.parseResults) {
    const content = Object.entries(parseResult)
      .filter(([k]) => k === "rawContent" || k === "file")
      .map(([, v]) => String(v ?? ""))
      .join(" ");

    // Check frameworks
    for (const [name, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
      if (patterns.some((p) => p.test(content))) frameworks.add(name);
    }

    // Check datastores via infra patterns
    for (const ip of parseResult.infraPatterns ?? []) {
      if (ip.kind === "db_postgres") datastores.add("postgres");
      if (ip.kind === "db_mongo") datastores.add("mongodb");
      if (ip.kind === "db_elasticsearch") datastores.add("elasticsearch");
      if (ip.kind === "kafka_produce" || ip.kind === "kafka_consume")
        transports.add("kafka");
      if (ip.kind === "http_request" || ip.kind === "http_route_define")
        transports.add("http");
      if (ip.kind === "grpc_call" || ip.kind === "grpc_serve")
        transports.add("grpc");
      if (ip.kind === "rabbitmq_publish" || ip.kind === "rabbitmq_consume")
        transports.add("rabbitmq");
      if (ip.kind === "redis_publish" || ip.kind === "redis_subscribe")
        transports.add("redis_pub");
      if (ip.kind === "sqs_send" || ip.kind === "sqs_receive")
        transports.add("sqs");
      if (ip.kind === "nats_publish" || ip.kind === "nats_subscribe")
        transports.add("nats");
    }

    // Deployment detection from file names
    if (parseResult.file.includes("docker-compose"))
      deployment = "docker_compose";
    if (parseResult.file.match(/k8s|kubernetes|helm|Chart\.yaml/))
      deployment = "k8s";
  }

  // Datastore content-based detection fallback
  for (const [, parseResult] of ctx.parseResults) {
    const allCode = parseResult.symbols
      .map((s) => s.calls.map((c) => c.name).join(" "))
      .join(" ");
    for (const [name, patterns] of Object.entries(DATASTORE_PATTERNS)) {
      if (patterns.some((p) => p.test(allCode))) datastores.add(name);
    }
    for (const [name, patterns] of Object.entries(TRANSPORT_PATTERNS)) {
      if (patterns.some((p) => p.test(allCode))) transports.add(name);
    }
  }

  return {
    frameworks: Array.from(frameworks),
    transports: Array.from(transports),
    datastores: Array.from(datastores),
    deployment,
    languages,
  };
}
