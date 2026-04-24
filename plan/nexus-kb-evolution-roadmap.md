# Nexus KB Evolution Roadmap

> **Ngày tạo**: 2026-04-24  
> **Branch hiện tại**: `feature/cross-service-kb-microservice`  
> **Status**: P0 + P1 + P2 đã hoàn thành và pushed. Plan này mô tả **giai đoạn tiếp theo**.

---

## 1. Tổng quan kiến trúc hiện tại

### 1.1 Hub & Spoke Model

```
┌─────────────────────────────── Nexus Repo ──────────────────────────────────┐
│                                                                             │
│   nexus-hub/                                                                │
│   ├── common-tools/    ← TypeScript pipeline + parsers (source of truth)    │
│   └── skills/          ← Agent skill definitions (code-review, debugging…)  │
│                                                                             │
│   mcp-server/          ← MCP HTTP gateway (port 13100) — 10 tools           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
         ▲  sync_service_knowledge(path)          ▲  query / search
         │                                        │
┌────────┴────────────────────────────────────────┴────────────────────────┐
│                       Hub Manager Agent                                  │
│   Người dùng / CI trigger → Hub Manager gọi MCP tools để sync/query      │
└──────────┬─────────────────────────────────────────────────────┬─────────┘
           │ post-push / post-merge hook                         │on-demand
           ▼                                                     ▼
┌──────────────────────────┐         ┌──────────────────────────────────────┐
│  External Service Repos  │         │       Agents (Search, Coder, …)      │
│  (git-ignored trong      │         │  KB-First: query KB trước,           │
│   Nexus, có repo riêng)  │         │  chỉ đọc source khi KB chưa đủ       │
│                          │         └──────────────────────────────────────┘
│  warehouse-2.0           │
│  service-B               │   ← Global git hooks (cài 1 lần trên máy):
│  service-C               │     post-push + post-merge → tự động sync KB
└──────────────────────────┘
```

**Nguyên tắc vận hành cốt lõi:**

- Agents **KB-First**: luôn query KB trước — chỉ đọc source code khi KB không đủ context để giải quyết vấn đề
- Source code được pipeline chạm vào qua `sync_service_knowledge` (incremental — chỉ file thay đổi)
- KB là **interface ưu tiên** giữa agents và codebase
- Global git hooks trên máy đảm bảo KB **tự động cập nhật sau mỗi push/pull**

### 1.2 Pipeline 10 Phase (hiện tại)

| Phase | File                            | Chức năng                                              |
| ----- | ------------------------------- | ------------------------------------------------------ |
| 0     | `phase-0-filesystem.ts`         | Scan file, hash staleness                              |
| 1     | `phase-1-parse.ts`              | Tree-sitter AST parse + OpenAPI/Docker Compose parsers |
| 2     | `phase-2-graph.ts`              | Upsert nodes/edges vào Memgraph                        |
| 3     | `phase-3-vectors.ts`            | Embed vectors vào ChromaDB                             |
| 4     | `phase-4-metadata.ts`           | Git metadata, staleness tracking                       |
| 5     | `phase-5-imports.ts`            | Import resolution                                      |
| 6     | `phase-6-heritage.ts`           | Class inheritance, interface implementation            |
| 7     | `phase-7-community.ts`          | Louvain community detection                            |
| 7.5   | `phase-8a-kafka-linkage.ts`     | ASYNC_TRIGGERS qua Kafka topic                         |
| 7.6   | `phase-8b-http-linkage.ts`      | HTTP_TRIGGERS cross-service (FE→BE)                    |
| 7.7   | `phase-8c-grpc-linkage.ts`      | GRPC_TRIGGERS cross-service                            |
| 7.8   | `phase-8d-messaging-linkage.ts` | ASYNC_TRIGGERS qua RabbitMQ/Redis/SQS/NATS             |
| 8     | `phase-8-process.ts`            | Business process tracing                               |
| 9     | `phase-9-types.ts`              | Type resolution                                        |

### 1.3 Graph Schema hiện tại

**Nodes:**

