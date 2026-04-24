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

// ── MCP Tool Registration ────────────────────────────────────

export function registerSyncTool(
  server: McpServer,
  memgraph: MemgraphClient,
  chromadb: ChromaDBClient,
): void {
  // Shared parser & pipeline instances
  const parser = new CodeParser();
  const pipeline = new PipelineEngine();
  pipeline
    .register(filesystemPhase)
    .register(parsePhase)
    .register(graphUpsertPhase)
    .register(vectorUpsertPhase)
    .register(metadataPhase)
    .register(importResolutionPhase)
    .register(heritagePhase)
    .register(communityPhase)
    .register(kafkaLinkagePhase)
    .register(httpLinkagePhase)
    .register(processTracingPhase)
    .register(typeResolutionPhase);

  server.tool(
    "sync_service_knowledge",
    "Scan all source files in a service directory, extract functions/calls/types using tree-sitter, and upsert the knowledge into the shared Memgraph graph and ChromaDB vector store. Returns a summary report with per-phase details.",
    {
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
    async ({ service_path, force_update }) => {
      try {
        const absPath = path.resolve(service_path);
        const serviceName = path.basename(absPath);

        // Validate directory exists
        const stat = await fs.stat(absPath);
        if (!stat.isDirectory()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `${absPath} is not a directory.`,
                }),
              },
            ],
            isError: true,
          };
        }

        // Run the pipeline
        const ctx = createEmptyContext(serviceName, absPath, force_update);
        const report = await pipeline.run(ctx, {
          graph: toGraphClient(memgraph),
          vectors: toVectorClient(chromadb),
          parser,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error("[sync_service_knowledge] Error:", message, stack);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, stack }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
