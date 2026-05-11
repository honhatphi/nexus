# Nexus — Local-first Context Gateway

> **Snapshot date**: 2026-05-11  
> **Status**: Current — reflects implementation after PRs 1–12 on `feature/context-gateway`

---

## 1. What Nexus is now

Nexus is a **local-first MCP Context Gateway**. It runs on the developer's machine as a
stateless HTTP server and exposes structured tools to any MCP-compatible agent (GitHub
Copilot, Codex CLI, custom clients). No cloud service is required.

```
Agent / Codex CLI
  │
  │  POST /mcp  (StreamableHTTP — JSON-RPC 2.0)
  ▼
MCP HTTP Server  (mcp-server/src/index.ts, port 13100)
  │
  ├─ High-level tools (always registered)
  │    context-pack · workspace · ledger · artifact · code-snippet · task-workspace
  │
  ├─ Legacy KB tools (opt-in — NEXUS_ENABLE_LEGACY_TOOLS=1)
  │    sync_service · query_graph · search_knowledge_base · detect_changes · …
  │
  └─ Nexus Core façade  (@nexus-hub/core)
       ├─ WorkspaceResolver / RepoDetector
       ├─ ContextPackBuilder
       ├─ LedgerService / FileLedgerStore
       ├─ ArtifactService / FileArtifactStore
       ├─ TaskWorkspaceManager / PatchGenerator
       └─ BudgetEngine / TokenEstimator
            │
            ├─ Memgraph (graph — bolt://localhost:17687)
            └─ ChromaDB (vectors — http://localhost:18000)
```

Each HTTP request to `/mcp` creates a **fresh** `McpServer` instance (stateless
per-request model). Long-lived state is persisted on disk under `~/.nexus/`.

---

## 2. Workspace model

### `.nexus/workspace.yaml` (in-repo manifest)

```yaml
version: 1
workspaceId: commerce-platform

repos:
  - repoId: pricing-service
    relativePath: pricing-service
  - repoId: warehouse-2.0
    relativePath: warehouse-2.0

indexing:
  exclude:
    - node_modules
    - dist

context:
  defaultBudgetTokens: 12000
  maxBudgetTokens: 24000
```

The manifest lives at the **root of the monorepo** (or the workspace parent directory),
one level above individual service repositories. `WorkspaceResolver` walks upward from
`cwd` until it finds this file.

### `NEXUS_WORKSPACE_ROOT` (env override)

If set, all workspace tools use this directory as the starting point instead of
`process.cwd()`. Useful when running the MCP server from a different directory.

### `~/.nexus/workspaces/<workspaceId>/` (local state)

```
~/.nexus/workspaces/commerce-platform/
├── ledger/          # Task ledger entries (JSON, one per taskId)
├── artifacts/       # Stored large outputs (one dir per artifactId)
│   └── artifact_diff_a1b2c3d4/
│       ├── content.txt
│       └── meta.json
├── context-packs/   # Persisted context packs (one JSON per packId)
└── task-workspaces/ # Isolated file copies for task editing
    └── task_abc123/
        ├── selected-files/
        ├── AGENTS.md
        └── context-pack.md
```

This directory is always local to the machine and is **never committed to git**.

---

## 3. Tool groups

### 3a. Workspace tools (PR 3)

| Tool                      | Description                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `nexus_resolve_workspace` | Initialise or locate `.nexus/workspace.yaml`; registers current repo if `auto_add_to_workspace=true` |
| `nexus_workspace_status`  | Read-only view of the manifest: registered repos, stale flags                                        |
| `nexus_sync_current_repo` | Detect git root, add to manifest if missing, index into KB                                           |

All three accept an optional `cwd` parameter and fall back to
`NEXUS_WORKSPACE_ROOT → process.cwd()`. No `workspace_id` is required — it is
resolved from the manifest.

### 3b. Ledger tools (PR 4)

| Tool                   | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `nexus_open_task`      | Create a task ledger entry; returns `taskId`                     |
| `nexus_get_task_state` | Retrieve compact state (objective, current state, touched files) |
| `nexus_update_ledger`  | Append a state change, touched files, or open questions          |
| `nexus_close_task`     | Mark the task done; persists final state                         |

Ledger entries are stored as JSON files under
`~/.nexus/workspaces/<workspaceId>/ledger/`.

### 3c. Artifact tools (PR 5)

| Tool                         | Description                                                  |
| ---------------------------- | ------------------------------------------------------------ |
| `nexus_store_artifact`       | Persist large output (logs, diffs, query results) off-prompt |
| `nexus_get_artifact_summary` | Get size, kind, and summary line                             |
| `nexus_get_artifact_excerpt` | Read a line-range slice with optional token cap              |

Artifact kinds: `test_log`, `diff`, `query_result`, `terminal_output`, `raw_context`.

