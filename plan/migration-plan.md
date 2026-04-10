# Nexus — Dependency Migration Plan

> Created: 2025-04-10  
> Status: Draft  
> Goal: Upgrade all dependencies to latest stable versions for best DX and performance

---

## Current State

| Package | Current | Latest | Location | Risk |
|---------|---------|--------|----------|------|
| `@types/node` | ^20.17.0 | 25.x | both | 🟢 None |
| `@modelcontextprotocol/sdk` | ^1.12.1 | 1.29.x | mcp-server | 🟢 Low |
| `neo4j-driver` | ^5.28.3 | 6.0.x | both | 🟡 Medium |
| `zod` | ^3.24.2 | 3.25.x → 4.x | mcp-server | 🟡 Medium |
| `typescript` | ^5.7.0 | 6.0.x | both | 🟡 Medium |
| `chromadb` | ^1.10.5 | 3.4.x | both | 🔴 High |
| `chromadb-default-embed` | ^2.14.0 | TBD | mcp-server | 🔴 High |
| `web-tree-sitter` | ^0.25.10 | 0.26.x | common-tools | 🔴 Blocked |
| `tree-sitter-wasms` | ^0.1.13 | 0.1.13 | common-tools | — Current |
| Docker ChromaDB | 1.0.0 | latest | docker-compose | 🔴 High |

---

## Phase 1 — Safe Upgrades (no code changes)

**Packages:**
- `@types/node` 20 → 25
- `@modelcontextprotocol/sdk` 1.12 → 1.29

**Why safe:**
- `@types/node`: Type definitions only. Aligns with our Node 24 runtime.
- MCP SDK: Still v1.x (minor bumps). Backward compatible. Adds sampling, elicitation, tasks capabilities.

**Steps:**
```bash
# common-tools
cd nexus-hub/common-tools
npm install @types/node@latest --save-dev

# mcp-server
cd ../../mcp-server
npm install @types/node@latest @modelcontextprotocol/sdk@latest --save-dev
npm install @modelcontextprotocol/sdk@latest
```

**Validation:**
```bash
cd nexus-hub/common-tools && npx tsc --noEmit
cd ../../mcp-server && npx tsc --noEmit
```

---

## Phase 2 — Neo4j Driver 5 → 6

**Breaking changes in v6:**
- Removed: `.readTransaction()`, `.writeTransaction()` → use `.executeRead()`, `.executeWrite()`
- Removed: `.lastBookmark()` → use `.lastBookmarks()`
- Removed: `.verifyConnectivity()` return value → now returns `void`
- `protocolVersion` type changed from `Number` to `ProtocolVersion`

**Impact on our code:**
- `mcp-server/src/clients/memgraph.ts` — uses `session.run()` directly ✅ (not affected)
- `nexus-hub/common-tools/src/sync-tool.ts` — uses `session.run()` directly ✅ (not affected)
- None of the removed APIs are used in our codebase.

**Risk: Memgraph Bolt compatibility**
- Neo4j driver 6 targets Bolt 5.x protocol
- Memgraph v2.14 supports Bolt v1-v4
- ⚠️ May cause protocol negotiation failure — must test

**Steps:**
```bash
cd nexus-hub/common-tools && npm install neo4j-driver@6
cd ../../mcp-server && npm install neo4j-driver@6
# Rebuild
cd nexus-hub/common-tools && npx tsc --noEmit
cd ../../mcp-server && npx tsc --noEmit
# Start MCP server and test sync pipeline
node dist/index.js
# Run test-sync.mjs to verify graph operations
```

**Rollback:** If Memgraph rejects Bolt 5, stay on `neo4j-driver@5` until Memgraph upgrades.

---

## Phase 3 — Zod 3.24 → 3.25

**Why 3.25 first (not 4.x):**
- MCP SDK 1.29 requires zod as peer dep and uses `zod/v4` internally
- zod 3.25+ provides `zod/v4` entrypoint for backward compat
- Full v4 migration has breaking import/API changes — defer until ecosystem stabilizes

**Steps:**
```bash
cd mcp-server && npm install zod@^3.25.0
npx tsc --noEmit
```

