# Plan: Cross-Service Knowledge Base — Microservice Integration

**Ngày tạo:** 2026-04-23  
**Nhánh triển khai:** `feature/cross-service-kb-microservice`  
**Ưu tiên:** P0 → P1 → P2 (sequential)

---

## Mục tiêu

Bổ sung các gap trong pipeline để KB có thể liên kết đầy đủ các microservice lại với nhau — đặc biệt là FE ↔ BE thông qua HTTP/REST, gRPC, và các message queue ngoài Kafka.

---

## Trạng thái hiện tại (Baseline)

### Graph nodes/edges đã có
```
Nodes:  :Service :File :Function :Class
        :KafkaTopic :Database :HTTPEndpoint
        :Process :Community

Edges:  BELONGS_TO  File → Service
        DEFINED_IN  Function/Class → File
        CALLS       Function → Function  (confidence-scored)
        IMPORTS     File → File          (intra-service only)
        PRODUCES_TO Function → KafkaTopic
        CONSUMES_FROM Function → KafkaTopic
        ASYNC_TRIGGERS Function → Function  (cross-service Kafka ✅)
        HTTP_CALL   Function → HTTPEndpoint  (FE caller only, không nối BE)
        CONNECTS_TO Function → Database
        EXTENDS     Class → Class
        IMPLEMENTS  Class → Class
        METHOD_OF   Function → Class
        STEP_IN_PROCESS Function → Process
```

### Pipeline phases đã có
| Order | Phase | File | Status |
|-------|-------|------|--------|
| 0 | filesystem | phase-0-filesystem.ts | ✅ |
| 1 | parse | phase-1-parse.ts | ✅ |
| 2 | graph-upsert | phase-2-graph.ts | ✅ |
| 3 | vector-upsert | phase-3-vectors.ts | ✅ |
| 4 | metadata | phase-4-metadata.ts | ✅ |
| 5 | import-resolution | phase-5-imports.ts | ⚠️ intra-service only |
| 6 | heritage-detection | phase-6-heritage.ts | ✅ |
| 7 | community | phase-7-community.ts | ✅ |
| 7.5 | kafka-linkage | phase-8a-kafka-linkage.ts | ✅ cross-service |
| 8 | process-tracing | phase-8-process.ts | ✅ |
| 9 | type-resolution | phase-9-types.ts | ✅ |

---

## P0 — HTTP/REST Cross-Service Linking

> **Goal:** FE gọi `GET /api/products` → KB tự động link tới BE handler `getProducts()`.

### P0-T1: Bổ sung JS/TS HTTP client rules vào `infra-detection.ts`

**File:** `nexus-hub/common-tools/src/parser/infra-detection.ts`

Rules cần thêm vào `INFRA_RULES`:
```typescript
// fetch API (browser + Node 18+)
{ pattern: /^fetch$/, kind: "http_request", targetArg: 0, fallbackTarget: "<url>" }

// axios
{ pattern: /axios\.(get|post|put|patch|delete|request)$/, kind: "http_request", targetArg: 0 }
{ pattern: /\.get$|\.post$|\.put$|\.patch$|\.delete$/, kind: "http_request", targetArg: 0 }  // axios instance

// ky
{ pattern: /ky\.(get|post|put|patch|delete)$/, kind: "http_request", targetArg: 0 }

// got
{ pattern: /got\.(get|post|put|patch|delete)$/, kind: "http_request", targetArg: 0 }

// Node built-in
{ pattern: /https?\.request$|https?\.get$/, kind: "http_request", targetArg: 0 }
```

JS/TS argument extraction cần xử lý AST nodes: `arguments`, `string`, `template_string`.

### P0-T2: Thêm `InfraKind` mới cho BE route definitions

**File:** `nexus-hub/common-tools/src/types.ts`

```typescript
// Thêm vào InfraKind union:
| "http_route_define"
```

**File:** `nexus-hub/common-tools/src/parser/infra-detection.ts`

