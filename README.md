# Nexus — AI Agent Knowledge Base

Hệ thống KB (Knowledge Base) tập trung cho AI Agent, giúp agent trả lời câu hỏi về codebase dựa trên graph + vector search thay vì đọc file trực tiếp.

## Kiến trúc

```
┌──────────────────────────────────────────────────────┐
│                   AI Agent (VS Code)                 │
└───────────────────────┬──────────────────────────────┘
                        │ MCP HTTP (port 13100)
┌───────────────────────▼──────────────────────────────┐
│                   MCP Server                         │
│   12 tools: search_kb, query_graph, sync, augment…   │
└───────────┬──────────────────────┬───────────────────┘
            │                      │
    ┌───────▼───────┐      ┌───────▼───────┐
    │   Memgraph    │      │   ChromaDB    │
    │  Graph DB     │      │  Vector DB    │
    │  port 17687   │      │  port 18000   │
    │  Lab: 13000   │      │               │
    └───────────────┘      └───────────────┘
```

### Hub & Spoke

- **Hub** (`/nexus-hub/`) — Source of truth: skills, patterns, knowledge-base, common-tools
- **Spokes** (`/services/*`) — Microservices được sync vào KB, không track trong git

---

## Khởi động

```bash
# 1. Start infrastructure (Memgraph + ChromaDB)
docker compose up memgraph chromadb -d

# 2. Build & start MCP Server
cd mcp-server && npm run build && npm start
```

Hoặc dùng VS Code task: **⚡ Full Stack: Start All**

MCP Server được quản lý bởi launchd — tự khởi động khi login:

```bash
# Install launchd agent (lần đầu)
cp scripts/com.nexus.mcp-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nexus.mcp-server.plist

# Logs
tail -f /tmp/nexus-mcp-server.log
```

---

## MCP Tools

| Tool                     | Mô tả                                              |
| ------------------------ | -------------------------------------------------- |
| `search_knowledge_base`  | Hybrid search (vector + BM25) với hit-count boost  |
| `query_graph`            | Cypher query trực tiếp vào Memgraph                |
| `get_impact_analysis`    | Dependency chain của function/file                 |
| `check_staleness`        | So sánh KB với git HEAD                            |
| `sync_service_knowledge` | Parse & sync service vào KB                        |
| `parse_code`             | Parse một file với tree-sitter (cần absolute path) |
| `augment`                | Enrich KB entry với context bổ sung                |
| `get_symbol_context`     | Context đầy đủ của một symbol                      |
| `detect_changes`         | Phát hiện code thay đổi từ lần sync cuối           |
| `get_process_flows`      | Extract business process flows                     |
| `scan_risks`             | Phát hiện rủi ro trong code                        |
| `query_log`              | Analytics KB usage (Learning Layer)                |

---

## Sync Service vào KB

```bash
# Qua Hub Manager agent trong VS Code
# @hub-manager sync /absolute/path/to/service

# Hoặc gọi MCP tool trực tiếp
curl -s -X POST http://localhost:13100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"sync_service_knowledge","arguments":{"service_path":"/absolute/path"}}
  }'
```

> **Quan trọng**: `service_path` phải là **absolute path**. Không dùng `"."` hay path tương đối.

---

## Learning Layer (Human Memory Architecture)

KB được thiết kế theo mô hình bộ nhớ người — tự cải thiện theo thời gian.

### Cơ chế hoạt động

Mỗi lần `search_knowledge_base` được gọi:

1. **QueryEvent** được ghi vào Memgraph — lưu query, timestamp, top score
2. **hit_count** trong ChromaDB được tăng cho các chunk được trả về

Kết quả search được rerank theo công thức:

$$\text{final\_score} = \text{rrf\_score} \times 0.7 + \text{hit\_count\_norm} \times 0.3$$

→ Chunk được hỏi nhiều nổi lên tự nhiên trong các lần sau.

### Daily Consolidation

Script `scripts/consolidation.mjs` chạy tự động lúc **02:00 mỗi đêm** (launchd).

```
Phase 1 — Gap Detection:   query có score thấp → augment KB entry
Phase 2 — Pattern Promo:   query hỏi ≥ 3 lần → tạo file trong nexus-hub/knowledge-base/auto-promoted/
Phase 3 — Cold Marking:    log QueryEvent cũ để cleanup thủ công
```

**Chạy thủ công:**

```bash
cd mcp-server

npm run consolidate        # chạy thật
npm run consolidate:dry    # dry-run, không ghi gì
```

**Xem analytics:**

```bash
# Top queries tuần này
curl -s -X POST http://localhost:13100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_log","arguments":{"kind":"top_queries","since_days":7}}}'

# KB gaps (câu hỏi không có câu trả lời tốt)
# → thay kind thành "gap_queries"
```

Hoặc dùng tool `query_log` trong VS Code qua agent `@search`.

---

## Wipe KB (reset toàn bộ)

```bash
# Xóa Memgraph
echo "MATCH (n) DETACH DELETE n;" | docker exec -i nexus-memgraph mgconsole --username "" --password ""

# Xóa ChromaDB collection
curl -X DELETE "http://localhost:18000/api/v2/tenants/default_tenant/databases/default_database/collections/nexus_codebase"
```

---

## Cấu trúc thư mục

```
Nexus/
├── docker-compose.yml          # Memgraph + ChromaDB
├── nexus-config.yaml           # Service registry
├── mcp-server/                 # MCP Server (TypeScript)
│   └── src/
│       ├── clients/            # Memgraph, ChromaDB, Search clients
│       └── tools/              # 12 MCP tools
├── nexus-hub/                  # Hub — source of truth
│   ├── knowledge-base/         # Shared KB entries
│   │   └── auto-promoted/      # Auto-promoted từ consolidation
│   ├── patterns/               # Design patterns chuẩn
│   ├── skills/                 # Agent skills (code-review, debugging…)
│   └── common-tools/           # TypeScript parser + sync engine
├── scripts/
│   ├── consolidation.mjs       # Daily Learning Layer job
│   ├── com.nexus.mcp-server.plist      # launchd: MCP Server
│   └── com.nexus.consolidation.plist   # launchd: Daily consolidation
└── services/                   # Spokes — local only, git-ignored
```

---

## Agents trong VS Code

| Agent            | Dùng khi                                    |
| ---------------- | ------------------------------------------- |
| `@search`        | Hỏi về codebase, architecture, dependencies |
| `@hub-manager`   | Sync service, audit KB, cleanup             |
| `⚡ Coder`       | Implement feature với KB-first workflow     |
| `🌿 Git Manager` | Commit, push, branch                        |

---

## Ports

| Service         | Port  |
| --------------- | ----- |
| MCP Server      | 13100 |
| Memgraph Bolt   | 17687 |
| Memgraph Lab UI | 13000 |
| ChromaDB        | 18000 |
