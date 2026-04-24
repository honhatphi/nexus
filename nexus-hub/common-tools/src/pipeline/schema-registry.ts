// ─────────────────────────────────────────────────────────────
// Schema Registry — Canonical node type definitions (Phase B5)
// All pipeline phases must comply with these required properties.
// ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = "1.0" as const;

/**
 * Required properties that every node must carry after Phase B.
 * Phase 10 (schema-validate) flags nodes missing any of these.
 */
export interface CanonicalNode {
  schemaVersion: typeof SCHEMA_VERSION;
  service: string;
  firstSeenAt: number; // unix ms — set on CREATE only
  lastSeenAt: number; // unix ms — updated on every sync
  source: CanonicalSource;
}

export type CanonicalSource =
  | "code"
  | "openapi_spec"
  | "docker_compose"
  | "grpc_proto"
  | "yaml_dag"
  | "inferred";

/** Node labels tracked by the canonical schema. */
export const CANONICAL_NODE_LABELS = [
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
] as const;

export type CanonicalNodeLabel = (typeof CANONICAL_NODE_LABELS)[number];

/** Edge types that require confidence + source metadata. */
export const INFERRED_EDGE_TYPES = [
  "CALLS",
  "HTTP_TRIGGERS",
  "ASYNC_TRIGGERS",
  "GRPC_TRIGGERS",
  "INHERITS",
  "EXTENDS",
] as const;

export type InferredEdgeType = (typeof INFERRED_EDGE_TYPES)[number];