Rules BE route detection:
```typescript
// Express / Fastify (JS/TS)
{ pattern: /router\.(get|post|put|patch|delete|use)$|app\.(get|post|put|patch|delete)$/, kind: "http_route_define" }
// NestJS decorators — detect từ decorator syntax
{ pattern: /@(Get|Post|Put|Patch|Delete|Controller)$/, kind: "http_route_define" }
// FastAPI / Flask (Python)
{ pattern: /@(app|router|blueprint)\.(get|post|put|patch|delete)$/, kind: "http_route_define" }
// Spring Boot (Java)
{ pattern: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)$/, kind: "http_route_define" }
// Laravel (PHP)
{ pattern: /Route\.(get|post|put|patch|delete)$/, kind: "http_route_define" }
// ASP.NET (C#) — detect attribute syntax
{ pattern: /\[Http(Get|Post|Put|Patch|Delete|Route)\]/, kind: "http_route_define" }
```

### P0-T3: Thêm node `APIRoute` và edge `EXPOSES` vào graph

**File:** `nexus-hub/common-tools/src/pipeline/phase-2-graph.ts`

```
Node mới:  :APIRoute { path, method, service }
Edge mới:  EXPOSES   Function → APIRoute
```

Thêm vào `INFRA_LABELS` và `INFRA_EDGE`:
```typescript
INFRA_LABELS["http_route_define"] = "APIRoute"
INFRA_EDGE["http_route_define"] = "EXPOSES"
```

### P0-T4: Tạo phase-8b-http-linkage.ts (tương tự 8a)

**File mới:** `nexus-hub/common-tools/src/pipeline/phase-8b-http-linkage.ts`

```typescript
order: 7.6  // sau kafka-linkage (7.5), trước process-tracing (8)

// Logic:
// 1. Clean HTTP_TRIGGERS edges cũ của service
// 2. Match: caller -[:HTTP_CALL]-> ep -[path normalize]-> route <-[:EXPOSES]- handler
// 3. MERGE: caller -[:HTTP_TRIGGERS {via, method, mechanism: 'http'}]-> handler

// Path normalization: strip query strings, normalize trailing slash
// Fuzzy match: /api/products/{id} matches /api/products/:id

Cypher cốt lõi:
  MATCH (caller:Function)-[:HTTP_CALL]->(ep:HTTPEndpoint)
  MATCH (handler:Function)-[:EXPOSES]->(route:APIRoute)
  WHERE route.service <> caller.service
    AND (ep.name = route.path OR ep.name CONTAINS route.path)
  MERGE (caller)-[r:HTTP_TRIGGERS]->(handler)
  SET r.via = route.path, r.method = route.method, r.mechanism = 'http'
```

### P0-T5: Đăng ký phase-8b vào pipeline + exports

**Files:**
- `nexus-hub/common-tools/src/sync-tool.ts` — register phase
- `mcp-server/src/tools/sync-service.ts` — register phase
- `nexus-hub/common-tools/src/index.ts` — export httpLinkagePhase

### P0-T6: Tests cho P0

**Files:**
- `nexus-hub/common-tools/tests/infra-detection.test.ts` — thêm test cases cho JS/TS HTTP rules + route define
- `nexus-hub/common-tools/tests/pipeline.test.ts` — thêm test cho phase-8b

---

## P1 — OpenAPI / gRPC Support

> **Goal:** Tự động parse OpenAPI spec và gRPC .proto để tạo contract nodes.

### P1-T1: OpenAPI spec parser

**File:** `nexus-hub/common-tools/src/parser/openapi-spec.ts` (mới)

```
Detect: openapi.yaml, swagger.yaml, swagger.json
Extract:
  - paths → :APIContract { operationId, path, method, tags, service }
  - schemas → :DataSchema { name, service }

Edge mới: DEFINES_CONTRACT  Service → APIContract
          IMPLEMENTS_CONTRACT Function → APIContract  (match by operationId / path)
```

### P1-T2: gRPC detection rules

**File:** `nexus-hub/common-tools/src/parser/infra-detection.ts`

```typescript
InfraKind mới: "grpc_call", "grpc_serve"

// Python
{ pattern: /stub\.\w+$|grpc\.insecure_channel$|pb2_grpc\.\w+Stub$/, kind: "grpc_call" }
// Go
{ pattern: /pb\.New\w+Client$|conn\.\w+$/, kind: "grpc_call" }
// Java
{ pattern: /stub\.\w+$|ManagedChannelBuilder$/, kind: "grpc_call" }
// TypeScript/NestJS
{ pattern: /@GrpcMethod$|new \w+Client$/, kind: "grpc_serve" }
```