| Label            | Count (live) | Ý nghĩa                     |
| ---------------- | ------------ | --------------------------- |
| `Function`       | 3 965        | Hàm/method                  |
| `File`           | 465          | File nguồn                  |
| `Task`           | 346          | Airflow Task                |
| `Class`          | 193          | Class/Interface             |
| `DAG`            | 115          | Airflow DAG                 |
| `Database`       | 53           | DB connection target        |
| `Community`      | 41           | Louvain cluster             |
| `KafkaTopic`     | 5            | Kafka topic                 |
| `HTTPEndpoint`   | 2            | HTTP endpoint được call     |
| `APIRoute`       | 0            | Chờ có service expose route |
| `GRPCEndpoint`   | 0            | Chờ có service gRPC         |
| `MessageQueue`   | 0            | Chờ có RabbitMQ/SQS service |
| `MessageChannel` | 0            | Chờ có Redis/NATS service   |
| `Service`        | 1            | warehouse-2.0               |

**Edges (top 14):**

| Type             | Count | Ý nghĩa                     |
| ---------------- | ----- | --------------------------- |
| `CALLS`          | 7 346 | Lời gọi hàm                 |
| `DEFINED_IN`     | 1 670 | Hàm định nghĩa trong file   |
| `BELONGS_TO`     | 811   | File thuộc service          |
| `DEPENDS_ON`     | 540   | Task phụ thuộc task         |
| `MEMBER_OF`      | 493   | Hàm/class thuộc community   |
| `EXTENDS`        | 480   | Kế thừa class (TS heritage) |
| `INHERITS`       | 479   | Kế thừa class (Python)      |
| `METHOD_OF`      | 426   | Method thuộc class          |
| `INVOKES`        | 192   | Airflow task invoke         |
| `CONNECTS_TO`    | 171   | Kết nối DB                  |
| `CONTAINS`       | 115   | DAG chứa task               |
| `PRODUCES_TO`    | 23    | Kafka produce               |
| `CONSUMES_FROM`  | 18    | Kafka consume               |
| `HTTP_CALL`      | 8     | HTTP call đi ra             |
| `HTTP_TRIGGERS`  | 0     | Chờ 2+ services             |
| `GRPC_TRIGGERS`  | 0     | Chờ 2+ services             |
| `ASYNC_TRIGGERS` | 0     | Chờ 2+ services             |

### 1.4 MCP Tools (10 tools đang live)

| Tool                     | Mô tả                                      |
| ------------------------ | ------------------------------------------ |
| `sync_service_knowledge` | Parse service → upsert Memgraph + ChromaDB |
| `parse_code`             | Parse file/snippet với tree-sitter         |
| `query_graph`            | Cypher read-only query                     |
| `search_knowledge_base`  | Semantic/hybrid search ChromaDB            |
| `get_impact_analysis`    | Trace transitive dependencies              |
| `check_staleness`        | Detect service KB lỗi thời                 |
| `augment`                | Tìm symbol + callers/callees context       |
| `get_symbol_context`     | 360° view của một symbol                   |
| `detect_changes`         | Diff code kể từ commit ref                 |
| `get_process_flows`      | Extract business process flows             |

### 1.5 Parser Coverage

**Ngôn ngữ**: Go, Python, PHP, TypeScript, JavaScript, Java, C#, YAML  
**Infra detection** (`InfraKind`):

```
Kafka:    kafka_produce, kafka_consume
Database: db_postgres, db_mongo, db_elasticsearch
HTTP:     http_request, http_route_define  (+ OpenAPI spec parser)
gRPC:     grpc_call, grpc_serve
RabbitMQ: rabbitmq_publish, rabbitmq_consume
Redis:    redis_publish, redis_subscribe
SQS:      sqs_send, sqs_receive
NATS:     nats_publish, nats_subscribe
```

### 1.6 Auto-Sync Hook Architecture

2 git hooks được cài **global trên máy** (giống pattern `~/.copilot/hooks/`) — hoạt động tự động cho **bất kỳ repo nào** trên máy mà không cần cài per-repo, không can thiệp CI/CD của external service:

