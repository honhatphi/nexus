# Nexus Context Gateway — Migration Plan

> **Ngày tạo**: 2026-05-11  
> **Chiến lược**: Strangler architecture — không rewrite, thêm Core mới phía sau MCP hiện tại  
> **Mục tiêu**: Nexus trở thành Local Context Gateway, provider-agnostic, agent nào cũng dùng được qua MCP

---

## Tóm lược kiến trúc target

```
Codex CLI / Agent
      |
      | MCP local: http://localhost:13100/mcp
      v
┌──────────────────────────────────────────────┐
│ Nexus MCP Adapter                            │
│ - expose 6-10 high-level tools               │
│ - legacy tools sau flag NEXUS_ENABLE_LEGACY  │
└───────────────────┬──────────────────────────┘
                    v
┌──────────────────────────────────────────────┐
│ Nexus Core                                   │
│ - Context Router                             │
│ - Context Pack Builder                       │
│ - Memory Engine (Task Ledger)                │
│ - Artifact Store                             │
│ - Budget Engine                              │
└───────────────────┬──────────────────────────┘
                    v
┌──────────────────────────────────────────────┐
│ Knowledge Engine                             │
│ - Memgraph (graph)                           │
│ - ChromaDB (vectors)                         │
│ - Hybrid Search (RRF)                        │
│ - Parser Pipeline (tree-sitter, 10 phases)   │
└──────────────────────────────────────────────┘
```

---

## Nguyên tắc migration

1. **Không rewrite** — Strangler architecture: thêm Core sau MCP hiện tại, dần thay thế
2. **Không phá tool cũ** — Zero Regression: tool cũ vẫn hoạt động sau mỗi PR
3. **Không move file trong PR có logic mới** — tránh khó review
4. **Snapshot test mỗi PR** — so sánh được behavior trước/sau
5. **Deterministic trước** — Context Pack v1 không dùng LLM summary, chỉ score-based
6. **Soft enforcement trước, hard workspace sau** — Phase đầu dùng AGENTS.md guide

---

## Milestones

| Milestone | Mô tả                                  | PRs           |
| --------- | -------------------------------------- | ------------- |
| **A**     | Nexus vẫn chạy như cũ + có Core façade | PR 0, 1, 2    |
| **B**     | Context Pack usable với Codex          | PR 3, 4, 6, 7 |
| **C**     | Memory + Artifact usable               | PR 4, 5       |
| **D**     | Budget enforced                        | PR 8          |
| **E**     | Codex local workflow đầy đủ            | PR 10, 11     |
| **F**     | Hard task workspace                    | PR 12         |

---

## Backlog P0 — Tối thiểu local-first

| PR    | Tên                                               | Milestone |
| ----- | ------------------------------------------------- | --------- |
| PR 0  | Baseline architecture docs + snapshot             | A         |
| PR 1  | NexusCore façade                                  | A         |
| PR 2  | Data contracts                                    | A         |
| PR 3  | Workspace Manifest Auto-Discovery + Auto-Register | B         |
| PR 4  | Task Ledger (Memory Engine v1)                    | B, C      |
| PR 5  | Artifact Store v1                                 | C         |
| PR 6  | Context Pack Builder v1                           | B         |
| PR 7  | `nexus_get_code_snippet` với manifest guard       | B         |
| PR 8  | Budget Engine + tool output cap                   | D         |
| PR 9  | Persistent incremental index                      | -         |
| PR 10 | Codex local integration                           | E         |
| PR 11 | Legacy tool compatibility layer                   | E         |
| PR 12 | Hard task workspace                               | F         |

**Thứ tự thực thi khuyến nghị**: PR 0 → 1 → 2 → 4 → 5 → 6 → 10 → 8 → 9 → 12

---

## PR 0 — Baseline architecture docs + snapshot

**Mục tiêu**: chưa đổi runtime, chỉ tạo baseline để sau này so sánh.

