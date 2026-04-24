// ─────────────────────────────────────────────────────────────
// Phase 8b — HTTP Linkage
// Creates HTTP_TRIGGERS edges between functions that call an
// HTTP endpoint (FE/client) and handler functions that expose
// the matching route (BE/server).
//
// Matching strategy (ordered by specificity):
//   1. Exact path match:   "/api/products" === "/api/products"
//   2. Template match:     "/api/products/1" matches "/api/products/:id"
//   3. Prefix match:       "/api/products/search" starts with "/api/products"
//
// Edge: caller ──[:HTTP_TRIGGERS {via, method, mechanism}]──> handler
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";

// ── Path Normalization ────────────────────────────────────────

/**
 * Normalize a URL/path for comparison:
 *   - Strip protocol + host (https://api.svc/v1/users → /v1/users)
 *   - Lowercase
 *   - Remove trailing slash
 *   - Strip query string
 */
function normalizePath(raw: string): string {
  try {
    // If it's a full URL, extract pathname only
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const url = new URL(raw);
      raw = url.pathname;
    }
  } catch {
    // Not a valid URL — treat as path
  }
  return raw
    .toLowerCase()
    .split("?")[0]   // strip query string
    .replace(/\/+$/, "") // trailing slash
    || "/";
}

/**
 * Convert Express/FastAPI param patterns to a regex:
 *   /users/:id         → /users/[^/]+
 *   /users/{id}        → /users/[^/]+
 *   /users/{id}/posts  → /users/[^/]+/posts
 */
function routePatternToRegex(routePath: string): RegExp {
  const escaped = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, (c) =>
      // Keep { } as placeholders — replace after escaping special chars
      ["{", "}"].includes(c) ? c : `\\${c}`,
    )
    .replace(/:\w+/g, "[^/]+")       // :param → [^/]+
    .replace(/\{[^}]+\}/g, "[^/]+"); // {param} → [^/]+
  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a caller URL matches a defined route path.
 * Returns a match score (higher = better match):
 *   3 = exact match
 *   2 = template/param match
 *   1 = prefix match
 *   0 = no match
 */
function matchScore(callerUrl: string, routePath: string): number {
  const normalizedCaller = normalizePath(callerUrl);
  const normalizedRoute = normalizePath(routePath);

  // Skip wildcard/fallback targets
  if (normalizedRoute === "<path>" || normalizedRoute === "" || normalizedRoute === "/") {
    return 0;
  }

  // Exact match
  if (normalizedCaller === normalizedRoute) return 3;

  // Template/param match (route has :id or {id})
  if (/:|\{/.test(normalizedRoute)) {
    try {
      const regex = routePatternToRegex(normalizedRoute);
      if (regex.test(normalizedCaller)) return 2;
    } catch {
      // Regex construction failed — skip
    }
  }

  // Prefix match (route is a sub-path prefix)
  if (
    normalizedCaller.startsWith(normalizedRoute + "/") ||
    normalizedCaller.startsWith(normalizedRoute)
  ) {
    return 1;
  }

  return 0;
}

// ── Phase Definition ─────────────────────────────────────────

export const httpLinkagePhase: PipelinePhase = {
  name: "http-linkage",
  // Run after kafka-linkage (7.5), before process-tracing (8)
  order: 7.6,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];

    try {
      // 1. Clean stale HTTP_TRIGGERS edges produced by this service
      await deps.graph.write(
        `MATCH (caller:Function {service: $service})-[r:HTTP_TRIGGERS]->()
         DELETE r`,
        { service: ctx.serviceName },
      );

      // 2. Fetch all HTTP callers in this service
      //    (functions that have HTTP_CALL edges to HTTPEndpoint nodes)
      const callers = await deps.graph.query(
        `MATCH (caller:Function {service: $service})-[:HTTP_CALL]->(ep:HTTPEndpoint)
         RETURN caller.name  AS callerName,
                caller.file  AS callerFile,
                ep.name      AS endpointUrl
         ORDER BY caller.name`,
        { service: ctx.serviceName },
      );

      if (callers.length === 0) {
        return {
          phase: "http-linkage",
          success: true,
          stats: { skipped: 1, reason: 1 },
          errors: [],
          durationMs: 0,
        };
      }

      // 3. Fetch all route handlers across ALL services
      //    (functions that have EXPOSES edges to APIRoute nodes)
      const handlers = await deps.graph.query(
        `MATCH (handler:Function)-[:EXPOSES]->(route:APIRoute)
         WHERE handler.service <> $service
         RETURN handler.name   AS handlerName,
                handler.file   AS handlerFile,
                handler.service AS handlerService,
                route.path     AS routePath,
                route.method   AS routeMethod`,
        { service: ctx.serviceName },
      );

      if (handlers.length === 0) {
        return {
          phase: "http-linkage",
          success: true,
          stats: { skipped: 1, reason: 2 },
          errors: [],
          durationMs: 0,
        };
      }

      // 4. Match callers to handlers and create HTTP_TRIGGERS edges
      let linksCreated = 0;

      for (const caller of callers) {
        const callerName = caller.callerName as string;
        const callerFile = caller.callerFile as string;
        const endpointUrl = caller.endpointUrl as string;

        // Find best-matching handler(s)
        type HandlerRow = {
          handlerName: string;
          handlerFile: string;
          handlerService: string;
          routePath: string;
          routeMethod: string;
        };

        const scored = (handlers as HandlerRow[])
          .map((h) => ({ ...h, score: matchScore(endpointUrl, h.routePath) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score);

        // Take only the best-scoring matches (avoid fan-out to low-quality matches)
        const topScore = scored[0]?.score ?? 0;
        const best = topScore > 0 ? scored.filter((h) => h.score === topScore) : [];

        for (const handler of best) {
          try {
            await deps.graph.write(
              `MATCH (caller:Function {name: $callerName, file: $callerFile, service: $callerService})
               MATCH (handler:Function {name: $handlerName, file: $handlerFile, service: $handlerService})
               MERGE (caller)-[r:HTTP_TRIGGERS]->(handler)
               SET r.via        = $routePath,
                   r.method     = $routeMethod,
                   r.mechanism  = 'http',
                   r.score      = $score,
                   r.updatedAt  = timestamp()`,
              {
                callerName,
                callerFile,
                callerService: ctx.serviceName,
                handlerName: handler.handlerName,
                handlerFile: handler.handlerFile,
                handlerService: handler.handlerService,
                routePath: handler.routePath,
                routeMethod: handler.routeMethod,
                score: handler.score,
              },
            );
            linksCreated++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`HTTP link failed (${callerName} → ${handler.handlerName}): ${msg}`);
          }
        }
      }

      return {
        phase: "http-linkage",
        success: errors.length === 0,
        stats: { httpTriggersCreated: linksCreated, callersChecked: callers.length, handlersAvailable: handlers.length },
        errors,
        durationMs: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`HTTP linkage failed: ${msg}`);
      return {
        phase: "http-linkage",
        success: false,
        stats: { httpTriggersCreated: 0 },
        errors,
        durationMs: 0,
      };
    }
  },
};
