import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CodeParser,
  PipelineEngine,
  createEmptyContext,
  filesystemPhase,
  parsePhase,
  graphUpsertPhase,
  vectorUpsertPhase,
  metadataPhase,
  importResolutionPhase,
  heritagePhase,
  communityPhase,
  kafkaLinkagePhase,
  httpLinkagePhase,
  grpcLinkagePhase,
  messagingLinkagePhase,
  processTracingPhase,
  typeResolutionPhase,
} from "@nexus-hub/common-tools";
import type { GraphClient, VectorClient } from "@nexus-hub/common-tools";
import { MemgraphClient } from "../clients/memgraph.js";
import { ChromaDBClient } from "../clients/chromadb.js";

// ── Adapter: MemgraphClient → GraphClient ────────────────────

function toGraphClient(memgraph: MemgraphClient): GraphClient {
  return {
    write: (cypher, params) => memgraph.write(cypher, params ?? {}),
    query: (cypher, params) => memgraph.query(cypher, params ?? {}),
  };
}

// ── Adapter: ChromaDBClient → VectorClient ───────────────────

function toVectorClient(chromadb: ChromaDBClient): VectorClient {
  return {
    upsert: (ids, documents, metadatas) =>
      chromadb.upsert(ids, documents, metadatas),
  };
}

// ── Background job store ─────────────────────────────────────
// Module-level: persists across HTTP connections.
// (index.ts creates a fresh McpServer per request, but module scope is shared.)
// Exported so workspace.ts (nexus_sync_current_repo) can push jobs here too,
// making nexus_sync_status the single polling endpoint for all sync jobs.

export type SyncJobStatus = "running" | "done" | "error";

export interface SyncJob {
  status: SyncJobStatus;
  service: string;
  path: string;
  startedAt: number;
  completedAt?: number;
  currentPhase?: string;
  phasesCompleted?: number;
  phasesTotal?: number;
  filesTotal?: number;
  filesChanged?: number;
  symbolsIndexed?: number;
  dagVectors?: number;
  durationMs?: number;
  summary?: string;
  errors?: string[];
  error?: string;
}

export const syncJobs = new Map<string, SyncJob>();
export const MAX_STORED_JOBS = 50;

// ── Shared pipeline (stateless after registration) ───────────
// Phases are pure functions; PipelineEngine has no mutable state after
// register(). Creating it once avoids re-registration on each HTTP request.

const _sharedPipeline = (() => {
  const p = new PipelineEngine();
  p.register(filesystemPhase)
    .register(parsePhase)
    .register(graphUpsertPhase)
    .register(vectorUpsertPhase)
    .register(metadataPhase)
    .register(importResolutionPhase)
    .register(heritagePhase)
    .register(communityPhase)
    .register(kafkaLinkagePhase)
    .register(httpLinkagePhase)
    .register(grpcLinkagePhase)
    .register(messagingLinkagePhase)
    .register(processTracingPhase)
    .register(typeResolutionPhase);
  return p;
})();

// ── MCP Tool Registration ────────────────────────────────────

export function registerSyncTool(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
): void {
  // ── Tool: sync_service_knowledge ──────────────────────────
  server.registerTool(
    "sync_service_knowledge",
    {
      annotations: { title: "🔄 Sync Service" },
      description:
        "Scan all source files in a service directory, extract functions/calls/types using tree-sitter, and upsert the knowledge into Memgraph (graph) and ChromaDB (vectors). Returns a job ID immediately — poll nexus_sync_status for results.",
      inputSchema: {
        service_path: z
          .string()
          .describe(
            "Absolute or workspace-relative path to the service folder (e.g. './services/api-gateway').",
          ),
        force_update: z
          .boolean()
          .default(false)
          .describe(
            "If true, re-process all files regardless of whether they changed. If false, skip unchanged files.",
          ),
      },
    },
    async ({ service_path, force_update }) => {
      try {
        const absPath = path.resolve(service_path);
        const serviceName = path.basename(absPath);

        const stat = await fs.stat(absPath).catch(() => null);
        if (!stat || !stat.isDirectory()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `${absPath} is not a directory or does not exist.`,
                }),
              },
            ],
            isError: true,
          };
        }

        const jobId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();

        syncJobs.set(jobId, {
          status: "running",
          service: serviceName,
          path: absPath,
          startedAt,
        });

        // Evict oldest jobs once we exceed the cap
        if (syncJobs.size > MAX_STORED_JOBS) {
          const oldest = Array.from(syncJobs.entries()).sort(
            (a, b) => a[1].startedAt - b[1].startedAt,
          )[0];
          if (oldest) syncJobs.delete(oldest[0]);
        }

        const graphClient = toGraphClient(memgraph);
        const vectorClient = toVectorClient(chromadb);

        // Run pipeline in background — does not block the HTTP response.
        // A fresh CodeParser is created per job to avoid parser state conflicts
        // if two syncs ever run concurrently.
        setImmediate(() => {
          void (async () => {
            try {
              const parser = new CodeParser();
              const ctx = createEmptyContext(
                serviceName,
                absPath,
                force_update,
              );
              const report = await _sharedPipeline.run(
                ctx,
                { graph: graphClient, vectors: vectorClient, parser },
                {
                  onPhaseStart: (name, index, total) => {
                    const job = syncJobs.get(jobId);
                    if (job) {
                      syncJobs.set(jobId, {
                        ...job,
                        currentPhase: name,
                        phasesCompleted: index,
                        phasesTotal: total,
                      });
                    }
                  },
                },
              );

              syncJobs.set(jobId, {
                status: "done",
                service: serviceName,
                path: absPath,
                startedAt,
                completedAt: Date.now(),
                currentPhase: undefined,
                phasesCompleted: report.phases?.length,
                phasesTotal: report.phases?.length,
                filesTotal:
                  (report.details?.filesScanned ?? 0) +
                  (report.details?.filesSkipped ?? 0),
                filesChanged: report.details?.filesScanned,
                symbolsIndexed: report.details?.totalSymbols,
                dagVectors: report.details?.totalDagVectors,
                durationMs: report.details?.durationMs,
                summary: report.summary,
                errors: report.errors?.length ? report.errors : undefined,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(
                `[sync_service_knowledge] Job ${jobId} failed:`,
                message,
              );
              syncJobs.set(jobId, {
                ...syncJobs.get(jobId)!,
                status: "error",
                completedAt: Date.now(),
                error: message,
              });
            }
          })();
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                jobId,
                status: "running",
                service: serviceName,
                message:
                  "Sync started in background. Poll with nexus_sync_status to check results.",
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[sync_service_knowledge] Error:", message);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Tool: nexus_sync_status ────────────────────────────────
  server.registerTool(
    "nexus_sync_status",
    {
      annotations: { title: "📡 Sync Status" },
      description:
        "Check the status of a background sync job started by sync_service_knowledge. Omit job_id to list the 10 most recent jobs.",
      inputSchema: {
        job_id: z
          .string()
          .optional()
          .describe(
            "Job ID returned by sync_service_knowledge. Omit to list recent jobs.",
          ),
      },
    },
    async ({ job_id }) => {
      if (job_id) {
        const job = syncJobs.get(job_id);
        if (!job) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Job "${job_id}" not found. It may have been evicted (max ${MAX_STORED_JOBS} jobs) or the server restarted.`,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ jobId: job_id, ...job }, null, 2),
            },
          ],
        };
      }

      // No job_id — list 10 most recent jobs
      const recent = Array.from(syncJobs.entries())
        .map(([id, job]) => ({ jobId: id, ...job }))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 10);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { count: recent.length, jobs: recent },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
