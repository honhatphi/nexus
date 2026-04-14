# Feature Flow — Agentic Workflow

Automated workflow when the agent receives a new feature request, ensuring **Zero Regression** and **Zone Policy** compliance.

---

## Overview

```
Request → Impact Analysis → Adapter Proposal → Write Tests → Implement → Hooks Verify
```

---

## Step 1 — Receive Feature Request

- Agent receives the feature description from the user.
- Call `search_knowledge_base` to check if the KB has any relevant patterns, constraints, or architectural decisions.
- If the KB conflicts with the request → **stop and notify** before proceeding.

**Output:** Request summary + KB context.

---

## Step 2 — Analyze Impact Zone (`get_impact_analysis`)

- Call `get_impact_analysis` with the file/function names related to the new feature.
- Analyze the results:
  - **dependencies** — List of directly and transitively dependent modules/functions.
  - **relatedCode** — Similar code snippets from ChromaDB.
  - **depth** — Propagation depth in the dependency graph.

```
get_impact_analysis({ name: "PaymentService", maxDepth: 3 })
```

- If the impact zone touches `/src/legacy/**` → **adapter is mandatory** (Step 3).
- If it only affects `/src/modules/v3/**` → can modify directly but TDD is still required (Step 4).

**Output:** Impact report with dependency list and risk level.

---

## Step 3 — Propose Adapter for Legacy Code

When the new feature needs to interact with `/src/legacy/**`:

1. **Identify the interface** that the legacy code currently exposes.
2. **Create an Adapter** in `/src/adapters/` to wrap the legacy interface.
3. The adapter must:
   - Preserve the original behavior of legacy code.
   - Expose a new, clean interface that follows SOLID for Green Zone usage.
   - Handle known quirks/bugs (consult KB).

```
/src/adapters/
└── payment-legacy.adapter.ts   ← Wraps /src/legacy/payment.js
```

**Principles:**

- NEVER modify any file in `/src/legacy/`.
- Adapter = the only isolation layer between legacy and v3.
- If legacy has a bug → fix the behavior in the adapter, document the reason clearly.

**Output:** New adapter file + interface definition.

---

## Step 4 — Write Tests & Implement

### 4.1 — Write tests first

- Write tests for the new feature based on the spec from Step 1.
- Write tests for the adapter (if any) to ensure it correctly wraps legacy behavior.

### 4.2 — Implement

- Implement the feature in `/src/modules/v3/`.
- Code only needs to be enough to make tests pass, no over-engineering.

### 4.3 — Verify

- Improve code quality: naming, structure, remove duplication.
- Run all tests → **must PASS**.

**Output:** Test files + implementation.

---

## Step 5 — Run Hooks for Regression Check

Before finalizing, execute the hook pipeline to ensure existing code is not affected:

### Hook Pipeline

```
pre-commit
  ├── lint          → Check code style
  ├── type-check    → tsc --noEmit
  └── test:unit     → Run unit tests (both new + existing)

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
│  4. Write Tests     │
│     + Implement     │
│     + Verify        │
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
