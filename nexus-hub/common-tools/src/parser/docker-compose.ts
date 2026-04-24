// ─────────────────────────────────────────────────────────────
// Docker Compose Parser
// Detects docker-compose.yml / docker-compose.*.yml files and
// extracts service topology for the KB graph.
//
// Extracted data:
//   Nodes  :InfraService { name, image, port, service (parent) }
//   Edges  DEPENDS_ON   InfraService → InfraService
//          IN_NETWORK   InfraService → InfraService (shared network)
//
// The parse result is consumed by phase-2-graph to upsert nodes.
// Topology metadata (dependsOn, networks) is available for future
// topology-aware phases.
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import yaml from "js-yaml";
import type { ParseResult } from "../types.js";

// ── File detection ────────────────────────────────────────────

const COMPOSE_BASENAME_RE = /^docker-compose(\.[a-z0-9_-]+)?\.(ya?ml)$/i;

export function isDockerComposeFile(filePath: string): boolean {
  return COMPOSE_BASENAME_RE.test(path.basename(filePath));
}

// ── Raw schema ────────────────────────────────────────────────

interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  ports?: (
    | string
    | { published?: string | number; target?: string | number }
  )[];
  depends_on?: string[] | Record<string, unknown>;
  networks?: string[] | Record<string, unknown>;
  environment?: string[] | Record<string, string>;
  command?: string | string[];
}

interface ComposeDoc {
  version?: string;
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
}

// ── Extraction helpers ────────────────────────────────────────

function extractPorts(ports: ComposeService["ports"]): string[] {
  if (!ports) return [];
  return ports
    .flatMap((p) => {
      if (typeof p === "string") {
        // "8080:80" → take host port
        return [p.split(":")[0]];
      }
      if (typeof p === "object" && p !== null) {
        return [String(p.published ?? p.target ?? "")];
      }
      return [];
    })
    .filter(Boolean);
}

function extractDependsOn(dependsOn: ComposeService["depends_on"]): string[] {
  if (!dependsOn) return [];
  if (Array.isArray(dependsOn)) return dependsOn;
  return Object.keys(dependsOn);
}

function extractNetworks(networks: ComposeService["networks"]): string[] {
  if (!networks) return [];
  if (Array.isArray(networks)) return networks;
  return Object.keys(networks);
}

function extractImage(svc: ComposeService): string {
  if (svc.image) return svc.image;
  if (svc.build) return "<local-build>";
  return "<unknown>";
}

// ── Main parser ───────────────────────────────────────────────

/**
 * Parse a Docker Compose file and emit a ParseResult with one
 * InfraPattern per service.
 *
 * The data lives in `parseResult.infraPatterns`:
 *   kind = "docker_service"  (new, handled by phase-2-graph P2 update)
 *   target = service name
 *   metadata = { image, ports, dependsOn, networks }
 */
export function parseDockerCompose(
  filePath: string,
  source: string,
): ParseResult {
  const parseErrors: string[] = [];

  let doc: unknown;
  try {
    doc = yaml.load(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parseErrors.push(`Docker Compose parse error: ${msg}`);
    return emptyResult(filePath, parseErrors);
  }

  if (!doc || typeof doc !== "object") {
    return emptyResult(filePath, ["Docker Compose file has no root object."]);
  }

  const composeDoc = doc as ComposeDoc;
  if (!composeDoc.services || typeof composeDoc.services !== "object") {
    // Valid compose file but no services — return clean empty
    return emptyResult(filePath, []);
  }

  const infraPatterns = [];

  for (const [svcName, svcDef] of Object.entries(composeDoc.services)) {
    if (!svcDef || typeof svcDef !== "object") continue;

    const image = extractImage(svcDef);
    const ports = extractPorts(svcDef.ports);
    const dependsOn = extractDependsOn(svcDef.depends_on);
    const networks = extractNetworks(svcDef.networks);

    infraPatterns.push({
      kind: "docker_service" as never, // Extended kind — not in InfraKind union
      target: svcName,
      detail: `Docker service: ${svcName} (${image})`,
      line: 1,
      metadata: {
        image,
        ports: ports.join(","),
        dependsOn: dependsOn.join(","),
        networks: networks.join(","),
        source: "docker_compose",
      },
    });
  }

  return {
    file: filePath,
    language: "yaml",
    symbols: [],
    functions: [],
    classes: [],
    infraPatterns,
    dags: [],
    parseErrors,
  };
}

// ── Helper ────────────────────────────────────────────────────

function emptyResult(filePath: string, parseErrors: string[]): ParseResult {
  return {
    file: filePath,
    language: "yaml",
    symbols: [],
    functions: [],
    classes: [],
    infraPatterns: [],
    dags: [],
    parseErrors,
  };
}