### P1-T3: Phase 8c — gRPC Linkage

**File mới:** `nexus-hub/common-tools/src/pipeline/phase-8c-grpc-linkage.ts`

```
order: 7.7

Node mới:  :GRPCService { name, package }
           :GRPCMethod { name, service_name }
Edge mới:  GRPC_CALLS  Function → GRPCMethod
           GRPC_SERVES Function → GRPCMethod
           GRPC_TRIGGERS Function → Function  (cross-service)
```

---

## P2 — Infrastructure Topology & Extended Messaging

> **Goal:** Hiểu cấu trúc Docker Compose, RabbitMQ, Redis Pub/Sub, SQS.

### P2-T1: Docker Compose parser

**File:** `nexus-hub/common-tools/src/parser/docker-compose.ts` (mới)

```
Detect: docker-compose.yml, docker-compose.*.yml
Extract:
  - services → :InfraService { name, image, port }
  - depends_on → DEPENDS_ON (InfraService → InfraService)
  - ports → EXPOSES_PORT
  - networks → IN_NETWORK
```

### P2-T2: Extended async messaging rules

**File:** `nexus-hub/common-tools/src/parser/infra-detection.ts`

```typescript
InfraKind mới: "rabbitmq_publish", "rabbitmq_consume",
               "redis_publish", "redis_subscribe",
               "sqs_send", "sqs_receive",
               "nats_publish", "nats_subscribe"

// RabbitMQ
{ pattern: /channel\.basic_publish$|\.publish$/, kind: "rabbitmq_publish" }
{ pattern: /channel\.basic_consume$|\.consume$/, kind: "rabbitmq_consume" }

// Redis Pub/Sub
{ pattern: /\.publish$/, kind: "redis_publish" }  // + redis context
{ pattern: /pubsub\.subscribe$|\.subscribe$/, kind: "redis_subscribe" }

// AWS SQS
{ pattern: /sqs\.send_message$/, kind: "sqs_send" }
{ pattern: /sqs\.receive_message$/, kind: "sqs_receive" }
```

### P2-T3: Mở rộng phase-8a thành async-linkage

**Rename/extend:** `phase-8a-kafka-linkage.ts` → handle tất cả async mechanisms

```typescript
// Thêm vào ASYNC_TRIGGERS query:
MATCH (p)-[:RABBITMQ_PUBLISH|REDIS_PUBLISH|SQS_SEND]->(q)<-[:RABBITMQ_CONSUME|REDIS_SUBSCRIBE|SQS_RECEIVE]-(c)
```

### P2-T4: Cross-service package dependency

**File:** `nexus-hub/common-tools/src/pipeline/phase-5-imports.ts`

```typescript
// Khi isExternal = true → tạo DEPENDS_ON_PACKAGE edge
MERGE (f:File {path: $source})
MERGE (pkg:Package {name: $module, version: $version})
MERGE (f)-[:DEPENDS_ON_PACKAGE]->(pkg)

// Sau khi sync nhiều service:
// Query: services nào share cùng Package node
```

---

## Thứ tự file cần tạo/sửa

### P0 (HTTP — 6 tasks)
| # | File | Action |
|---|------|--------|
| 1 | `nexus-hub/common-tools/src/types.ts` | Thêm `http_route_define` vào `InfraKind` |
| 2 | `nexus-hub/common-tools/src/parser/infra-detection.ts` | Thêm JS/TS HTTP client rules + BE route rules |
| 3 | `nexus-hub/common-tools/src/pipeline/phase-2-graph.ts` | Thêm `APIRoute` node + `EXPOSES` edge handling |
| 4 | `nexus-hub/common-tools/src/pipeline/phase-8b-http-linkage.ts` | **Tạo mới** |
| 5 | `nexus-hub/common-tools/src/sync-tool.ts` | Register phase-8b |
| 6 | `mcp-server/src/tools/sync-service.ts` | Register phase-8b |
| 7 | `nexus-hub/common-tools/src/index.ts` | Export httpLinkagePhase |
| 8 | `nexus-hub/common-tools/tests/infra-detection.test.ts` | Thêm test cases P0 |

