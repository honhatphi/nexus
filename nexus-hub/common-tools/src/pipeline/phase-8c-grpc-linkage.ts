// ─────────────────────────────────────────────────────────────
// Phase 8c — gRPC Linkage
// Creates GRPC_TRIGGERS edges between functions that call a
// gRPC method (grpc_call) and functions that serve/implement
// that method (grpc_serve).
//
// Matching strategy:
//   1. Exact service+method name match (from GrpcMethod metadata)
//   2. Service name match only (lower specificity)
//
// Edge: caller ──[:GRPC_TRIGGERS {via, mechanism: 'grpc'}]──> handler
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

export const grpcLinkagePhase: PipelinePhase = {
  name: "grpc-linkage",
  // After http-linkage (7.6), before process-tracing (8)
  order: 7.7,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    try {
      // 1. Clean stale GRPC_TRIGGERS edges for this service
      await deps.graph.write(
        `MATCH (caller:Function {service: $service})-[r:GRPC_TRIGGERS]->()
         DELETE r`,
        { service: ctx.serviceName },
      );

      // 2. Create GRPC_TRIGGERS edges via shared GRPCEndpoint node:
      //    caller ──[:GRPC_CALL]──> GRPCEndpoint <──[:GRPC_HANDLES]── handler
      //    ⇒ caller ──[:GRPC_TRIGGERS {via, mechanism: 'grpc'}]──> handler
      const results = await deps.graph.query(
        `MATCH (caller:Function)-[:GRPC_CALL]->(ep:GRPCEndpoint)<-[:GRPC_HANDLES]-(handler:Function)
         WHERE caller.service <> handler.service
           AND caller <> handler
         MERGE (caller)-[r:GRPC_TRIGGERS]->(handler)
         SET r.via       = ep.name,
             r.service   = ep.service,
             r.mechanism = 'grpc',
             r.updatedAt = timestamp()
         RETURN caller.name  AS callerName,
                caller.service AS callerService,
                handler.name AS handlerName,
                handler.service AS handlerService,
                ep.name AS endpointName`,
        {},
      );

      // 3. Also link same-service callers to handlers (intra-service gRPC)
      const intraResults = await deps.graph.query(
        `MATCH (caller:Function {service: $service})-[:GRPC_CALL]->(ep:GRPCEndpoint)<-[:GRPC_HANDLES]-(handler:Function)
         WHERE caller <> handler
         MERGE (caller)-[r:GRPC_TRIGGERS]->(handler)
         SET r.via       = ep.name,
             r.service   = ep.service,
             r.mechanism = 'grpc',
             r.updatedAt = timestamp()
         RETURN caller.name AS callerName, handler.name AS handlerName`,
        { service: ctx.serviceName },
      );

      const linksCreated = results.length + intraResults.length;

      return {
        phase: "grpc-linkage",
        success: true,
        stats: { grpcTriggersCreated: linksCreated },
        errors,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`gRPC linkage failed: ${msg}`);
      return {
        phase: "grpc-linkage",
        success: false,
        stats: { grpcTriggersCreated: 0 },
        errors,
        durationMs: 0,
      };
    }
  },
};
