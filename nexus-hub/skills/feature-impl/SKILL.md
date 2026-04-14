---
name: nexus-feature-implementation
description: "Use when implementing a new feature in any service. Follows the Hub-First workflow to ground all decisions in KB knowledge."
tools: [search_knowledge_base, query_graph, get_impact_analysis, sync_service_knowledge]
---

## When to Use

- Implementing a new endpoint, function, or module
- Adding a new capability to an existing service
- Any code change that creates new symbols or edges in the codebase

## Workflow

1. **Search Hub** — Check `/nexus-hub/knowledge-base`, `/nexus-hub/patterns`, and `/nexus-hub/skills` for relevant prior art.
2. **Search KB** — `search_knowledge_base` for similar implementations or patterns already in the codebase.
3. **Check dependencies** — `query_graph` to understand the module/service landscape:
   ```cypher
   MATCH (f:Function {service: "target-service"})
   WHERE f.name CONTAINS "relatedKeyword"
   RETURN f.name, f.file
   ```
4. **Impact check** — `get_impact_analysis` on any existing function you plan to modify.
5. **Implement** — Write code following existing patterns from KB results.
6. **Sync** — After implementation, suggest running `sync_service_knowledge` to update the KB.

## Code Quality Rules

- Follow patterns found in Hub (`/nexus-hub/patterns/`) — do not invent new ones if equivalent exists.
- Add proper type annotations for Type Resolution phase to work.
- Keep functions focused (single responsibility) — this improves community detection accuracy.
- Add docstrings — they feed into semantic search embeddings.

## Anti-patterns

- Do NOT implement without searching KB first.
- Do NOT change public API signatures without checking callers via `get_impact_analysis`.
- Do NOT mix runtimes (e.g., Python in a Go service).
