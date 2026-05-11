// ─────────────────────────────────────────────────────────────
// Candidate Pattern (Phase D2)
// When an InfraKind cannot be resolved, this module records a
// CandidatePattern node in the graph for human review.
// ─────────────────────────────────────────────────────────────

import type { GraphClient } from "./types.js";
import { SCHEMA_VERSION } from "./schema-registry.js";

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface CandidatePattern {
  id: string;
  service: string;
  file: string;
  line: number;
  pattern: string;
  rawCode: string;
  confidence: number;
  status: CandidateStatus;
  detectedAt: number;
}

/**
 * Record an unresolved infrastructure pattern as a CandidatePattern node.
 * Called by the parse phase when an InfraKind token is encountered but
 * doesn't map to any known InfraKind enum value.
 *
 * Safe to call multiple times — idempotent on (service, file, pattern).
 */
export async function recordCandidatePattern(
  graph: GraphClient,
  candidate: Omit<CandidatePattern, "id" | "detectedAt">,
): Promise<void> {
  const id = `${candidate.service}::${candidate.file}::${candidate.pattern}`;
  const detectedAt = Date.now();

  await graph.write(
    `MERGE (cp:CandidatePattern {id: $id})
     ON CREATE SET
       cp.service     = $service,
       cp.file        = $file,
       cp.line        = $line,
       cp.pattern     = $pattern,
       cp.rawCode     = $rawCode,
       cp.confidence  = $confidence,
       cp.status      = 'pending',
       cp.detectedAt  = $detectedAt,
       cp.schemaVersion = $sv
     SET cp.lastSeenAt = timestamp()`,
    { id, detectedAt, sv: SCHEMA_VERSION, ...candidate },
  );

  console.warn(
    `[candidate-pattern] Unknown pattern "${candidate.pattern}" in ${candidate.file}:${candidate.line} ` +
      `— recorded CandidatePattern(status=pending). Review via augment.promoteCandidate.`,
  );
}

/**
 * Promote a pending CandidatePattern to an approved InfraKind.
 * Called by the augment tool's promoteCandidate action.
 */
export async function promoteCandidate(
  graph: GraphClient,
  id: string,
  approvedAs: string,
): Promise<{ found: boolean }> {
  const rows = await graph.write(
    `MATCH (cp:CandidatePattern {id: $id})
     SET cp.status = 'approved', cp.approvedAs = $approvedAs, cp.approvedAt = timestamp()
     RETURN cp.id AS id`,
    { id, approvedAs },
  );
  return { found: rows.length > 0 };
}

/**
 * Reject a pending CandidatePattern.
 */
export async function rejectCandidate(
  graph: GraphClient,
  id: string,
  reason: string,
): Promise<{ found: boolean }> {
  const rows = await graph.write(
    `MATCH (cp:CandidatePattern {id: $id})
     SET cp.status = 'rejected', cp.rejectionReason = $reason, cp.rejectedAt = timestamp()
     RETURN cp.id AS id`,
    { id, reason },
  );
  return { found: rows.length > 0 };
}