### P1 (OpenAPI + gRPC — 3 tasks)
| # | File | Action |
|---|------|--------|
| 9 | `nexus-hub/common-tools/src/parser/openapi-spec.ts` | **Tạo mới** |
| 10 | `nexus-hub/common-tools/src/parser/infra-detection.ts` | Thêm gRPC rules |
| 11 | `nexus-hub/common-tools/src/pipeline/phase-8c-grpc-linkage.ts` | **Tạo mới** |

### P2 (Infra Topology + Extended Messaging — 4 tasks)
| # | File | Action |
|---|------|--------|
| 12 | `nexus-hub/common-tools/src/parser/docker-compose.ts` | **Tạo mới** |
| 13 | `nexus-hub/common-tools/src/parser/infra-detection.ts` | Thêm RabbitMQ/Redis/SQS rules |
| 14 | `nexus-hub/common-tools/src/pipeline/phase-8a-kafka-linkage.ts` | Mở rộng sang async-linkage chung |
| 15 | `nexus-hub/common-tools/src/pipeline/phase-5-imports.ts` | Cross-service package edges |

---

## Graph schema cuối (target state)

```
Nodes:
  :Service :File :Function :Class
  :KafkaTopic :Database :HTTPEndpoint
  :APIRoute { path, method, service }         ← NEW (P0)
  :APIContract { operationId, path, method }  ← NEW (P1)
  :DataSchema { name, service }               ← NEW (P1)
  :GRPCService :GRPCMethod                    ← NEW (P1)
  :InfraService { name, image, port }         ← NEW (P2)
  :Package { name, version }                  ← NEW (P2)
  :Process :Community

Edges:
  BELONGS_TO  DEFINED_IN  CALLS  IMPORTS
  PRODUCES_TO  CONSUMES_FROM
  ASYNC_TRIGGERS { mechanism: kafka|rabbitmq|redis|sqs }   ← EXTENDED (P2)
  HTTP_CALL   Function → HTTPEndpoint
  EXPOSES     Function → APIRoute                           ← NEW (P0)
  HTTP_TRIGGERS Function → Function { via, method }        ← NEW (P0)
  DEFINES_CONTRACT  Service → APIContract                  ← NEW (P1)
  IMPLEMENTS_CONTRACT Function → APIContract               ← NEW (P1)
  GRPC_CALLS  Function → GRPCMethod                        ← NEW (P1)
  GRPC_SERVES Function → GRPCMethod                        ← NEW (P1)
  GRPC_TRIGGERS Function → Function                        ← NEW (P1)
  CONNECTS_TO  EXTENDS  IMPLEMENTS  METHOD_OF
  STEP_IN_PROCESS
  DEPENDS_ON  InfraService → InfraService                  ← NEW (P2)
  DEPENDS_ON_PACKAGE File → Package                        ← NEW (P2)
```

---

## Useful cross-service queries sau khi hoàn thành

```cypher
-- 1. FE function nào gọi BE function nào qua HTTP?
MATCH (fe:Function)-[:HTTP_TRIGGERS]->(be:Function)
WHERE fe.service <> be.service
RETURN fe.service, fe.name, be.service, be.name

-- 2. Toàn bộ cross-service dependencies (tất cả mechanisms)
MATCH (a:Function)-[r:HTTP_TRIGGERS|ASYNC_TRIGGERS|GRPC_TRIGGERS]->(b:Function)
WHERE a.service <> b.service
RETURN a.service, a.name, type(r), r.mechanism, b.service, b.name

-- 3. Service nào expose route /api/products?
MATCH (fn:Function)-[:EXPOSES]->(r:APIRoute)
WHERE r.path CONTAINS '/products'
RETURN fn.service, fn.name, r.path, r.method

-- 4. Tất cả services phụ thuộc vào nhau qua Kafka + HTTP
MATCH path = (s1:Service)<-[:BELONGS_TO]-(f1:Function)
             -[:HTTP_TRIGGERS|ASYNC_TRIGGERS]->(f2:Function)
             -[:BELONGS_TO]->(s2:Service)
WHERE s1 <> s2
RETURN s1.name, s2.name, count(path) AS touchpoints
ORDER BY touchpoints DESC
```
