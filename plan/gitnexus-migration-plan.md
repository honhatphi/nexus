# Nexus — GitNexus-Inspired Migration Plan

> **Ngày tạo**: 2026-04-14
> **Dựa trên**: `/nexus-hub/knowledge-base/gitnexus-analysis-report.md`
> **Mục tiêu**: Nâng cấp Nexus từ "scan & dump" lên "multi-phase intelligent analysis"
> **Giữ nguyên**: Hub & Spoke architecture, Memgraph + ChromaDB infra, multi-service awareness

---

## Tổng quan chiến lược

### Nguyên tắc chỉ đạo

1. **Giữ architecture advantage** — Hub & Spoke, production-grade infra, multi-service
2. **Bổ sung analysis depth** — học từ GitNexus 15-phase pipeline
3. **Incremental delivery** — mỗi phase tự chạy độc lập, không cần đợi phase sau
4. **Zero Regression** — không break API hiện tại, chỉ mở rộng
5. **ROI-first** — ưu tiên feature nào agent dùng được ngay

### Current State vs Target State

```
CURRENT (v0.1)                          TARGET (v1.0)
──────────────────                      ──────────────────
Single-pass sync                   →    9-phase pipeline
Semantic search only               →    Hybrid BM25 + Semantic + RRF
No staleness detection             →    Git commit tracking + auto-warning
No confidence on edges             →    Confidence-based edges (0.0–1.0)
Basic CALLS edges                  →    Type-resolved CALLS + Heritage
No community detection             →    Leiden algorithm auto-clustering
No execution flow tracing          →    Process Tracing (entry→terminal)
No change detection tool           →    detect_changes MCP tool
5 MCP tools                        →    8 MCP tools + 4 MCP resources
Rules-only skills                  →    Task-oriented SKILL.md workflows
5 languages (tree-sitter)          →    8+ languages
```

---

## Phase 0 — Foundation: Pipeline Architecture Refactor

> **Priority**: P0 — Nền tảng cho mọi phase sau
> **Effort**: Large (1.5–2 tuần)
> **Risk**: Medium — refactor core sync, cần test kỹ
> **Affected**: `common-tools/src/sync-tool.ts`, `mcp-server/src/tools/sync-service.ts`

### 0.1 Tách sync thành Pipeline Engine

**Hiện tại**: `SyncServiceKnowledge.run()` và `registerSyncTool()` là 1 hàm monolithic:

- scan files → parse → upsert graph → upsert vector (lặp per file)

**Target**: Pipeline architecture với các phase độc lập:

```
nexus-hub/common-tools/src/
├── index.ts
├── types.ts
├── universal-parser.ts          # giữ nguyên, mở rộng
├── sync-tool.ts                 # → thin wrapper gọi pipeline
└── pipeline/                    # NEW
    ├── index.ts                 # PipelineEngine class
    ├── types.ts                 # PipelineContext, PhaseResult
    ├── phase-0-filesystem.ts    # File discovery + diff detection
    ├── phase-1-parse.ts         # Tree-sitter parsing (parallel)
    ├── phase-2-imports.ts       # Import resolution (cross-file)
    ├── phase-3-calls.ts         # Call resolution (with type hints)
    ├── phase-4-heritage.ts      # EXTENDS / IMPLEMENTS detection
    ├── phase-5-community.ts     # Leiden community detection
    ├── phase-6-process.ts       # Execution flow tracing
    ├── phase-7-vectors.ts       # ChromaDB embedding upsert
    └── phase-8-metadata.ts      # Staleness + git commit tracking
```

### 0.2 Pipeline Context & Phase Interface

```typescript
// pipeline/types.ts

export interface PipelineContext {
  serviceName: string;
  servicePath: string;
  forceUpdate: boolean;

  // Phase 0 output
  sourceFiles: FileEntry[];
  changedFiles: FileEntry[];

  // Phase 1 output
  parseResults: Map<string, ParseResult>;

  // Phase 2 output
  importGraph: ImportEdge[];

  // Phase 3 output
  resolvedCalls: ResolvedCall[];

  // Phase 4 output
  heritageEdges: HeritageEdge[];

  // Phase 5 output
  communities: Community[];

  // Phase 6 output
  processes: ProcessTrace[];

  // Metadata
  gitCommitHash: string | null;
  startedAt: number;
  errors: PhaseError[];
}

export interface PipelinePhase {
  name: string;
  order: number;
  run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult>;
}

export interface PipelineDeps {
  memgraph: MemgraphClient;
  chromadb: ChromaDBClient;
  parser: CodeParser;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  stats: Record<string, number>;
  errors: string[];
  durationMs: number;
}
```

### 0.3 Pipeline Engine

```typescript
// pipeline/index.ts

export class PipelineEngine {
  private phases: PipelinePhase[] = [];

  register(phase: PipelinePhase): void {
    this.phases.push(phase);
    this.phases.sort((a, b) => a.order - b.order);
  }

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PipelineReport> {
    const results: PhaseResult[] = [];

    for (const phase of this.phases) {
      const start = Date.now();
      try {
        const result = await phase.run(ctx, deps);
        result.durationMs = Date.now() - start;
        results.push(result);

        if (!result.success) {
          // Non-critical phase failure — log and continue
          ctx.errors.push(
            ...result.errors.map((e) => ({
              phase: phase.name,
              message: e,
            })),
          );
        }
      } catch (err) {
        results.push({
          phase: phase.name,
          success: false,
          stats: {},
          errors: [String(err)],
          durationMs: Date.now() - start,
        });
      }
    }

    return { phases: results, context: ctx };
  }
}
```

