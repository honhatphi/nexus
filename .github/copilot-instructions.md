# Nexus — AI Agent Coding Assistant (Knowledge Base-Driven)

## Project Overview

Nexus is an AI Agent system that assists developers by leveraging a centralized Knowledge Base (KB).
Every suggestion, refactor, or code generation must be grounded in verified knowledge from the KB.

The project follows a **Hub & Spoke** architecture:

- **Hub** (`/nexus-hub`) — Centralized knowledge: Global Skills, Shared KB, Patterns, Prompts + Common Tools (parser, sync).
- **Spokes** (`/services/*`) — Independent microservices, each with its own tech stack (local only, not tracked in git).

All agent configuration is defined in `/nexus-config.yaml`.

> **Nexus Hub (`/nexus-hub`) is the SINGLE Source of Truth for the entire system.**
> All architectural decisions, design patterns, technical constraints, and best practices **must be stored in and retrieved from the Hub**.
> No service may define its own pattern if the Hub already has an equivalent.
> When Hub and local code conflict — **Hub always wins** unless the user explicitly overrides.

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

> **Before implementing any new feature**, the agent **must** use `query_graph` to check cross-service dependencies.

```
# Check which services call a specific function/module
query_graph({
  query: "MATCH (caller:Function)-[:CALLS]->(target:Function {name: $name}) RETURN caller.name, caller.service",
  params: { name: "TargetFunctionName" }
})

# Check the full dependency chain of a service
get_impact_analysis({ name: "PaymentService", maxDepth: 3 })
```

**Rules:**

1. If a function/module is called by another service → **do not change its signature** without approval.
2. If a contract change is needed → create a new version (v2) in parallel; do not modify the existing version.
3. The agent must list **all affected services** before proposing any change.

### When KB / Hub Conflicts with Request

- If the Hub or KB documents a decision that contradicts the user's request, **surface the conflict** before proceeding.
- Never silently override a Hub/KB-documented architectural decision.
- If a local service pattern contradicts a Hub pattern, the **Hub pattern takes precedence** unless explicitly overridden.

---

## Autopilot Safety — PreToolUse Hook

> **Mọi lệnh shell autopilot chạy đều qua hook kiểm duyệt trước khi thực thi.**
> Hook được cấu hình global tại `~/.copilot/hooks/safe-commands.json` → gọi `~/.copilot/hooks/check-safe-command.js`.
> Hoạt động ở mọi workspace trên máy.

### Phân loại lệnh

| Quyết định | Ý nghĩa                                   | Ví dụ                                                  |
| ---------- | ----------------------------------------- | ------------------------------------------------------ |
| `allow`    | An toàn, tự động cho qua                  | `npm run build`, `git status`, `ls`                    |
| `ask`      | Có thể gây hại, **yêu cầu user xác nhận** | `rm -rf dist/`, `git reset --hard`, `git push --force` |
| `deny`     | Nguy hiểm, **chặn ngay lập tức** (exit 2) | `rm -rf /*`, `dd if=`, `mkfs`, `git push -f master`    |

### Các pattern bị DENY (chặn tuyệt đối)

- `rm -rf /` hoặc `rm -rf /*` — xóa toàn bộ filesystem
- `dd if=` — ghi thẳng vào disk
- `mkfs` — format filesystem
- `git push --force origin master/main` — force-push vào nhánh protected
- `DROP DATABASE/SCHEMA` — xóa toàn bộ database

### Các pattern cần ASK (yêu cầu xác nhận)

- `rm -r` / `rm -f` bất kỳ path nào
- `git reset --hard`, `git clean -fd`, `git commit --amend`, `git rebase`
- `git push --force` (mọi nhánh), `git push origin master/main`
- `git branch -d/-D`, `git push origin --delete`
- `DROP TABLE`, `TRUNCATE TABLE`
- `curl/wget | bash/sh` — pipe remote script vào shell
- `kill -9`, `chmod 777`

### Cập nhật danh sách pattern

**Chỉ** chỉnh sửa `~/.copilot/hooks/check-safe-command.js` khi có lệnh nguy hiểm mới cần bổ sung.
Bản gốc lưu tại `scripts/hooks/check-safe-command.js` trong repo. Không để autopilot tự sửa file hook — luôn review thủ công.

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
├── docker-compose.yml              # Memgraph + ChromaDB + MCP Server (Docker)
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
│       └── tools/                 #   MCP tools (10 tools)
│
├── scripts/                       # Git hooks + safety scripts
│   ├── hooks/check-safe-command.js #  PreToolUse safety hook (source of truth)
│   ├── commit-msg                 #   Conventional Commits validator
│   └── pre-commit                 #   Block direct commits to master/main
│
└── services/                      # 🔗 SPOKES (local only, git-ignored)
    └── warehouse-2.0/             #   Python 3.8 + Airflow ETL platform
```

### Global User-Level Files

```
~/Library/Application Support/Code/User/prompts/
├── coder.agent.md                 # ⚡ Coder agent mode
├── git-manager.agent.md           # 🌿 Git Manager agent mode
├── hub-manager.agent.md           # 🏛️ Hub Manager agent mode
└── search.agent.md                # 🔍 Search agent mode

