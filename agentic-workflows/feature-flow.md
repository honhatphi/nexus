# Feature Flow — Agentic Workflow

Quy trình tự động khi Agent nhận yêu cầu tính năng mới, đảm bảo **Zero Regression**.

---

## Tổng quan

```
Request → Impact Analysis → Write Tests (TDD) → Implement → Hooks Verify
```

---

## Bước 1 — Nhận yêu cầu tính năng

- Agent nhận mô tả tính năng từ người dùng.
- Gọi `search_knowledge_base` để kiểm tra KB có pattern, constraint, hoặc quyết định kiến trúc nào liên quan.
- Nếu KB có xung đột với yêu cầu → **dừng lại và thông báo** trước khi tiếp tục.

**Output:** Bản tóm tắt yêu cầu + context từ KB.

---

## Bước 2 — Khảo sát vùng ảnh hưởng (`get_impact_analysis`)

- Gọi tool `get_impact_analysis` với tên file/hàm liên quan đến tính năng mới.
- Phân tích kết quả trả về:
  - **dependencies** — Danh sách module/hàm phụ thuộc trực tiếp và gián tiếp.
  - **relatedCode** — Các đoạn code tương đồng từ ChromaDB.
  - **depth** — Độ sâu lan truyền trong dependency graph.

```
get_impact_analysis({ name: "PaymentService", maxDepth: 3 })
```

**Output:** Báo cáo impact với danh sách dependencies và mức rủi ro.

---

## Bước 3 — Viết Unit Test trước (TDD)

Tuân thủ quy trình **Red → Green → Refactor**:

### 3.1 — Red (Viết test thất bại)

- Viết test cho tính năng mới dựa trên spec từ Bước 1.
- Chạy test → **tất cả phải FAIL** (chưa có implementation).

### 3.2 — Green (Viết code tối thiểu)

- Implement tính năng trong service.
- Code chỉ cần đủ để test pass, không over-engineer.

### 3.3 — Refactor

- Cải thiện code quality: naming, structure, loại bỏ duplication.
- Chạy lại toàn bộ test → **phải vẫn PASS**.

**Output:** Test files + implementation.

---

## Bước 4 — Chạy Hooks kiểm tra regression

Trước khi hoàn tất, thực thi chuỗi hooks để đảm bảo code cũ không bị ảnh hưởng:

### Hook Pipeline

```
pre-commit
  ├── lint          → Kiểm tra code style
  ├── type-check    → tsc --noEmit
  └── test:unit     → Chạy unit tests (bao gồm test mới + test cũ)

pre-push
  └── test:regression   → Full regression suite
```

### Regression Checklist (tự động)

- [ ] Tất cả test cũ vẫn pass.
- [ ] Không có public interface nào bị thay đổi signature.
- [ ] Cross-service dependencies đã được kiểm tra trước khi thay đổi.

**Output:** Báo cáo hook pass/fail. Nếu fail → quay lại bước tương ứng để sửa.

---

## Sơ đồ luồng

```
┌─────────────────────┐
│  1. Nhận yêu cầu    │
│     + tra KB         │
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  2. Impact Analysis  │
│     get_impact_      │
│     analysis()       │
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  3. TDD             │
│  Red → Green →      │
│  Refactor           │
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  4. Hooks Verify    │
│  lint + type-check  │
│  + regression tests │
└────────┬────────────┘
         ▼
    ┌────┴─────┐
    │  Pass?   │
    └────┬─────┘
    Yes  │  No
    ▼    │   ▼
  Done   │ Quay lại
         │ bước lỗi
```
