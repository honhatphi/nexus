// ─────────────────────────────────────────────────────────────
// Infrastructure Pattern Detection — unit tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { CodeParser } from "../src/universal-parser.js";

const parser = new CodeParser();

describe("Infrastructure Detection — Kafka", () => {
  it("detects Kafka produce calls", async () => {
    const py = `
def send_event(event):
    producer.produce("order_events", event)
`;
    const result = await parser.parseSource("kafka.py", py);
    expect(result.infraPatterns.length).toBeGreaterThanOrEqual(1);
    const kafka = result.infraPatterns.find((p) => p.kind === "kafka_produce");
    expect(kafka).toBeDefined();
    expect(kafka!.target).toBe("order_events");
    expect(kafka!.detail).toContain("order_events");
  });

  it("detects Kafka consume calls with keyword args", async () => {
    const py = `
def consume_events():
    consumer.consume_batch(topic="inventory_updates", group_id="sync-group")
`;
    const result = await parser.parseSource("consumer.py", py);
    const kafka = result.infraPatterns.find((p) => p.kind === "kafka_consume");
    expect(kafka).toBeDefined();
    expect(kafka!.target).toBe("inventory_updates");
    expect(kafka!.metadata?.group_id).toBe("sync-group");
  });

  it("detects KafkaConsumer constructor", async () => {
    const py = `
def setup():
    consumer = KafkaConsumer("topic_name", group_id="my-group")
`;
    const result = await parser.parseSource("setup.py", py);
    const kafka = result.infraPatterns.find((p) => p.kind === "kafka_consume");
    expect(kafka).toBeDefined();
    expect(kafka!.target).toBe("topic_name");
  });
});

describe("Infrastructure Detection — PostgreSQL", () => {
  it("detects PostgresHook", async () => {
    const py = `
def run_query():
    hook = PostgresHook(postgres_conn_id="warehouse_db")
    hook.execute("SELECT 1")
`;
    const result = await parser.parseSource("db.py", py);
    const pg = result.infraPatterns.find(
      (p) => p.kind === "db_postgres" && p.target === "warehouse_db",
    );
    expect(pg).toBeDefined();
  });
});

describe("Infrastructure Detection — MongoDB", () => {
  it("detects MongoHook", async () => {
    const py = `
def get_data():
    hook = MongoHook(conn_id="mongo_prod")
    data = hook.find({})
`;
    const result = await parser.parseSource("mongo.py", py);
    const mongo = result.infraPatterns.find(
      (p) => p.kind === "db_mongo" && p.target === "mongo_prod",
    );
    expect(mongo).toBeDefined();
  });
});

describe("Infrastructure Detection — Elasticsearch", () => {
  it("detects Elasticsearch constructor", async () => {
    const py = `
def search():
    es = Elasticsearch(index="products")
    results = es.search(query)
`;
    const result = await parser.parseSource("es.py", py);
    const esPat = result.infraPatterns.find(
      (p) => p.kind === "db_elasticsearch",
    );
    expect(esPat).toBeDefined();
  });
});

describe("Infrastructure Detection — HTTP", () => {
  it("detects requests.post with URL", async () => {
    const py = `
def notify():
    requests.post("https://api.example.com/webhook", data=payload)
`;
    const result = await parser.parseSource("http.py", py);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
    expect(http!.target).toContain("api.example.com");
  });

  it("detects requests.get", async () => {
    const py = `
def fetch_config():
    resp = requests.get("https://config.svc/settings")
`;
    const result = await parser.parseSource("config.py", py);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
  });
});

describe("Infrastructure Detection — deduplication", () => {
  it("deduplicates same kind+target across multiple calls", async () => {
    const py = `
def multi_send():
    producer.produce("events", msg1)
    producer.produce("events", msg2)
    producer.produce("events", msg3)
`;
    const result = await parser.parseSource("dedup.py", py);
    const kafkaPats = result.infraPatterns.filter(
      (p) => p.kind === "kafka_produce" && p.target === "events",
    );
    expect(kafkaPats.length).toBe(1); // deduplicated
  });
});

describe("Infrastructure Detection — env var target", () => {
  it("extracts env var reference as target", async () => {
    const py = `
import os

def send():
    topic = os.getenv("KAFKA_TOPIC")
    producer.produce(topic)
`;
    const result = await parser.parseSource("env.py", py);
    const kafka = result.infraPatterns.find((p) => p.kind === "kafka_produce");
    expect(kafka).toBeDefined();
    // topic is an identifier → prefixed with $
    expect(kafka!.target).toBe("$topic");
  });
});
