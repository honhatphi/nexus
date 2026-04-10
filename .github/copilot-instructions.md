# Nexus — AI Agent Coding Assistant (Knowledge Base-Driven)

## Project Overview

Nexus is an AI Agent system that assists developers by leveraging a centralized Knowledge Base (KB).
Every suggestion, refactor, or code generation must be grounded in verified knowledge from the KB.

The project follows a **Hub & Spoke** architecture:
- **Hub** (`/nexus-hub`) — Centralized knowledge: Global Skills, Shared KB, Patterns, Prompts + Common Tools (parser, sync).
- **Spokes** (`/services/*`) — Independent microservices, each with its own tech stack (local only, not tracked in git).

All agent configuration is defined in `/nexus-config.yaml`.

> **Nexus Hub (`/nexus-hub`) là nguồn tri thức DUY NHẤT (Single Source of Truth) của toàn hệ thống.**
> Mọi quyết định kiến trúc, pattern thiết kế, ràng buộc kỹ thuật, và best practice **đều phải được lưu trữ và tra cứu từ Hub**.
> Không service nào được tự định nghĩa pattern riêng nếu Hub đã có pattern tương đương.
> Khi Hub và local code xung đột — **Hub luôn thắng** trừ khi người dùng override tường minh.

---

## Hub & Spoke Model

### 🏛️ Hub — `/nexus-hub/`

The Hub is the **single source of truth** for cross-cutting knowledge. Agent must **always consult the Hub first** before taking any action on a local service.

```
nexus-hub/
├── common-tools/     # Shared TypeScript tools (universal parser, sync engine)
├── skills/           # Global reusable skill definitions
├── knowledge-base/   # Shared KB — decisions, constraints, prior art
├── prompts/          # Prompt templates used across services
└── patterns/         # Standardized design patterns & code templates
```

**Rules:**
1. Before any code change, search `/nexus-hub/knowledge-base` for relevant context.
2. Before applying a pattern, check `/nexus-hub/patterns` for an existing standardized version.
3. When a new pattern emerges in a local service and is reusable, **promote it to the Hub**.
4. Hub content is shared — changes here affect all services. Apply the **Zero Regression Policy**.

### 🔗 Spokes — `/services/*` (local only)

Each spoke is an independent microservice with its own tech stack, defined in `/nexus-config.yaml`.
Services live locally and are **not tracked in git** — they are analyzed by the MCP pipeline.

**Rules:**
1. Each service owns its own code, tests, and local configuration.
2. Do not mix runtimes across services (e.g., no Python imports in a Go service).
3. Cross-service communication must go through defined APIs, never direct code imports.
4. Local patterns that prove useful across services should be promoted to the Hub.

### Lookup Order (mandatory)

```
1. /nexus-hub/knowledge-base   ← Search here FIRST
2. /nexus-hub/skills           ← Check for existing skills
3. /nexus-hub/patterns         ← Check for standardized patterns
4. Local service context       ← Only then look at the current service
```

> **If the Hub has no relevant entries**, state that explicitly, proceed with best practices, and flag the gap so it can be filled later.

---

## Knowledge Base-First Rule

> **Before** proposing any suggestion, code change, or architectural decision, the agent **must** consult the Hub, then call the MCP tool `search_knowledge_base` to retrieve relevant context.

### Workflow

1. Receive a user request or identify a task.
2. **Search the Hub** — check `/nexus-hub/knowledge-base`, `/nexus-hub/skills`, and `/nexus-hub/patterns` for relevant context.
3. **Call `search_knowledge_base`** with relevant keywords/context to query the vector/graph KB.
4. **Call `query_graph`** to check cross-service dependencies before any new feature implementation.
5. Analyze results — look for existing patterns, decisions, constraints, and prior art.
6. Only then formulate a response or code change that aligns with findings.
7. If neither Hub nor KB has relevant entries, state that explicitly, proceed with best practices, and **flag the gap** for future Hub contribution.

### Cross-Service Dependency Check (mandatory)

