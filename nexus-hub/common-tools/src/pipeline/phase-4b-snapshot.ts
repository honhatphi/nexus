// ─────────────────────────────────────────────────────────────
// Phase 4b — Graph Snapshot (Phase C1)
// Captures a lightweight fingerprint of the graph state keyed
// by git commit hash. Used by graph-diff.ts to detect arch changes.
// ─────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

export interface GraphSnapshot {
  service: string;
  commit: string;
  takenAt: number;
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, number>;
  apiRoutes: { path: string; method: string }[];
  grpcEndpoints: string[];
  kafkaTopics: string[];
}

function getGitHead(servicePath: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: servicePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export const snapshotPhase: PipelinePhase = {
  name: "snapshot",
  order: 41,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const start = Date.now();
    const commit = getGitHead(ctx.servicePath);

    // Node counts per label
    const nodeLabels = [
      "Function",
      "Class",
      "File",
      "Service",
      "APIRoute",
      "GRPCEndpoint",
      "KafkaTopic",
      "Database",
      "MessageQueue",
      "MessageChannel",
      "DAG",
      "Task",
    ];
    const nodeCounts: Record<string, number> = {};
    for (const label of nodeLabels) {
      const rows = await deps.graph.query(
        `MATCH (n:${label} {service: $service}) RETURN count(n) AS cnt`,
        { service: ctx.serviceName },
      );
      nodeCounts[label] = Number(
        (rows[0]?.cnt as { low?: number })?.low ?? rows[0]?.cnt ?? 0,
      );
    }

    // Edge counts per type
    const edgeTypes = [
      "CALLS",
      "HTTP_TRIGGERS",
      "ASYNC_TRIGGERS",
      "GRPC_TRIGGERS",
      "PRODUCES_TO",
      "CONSUMES_FROM",
      "HTTP_CALL",
      "CONNECTS_TO",
    ];
    const edgeCounts: Record<string, number> = {};
    for (const edgeType of edgeTypes) {
      const rows = await deps.graph.query(
        `MATCH (:Function {service: $service})-[r:${edgeType}]->() RETURN count(r) AS cnt`,
        { service: ctx.serviceName },
      );
      edgeCounts[edgeType] = Number(
        (rows[0]?.cnt as { low?: number })?.low ?? rows[0]?.cnt ?? 0,
      );
    }

    // APIRoute list (for contract drift detection)
    const routeRows = await deps.graph.query(
      `MATCH (r:APIRoute {service: $service}) RETURN r.path AS path, r.method AS method`,
      { service: ctx.serviceName },
    );
    const apiRoutes = routeRows.map((r) => ({
      path: String(r.path ?? ""),
      method: String(r.method ?? "GET"),
    }));

    // gRPC endpoints
    const grpcRows = await deps.graph.query(
      `MATCH (g:GRPCEndpoint) WHERE g.service STARTS WITH $service RETURN g.name AS name`,
      { service: ctx.serviceName },
    );
    const grpcEndpoints = grpcRows.map((r) => String(r.name ?? ""));

    // Kafka topics
    const kafkaRows = await deps.graph.query(
      `MATCH (:Function {service: $service})-[:PRODUCES_TO|CONSUMES_FROM]->(k:KafkaTopic) RETURN DISTINCT k.name AS name`,
      { service: ctx.serviceName },
    );
    const kafkaTopics = kafkaRows.map((r) => String(r.name ?? ""));

    const snapshot: GraphSnapshot = {
      service: ctx.serviceName,
      commit,
      takenAt: Date.now(),
      nodeCounts,
      edgeCounts,
      apiRoutes,
      grpcEndpoints,
      kafkaTopics,
    };

    // Persist snapshot on the Service node as JSON
    await deps.graph.write(
      `MERGE (s:Service {name: $service})
       SET s.lastSnapshot = $snapshot, s.lastSnapshotCommit = $commit`,
      { service: ctx.serviceName, snapshot: JSON.stringify(snapshot), commit },
    );

    return {
      phase: "snapshot",
      success: true,
      durationMs: Date.now() - start,
      stats: {
        apiRouteCount: apiRoutes.length,
        grpcEndpointCount: grpcEndpoints.length,
        kafkaTopicCount: kafkaTopics.length,
      },
      errors: [],
    };
  },
};
