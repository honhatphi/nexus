// ─────────────────────────────────────────────────────────────
// MCP tools: Workspace Manifest (PR 3)
// nexus_workspace_status, nexus_sync_current_repo,
// nexus_resolve_workspace
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { CodeIndexer } from "@nexus-hub/core";
import { WorkspaceResolver, RepoDetector } from "@nexus-hub/core";

export function registerWorkspaceTools(
  server: McpServer,
  indexer: CodeIndexer,
): void {
  // ── nexus_workspace_status ─────────────────────────────────
  server.tool(
    "nexus_workspace_status",
    "Show the current workspace manifest and registered repos. Does NOT modify the manifest.",
    {
      cwd: z
        .string()
        .optional()
        .describe(
          "Directory to search from (default: process.cwd()). Walk upward until .nexus/workspace.yaml is found.",
        ),
    },
    async ({ cwd }) => {
      try {
        const startDir = cwd ?? process.cwd();
        const found = await WorkspaceResolver.findWorkspaceRoot(startDir);

        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "No .nexus/workspace.yaml found. Run nexus_resolve_workspace to initialise.",
                }),
              },
            ],
          };
        }

        const manifest = await WorkspaceResolver.readManifest(
          found.manifestPath,
        );
        const localState = await WorkspaceResolver.readLocalState(
          manifest.workspaceId,
        );

        const repos = manifest.repos.map((r) => {
          const ls = localState?.repos[r.repoId];
          return {
            repoId: r.repoId,
            relativePath: r.relativePath,
            exists: !!ls,
            lastIndexedCommit: ls?.lastIndexedCommit ?? null,
            lastIndexedAt: ls?.lastIndexedAt ?? null,
          };
        });

        // Detect current repo
        const detected = await RepoDetector.detect(startDir);
        let currentRepo: Record<string, unknown> | null = null;
        if (detected) {
          const rel = path.relative(found.root, detected.repoRoot);
          const registered = manifest.repos.some(
            (r) => r.repoId === detected.repoId || r.relativePath === rel,
          );
          currentRepo = {
            repoId: detected.repoId,
            relativePath: rel,
            branch: detected.branch,
            commit: detected.commit,
            registered,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  workspaceId: manifest.workspaceId,
                  workspaceRoot: found.root,
                  currentRepo,
                  repos,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_resolve_workspace ────────────────────────────────
  server.tool(
    "nexus_resolve_workspace",
    "Find or create the workspace manifest. Pass workspaceId to initialise a new workspace at cwd. Returns resolved workspaceId and root.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Directory to search/init from (default: process.cwd())."),
      workspace_id: z
        .string()
        .optional()
        .describe(
          "If provided and no manifest exists, creates one with this workspaceId.",
        ),
    },
    async ({ cwd, workspace_id }) => {
      try {
        const startDir = cwd ?? process.cwd();
        let found = await WorkspaceResolver.findWorkspaceRoot(startDir);

        if (!found && workspace_id) {
          // Init new manifest at startDir
          await WorkspaceResolver.initManifest(startDir, workspace_id);
          found = await WorkspaceResolver.findWorkspaceRoot(startDir);
        }

        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "No workspace found. Provide workspace_id to initialise one.",
                }),
              },
            ],
            isError: true,
          };
        }

        const manifest = await WorkspaceResolver.readManifest(
          found.manifestPath,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  workspaceId: manifest.workspaceId,
                  workspaceRoot: found.root,
                  manifestPath: found.manifestPath,
                  reposRegistered: manifest.repos.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── nexus_sync_current_repo ────────────────────────────────
  server.tool(
    "nexus_sync_current_repo",
    "Detect the current repo (via Git), optionally add it to the workspace manifest, then sync/index it into the Knowledge Base. This is the primary way to keep the KB up to date.",
    {
      cwd: z
        .string()
        .optional()
        .describe(
          "Path to the repo root or any subdirectory (default: process.cwd()).",
        ),
      auto_add_to_workspace: z
        .boolean()
        .optional()
        .describe(
          "If true (default), add the repo to the workspace manifest if not already registered.",
        ),
      force_update: z
        .boolean()
        .optional()
        .describe(
          "If true, re-index all files even if content hash is unchanged.",
        ),
    },
    async ({ cwd, auto_add_to_workspace = true, force_update = false }) => {
      try {
        const startDir = cwd ?? process.cwd();
        const detected = await RepoDetector.detect(startDir);

        if (!detected) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "Could not detect a Git repo. Is git installed and is this a git repository?",
                }),
              },
            ],
            isError: true,
          };
        }

        let addedToManifest = false;

        if (auto_add_to_workspace) {
          const workspaceFound =
            await WorkspaceResolver.findWorkspaceRoot(startDir);
          if (workspaceFound) {
            const manifest = await WorkspaceResolver.readManifest(
              workspaceFound.manifestPath,
            );
            const rel = path.relative(workspaceFound.root, detected.repoRoot);
            const alreadyIn = manifest.repos.some(
              (r) => r.repoId === detected.repoId || r.relativePath === rel,
            );
            if (!alreadyIn) {
              manifest.repos.push({
                repoId: detected.repoId,
                relativePath: rel,
              });
              await WorkspaceResolver.writeManifest(
                workspaceFound.manifestPath,
                manifest,
              );
              addedToManifest = true;
            }

            // Update local state
            const localState = (await WorkspaceResolver.readLocalState(
              manifest.workspaceId,
            )) ?? {
              workspaceId: manifest.workspaceId,
              workspaceRoot: workspaceFound.root,
              repos: {},
            };
            localState.repos[detected.repoId] = {
              absolutePath: detected.repoRoot,
              relativePath: rel,
              lastIndexedCommit: detected.commit ?? undefined,
              lastIndexedAt: new Date().toISOString(),
            };
            await WorkspaceResolver.writeLocalState(localState);
          }
        }

        // Run sync/index
        const syncResult = await indexer.sync({
          serviceId: detected.repoId,
          servicePath: detected.repoRoot,
          forceUpdate: force_update,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  repo: {
                    repoId: detected.repoId,
                    repoRoot: detected.repoRoot,
                    branch: detected.branch,
                    commit: detected.commit,
                    addedToManifest,
                  },
                  sync: syncResult,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