> **Trước khi code tính năng mới**, Agent **phải** dùng `query_graph` để kiểm tra các phụ thuộc liên dịch vụ (cross-service dependencies).

```
# Kiểm tra hàm/module đang được service nào gọi
query_graph({
  query: "MATCH (caller:Function)-[:CALLS]->(target:Function {name: $name}) RETURN caller.name, caller.service",
  params: { name: "TargetFunctionName" }
})

# Kiểm tra toàn bộ dependency chain của một service
get_impact_analysis({ name: "PaymentService", maxDepth: 3 })
```

**Rules:**
1. Nếu hàm/module bị gọi bởi service khác → **không được thay đổi signature** mà không có approval.
2. Nếu cần thay đổi contract → tạo version mới (v2) song song, không sửa version cũ.
3. Agent phải liệt kê **tất cả service bị ảnh hưởng** trước khi đề xuất thay đổi.

### When KB / Hub Conflicts with Request

- If the Hub or KB documents a decision that contradicts the user's request, **surface the conflict** before proceeding.
- Never silently override a Hub/KB-documented architectural decision.
- If a local service pattern contradicts a Hub pattern, the **Hub pattern takes precedence** unless explicitly overridden.

---

## Zero Regression Policy

> **Stability of existing code is the #1 priority.** No change should break what already works.

### Rules

1. **No breaking changes** to public APIs, interfaces, or contracts without explicit approval.
2. Before modifying any shared module, verify all dependents via `search_knowledge_base` and codebase analysis.
3. All refactors must be covered by existing or newly written tests **before** the change is applied.
4. If a change carries regression risk, propose it as a **feature flag** or **behind an abstraction layer** first.
5. When in doubt, prefer the safer, more conservative approach.

### Regression Checklist (before every change)

- [ ] Existing tests still pass.
- [ ] No public interface signatures changed unintentionally.
- [ ] KB has been consulted for known side effects or dependencies.

---

## Directory Structure

```
Nexus/
├── .github/
│   └── copilot-instructions.md    # This file — global agent rules
├── nexus-config.yaml               # Hub & Spoke service registry
├── docker-compose.yml              # Memgraph + ChromaDB infrastructure
│
├── nexus-hub/                      # 🏛️ HUB — Centralized knowledge
│   ├── common-tools/              #   TypeScript: universal parser + sync engine
│   │   └── src/
│   │       ├── universal-parser.ts #   Tree-sitter multi-lang parser + infra detection
│   │       ├── sync-tool.ts        #   SyncServiceKnowledge (graph + vector upsert)
│   │       ├── types.ts            #   Shared type definitions
│   │       └── index.ts            #   Package exports
│   ├── knowledge-base/            #   Shared KB (decisions, constraints)
│   ├── patterns/                  #   Standardized design patterns
│   ├── prompts/                   #   Prompt templates
│   └── skills/                    #   Global skill definitions
│
├── mcp-server/                    # MCP Server — Tool gateway (port 3100)
│   └── src/
│       ├── index.ts               #   Server entry (StreamableHTTP)
│       ├── config.ts              #   Environment config
│       ├── clients/               #   DB clients (Memgraph, ChromaDB)
│       └── tools/                 #   MCP tools (sync, parse, query, search, impact)
│
├── agents/                        # Agent definitions (JSON configs)
│   ├── legacy-guardian.json       #   Legacy code analysis & adapter design
│   ├── nexus-librarian.json       #   Hub knowledge management & sync
│   └── service-worker.json        #   Service-scoped code execution
│
├── agentic-workflows/             # Multi-step workflow orchestrations
│   ├── feature-flow.md            #   Feature implementation workflow
│   ├── maintain-hub.md            #   Hub maintenance workflow
│   └── sync-workspace.md          #   Full workspace sync workflow
│
├── skills/                        # Local skill modules
│   └── migration-patterns.md      #   Adapter patterns (Go/PHP/Python/TS)
│
└── services/                      # 🔗 SPOKES (local only, git-ignored)
    └── warehouse-2.0/             #   Python 3.8 + Airflow ETL platform
```

