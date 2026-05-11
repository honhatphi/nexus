# 03 — Migration Status

> Cập nhật sau mỗi PR merge.

---

## Milestones

| Milestone | Mô tả                                  | Status  |
| --------- | -------------------------------------- | ------- |
| A         | Nexus vẫn chạy như cũ + có Core façade | ✅ Done |
| B         | Context Pack usable với Codex          | ✅ Done |
| C         | Memory + Artifact usable               | ✅ Done |
| D         | Budget enforced                        | ✅ Done |
| E         | Codex local workflow đầy đủ            | ✅ Done |
| F         | Hard task workspace                    | ✅ Done |

---

## PR Status

| PR    | Tên                                               | Status  | Branch | Merged     |
| ----- | ------------------------------------------------- | ------- | ------ | ---------- |
| PR 0  | Baseline docs + snapshot                          | ✅ Done | —      | 2026-05-11 |
| PR 1  | NexusCore façade                                  | ✅ Done | —      | 2026-05-11 |
| PR 2  | Data contracts                                    | ✅ Done | —      | 2026-05-11 |
| PR 3  | Workspace Manifest Auto-Discovery + Auto-Register | ✅ Done | —      | 2026-08-04 |
| PR 4  | Task Ledger                                       | ✅ Done | —      | 2026-05-11 |
| PR 5  | Artifact Store                                    | ✅ Done | —      | 2026-05-11 |
| PR 6  | Context Pack Builder                              | ✅ Done | —      | 2026-05-11 |
| PR 7  | Code Snippet tool                                 | ✅ Done | —      | 2026-05-11 |
| PR 8  | Budget Engine                                     | ✅ Done | —      | 2026-05-11 |
| PR 9  | Persistent index                                  | ✅ Done | —      | 2026-08-04 |
| PR 10 | Codex local integration                           | ✅ Done | —      | 2026-05-11 |
| PR 11 | Legacy tool flag                                  | ✅ Done | —      | 2026-08-04 |
| PR 12 | Hard task workspace                               | ✅ Done | —      | 2026-08-04 |

---

## New MCP Tools Introduced

| Tool                         | PR    | Status |
| ---------------------------- | ----- | ------ |
| `nexus_workspace_status`     | PR 3  | ✅     |
| `nexus_sync_current_repo`    | PR 3  | ✅     |
| `nexus_resolve_workspace`    | PR 3  | ✅     |
| `nexus_open_task`            | PR 4  | ✅     |
| `nexus_get_task_state`       | PR 4  | ✅     |
| `nexus_update_ledger`        | PR 4  | ✅     |
| `nexus_close_task`           | PR 4  | ✅     |
| `nexus_store_artifact`       | PR 5  | ✅     |
| `nexus_get_artifact_summary` | PR 5  | ✅     |
| `nexus_get_artifact_excerpt` | PR 5  | ✅     |
| `nexus_build_context_pack`   | PR 6  | ✅     |
| `nexus_get_code_snippet`     | PR 7  | ✅     |
| `nexus_status`               | PR 11 | ✅     |
| `nexus_spawn_task_workspace` | PR 12 | ✅     |
| `nexus_get_task_workspace`   | PR 12 | ✅     |
| `nexus_apply_task_patch`     | PR 12 | ✅     |

---

## Architecture Snapshots

| Snapshot        | Date       | PR   |
| --------------- | ---------- | ---- |
| `baseline.json` | 2026-05-11 | PR 0 |
