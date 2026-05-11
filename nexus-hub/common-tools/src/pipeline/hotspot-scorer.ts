// ─────────────────────────────────────────────────────────────
// Hotspot Scorer (Phase C3)
// Scores functions by risk/priority using:
//   HotspotScore = 0.3×Churn + 0.3×BlastRadius + 0.25×FanIn + 0.15×InfraConnections
// ─────────────────────────────────────────────────────────────

import type { GraphClient } from "./types.js";

// ── Types ────────────────────────────────────────────────────

export interface HotspotEntry {
  name: string;
  file: string;
  service: string;
  score: number;
  reasons: string[];
  blastRadius: number;
  fanIn: number;
  infraConnections: number;
  churn: number;
}

// ── Scorer ───────────────────────────────────────────────────

export async function scoreHotspots(
  graph: GraphClient,
  service: string,
  topK = 10,
): Promise<HotspotEntry[]> {
  // Fan-in: number of callers (how often this function is called)
  const fanInRows = await graph.query(
    `MATCH (caller:Function)-[:CALLS]->(f:Function {service: $service})
     RETURN f.name AS name, f.file AS file, f.service AS service,
            count(DISTINCT caller) AS fanIn
     ORDER BY fanIn DESC
     LIMIT 50`,
    { service },
  );

  // Blast radius proxy: how many functions does this one transitively call
  // (approximated as direct out-degree for performance)
  const blastRows = await graph.query(
    `MATCH (f:Function {service: $service})-[:CALLS]->(callee:Function)
     RETURN f.name AS name, f.file AS file, f.service AS service,
            count(DISTINCT callee) AS blastRadius
     ORDER BY blastRadius DESC
     LIMIT 50`,
    { service },
  );

  // Infra connections: functions that touch DB/Kafka/HTTP/gRPC
  const infraRows = await graph.query(
    `MATCH (f:Function {service: $service})-[r]->(t)
     WHERE t:Database OR t:KafkaTopic OR t:HTTPEndpoint OR t:APIRoute OR t:GRPCEndpoint
           OR t:MessageQueue OR t:MessageChannel
     RETURN f.name AS name, f.file AS file, f.service AS service,
            count(r) AS infraConnections
     ORDER BY infraConnections DESC
     LIMIT 50`,
    { service },
  );

  // Merge all candidates into a map
  const candidates = new Map<
    string,
    {
      name: string;
      file: string;
      service: string;
      fanIn: number;
      blastRadius: number;
      infraConnections: number;
    }
  >();

  for (const row of fanInRows) {
    const key = `${row.name}::${row.file}`;
    const existing = candidates.get(key) ?? {
      name: String(row.name ?? ""),
      file: String(row.file ?? ""),
      service: String(row.service ?? service),
      fanIn: 0,
      blastRadius: 0,
      infraConnections: 0,
    };
    existing.fanIn = Number(
      (row.fanIn as { low?: number })?.low ?? row.fanIn ?? 0,
    );
    candidates.set(key, existing);
  }
  for (const row of blastRows) {
    const key = `${row.name}::${row.file}`;
    const existing = candidates.get(key) ?? {
      name: String(row.name ?? ""),
      file: String(row.file ?? ""),
      service: String(row.service ?? service),
      fanIn: 0,
      blastRadius: 0,
      infraConnections: 0,
    };
    existing.blastRadius = Number(
      (row.blastRadius as { low?: number })?.low ?? row.blastRadius ?? 0,
    );
    candidates.set(key, existing);
  }
  for (const row of infraRows) {
    const key = `${row.name}::${row.file}`;
    const existing = candidates.get(key) ?? {
      name: String(row.name ?? ""),
      file: String(row.file ?? ""),
      service: String(row.service ?? service),
      fanIn: 0,
      blastRadius: 0,
      infraConnections: 0,
    };
    existing.infraConnections = Number(
      (row.infraConnections as { low?: number })?.low ??
        row.infraConnections ??
        0,
    );
    candidates.set(key, existing);
  }

  // Normalize each metric to [0,1] range
  const all = Array.from(candidates.values());
  const maxFanIn = Math.max(...all.map((c) => c.fanIn), 1);
  const maxBlast = Math.max(...all.map((c) => c.blastRadius), 1);
  const maxInfra = Math.max(...all.map((c) => c.infraConnections), 1);

  const scored: HotspotEntry[] = all.map((c) => {
    const normFanIn = c.fanIn / maxFanIn;
    const normBlast = c.blastRadius / maxBlast;
    const normInfra = c.infraConnections / maxInfra;
    // Churn = 0 until Phase C has git churn data; use fanIn as proxy for now
    const churn = normFanIn;

    const score = parseFloat(
      (
        0.3 * churn +
        0.3 * normBlast +
        0.25 * normFanIn +
        0.15 * normInfra
      ).toFixed(3),
    );

    const reasons: string[] = [];
    if (c.fanIn > maxFanIn * 0.6)
      reasons.push(`high fan-in (${c.fanIn} callers)`);
    if (c.blastRadius > maxBlast * 0.6)
      reasons.push(`large blast radius (${c.blastRadius} callees)`);
    if (c.infraConnections > 0)
      reasons.push(`infra connections (${c.infraConnections})`);

    return {
      ...c,
      score,
      reasons,
      churn: parseFloat(churn.toFixed(3)),
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