**Validation:** All tool schemas (`z.object`, `z.string`, etc.) remain identical in 3.25.

---

## Phase 4 — TypeScript 5 → 6

**Changes in v6:**
- License changed to Apache-2.0
- Stricter type checking in some edge cases
- New compiler features

**Steps:**
```bash
cd nexus-hub/common-tools && npm install typescript@6 --save-dev
cd ../../mcp-server && npm install typescript@6 --save-dev
# Test both builds
cd nexus-hub/common-tools && npx tsc --noEmit
cd ../../mcp-server && npx tsc --noEmit
```

**Rollback:** If new strict checks cause errors, stay on `typescript@^5.8`.

---

## Phase 5 — ChromaDB 1 → 3 (Major)

**This is the largest migration item.**

**Breaking changes:**
- `ChromaClient` constructor API changed
- `getOrCreateCollection` → verify new API shape
- `collection.query()` / `collection.upsert()` → parameter shapes may differ
- `chromadb-default-embed` may be bundled in v3 (chromadb package now includes all embedding deps)
- Docker ChromaDB server must also be upgraded

**Affected files:**
- `mcp-server/src/clients/chromadb.ts` — Full rewrite of client wrapper
- `nexus-hub/common-tools/src/sync-tool.ts` — ChromaDB init + upsert calls
- `docker-compose.yml` — Update image version
- `.env` / `.env.example` — Health check endpoint may change

**Steps:**
```bash
# 1. Update Docker image
# In docker-compose.yml: change chromadb/chroma:${CHROMADB_VERSION:-latest}
# In .env: set CHROMADB_VERSION=latest (or specific v3.x tag)
docker compose down chromadb
docker compose up chromadb -d

# 2. Install new client
cd mcp-server && npm install chromadb@3
# Check if chromadb-default-embed is still needed
npm ls chromadb-default-embed

# 3. Update client wrapper (chromadb.ts)
# - Adapt ChromaClient constructor
# - Adapt getOrCreateCollection
# - Adapt query/upsert calls
# - Update imports

# 4. Update sync-tool.ts similarly

# 5. Rebuild and test
npx tsc --noEmit
node dist/index.js
# Re-run sync pipeline
node test-sync.mjs
```

**Data:** Vector store will need to be rebuilt via `sync_service_knowledge`.

---

## Phase 6 — Web-Tree-Sitter (DEFERRED)

**Status: 🔴 BLOCKED**

**Problem:**
- `web-tree-sitter@0.26.x` has WASM ABI mismatch with `tree-sitter-wasms@0.1.13`
- `tree-sitter-wasms` is the latest version (0.1.13, last published 6 months ago)
- Upgrading causes runtime crash: "ABI version mismatch"

**Options (future):**

| Option | Effort | Risk |
|--------|--------|------|
| A) Stay on 0.25.10 | None | None — stable, working |
| B) Switch to individual packages (`tree-sitter-python`, `tree-sitter-go`, etc.) | Medium | Need to find/build WASM for each language |
| C) Fork `tree-sitter-wasms` and rebuild against 0.26 ABI | High | Maintenance burden |

**Recommendation:** Stay on `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`. Revisit when `tree-sitter-wasms` publishes a new version.

---

## Execution Order Summary

```
Phase 1  →  @types/node + MCP SDK           (safe, immediate)
Phase 2  →  neo4j-driver 6                   (test Memgraph compat)
Phase 3  →  zod 3.25                          (MCP SDK peer dep)
Phase 4  →  TypeScript 6                      (test builds)
Phase 5  →  chromadb 3 + Docker               (biggest change, do last)
Phase 6  →  web-tree-sitter                   (deferred / blocked)
```

---

## Post-Migration Checklist

- [ ] Both packages compile: `tsc --noEmit`
- [ ] MCP server starts on port 3100
- [ ] `sync_service_knowledge` runs against warehouse-2.0
- [ ] `query_graph` returns valid results
- [ ] `search_knowledge_base` returns relevant vectors
- [ ] `get_impact_analysis` traces dependencies
- [ ] Memgraph Lab shows graph data
- [ ] Git commit all changes
