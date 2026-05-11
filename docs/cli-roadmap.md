# Nexus CLI — Roadmap

> **Status**: No CLI package exists yet. This document records the desired command UX
> and the mapping to existing MCP tools, so a future `nexus-hub/cli` package can be
> built with a clear spec.

---

## Desired commands

### `nexus workspace init <workspaceId>`

Initialise a workspace manifest in the current directory.

```bash
cd ~/work/commerce-platform
nexus workspace init commerce-platform
# Creates: .nexus/workspace.yaml
```

**MCP equivalent**:

```
nexus_resolve_workspace { workspace_id: "commerce-platform", cwd: "." }
```

---

### `nexus workspace status`

Show registered repos, their relative paths, and whether each is stale.

```bash
nexus workspace status
# commerce-platform
# ✓ pricing-service   (pricing-service/)        up-to-date
# ✓ warehouse-2.0     (warehouse-2.0/)           up-to-date
# ! promotion-service (promotion-service/)       stale — run `nexus sync`
```

**MCP equivalent**:

```
nexus_workspace_status { cwd: "." }
```

---

### `nexus workspace add .`

Register the current repository in the workspace manifest without syncing.

```bash
cd ~/work/commerce-platform/promotion-service
nexus workspace add .
# Adds relativePath: "promotion-service" to .nexus/workspace.yaml
```

**MCP equivalent**: `nexus_resolve_workspace` with `auto_add_to_workspace: false` +
manual manifest write (no dedicated tool today — gap to fill).

---

### `nexus sync`

Auto-detect the git root of the current directory, locate `.nexus/workspace.yaml`
in a parent, add the repo if missing, then index it into the KB.

```bash
cd ~/work/commerce-platform/pricing-service
nexus sync
# ✓ Detected repo: pricing-service
# ✓ Workspace:     commerce-platform (.nexus/workspace.yaml)
# ✓ Added to manifest: relativePath = pricing-service
# ✓ Indexed 320 files, 1840 symbols, 520 vectors
```

**MCP equivalent**:

```
nexus_sync_current_repo { auto_add_to_workspace: true, force_update: false }
```

### `nexus sync --all`

Sync every registered repo in the workspace manifest.

**MCP equivalent**: Call `nexus_sync_current_repo` for each repo in the manifest (no
batch tool today — gap to fill).

---

## Implementation notes

### Package location

```
nexus-hub/cli/
├── package.json          # "bin": { "nexus": "dist/index.js" }
├── tsconfig.json
└── src/
    ├── index.ts           # Commander root command
    └── commands/
        ├── workspace-init.ts
        ├── workspace-status.ts
        ├── workspace-add.ts
        └── sync.ts
```

### Shared infrastructure (already exists in `@nexus-hub/core`)

| Concern                   | Module                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| Locate workspace root     | `WorkspaceResolver` → `nexus-hub/core/src/workspace/workspace-resolver.ts` |
| Detect git root + repo ID | `RepoDetector` → `nexus-hub/core/src/workspace/repo-detector.ts`           |
| Read/write manifest       | `WorkspaceManifest` → `nexus-hub/core/src/workspace/workspace-manifest.ts` |
| Sync / index repo         | `SyncServiceKnowledge` → `nexus-hub/common-tools/src/sync-tool.ts`         |

> All CLI commands **must** call the same `WorkspaceResolver` / `RepoDetector` as the
> MCP tools so behaviour is identical regardless of entry point.

### Recommended CLI framework

[`commander`](https://github.com/tj/commander.js) — already used as a peer in many
Node.js CLIs, no runtime overhead, fits the existing TypeScript setup.

### Acceptance criteria (when CLI is built)

- [ ] `nexus workspace init <id>` creates `.nexus/workspace.yaml` (idempotent)
- [ ] `nexus workspace status` exits 0, prints stale markers
- [ ] `nexus sync` from a sub-repo adds to manifest + runs KB index
- [ ] `nexus sync --all` iterates manifest repos
- [ ] Build: `cd nexus-hub/cli && npm run build` exits 0
- [ ] Shared modules: no duplicated workspace/git logic between CLI and MCP tools

---

## MCP tools mapping summary

| CLI command              | MCP tool                  |
| ------------------------ | ------------------------- |
| `nexus workspace init`   | `nexus_resolve_workspace` |
| `nexus workspace status` | `nexus_workspace_status`  |
| `nexus workspace add .`  | _(no direct tool — gap)_  |
| `nexus sync`             | `nexus_sync_current_repo` |
| `nexus sync --all`       | _(no batch tool — gap)_   |

Gaps marked above should be filled (new MCP tools or updated tools) **before** the CLI
package is created, so CLI commands are thin wrappers rather than owning business logic.