### Files tạo mới

```
docs/architecture/00-current-nexus.md
docs/architecture/01-target-local-context-gateway.md
docs/architecture/02-delta-map.md
docs/architecture/03-migration-status.md
docs/architecture/snapshots/baseline.json
docs/adr/0001-local-first-agent-agnostic.md
scripts/arch-snapshot.mjs
scripts/arch-diff.mjs
```

### Acceptance criteria

```bash
npm run build                      # không lỗi
npm test                           # không lỗi
node scripts/arch-snapshot.mjs > docs/architecture/snapshots/baseline.json
git diff --stat                    # chỉ docs + scripts, không đổi src
```

---

## PR 1 — NexusCore façade

**Mục tiêu**: thêm lớp Core đứng sau MCP server, tool output cũ vẫn giữ nguyên.

### Files tạo mới

```
nexus-hub/core/
  package.json
  tsconfig.json
  src/
    index.ts
    nexus-core.ts
    ports/
      graph-store.ts
      vector-store.ts
      code-indexer.ts
      retriever.ts
      memory-store.ts
      artifact-store.ts
      budget-estimator.ts
    adapters/
      memgraph-graph-store.ts
      chromadb-vector-store.ts
      existing-pipeline-indexer.ts
      existing-hybrid-retriever.ts
```

### Interface chính

```ts
export interface NexusCore {
  search(input: SearchInput): Promise<SearchResult>;
  getSymbolContext(input: SymbolContextInput): Promise<SymbolContext>;
  detectChanges(input: DetectChangesInput): Promise<ChangeAnalysis>;
  syncService(input: SyncServiceInput): Promise<SyncReport>;
}
```

### Files modify nhỏ

```
mcp-server/src/index.ts          ← khởi tạo NexusCore thay vì direct clients
mcp-server/src/tools/index.ts    ← pass core thay vì pass clients
mcp-server/src/tools/context.ts  ← delegate sang core.getSymbolContext
mcp-server/src/tools/detect-changes.ts ← delegate sang core.detectChanges
```

Logic tool vẫn delegate vào implementation cũ thông qua NexusCore adapter.

### Acceptance criteria

```bash
npm run build
npm test
node scripts/arch-snapshot.mjs > docs/architecture/snapshots/pr1.json
node scripts/arch-diff.mjs \
  docs/architecture/snapshots/baseline.json \
  docs/architecture/snapshots/pr1.json
```

arch-diff phải show: `+ added NexusCore | = MCP tools unchanged | = output contract unchanged`

---

## PR 2 — Data contracts

**Mục tiêu**: định nghĩa data contract trước khi implement logic.

### Files tạo mới

```
nexus-hub/core/src/contracts/
  context-pack.ts
  context-manifest.ts
  task-ledger.ts
  artifact.ts
  token-budget.ts
  tool-output.ts
```

### Schemas chính

```ts
// ContextPack
export interface ContextPack {
  id: string;
  workspaceId: string;
  taskId: string;
  task: string;
  mode: "ask" | "code" | "debug" | "review" | "migration";
  budget: TokenBudget;
  estimatedTokens: number;
  manifest: ContextManifestItem[];
  sections: ContextSection[];
  artifacts: ArtifactRef[];
  createdAt: string;
}

// ContextManifestItem
export interface ContextManifestItem {
  id: string;
  type:
    | "repo_capsule"
    | "module_capsule"
    | "file_capsule"
    | "symbol_context"
    | "code_snippet"
    | "ledger"
    | "artifact_summary";
  source: string;
  reason: string;
  estimatedTokens: number;
  freshness: "fresh" | "stale" | "unknown";
  commit?: string;
}

// TaskLedger
export interface TaskLedger {
  taskId: string;
  objective: string;
  currentState: string;
  constraints: string[];
  decisions: Decision[];
  touchedFiles: string[];
  commandsRun: CommandSummary[];
  openQuestions: string[];
  nextActions: string[];
  updatedAt: string;
}

// ArtifactRef
export interface ArtifactRef {
  id: string;
  kind:
    | "test_log"
    | "diff"
    | "query_result"
    | "terminal_output"
    | "raw_context";
  summary: string;
  path: string;
  sizeBytes: number;
  estimatedTokens?: number;
}
```