```
Developer                 Git Remote              Nexus MCP            KB
    │                         │                      │                  │
    │──── git push ──────────▶│                      │                  │
    │◀─── push success ───────│                      │                  │
    │                         │                      │                  │
    │  [global post-push]────────────────────────── ▶│                  │
    │  (background, async)                           │ sync incremental │
    │                                                │─────────────────▶│
    │                                                │ (chỉ file mới)   │
    │──── git pull ──────────▶│                      │                  │
    │◀─── pull complete ──────│                      │                  │
    │                         │                      │                  │
    │  [global post-merge]───────────────────────── ▶│                  │
    │  (nếu có MERGE_HEAD,    │                      │ sync incremental │
    │   background, async)    │                      │─────────────────▶│
```

**Trigger conditions:**
| Hook | Khi nào chạy | Ghi chú |
|---|---|---|
| `post-push` | Sau khi push thành công lên remote | Sync các file đã thay đổi trong commit vừa push |
| `post-merge` | Sau `git pull` hoặc `git merge` khi có commit mới về | Chỉ chạy nếu `MERGE_HEAD` tồn tại — có code mới merge vào |

**Hook behavior:**

```bash
# Chạy hoàn toàn async — KHÔNG block git push/pull
# Log kết quả vào ~/.nexus/sync.log
# Incremental: force_update=false — CHỈ re-parse file có thay đổi, không chạy lại toàn bộ
# Silent fail nếu MCP unavailable — ghi warning vào log, không crash
NEXUS_MCP_URL="${NEXUS_MCP_URL:-http://localhost:13100}"
```

**Cài đặt global (1 lần trên máy, áp dụng cho mọi repo):**

```bash
# Tương tự ~/.copilot/hooks/ — global git config
bash /path/to/nexus/scripts/install-global-hooks.sh
# Kết quả: git config --global core.hooksPath ~/.nexus/hooks/
```

**Không can thiệp CI/CD**: Hooks chỉ chạy local trên máy developer. Remote CI/CD của external services không bị ảnh hưởng.

---

## 2. Vấn đề cần giải quyết (Gap Analysis)

### Gap 1: KB chỉ có 1 service — cross-service edges chưa thể hoạt động

- `HTTP_TRIGGERS`, `GRPC_TRIGGERS`, `ASYNC_TRIGGERS` = 0 vì chỉ có 1 service được onboard vào KB.
- Cần ≥ 2 external services được sync qua Hub Manager để linkage phases tạo được edges thực sự.
- Không có cơ chế tự động giữ KB fresh — phải sync thủ công qua Hub Manager mỗi khi service thay đổi.
- **Giải pháp**: Auto-sync hook (post-push + post-merge) trên từng external service repo → KB luôn cập nhật.

### Gap 2: Vector KB không ổn định

- ChromaDB collection đôi khi trả `ChromaNotFoundError`.
- Chưa có health-check bootstrap trước khi sync.
- Semantic search (`search_knowledge_base`) unreliable.

### Gap 3: Không có data quality assertion

- `confidence` trên edge suy luận có thể null.
- Orphan edges có thể tồn tại sau resync partial.
- Không có constraint/index trong Memgraph để đảm bảo uniqueness.

### Gap 4: Không có kiến trúc diff và hotspot scoring

- Mỗi lần sync overwrite không lưu snapshot trước đó.
- Không biết được thay đổi kiến trúc giữa 2 lần sync.
- Không có metric nào đo mức độ coupling hay blast radius thay đổi theo thời gian.

### Gap 5: Không có cơ chế self-adjusting khi có kiến trúc mới

- Pattern mới (ví dụ framework chưa biết) sẽ không được detect.
- Không có candidate promotion flow khi có rule cần thêm vào.

### Gap 6: Không có CI/CD integration

- Hiện test E2E là script thủ công.
- Không có quality gate tự động trong PR.

---

## 3. Roadmap nâng cấp

### Phase A — Ổn định nền KB & Auto-Sync Infrastructure (Tuần 1–2)

