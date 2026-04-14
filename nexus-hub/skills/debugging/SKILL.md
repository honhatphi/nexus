---
name: nexus-debugging
description: "Use when tracing bugs that span multiple functions or services. Leverages KB graph for call chains, impact analysis, and process flows."
tools: [search_knowledge_base, query_graph, get_impact_analysis, get_process_flows, detect_changes]
---

## When to Use

- User reports a bug involving multiple functions/files
- Stack trace crosses service or module boundaries
- Need to understand the full execution path that leads to the error
- Debugging a regression after recent code changes

## Workflow

1. **Search KB** — `search_knowledge_base` for error-related symbols, function names, or error messages.
2. **Query graph** — `query_graph` to find callers/callees of the suspect function:
   ```cypher
   MATCH (caller)-[:CALLS]->(f:Function {name: "suspectFunction"})
   RETURN caller.name, caller.file, caller.service
   ```
3. **Get impact analysis** — `get_impact_analysis` to find all dependents (blast radius).
4. **Get process flows** — `get_process_flows` to trace the full execution path from entry point to terminal.
5. **Detect changes** — `detect_changes` to check if recent commits touched affected code.
6. **Read source files** at identified locations to pinpoint the bug.
7. Propose fix with KB-grounded context — cite which functions/files are affected and why.

## Anti-patterns

- Do NOT guess the root cause without checking KB first.
- Do NOT modify shared modules without running `get_impact_analysis` to understand blast radius.
- Do NOT assume a function is only called from one place — always verify via graph.