### Acceptance criteria

```bash
npm run build
npm test
```

Không cần tool mới. Chỉ schema + unit tests.

---

## PR 3 — Workspace Manifest Auto-Discovery + Auto-Register

**Mục tiêu**: Nexus tự detect repo hiện tại, tự add vào workspace manifest — user không cần nhập path thủ công.

### Nguyên tắc thiết kế

```text
Workspace manifest = khai báo platform/multi-repo ở mức logic
CLI sync          = tự detect Git root, tính relativePath, add vào manifest
Local registry    = cache nội bộ (~/.nexus), agent/user không cần đụng vào
```

### Workspace manifest (`.nexus/workspace.yaml`)

File này nằm ở **folder cha** của tất cả repos, dùng `relativePath` — không có absolute path:

```yaml
version: 1
workspaceId: commerce-platform
displayName: Commerce Platform

repos:
  - repoId: magento-adapter
    relativePath: magento-adapter
    tags: [integration, ecommerce]

  - repoId: pricing-service
    relativePath: pricing-service
    tags: [pricing, api]

  - repoId: warehouse-2.0
    relativePath: warehouse-2.0
    tags: [etl, airflow, data-warehouse]

indexing:
  exclude:
    - node_modules/**
    - dist/**
    - build/**
    - .git/**
    - .venv/**
    - __pycache__/**

context:
  defaultBudgetTokens: 12000
  maxBudgetTokens: 24000
```

**Không lưu vào manifest**: absolute path, last synced commit, artifact path, local username, runtime logs.

### Local state layout

```
~/.nexus/workspaces/<workspaceId>/
  workspace-state.json    ← absolute paths, lastIndexedCommit (chỉ local)
  index-state/
    <repoId>.files.json
  ledgers/
  context-packs/
  artifacts/
  logs/
```

`workspace-state.json` ví dụ:

```json
{
  "workspaceId": "commerce-platform",
  "workspaceRoot": "/Users/phi/work/commerce-platform",
  "repos": {
    "pricing-service": {
      "absolutePath": "/Users/phi/work/commerce-platform/pricing-service",
      "relativePath": "pricing-service",
      "lastIndexedCommit": "abc123"
    }
  }
}
```

### Resolver algorithm (khi chạy `nexus sync`)

```text
1. currentDir = process.cwd()
2. repoRoot   = git rev-parse --show-toplevel
3. workspaceRoot = walk upward từ repoRoot, tìm .nexus/workspace.yaml
4. relativePath  = path.relative(workspaceRoot, repoRoot)
5. repoId = basename(repoRoot)  [fallback: git remote name, package.json name]
6. Nếu relativePath chưa trong repos[] → append + sort alphabetically
7. Sync/index repo
8. Update ~/.nexus/workspaces/<workspaceId>/ local state
```

### Policy: khi nào sửa workspace.yaml?

| Action                          | Sửa workspace.yaml?                      |
| ------------------------------- | ---------------------------------------- |
| `nexus workspace status`        | Không                                    |
| `nexus build-context-pack`      | Không (warning nếu repo chưa registered) |
| `nexus sync`                    | Có (nếu `autoAdd=true`, mặc định)        |
| `nexus workspace add .`         | Có                                       |
| `nexus sync --all`              | Không (chỉ sync repo đã khai báo)        |
| `nexus discover`                | Không (chỉ preview)                      |
| `nexus discover --write`        | Có                                       |
| `nexus_workspace_status` (MCP)  | Không                                    |
| `nexus_sync_current_repo` (MCP) | Có (nếu `autoAddToWorkspace=true`)       |

