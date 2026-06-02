# Nexus — AI Agent Instructions for Codex / Copilot

> **Use Nexus MCP tools as your primary context source before reading any files.**
> The MCP server runs locally at `http://localhost:13100/mcp`.

---

## Workflow for every coding task

1. **`nexus_build_context_pack`** — always start here. Pass `task`; `workspace_id` is optional and only needed when the auto-resolved workspace is wrong.
2. **`nexus_open_task`** — open a ledger entry so decisions and touched files are tracked.
3. **`nexus_get_code_snippet`** — read file excerpts, but only for files listed in the context pack manifest.
4. **`nexus_update_ledger`** after each meaningful step (state change, file modified, decision made).
5. **`nexus_store_artifact`** — offload large outputs (test logs, diffs, query results) instead of returning them inline.
6. **`nexus_close_task`** when the task is done.

---

## Tool reference (task lifecycle)

| Tool                         | When to call                 |
| ---------------------------- | ---------------------------- |
| `nexus_build_context_pack`   | First tool, every task       |
| `nexus_open_task`            | Before writing code          |
| `nexus_get_task_state`       | Resume after interruption    |
| `nexus_update_ledger`        | After each step              |
| `nexus_close_task`           | Task complete or abandoned   |
| `nexus_store_artifact`       | Any output > 500 tokens      |
| `nexus_get_artifact_excerpt` | Read artifact by line range  |
| `nexus_get_code_snippet`     | Read file (manifest-guarded) |

---

## KB search tools

| Tool                     | When to call                      |
| ------------------------ | --------------------------------- |
| `search_knowledge_base`  | Before any architecture decision  |
| `query_graph`            | Cross-service dependency checks   |
| `get_impact_analysis`    | Before modifying shared functions |
| `sync_service_knowledge` | After major refactor to update KB |

---

## Rules

- Never read more than 50 lines of a file at once without calling `nexus_get_code_snippet`.
- Before modifying a shared function, call `get_impact_analysis`.
- If a function is called by another service, **do not change its signature** — create a v2 instead.
- Store any test output, diff, or terminal log with `nexus_store_artifact` and reference by artifact ID.
- Do not guess token budgets — use the `estimatedTokens` field in tool responses.

## Quick KB sync check

Added a helper script `projects/ai/nexus/scripts/check-sync-summary.sh` to quickly summarize recent Nexus KB sync jobs. Run the script locally to see jobId, service, status, files, symbols indexed, duration, and error counts.


### NPM shortcut

You can run the quick sync summary via npm from the MCP server folder:

```bash
npm --prefix projects/ai/nexus/mcp-server run check-sync
```

This is useful for Hub Manager or CI scripts that can invoke npm commands.

