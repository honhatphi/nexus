// ─────────────────────────────────────────────────────────────
// sync_service_knowledge — Thin wrapper around PipelineEngine.
// Maintains backward-compatible API while delegating to the
// multi-phase pipeline architecture.
//
// Usage:
//   const tool = new SyncServiceKnowledge({ memgraph: { uri }, chromadb: { url } });
//   const report = await tool.run("/abs/path/to/services/api-gateway");
//   await tool.close();
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { ChromaClient, type Collection, type Metadata } from "chromadb";

import { CodeParser } from "./universal-parser.js";
import { PipelineEngine } from "./pipeline/index.js";
import { createEmptyContext } from "./pipeline/types.js";
import type {
  PipelineReport,
  GraphClient,
  VectorClient,
} from "./pipeline/types.js";
import { filesystemPhase } from "./pipeline/phase-0-filesystem.js";
import { parsePhase } from "./pipeline/phase-1-parse.js";
import { graphUpsertPhase } from "./pipeline/phase-2-graph.js";
import { vectorUpsertPhase } from "./pipeline/phase-3-vectors.js";
import { metadataPhase } from "./pipeline/phase-4-metadata.js";
import { snapshotPhase } from "./pipeline/phase-4b-snapshot.js";
import { importResolutionPhase } from "./pipeline/phase-5-imports.js";
import { heritagePhase } from "./pipeline/phase-6-heritage.js";
import { communityPhase } from "./pipeline/phase-7-community.js";
import { kafkaLinkagePhase } from "./pipeline/phase-8a-kafka-linkage.js";
import { httpLinkagePhase } from "./pipeline/phase-8b-http-linkage.js";
import { grpcLinkagePhase } from "./pipeline/phase-8c-grpc-linkage.js";
import { messagingLinkagePhase } from "./pipeline/phase-8d-messaging-linkage.js";
import { processTracingPhase } from "./pipeline/phase-8-process.js";
import { typeResolutionPhase } from "./pipeline/phase-9-types.js";
import { schemaValidationPhase } from "./pipeline/phase-10-schema-validate.js";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface SyncToolConfig {
  memgraph: {
    uri: string;
    user?: string;
    password?: string;
  };
  chromadb: {
    url: string;
    collection?: string;
    token?: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Result Types (backward-compatible)
// ─────────────────────────────────────────────────────────────

export interface SyncReport {
  service: string;
  path: string;
  success: boolean;
  summary: string;
  details: {
    filesScanned: number;
    filesSkipped: number;
    totalSymbols: number;
    totalRelationships: number;
    totalVectors: number;
    languages: string[];
  };
  errors: string[];
  /** Extended pipeline report (new in v1.0). */
  pipelineReport?: PipelineReport;
}

// ─────────────────────────────────────────────────────────────
// SyncServiceKnowledge — Pipeline-backed
// ─────────────────────────────────────────────────────────────

export class SyncServiceKnowledge {
  private driver: Driver;
  private chromaClient: ChromaClient;
  private collectionName: string;
  private collection: Collection | null = null;
  private parser: CodeParser;
  private pipeline: PipelineEngine;

  constructor(config: SyncToolConfig) {
    // ── Memgraph ──
    this.driver = neo4j.driver(
      config.memgraph.uri,
      config.memgraph.user && config.memgraph.password
        ? neo4j.auth.basic(config.memgraph.user, config.memgraph.password)
        : undefined,
    );

    // ── ChromaDB ──
    // Use `path` constructor (chromadb 3.x) — `ssl/host/port` is deprecated
    // and routes to a different base URL causing 404s with server 1.4.x
    this.chromaClient = new ChromaClient({
      path: config.chromadb.url,
      ...(config.chromadb.token
        ? { auth: { provider: "token", credentials: config.chromadb.token } }
        : {}),
    } as ConstructorParameters<typeof ChromaClient>[0]);
    this.collectionName = config.chromadb.collection ?? "nexus_code";

    // ── Parser ──
    this.parser = new CodeParser();

    // ── Pipeline ──
    this.pipeline = new PipelineEngine();
    this.pipeline
      .register(filesystemPhase)
      .register(parsePhase)
      .register(graphUpsertPhase)
      .register(vectorUpsertPhase)
      .register(metadataPhase)
      .register(snapshotPhase)
      .register(importResolutionPhase)
      .register(heritagePhase)
      .register(communityPhase)
      .register(kafkaLinkagePhase)
      .register(httpLinkagePhase)
      .register(grpcLinkagePhase)
      .register(messagingLinkagePhase)
      .register(processTracingPhase)
      .register(typeResolutionPhase)
      .register(schemaValidationPhase);
  }

  // ── Public API ───────────────────────────────────────────

  async run(servicePath: string, forceUpdate = false): Promise<SyncReport> {
    const absPath = path.resolve(servicePath);
    const serviceName = path.basename(absPath);

    // Validate path
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isDirectory()) {
        return this.errorReport(
          serviceName,
          absPath,
          `${absPath} is not a directory.`,
        );
      }
    } catch {
      return this.errorReport(
        serviceName,
        absPath,
        `${absPath} does not exist.`,
      );
    }

    // ── preSync health check (A2) ─────────────────────────
    const healthError = await this.preSync(serviceName, absPath);
    if (healthError) return healthError;

    // Build pipeline dependencies
    const graphClient = this.createGraphClient();
    const vectorClient = await this.createVectorClient();

    const ctx = createEmptyContext(serviceName, absPath, forceUpdate);

    const pipelineReport = await this.pipeline.run(ctx, {
      graph: graphClient,
      vectors: vectorClient,
      parser: this.parser,
    });

    // Map to backward-compatible SyncReport
    return {
      service: pipelineReport.service,
      path: pipelineReport.path,
      success: pipelineReport.errors.length === 0,
      summary: pipelineReport.summary,
      details: {
        filesScanned: pipelineReport.details.filesScanned,
        filesSkipped: pipelineReport.details.filesSkipped,
        totalSymbols: pipelineReport.details.totalSymbols,
        totalRelationships: pipelineReport.details.totalRelationships,
        totalVectors: pipelineReport.details.totalVectors,
        languages: pipelineReport.details.languages,
      },
      errors: pipelineReport.errors,
      pipelineReport,
    };
  }
  async close(): Promise<void> {
    await this.driver.close();
  }

  // ── Private Helpers ──────────────────────────────────────

  private createGraphClient(): GraphClient {
    const driver = this.driver;
    return {
      async write(cypher: string, params: Record<string, unknown> = {}) {
        const session: Session = driver.session({
          defaultAccessMode: neo4j.session.WRITE,
        });
        try {
          const result = await session.run(cypher, params);
          return result.records.map(
            (r) => r.toObject() as Record<string, unknown>,
          );
        } finally {
          await session.close();
        }
      },
      async query(cypher: string, params: Record<string, unknown> = {}) {
        const session: Session = driver.session({
          defaultAccessMode: neo4j.session.READ,
        });
        try {
          const result = await session.run(cypher, params);
          return result.records.map(
            (r) => r.toObject() as Record<string, unknown>,
          );
        } finally {
          await session.close();
        }
      },
    };
  }

  private async createVectorClient(): Promise<VectorClient> {
    if (!this.collection) {
      this.collection = await this.chromaClient.getOrCreateCollection({
        name: this.collectionName,
      });
    }
    const collection = this.collection;
    return {
      async upsert(ids, documents, metadatas) {
        await collection.upsert({ ids, documents, metadatas });
      },
    };
  }

  private errorReport(
    service: string,
    absPath: string,
    msg: string,
  ): SyncReport {
    return {
      service,
      path: absPath,
      success: false,
      summary: msg,
      details: {
        filesScanned: 0,
        filesSkipped: 0,
        totalSymbols: 0,
        totalRelationships: 0,
        totalVectors: 0,
        languages: [],
      },
      errors: [msg],
    };
  }

  /**
   * A2 — preSync health check.
   * Verifies Memgraph and ChromaDB are reachable before starting the pipeline.
   * Returns a SyncReport error if any dependency is down; null if all healthy.
   */
  private async preSync(
    serviceName: string,
    absPath: string,
  ): Promise<SyncReport | null> {
    // Check Memgraph
    try {
      const session = this.driver.session({ defaultAccessMode: "READ" });
      await session.run("RETURN 1");
      await session.close();
    } catch (err) {
      return this.errorReport(
        serviceName,
        absPath,
        `preSync: Memgraph unreachable — ${String(err)}`,
      );
    }

    // Check ChromaDB — getOrCreateCollection as a lightweight ping
    try {
      await this.chromaClient.getOrCreateCollection({
        name: this.collectionName,
      });
    } catch (err) {
      return this.errorReport(
        serviceName,
        absPath,
        `preSync: ChromaDB unreachable — ${String(err)}`,
      );
    }

    return null;
  }
}