### 3d. Context pack tools (PRs 6–7)

| Tool                       | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| `nexus_build_context_pack` | Hybrid KB search → score → budget-trim → structured pack |
| `nexus_get_code_snippet`   | Return a line-range excerpt from a file in the manifest  |

`nexus_build_context_pack` inputs:

| Parameter      | Required?    | Notes                                                 |
| -------------- | ------------ | ----------------------------------------------------- |
| `task`         | Yes          | Natural language task description                     |
| `workspace_id` | **Optional** | Auto-resolved from `.nexus/workspace.yaml` if omitted |
| `task_id`      | Optional     | Attaches active ledger to the pack                    |
| `cwd`          | Optional     | Override directory for workspace resolution           |
| `max_files`    | Optional     | Default 8                                             |

Default token budget: 12 000 input tokens, 3 000 reserved for output.

### 3e. Task workspace tools (PR 12)

| Tool                         | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `nexus_spawn_task_workspace` | Copy selected files into an isolated directory; write `AGENTS.md` |
| `nexus_get_task_workspace`   | Return file list, timestamps, and usage hint                      |
| `nexus_apply_task_patch`     | Compute a diff between workspace and repo; apply or report        |

The workspace directory is under
`~/.nexus/workspaces/<workspaceId>/task-workspaces/<taskId>/`.

### 3f. Legacy KB tools (opt-in)

Registered only when `NEXUS_ENABLE_LEGACY_TOOLS=1`:

| Tool                     | File                             |
| ------------------------ | -------------------------------- |
| `sync_service_knowledge` | `tools/legacy/sync-service.ts`   |
| `parse_code`             | `tools/legacy/parse-code.ts`     |
| `query_graph`            | `tools/legacy/index.ts`          |
| `search_knowledge_base`  | `tools/legacy/index.ts`          |
| `get_impact_analysis`    | `tools/legacy/index.ts`          |
| `check_staleness`        | `tools/legacy/index.ts`          |
| `augment`                | `tools/legacy/augment.ts`        |
| `get_symbol_context`     | `tools/legacy/context.ts`        |
| `detect_changes`         | `tools/legacy/detect-changes.ts` |
| `get_process_flows`      | `tools/legacy/resources.ts`      |
| `scan_risks`             | `tools/legacy/scan-risks.ts`     |

These require Memgraph + ChromaDB to be running and populated.

---

## 4. Security / privacy rule — no absolute paths by default

All tools that return filesystem locations go through view functions in
`mcp-server/src/utils/safe-response.ts`.

**Default (`debug=false`)**: absolute paths are stripped from responses. Only relative
paths, task IDs, and usage hints are returned to the agent.

**Opt-in (`debug=true`)**: absolute paths (`localWorkspaceDir`, `repoRoot`,
`manifestPath`, etc.) are included. Intended for developer debugging only.

This prevents local filesystem topology from leaking into cloud-synced chat histories
or shared prompt logs.

---

## 5. Local-first Codex workflow (end-to-end)

```
1.  nexus_resolve_workspace          # init or locate .nexus/workspace.yaml
                                     # workspace_id auto-resolved from manifest
2.  nexus_sync_current_repo          # index current git repo → Memgraph + ChromaDB

3.  nexus_open_task                  # start ledger; receive taskId
    → { taskId: "task_abc123" }

4.  nexus_build_context_pack         # hybrid search; build budget-trimmed pack
    task:         "Fix auth bug"     # workspace_id is NOT required
    task_id:      "task_abc123"
    → { contextPackId, manifest, sections, instructions }

5.  nexus_get_code_snippet           # read file excerpt (manifest-guarded)
    context_pack_id: "ctxpack_xxx"
    source_id:       "src/auth/login.ts"

6.  [agent edits files]

7.  nexus_update_ledger              # record progress
    task_id:            "task_abc123"
    current_state:      "Fixed null check in login handler"
    add_touched_files:  ["src/auth/login.ts"]

8.  nexus_spawn_task_workspace       # optional: isolated copy for patch workflow
    task_id: "task_abc123"
    task:    "Fix auth bug"

9.  nexus_apply_task_patch           # diff workspace → repo; apply patch
    task_id: "task_abc123"

10. nexus_close_task                 # finalize ledger entry
    task_id: "task_abc123"
```

Steps 1–2 are one-time setup per repo. Steps 3–10 repeat per coding session.
Steps 8–9 (task workspace) are optional — skip for simple in-place edits.

---

## 6. Environment variables