### Files tạo mới

```
nexus-hub/core/src/workspace/
  workspace-manifest.ts      ← đọc/ghi .nexus/workspace.yaml
  workspace-resolver.ts      ← walk upward tìm workspace root
  repo-detector.ts           ← git rev-parse, derive repoId
  manifest-writer.ts         ← ghi YAML deterministic (sorted, no timestamps)
  local-state.ts             ← đọc/ghi ~/.nexus/workspaces/<id>/

nexus-hub/cli/
  package.json
  src/
    index.ts
    commands/
      workspace-init.ts      ← nexus workspace init <workspaceId>
      workspace-status.ts    ← nexus workspace status
      workspace-add.ts       ← nexus workspace add .
      discover.ts            ← nexus discover [--write] [--sync]
      sync.ts                ← nexus sync [--all]
```

### MCP tools mới (3)

```
nexus_workspace_status
nexus_sync_current_repo
nexus_resolve_workspace
```

**`nexus_sync_current_repo` input/output:**

```json
// input
{ "autoAddToWorkspace": true, "forceUpdate": false }

// output
{
  "workspaceId": "commerce-platform",
  "repo": { "repoId": "pricing-service", "relativePath": "pricing-service", "addedToManifest": true },
  "sync": { "filesScanned": 320, "filesChanged": 12, "symbolsIndexed": 1840, "vectorsUpserted": 520 }
}
```

**`nexus_workspace_status` input/output:**

```json
// output
{
  "workspaceId": "commerce-platform",
  "currentRepo": {
    "repoId": "pricing-service",
    "relativePath": "pricing-service",
    "registered": true,
    "stale": false
  },
  "repos": [
    {
      "repoId": "warehouse-2.0",
      "relativePath": "warehouse-2.0",
      "exists": true,
      "stale": false
    },
    {
      "repoId": "promotion-service",
      "relativePath": "promotion-service",
      "exists": true,
      "indexed": false,
      "stale": true
    }
  ]
}
```

### CLI commands

```bash
# Một lần ở folder cha
cd ~/work/commerce-platform
nexus workspace init commerce-platform

# Mỗi khi thêm repo mới — tự add + sync
cd ~/work/commerce-platform/promotion-service
nexus sync

# Chỉ add, chưa sync
nexus workspace add .

# Sync toàn workspace
cd ~/work/commerce-platform
nexus sync --all

# Preview repos chưa được register
nexus discover
nexus discover --write          # update manifest
nexus discover --write --sync   # update + sync

# Kiểm tra trạng thái
nexus workspace status
```

### YAML diff khi add repo mới phải minimal

```diff
 repos:
   - repoId: magento-adapter
     relativePath: magento-adapter

+  - repoId: promotion-service
+    relativePath: promotion-service
+
   - repoId: warehouse-2.0
     relativePath: warehouse-2.0
```

### Acceptance criteria

```bash
# Setup
cd ~/work/commerce-platform
nexus workspace init commerce-platform
# → tạo .nexus/workspace.yaml với repos: []

# Add repo đầu tiên
cd pricing-service
nexus sync
# → pricing-service xuất hiện trong workspace.yaml với relativePath (không có absolute path)
# → local state được tạo tại ~/.nexus/workspaces/commerce-platform/

# Add repo thứ hai
cd ../warehouse-2.0
nexus sync
# → workspace.yaml có 2 repos, sorted alphabetically

# Sync toàn bộ
cd ~/work/commerce-platform
nexus sync --all
# → cả 2 repos được sync

# Discover
nexus discover
# → hiện repo nào có trong folder nhưng chưa trong manifest

# MCP status tool không sửa manifest
nexus_workspace_status → registered: true/false, stale: true/false
```

---

## PR 4 — Memory Engine v1: Task Ledger

**Mục tiêu**: thay chat-history replay bằng task state có cấu trúc.