**Mục tiêu**: KB hoạt động ổn định, tự động cập nhật khi code thay đổi, multi-service ready.

**Deliverables:**

- [ ] **A1** Tạo ChromaDB bootstrap script — khởi tạo collection nếu chưa tồn tại, verify sau khi tạo.
- [ ] **A2** Thêm `preSync` health check vào `sync-tool.ts` — fail fast nếu Memgraph hoặc ChromaDB unreachable.
- [ ] **A3** Triển khai auto-sync git hook **global trên máy** (pattern giống `~/.copilot/hooks/`):
  - **`post-push`** — chạy async sau push → gọi `sync_service_knowledge` với `force_update=false` cho repo hiện tại
  - **`post-merge`** — chạy async sau pull/merge khi `MERGE_HEAD` tồn tại → incremental sync chỉ file thay đổi
  - Hook **không block** push/pull, **không can thiệp CI/CD** của external service — chỉ local
  - Config qua `NEXUS_MCP_URL` env var (default: `http://localhost:13100`), log vào `~/.nexus/sync.log`
- [ ] **A4** Tạo script `scripts/install-global-hooks.sh` — cài 1 lần trên máy, áp dụng cho **mọi repo** qua `git config --global core.hooksPath ~/.nexus/hooks/`.
- [ ] **A5** Onboard ít nhất 1 external service thứ hai vào KB qua Hub Manager (gọi `sync_service_knowledge`), ưu tiên service có REST API hoặc gRPC để cross-service edges có thể hình thành.
- [ ] **A6** Viết integration test `test-cross-service.mjs` — verify `HTTP_TRIGGERS` / `ASYNC_TRIGGERS` count > 0.
- [ ] **A7** Thêm Memgraph index constraint cho các node identity:
  ```cypher
  CREATE CONSTRAINT ON (f:Function) ASSERT (f.name, f.file, f.service) IS NODE KEY;
  CREATE CONSTRAINT ON (r:APIRoute) ASSERT (r.path, r.method, r.service) IS NODE KEY;
  ```

**Exit criteria:**

- `test-sync.mjs` pass 100%.
- `test-new-tools.mjs` pass 100% (bao gồm `search_knowledge_base`).
- Hook tự động chạy sau push và sau pull, KB cập nhật trong vòng 60 giây.
- Graph có ≥ 2 services và ≥ 1 cross-service trigger edge.

---

### Phase B — Canonical Schema v1 (Tuần 2)

**Mục tiêu**: Mọi node/edge có đủ metadata chuẩn để có thể diff và audit.

**Deliverables:**

- [ ] **B1** Định nghĩa `SCHEMA_VERSION = "1.0"` — set trên mọi node khi upsert.
- [ ] **B2** Chuẩn hóa bắt buộc cho mọi edge suy luận: `source`, `confidence`, `firstSeenAt`, `lastSeenAt`.
- [ ] **B3** Tạo `phase-10-schema-validate.ts` — sau khi sync, scan và flag record thiếu field bắt buộc.
- [ ] **B4** Cập nhật `phase-2-graph.ts` — thêm `schemaVersion`, `firstSeenAt` khi MERGE (chỉ SET nếu null), `lastSeenAt` luôn update.
- [ ] **B5** Tạo `schema-registry.ts` — định nghĩa canonical node types và required properties.

**Canonical Node Properties (v1):**

```typescript
interface CanonicalNode {
  schemaVersion: "1.0";
  service: string;
  firstSeenAt: number; // timestamp ms
  lastSeenAt: number; // timestamp ms
  source: string; // "code" | "openapi_spec" | "docker_compose" | "grpc_proto"
}
```

**Exit criteria:**

- 100% node mới tạo có `schemaVersion = "1.0"`.
- `phase-10-schema-validate.ts` pass trên tất cả services đã sync.

---

### Phase C — Graph Diff Engine (Tuần 3–4)

**Mục tiêu**: Phát hiện thay đổi kiến trúc giữa các lần sync và sinh hotspot report.

**Deliverables:**

