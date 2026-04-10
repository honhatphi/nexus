# Maintain Hub — Agentic Workflow

Quy trình tự động khi phát hiện thay đổi trong `/services/*`, đảm bảo **Nexus Hub luôn đồng bộ** với knowledge mới nhất từ các spoke service.

---

## Tổng quan

```
Detect Change → Validate Service → sync_service_knowledge → Verify Graph → Notify
```

---

## Trigger — Khi nào workflow này kích hoạt?

Agent **phải tự động gợi ý** chạy workflow này khi phát hiện một trong các sự kiện sau:

1. **Folder mới** được thêm vào `/services/` (new microservice).
2. **File source code mới** được tạo hoặc sửa đổi đáng kể trong một service đã có.
3. **Người dùng yêu cầu** đồng bộ kiến thức thủ công.
4. **Trước khi code tính năng mới** — nếu lần sync gần nhất đã quá cũ (agent nên hỏi).

### Phát hiện folder mới

Khi Agent quan sát thấy thư mục mới trong `/services/`:

```
# Ví dụ: người dùng vừa tạo /services/inventory-service/
Agent PHẢI thông báo:
  "Phát hiện service mới: inventory-service.
   Bạn có muốn chạy sync_service_knowledge để nạp toàn bộ
   hàm và quan hệ vào Knowledge Base không?"
```

> **Không tự động chạy sync** mà không hỏi người dùng trước — đây là hành động ảnh hưởng đến shared KB.

---

## Bước 1 — Validate Service Directory

Trước khi chạy sync, kiểm tra service folder hợp lệ:

- [ ] Folder tồn tại và chứa source code (`.go`, `.py`, `.php`, `.ts`, `.tsx`).
- [ ] Folder không nằm trong danh sách bỏ qua (`node_modules`, `.git`, `vendor`, `dist`, ...).
- [ ] Tuyệt đối **không** sync `/src/legacy/` — chỉ sync `/services/*`.

```
# ❌ FORBIDDEN
sync_service_knowledge({ service_path: "/src/legacy" })

# ✅ ALLOWED
sync_service_knowledge({ service_path: "./services/inventory-service" })
```

**Output:** Xác nhận service hợp lệ hoặc thông báo lỗi.

---

## Bước 2 — Chạy `sync_service_knowledge`

Gọi tool với đường dẫn service:

```
sync_service_knowledge({
  service_path: "./services/inventory-service",
  force_update: false   // true nếu muốn re-sync toàn bộ
})
```

Tool sẽ tự động:
1. Quét toàn bộ file source code trong folder.
2. Parse bằng `CodeParser` (tree-sitter WASM) — extract symbols, params, docstrings, calls.
3. Upsert vào **Memgraph**:
   - Nodes: `Service`, `File`, `Function` (với `kind`, `signature`, `docstring`).
   - Edges: `Service → CONTAINS → File → CONTAINS → Function`, `Function → CALLS → Function`.
4. Upsert vào **ChromaDB**: Embedding signature + docstring + metadata cho mỗi symbol.

**Output:** `SyncReport` — số hàm nạp, số quan hệ mới, trạng thái thành công.

---

## Bước 3 — Verify Graph Integrity

Sau khi sync xong, Agent nên chạy kiểm tra nhanh:

```
# Kiểm tra service node đã tồn tại trong graph
query_graph({ query: "MATCH (s:Service {name: 'inventory-service'}) RETURN s" })

# Kiểm tra số lượng function đã nạp
query_graph({
  query: "MATCH (s:Service {name: $name})-[:CONTAINS]->(:File)-[:CONTAINS]->(f:Function) RETURN count(f) AS total",
  params: { name: "inventory-service" }
})
```

Nếu kết quả bất thường (0 function, missing edges), cảnh báo người dùng và gợi ý chạy lại với `force_update: true`.

**Output:** Báo cáo xác nhận graph đã cập nhật đúng.

---

## Bước 4 — Cập nhật `nexus-config.yaml`

Nếu service mới chưa được khai báo trong `/nexus-config.yaml`, Agent phải gợi ý thêm:

```yaml
services:
  # ... existing services ...
  inventory-service:
    path: ./services/inventory-service
    language: go          # or python, php, typescript
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

| # | Quy tắc | Mức độ |
|---|---------|--------|
| 1 | Luôn **hỏi trước** khi chạy sync — không tự động thay đổi shared KB | Critical |
| 2 | Chỉ sync từ `/services/*` — không sync `/src/legacy/` | Critical |
| 3 | Sau mỗi sync, chạy verify graph để đảm bảo dữ liệu chính xác | Required |
| 4 | Gợi ý cập nhật `nexus-config.yaml` nếu service mới | Required |
| 5 | Nếu sync thất bại, báo chi tiết lỗi — không retry im lặng | Required |
