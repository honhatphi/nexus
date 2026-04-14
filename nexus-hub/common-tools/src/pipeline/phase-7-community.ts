// ─────────────────────────────────────────────────────────────
// Phase 7 — Community Detection (Louvain Algorithm)
// Exports CALLS graph from Memgraph into an in-memory graphology
// graph, runs Louvain community detection, and upserts
// Community nodes + MEMBER_OF edges back into the graph.
// ─────────────────────────────────────────────────────────────

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

// ── Phase Definition ─────────────────────────────────────────

export const communityPhase: PipelinePhase = {
  name: "community-detection",
  order: 7,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    // 1. Export CALLS edges for this service from graph
    const edges = await deps.graph.query(
      `MATCH (a:Function {service: $service})-[r:CALLS]->(b:Function {service: $service})
       RETURN a.name + '::' + a.file AS source,
              b.name + '::' + b.file AS target,
              coalesce(r.confidence, 0.7) AS weight`,
      { service: ctx.serviceName },
    );

    // Not enough edges for meaningful clustering
    if (edges.length < 5) {
      return {
        phase: "community-detection",
        success: true,
        stats: { skipped: 1, reason_too_few_edges: edges.length },
        errors: [],
        durationMs: 0,
      };
    }

    // 2. Build in-memory undirected graph
    const graph = new Graph({ type: "undirected" });

    for (const edge of edges) {
      const src = edge.source as string;
      const tgt = edge.target as string;
      const weight = edge.weight as number;

      if (!graph.hasNode(src)) graph.addNode(src);
      if (!graph.hasNode(tgt)) graph.addNode(tgt);
      if (!graph.hasEdge(src, tgt)) {
        graph.addEdge(src, tgt, { weight });
      }
    }

    // 3. Run Louvain community detection
    let assignments: Record<string, number>;
    try {
      assignments = louvain(graph, { resolution: 1.0 });
    } catch (err) {
      errors.push(
        `Louvain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        phase: "community-detection",
        success: false,
        stats: { nodesInGraph: graph.order, edgesInGraph: graph.size },
        errors,
        durationMs: 0,
      };
    }

    // 4. Group by community
    const communities = new Map<number, string[]>();
    for (const [nodeId, communityId] of Object.entries(assignments)) {
      const list = communities.get(communityId) ?? [];
      list.push(nodeId);
      communities.set(communityId, list);
    }

    // 5. Clear old community data for this service
    try {
      await deps.graph.write(
        `MATCH (c:Community {service: $service})
         DETACH DELETE c`,
        { service: ctx.serviceName },
      );
    } catch {
      // If no existing communities, ignore
    }

    // 6. Upsert Community nodes + MEMBER_OF edges
    let nodesCreated = 0;
    let edgesCreated = 0;

    for (const [commId, members] of communities) {
      const communityName = `${ctx.serviceName}::community-${commId}`;

      try {
        await deps.graph.write(
          `MERGE (c:Community {name: $name, service: $service})
           SET c.memberCount = $count, c.updatedAt = timestamp()`,
          {
            name: communityName,
            service: ctx.serviceName,
            count: members.length,
          },
        );
        nodesCreated++;

        for (const memberId of members) {
          const sepIdx = memberId.indexOf("::");
          if (sepIdx === -1) continue;
          const funcName = memberId.slice(0, sepIdx);
          const funcFile = memberId.slice(sepIdx + 2);

          await deps.graph.write(
            `MATCH (f:Function {name: $funcName, file: $funcFile, service: $service})
             MATCH (c:Community {name: $communityName, service: $service})
             MERGE (f)-[:MEMBER_OF]->(c)`,
            {
              funcName,
              funcFile,
              service: ctx.serviceName,
              communityName,
            },
          );
          edgesCreated++;
        }
      } catch (err) {
        errors.push(
          `Community ${commId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 7. Store in context
    ctx.communities = [...communities.entries()].map(([id, members]) => ({
      id,
      name: `${ctx.serviceName}::community-${id}`,
      members,
    }));

    return {
      phase: "community-detection",
      success: true,
      stats: {
        nodesInGraph: graph.order,
        edgesInGraph: graph.size,
        communitiesDetected: communities.size,
        communityNodesCreated: nodesCreated,
        memberOfEdgesCreated: edgesCreated,
      },
      errors,
      durationMs: 0,
    };
  },
};