- [ ] **C1** Tạo `phase-4b-snapshot.ts` — lưu fingerprint của graph state theo commit hash.
  - Lưu: node counts per label, edge counts per type, danh sách APIRoute/GRPCEndpoint/MessageQueue.
- [ ] **C2** Tạo `graph-diff.ts` — tính semantic diff giữa 2 snapshots:
  - `addedNodes`, `removedNodes`, `changedNodes`
  - `addedEdges`, `removedEdges`
  - `contractDrift` (APIRoute/GRPCEndpoint path/method thay đổi)
  - `blastRadiusChange` (hàm X có blast radius tăng > threshold)
- [ ] **C3** Tạo `hotspot-scorer.ts` — chấm điểm ưu tiên tối ưu hóa:
  ```
  HotspotScore = 0.3 × Churn + 0.3 × BlastRadius + 0.25 × FanIn + 0.15 × InfraConnections
  ```
- [ ] **C4** Expose `detect_changes` trả thêm `architectureDiff` và `hotspots` top 10.
- [ ] **C5** Thêm `query_graph` Cypher templates cho hotspot analysis vào docs.

**Graph Diff Schema:**

```typescript
interface GraphDiff {
  fromCommit: string;
  toCommit: string;
  addedNodes: { label: string; count: number }[];
  removedNodes: { label: string; count: number }[];
  contractDrift: {
    type: "APIRoute" | "GRPCEndpoint" | "MessageQueue";
    name: string;
    change: "added" | "removed" | "path_changed" | "method_changed";
  }[];
  hotspots: {
    name: string;
    file: string;
    service: string;
    score: number;
    reasons: string[];
  }[];
}
```

**Exit criteria:**

- Diff giữa 2 sync liên tiếp chạy < 2 giây.
- `detect_changes` trả `architectureDiff` có nội dung khi có thay đổi thật.

---

### Phase D — Self-Adjusting KB (Tuần 4–5)

**Mục tiêu**: Pipeline tự nhận diện pattern kiến trúc mới và đề xuất chuẩn hóa.

**Deliverables:**

- [ ] **D1** Tạo `architecture-fingerprint.ts` — mô tả "profile" của một service:
  ```typescript
  interface ServiceFingerprint {
    frameworks: string[]; // ["express", "nestjs", "fastapi", ...]
    transports: string[]; // ["http", "grpc", "kafka", "rabbitmq"]
    datastores: string[]; // ["postgres", "mongo", "elasticsearch"]
    deployment: string; // "docker_compose" | "k8s" | "unknown"
    languages: string[];
  }
  ```
- [ ] **D2** Tạo `candidate-pattern.ts` — khi sync thấy InfraKind không map được vào schema:
  - Ghi vào node `CandidatePattern {source, pattern, confidence: 0.3, status: "pending"}`
  - Trigger log cảnh báo để review
- [ ] **D3** Tạo `augment` tool action `promoteCandidate` — human approve một pattern → promote vào InfraKind
- [ ] **D4** Viết quy trình trong `nexus-hub/skills/` hướng dẫn khi nào và cách promote pattern mới

**Exit criteria:**

- Sync file với framework lạ không crash pipeline.
- Tạo được `CandidatePattern` node với status pending.
- Human có thể approve/reject candidate qua MCP tool.

---

### Phase E — Quality Gate On-Demand (Tuần 6)

**Mục tiêu**: Developer/agent có thể yêu cầu risk assessment bất kỳ lúc nào từ KB hiện có — không can thiệp CI/CD của external services.

> **Nguyên tắc**: Phase E KHÔNG tích hợp vào CI/CD pipeline của external services. Mọi thứ dừng ở local — KB được cập nhật qua git hooks, risk report được tạo on-demand khi cần.

**Deliverables:**

- [ ] **E1** Tạo MCP tool `scan_risks` — on-demand risk assessment từ KB hiện có:
  - Input: `service` + `riskTypes[]` + `threshold`
  - Không cần re-sync, đọc thẳng từ Memgraph + ChromaDB
  - Output: structured risk items theo severity