---

## MCP Tools Reference

The MCP server (`/mcp-server`) exposes 5 tools via HTTP on port 3100:

| Tool | Purpose |
|------|---------|
| `sync_service_knowledge` | Parse service code → upsert to Memgraph (graph) + ChromaDB (vectors) |
| `parse_code` | Parse a single file/snippet with tree-sitter |
| `query_graph` | Execute Cypher queries against Memgraph |
| `search_knowledge_base` | Semantic search against ChromaDB vectors |
| `get_impact_analysis` | Trace transitive dependencies for a function/file |

---

## Global Skills — Security & API Design

Các Global Skills sau đây áp dụng cho **toàn bộ project** (mọi service trong `/services/*` và mọi tool trong `/mcp-server/`). Agent phải tuân thủ khi code bất kỳ tính năng nào.

### 🔐 Security Skill

1. **Input Validation** — Mọi dữ liệu từ bên ngoài (HTTP request, message queue, file upload) phải được validate và sanitize trước khi xử lý. Dùng schema validation (zod, JSON Schema, struct tags) phù hợp với từng runtime.
2. **Authentication & Authorization** — Mọi endpoint phải yêu cầu authentication (JWT/OAuth2). Authorization phải dùng RBAC. Không hardcode roles trong code.
3. **Secret Management** — Không bao giờ commit secrets, API keys, hay credentials vào source code. Sử dụng environment variables hoặc secret manager. Kiểm tra `.env` files được liệt kê trong `.gitignore`.
4. **OWASP Top 10** — Agent phải chủ động phát hiện và cảnh báo các lỗ hổng: SQL/NoSQL injection, XSS, CSRF, broken access control, security misconfiguration.
5. **Dependency Security** — Khi thêm dependency mới, kiểm tra known vulnerabilities. Không dùng package deprecated hoặc có CVE nghiêm trọng.

### 🌐 API Design Skill

1. **RESTful Conventions** — Sử dụng đúng HTTP methods (GET/POST/PUT/PATCH/DELETE), status codes (2xx/4xx/5xx), và resource naming (`/users/{id}`, không `/getUser`).
2. **Consistent Response Format** — Mọi API response phải tuân theo cấu trúc chuẩn:
   ```json
   {
     "success": true,
     "data": { ... },
     "error": null,
     "meta": { "page": 1, "total": 100 }
   }
   ```
3. **Versioning** — API phải được version (`/v1/`, `/v2/`). Không breaking change trên version đang active.
4. **Rate Limiting & Pagination** — Mọi public endpoint phải có rate limiting. List endpoints phải hỗ trợ pagination (cursor-based hoặc offset-based).
5. **Documentation** — Mọi endpoint mới phải có OpenAPI/Swagger spec. Agent phải gợi ý viết spec khi tạo route mới.
6. **Cross-Service Communication** — Giữa các service trong `/services/*`, giao tiếp qua gRPC hoặc REST với retry + circuit breaker. Không gọi trực tiếp internal functions.

> Các skill này được lưu tại `/nexus-hub/skills/` và sẽ được mở rộng theo thời gian. Agent phải kiểm tra Hub trước khi áp dụng để dùng version mới nhất.

---

## Summary of Core Rules

| # | Rule | Priority |
|---|------|----------|
| 1 | Nexus Hub là nguồn tri thức DUY NHẤT — luôn consult trước | Critical |
| 2 | Dùng `query_graph` kiểm tra cross-service dependencies trước khi code | Critical |
| 3 | Zero regression — stability of existing code comes first | Critical |
| 4 | Always search Hub + call `search_knowledge_base` before any suggestion | Required |
| 5 | Each service owns its stack; no cross-service runtime mixing | Required |
| 6 | Global Skills (Security + API Design) apply to ALL sub-projects | Required |
| 7 | Khi thêm service mới vào `/services/`, gợi ý chạy `sync_service_knowledge` | Required |
| 8 | Clean Code + SOLID principles for all new code | Required |