### Files tạo mới

```
nexus-hub/core/src/memory/
  ledger-store.ts
  file-ledger-store.ts
  ledger-service.ts
```

### MCP tools mới (4)

```
nexus_open_task
nexus_get_task_state
nexus_update_ledger
nexus_close_task
```

### Ledger example

```json
{
  "taskId": "task_01",
  "objective": "Fix retry backoff bug",
  "currentState": "Context pack created; no files edited yet.",
  "constraints": ["Do not change public API", "Use existing tests first"],
  "decisions": [],
  "touchedFiles": [],
  "nextActions": ["Inspect RetryPolicy symbol context", "Run targeted test"]
}
```

### Acceptance criteria

```bash
npm run test -- ledger
nexus_open_task   → returns taskId
nexus_update_ledger → updates JSON file under ~/.nexus/...
nexus_get_task_state → returns compact state
```

### Review delta

```
+ New MCP tools: 4
+ New local state folder usage
= Existing tools unchanged
```

---

## PR 5 — Artifact Store v1

**Mục tiêu**: không đưa full logs/diffs/query results vào prompt.

### Files tạo mới

```
nexus-hub/core/src/artifacts/
  artifact-store.ts
  file-artifact-store.ts
  artifact-service.ts
  reducers/
    terminal-output-reducer.ts
    test-log-reducer.ts
    diff-reducer.ts
    graph-query-result-reducer.ts
```

### MCP tools mới (3)

```
nexus_store_artifact
nexus_get_artifact_summary
nexus_get_artifact_excerpt
```

### Output pattern — thay vì raw 20.000 tokens

```json
{
  "artifactId": "artifact_testlog_01",
  "kind": "test_log",
  "summary": {
    "exitCode": 1,
    "failures": [
      {
        "test": "RetryPolicy caps max delay",
        "file": "test/retry_backoff_spec.ts:42",
        "assertion": "expected 30000, got 60000"
      }
    ],
    "omittedLines": 1842
  }
}
```

### Acceptance criteria

```bash
npm run test -- artifacts
```

Golden tests:

```
tests/golden/artifacts/test-log-large.input.txt
tests/golden/artifacts/test-log-large.summary.json
```

---

## PR 6 — Context Pack Builder v1

**Mục tiêu**: tool quan trọng nhất — Codex hỏi task, Nexus trả context pack đã chọn lọc.

### Files tạo mới

```
nexus-hub/core/src/context/
  context-router.ts
  context-pack-builder.ts
  context-budgeter.ts
  context-manifest.ts
  context-section-renderer.ts
```

### MCP tool mới (1)

```
nexus_build_context_pack
```

### Input

```json
{
  "workspaceId": "honhatphi-nexus",
  "task": "Refactor MCP tools so Codex uses Nexus context pack first",
  "mode": "code",
  "budget": { "maxInputTokens": 12000, "reservedOutputTokens": 3000 },
  "preferences": {
    "includeRawCode": false,
    "preferCapsules": true,
    "maxFiles": 8
  }
}
```

### Output

```json
{
  "contextPackId": "ctxpack_01",
  "estimatedTokens": 7420,
  "summary": "Task touches MCP server, tool registration, and core adapter boundary.",
  "manifest": [
    {
      "id": "file:mcp-server/src/index.ts",
      "type": "file_capsule",
      "reason": "MCP entrypoint and tool registration",
      "estimatedTokens": 900,
      "freshness": "fresh"
    }
  ],
  "instructions": [
    "Use this context before reading additional files.",
    "Call nexus_get_code_snippet only for manifest items.",
    "Update ledger after each meaningful step."
  ]
}
```

### Retrieval strategy v1 — deterministic, không LLM summary

```
1. Hybrid search KB (semantic + keyword RRF)
2. Query symbol/file context từ graph
3. Pull ledger nếu taskId có
4. Pull staleness status
5. Select top candidates theo score
6. Estimate tokens
7. Trim theo budget
8. Store context pack local
```

