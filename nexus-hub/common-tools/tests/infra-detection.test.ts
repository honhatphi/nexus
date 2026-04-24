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

// ─────────────────────────────────────────────────────────────
// P0: JS/TS HTTP client detection
// ─────────────────────────────────────────────────────────────

describe("Infrastructure Detection — JS/TS HTTP clients", () => {
  it("detects fetch() call", async () => {
    const ts = `
async function loadProducts() {
  const res = await fetch("/api/products");
  return res.json();
}
`;
    const result = await parser.parseSource("api.ts", ts);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
    expect(http!.target).toContain("products");
  });

  it("detects axios.get()", async () => {
    const ts = `
async function getUser(id: string) {
  const res = await axios.get("/api/users/" + id);
  return res.data;
}
`;
    const result = await parser.parseSource("user.ts", ts);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
  });

  it("detects axios.post() and extracts method", async () => {
    const ts = `
async function createOrder(data: Order) {
  return axios.post("/api/orders", data);
}
`;
    const result = await parser.parseSource("order.ts", ts);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
    expect(http!.metadata?.method).toBe("POST");
  });

  it("detects ky.get()", async () => {
    const ts = `
async function fetchConfig() {
  return ky.get("/api/config").json();
}
`;
    const result = await parser.parseSource("config.ts", ts);
    const http = result.infraPatterns.find((p) => p.kind === "http_request");
    expect(http).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// P0: BE route definition detection
// ─────────────────────────────────────────────────────────────

describe("Infrastructure Detection — BE route definitions (Express/JS)", () => {
  it("detects router.get()", async () => {
    const ts = `
router.get("/api/products", async (req, res) => {
  const products = await ProductService.findAll();
  res.json(products);
});
`;
    const result = await parser.parseSource("products.route.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route).toBeDefined();
    expect(route!.target).toContain("products");
    expect(route!.metadata?.method).toBe("GET");
  });

  it("detects app.post()", async () => {
    const ts = `
app.post("/api/orders", validateBody, async (req, res) => {
  const order = await OrderService.create(req.body);
  res.status(201).json(order);
});
`;
    const result = await parser.parseSource("app.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route).toBeDefined();
    expect(route!.metadata?.method).toBe("POST");
  });

  it("detects router.delete()", async () => {
    const ts = `
router.delete("/api/products/:id", async (req, res) => {
  await ProductService.remove(req.params.id);
  res.sendStatus(204);
});
`;
    const result = await parser.parseSource("products.route.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route).toBeDefined();
    expect(route!.metadata?.method).toBe("DELETE");
  });
});

describe("Infrastructure Detection — BE route definitions (FastAPI/Python)", () => {
  it("detects @app.get() decorator", async () => {
    const py = `
@app.get("/api/products")
async def list_products():
    return db.query(Product).all()
`;
    const result = await parser.parseSource("routes.py", py);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route).toBeDefined();
    expect(route!.target).toContain("products");
    expect(route!.metadata?.method).toBe("GET");
  });

  it("detects @router.post() decorator", async () => {
    const py = `
@router.post("/api/orders")
async def create_order(data: OrderCreate):
    return await order_service.create(data)
`;
    const result = await parser.parseSource("orders.py", py);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route).toBeDefined();
    expect(route!.metadata?.method).toBe("POST");
  });
});

describe("Infrastructure Detection — http_route_define method extraction", () => {
  it("extracts GET method from router.get", async () => {
    const ts = `
router.get("/health", (req, res) => res.json({ ok: true }));
`;
    const result = await parser.parseSource("health.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route?.metadata?.method).toBe("GET");
  });

  it("extracts PUT method from router.put", async () => {
    const ts = `
router.put("/api/users/:id", updateUser);
`;
    const result = await parser.parseSource("users.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route?.metadata?.method).toBe("PUT");
  });

  it("extracts PATCH method from router.patch", async () => {
    const ts = `
router.patch("/api/users/:id/status", patchStatus);
`;
    const result = await parser.parseSource("users.ts", ts);
    const route = result.infraPatterns.find(
      (p) => p.kind === "http_route_define",
    );
    expect(route?.metadata?.method).toBe("PATCH");
  });
});
