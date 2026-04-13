# Maintain Hub — Agentic Workflow

Automated workflow triggered when changes are detected in `/services/*`, ensuring the **Nexus Hub stays in sync** with the latest knowledge from spoke services.

---

## Overview

```
Detect Change → Validate Service → sync_service_knowledge → Verify Graph → Notify
```

---

## Trigger — When does this workflow activate?

The agent **must automatically suggest** running this workflow when any of the following events are detected:

1. **New folder** added to `/services/` (new microservice).
2. **New source code file** created or significantly modified in an existing service.
3. **User explicitly requests** a manual knowledge sync.
4. **Before implementing a new feature** — if the last sync is stale (agent should ask).

### Detecting a new folder

When the agent observes a new directory in `/services/`:

```
# Example: user just created /services/inventory-service/
Agent MUST notify:
  "Detected new service: inventory-service.
   Would you like to run sync_service_knowledge to ingest
   all functions and relationships into the Knowledge Base?"
```

> **Do not auto-run sync** without user confirmation — this action affects the shared KB.

---

## Step 1 — Validate Service Directory

Before running sync, verify the service folder is valid:

- [ ] Folder exists and contains source code (`.go`, `.py`, `.php`, `.ts`, `.tsx`).
- [ ] Folder is not in the ignore list (`node_modules`, `.git`, `vendor`, `dist`, ...).
- [ ] Absolutely **never** sync `/src/legacy/` — only sync `/services/*`.

```
# ❌ FORBIDDEN
sync_service_knowledge({ service_path: "/src/legacy" })

# ✅ ALLOWED
sync_service_knowledge({ service_path: "./services/inventory-service" })
```

**Output:** Confirmation that the service is valid, or an error message.

---

## Step 2 — Run `sync_service_knowledge`

Call the tool with the service path:

```
sync_service_knowledge({
  service_path: "./services/inventory-service",
  force_update: false   // true to re-sync everything
})
```

The tool automatically:

1. Scans all source code files in the folder.
2. Parses with `CodeParser` (tree-sitter WASM) — extracts symbols, params, docstrings, calls.
3. Upserts to **Memgraph**:
   - Nodes: `Service`, `File`, `Function` (with `kind`, `signature`, `docstring`).
   - Edges: `Service → CONTAINS → File → CONTAINS → Function`, `Function → CALLS → Function`.
4. Upserts to **ChromaDB**: Embedding signature + docstring + metadata for each symbol.

**Output:** `SyncReport` — number of functions ingested, new relationships, success status.

---

## Step 3 — Verify Graph Integrity

After sync completes, the agent should run a quick validation:

```
# Check that the service node exists in the graph
query_graph({ query: "MATCH (s:Service {name: 'inventory-service'}) RETURN s" })

# Check the number of functions ingested
query_graph({
  query: "MATCH (s:Service {name: $name})-[:CONTAINS]->(:File)-[:CONTAINS]->(f:Function) RETURN count(f) AS total",
  params: { name: "inventory-service" }
})
```

If results are abnormal (0 functions, missing edges), warn the user and suggest re-running with `force_update: true`.

**Output:** Confirmation report that the graph has been updated correctly.

---

## Bước 4 — Cập nhật `nexus-config.yaml`

Nếu service mới chưa được khai báo trong `/nexus-config.yaml`, Agent phải gợi ý thêm:

```yaml
services:
  # ... existing services ...
  inventory-service:
    path: ./services/inventory-service
    language: go # or python, php, typescript
    port: 8084
    description: "Inventory management — stock tracking, warehouse ops"
```

> **Không tự động sửa** `nexus-config.yaml` mà không hỏi người dùng trước.

---

## Bước 5 — Thông báo kết quả

Agent trả về tóm tắt cuối cùng cho người dùng:

```
✅ Sync hoàn tất cho service: inventory-service
   • 42 hàm đã nạp vào Memgraph
   • 18 quan hệ CALLS mới
   • 42 vectors đã lưu vào ChromaDB
   • Ngôn ngữ: go
   • Lỗi parse: 0

   Service đã được đăng ký trong Knowledge Base.
   Bạn có muốn cập nhật nexus-config.yaml không?
```

---

## Quy tắc quan trọng

| #   | Quy tắc                                                             | Mức độ   |
| --- | ------------------------------------------------------------------- | -------- |
| 1   | Luôn **hỏi trước** khi chạy sync — không tự động thay đổi shared KB | Critical |
| 2   | Chỉ sync từ `/services/*` — không sync `/src/legacy/`               | Critical |
| 3   | Sau mỗi sync, chạy verify graph để đảm bảo dữ liệu chính xác        | Required |
| 4   | Gợi ý cập nhật `nexus-config.yaml` nếu service mới                  | Required |
| 5   | Nếu sync thất bại, báo chi tiết lỗi — không retry im lặng           | Required |
