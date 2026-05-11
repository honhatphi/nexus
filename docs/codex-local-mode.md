# Nexus MCP — Codex Local Mode

## Overview

Nexus runs as a local MCP server that Codex CLI connects to instead of fetching context from a remote API. This gives you:

- Semantic code search via ChromaDB (vector embeddings)
- Cross-service dependency graphs via Memgraph (Cypher)
- Task ledger to track decisions and touched files
- Artifact store to offload large outputs out of the prompt
- Budget-trimmed context packs (default 12k tokens)
- **Zero-config workspace resolution** — tools auto-detect your workspace from `.nexus/workspace.yaml`

---

## Prerequisites

- Docker Desktop running
- Node.js 20+
- Codex CLI (`npm install -g @openai/codex`) or GitHub Copilot with MCP support

---

## Quick-start

```bash
# 1. Start infrastructure (Memgraph + ChromaDB)
docker compose up memgraph chromadb -d

# 2. Build and start MCP server
cd mcp-server && npm run build && node dist/index.js
# Server starts on http://localhost:13100

# 3. Verify everything is wired up
node scripts/smoke-local-first.mjs
```

Health check: `curl http://localhost:13100/health`

---

## Local-first workflow (zero workspace_id required)

The tools below work without passing an explicit `workspace_id`. They walk up from
`cwd` (or `NEXUS_WORKSPACE_ROOT`) to find `.nexus/workspace.yaml`.

### 1. Initialise the workspace (first time only)

```
nexus_resolve_workspace
  workspace_id: "my-project"   # omit on subsequent calls
  cwd: "/path/to/repo"         # optional — defaults to NEXUS_WORKSPACE_ROOT or process.cwd()
```

Creates `.nexus/workspace.yaml` in the repo root.

### 2. Sync the current repo into the Knowledge Base

```
nexus_sync_current_repo
  # no arguments needed — auto-detects Git repo from cwd
  auto_add_to_workspace: true   # default
```

### 3. Open a task

```
nexus_open_task
  objective: "Fix authentication bug in user login flow"
→ Returns: { taskId: "task_abc123" }
```

### 4. Build a context pack (zero-config)

```
nexus_build_context_pack
  task: "Fix authentication bug in user login flow"
  task_id: "task_abc123"   # optional but recommended
  # workspace_id is NOT required — resolved automatically
→ Returns: context pack with manifest, file snippets, repo capsule
```

### 5. Spawn a task workspace

```
nexus_spawn_task_workspace
  task_id: "task_abc123"
  task: "Fix authentication bug"
  context_pack_id: "ctxpack_xxxxxxxx"   # from step 4
→ Returns: { taskId, selectedFiles, hint }
```

### 6. Inspect the workspace

```
nexus_get_task_workspace
  task_id: "task_abc123"
→ Returns: { taskId, selectedFiles, createdAt, hint }
```

### 7. Apply changes as a patch

```
nexus_apply_task_patch
  task_id: "task_abc123"
  include_full_diff: false   # set true for the unified diff
→ Returns: { filesChanged, totalLinesAdded, totalLinesRemoved, files }
```

### 8. Update the ledger & close

```
nexus_update_ledger
  task_id: "task_abc123"
  current_state: "Fixed null check in login handler"
  add_touched_files: ["src/auth/login.ts"]

nexus_close_task
  task_id: "task_abc123"
```

---

## Smoke test script

Run the smoke script to check all local-first prerequisites:

```bash
node scripts/smoke-local-first.mjs
```

What it checks:

| Gate | What | Fix hint |
|------|------|----------|
| Build artefact | `mcp-server/dist/index.js` exists | `cd mcp-server && npm run build` |
| Environment | `NEXUS_WORKSPACE_ROOT` exists if set | Update the env var |
| Workspace manifest | `.nexus/workspace.yaml` reachable | Call `nexus_resolve_workspace` |
| Health endpoint | `GET /health → { status: "ok" }` | Start the MCP server |
| MCP protocol | `initialize` handshake succeeds | Rebuild + restart server |
| Tool registration | All 6 local-first tools registered | Check server logs |
| Smoke call | `nexus_resolve_workspace` returns `workspaceId` | Call with `workspace_id` to init |

The script exits 0 on full pass, 1 on any failure. Use `MCP_URL=http://localhost:PORT` to override the default port.

---

## Configure Codex CLI

Copy `.codex/config.example.toml` to `~/.codex/config.toml`:

```toml
[mcp]
server_url = "http://localhost:13100/mcp"
# workspace_id is optional — auto-resolved from .nexus/workspace.yaml
```

---

## Sync your codebase to the KB

```bash
# Via MCP tool (preferred — auto-detects Git repo)
nexus_sync_current_repo

# Or via the doctor script
node scripts/doctor-codex-mcp.mjs
```

---

## Environment variables (mcp-server)

| Variable                  | Default                      | Description                                        |
| ------------------------- | ---------------------------- | -------------------------------------------------- |
| `MCP_SERVER_PORT`         | `13100`                      | HTTP port                                          |
| `MEMGRAPH_URI`            | `bolt://localhost:17687`     | Memgraph Bolt URI                                  |
| `CHROMADB_URL`            | `http://localhost:18000`     | ChromaDB HTTP URL                                  |
| `NEXUS_WORKSPACE_ID`      | `default`                    | Default workspace ID for ledger/artifact storage   |
| `NEXUS_WORKSPACE_ROOT`    | _(process.cwd())_            | Directory used as fallback for workspace detection |
| `NEXUS_DATA_DIR`          | `~/.nexus`                   | Root for all Nexus local data                      |
| `NEXUS_ENABLE_LEGACY_TOOLS` | `0`                        | Set to `1` to register low-level KB tools          |

---

## Troubleshooting

```bash
# Run smoke test
node scripts/smoke-local-first.mjs

# Run doctor script
node scripts/doctor-codex-mcp.mjs

# Check Docker infra
docker compose ps
docker compose logs memgraph
docker compose logs chromadb

# Rebuild MCP server
cd mcp-server && npm run build

# Reset KB data (DESTRUCTIVE)
docker compose down -v && docker compose up memgraph chromadb -d
```