### 0.4 Backward Compatibility

- `SyncServiceKnowledge.run()` trong `common-tools` → giữ nguyên API, bên trong gọi `PipelineEngine`
- `registerSyncTool()` trong `mcp-server` → response format giữ nguyên, thêm `phases` detail
- MCP tool `sync_service_knowledge` → cùng input schema, output mở rộng (thêm `pipelineReport`)

### Tasks

- [ ] Tạo `pipeline/types.ts` — context, phase interface, result types
- [ ] Tạo `pipeline/index.ts` — PipelineEngine class
- [ ] Migrate filesystem walk → `phase-0-filesystem.ts`
- [ ] Migrate tree-sitter parsing → `phase-1-parse.ts`
- [ ] Migrate graph upsert logic → tách riêng, phase gọi lại
- [ ] Migrate vector upsert logic → `phase-7-vectors.ts`
- [ ] Update `sync-tool.ts` → thin wrapper around PipelineEngine
- [ ] Update `mcp-server/src/tools/sync-service.ts` → dùng PipelineEngine
- [ ] Add integration test: pipeline chạy đúng thứ tự, output consistent
- [ ] Verify: `test-sync.mjs` vẫn pass

---

## Phase 1 — Staleness Detection

> **Priority**: P0 — Agent phải biết data có cũ không
> **Effort**: Small (2–3 ngày)
> **Risk**: Low
> **Affected**: `pipeline/phase-8-metadata.ts`, `mcp-server/src/tools/index.ts`

### 1.1 Git Commit Tracking

Khi sync:

```typescript
// phase-8-metadata.ts
import { execSync } from "node:child_process";

function getGitHead(servicePath: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: servicePath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function getCommitCount(from: string, to: string, cwd: string): number {
  try {
    return parseInt(
      execSync(`git rev-list --count ${from}..${to}`, {
        cwd,
        encoding: "utf-8",
      }).trim(),
      10,
    );
  } catch {
    return -1;
  }
}
```

Lưu vào Memgraph:

```cypher
MERGE (s:Service {name: $service})
SET s.lastSyncCommit = $commitHash,
    s.lastSyncAt = timestamp(),
    s.lastSyncFileCount = $fileCount
```

### 1.2 Staleness Warning trong Tool Responses

Mọi MCP tool (`query_graph`, `search_knowledge_base`, `get_impact_analysis`) check staleness:

```typescript
async function checkStaleness(
  memgraph: MemgraphClient,
  serviceName: string,
  servicePath: string,
): Promise<StalenessInfo | null> {
  const rows = await memgraph.query(
    `MATCH (s:Service {name: $name}) RETURN s.lastSyncCommit AS commit, s.lastSyncAt AS syncAt`,
    { name: serviceName },
  );
  if (rows.length === 0) return null;

  const lastCommit = rows[0].commit as string;
  const currentHead = getGitHead(servicePath);
  if (!currentHead || currentHead === lastCommit) return null;

  const commitsAhead = getCommitCount(lastCommit, currentHead, servicePath);
  return {
    stale: true,
    lastSyncCommit: lastCommit.slice(0, 8),
    currentHead: currentHead.slice(0, 8),
    commitsBehind: commitsAhead,
    message: `⚠️ KB data is ${commitsAhead} commits behind HEAD. Consider re-syncing.`,
  };
}
```

### Tasks

- [ ] Implement git commit detection trong `phase-8-metadata.ts`
- [ ] Upsert `lastSyncCommit`, `lastSyncAt` vào Service node
- [ ] Add `checkStaleness()` helper shared giữa các tools
- [ ] Integrate staleness check vào `query_graph` response
- [ ] Integrate staleness check vào `search_knowledge_base` response
- [ ] Integrate staleness check vào `get_impact_analysis` response
- [ ] Test: sync → commit new file → query → verify warning

---

## Phase 2 — Confidence-Based Edges

> **Priority**: P0 — Nâng chất lượng impact analysis
> **Effort**: Small-Medium (3–5 ngày)
> **Risk**: Low — additive change, không break existing edges
> **Affected**: `pipeline/phase-3-calls.ts`, `mcp-server/src/tools/sync-service.ts`

### 2.1 Confidence Scoring Rules

| Scenario                     | Confidence | Reason                  |
| ---------------------------- | ---------- | ----------------------- |
| Same-file call               | 0.95       | `direct`                |
| Relative import + call       | 0.90       | `relative_import`       |
| Module import + call         | 0.85       | `module_import`         |
| Type-annotated method call   | 0.90       | `type_annotation`       |
| Constructor inference call   | 0.85       | `constructor_inference` |
| Unresolved (name-match only) | 0.70       | `name_match`            |
| External library call        | 0.60       | `external`              |

### 2.2 Edge Properties

```cypher
-- CALLS edge mở rộng
MERGE (caller)-[r:CALLS]->(callee)
SET r.confidence = $confidence,
    r.reason = $reason,
    r.line = $line,
    r.updatedAt = timestamp()
```

### 2.3 Impact Analysis với Confidence Filter

Update `getImpact()` trong `MemgraphClient`:

```typescript
async getImpact(name: string, maxDepth = 3, minConfidence = 0.0): Promise<Record<string, unknown>[]> {
  const cypher = `
    MATCH path = (source)-[:DEPENDS_ON|CALLS|IMPORTS*1..${maxDepth}]->(target)
    WHERE (source.name = $name OR source.file = $name)
      AND ALL(r IN relationships(path) WHERE coalesce(r.confidence, 1.0) >= $minConf)
    RETURN source.name AS source, target.name AS dependency,
           [r IN relationships(path) | r.confidence] AS confidences,
           length(path) AS depth
    ORDER BY depth
  `;
  return this.query(cypher, { name, minConf: minConfidence });
}
```

### 2.4 MCP Tool Update

Add `min_confidence` param vào `get_impact_analysis`:

```typescript
min_confidence: z.number()
  .min(0)
  .max(1)
  .default(0)
  .describe(
    "Minimum relationship confidence threshold (0.0–1.0). Higher = fewer but more reliable results.",
  );
```

### Tasks

- [ ] Define confidence scoring function (per-language rules)
- [ ] Update CALLS edge upsert: add `confidence`, `reason` properties
- [ ] Update IMPORTS edge upsert: add `confidence`
- [ ] Update `MemgraphClient.getImpact()` → support `minConfidence`
- [ ] Add `min_confidence` param vào `get_impact_analysis` MCP tool
- [ ] Backfill: khi sync lại, existing edges nhận `confidence` score
- [ ] Test: verify edges có confidence, impact filter hoạt động

---

## Phase 3 — Import Resolution Enhancement

> **Priority**: P1 — Prerequisite cho Type Resolution và accurate CALLS
> **Effort**: Medium (1 tuần)
> **Risk**: Medium
> **Affected**: `pipeline/phase-2-imports.ts`, `universal-parser.ts`

### 3.1 Import Graph

Hiện tại parser detect `calls` nhưng không resolve cross-file imports. Cần:

```typescript
// pipeline/phase-2-imports.ts

export interface ImportEdge {
  sourceFile: string; // file chứa import statement
  targetModule: string; // raw import path
  resolvedFile: string | null; // resolved absolute path (null = external)
  importedNames: string[]; // named imports ["foo", "bar"] hoặc ["*"]
  isExternal: boolean; // node_modules / pip package
  confidence: number; // 0.85 relative, 0.80 module, 0.60 external
}
```

### 3.2 Resolution Strategy per Language

| Language   | Import Syntax                  | Resolution                                       |
| ---------- | ------------------------------ | ------------------------------------------------ |
| TypeScript | `import { X } from "./foo"`    | Resolve relative path, check `.ts/.tsx/.js`      |
| Python     | `from .module import func`     | Resolve relative to package, check `__init__.py` |
| Go         | `import "github.com/org/pkg"`  | Match go.mod module path                         |
| PHP        | `use App\Services\UserService` | PSR-4 namespace → directory mapping              |
| C#         | `using MyNamespace.MyClass`    | Namespace → assembly resolution                  |

### 3.3 Graph Upsert

```cypher
MERGE (source:File {path: $sourceFile})
MERGE (target:File {path: $targetFile})
MERGE (source)-[r:IMPORTS]->(target)
SET r.importedNames = $names,
    r.confidence = $confidence,
    r.updatedAt = timestamp()
```

### Tasks

- [ ] Extract import statements per language trong `universal-parser.ts`
- [ ] Implement `phase-2-imports.ts` — cross-file resolution
- [ ] TypeScript/JS: resolve relative imports, handle index.ts
- [ ] Python: resolve relative/absolute imports, handle `__init__.py`
- [ ] Go: resolve package imports via go.mod
- [ ] Upsert IMPORTS edges with `confidence` + `importedNames`
- [ ] Test: multi-file project → verify IMPORTS graph accuracy

---

## Phase 4 — Heritage Detection (EXTENDS / IMPLEMENTS)

> **Priority**: P1 — Understanding class hierarchies
> **Effort**: Medium (4–5 ngày)
> **Risk**: Low — parser đã extract `ClassInfo.bases`
> **Affected**: `pipeline/phase-4-heritage.ts`, `types.ts`

### 4.1 Hiện trạng

Parser đã extract `ClassInfo` với `bases: string[]` và upsert `INHERITS` edges. Cần mở rộng:

### 4.2 Mở rộng

```typescript
export interface HeritageEdge {
  childClass: string;
  childFile: string;
  parentClass: string;
  parentFile: string | null; // resolved file, null = external
  kind: "extends" | "implements";
  confidence: number;
}
```

### 4.3 Per-Language Detection

| Language   | Extends               | Implements                           |
| ---------- | --------------------- | ------------------------------------ |
| TypeScript | `class A extends B`   | `class A implements I`               |
| Python     | `class A(B, C)`       | (mixin pattern)                      |
| PHP        | `class A extends B`   | `class A implements I, J`            |
| C#         | `class A : B, IC, ID` | (first = extends, rest = implements) |
| Go         | (no classes)          | `type S struct` + method sets        |

### 4.4 New Node Types

```cypher
-- Interface node
MERGE (i:Interface {name: $name, file: $file, service: $service})

-- EXTENDS edge
MERGE (child:Class {name: $child})-[r:EXTENDS]->(parent:Class {name: $parent})
SET r.confidence = $confidence

-- IMPLEMENTS edge
MERGE (cls:Class {name: $class})-[r:IMPLEMENTS]->(iface:Interface {name: $iface})
SET r.confidence = $confidence
```

### Tasks

