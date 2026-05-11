# 01 — Target Architecture: Nexus Local Context Gateway

> **Version**: 1.0  
> **Date**: 2026-05-11  
> **Status**: Target — chưa implement

---

## Tổng quan

Nexus tiến hóa từ **Knowledge Engine prototype** thành **Local Context Gateway** cho coding agents.

```
Codex CLI / Agent (cloud model)
      |
      | MCP local: http://localhost:13100/mcp
      v
┌──────────────────────────────────────────────┐
│ Nexus MCP Adapter                            │
│ - 9 high-level tools (default)               │
│ - legacy tools sau NEXUS_ENABLE_LEGACY_TOOLS │
└───────────────────┬──────────────────────────┘
                    v
┌──────────────────────────────────────────────┐
│ Nexus Core                                   │
│                                              │
│ Context Router                               │
│ - classify task type                         │
│ - choose retrieval strategy                  │
│ - build context manifest                     │
│                                              │
│ Context Pack Builder                         │
│ - repo/module/file/symbol capsules           │
│ - budget-aware packing                       │
│ - deterministic (no LLM in v1)               │
│                                              │
│ Memory Engine                                │
│ - task ledger (structured state)             │
│ - decisions log                              │
│ - touched files                              │
│ - next actions                               │
│                                              │
│ Artifact Store                               │
│ - full logs                                  │
│ - full diffs                                 │
│ - raw query results                          │
│ - large test outputs                         │
│                                              │
│ Budget Engine                                │
│ - token estimate                             │
│ - hard/soft budget                           │
│ - tool output cap                            │
└───────────────────┬──────────────────────────┘
                    v
┌──────────────────────────────────────────────┐
│ Knowledge Engine (giữ nguyên)                │
│ - Graph Store: Memgraph                      │
│ - Vector Store: ChromaDB                     │
│ - Hybrid Search (RRF)                        │
│ - Code Indexer (tree-sitter pipeline)        │
└──────────────────────────────────────────────┘
```

---

## Local-first định nghĩa

"Local-first" không có nghĩa model không bao giờ thấy code.

**Điều khác biệt là:**

- Nexus chạy **local**
- Index **local** (Memgraph + ChromaDB trên máy)
- Memory **local** (task ledger, artifact store tại `~/.nexus/`)
- Budget **local** (Nexus kiểm soát, không phụ thuộc provider)
- Model cloud chỉ nhận **context pack đã được Nexus chọn lọc** thay vì tự đọc lung tung toàn repo

---

## Default MCP Tool Surface (Codex thấy)

| Tool                         | Mô tả                                          |
| ---------------------------- | ---------------------------------------------- |
| `nexus_status`               | Trạng thái MCP server, workspace, KB           |
| `nexus_open_task`            | Mở task mới, trả taskId                        |
| `nexus_get_task_state`       | Lấy task ledger hiện tại                       |
| `nexus_update_ledger`        | Cập nhật task state, decisions, touched files  |
| `nexus_close_task`           | Đóng task, tổng kết                            |
| `nexus_build_context_pack`   | Build context pack đã chọn lọc và budget-aware |
| `nexus_get_code_snippet`     | Lấy code snippet theo manifest guard           |
| `nexus_store_artifact`       | Lưu large output (log, diff, query result)     |
| `nexus_get_artifact_summary` | Lấy summary của artifact                       |
| `nexus_get_artifact_excerpt` | Lấy excerpt từ artifact                        |

---

## Legacy MCP Tool Surface (flag)

Enabled khi `NEXUS_ENABLE_LEGACY_TOOLS=1`:

| Tool                     | Ghi chú                                           |
| ------------------------ | ------------------------------------------------- |
| `query_graph`            | Raw Cypher — không expose cho Codex mặc định      |
| `search_knowledge_base`  | Semantic/hybrid search — wrapped vào context pack |
| `get_impact_analysis`    | Dependency trace                                  |
| `check_staleness`        | Staleness check                                   |
| `parse_code`             | Direct parser                                     |
| `sync_service_knowledge` | Direct sync                                       |
| `augment`                | Symbol context                                    |
| `get_process_flows`      | Process flows                                     |

---

## `nexus_build_context_pack` — Core Contract

### Input

```json
{
  "workspaceId": "string",
  "taskId": "string (optional)",
  "task": "string — natural language task description",
  "mode": "ask | code | debug | review | migration",
  "budget": {
    "maxInputTokens": 12000,
    "reservedOutputTokens": 3000
  },
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
  "contextPackId": "string",
  "estimatedTokens": 7420,
  "status": "ready",
  "summary": "string",
  "manifest": [
    {
      "id": "file:mcp-server/src/index.ts",
      "type": "file_capsule | symbol_context | ...",
      "source": "string",
      "reason": "string",
      "estimatedTokens": 900,
      "freshness": "fresh | stale | unknown"
    }
  ],
  "sections": [{ "title": "string", "content": "string" }],
  "instructions": ["string"],
  "artifacts": []
}
```

### Retrieval strategy v1 (deterministic)

```
1. Hybrid search KB (semantic + keyword RRF)
2. Query symbol/file context từ graph
3. Pull task ledger (nếu có taskId)
4. Pull staleness status
5. Select top candidates theo score
6. Estimate tokens
7. Trim theo budget
8. Store context pack → ~/.nexus/workspaces/<id>/context-packs/
```

---

## Local State Layout

```
~/.nexus/
  config.json
  workspaces/
    <workspace_id>/
      workspace.json          ← workspace metadata
      ledgers/
        task_01.json
        task_02.json
      context-packs/
        ctxpack_01.json
      artifacts/
        artifact_testlog_01.txt
        artifact_testlog_01.meta.json
      snapshots/
      logs/
```

---

## Enforcement Modes

### Soft mode (Phase đầu)

- Codex chạy trong repo bình thường
- Nexus hướng dẫn qua `AGENTS.md`
- Budget/tooling khuyến khích dùng context pack
- Agent có thể đọc file local nhưng không được khuyến khích

### Hard mode (Phase sau — PR 12)

- Nexus tạo task workspace riêng
- Codex chạy trong `~/.nexus/tasks/<task_id>/workspace/`
- Chỉ thấy selected files từ context pack
- Nexus tạo patch, validate, rồi apply về repo thật

---

## Codex Workflow

```
User: Fix bug X, use Nexus context first.

Codex:
  1. nexus_status
  2. nexus_open_task → taskId
  3. nexus_build_context_pack { task, budget }
  4. nexus_get_code_snippet for manifest items
  5. edit code
  6. run tests
  7. nexus_store_artifact for long logs
  8. nexus_update_ledger { touchedFiles, decisions }
  9. nexus_detect_changes
  10. final answer
```
