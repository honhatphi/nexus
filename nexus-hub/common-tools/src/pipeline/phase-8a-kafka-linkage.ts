// ─────────────────────────────────────────────────────────────
// Phase 8a — Kafka Linkage
// Creates ASYNC_TRIGGERS edges between functions that produce
// to a Kafka topic and functions that consume from the same
// topic.  This bridges the gap that CALLS-only traversal
// cannot cross, enabling end-to-end process tracing through
// asynchronous Kafka-mediated flows.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

export const kafkaLinkagePhase: PipelinePhase = {
  name: "kafka-linkage",
  // Run after graph upsert (2) but before process tracing (8)
  order: 7.5,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    try {
      // 1. Clean stale ASYNC_TRIGGERS edges for this service
      await deps.graph.write(
        `MATCH (producer:Function {service: $service})-[r:ASYNC_TRIGGERS]->()
         DELETE r`,
        { service: ctx.serviceName },
      );

      // 2. Create ASYNC_TRIGGERS edges:
      //    producer ──[:PRODUCES_TO]──> KafkaTopic <──[:CONSUMES_FROM]── consumer
      //    ⇒ producer ──[:ASYNC_TRIGGERS {via, mechanism}]──> consumer
      const results = await deps.graph.query(
        `MATCH (producer:Function)-[:PRODUCES_TO]->(topic:KafkaTopic)<-[:CONSUMES_FROM]-(consumer:Function)
         WHERE producer <> consumer
         MERGE (producer)-[r:ASYNC_TRIGGERS]->(consumer)
         SET r.via       = topic.name,
             r.mechanism = 'kafka',
             r.updatedAt = timestamp()
         RETURN producer.name  AS producerName,
                producer.file  AS producerFile,
                consumer.name  AS consumerName,
                consumer.file  AS consumerFile,
                topic.name     AS topicName`,
        {},
      );

      const linksCreated = results.length;

      return {
        phase: "kafka-linkage",
        success: true,
        stats: { asyncTriggersCreated: linksCreated },
        errors,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Kafka linkage failed: ${msg}`);
      return {
        phase: "kafka-linkage",
        success: false,
        stats: { asyncTriggersCreated: 0 },
        errors,
        durationMs: 0,
      };
    }
  },
};
