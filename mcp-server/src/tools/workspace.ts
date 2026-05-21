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
import { mcpJson, mcpError } from "../utils/mcp-response.js";
import { resolveStartDir } from "../utils/workspace-context.js";
import {
  workspaceStatusView,
  resolveWorkspaceView,
  syncCurrentRepoView,
} from "../utils/safe-response.js";

export function registerWorkspaceTools(
  server: McpServer,
  indexer: CodeIndexer,
): void {
  // ── nexus_workspace_status ─────────────────────────────────
  server.registerTool(
    "nexus_workspace_status",
    {
      annotations: { title: "🗺️ Workspace Status" },
      description:
        "Show the current workspace manifest and registered repos. Does NOT modify the manifest.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe(
            "Directory to search from. Walks upward until .nexus/workspace.yaml is found. Defaults to NEXUS_WORKSPACE_ROOT env var, then process.cwd().",
          ),
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes absolute local paths in the response (for developer debugging only).",
          ),
      },
    },
    async ({ cwd, debug = false }) => {
      try {
        const startDir = resolveStartDir(cwd);
        const found = await WorkspaceResolver.findWorkspaceRoot(startDir);

        if (!found) {
          return mcpJson({
            error:
              "No .nexus/workspace.yaml found. Run nexus_resolve_workspace to initialise.",
            hint: `Searched from: ${startDir}. Set NEXUS_WORKSPACE_ROOT to the workspace root.`,
          });
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

        return mcpJson(
          workspaceStatusView(
            manifest.workspaceId,
            found.root,
            currentRepo,
            repos,
            debug,
          ),
        );
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // ── nexus_resolve_workspace ────────────────────────────────
  server.registerTool(
    "nexus_resolve_workspace",
    {
      annotations: { title: "🗂️ Resolve Workspace" },
      description:
        "Find or create the workspace manifest. Pass workspaceId to initialise a new workspace at cwd. Returns resolved workspaceId and root.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe(
            "Directory to search/init from. Defaults to NEXUS_WORKSPACE_ROOT env var, then process.cwd().",
          ),
        workspace_id: z
          .string()
          .optional()
          .describe(
            "If provided and no manifest exists, creates one with this workspaceId.",
          ),
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes absolute local paths in the response (for developer debugging only).",
          ),
      },
    },
    async ({ cwd, workspace_id, debug = false }) => {
      try {
        const startDir = resolveStartDir(cwd);
        let found = await WorkspaceResolver.findWorkspaceRoot(startDir);

        if (!found && workspace_id) {
          // Init new manifest at startDir
          await WorkspaceResolver.initManifest(startDir, workspace_id);
          found = await WorkspaceResolver.findWorkspaceRoot(startDir);
        }

        if (!found) {
          return mcpError(
            "No workspace found. Provide workspace_id to initialise one.",
          );
        }

        const manifest = await WorkspaceResolver.readManifest(
          found.manifestPath,
        );
        return mcpJson(
          resolveWorkspaceView(
            manifest.workspaceId,
            manifest.repos.length,
            found.root,
            found.manifestPath,
            debug,
          ),
        );
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // ── nexus_sync_current_repo ────────────────────────────────
  server.registerTool(
    "nexus_sync_current_repo",
    {
      annotations: { title: "⚡ Sync Current Repo" },
      description:
        "Detect the current repo (via Git), optionally add it to the workspace manifest, then sync/index it into the Knowledge Base. This is the primary way to keep the KB up to date.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe(
            "Path to the repo root or any subdirectory. Defaults to NEXUS_WORKSPACE_ROOT env var, then process.cwd().",
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
        debug: z
          .boolean()
          .optional()
          .describe(
            "When true, includes absolute local paths in the response (for developer debugging only).",
          ),
      },
    },
    async ({
      cwd,
      auto_add_to_workspace = true,
      force_update = false,
      debug = false,
    }) => {
      try {
        const startDir = resolveStartDir(cwd);
        const detected = await RepoDetector.detect(startDir);

        if (!detected) {
          return mcpError(
            "Could not detect a Git repo. Is git installed and is this a git repository?",
          );
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

        return mcpJson(
          syncCurrentRepoView(
            detected.repoId,
            detected.repoRoot,
            detected.branch,
            detected.commit,
            addedToManifest,
            syncResult,
            debug,
          ),
        );
      } catch (err) {
        return mcpError(err);
      }
    },
  );
}
