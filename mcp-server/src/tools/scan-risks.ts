// ─────────────────────────────────────────────────────────────
// scan_risks — On-demand risk assessment MCP tool (Phase E1)
// Reads directly from Memgraph + ChromaDB — no re-sync needed.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemgraphClient } from "../clients/memgraph.js";
import { scoreHotspots } from "@nexus-hub/common-tools";

// ── Types ────────────────────────────────────────────────────

type RiskType = "security" | "performance" | "stability" | "upgrade";
type Severity = "low" | "medium" | "high" | "critical";

interface RiskItem {
  id: string;
  type: RiskType;
  severity: Severity;
  score: number;
  title: string;
  description: string;
  affectedSymbols: string[];
  recommendedAction: string;
}

// ── Risk Checkers ────────────────────────────────────────────

async function checkSecurityRisks(
  memgraph: MemgraphClient,
  service: string,
): Promise<RiskItem[]> {
  const risks: RiskItem[] = [];

  // Unprotected APIRoutes (no auth-related calls in the handler function)
  const unprotectedRoutes = await memgraph.query(
    `MATCH (f:Function {service: $service})-[:EXPOSES]->(r:APIRoute)
     OPTIONAL MATCH (f)-[:CALLS]->(auth:Function)
       WHERE toLower(auth.name) CONTAINS 'auth'
          OR toLower(auth.name) CONTAINS 'jwt'
          OR toLower(auth.name) CONTAINS 'permission'
          OR toLower(auth.name) CONTAINS 'middleware'
     WITH f, r, auth
     WHERE auth IS NULL
     RETURN f.name AS fn, r.path AS path, r.method AS method
     LIMIT 20`,
    { service },
  );

  for (const row of unprotectedRoutes) {
    risks.push({
      id: `security::unprotected-route::${row.method}:${row.path}`,
      type: "security",
      severity: "high",
      score: 0.75,
      title: `Potentially unprotected route: ${row.method} ${row.path}`,
      description: `Handler function "${row.fn}" exposes this route but no auth/jwt/permission call was found in KB.`,
      affectedSymbols: [String(row.fn ?? "")],
      recommendedAction:
        "Verify authentication middleware is applied. If using decorator-based auth, this may be a false positive.",
    });
  }

  // Functions with high fan-in that also connect to DB (high blast radius on sensitive data)
  const sensitiveHighFanIn = await memgraph.query(
    `MATCH (f:Function {service: $service})-[:CONNECTS_TO]->(db:Database)
     WITH f, count(db) AS dbConns
     MATCH (caller:Function)-[:CALLS]->(f)
     WITH f, dbConns, count(DISTINCT caller) AS fanIn
     WHERE fanIn > 10
     RETURN f.name AS name, f.file AS file, fanIn, dbConns
     ORDER BY fanIn DESC LIMIT 10`,
    { service },
  );

  for (const row of sensitiveHighFanIn) {
    risks.push({
      id: `security::high-fanin-db::${row.name}`,
      type: "security",
      severity: "medium",
      score: 0.55,
      title: `High fan-in DB function: ${row.name}`,
      description:
        `"${row.name}" is called by ${row.fanIn} callers and connects to ${row.dbConns} database(s). ` +
        `A bug here could affect many callers with data integrity impact.`,
      affectedSymbols: [String(row.name ?? "")],
      recommendedAction:
        "Ensure input validation and proper error handling are in place.",
    });
  }

  return risks;
}

async function checkStabilityRisks(
  memgraph: MemgraphClient,
  service: string,
  threshold: number,
): Promise<RiskItem[]> {
  const risks: RiskItem[] = [];

  const graphClient = {
    write: (c: string, p?: Record<string, unknown>) =>
      memgraph.write(c, p ?? {}),
    query: (c: string, p?: Record<string, unknown>) =>
      memgraph.query(c, p ?? {}),
  };

  const hotspots = await scoreHotspots(graphClient, service, 20);
  const criticalHotspots = hotspots.filter((h) => h.score >= threshold);

  for (const h of criticalHotspots) {
    risks.push({
      id: `stability::hotspot::${h.name}::${h.file}`,
      type: "stability",
      severity: h.score >= 0.85 ? "critical" : "high",
      score: h.score,
      title: `Stability hotspot: ${h.name}`,
      description:
        `Score ${h.score} (blast_radius=${h.blastRadius}, fan_in=${h.fanIn}, infra=${h.infraConnections}). ` +
        h.reasons.join(". "),
      affectedSymbols: [h.name],
      recommendedAction:
        "Consider decomposing this function, adding circuit breakers, or improving test coverage.",
    });
  }

  // Contract drift check — removed routes
  const removedRoutes = await memgraph.query(
    `MATCH (s:Service {name: $service})
     WHERE s.lastSnapshot IS NOT NULL
     RETURN s.lastSnapshot AS snap`,
    { service },
  );

  if (removedRoutes.length > 0 && removedRoutes[0].snap) {
    try {
      const snap = JSON.parse(String(removedRoutes[0].snap));
      const currentRoutes = await memgraph.query(
        `MATCH (r:APIRoute {service: $service}) RETURN r.path AS path, r.method AS method`,
        { service },
      );
      const currentSet = new Set(
        currentRoutes.map((r) => `${r.method}:${r.path}`),
      );
      const prevRoutes: { path: string; method: string }[] =
        snap.apiRoutes ?? [];
      for (const route of prevRoutes) {
        if (!currentSet.has(`${route.method}:${route.path}`)) {
          risks.push({
            id: `stability::contract-drift::${route.method}:${route.path}`,
            type: "stability",
            severity: "critical",
            score: 0.95,
            title: `Contract drift: ${route.method} ${route.path} was removed`,
            description:
              `This route existed in the previous snapshot but is no longer in the graph. ` +
              `Callers may be broken.`,
            affectedSymbols: [],
            recommendedAction:
              "Use versioning (v2) instead of removing routes. Check if callers have been updated.",
          });
        }
      }
    } catch {
      // non-blocking
    }
  }

  return risks;
}

