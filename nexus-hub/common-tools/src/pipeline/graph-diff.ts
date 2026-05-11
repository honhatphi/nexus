// ─────────────────────────────────────────────────────────────
// Graph Diff Engine (Phase C2)
// Computes semantic diff between two GraphSnapshot objects and
// identifies contract drift + blast-radius changes.
// ─────────────────────────────────────────────────────────────

import type { GraphSnapshot } from "./phase-4b-snapshot.js";

// ── Types ────────────────────────────────────────────────────

export interface ContractDriftItem {
  type: "APIRoute" | "GRPCEndpoint" | "KafkaTopic";
  name: string;
  change: "added" | "removed" | "method_changed";
  detail?: string;
}

export interface GraphDiff {
  service: string;
  fromCommit: string;
  toCommit: string;
  fromTime: number;
  toTime: number;
  addedNodes: { label: string; delta: number }[];
  removedNodes: { label: string; delta: number }[];
  addedEdges: { type: string; delta: number }[];
  removedEdges: { type: string; delta: number }[];
  contractDrift: ContractDriftItem[];
  summary: string;
}

// ── Diff Logic ───────────────────────────────────────────────

export function diffSnapshots(
  from: GraphSnapshot,
  to: GraphSnapshot,
): GraphDiff {
  const addedNodes: { label: string; delta: number }[] = [];
  const removedNodes: { label: string; delta: number }[] = [];
  const addedEdges: { type: string; delta: number }[] = [];
  const removedEdges: { type: string; delta: number }[] = [];
  const contractDrift: ContractDriftItem[] = [];

  // Node deltas
  const allLabels = new Set([
    ...Object.keys(from.nodeCounts),
    ...Object.keys(to.nodeCounts),
  ]);
  for (const label of allLabels) {
    const before = from.nodeCounts[label] ?? 0;
    const after = to.nodeCounts[label] ?? 0;
    const delta = after - before;
    if (delta > 0) addedNodes.push({ label, delta });
    if (delta < 0) removedNodes.push({ label, delta });
  }

  // Edge deltas
  const allEdgeTypes = new Set([
    ...Object.keys(from.edgeCounts),
    ...Object.keys(to.edgeCounts),
  ]);
  for (const type of allEdgeTypes) {
    const before = from.edgeCounts[type] ?? 0;
    const after = to.edgeCounts[type] ?? 0;
    const delta = after - before;
    if (delta > 0) addedEdges.push({ type, delta });
    if (delta < 0) removedEdges.push({ type, delta });
  }

  // APIRoute contract drift
  const fromRoutes = new Map(
    from.apiRoutes.map((r) => [`${r.method}:${r.path}`, r]),
  );
  const toRoutes = new Map(
    to.apiRoutes.map((r) => [`${r.method}:${r.path}`, r]),
  );

  for (const [key, route] of fromRoutes) {
    if (!toRoutes.has(key)) {
      // Check if same path exists with different method
      const samePathDiffMethod = to.apiRoutes.find(
        (r) => r.path === route.path && r.method !== route.method,
      );
      contractDrift.push({
        type: "APIRoute",
        name: `${route.method} ${route.path}`,
        change: samePathDiffMethod ? "method_changed" : "removed",
        detail: samePathDiffMethod
          ? `method changed from ${route.method} to ${samePathDiffMethod.method}`
          : undefined,
      });
    }
  }
  for (const [key, route] of toRoutes) {
    if (!fromRoutes.has(key)) {
      // Only flag as added if no method_changed already covers this path
      const alreadyCovered = contractDrift.some(
        (d) => d.change === "method_changed" && d.name.endsWith(route.path),
      );
      if (!alreadyCovered) {
        contractDrift.push({
          type: "APIRoute",
          name: `${route.method} ${route.path}`,
          change: "added",
        });
      }
    }
  }

  // gRPC endpoint drift
  const fromGrpc = new Set(from.grpcEndpoints);
  const toGrpc = new Set(to.grpcEndpoints);
  for (const ep of fromGrpc) {
    if (!toGrpc.has(ep)) {
      contractDrift.push({ type: "GRPCEndpoint", name: ep, change: "removed" });
    }
  }
  for (const ep of toGrpc) {
    if (!fromGrpc.has(ep)) {
      contractDrift.push({ type: "GRPCEndpoint", name: ep, change: "added" });
    }
  }

  // Kafka topic drift
  const fromKafka = new Set(from.kafkaTopics);
  const toKafka = new Set(to.kafkaTopics);
  for (const topic of fromKafka) {
    if (!toKafka.has(topic)) {
      contractDrift.push({
        type: "KafkaTopic",
        name: topic,
        change: "removed",
      });
    }
  }
  for (const topic of toKafka) {
    if (!fromKafka.has(topic)) {
      contractDrift.push({ type: "KafkaTopic", name: topic, change: "added" });
    }
  }

  // Summary
  const removedContracts = contractDrift.filter(
    (d) => d.change === "removed" || d.change === "method_changed",
  ).length;
  const summary =
    removedContracts > 0
      ? `⚠️  ${removedContracts} breaking contract change(s) detected`
      : contractDrift.length > 0
        ? `ℹ️  ${contractDrift.length} contract change(s) (additions only)`
        : "✅ No contract drift";

  return {
    service: to.service,
    fromCommit: from.commit,
    toCommit: to.commit,
    fromTime: from.takenAt,
    toTime: to.takenAt,
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
    contractDrift,
    summary,
  };
}