~/.copilot/hooks/
├── safe-commands.json             # PreToolUse hook config (global)
└── check-safe-command.js          # Safety script (ALLOW/ASK/DENY)
```

---

## MCP Tools Reference

The MCP server (`/mcp-server`) exposes 10 tools via HTTP on port 3100.
Infra runs as Docker containers (`docker compose up -d`) with `restart: unless-stopped`.

| Tool                     | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `sync_service_knowledge` | Parse service code → upsert to Memgraph (graph) + ChromaDB (vectors) |
| `parse_code`             | Parse a single file/snippet with tree-sitter                         |
| `query_graph`            | Execute Cypher queries against Memgraph                              |
| `search_knowledge_base`  | Semantic search against ChromaDB vectors                             |
| `get_impact_analysis`    | Trace transitive dependencies for a function/file                    |
| `check_staleness`        | Detect services with outdated KB data                                |
| `augment`                | Enrich KB entries with additional context                            |
| `get_symbol_context`     | Get full context for a specific symbol                               |
| `detect_changes`         | Detect code changes since last sync                                  |
| `get_process_flows`      | Extract business process flows from code                             |

---

## Global Skills — Security & API Design

The following Global Skills apply to the **entire project** (all services in `/services/*` and all tools in `/mcp-server/`). The agent must comply when implementing any feature.

### 🔐 Security Skill

1. **Input Validation** — All external data (HTTP requests, message queues, file uploads) must be validated and sanitized before processing. Use schema validation (zod, JSON Schema, struct tags) appropriate to each runtime.
2. **Authentication & Authorization** — All endpoints must require authentication (JWT/OAuth2). Authorization must use RBAC. Never hardcode roles in code.
3. **Secret Management** — Never commit secrets, API keys, or credentials to source code. Use environment variables or a secret manager. Verify `.env` files are listed in `.gitignore`.
4. **OWASP Top 10** — The agent must proactively detect and flag vulnerabilities: SQL/NoSQL injection, XSS, CSRF, broken access control, security misconfiguration.
5. **Dependency Security** — When adding a new dependency, check for known vulnerabilities. Do not use deprecated packages or those with critical CVEs.

### 🌐 API Design Skill

1. **RESTful Conventions** — Use correct HTTP methods (GET/POST/PUT/PATCH/DELETE), status codes (2xx/4xx/5xx), and resource naming (`/users/{id}`, not `/getUser`).
2. **Consistent Response Format** — All API responses must follow this standard structure:
   ```json
   {
     "success": true,
     "data": { ... },
     "error": null,
     "meta": { "page": 1, "total": 100 }
   }
   ```
3. **Versioning** — APIs must be versioned (`/v1/`, `/v2/`). No breaking changes on an active version.
4. **Rate Limiting & Pagination** — All public endpoints must have rate limiting. List endpoints must support pagination (cursor-based or offset-based).
5. **Documentation** — All new endpoints must have an OpenAPI/Swagger spec. The agent should suggest writing a spec when creating new routes.
6. **Cross-Service Communication** — Between services in `/services/*`, communicate via gRPC or REST with retry + circuit breaker. Never call internal functions directly.

> These skills are stored in `/nexus-hub/skills/` and will be expanded over time. The agent must check the Hub before applying to use the latest version.

---

## Summary of Core Rules

| #   | Rule                                                                                                         | Priority |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Nexus Hub is the SINGLE source of truth — always consult first                                               | Critical |
| 2   | Use `query_graph` to check cross-service dependencies before coding                                          | Critical |
| 3   | Zero regression — stability of existing code comes first                                                     | Critical |
| 4   | Always search Hub + call `search_knowledge_base` before any suggestion                                       | Required |
| 5   | Each service owns its stack; no cross-service runtime mixing                                                 | Required |
| 6   | Global Skills (Security + API Design) apply to ALL sub-projects                                              | Required |
| 7   | When adding a new service to `/services/`, suggest running `sync_service_knowledge`                          | Required |
| 8   | Clean Code + SOLID principles for all new code                                                               | Required |
| 9   | Follow Git Flow — branch naming, Conventional Commits, PR before merge                                       | Required |
| 10  | All autopilot shell commands go through PreToolUse hook — never bypass `~/.copilot/hooks/safe-commands.json` | Required |

---

## Git Flow & Conventional Commits

> Full workflow is defined in `.github/agents/git-manager.agent.md`. Use the **Git Manager** agent for all commit/push tasks.

### Rules (apply to all agents)

- **Never commit directly to `master`/`main`** — always branch first.
- Branch naming: lowercase, hyphen-separated. Types: `feature/`, `fix/`, `hotfix/`, `chore/`, `docs/`, `refactor/`.

- Lowercase, hyphen-separated: `feature/add-search-endpoint`, `fix/memgraph-dns`
- No uppercase, no underscores, no spaces
- Scope should match the commit scope

### Conventional Commits Format

```
<type>(<scope>): <short description>

[optional body — explain WHY, not WHAT]

[optional footer — BREAKING CHANGE: ..., Closes #123]
```

### Git Hooks (auto-enforced)

- **`commit-msg`** — validates Conventional Commits format on every commit (`/scripts/commit-msg`)
- **`pre-commit`** — blocks direct commits to `master`/`main` (`/scripts/pre-commit`)
- **`PreToolUse`** — autopilot safety check for shell commands (`~/.copilot/hooks/safe-commands.json` — global, works in all workspaces)
- Git hooks installed via `scripts/setup-git-hooks.sh`

### PR Rules

1. Every branch must have a Pull Request before merging to `master`.
2. PR title must follow Conventional Commits format.
3. PR description must include: **What changed**, **Why**, **How to test**.
4. Squash-merge preferred to keep history clean.
