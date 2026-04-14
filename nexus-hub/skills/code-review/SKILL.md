---
name: nexus-code-review
description: "Use when reviewing code changes for correctness, safety, and consistency with KB knowledge."
tools: [search_knowledge_base, query_graph, get_impact_analysis, detect_changes]
---

## When to Use

- Reviewing a PR or set of changes before merge
- Checking if changes follow established patterns
- Assessing risk and blast radius of modifications

## Workflow

1. **Detect changes** — `detect_changes` to get the list of affected files with risk assessment.
2. **Check callers** — For each high-risk file, use `get_impact_analysis` to understand who depends on it.
3. **Search patterns** — `search_knowledge_base` to verify the changes follow established patterns.
4. **Verify graph consistency** — `query_graph` to check if any CALLS or IMPORTS edges will be broken:
   ```cypher
   MATCH (caller)-[:CALLS]->(f:Function {file: "changed-file-path"})
   RETURN caller.name, caller.file
   ```
5. **Review against Hub** — Check if changes contradict any documented decisions in `/nexus-hub/knowledge-base/`.
6. Provide structured feedback: what's correct, what's risky, what violates patterns.

## Review Checklist

- [ ] No public API signature changes without explicit approval
- [ ] Changes consistent with existing patterns (KB-verified)
- [ ] Risk level acceptable (from `detect_changes`)
- [ ] No new dependencies with known vulnerabilities
- [ ] Type annotations present for new functions/variables
- [ ] Docstrings added for new public functions

## Anti-patterns

- Do NOT approve changes without checking KB for conflicts.
- Do NOT ignore high-risk warnings from `detect_changes`.