- [ ] Extend parser: detect `implements` keyword per language
- [ ] Add `Interface` node type vào graph schema
- [ ] Tách `INHERITS` → `EXTENDS` + `IMPLEMENTS`
- [ ] Implement `phase-4-heritage.ts`
- [ ] Cross-file resolve: `extends B` → tìm `B` ở file nào qua import graph
- [ ] Test: TypeScript class hierarchy → verify EXTENDS/IMPLEMENTS edges

---

## Phase 5 — Hybrid Search (BM25 + Semantic + RRF)

> **Priority**: P1 — Lớn nhất improvement cho agent search quality
> **Effort**: Medium (1 tuần)
> **Risk**: Medium — thêm Memgraph text index, change search response format
> **Affected**: `mcp-server/src/clients/memgraph.ts`, `mcp-server/src/tools/index.ts`

### 5.1 Architecture

```
User Query
    ├── BM25 (Memgraph text index) → ranked by keyword relevance
    ├── Semantic (ChromaDB cosine) → ranked by embedding similarity
    └── RRF Fusion (K=60) → final merged ranking
```

### 5.2 Memgraph Text Index

```cypher
-- Create text index on Function nodes
CREATE TEXT INDEX ON :Function;
CREATE TEXT INDEX ON :Class;
CREATE TEXT INDEX ON :File;

-- Query with text search
CALL text_search.search_all("search query") YIELD node, score
RETURN node.name, node.file, node.service, labels(node), score
ORDER BY score DESC
LIMIT 50;
```

### 5.3 RRF Implementation

```typescript
// clients/search.ts (NEW)

export interface HybridSearchResult {
  id: string;
  name: string;
  file: string;
  service: string;
  kind: string;
  score: number;
  sources: ("bm25" | "semantic")[];
  bm25Rank?: number;
  semanticRank?: number;
  document?: string;
}

const RRF_K = 60;

function rrfFusion(
  bm25Results: { id: string; score: number; [key: string]: unknown }[],
  semanticResults: { id: string; score: number; [key: string]: unknown }[],
  limit: number,
): HybridSearchResult[] {
  const scoreMap = new Map<string, HybridSearchResult>();

  bm25Results.forEach((r, rank) => {
    const existing = scoreMap.get(r.id) ?? {
      id: r.id,
      score: 0,
      sources: [],
      ...r,
    };
    existing.score += 1 / (RRF_K + rank);
    existing.sources.push("bm25");
    existing.bm25Rank = rank;
    scoreMap.set(r.id, existing as HybridSearchResult);
  });

  semanticResults.forEach((r, rank) => {
    const existing = scoreMap.get(r.id) ?? {
      id: r.id,
      score: 0,
      sources: [],
      ...r,
    };
    existing.score += 1 / (RRF_K + rank);
    existing.sources.push("semantic");
    existing.semanticRank = rank;
    scoreMap.set(r.id, existing as HybridSearchResult);
  });

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### 5.4 MCP Tool Update

Update `search_knowledge_base`:

```typescript
server.tool(
  "search_knowledge_base",
  "Hybrid search (BM25 + Semantic) over Nexus KB with RRF fusion.",
  {
    query: z.string(),
    topK: z.number().int().min(1).max(20).default(5),
    mode: z
      .enum(["hybrid", "semantic", "keyword"])
      .default("hybrid")
      .describe(
        "Search mode: hybrid (BM25+Semantic+RRF), semantic only, or keyword only.",
      ),
  },
  async ({ query, topK, mode }) => {
    /* ... */
  },
);
```

### Tasks

- [ ] Create Memgraph text indices (`Function`, `Class`, `File`)
- [ ] Add `bm25Search()` method vào `MemgraphClient`
- [ ] Create `clients/search.ts` — RRF fusion logic
- [ ] Update `search_knowledge_base` tool: add `mode` param
- [ ] Default mode = `hybrid`, fallback to `semantic` nếu text index unavailable
- [ ] Test: query exact function name → verify BM25 ranks higher than semantic
- [ ] Test: query concept → verify semantic ranks higher than BM25
- [ ] Test: hybrid combines both correctly

---

## Phase 6 — Community Detection (Leiden Algorithm)

> **Priority**: P1 — Auto-detect functional areas
> **Effort**: Medium (1 tuần)
> **Risk**: Medium — external dep (graphology-leiden), computational cost
> **Affected**: `pipeline/phase-5-community.ts`, new MCP tool

### 6.1 Dependency

```bash
# common-tools
npm install graphology graphology-communities-leiden
```

Note: có thể cần vendor/patch nếu CJS/ESM compat issues (GitNexus đã vendor).

### 6.2 Implementation

```typescript
// pipeline/phase-5-community.ts

import Graph from "graphology";
import { leiden } from "graphology-communities-leiden";

