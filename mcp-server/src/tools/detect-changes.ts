// ─────────────────────────────────────────────────────────────
// detect_changes — MCP tool that analyzes git diffs against the
// Knowledge Base to show which KB symbols are affected by recent
// code changes, together with a risk assessment.
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { MemgraphClient } from "../clients/memgraph.js";
import { diffSnapshots } from "@nexus-hub/common-tools";
import { scoreHotspots } from "@nexus-hub/common-tools";
import type { GraphSnapshot } from "@nexus-hub/common-tools";

// ── Git Diff Parsing ─────────────────────────────────────────

interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

function parseGitDiff(servicePath: string, ref: string): ChangedFile[] {
  try {
    const output = execSync(`git diff --name-status ${ref}`, {
      cwd: servicePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [statusCode, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t"); // handle tabs in filenames
        const status =
          statusCode === "A"
            ? "added"
            : statusCode === "D"
              ? "deleted"
              : statusCode?.startsWith("R")
                ? "renamed"
                : "modified";
        return { path: filePath, status } as ChangedFile;
      });
  } catch {
    return [];
  }
}

// ── Risk Assessment ──────────────────────────────────────────

type RiskLevel = "low" | "medium" | "high" | "critical";

interface RiskAssessment {
  level: RiskLevel;
  score: number;
  factors: string[];
}

function assessRisk(
  callerCount: number,
  hasInfra: boolean,
  isDeleted: boolean,
): RiskAssessment {
  let score = 0;
  const factors: string[] = [];

  if (isDeleted) {
    score += 40;
    factors.push("file_deleted");
  }

  if (callerCount > 10) {
    score += 30;
    factors.push(`high_fan_in(${callerCount}_callers)`);
  } else if (callerCount > 3) {
    score += 15;
    factors.push(`moderate_fan_in(${callerCount}_callers)`);
  } else if (callerCount > 0) {
    score += 5;
    factors.push(`low_fan_in(${callerCount}_callers)`);
  }

  if (hasInfra) {
    score += 20;
    factors.push("touches_infrastructure");
  }

  const level: RiskLevel =
    score >= 60
      ? "critical"
      : score >= 40
        ? "high"
        : score >= 15
          ? "medium"
          : "low";

  return { level, score, factors };
}

// ── Tool Registration ────────────────────────────────────────

export function registerDetectChangesTool(
  server: McpServer,
  memgraph: MemgraphClient,
): void {
  server.registerTool(
    "detect_changes",
    {
      annotations: { title: "🔍 Detect Changes" },
      description:
        "Analyze recent code changes (git diff) against the Knowledge Base. Returns affected KB symbols, their callers, and a risk assessment for each changed file.",
      inputSchema: {
        service_path: z
          .string()
          .describe(
            "Absolute path to the service directory (e.g. /workspace/services/warehouse-2.0).",
          ),
        ref: z
          .string()
          .default("HEAD~1")
          .describe(
            "Git ref to diff against (default: HEAD~1). Can be a commit hash, branch, or tag.",
          ),
      },
    },
    async ({ service_path, ref }) => {
      try {
        const serviceName = service_path.split("/").pop() ?? "unknown";

        // 1. Get changed files from git
        const changedFiles = parseGitDiff(service_path, ref);
        if (changedFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  message: "No changes detected.",
                  service: serviceName,
                  ref,
                }),
              },
            ],
          };
        }

        // 2. For each changed file, query KB for affected symbols
        const analysis = [];

        for (const file of changedFiles) {
          const filePath = `${serviceName}/${file.path}`;

          // Find symbols in this file
          const symbols = await memgraph.query(
            `MATCH (f:Function)
             WHERE f.file = $file
             RETURN f.name AS name, f.service AS service`,
            { file: filePath },
          );

          // Find callers of symbols in this file
          const callers = await memgraph.query(
            `MATCH (caller:Function)-[r:CALLS]->(target:Function)
             WHERE target.file = $file
             RETURN
               caller.name AS callerName,
               caller.file AS callerFile,
               target.name AS targetName,
               coalesce(r.confidence, 1.0) AS confidence`,
            { file: filePath },
          );

          // Check for infra patterns
          const infraRows = await memgraph.query(
            `MATCH (f:Function)-[r:USES]->(i)
             WHERE f.file = $file
             RETURN i.kind AS kind, i.target AS target`,
            { file: filePath },
          );

          const hasInfra = infraRows.length > 0;
          const risk = assessRisk(
            callers.length,
            hasInfra,
            file.status === "deleted",
          );

          analysis.push({
            file: file.path,
            status: file.status,
            risk,
            affectedSymbols: symbols.map((s) => s.name),
            callers: callers.map((c) => ({
              name: c.callerName,
              file: c.callerFile,
              confidence: c.confidence,
            })),
            infrastructure: infraRows.map((r) => ({
              kind: r.kind,
              target: r.target,
            })),
          });
        }

        // Sort by risk score (highest first)
        analysis.sort((a, b) => b.risk.score - a.risk.score);

        // Summary
        const riskCounts = {
          critical: analysis.filter((a) => a.risk.level === "critical").length,
          high: analysis.filter((a) => a.risk.level === "high").length,
          medium: analysis.filter((a) => a.risk.level === "medium").length,
          low: analysis.filter((a) => a.risk.level === "low").length,
        };

        // C4: Architecture diff — load previous snapshot from Service node
        let architectureDiff = null;
        try {
          const snapRows = await memgraph.query(
            `MATCH (s:Service {name: $service})
             WHERE s.lastSnapshot IS NOT NULL
             RETURN s.lastSnapshot AS snap, s.lastSnapshotCommit AS commit`,
            { service: serviceName },
          );
          if (snapRows.length > 0 && snapRows[0].snap) {
            const previousSnapshot: GraphSnapshot = JSON.parse(
              String(snapRows[0].snap),
            );
            // Build a current snapshot inline for comparison
            const nodeCounts: Record<string, number> = {};
            for (const label of [
              "Function",
              "Class",
              "APIRoute",
              "GRPCEndpoint",
              "KafkaTopic",
            ]) {
              const rows = await memgraph.query(
                `MATCH (n:${label} {service: $service}) RETURN count(n) AS cnt`,
                { service: serviceName },
              );
              nodeCounts[label] = Number(
                (rows[0]?.cnt as { low?: number })?.low ?? rows[0]?.cnt ?? 0,
              );
            }
            const routeRows = await memgraph.query(
              `MATCH (r:APIRoute {service: $service}) RETURN r.path AS path, r.method AS method`,
              { service: serviceName },
            );
            const currentSnapshot: GraphSnapshot = {
              service: serviceName,
              commit: ref,
              takenAt: Date.now(),
              nodeCounts,
              edgeCounts: {},
              apiRoutes: routeRows.map((r) => ({
                path: String(r.path ?? ""),
                method: String(r.method ?? "GET"),
              })),
              grpcEndpoints: [],
              kafkaTopics: [],
            };
            architectureDiff = diffSnapshots(previousSnapshot, currentSnapshot);
          }
        } catch {
          // non-blocking
        }

        // C4: Hotspots top 10
        let hotspots = null;
        try {
          hotspots = await scoreHotspots(
            {
              write: (c, p) => memgraph.write(c, p ?? {}),
              query: (c, p) => memgraph.query(c, p ?? {}),
            },
            serviceName,
            10,
          );
        } catch {
          // non-blocking
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  service: serviceName,
                  ref,
                  totalChangedFiles: changedFiles.length,
                  riskSummary: riskCounts,
                  analysis,
                  architectureDiff,
                  hotspots,
                },
                null,
                2,
              ),
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