### Acceptance criteria

```bash
npm run test -- context-pack
nexus_build_context_pack returns <= budget
context pack saved under ~/.nexus/workspaces/<id>/context-packs/
manifest explains every selected item
```

Golden test:

```
tests/golden/context-pack/mcp-refactor.input.json
tests/golden/context-pack/mcp-refactor.output.json
```

---

## PR 7 — `nexus_get_code_snippet` với budget và manifest guard

**Mục tiêu**: agent không tự đọc full file; request snippet theo manifest.

### MCP tool mới (1)

```
nexus_get_code_snippet
```

### Input

```json
{
  "contextPackId": "ctxpack_01",
  "sourceId": "file:mcp-server/src/index.ts",
  "range": { "startLine": 1, "endLine": 120 },
  "maxTokens": 1500
}
```

### Behavior

```
- sourceId không trong manifest → warning hoặc deny (tùy policy)
- range quá lớn → truncate + artifact ref
- file stale → warning
```

### Output

```json
{
  "sourceId": "file:mcp-server/src/index.ts",
  "path": "mcp-server/src/index.ts",
  "range": { "startLine": 1, "endLine": 120 },
  "estimatedTokens": 1360,
  "content": "...",
  "truncated": false
}
```

### Acceptance criteria

```bash
snippet trong manifest    → allowed
snippet không trong manifest → denied/warning theo policy
range quá lớn            → truncated + artifactId
```

---

## PR 8 — Budget Engine + tool output cap

**Mục tiêu**: mọi MCP tool trả output có giới hạn.

### Files tạo mới

```
nexus-hub/core/src/budget/
  token-estimator.ts
  budget-policy.ts
  budget-session.ts
  output-limiter.ts
```

### Default policy (`nexus-config.yaml` mở rộng)

```yaml
budget:
  default_context_pack_tokens: 12000
  max_context_pack_tokens: 24000
  default_tool_output_tokens: 1500
  max_tool_output_tokens: 4000
  store_raw_outputs_as_artifacts: true
```

### Tool output contract mới

```json
{
  "estimatedTokens": 1200,
  "truncated": false,
  "artifactId": null
}
```

Khi truncated:

```json
{
  "estimatedTokens": 1500,
  "truncated": true,
  "omittedItems": 42,
  "artifactId": "artifact_raw_query_01"
}
```

### Acceptance criteria

```bash
npm run test -- budget
tool output không vượt maxTokens trong golden tests
raw output được store artifact khi truncated
```

---

## PR 9 — Persistent incremental index

**Mục tiêu**: thay `hashCache` in-memory trong `phase-0-filesystem.ts` bằng persistent file index.

### Files tạo mới

```
nexus-hub/core/src/index-state/
  file-index-store.ts
  json-file-index-store.ts
  symbol-index-store.ts
```

### Interface

```ts
export interface FileHashStore {
  get(path: string): Promise<string | null>;
  set(path: string, hash: string): Promise<void>;
}
```

### State file

```json
{
  "files": {
    "mcp-server/src/index.ts": {
      "contentHash": "abc123",
      "lastIndexedCommit": "def456",
      "lastIndexedAt": "2026-05-11T..."
    }
  }
}
```

### File modify

```
nexus-hub/common-tools/src/pipeline/phase-0-filesystem.ts
```

Inject `FileHashStore` interface, giữ fallback in-memory.

### Acceptance criteria

```bash
sync once → files changed (tất cả)
restart MCP server
sync again → files skipped (tất cả)
modify one file
sync → chỉ 1 file changed
```

Integration test: `tests/integration/incremental-persistent.test.ts`

---

## PR 10 — Codex local integration

**Mục tiêu**: Codex dùng Nexus local MCP như executor context source.

### Files tạo mới

