// ─────────────────────────────────────────────────────────────
// Adapter: ExistingPipelineIndexer — implements CodeIndexer port
// using the common-tools PipelineEngine (all 10 phases).
// Delegates to the same pipeline as sync_service_knowledge tool.
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
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
import type {
  GraphClient,
  VectorClient,
  PipelineReport,
} from "@nexus-hub/common-tools";
import type {
  CodeIndexer,
  SyncInput,
  SyncSummary,
} from "../ports/code-indexer.js";
import type { GraphStore } from "../ports/graph-store.js";
import type { VectorStore } from "../ports/vector-store.js";
import { JsonFileHashStore } from "../index-state/json-file-hash-store.js";

export class ExistingPipelineIndexer implements CodeIndexer {
  private readonly parser = new CodeParser();
  private readonly pipeline: PipelineEngine;
  /**
   * workspaceId is used to scope the persistent file-hash index under
   * ~/.nexus/workspaces/<workspaceId>/index-state/<repoId>.files.json
   */
  constructor(
    private readonly graph: GraphStore,
    private readonly vector: VectorStore,
    private readonly workspaceId: string = "default",
  ) {
    this.pipeline = new PipelineEngine();
    this.pipeline
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
      .register(grpcLinkagePhase)
      .register(messagingLinkagePhase)
      .register(processTracingPhase)
      .register(typeResolutionPhase);
  }

  async sync(input: SyncInput): Promise<SyncSummary> {
    const absPath = path.resolve(input.servicePath);

    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${absPath} is not a directory`);
    }

    const ctx = createEmptyContext(
      input.serviceId,
      absPath,
      input.forceUpdate ?? false,
    );

    const graphClient: GraphClient = {
      write: (cypher, params) => this.graph.write(cypher, params ?? {}),
      query: (cypher, params) => this.graph.query(cypher, params ?? {}),
    };

    const vectorClient: VectorClient = {
      upsert: (ids, documents, metadatas) =>
        this.vector.upsert(
          ids,
          documents,
          metadatas as Record<string, unknown>[],
        ),
    };

    const startMs = Date.now();

    // Persistent incremental index (PR 9)
    const hashStore = new JsonFileHashStore(this.workspaceId, input.serviceId);
    await hashStore.load();

    const report: PipelineReport = await this.pipeline.run(ctx, {
      graph: graphClient,
      vectors: vectorClient,
      parser: this.parser,
      hashStore,
    });

    return {
      filesScanned: report.details.filesScanned,
      filesChanged: report.details.filesScanned - report.details.filesSkipped,
      symbolsIndexed: report.details.totalSymbols,
      vectorsUpserted: report.details.totalVectors,
      durationMs: Date.now() - startMs,
    };
  }
}
