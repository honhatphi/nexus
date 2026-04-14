# GitNexus Analysis Report — Định hướng phát triển Nexus

> **Ngày**: 2026-04-13  
> **Mục đích**: Phân tích mã nguồn mở GitNexus, rút ra bài học và định hướng cho dự án Nexus  
> **Nguồn**: `/workspace/reference/GitNexus/` (3975 symbols, 10043 relationships, 245 execution flows)

---

## Mục lục

1. [Tổng quan so sánh kiến trúc](#1-tổng-quan-so-sánh-kiến-trúc)
2. [Những điểm GitNexus làm tốt hơn Nexus](#2-những-điểm-gitnexus-làm-tốt-hơn-nexus)
3. [Những điểm Nexus đã làm tốt](#3-những-điểm-nexus-đã-làm-tốt)
4. [10 ý tưởng chọn lọc để áp dụng](#4-10-ý-tưởng-chọn-lọc-để-áp-dụng)
5. [Roadmap đề xuất](#5-roadmap-đề-xuất)
6. [Chi tiết kỹ thuật từng area](#6-chi-tiết-kỹ-thuật-từng-area)

---

## 1. Tổng quan so sánh kiến trúc

| Khía cạnh               | **Nexus** (chúng ta)                         | **GitNexus**                                  |
| ----------------------- | -------------------------------------------- | --------------------------------------------- |
| **Mô hình**             | Hub & Spoke — KB trung tâm + microservices   | Monorepo — CLI + Web + MCP                    |
| **Graph DB**            | Memgraph (Cypher, chạy riêng qua Docker)     | LadybugDB (embedded, chạy local cùng process) |
| **Vector DB**           | ChromaDB (chạy riêng qua Docker)             | LadybugDB built-in vector index               |
| **Parser**              | web-tree-sitter (WASM) — 5 ngôn ngữ          | tree-sitter native bindings — **13 ngôn ngữ** |
| **Ingestion Pipeline**  | Đơn giản: scan → parse → upsert              | **15-phase pipeline** chi tiết                |
| **MCP Tools**           | 5 tools (sync, parse, query, search, impact) | **7 tools** + 7 resource types                |
| **Search**              | ChromaDB semantic search                     | **Hybrid BM25 + Semantic + RRF fusion**       |
| **Agent Skills**        | Global Skills trong nexus-hub/skills/        | 6 task-oriented SKILL.md + hooks              |
| **Web UI**              | Không có                                     | React + WASM graph visualization              |
| **CLI**                 | Không có (chỉ MCP server)                    | **15+ CLI commands**                          |
| **Eval/Benchmark**      | Không có                                     | **SWE-bench evaluation framework**            |
| **CI/CD**               | Không có                                     | 5 workflow files, cross-platform              |
| **Type Resolution**     | Không có                                     | **13-language, 7-phase tiered system**        |
| **Community Detection** | Không có                                     | **Leiden algorithm** — auto cluster           |
| **Process Tracing**     | Không có                                     | **Entry → Terminal execution flows**          |
| **Staleness Detection** | Không có                                     | **Git commit comparison**                     |

---

## 2. Những điểm GitNexus làm tốt hơn Nexus

### 2.1 🔥 15-Phase Ingestion Pipeline (vs. Nexus scan → parse → upsert)

GitNexus có pipeline 15 bước tuần tự, mỗi bước giải quyết một concern riêng:

```
Phase 0:  Filesystem Walk          ← Nexus cũng có
Phase 1:  Structure (folder/file)  ← Nexus cũng có (CONTAINS edges)
Phase 2:  Markdown Sections        ← Nexus KHÔNG có
Phase 3:  Tree-sitter Parsing      ← Nexus cũng có
Phase 4:  Type Environment Build   ← Nexus KHÔNG có ⭐
Phase 5:  Import Resolution        ← Nexus có cơ bản
Phase 6:  Call Resolution          ← Nexus chỉ có cơ bản
Phase 7:  Export Detection         ← Nexus KHÔNG có
Phase 8:  Heritage (extends/impl)  ← Nexus KHÔNG có ⭐
Phase 9:  Field Extraction         ← Nexus KHÔNG có
Phase 10: MRO (Method Resolution)  ← Nexus KHÔNG có ⭐
Phase 11: Community Detection      ← Nexus KHÔNG có ⭐⭐
Phase 12: Process Tracing          ← Nexus KHÔNG có ⭐⭐
Phase 13: Cluster Enrichment       ← Nexus KHÔNG có
Phase 14: Embeddings               ← Nexus có (ChromaDB)
```

**Bài học**: Pipeline của chúng ta cần phát triển từ "scan & dump" sang "multi-phase analysis".

### 2.2 🔥 Hybrid Search với RRF (Reciprocal Rank Fusion)

Nexus chỉ dùng ChromaDB semantic search. GitNexus kết hợp:

```
BM25 (keyword exact match) + Semantic (embedding cosine)
→ RRF fusion: score = Σ(1 / (K + rank)), K=60
```

**Lợi ích**: Keyword search tìm exact names, Semantic tìm concepts — kết hợp cho kết quả tốt nhất.

### 2.3 🔥 Community Detection (Leiden Algorithm)

GitNexus tự động phát hiện "functional areas" — không dựa vào folder structure mà dựa vào **CALLS edges** thực tế:

- Input: Graph CALLS edges giữa các functions/methods
- Algorithm: vendored `graphology-leiden`
- Output: Communities (clusters) với `cohesion score`, `keywords`, `description`
- Enrichment: Optional LLM-generated descriptions

**Ý nghĩa cho Nexus**: Thay vì dev tự khai báo "service boundary", hệ thống tự detect code thuộc về cluster nào.

### 2.4 🔥 Process Tracing (Execution Flows)

GitNexus trace **execution flows** từ entry point đến terminal:

```
1. Score functions: outgoing_edges - incoming_edges * 0.5
2. BFS trace from entry points (max depth 10, max branches 4)
3. Deduplicate subsets, keep top 75 longest unique pairs
4. Each process = first-class entity in graph
```

**Ví dụ output**: "HTTP Request → Middleware → Auth → DB Query → Response" — một execution flow.

### 2.5 🔥 Type Resolution System (13 ngôn ngữ)

```
Tier 0: Type annotation  → confidence 1.0  (const x: MyType = ...)
Tier 1: Constructor call  → confidence 0.9  (const x = new MyClass())
Tier 2: Assignment chain  → confidence 0.8  (const x = y where y is typed)
```

**Vấn đề nó giải quyết**: `user.save()` → biết `user` là `User` type → link CALLS edge tới `User.save()` thay vì mọi `save()` trong codebase.

### 2.6 🔥 Confidence-Based Edges

Mọi relationship có `confidence: 0.0-1.0`:

- `direct (cùng file)` → 0.95
- `relative import` → 0.85
- `module import` → 0.80
- `global (ambiguous)` → 0.70
- `external (library)` → 0.60

**Impact Analysis** lọc theo `minConfidence` → agent chỉ xem edges đáng tin.

### 2.7 🔥 Staleness Detection

```typescript
// So sánh indexed commit vs HEAD
if (currentCommit !== indexedLastCommit) {
  stale = true;
  commitsAhead = git rev-list --count {indexed}..HEAD;
}
```

Agent luôn biết graph có cũ không → tự trigger re-index.

### 2.8 🔥 SWE-bench Evaluation Framework

GitNexus có hệ thống benchmark agent performance trên real GitHub issues:

| Mode             | Khả năng                | Mục đích            |
| ---------------- | ----------------------- | ------------------- |
| `baseline`       | grep, find, cat         | Control group       |
| `native`         | GitNexus tools          | Explicit tool usage |
| `native_augment` | Tools + grep enrichment | Production-like     |

**Metrics**: cost, tokens, tool usage, resolution rate.

### 2.9 🔥 Agent Hooks (PreToolUse / PostToolUse)

- **PreToolUse**: Intercept agent's grep/search → auto-enrich with callers/callees/flows
- **PostToolUse**: After git commit → auto re-index graph

Agent nhận context tốt hơn **mà không cần gọi tool explicit**.

### 2.10 🔥 Wiki Generation

Auto-generate documentation từ graph:

```
Phase 0: Validate structure
Phase 1: Build module tree (1 LLM call)
Phase 2: Generate pages per module (N LLM calls, concurrent)
Phase 3: Generate overview (1 LLM call)
```

---

## 3. Những điểm Nexus đã làm tốt

| Nexus Advantage                      | Giải thích                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Hub & Spoke model**                | Kiến trúc rõ ràng hơn: centralized KB + independent services. GitNexus là monolith.          |
| **Memgraph (production-grade)**      | Distributed graph DB, cluster-ready. GitNexus dùng embedded LadybugDB — single-process lock. |
| **ChromaDB (managed vectors)**       | Tách riêng vector store, dễ scale. GitNexus vector built-in LadybugDB — lock contention.     |
| **Docker Compose infra**             | Production-ready deployment. GitNexus chỉ embedded local.                                    |
| **Multi-service awareness**          | Nexus biết quản lý N services khác nhau. GitNexus focus 1 repo tại 1 thời điểm.              |
| **Infrastructure pattern detection** | Nexus detect Kafka, DB, HTTP patterns. GitNexus chỉ detect code-level relationships.         |
| **nexus-config.yaml**                | Service registry rõ ràng. GitNexus dùng `~/.gitnexus/registry.json` flat.                    |
| **Zero Regression Policy**           | Documented policy. GitNexus có GUARDRAILS nhưng ít formal hơn.                               |
| **Agent safety hooks**               | PreToolUse safety check cho DENY/ASK/ALLOW commands. GitNexus hooks chỉ enrich, không guard. |

---

## 4. 10 ý tưởng chọn lọc để áp dụng

### Ý tưởng #1: Multi-Phase Ingestion Pipeline ⭐⭐⭐

**Hiện tại**: Nexus có 1 bước `SyncServiceKnowledge.run()` = scan + parse + upsert.

**Đề xuất**: Tách thành pipeline rõ ràng:

```
Phase 1: Filesystem Walk + Diff Detection
Phase 2: Tree-sitter Parsing (parallel workers)
Phase 3: Import Resolution (cross-file)
Phase 4: Call Resolution (with type inference)
Phase 5: Heritage Detection (extends/implements)
Phase 6: Community Detection (Leiden on CALLS graph)
Phase 7: Process Tracing (execution flows)
Phase 8: Vector Embedding (ChromaDB)
Phase 9: Staleness Metadata (git commit hash)
```

**Effort**: Large — 2-3 sprint  
**Impact**: Rất cao — nền tảng cho mọi feature khác

---

### Ý tưởng #2: Hybrid Search (BM25 + Semantic + RRF) ⭐⭐⭐

**Hiện tại**: `search_knowledge_base` chỉ dùng ChromaDB semantic search.

**Đề xuất**: Thêm BM25 layer (Memgraph full-text index) + RRF fusion:

```typescript
// Memgraph supports full-text search via text indices
// Combine results using RRF:
function rrfScore(ranks: number[], K = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (K + rank), 0);
}
```

**Effort**: Medium — 1 sprint  
**Impact**: Cao — solve "exact name search sucks with embeddings only"

---

### Ý tưởng #3: Community Detection (Leiden Algorithm) ⭐⭐

**Hiện tại**: Nexus không tự group functions vào clusters.

**Đề xuất**: Sau khi build CALLS graph, chạy Leiden trên Memgraph:

1. Export CALLS edges → in-memory graph (graphology)
2. Run Leiden → communities
3. Upsert `MEMBER_OF` edges + Community nodes
4. Optional LLM enrichment cho descriptions

**Effort**: Medium — 1 sprint  
**Impact**: Cao — "auto-detect service boundaries" rất hữu ích cho microservices

---

### Ý tưởng #4: Process Tracing (Execution Flows) ⭐⭐

**Hiện tại**: `get_impact_analysis` chỉ trace transitive deps theo edges.

**Đề xuất**: Detect execution flows:

1. Score: functions có nhiều outgoing calls nhưng ít incoming
2. BFS trace từ entry points
3. Create `Process` nodes + `STEP_IN_PROCESS` edges
4. Query: "process nào chứa function X?"

**Effort**: Medium — 1 sprint  
**Impact**: Trung bình-cao — giúp hiểu "flow nào chạy qua function này"

---

### Ý tưởng #5: Staleness Detection ⭐⭐

**Hiện tại**: Không biết KB có cũ không.

**Đề xuất**:

1. Khi sync → lưu `lastCommit` hash + timestamp vào Memgraph metadata
2. Khi query → compare với `git rev-parse HEAD`
3. Nếu stale → warning trong tool response
4. Auto-trigger re-sync khi stale quá N commits

**Effort**: Small — 2-3 ngày  
**Impact**: Cao — prevent "agent works on stale data"

---

### Ý tưởng #6: Confidence-Based Edges ⭐⭐

**Hiện tại**: Edges trong Memgraph không có confidence score.

**Đề xuất**: Thêm `confidence` property vào mọi relationship:

```cypher
MERGE (a)-[:CALLS {confidence: 0.9, reason: "constructor inference"}]->(b)
```

Agent filter: `WHERE r.confidence >= $minConfidence`

**Effort**: Small-Medium — 3-5 ngày  
**Impact**: Trung bình — impact analysis chính xác hơn

---

### Ý tưởng #7: detect_changes Tool ⭐⭐

**Hiện tại**: Không có tool nào check "changes ảnh hưởng gì".

**Đề xuất**: New MCP tool `detect_changes`:

1. `git diff --name-only` → changed files
2. Query graph: "symbols nào trong files này?"
3. Trace upstream: "ai gọi symbols bị sửa?"
4. Report: affected symbols, processes, risk level

**Effort**: Medium — 1 sprint  
**Impact**: Cao — pre-commit safety check

---

### Ý tưởng #8: Task-Oriented Skills (SKILL.md format) ⭐

**Hiện tại**: nexus-hub/skills/ chứa Security + API Design skills dạng rules.

**Đề xuất**: Thêm **task-oriented skills** theo pattern GitNexus:

```markdown
---
name: nexus-debugging
description: "Use when tracing bugs across services"
---

## Workflow

1. search_knowledge_base({query: "error keyword"})
2. query_graph({cypher: "MATCH callers..."})
3. get_impact_analysis({name: "suspect function"})
4. Read source files
```

**Effort**: Small — 2-3 ngày  
**Impact**: Trung bình — agent workflows rõ ràng hơn

---

### Ý tưởng #9: MCP Resources (Lightweight Context) ⭐

**Hiện tại**: Nexus chỉ có tools (callable). Không có resources (readable context).

**Đề xuất**: Thêm MCP Resources:

| Resource URI                      | Token Cost | Content                        |
| --------------------------------- | ---------- | ------------------------------ |
| `nexus://services`                | ~100       | List all services + stats      |
| `nexus://service/{name}/overview` | ~200       | Service overview + staleness   |
| `nexus://service/{name}/clusters` | ~300       | Auto-detected functional areas |
| `nexus://service/{name}/flows`    | ~400       | Execution flows                |

**Effort**: Medium — 1 sprint  
**Impact**: Trung bình — agent nhận context rẻ hơn gọi tool

---

### Ý tưởng #10: Evaluation Framework ⭐

**Hiện tại**: Không có cách đo chất lượng agent.

**Đề xuất**: Build eval harness:

1. Tạo test cases: "given this codebase question, expected answer X"
2. Run agent with/without KB tools
3. Compare: resolution rate, tokens used, accuracy
4. Track metrics over time

**Effort**: Large — 2+ sprint  
**Impact**: Trung bình — nhưng quan trọng cho long-term quality

---

## 5. Roadmap đề xuất

### Sprint 1 — Foundations (Tuần 1-2)

| #   | Task                                                  | Effort | Priority |
| --- | ----------------------------------------------------- | ------ | -------- |
| 1   | Staleness Detection (git commit tracking)             | Small  | P0       |
| 2   | Confidence-Based Edges                                | Small  | P0       |
| 3   | Refactor `SyncServiceKnowledge` thành pipeline phases | Medium | P0       |

### Sprint 2 — Search & Analysis (Tuần 3-4)

| #   | Task                                    | Effort | Priority |
| --- | --------------------------------------- | ------ | -------- |
| 4   | Hybrid Search (BM25 + Semantic + RRF)   | Medium | P1       |
| 5   | `detect_changes` MCP tool               | Medium | P1       |
| 6   | Heritage Detection (EXTENDS/IMPLEMENTS) | Medium | P1       |

### Sprint 3 — Intelligence (Tuần 5-6)

| #   | Task                                   | Effort | Priority |
| --- | -------------------------------------- | ------ | -------- |
| 7   | Community Detection (Leiden Algorithm) | Medium | P1       |
| 8   | Process Tracing (Execution Flows)      | Medium | P2       |
| 9   | MCP Resources (lightweight context)    | Medium | P2       |

### Sprint 4 — Agent Experience (Tuần 7-8)

| #   | Task                            | Effort | Priority |
| --- | ------------------------------- | ------ | -------- |
| 10  | Task-Oriented Skills (SKILL.md) | Small  | P2       |
| 11  | Evaluation Framework (basic)    | Large  | P2       |
| 12  | Wiki Generation (stretch)       | Large  | P3       |

---

## 6. Chi tiết kỹ thuật từng area

### 6.1 Graph Schema — Đề xuất mở rộng cho Nexus

**Hiện tại** Nexus có node types: `Service`, `File`, `Function`, `Class`, `Module`, `DagTask`.
**Edge types**: `CONTAINS`, `DEFINES`, `CALLS`, `IMPORTS`, `DEPENDS_ON`.

**Đề xuất thêm** (học từ GitNexus):

```
NEW NODE TYPES:
  - Community (auto-detected functional area)
  - Process (execution flow trace)
  - Route (HTTP endpoint)
  - Interface, Struct, Enum, Method, Constructor
  - Property (field/property of class)

NEW EDGE TYPES:
  - EXTENDS (class inheritance)
  - IMPLEMENTS (interface implementation)
  - HAS_METHOD (class → method ownership)
  - HAS_PROPERTY (class → property)
  - ACCESSES (function → property, read/write)
  - METHOD_OVERRIDES (MRO winner)
  - METHOD_IMPLEMENTS (method → interface method)
  - MEMBER_OF (symbol → community)
  - STEP_IN_PROCESS (symbol → process, with step order)
  - ENTRY_POINT_OF (function → process)
  - HANDLES_ROUTE (function → HTTP route)
  - FETCHES (function → external API)
  - WRAPS (decorator/wrapper pattern)

EDGE PROPERTIES (tất cả edges):
  + confidence: DOUBLE  (0.0 - 1.0)
  + reason: STRING       ("constructor inference", "type annotation", etc.)
  + step: INT            (for STEP_IN_PROCESS only)
```

### 6.2 Type Resolution — Thiết kế cho Nexus

GitNexus có 7 phase type resolution. Cho Nexus, đề xuất simplified version:

```typescript
interface TypeEnvironment {
  // Map (scope, varName) → resolvedType
  bindings: Map<string, TypeBinding>;
}

interface TypeBinding {
  name: string;
  resolvedType: string;
  tier: 0 | 1 | 2; // 0=annotation, 1=constructor, 2=assignment
  confidence: number;
}

// Resolution flow:
// 1. Extract type annotations from AST → Tier 0
// 2. Detect constructor calls (new X()) → Tier 1
// 3. Follow assignment chains → Tier 2
// 4. Use resolved types for CALLS edge targeting
```

### 6.3 RRF Hybrid Search — Implementation sketch

```typescript
interface SearchResult {
  id: string;
  score: number;
  sources: ("bm25" | "semantic")[];
}

function hybridSearch(query: string, limit: number): SearchResult[] {
  // 1. BM25 via Memgraph text index
  const bm25Results = memgraph.query(`
    CALL text_search.search("symbols", "${query}", 50)
    YIELD node, score
    RETURN node.id AS id, score
    ORDER BY score DESC
  `);

  // 2. Semantic via ChromaDB
  const semanticResults = chromadb.query({
    queryTexts: [query],
    nResults: 50,
  });

  // 3. RRF Fusion (K=60, industry standard)
  const K = 60;
  const scoreMap = new Map<string, SearchResult>();

  bm25Results.forEach((r, rank) => {
    const existing = scoreMap.get(r.id) || { id: r.id, score: 0, sources: [] };
    existing.score += 1 / (K + rank);
    existing.sources.push("bm25");
    scoreMap.set(r.id, existing);
  });

  semanticResults.forEach((r, rank) => {
    const existing = scoreMap.get(r.id) || { id: r.id, score: 0, sources: [] };
    existing.score += 1 / (K + rank);
    existing.sources.push("semantic");
    scoreMap.set(r.id, existing);
  });

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### 6.4 Community Detection — Leiden on Memgraph

```typescript
import Graph from "graphology";
// Note: need to vendor graphology-leiden (CJS compat)

async function detectCommunities(memgraph: MemgraphClient) {
  // 1. Export CALLS edges from Memgraph
  const edges = await memgraph.query(`
    MATCH (a)-[r:CALLS]->(b)
    RETURN a.id AS source, b.id AS target, r.confidence AS weight
  `);

  // 2. Build in-memory graph
  const graph = new Graph();
  for (const edge of edges) {
    if (!graph.hasNode(edge.source)) graph.addNode(edge.source);
    if (!graph.hasNode(edge.target)) graph.addNode(edge.target);
    graph.addEdge(edge.source, edge.target, { weight: edge.weight });
  }

  // 3. Run Leiden
  const communities = leiden(graph, { resolution: 1.0 });

  // 4. Upsert Community nodes + MEMBER_OF edges
  for (const [communityId, members] of Object.entries(communities)) {
    await memgraph.query(
      `
      CREATE (c:Community {id: $id, memberCount: $count})
    `,
      { id: communityId, count: members.length },
    );

    for (const memberId of members) {
      await memgraph.query(
        `
        MATCH (s {id: $symbolId}), (c:Community {id: $communityId})
        MERGE (s)-[:MEMBER_OF]->(c)
      `,
        { symbolId: memberId, communityId },
      );
    }
  }

  return communities;
}
```

### 6.5 Process Tracing — Execution Flow Detection

```typescript
async function traceProcesses(memgraph: MemgraphClient) {
  // 1. Find entry points (high outgoing, low incoming)
  const candidates = await memgraph.query(`
    MATCH (f:Function)
    OPTIONAL MATCH (f)-[:CALLS]->()
    WITH f, count(*) AS outgoing
    OPTIONAL MATCH ()-[:CALLS]->(f)
    WITH f, outgoing, count(*) AS incoming
    WHERE outgoing > 0 AND incoming <= 1
    RETURN f.id, f.name, outgoing - incoming * 0.5 AS score
    ORDER BY score DESC
    LIMIT 50
  `);

  // 2. BFS from each entry point
  for (const entry of candidates) {
    const trace = await memgraph.query(
      `
      MATCH path = (start:Function {id: $entryId})-[:CALLS*1..10]->(end)
      WHERE NOT (end)-[:CALLS]->()
      RETURN [n IN nodes(path) | n.id] AS steps
      ORDER BY length(path) DESC
      LIMIT 1
    `,
      { entryId: entry["f.id"] },
    );

    if (trace.length > 0) {
      // Create Process node + STEP_IN_PROCESS edges
      // ...
    }
  }
}
```

---

## Appendix A: GitNexus Technology Stack

| Component           | Technology                                     |
| ------------------- | ---------------------------------------------- |
| Language            | TypeScript (Node.js)                           |
| Parser              | tree-sitter (native) — 13 languages            |
| Graph DB            | LadybugDB (embedded, Cypher-compatible)        |
| Search              | Built-in FTS + vector index                    |
| Embeddings          | transformers.js (Snowflake Arctic XS, 384-dim) |
| CLI                 | Commander.js                                   |
| MCP                 | @modelcontextprotocol/sdk (stdio + HTTP)       |
| Web UI              | React + Vite + WASM workers                    |
| E2E Tests           | Playwright                                     |
| Unit Tests          | Vitest                                         |
| Community Detection | graphology-leiden (vendored)                   |
| CI/CD               | GitHub Actions (5 workflows)                   |
| Hooks               | Claude Code PreToolUse/PostToolUse             |
| Eval                | Python (SWE-bench, Docker containers)          |

## Appendix B: GitNexus MCP Tools vs Nexus MCP Tools

| Capability       | GitNexus Tool    | Nexus Tool               | Nexus Gap                                 |
| ---------------- | ---------------- | ------------------------ | ----------------------------------------- |
| Parse code       | CLI `analyze`    | `parse_code`             | Nexus parse đơn giản hơn                  |
| Sync to DB       | CLI `analyze`    | `sync_service_knowledge` | Nexus sync = 1 step, GitNexus = 15 phases |
| Graph query      | `cypher`         | `query_graph`            | Tương đương                               |
| Semantic search  | `query` (hybrid) | `search_knowledge_base`  | Nexus chỉ semantic, thiếu BM25            |
| Impact analysis  | `impact`         | `get_impact_analysis`    | Nexus cơ bản hơn, thiếu confidence        |
| Symbol context   | `context`        | ❌                       | **Missing**: 360° view of one symbol      |
| Change detection | `detect_changes` | ❌                       | **Missing**: pre-commit scope check       |
| Rename           | `rename`         | ❌                       | **Missing**: graph-aware rename           |
| List repos       | `list_repos`     | ❌                       | **Missing**: multi-repo discovery         |
| Resources        | 7 resource URIs  | ❌                       | **Missing**: lightweight context          |

## Appendix C: Compound Engineering Pattern (từ GitNexus)

GitNexus dùng mô hình **multi-specialist review** rất hay:

```yaml
review_agents:
  - typescript-reviewer # Code style, patterns
  - pattern-recognition # Cross-language consistency
  - architecture-strategist # System design review
  - data-integrity-guardian # DB/graph schema safety
  - security-sentinel # OWASP, injection, auth
  - performance-oracle # Perf impact analysis
  - code-simplicity-reviewer # Readability, KISS
```

**Áp dụng cho Nexus**: Có thể tạo các "review personas" trong agent workflow, mỗi persona kiểm tra 1 khía cạnh khi review code changes.

---

## Kết luận

GitNexus và Nexus có **cùng ý tưởng cốt lõi** (knowledge graph cho code intelligence), nhưng GitNexus đã mature hơn đáng kể ở:

1. **Depth of analysis** (15-phase pipeline vs single-pass)
2. **Search quality** (hybrid BM25+semantic vs semantic-only)
3. **Agent experience** (hooks, skills, resources, staleness)
4. **Tooling breadth** (CLI, Web UI, eval framework)

Tuy nhiên, Nexus có **lợi thế kiến trúc**:

- **Multi-service awareness** (Hub & Spoke) — GitNexus focus single repo
- **Production-grade infra** (Memgraph + ChromaDB via Docker) — GitNexus embedded DB
- **Infrastructure detection** (Kafka, DB patterns) — GitNexus chỉ code-level

**Chiến lược**: Giữ architecture advantage của Nexus, bổ sung analysis depth từ GitNexus. Ưu tiên **Hybrid Search, Staleness Detection, Confidence Edges, Community Detection** — những thứ có ROI cao nhất cho agent quality.