```
AGENTS.md
.codex/config.example.toml
scripts/install-codex-mcp.sh
scripts/doctor-codex-mcp.mjs
docs/codex-local-mode.md
```

### `.codex/config.example.toml`

```toml
[mcp_servers.nexus]
url = "http://localhost:13100/mcp"
```

### `AGENTS.md` — workflow instruction cho Codex

```md
# Nexus local-first workflow

For any coding/debugging/review task:

1. Call `nexus_status`
2. Call `nexus_open_task` (unless taskId exists)
3. Call `nexus_build_context_pack` with a token budget
4. Use the returned context pack first
5. Call `nexus_get_code_snippet` only for manifest items
6. Store long outputs with `nexus_store_artifact`
7. Update task state with `nexus_update_ledger` after meaningful changes
8. Call `nexus_detect_changes` before final response

Do not read the whole repository.
Do not paste full logs into the conversation.
```

### Acceptance criteria

```bash
nexus mcp start
codex mcp list         # thấy nexus
scripts/doctor-codex-mcp.mjs
```

---

## PR 11 — Legacy tool compatibility layer

**Mục tiêu**: giảm tool surface cho Codex, vẫn không phá flow cũ.

### Default tools (Codex thấy)

```
nexus_status
nexus_open_task
nexus_update_ledger
nexus_build_context_pack
nexus_get_code_snippet
nexus_get_symbol_context
nexus_detect_changes
nexus_store_artifact
nexus_get_artifact_excerpt
```

### Legacy tools (sau flag)

```bash
NEXUS_ENABLE_LEGACY_TOOLS=1
```

```
query_graph
search_knowledge_base
get_impact_analysis
check_staleness
parse_code
sync_service_knowledge
augment
get_process_flows
```

### Acceptance criteria

```bash
NEXUS_ENABLE_LEGACY_TOOLS=0 node scripts/arch-snapshot.mjs  # only new tools
NEXUS_ENABLE_LEGACY_TOOLS=1 node scripts/arch-snapshot.mjs  # old + new tools
```

---

## PR 12 — Hard task workspace

**Mục tiêu**: Codex chỉ thấy repo con, không thấy toàn bộ codebase.

### Files tạo mới

```
nexus-hub/core/src/task-workspace/
  task-workspace-manager.ts
  file-selector.ts
  patch-generator.ts
  patch-applier.ts
```

### Workflow

```bash
nexus task spawn --task "fix retry backoff bug" --budget 12000
# → tạo ~/.nexus/tasks/<task_id>/workspace/
# → copy/symlink selected files vào workspace
# → tạo AGENTS.md trong workspace

cd ~/.nexus/tasks/<task_id>/workspace
codex          # chạy trong task workspace, không thấy full repo

nexus task apply-patch <task_id>
# → tạo diff từ task workspace
# → validate
# → apply về repo thật
```

### Task workspace layout

```
~/.nexus/tasks/<task_id>/workspace/
  AGENTS.md
  context-pack.md
  selected-files/
    mcp-server/src/index.ts  ← copy/symlink
    ...
  artifacts/
```

### Acceptance criteria

```bash
nexus task spawn  → tạo workspace
codex trong workspace → chỉ thấy selected files
nexus task apply-patch → patch apply được về repo thật
```

---

## Tool surface mới vs cũ

| Category           | Tools                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New high-level** | `nexus_status`, `nexus_open_task`, `nexus_get_task_state`, `nexus_update_ledger`, `nexus_close_task`, `nexus_build_context_pack`, `nexus_get_code_snippet`, `nexus_store_artifact`, `nexus_get_artifact_summary`, `nexus_get_artifact_excerpt`, `nexus_estimate_cost` |
| **Legacy (flag)**  | `query_graph`, `search_knowledge_base`, `get_impact_analysis`, `check_staleness`, `parse_code`, `sync_service_knowledge`, `augment`, `get_process_flows`                                                                                                              |

---

## Test strategy

### Snapshot tests