- [ ] **E2** Định nghĩa Risk Policy (`nexus-config.yaml`):
  ```yaml
  quality_gates:
    max_contract_drift: 0 # 0 = cảnh báo nếu có API contract bị xóa
    max_blast_radius_increase: 20 # percent
    min_test_coverage_hotspot: 80 # percent, áp cho hàm hotspot score > 0.7
  ```
- [ ] **E3** Tạo output format chuẩn cho risk report (dùng bởi agent khi được hỏi):
  ```
  ## Nexus KB Quality Report — <service> @ <lastSyncCommit>
  ### Breaking Risk: 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW
  ### Contract Drift: 2 routes removed, 1 method changed
  ### Top Hotspots: [list]
  ### Recommended Actions: [list]
  ```
- [ ] **E4** Vitest integration test suite đầy đủ trong `mcp-server/tests/` bao gồm cross-service scenarios.
- [ ] **E5** Tạo skill `nexus-hub/skills/risk-assessment/` hướng dẫn agent khi nào gọi `scan_risks` và cách interpret kết quả.

**Exit criteria:**

- `scan_risks` trả kết quả chính xác từ KB, không cần network call ra ngoài.
- Agent có thể tạo risk report đầy đủ chỉ từ câu hỏi tự nhiên của developer.

---

## 4. E2E Test Plan

### 4.1 Tiền điều kiện

```bash
# 1. Khởi động hạ tầng Nexus
docker compose up memgraph chromadb -d

# 2. Build và start MCP server
cd nexus-hub/common-tools && npm run build
cd mcp-server && npm run build && node dist/index.js &

# 3. Xác nhận server healthy
curl http://localhost:13100/health

# 4. Đảm bảo external service repos đã được clone về local
#    (services nằm ngoài Nexus repo, có path riêng)
ls /path/to/warehouse-2.0
ls /path/to/service-b

# 5. Cài global git hooks (1 lần duy nhất trên máy — áp dụng cho mọi repo)
bash scripts/install-global-hooks.sh
# → git config --global core.hooksPath ~/.nexus/hooks/

# 6. Set NEXUS_MCP_URL nếu MCP không chạy ở localhost:13100
export NEXUS_MCP_URL=http://localhost:13100
```

### 4.2 Test Scenarios

#### Scenario T1: Sync chuẩn (MUST PASS)

```
1. Sync service warehouse-2.0
2. Verify: Function count > 3000
3. Verify: KafkaTopic > 0, Database > 0
4. Verify: Vector search "kafka producer" trả ≥ 1 result
5. Verify: check_staleness trả status = "up_to_date"
```

**Script**: `node mcp-server/test-sync.mjs`

#### Scenario T2: Cross-service linking (MUST PASS khi có ≥ 2 services)

```
Pre: 2 external services đã được sync vào KB qua Hub Manager
     hoặc hooks đã chạy sau push gần nhất

1. Hub Manager gọi sync_service_knowledge với path của service A
   (service A có REST client gọi service B)
2. Hub Manager gọi sync_service_knowledge với path của service B
   (service B expose route handler)
3. Query: MATCH ()-[:HTTP_TRIGGERS]->() RETURN count(*) → expect > 0
4. Query: MATCH ()-[:ASYNC_TRIGGERS]->() RETURN count(*) → expect > 0
```

**Script**: `node mcp-server/test-cross-service.mjs` _(cần tạo — Phase A6)_

#### Scenario T8: Auto-sync hook (MUST PASS — Phase A)

```
Pre: hook đã cài vào external service repo

1. Vào service repo, thêm 1 function mới vào file bất kỳ
2. git commit + git push
3. Đợi ≤ 60 giây
4. Verify: KB có function mới (query_graph hoặc search_knowledge_base)
5. Verify: ~/.nexus/sync.log có entry thành công cho lần push đó

6. git pull (khi remote có commit mới từ teammate)
7. Verify: post-merge hook chạy → KB cập nhật theo
8. Verify: hook không làm chậm git pull (chạy background)
```

