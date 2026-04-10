# Feature Flow — Agentic Workflow

Quy trình tự động khi Agent nhận yêu cầu tính năng mới, đảm bảo **Zero Regression** và tuân thủ **Zone Policy**.

---

## Tổng quan

```
Request → Impact Analysis → Adapter Proposal → Write Tests (TDD) → Implement → Hooks Verify
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

- Nếu vùng ảnh hưởng chạm vào `/src/legacy/**` → **bắt buộc dùng Adapter** (Bước 3).
- Nếu chỉ ảnh hưởng `/src/modules/v3/**` → có thể sửa trực tiếp nhưng vẫn phải qua TDD (Bước 4).

**Output:** Báo cáo impact với danh sách dependencies và mức rủi ro.

---

## Bước 3 — Đề xuất Adapter cho code cũ

Khi tính năng mới cần tương tác với `/src/legacy/**`:

1. **Xác định interface** mà code cũ đang expose.
2. **Tạo Adapter** trong `/src/adapters/` để bọc (wrap) interface cũ.
3. Adapter phải:
   - Giữ nguyên hành vi gốc của legacy code.
   - Expose interface mới, sạch, tuân thủ SOLID cho Green Zone sử dụng.
   - Xử lý các quirks/bugs đã biết (tra KB).

```
/src/adapters/
└── payment-legacy.adapter.ts   ← Wraps /src/legacy/payment.js
```

**Nguyên tắc:**
- KHÔNG sửa bất kỳ file nào trong `/src/legacy/`.
- Adapter = lớp cách ly duy nhất giữa legacy và v3.
- Nếu legacy có bug → sửa hành vi trong adapter, ghi chú rõ lý do.

**Output:** File adapter mới + interface definition.

---

## Bước 4 — Viết Unit Test trước (TDD)

Tuân thủ quy trình **Red → Green → Refactor**:

### 4.1 — Red (Viết test thất bại)
- Viết test cho tính năng mới dựa trên spec từ Bước 1.
- Viết test cho adapter (nếu có) để đảm bảo nó wrap đúng hành vi legacy.
- Chạy test → **tất cả phải FAIL** (chưa có implementation).

### 4.2 — Green (Viết code tối thiểu)
- Implement tính năng trong `/src/modules/v3/`.
- Code chỉ cần đủ để test pass, không over-engineer.

### 4.3 — Refactor
- Cải thiện code quality: naming, structure, loại bỏ duplication.
- Chạy lại toàn bộ test → **phải vẫn PASS**.

**Output:** Test files + implementation trong Green Zone.

---

## Bước 5 — Chạy Hooks kiểm tra regression

Trước khi hoàn tất, thực thi chuỗi hooks để đảm bảo code cũ không bị ảnh hưởng:

### Hook Pipeline

```
pre-commit
  ├── lint          → Kiểm tra code style
  ├── type-check    → tsc --noEmit
  └── test:unit     → Chạy unit tests (bao gồm test mới + test cũ)

pre-push
  ├── test:integration  → Test tích hợp giữa adapter và legacy
  └── test:regression   → Full regression suite
```

### Regression Checklist (tự động)

- [ ] Tất cả test cũ vẫn pass.
- [ ] Không có public interface nào bị thay đổi signature.
- [ ] Adapter trong `/src/adapters/` vẫn wrap đúng hành vi legacy.
- [ ] Không có file nào trong `/src/legacy/` bị sửa đổi.

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
    ┌────┴─────┐
    │ Chạm     │
    │ legacy?  │
    └────┬─────┘
    Yes  │  No
    ▼    │   ▼
┌────────┐ ┌──────────┐
│3.Adapter│ │ Bỏ qua   │
│ Proposal│ │ Bước 3   │
└────┬───┘ └────┬─────┘
     └─────┬────┘
           ▼
┌─────────────────────┐
│  4. TDD             │
│  Red → Green →      │
│  Refactor           │
└────────┬────────────┘
         ▼
┌─────────────────────┐
│  5. Hooks Verify    │
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