```
tests/contract/mcp-tools.snapshot.test.ts
tests/contract/context-pack-schema.snapshot.test.ts
tests/contract/legacy-tools.snapshot.test.ts
```

Mỗi PR thay đổi MCP tools phải update snapshot rõ ràng.

### Golden tests

```
tests/golden/context-pack/
  mcp-refactor.input.json
  mcp-refactor.expected.json

tests/golden/artifacts/
  large-test-log.input.txt
  large-test-log.expected-summary.json

tests/golden/ledger/
  update-ledger.input.json
  update-ledger.expected.json
```

### Architecture diff (mỗi PR chạy)

```bash
node scripts/arch-snapshot.mjs > docs/architecture/snapshots/current.json
node scripts/arch-diff.mjs \
  docs/architecture/snapshots/baseline.json \
  docs/architecture/snapshots/current.json
```

### Regression tests

```bash
npm run test -- legacy-tools   # đảm bảo tool cũ không bị phá
```

---

## So sánh before/after

| Area              | Nexus hiện tại                       | Target                                    |
| ----------------- | ------------------------------------ | ----------------------------------------- |
| Agent dependency  | KB-first, chưa provider-agnostic rõ  | Codex/Copilot/Cline đều là client qua MCP |
| MCP server        | Register nhiều tool trực tiếp        | MCP adapter mỏng, gọi Nexus Core          |
| Search            | Hybrid search semantic + keyword RRF | Search là phần của Context Router         |
| Graph/vector      | Memgraph + ChromaDB clients riêng    | Store adapters sau interface              |
| Parser/indexer    | Tree-sitter + pipeline nhiều phase   | Giữ lại, thêm capsule/context output      |
| Incremental sync  | In-memory hash cache                 | Persistent file/symbol index              |
| Tool output       | JSON raw, có thể lớn                 | Summary + artifact + max token            |
| Session memory    | Chưa có task ledger                  | TaskLedger local                          |
| Context selection | Agent tự search/query nhiều lần      | `nexus_build_context_pack`                |
| Codex integration | Chưa có                              | `AGENTS.md` + MCP config + doctor script  |
| Enforcement       | Prompt/rule-level                    | Soft mode → hard task workspace           |

---

## Những việc KHÔNG làm ở giai đoạn đầu

```
- Không rewrite toàn bộ Nexus sang framework mới
- Không bỏ Memgraph/Chroma ngay
- Không đưa Copilot SDK làm dependency
- Không expose raw Cypher cho Codex mặc định
- Không build UI trước
- Không dùng LLM để summarize mọi thứ từ đầu
- Không move hàng loạt file trong cùng PR đổi logic
```

---

## Repo layout target (cuối migration)

```
nexus/
  AGENTS.md
  nexus-config.yaml

  apps/
    mcp-server/          ← từ mcp-server/ hiện tại
    cli/                 ← từ nexus-hub/cli/

  packages/
    core/                ← NexusCore + ports + adapters
    contracts/           ← data contracts
    memory/              ← task ledger
    artifacts/           ← artifact store + reducers
    budget/              ← token budget engine
    context/             ← context pack builder
    retrieval/           ← hybrid search
    index-state/         ← persistent hash store
    graph-store/         ← Memgraph adapter
    vector-store/        ← ChromaDB adapter

  nexus-hub/
    common-tools/        ← giữ nguyên parser/pipeline
    skills/
    knowledge-base/
    prompts/
    patterns/

  scripts/
    arch-snapshot.mjs
    arch-diff.mjs
    install-codex-mcp.sh
    doctor-codex-mcp.mjs
    install-global-hooks.sh

  docs/
    architecture/
    adr/
    codex-local-mode.md

  tests/
    golden/
    integration/
    contract/
```

> Thứ tự: giai đoạn đầu thêm mới, không move. Giai đoạn giữa git mv khi core ổn. Giai đoạn cuối cleanup layout.
