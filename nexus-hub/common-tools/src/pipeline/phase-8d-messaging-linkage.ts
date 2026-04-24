// ─────────────────────────────────────────────────────────────
// Phase 8d — Extended Messaging Linkage
// Creates ASYNC_TRIGGERS edges for all async messaging patterns
// beyond Kafka:  RabbitMQ, Redis Pub/Sub, AWS SQS, NATS.
//
// Works on shared queue/channel nodes already created by
// phase-2-graph:
//   publisher  ──[:PUBLISHES_TO | SENDS_TO]──> MessageQueue/Channel
//   consumer   ──[:CONSUMES_FROM | SUBSCRIBES_TO | RECEIVES_FROM]──> MessageQueue/Channel
//
// This phase adds:
//   publisher ──[:ASYNC_TRIGGERS {via, mechanism}]──> consumer
//
// Runs at order 7.8 — after kafka-linkage (7.5), http-linkage
// (7.6), grpc-linkage (7.7), before process-tracing (8).
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

// ── Edge-pair definitions per mechanism ──────────────────────

interface MessagingMechanism {
  mechanism: string;
  publishEdge: string;
  consumeEdge: string;
  nodeLabel: string;
}

const MECHANISMS: MessagingMechanism[] = [
  {
    mechanism: "rabbitmq",
    publishEdge: "PUBLISHES_TO",
    consumeEdge: "CONSUMES_FROM",
    nodeLabel: "MessageQueue",
  },
  {
    mechanism: "redis",
    publishEdge: "PUBLISHES_TO",
    consumeEdge: "SUBSCRIBES_TO",
    nodeLabel: "MessageChannel",
  },
  {
    mechanism: "sqs",
    publishEdge: "SENDS_TO",
    consumeEdge: "RECEIVES_FROM",
    nodeLabel: "MessageQueue",
  },
  {
    mechanism: "nats",
    publishEdge: "PUBLISHES_TO",
    consumeEdge: "SUBSCRIBES_TO",
    nodeLabel: "MessageChannel",
  },
];

export const messagingLinkagePhase: PipelinePhase = {
  name: "messaging-linkage",
  order: 7.8,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let totalLinks = 0;

    try {
      // 1. Clean stale ASYNC_TRIGGERS edges added by this phase for current service
      //    (Kafka linkage phase already cleaned its own — we only clean messaging ones)
      await deps.graph.write(
        `MATCH (publisher:Function {service: $service})-[r:ASYNC_TRIGGERS]->()
         WHERE r.mechanism IN ['rabbitmq', 'redis', 'sqs', 'nats']
         DELETE r`,
        { service: ctx.serviceName },
      );

      // 2. For each mechanism, create ASYNC_TRIGGERS through the shared queue/channel node
      for (const m of MECHANISMS) {
        const results = await deps.graph.query(
          `MATCH (publisher:Function)-[:${m.publishEdge}]->(q:${m.nodeLabel} {type: $mechanism})
           MATCH (consumer:Function)-[:${m.consumeEdge}]->(q)
           WHERE publisher <> consumer
           MERGE (publisher)-[r:ASYNC_TRIGGERS]->(consumer)
           SET r.via       = q.name,
               r.mechanism = $mechanism,
               r.updatedAt = timestamp()
           RETURN publisher.name  AS publisherName,
                  publisher.service AS publisherService,
                  consumer.name  AS consumerName,
                  consumer.service AS consumerService,
                  q.name         AS queueName`,
          { mechanism: m.mechanism },
        );
        totalLinks += results.length;
      }

      return {
        phase: "messaging-linkage",
        success: true,
        stats: { asyncTriggersCreated: totalLinks },
        errors,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Messaging linkage failed: ${msg}`);
      return {
        phase: "messaging-linkage",
        success: false,
        stats: { asyncTriggersCreated: 0 },
        errors,
        durationMs: 0,
      };
    }
  },
};
