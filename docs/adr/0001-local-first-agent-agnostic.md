# ADR 0001 — Local-First Agent-Agnostic Architecture

**Date**: 2026-05-11  
**Status**: Accepted  
**Deciders**: Nexus team

---

## Context

Nexus hiện đang hoạt động như một Knowledge Engine với MCP server cho GitHub Copilot. Các vấn đề phát sinh:

1. Agent (Copilot, Codex, Cline) có thể đọc toàn repo tùy tiện — context không được kiểm soát
2. Tool output không có giới hạn token — có thể rất lớn khi đưa vào prompt
3. Không có task state structure — agent phải replay chat history
4. Large outputs (logs, diffs) được đưa trực tiếp vào prompt
5. Chưa có context pack — agent phải tự search/query nhiều lần, context không nhất quán
6. Chưa có Codex integration — chưa provider-agnostic

---

## Decision

Chuyển Nexus từ Knowledge Engine prototype thành **Local Context Gateway** theo các nguyên tắc:

### 1. Local-First

- Nexus chạy local (MCP server, Memgraph, ChromaDB đều trên máy developer)
- Memory (task ledger, artifacts, context packs) lưu local tại `~/.nexus/`
- Token budget do Nexus kiểm soát local
- Model cloud chỉ nhận context pack đã được Nexus chọn lọc

### 2. Agent-Agnostic

- Codex, Copilot, Cline, bất kỳ agent MCP-compatible nào đều dùng được
- Nexus expose MCP standard — agent chỉ là executor
- Không có hard dependency vào provider SDK cụ thể

### 3. Strangler Architecture

- Không rewrite toàn bộ
- Thêm Nexus Core phía sau MCP adapter hiện tại
- Tool cũ vẫn hoạt động sau flag `NEXUS_ENABLE_LEGACY_TOOLS`
- Mỗi PR là một delta nhỏ, có snapshot test để compare

### 4. Context Pack là core primitive

- `nexus_build_context_pack` là tool quan trọng nhất
- Agent nhận context pack trước, sau đó mới request specific snippets
- Context pack v1 là deterministic (no LLM summarization)

### 5. Soft enforcement trước, hard workspace sau

- Phase đầu: soft mode, AGENTS.md guide agent dùng context pack
- Phase sau: hard task workspace — Codex chỉ thấy selected files

---

## Consequences

**Positive:**

- Model token consumption giảm đáng kể
- Context quality tăng (Nexus chọn lọc thay vì agent đọc random)
- Task state có cấu trúc, không cần replay chat history
- Large outputs được store artifact, không tốn prompt tokens
- Provider-agnostic: Codex, Copilot, Cline đều dùng được

**Negative/Risks:**

- Context pack builder cần đủ tốt để chọn đúng context
- Strangler migration cần kỷ luật để không phá tool cũ
- Hard task workspace (PR 12) phức tạp, cần patch/apply flow

**Neutral:**

- Memgraph + ChromaDB vẫn giữ, không thay thế
- Parser pipeline tree-sitter vẫn giữ, thêm capsule output
- Git hooks auto-sync vẫn giữ

---

## Alternatives Considered

### A. Rewrite toàn bộ Nexus

Rejected: quá rủi ro, phá tool cũ, mất thời gian dài trước khi có value.

### B. Plugin cho từng agent (Copilot extension, Codex plugin)

Rejected: không provider-agnostic, phải maintain nhiều adapters.

### C. Cloud-hosted context gateway

Rejected: vi phạm nguyên tắc local-first, code không rời máy developer nếu không muốn.