| Variable                         | Default                  | Description                          |
| -------------------------------- | ------------------------ | ------------------------------------ |
| `MCP_SERVER_PORT`                | `13100`                  | HTTP server port                     |
| `MEMGRAPH_URI`                   | `bolt://localhost:17687` | Memgraph Bolt URI                    |
| `MEMGRAPH_USER`                  | _(empty)_                | Memgraph username                    |
| `MEMGRAPH_PASSWORD`              | _(empty)_                | Memgraph password                    |
| `CHROMADB_URL`                   | `http://localhost:18000` | ChromaDB HTTP URL                    |
| `CHROMADB_TOKEN`                 | _(empty)_                | ChromaDB auth token                  |
| `CHROMADB_COLLECTION`            | `nexus_codebase`         | ChromaDB collection name             |
| `NEXUS_WORKSPACE_ID`             | `default`                | Default workspace ID (fallback only) |
| `NEXUS_WORKSPACE_ROOT`           | _(process.cwd())_        | Directory for workspace resolution   |
| `NEXUS_DATA_DIR`                 | `~/.nexus`               | Root for all local state             |
| `NEXUS_DEFAULT_MAX_INPUT_TOKENS` | `12000`                  | Context pack input budget            |
| `NEXUS_DEFAULT_RESERVED_TOKENS`  | `3000`                   | Reserved output tokens               |
| `NEXUS_TASK_MAX_INPUT_TOKENS`    | `16000`                  | Budget when spawning task workspace  |
| `NEXUS_ENABLE_LEGACY_TOOLS`      | `0`                      | Set `1` to register legacy KB tools  |

---

## 7. Smoke test

```bash
# Prerequisites:
#   docker compose up memgraph chromadb -d
#   cd mcp-server && npm run build && node dist/index.js &

node scripts/smoke-local-first.mjs
```

The script checks 7 gates in order:

| #   | Gate                                            | Failure fix                       |
| --- | ----------------------------------------------- | --------------------------------- |
| 1   | `mcp-server/dist/index.js` exists               | `cd mcp-server && npm run build`  |
| 2   | `NEXUS_WORKSPACE_ROOT` path is valid (if set)   | Correct the env var               |
| 3   | `.nexus/workspace.yaml` reachable from cwd      | Call `nexus_resolve_workspace`    |
| 4   | `GET /health → { status: "ok" }`                | Start MCP server                  |
| 5   | `initialize` MCP handshake succeeds             | Rebuild + restart                 |
| 6   | All 6 local-first tools registered              | Check server logs                 |
| 7   | `nexus_resolve_workspace` returns `workspaceId` | Call with explicit `workspace_id` |

Exit code 0 = all pass. Set `MCP_URL=http://localhost:<port>` to override the default.

---

## 8. Source layout reference

```
Nexus/
├── mcp-server/src/
│   ├── index.ts                    ← HTTP server + tool wiring
│   ├── config.ts                   ← loadConfig() + env defaults
│   ├── clients/
│   │   ├── memgraph.ts             ← Bolt driver wrapper
│   │   ├── chromadb.ts             ← ChromaDB HTTP client
│   │   └── search.ts               ← Hybrid RRF search
│   ├── tools/
│   │   ├── workspace.ts            ← nexus_workspace_* tools
│   │   ├── ledger.ts               ← nexus_*_task / nexus_update_ledger
│   │   ├── artifacts.ts            ← nexus_store_artifact / nexus_get_artifact_*
│   │   ├── context-pack.ts         ← nexus_build_context_pack
│   │   ├── code-snippet.ts         ← nexus_get_code_snippet
│   │   ├── task-workspace.ts       ← nexus_spawn/get/apply_task_*
│   │   └── legacy/                 ← opt-in legacy KB tools
│   └── utils/
│       ├── mcp-response.ts         ← mcpJson / mcpError / mcpText builders
│       ├── safe-response.ts        ← path-sanitising view functions
│       └── workspace-context.ts   ← resolveStartDir / resolveWorkspaceFromInput
│
└── nexus-hub/core/src/
    ├── workspace/
    │   ├── workspace-resolver.ts   ← walk-up manifest finder + writer
    │   ├── repo-detector.ts        ← git root + repoId detection
    │   └── workspace-manifest.ts   ← manifest types + YAML read/write
    ├── budget/
    │   ├── token-estimator.ts      ← CHARS_PER_TOKEN, estimateTokens (single source)
    │   └── budget-engine.ts        ← BudgetPolicy, OutputLimiter
    ├── context/
    │   ├── context-pack-builder.ts ← orchestrates phases 1–3
    │   ├── context-pack-store.ts   ← persist to ~/.nexus/…/context-packs/
    │   ├── context-section-renderer.ts ← file snippet sections
    │   └── source-resolver.ts      ← path candidate resolution
    ├── artifacts/
    │   ├── artifact-service.ts     ← store/retrieve orchestration
    │   └── file-artifact-store.ts  ← disk persistence
    ├── memory/
    │   ├── ledger-service.ts
    │   └── file-ledger-store.ts
    └── task-workspace/
        ├── task-workspace-manager.ts
        └── patch-generator.ts
```
