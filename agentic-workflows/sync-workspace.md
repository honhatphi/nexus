# Sync Workspace — Agentic Workflow

Quy trình tự động quét toàn bộ `/services`, trích xuất tri thức, nạp vào Shared Graph & Vector DB, rồi phân tích để tạo Global Skills.

---

## Tổng quan

```
Scan /services → Parse (tree-sitter) → Upsert Graph + Vector → Detect Patterns → Generate Global Skills
```

---

## Bước 1 — Quét toàn bộ dự án trong `/services`

- Liệt kê tất cả service directories trong `/services/*`.
- Mỗi service đã được khai báo trong `/nexus-config.yaml` với tech stack tương ứng.
- Thu thập metadata: tên service, ngôn ngữ, đường dẫn.

```
Input:  /services/*
Output: [
  { name: "api-gateway",          path: "./services/api-gateway",          tech: "Go"     },
  { name: "auth-service",         path: "./services/auth-service",         tech: "Go"     },
  { name: "payment-service",      path: "./services/payment-service",      tech: "Python" },
  { name: "notification-service", path: "./services/notification-service", tech: "PHP"    },
]
```

---

## Bước 2 — Gọi `universal-parser` trích xuất tri thức

Với mỗi service, sử dụng MCP Tool `sync_service_knowledge`:

```
sync_service_knowledge({
  service_path: "./services/api-gateway",
  force_update: false
})
```

Tool sẽ tự động:
1. Quét tất cả file mã nguồn (`.go`, `.py`, `.php`, `.ts`).
2. Gọi `universal-parser.ts` cho từng file.
3. Trích xuất: **Functions**, **Parameters**, **Return Types**, **Function Calls**.
4. Chuẩn hóa thành Unified Schema JSON.

**Output mỗi service:**
```jsonc
{
  "service": "api-gateway",
  "language": "go",
  "filesScanned": 42,
  "functionsExtracted": 156,
  "relationshipsCreated": 320,
  "vectorsUpserted": 156
}
```

---

## Bước 3 — Nạp dữ liệu vào Shared Databases

### 3a. Memgraph (Shared Graph)

Tạo/cập nhật nodes và relationships:

```cypher
// Node cho mỗi hàm
MERGE (f:Function {name: $name, file: $file, service: $service})
SET f.language    = $language,
    f.returnType  = $returnType,
    f.startLine   = $startLine,
    f.endLine     = $endLine,
    f.updatedAt   = timestamp()

// Relationship cho mỗi function call
MERGE (caller:Function {name: $callerName, file: $callerFile})
MERGE (callee:Function {name: $calleeName})
MERGE (caller)-[:CALLS {line: $line}]->(callee)

// Relationship file → service
MERGE (s:Service {name: $service})
MERGE (fi:File {path: $file})
MERGE (fi)-[:BELONGS_TO]->(s)
MERGE (f)-[:DEFINED_IN]->(fi)
```

### 3b. ChromaDB (Shared Vector)

Nạp mỗi function signature + body context làm vector document:

```
ID:       "{service}::{file}::{functionName}"
Document: "{functionSignature}\n{parameterList}\n{returnType}"
Metadata: { service, file, language, startLine, endLine }
```

---

## Bước 4 — Phân tích Pattern chung giữa các Microservices

Sau khi nạp xong tất cả services, Agent thực hiện phân tích cross-service:

### 4a. Truy vấn Graph để tìm pattern

```cypher
// Tìm các hàm có tên giống nhau xuất hiện trong nhiều service
MATCH (f:Function)
WITH f.name AS funcName, collect(DISTINCT f.service) AS services, count(*) AS cnt
WHERE cnt > 1
RETURN funcName, services, cnt
ORDER BY cnt DESC
LIMIT 20

// Tìm pattern gọi API chéo service
MATCH (caller:Function)-[:CALLS]->(callee:Function)
WHERE caller.service <> callee.service
RETURN caller.service, caller.name, callee.service, callee.name

// Tìm pattern xử lý lỗi chung
MATCH (f:Function)-[:CALLS]->(handler:Function)
WHERE handler.name CONTAINS 'error' OR handler.name CONTAINS 'Error'
   OR handler.name CONTAINS 'handle' OR handler.name CONTAINS 'catch'
RETURN f.service, f.name, handler.name, count(*) AS frequency
ORDER BY frequency DESC
```

### 4b. Truy vấn Vector để tìm code tương đồng

```
search_knowledge_base({ query: "error handling middleware", topK: 10 })
search_knowledge_base({ query: "HTTP client retry logic", topK: 10 })
search_knowledge_base({ query: "authentication token validation", topK: 10 })
```

---

## Bước 5 — Tạo Global Skills trong `/nexus-hub/skills`

Dựa trên kết quả phân tích, Agent tự động tạo các Global Skill files:

```
nexus-hub/skills/
├── error-handling.md          ← Pattern xử lý lỗi chung
├── inter-service-calls.md     ← Cách gọi API giữa các service
├── auth-middleware.md          ← Pattern auth middleware
├── retry-logic.md              ← Retry & circuit breaker pattern
└── logging-standards.md        ← Logging format chuẩn
```

Mỗi skill file chứa:
- **Mô tả pattern** — Tóm tắt pattern tìm thấy.
- **Services áp dụng** — Danh sách services nào đang dùng pattern này.
- **Code mẫu chuẩn** — Ví dụ code reference từ service tốt nhất.
- **Anti-patterns** — Các cách triển khai sai phát hiện khi so sánh.
- **Recommendations** — Gợi ý cải thiện cho các service chưa tuân thủ.

---

## Sơ đồ luồng

```
┌──────────────────────────────┐
│  1. Liệt kê /services/*     │
│     Đọc nexus-config.yaml   │
└──────────────┬───────────────┘
               ▼
       ┌───────┴───────┐
       │  Với mỗi      │
       │  service:      │
       └───────┬───────┘
               ▼
┌──────────────────────────────┐
│  2. sync_service_knowledge   │
│     universal-parser →       │
│     extract functions        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  3a. Upsert → Memgraph      │
│  3b. Upsert → ChromaDB      │
└──────────────┬───────────────┘
               ▼
       ┌───────┴───────┐
       │ Tất cả        │
       │ services done? │
       └───────┬───────┘
          Yes  ▼
┌──────────────────────────────┐
│  4. Cross-service analysis   │
│     Graph queries +          │
│     Vector similarity        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  5. Generate Global Skills   │
│     → /nexus-hub/skills/     │
└──────────────────────────────┘
```

---

## Lịch chạy

| Trigger | Hành động |
|---------|-----------|
| **Manual** | Agent gọi khi người dùng yêu cầu sync |
| **On Push** | Hook `post-push` chạy `sync_service_knowledge` cho service vừa thay đổi |
| **Scheduled** | Cron job chạy full sync hàng ngày, phân tích patterns hàng tuần |