export async function detectCommunities(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<PhaseResult> {
  // 1. Export CALLS edges from Memgraph
  const edges = await deps.memgraph.query(
    `
    MATCH (a:Function {service: $service})-[r:CALLS]->(b:Function {service: $service})
    RETURN a.name + '::' + a.file AS source,
           b.name + '::' + b.file AS target,
           coalesce(r.confidence, 0.7) AS weight
  `,
    { service: ctx.serviceName },
  );

  if (edges.length < 5)
    return {
      phase: "community",
      success: true,
      stats: { skipped: 1 },
      errors: [],
      durationMs: 0,
    };

  // 2. Build in-memory graph
  const graph = new Graph();
  for (const edge of edges) {
    const src = edge.source as string;
    const tgt = edge.target as string;
    if (!graph.hasNode(src)) graph.addNode(src);
    if (!graph.hasNode(tgt)) graph.addNode(tgt);
    if (!graph.hasEdge(src, tgt)) {
      graph.addEdge(src, tgt, { weight: edge.weight as number });
    }
  }

  // 3. Run Leiden
  const assignments = leiden(graph, { resolution: 1.0 });

  // 4. Group by community
  const communities = new Map<number, string[]>();
  graph.forEachNode((node, attrs) => {
    const communityId = assignments[node] ?? 0;
    const list = communities.get(communityId) ?? [];
    list.push(node);
    communities.set(communityId, list);
  });

  // 5. Upsert Community nodes + MEMBER_OF edges
  let nodesCreated = 0;
  for (const [commId, members] of communities) {
    const communityName = `${ctx.serviceName}::community-${commId}`;
    await deps.memgraph.write(
      `MERGE (c:Community {name: $name, service: $service})
       SET c.memberCount = $count, c.updatedAt = timestamp()`,
      { name: communityName, service: ctx.serviceName, count: members.length },
    );
    nodesCreated++;

    for (const memberId of members) {
      const [funcName, funcFile] = memberId.split("::");
      await deps.memgraph.write(
        `MATCH (f:Function {name: $funcName, file: $funcFile, service: $service})
         MERGE (c:Community {name: $communityName, service: $service})
         MERGE (f)-[:MEMBER_OF]->(c)`,
        { funcName, funcFile, service: ctx.serviceName, communityName },
      );
    }
  }

  ctx.communities = [...communities.entries()].map(([id, members]) => ({
    id,
    name: `${ctx.serviceName}::community-${id}`,
    members,
  }));

  return {
    phase: "community",
    success: true,
    stats: {
      communitiesDetected: communities.size,
      membersAssigned: nodesCreated,
    },
    errors: [],
    durationMs: 0,
  };
}
```

### 6.3 New MCP Resource (optional)

```typescript
// nexus://service/{name}/clusters
server.resource(`nexus://service/${name}/clusters`, async () => {
  const rows = await memgraph.query(
    `
    MATCH (c:Community {service: $service})<-[:MEMBER_OF]-(f:Function)
    RETURN c.name, collect(f.name) AS members, c.memberCount
  `,
    { service: name },
  );
  return { contents: [{ text: JSON.stringify(rows) }] };
});
```

### Tasks

- [ ] Install `graphology` + `graphology-communities-leiden`
- [ ] Implement `phase-5-community.ts`
- [ ] Add `Community` node type + `MEMBER_OF` edge type vào graph schema
- [ ] Clear old communities trước khi re-detect (`DELETE` old MEMBER_OF edges)
- [ ] Optional: LLM-generated community descriptions (stretch)
- [ ] Test: sync warehouse-2.0 → verify communities detected & meaningful

---

## Phase 7 — Process Tracing (Execution Flows)

> **Priority**: P2 — Nâng cao khả năng trace "luồng nào chạy qua function X"
> **Effort**: Medium (1 tuần)
> **Risk**: Medium — BFS complexity, cần limit depth/branches
> **Affected**: `pipeline/phase-6-process.ts`, new MCP tool

### 7.1 Entry Point Detection

```typescript
// Score functions: nhiều outgoing CALLS, ít incoming → likely entry point
const candidates = await memgraph.query(
  `
  MATCH (f:Function {service: $service})
  OPTIONAL MATCH (f)-[:CALLS]->()
  WITH f, count(*) AS outgoing
  OPTIONAL MATCH ()-[:CALLS]->(f)
  WITH f, outgoing, count(*) AS incoming
  WHERE outgoing > 0 AND incoming <= 1
  RETURN f.name, f.file, outgoing - incoming * 0.5 AS score
  ORDER BY score DESC
  LIMIT 50
`,
  { service: serviceName },
);
```

### 7.2 BFS Trace

```typescript
// Max depth 10, max branches 4 per node
async function traceProcess(
  entryId: string,
  memgraph: MemgraphClient,
): Promise<string[][]> {
  const traces = await memgraph.query(
    `
    MATCH path = (start:Function {name: $name})-[:CALLS*1..10]->(end:Function)
    WHERE NOT (end)-[:CALLS]->(:Function)
    RETURN [n IN nodes(path) | n.name] AS steps
    ORDER BY length(path) DESC
    LIMIT 4
  `,
    { name: entryId },
  );

  return traces.map((t) => t.steps as string[]);
}
```

### 7.3 Graph Schema

```cypher
-- Process node
MERGE (p:Process {name: $processName, service: $service})
SET p.entryPoint = $entryFunc, p.stepCount = $stepCount

-- STEP_IN_PROCESS edge
MATCH (f:Function {name: $funcName})
MATCH (p:Process {name: $processName})
MERGE (f)-[r:STEP_IN_PROCESS]->(p)
SET r.step = $stepOrder
```

### 7.4 New MCP Tool: `get_process_flows`

```typescript
server.tool(
  "get_process_flows",
  "Discover execution flows through a function — traces the call chain from entry points to terminal functions.",
  {
    function_name: z.string(),
    service: z.string().optional(),
    max_depth: z.number().int().min(1).max(15).default(10),
  },
  async ({ function_name, service, max_depth }) => {
    /* ... */
  },
);
```

### Tasks

- [ ] Implement entry point detection heuristic
- [ ] Implement BFS trace with depth/branch limits
- [ ] Add `Process` node type + `STEP_IN_PROCESS`, `ENTRY_POINT_OF` edge types
- [ ] Implement `phase-6-process.ts`
- [ ] Register `get_process_flows` MCP tool
- [ ] Deduplicate subset traces (keep longest unique paths)
- [ ] Test: sync → verify process flows detected for known entry points

---

## Phase 8 — `detect_changes` MCP Tool

> **Priority**: P1 — Pre-commit safety check
> **Effort**: Medium (4–5 ngày)
> **Risk**: Low — read-only tool
> **Affected**: `mcp-server/src/tools/` — new file

### 8.1 Workflow

```
1. git diff --name-only [base..HEAD]  → changed files
2. Query graph: symbols trong changed files?
3. Trace upstream: ai CALLS symbols bị sửa?
4. Check communities: community nào bị affect?
5. Report: affected symbols, callers, communities, risk level
```

### 8.2 MCP Tool Definition

```typescript
server.tool(
  "detect_changes",
  "Analyze git changes to determine which functions, callers, and communities are affected. Use before commit to assess risk.",
  {
    service_path: z.string().describe("Path to the service directory."),
    base: z
      .string()
      .default("HEAD~1")
      .describe("Git base ref to compare against (default: HEAD~1)."),
    head: z
      .string()
      .default("HEAD")
      .describe(
        "Git head ref (default: HEAD, or 'working' for uncommitted changes).",
      ),
  },
  async ({ service_path, base, head }) => {
    // 1. Get changed files
    const diffCmd =
      head === "working"
        ? `git diff --name-only ${base}`
        : `git diff --name-only ${base}..${head}`;
    const changedFiles = execSync(diffCmd, {
      cwd: service_path,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    // 2. Find affected symbols
    const affectedSymbols = await memgraph.query(
      `
      MATCH (f:Function)-[:DEFINED_IN]->(fi:File)
      WHERE fi.path IN $files
      RETURN f.name, fi.path, f.kind
    `,
      { files: changedFiles.map((f) => `${serviceName}/${f}`) },
    );

    // 3. Find upstream callers
    const callers = await memgraph.query(
      `
      MATCH (caller:Function)-[:CALLS]->(target:Function)-[:DEFINED_IN]->(fi:File)
      WHERE fi.path IN $files AND caller.file <> fi.path
      RETURN caller.name, caller.file, target.name AS calledFunction
    `,
      { files: changedFiles.map((f) => `${serviceName}/${f}`) },
    );

    // 4. Risk assessment
    const riskLevel =
      callers.length > 10 ? "HIGH" : callers.length > 3 ? "MEDIUM" : "LOW";

    return {
      changedFiles,
      affectedSymbols,
      externalCallers: callers,
      riskLevel,
      recommendation:
        riskLevel === "HIGH"
          ? "Consider running full test suite and reviewing all callers."
          : "Changes appear safe. Run relevant tests.",
    };
  },
);
```

### Tasks

- [ ] Create `mcp-server/src/tools/detect-changes.ts`
- [ ] Implement git diff parsing
- [ ] Query graph for affected symbols + callers
- [ ] Calculate risk level heuristic
- [ ] Register tool in `mcp-server/src/tools/index.ts`
- [ ] Handle edge case: uncommitted changes (`--cached`, working tree)
- [ ] Test: modify file → detect_changes → verify callers listed

---

## Phase 9 — Type Resolution (Simplified)

> **Priority**: P2 — Nâng accuracy cho CALLS edges
> **Effort**: Large (1.5–2 tuần)
> **Risk**: High — complex cross-file analysis
> **Affected**: `pipeline/phase-3-calls.ts`, `universal-parser.ts`

### 9.1 Simplified 3-Tier System (vs GitNexus 7-tier)

```
Tier 0: Type annotation     → confidence 1.0  (const x: MyType = ...)
Tier 1: Constructor call     → confidence 0.9  (const x = new MyClass())
Tier 2: Assignment chain     → confidence 0.8  (const x = getUser() → returnType)
```

### 9.2 TypeEnvironment

```typescript
export interface TypeBinding {
  varName: string;
  resolvedType: string;
  tier: 0 | 1 | 2;
  confidence: number;
  scope: string; // function/class scope
}

export interface TypeEnvironment {
  bindings: Map<string, TypeBinding>;
}
```

### 9.3 Usage: Improving CALLS edges

```
Before:  user.save() → CALLS edge to ANY save() in codebase (confidence 0.7)
After:   user: User → user.save() → CALLS edge to User.save() (confidence 0.9)
```

### Tasks

- [ ] Extract type annotations from AST (per language)
- [ ] Detect constructor calls (`new X()`) → infer type
- [ ] Build TypeEnvironment per file
- [ ] Use TypeEnvironment to resolve `obj.method()` → specific class method
- [ ] Update CALLS edge confidence based on resolution tier
- [ ] Test: TypeScript class → `const svc = new PaymentService(); svc.charge()` → correct CALLS

---

## Phase 10 — MCP Resources (Lightweight Context)

> **Priority**: P2 — Agent nhận context rẻ hơn
> **Effort**: Medium (3–5 ngày)
> **Risk**: Low
> **Affected**: `mcp-server/src/index.ts`

### 10.1 Resource URIs

| Resource URI                      | Token Cost | Content                                               |
| --------------------------------- | ---------- | ----------------------------------------------------- |
| `nexus://services`                | ~100       | List all services + sync status + staleness           |
| `nexus://service/{name}/overview` | ~200       | Service stats: files, functions, classes, communities |
| `nexus://service/{name}/clusters` | ~300       | Auto-detected communities + top functions             |
| `nexus://service/{name}/flows`    | ~400       | Execution flows (process traces)                      |

### 10.2 Implementation

```typescript
// MCP SDK resource registration
server.resource(
  "nexus://services",
  "List all indexed services with sync status",
  async () => {
    const services = await memgraph.query(`
      MATCH (s:Service)
      OPTIONAL MATCH (s)-[:CONTAINS]->(f:File)
      RETURN s.name AS name, s.lastSyncAt AS lastSync,
             s.lastSyncCommit AS commit, count(f) AS fileCount
    `);
    return {
      contents: [
        { uri: "nexus://services", text: JSON.stringify(services, null, 2) },
      ],
    };
  },
);
```

### Tasks

- [ ] Register `nexus://services` resource
- [ ] Register `nexus://service/{name}/overview` resource
- [ ] Register `nexus://service/{name}/clusters` resource (requires Phase 6)
- [ ] Register `nexus://service/{name}/flows` resource (requires Phase 7)
- [ ] Test: agent reads resource → verify token-efficient context

---

## Phase 11 — Task-Oriented Skills

> **Priority**: P2 — Agent workflows rõ ràng hơn
> **Effort**: Small (2–3 ngày)
> **Risk**: None — chỉ viết markdown files
> **Affected**: `nexus-hub/skills/`

### 11.1 Skill Files

```
nexus-hub/skills/
├── debugging/
│   └── SKILL.md      # Tracing bugs across services
├── feature-impl/
│   └── SKILL.md      # Implementing new features (hub-first)
├── code-review/
│   └── SKILL.md      # Reviewing changes with KB context
├── migration/
│   └── SKILL.md      # Database/API migration workflow
├── performance/
│   └── SKILL.md      # Performance analysis using graph
└── onboarding/
    └── SKILL.md      # Understanding a new service via KB
```

### 11.2 Skill Template

```markdown
---
name: nexus-debugging
description: "Use when tracing bugs that span multiple functions or services"
tools:
  [search_knowledge_base, query_graph, get_impact_analysis, get_process_flows]
---

## When to Use

- User reports a bug involving multiple functions/files
- Stack trace crosses service boundaries
- Need to understand full execution path

## Workflow

1. **Search KB** for error-related symbols
2. **Query graph** for callers/callees of suspect function
3. **Get impact analysis** to find blast radius
4. **Get process flows** to trace execution path
5. **Read source files** at identified locations
6. Propose fix with KB-grounded context

## Anti-patterns

- Do NOT guess without checking KB first
- Do NOT modify shared modules without impact analysis
```

### Tasks

- [ ] Create `debugging/SKILL.md`
- [ ] Create `feature-impl/SKILL.md`
- [ ] Create `code-review/SKILL.md`
- [ ] Create `onboarding/SKILL.md`
- [ ] Reference skills trong `.github/copilot-instructions.md`

---

## Phase 12 — Extended Language Support

> **Priority**: P3 — Mở rộng coverage
> **Effort**: Medium (per language ~2 ngày)
> **Risk**: Low — additive, parser modular
> **Affected**: `common-tools/src/universal-parser.ts`, `types.ts`

### 12.1 Language Roadmap

| Language   | tree-sitter WASM              | Priority | Use case                      |
| ---------- | ----------------------------- | -------- | ----------------------------- |
| JavaScript | `tree-sitter-javascript.wasm` | P1       | Frontend, Node.js services    |
| Java       | `tree-sitter-java.wasm`       | P2       | Enterprise backend            |
| Rust       | `tree-sitter-rust.wasm`       | P3       | Performance-critical services |
| SQL        | `tree-sitter-sql.wasm`        | P2       | Stored procedures, migrations |
| Kotlin     | `tree-sitter-kotlin.wasm`     | P3       | Android                       |

### 12.2 Changes Needed

```typescript
// types.ts
export type SupportedLanguage =
  | "go"
  | "python"
  | "php"
  | "typescript"
  | "csharp"
  | "javascript"
  | "java"
  | "rust"
  | "sql"
  | "kotlin" // NEW
  | "yaml";

export const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  // ... existing
  ".js": "javascript",
  ".jsx": "javascript",
  ".java": "java",
  ".rs": "rust",
  ".sql": "sql",
  ".kt": "kotlin",
};

// universal-parser.ts — add extractors per new language
```

### Tasks

- [ ] Add JavaScript extractor (highest priority — share base with TypeScript)
- [ ] Add Java extractor
- [ ] Add SQL extractor (for stored procedures & migration analysis)
- [ ] Update `SupportedLanguage` type + `EXTENSION_MAP`
- [ ] Test each new language with sample files

---

## Delivery Roadmap

### Sprint 1 — Foundations (Tuần 1–2) ⭐ Critical Path

| #   | Task                           | Phase | Effort | Priority | Dependencies |
| --- | ------------------------------ | ----- | ------ | -------- | ------------ |
| 1   | Pipeline Architecture Refactor | 0     | Large  | P0       | —            |
| 2   | Staleness Detection            | 1     | Small  | P0       | Phase 0      |
| 3   | Confidence-Based Edges         | 2     | Small  | P0       | Phase 0      |

**Milestone**: Pipeline chạy đúng, edges có confidence, staleness warning hoạt động.

### Sprint 2 — Search & Analysis (Tuần 3–4)

| #   | Task                                  | Phase | Effort | Priority | Dependencies |
| --- | ------------------------------------- | ----- | ------ | -------- | ------------ |
| 4   | Import Resolution Enhancement         | 3     | Medium | P1       | Phase 0      |
| 5   | Heritage Detection                    | 4     | Medium | P1       | Phase 3      |
| 6   | Hybrid Search (BM25 + Semantic + RRF) | 5     | Medium | P1       | —            |
| 7   | `detect_changes` Tool                 | 8     | Medium | P1       | Phase 1      |

**Milestone**: Hybrid search live, heritage edges, detect_changes tool available.

### Sprint 3 — Intelligence (Tuần 5–6)

| #   | Task                         | Phase | Effort | Priority | Dependencies |
| --- | ---------------------------- | ----- | ------ | -------- | ------------ |
| 8   | Community Detection (Leiden) | 6     | Medium | P1       | Phase 0      |
| 9   | Process Tracing              | 7     | Medium | P2       | Phase 0      |
| 10  | MCP Resources                | 10    | Medium | P2       | Phase 6, 7   |

**Milestone**: Automated community detection, execution flow tracing.

### Sprint 4 — Experience & Polish (Tuần 7–8)

| #   | Task                         | Phase | Effort | Priority | Dependencies |
| --- | ---------------------------- | ----- | ------ | -------- | ------------ |
| 11  | Type Resolution (Simplified) | 9     | Large  | P2       | Phase 3      |
| 12  | Task-Oriented Skills         | 11    | Small  | P2       | —            |
| 13  | Extended Language Support    | 12    | Medium | P3       | Phase 0      |

**Milestone**: Type-aware CALLS, agent skills, JS/Java language support.

---

## Graph Schema — Full Target State

### Node Types

```
EXISTING:           NEW:
Service             Community
File                Process
Function            Interface
Class               Route
DAG
Task
KafkaTopic
Database
HTTPEndpoint
```

### Edge Types

```
EXISTING:              NEW:
CONTAINS               EXTENDS
BELONGS_TO             IMPLEMENTS
DEFINED_IN             MEMBER_OF
CALLS                  STEP_IN_PROCESS
IMPORTS                ENTRY_POINT_OF
DEPENDS_ON             HAS_METHOD (replace METHOD_OF)
INHERITS (→ EXTENDS)   HAS_PROPERTY
INVOKES                METHOD_OVERRIDES
METHOD_OF              FETCHES
PRODUCES_TO
CONSUMES_FROM
CONNECTS_TO
HTTP_CALL

MODIFIED (new properties):
CALLS      + confidence, reason
IMPORTS    + confidence, importedNames
```

### Edge Properties (universal)

```
ALL edges:
  + updatedAt: timestamp
  + confidence: DOUBLE (0.0–1.0) — NEW for existing edges
  + reason: STRING — NEW

CALLS:
  + line: INT
  + confidence: DOUBLE
  + reason: STRING ("direct", "type_annotation", "constructor_inference", "name_match")

STEP_IN_PROCESS:
  + step: INT (execution order)
```

---

## Risk Assessment

| Phase                 | Risk                   | Mitigation                                      |
| --------------------- | ---------------------- | ----------------------------------------------- |
| 0 — Pipeline Refactor | Medium — refactor core | Comprehensive integration test; old API wrapper |
| 1 — Staleness         | Low                    | Git command fallback nếu không có git           |
| 2 — Confidence        | Low                    | Default confidence = 1.0 cho existing edges     |
| 3 — Import Resolution | Medium                 | Per-language; start with TS/Python              |
| 4 — Heritage          | Low                    | Parser đã extract ClassInfo.bases               |
| 5 — Hybrid Search     | Medium                 | Fallback to semantic-only nếu text index fails  |
| 6 — Community         | Medium                 | External dep; vendor nếu cần                    |
| 7 — Process Tracing   | Medium                 | BFS limits (depth 10, branch 4)                 |
| 8 — detect_changes    | Low                    | Read-only tool                                  |
| 9 — Type Resolution   | High                   | Complex cross-file analysis; simplified 3-tier  |
| 10 — MCP Resources    | Low                    | Read-only                                       |
| 11 — Skills           | None                   | Markdown only                                   |
| 12 — Languages        | Low                    | Modular extractors                              |

---

## Success Metrics

| Metric                 | Current        | Target (v1.0)                 |
| ---------------------- | -------------- | ----------------------------- |
| Languages supported    | 5              | 8+                            |
| MCP Tools              | 5              | 8                             |
| MCP Resources          | 0              | 4                             |
| Pipeline phases        | 1 (monolithic) | 9                             |
| Edge confidence        | No             | Yes (0.0–1.0)                 |
| Staleness detection    | No             | Yes                           |
| Community detection    | No             | Yes                           |
| Execution flow tracing | No             | Yes                           |
| Search modes           | 1 (semantic)   | 3 (hybrid, semantic, keyword) |
| Agent skills           | 2 (rules)      | 6 (task-oriented)             |
| Graph node types       | 7              | 10                            |
| Graph edge types       | 11             | 19                            |

---

## Notes

- **Phase 0 là critical path** — mọi phase sau đều depend vào pipeline architecture
- **Phase 5 (Hybrid Search) có thể làm parallel** với Phase 0 vì nó chỉ affect MCP server, không touch common-tools pipeline
- **Phase 8 (detect_changes) cũng parallel-friendly** — standalone tool
- **Phase 11 (Skills) có thể làm bất kỳ lúc nào** — chỉ viết markdown
- **Evaluation Framework** (GitNexus idea #10) — defer to v1.1, cần stable base trước
- **Wiki Generation** — defer to v1.1+, nice-to-have