**Script**: `node mcp-server/test-auto-sync-hook.mjs` _(cần tạo — Phase A)_

#### Scenario T3: Incremental sync (MUST PASS)

```
1. Sync lần 1 (full)
2. Thay đổi 1 file trong service
3. Sync lần 2 (incremental, force_update=false)
4. Verify: chỉ file thay đổi được re-parse
5. Verify: graph cập nhật đúng hàm mới/đã sửa
```

#### Scenario T4: Contract drift detection (MUST PASS — Phase C)

```
1. Sync service có APIRoute "/api/v1/products"
2. Đổi route thành "/api/v2/products"
3. Sync lại
4. Verify: detect_changes trả contractDrift có entry
5. Verify: HTTP_TRIGGERS từ caller cũ bị xóa hoặc marked stale
```

#### Scenario T5: Resilience — Memgraph restart

```
1. Sync thành công
2. docker restart nexus-memgraph
3. Sync ngay sau khi restart
4. Verify: pipeline retry và thành công (hoặc trả lỗi có cấu trúc)
5. Verify: không có partial state / orphan nodes
```

#### Scenario T6: Security — mutation blocked

```
1. Gọi query_graph với "CREATE (n:Test)"
2. Gọi query_graph với "MATCH (n) DELETE n"
3. Gọi query_graph với "MERGE (n:Test)"
4. Verify: tất cả trả error có field "error" mô tả keyword bị block
```

**Script**: có trong `mcp-server/tests/tools-core.test.ts`

#### Scenario T7: Unknown pattern handling (Phase D)

```
1. Tạo file có call pattern lạ: someNewMQ.publishMessage("topic", data)
2. Sync service chứa file đó
3. Verify: không crash pipeline
4. Verify: tạo CandidatePattern node với status = "pending"
5. Verify: log có cảnh báo về pattern chưa biết
```

### 4.3 Test Matrix

| Scenario            | Priority | Khi nào     | Hiện có script        |
| ------------------- | -------- | ----------- | --------------------- |
| T1: Sync chuẩn      | P0       | Mỗi deploy  | ✅ test-sync.mjs      |
| T2: Cross-service   | P0       | Sau Phase A | ❌ cần tạo            |
| T3: Incremental     | P1       | Weekly      | ❌ cần tạo            |
| T4: Contract drift  | P1       | Sau Phase C | ❌ cần tạo            |
| T5: Resilience      | P2       | Monthly     | ❌ cần tạo            |
| T6: Security        | P0       | Mỗi deploy  | ✅ tools-core.test.ts |
| T7: Unknown pattern | P2       | Sau Phase D | ❌ cần tạo            |
| T8: Auto-sync hook  | P0       | Sau Phase A | ❌ cần tạo            |

---

## 5. KPI và Success Metrics

| Metric                          | Hiện tại | Mục tiêu Phase A | Mục tiêu Phase E  |
| ------------------------------- | -------- | ---------------- | ----------------- |
| Services trong KB               | 1        | ≥ 3              | N (tất cả spokes) |
| Cross-service trigger edges     | 0        | > 0              | Phản ánh thực tế  |
| Vector search success rate      | ~60%     | 99%              | 99.9%             |
| Schema completeness             | ~40%     | 80%              | 95%               |
| Mean sync duration (1 service)  | ~30s     | < 20s            | < 15s             |
| KB freshness lag sau push       | manual   | ≤ 60s            | ≤ 30s             |
| KB freshness lag sau pull/merge | manual   | ≤ 60s            | ≤ 30s             |
| Contract drift detection rate   | 0%       | -                | ≥ 90%             |
| PR quality gate coverage        | 0%       | -                | 100%              |

---

## 6. Nguyên tắc triển khai

