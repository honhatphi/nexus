# 00 — Current Nexus Architecture (Baseline)

> **Snapshot date**: 2026-05-11  
> **Status**: Baseline — không thay đổi, chỉ mô tả

---

## 1. Hub & Spoke Config

Defined in `nexus-config.yaml`. The Hub (`/nexus-hub`) is the single source of truth for:

- Shared KB (`/nexus-hub/knowledge-base/`)
- Global skills (`/nexus-hub/skills/`)
- Prompt templates (`/nexus-hub/prompts/`)
- Design patterns (`/nexus-hub/patterns/`)
- Common tools — universal parser + sync pipeline (`/nexus-hub/common-tools/`)

Spokes are independent microservices under `/services/` (local-only, git-ignored, analyzed by MCP pipeline).

---

## 2. MCP Server

**Entry**: `mcp-server/src/index.ts`  
**Transport**: StreamableHTTP on port 13100  
**Endpoint**: `http://localhost:13100/mcp`  
**Health**: `http://localhost:13100/health`

### Initialization sequence

```
1. loadConfig()
2. MemgraphClient(config.memgraph)
3. ChromaDBClient(config.chromadb)
4. chromadb.bootstrap()           ← ensure collection exists
5. memgraph.write(constraints)    ← ensure uniqueness constraints
6. http.createServer()
7. Per-request: new McpServer() + StreamableHTTPServerTransport
8. registerTools(server, memgraph, chromadb)
```

### Registered tools (10 tools)

| Tool                     | File                | Mô tả                                      |
| ------------------------ | ------------------- | ------------------------------------------ |
| `sync_service_knowledge` | `sync-service.ts`   | Parse service → upsert Memgraph + ChromaDB |
| `parse_code`             | `parse-code.ts`     | Parse file/snippet với tree-sitter         |
| `query_graph`            | `tools/index.ts`    | Cypher read-only query                     |
| `search_knowledge_base`  | `tools/index.ts`    | Semantic/hybrid search ChromaDB            |
| `get_impact_analysis`    | `tools/index.ts`    | Trace transitive dependencies              |
| `check_staleness`        | `tools/index.ts`    | Detect KB lỗi thời                         |
| `augment`                | `augment.ts`        | 360° symbol + callers/callees context      |
| `get_symbol_context`     | `context.ts`        | Symbol context từ graph + vectors          |
| `detect_changes`         | `detect-changes.ts` | Diff code kể từ commit ref                 |
| `get_process_flows`      | `resources.ts`      | Extract business process flows             |

---

## 3. Knowledge Engine

### Graph Store: Memgraph

Client: `mcp-server/src/clients/memgraph.ts`

**Node labels**: Function, File, Class, Task, DAG, Database, Community, KafkaTopic, HTTPEndpoint, APIRoute, GRPCEndpoint, MessageQueue, MessageChannel, Service

**Edge types**: CALLS, DEFINED_IN, BELONGS_TO, DEPENDS_ON, MEMBER_OF, EXTENDS, INHERITS, METHOD_OF, INVOKES, CONNECTS_TO, CONTAINS, PRODUCES_TO, CONSUMES_FROM, HTTP_CALL, HTTP_TRIGGERS, GRPC_TRIGGERS, ASYNC_TRIGGERS

**Known counts (2026-05-11)**: ~3965 Functions, ~465 Files, ~346 Tasks, ~193 Classes, ~115 DAGs

### Vector Store: ChromaDB

Client: `mcp-server/src/clients/chromadb.ts`  
Search: `mcp-server/src/clients/search.ts` — hybrid RRF (semantic + keyword)

### Hybrid Search

Reciprocal Rank Fusion (RRF) kết hợp:

- Semantic search (ChromaDB embeddings)
- Keyword search (BM25-style)

---

## 4. Parser Pipeline (common-tools)

**Entry**: `nexus-hub/common-tools/src/sync-tool.ts`  
**Languages**: Go, Python, PHP, TypeScript, JavaScript, Java, C#, YAML  
**Infra detection**: Kafka, PostgreSQL, MongoDB, Elasticsearch, HTTP, gRPC, RabbitMQ, Redis, SQS, NATS

### 10-phase pipeline

| Phase | File                            | Chức năng                                        |
| ----- | ------------------------------- | ------------------------------------------------ |
| 0     | `phase-0-filesystem.ts`         | Scan files, **in-memory hash cache** (known gap) |
| 1     | `phase-1-parse.ts`              | Tree-sitter AST + OpenAPI/Docker parsers         |
| 2     | `phase-2-graph.ts`              | Upsert nodes/edges → Memgraph                    |
| 3     | `phase-3-vectors.ts`            | Embed vectors → ChromaDB                         |
| 4     | `phase-4-metadata.ts`           | Git metadata, staleness tracking                 |
| 4b    | `phase-4b-snapshot.ts`          | Snapshot versioning                              |
| 5     | `phase-5-imports.ts`            | Import resolution                                |
| 6     | `phase-6-heritage.ts`           | Class inheritance / interface impl               |
| 7     | `phase-7-community.ts`          | Louvain community detection                      |
| 8a    | `phase-8a-kafka-linkage.ts`     | Kafka topic linkage                              |
| 8b    | `phase-8b-http-linkage.ts`      | HTTP cross-service triggers                      |
| 8c    | `phase-8c-grpc-linkage.ts`      | gRPC cross-service triggers                      |
| 8d    | `phase-8d-messaging-linkage.ts` | RabbitMQ/Redis/SQS/NATS                          |
| 8     | `phase-8-process.ts`            | Business process tracing                         |
| 9     | `phase-9-types.ts`              | Type resolution                                  |
| 10    | `phase-10-schema-validate.ts`   | Schema validation                                |

---

## 5. Global Git Hook Flow

Two hooks installed globally on developer machine (`~/.git-hooks/` or configured via `core.hooksPath`):

```
git push / git merge
       │
       ▼ post-push / post-merge (global hook)
scripts/global-hooks/sync-kb.mjs
       │
       ▼ HTTP POST to http://localhost:13100/mcp
sync_service_knowledge({ service_path: "." })
       │
       ▼ Pipeline runs, KB updated
```

Hooks installed via: `scripts/install-global-hooks.sh`

---

## 6. Known Gaps

| Gap                             | Impact                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| In-memory hash cache in phase-0 | MCP restart loses cache, re-indexes all files                  |
| No task ledger                  | Agent phải replay chat history để hiểu trạng thái task         |
| No artifact store               | Full logs/diffs/query results đưa vào prompt → tốn tokens      |
| No context pack                 | Agent tự search/query nhiều tool → context không được chọn lọc |
| No token budget                 | Tool output không có giới hạn, có thể rất lớn                  |
| No Codex integration            | Chưa có `AGENTS.md`, MCP config cho Codex                      |
| No workspace registry           | Service/repo được hardcode hoặc nhập tay                       |
| Tool surface lớn                | 10 tools cho agent có thể gây confuse, tool schema tốn tokens  |
| Raw Cypher exposed              | `query_graph` expose trực tiếp, agent có thể misuse            |