async function checkPerformanceRisks(
  memgraph: MemgraphClient,
  service: string,
): Promise<RiskItem[]> {
  const risks: RiskItem[] = [];

  // N+1 pattern proxy: functions that call the same DB function > 3 times
  const nPlusOne = await memgraph.query(
    `MATCH (f:Function {service: $service})-[:CALLS]->(db:Function)
     WHERE db.name CONTAINS 'query' OR db.name CONTAINS 'find' OR db.name CONTAINS 'fetch'
     WITH f, db, count(*) AS callCount
     WHERE callCount > 3
     RETURN f.name AS name, f.file AS file, db.name AS dbFn, callCount
     ORDER BY callCount DESC LIMIT 10`,
    { service },
  );

  for (const row of nPlusOne) {
    risks.push({
      id: `performance::n-plus-one::${row.name}`,
      type: "performance",
      severity: "medium",
      score: 0.5,
      title: `Potential N+1: ${row.name} calls ${row.dbFn} ${row.callCount}x`,
      description:
        `"${row.name}" calls DB function "${row.dbFn}" ${row.callCount} times. ` +
        `This may indicate an N+1 query pattern.`,
      affectedSymbols: [String(row.name ?? "")],
      recommendedAction:
        "Consider batching queries or using a DataLoader pattern.",
    });
  }

  return risks;
}

// ── Tool Registration ────────────────────────────────────────

export function registerScanRisksTool(
  server: McpServer,
  memgraph: MemgraphClient,
): void {
  server.registerTool(
    "scan_risks",
    {
      annotations: { title: "🔐 Scan Risks" },
      description:
        "On-demand risk assessment from the Knowledge Base. Reads directly from Memgraph — no re-sync needed. Returns structured risk items by severity.",
      inputSchema: {
        service: z
          .string()
          .describe("Service name to scan (e.g. 'warehouse-2.0')."),
        riskTypes: z
          .array(z.enum(["security", "performance", "stability", "upgrade"]))
          .default(["security", "stability"])
          .describe("Risk types to check. Default: security + stability."),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe(
            "Minimum risk score to include in results (0.0–1.0). Default: 0.5.",
          ),
      },
    },
    async ({ service, riskTypes, threshold }) => {
      try {
        const allRisks: RiskItem[] = [];

        if (riskTypes.includes("security")) {
          allRisks.push(...(await checkSecurityRisks(memgraph, service)));
        }
        if (riskTypes.includes("stability")) {
          allRisks.push(
            ...(await checkStabilityRisks(memgraph, service, threshold)),
          );
        }
        if (riskTypes.includes("performance")) {
          allRisks.push(...(await checkPerformanceRisks(memgraph, service)));
        }

        // Filter by threshold and sort by score desc
        const filtered = allRisks
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score);

        const byLevel = {
          critical: filtered.filter((r) => r.severity === "critical").length,
          high: filtered.filter((r) => r.severity === "high").length,
          medium: filtered.filter((r) => r.severity === "medium").length,
          low: filtered.filter((r) => r.severity === "low").length,
        };

        const overallSeverity =
          byLevel.critical > 0
            ? "HIGH"
            : byLevel.high > 0
              ? "MEDIUM"
              : byLevel.medium > 0
                ? "LOW"
                : "NONE";

        // Fetch last sync commit for report header
        const serviceRows = await memgraph.query(
          `MATCH (s:Service {name: $service})
           RETURN s.lastSyncCommit AS commit, s.lastSnapshotCommit AS snapCommit`,
          { service },
        );
        const lastCommit = String(
          serviceRows[0]?.commit ?? serviceRows[0]?.snapCommit ?? "unknown",
        );

        const report = {
          service,
          lastSyncCommit: lastCommit,
          checkedAt: new Date().toISOString(),
          riskTypes,
          threshold,
          summary: {
            breakingRisk: overallSeverity,
            total: filtered.length,
            bySeverity: byLevel,
          },
          risks: filtered,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