1. **Zero Regression Policy**: Mọi thay đổi pipeline phải pass 100% test hiện có trước khi merge.
2. **Hub First**: Schema, rules, patterns chỉ được thêm vào `nexus-hub/common-tools` — không hard-code trong service.
3. **KB-First Agents**: Agents **luôn query KB trước** (`search_knowledge_base`, `query_graph`, `get_impact_analysis`). Chỉ đọc source code trực tiếp khi KB chưa đủ context để giải quyết vấn đề — và phải khai báo rõ "KB has no data for X" trước khi fallback.
4. **Backward Compat**: Node schema mới (thêm field) phải compatible với data cũ — không xóa field đang có.
5. **Incremental by default**: `force_update=false` là mặc định, chỉ dùng `force_update=true` khi thật sự cần.
6. **Fail fast, recover clean**: Phase nào fail → pipeline dừng, không tạo partial state trong graph.
7. **Hook never blocks**: Git hooks sync KB async — không bao giờ làm chậm hoặc block git push/pull của developer.
8. **Feature discussion-first**: Tính năng mới phải có proposal template với acceptance criteria rõ ràng trước khi implement — tránh làm đi làm lại do hiểu sai yêu cầu.
9. **Branch per phase**: Mỗi phase A→E là 1 feature branch riêng, PR riêng, review riêng.

---

## 7. Roadmap Agent Mới (Sau Phase A–E)

> Agents vận hành theo nguyên tắc **KB-First**: query KB → chỉ fallback ra source code khi KB chưa đủ.  
> Pre-requisite: Phase A (KB stable + global hooks) + Phase B (Canonical Schema) phải hoàn thành trước.

### 7.1 Incident Resolver Agent ← ROI cao nhất, ưu tiên xây trước

**Input**: log snippet | error code | URL/path đến log stream  
**Workflow**:

```
1. Parse input → extract: function name, file, exception type, error code
2. search_knowledge_base(error pattern) → tìm context lịch sử
3. get_impact_analysis(function) → trace toàn bộ call chain liên quan
4. detect_changes(since=last_deploy_commit) → thay đổi gần nhất trong vùng lỗi
5. query_graph → tìm DB connections / Kafka topics liên quan đến code path đó
```

**Output**: Root cause analysis + danh sách thay đổi gần nhất có thể gây ra lỗi + suggested fix direction

### 7.2 Security Audit Agent

**Input**: service name (hoặc `all`)  
**Workflow**:

```
1. query_graph → HTTPEndpoint/APIRoute không có auth pattern trong KB
2. get_process_flows → trace sensitive data (PII, credentials) qua HTTP/Kafka
3. search_knowledge_base → framework vulnerabilities đã được document
4. hotspot_scorer → hàm có blast radius cao + xử lý data nhạy cảm
```

**Output**: Risk report theo OWASP Top 10 category, mỗi item có severity + affected code path

### 7.3 Upgrade Assessment Agent

**Input**: service name  
**Workflow**:

```
1. get_symbol_context → runtime version, framework versions từ KB
2. query_graph → hotspot functions (high churn + high blast radius)
3. So sánh với version registry trong nexus-hub/knowledge-base
4. search_knowledge_base → breaking changes giữa version hiện tại và latest
```

**Output**: "Service X dùng Python 3.8 (EOL 2024), 3 hotspot functions cần refactor trước khi upgrade"

### 7.4 Proactive Risk Scanner (MCP Tool mới — `scan_risks`)

```typescript
// Input
{
  service: string,
  riskTypes: ("security" | "performance" | "stability" | "upgrade")[],
  threshold: number  // 0.0–1.0, chỉ trả risk score >= threshold
}
// Output: structured risk items, ưu tiên theo score
// kèm affected functions và recommended actions
```

### 7.5 Feature Proposal Gate (Governance Skill)

Trước khi bất kỳ agent nào nhận task implement feature mới, phải có proposal với:

```markdown
## Feature Proposal Template

- **Mục tiêu đầu ra** (acceptance criteria đo được)
- **Impact check**: query_graph → ai/service nào bị ảnh hưởng?
- **Contract change?** Có cần versioning (v2) không?
- **KB gap**: KB hiện có đủ data để implement không?
- **Definition of Done**: Test cases cụ thể
```

Skill tương ứng sẽ được thêm vào `nexus-hub/skills/feature-proposal/`.
