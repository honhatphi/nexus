// ─────────────────────────────────────────────────────────────
// OpenAPI / Swagger Spec Parser
// Detects openapi.yaml, swagger.yaml, swagger.json files and
// extracts API contracts (paths + operations) for KB linking.
//
// Output: APIContract entries stored as InfraPattern with
//         kind = "http_route_define", so phase-2-graph creates
//         APIRoute nodes automatically.
//
// Supported formats:
//   - OpenAPI 3.x   (openapi: "3.x.x")
//   - Swagger 2.x   (swagger: "2.x")
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import yaml from "js-yaml";
import type { ParseResult, InfraPattern } from "../types.js";

// ── Supported filenames ───────────────────────────────────────

const OPENAPI_FILENAMES = new Set([
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.yml",
  "swagger.json",
  "api.yaml",
  "api.yml",
  "api.json",
]);

export function isOpenApiFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return OPENAPI_FILENAMES.has(base);
}

// ── HTTP methods recognized in OpenAPI ───────────────────────

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

// ── Raw doc types ─────────────────────────────────────────────

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
}

interface OpenApiPathItem {
  [method: string]: OpenApiOperation | string | string[];
}

interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, OpenApiPathItem>;
  basePath?: string; // Swagger 2.x
  servers?: Array<{ url: string }>; // OpenAPI 3.x
}

// ── Extraction ────────────────────────────────────────────────

interface ApiContractEntry {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
}

function extractContracts(doc: OpenApiDoc): ApiContractEntry[] {
  const contracts: ApiContractEntry[] = [];

  const basePath = doc.basePath ?? ""; // Swagger 2.x prefix

  for (const [rawPath, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const fullPath = basePath ? `${basePath}${rawPath}` : rawPath;

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;

      const operation = op as OpenApiOperation;
      contracts.push({
        path: fullPath,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags,
      });
    }
  }

  return contracts;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Parse an OpenAPI/Swagger spec file and return a ParseResult
 * whose `infraPatterns` contain `http_route_define` entries for
 * each path+method combination.  These are picked up by
 * phase-2-graph to create `:APIRoute` nodes.
 */
export function parseOpenApiSpec(
  filePath: string,
  source: string,
): ParseResult {
  const parseErrors: string[] = [];

  // ── Deserialize ──────────────────────────────────────────
  let doc: unknown;
  try {
    if (filePath.endsWith(".json")) {
      doc = JSON.parse(source);
    } else {
      doc = yaml.load(source);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parseErrors.push(`OpenAPI parse error: ${msg}`);
    return emptyResult(filePath, parseErrors);
  }

  if (!doc || typeof doc !== "object") {
    return emptyResult(filePath, ["OpenAPI file has no root object."]);
  }

  const openApiDoc = doc as OpenApiDoc;

  // ── Validate it's actually an OpenAPI/Swagger doc ────────
  if (!openApiDoc.openapi && !openApiDoc.swagger) {
    return emptyResult(filePath, [
      "Not an OpenAPI/Swagger document (missing 'openapi' or 'swagger' key).",
    ]);
  }

  if (!openApiDoc.paths || typeof openApiDoc.paths !== "object") {
    return emptyResult(filePath, []);
  }

  // ── Extract contracts ────────────────────────────────────
  const contracts = extractContracts(openApiDoc);
  const infraPatterns: InfraPattern[] = contracts.map((c, idx) => ({
    kind: "http_route_define",
    target: c.path,
    detail: c.operationId
      ? `OpenAPI: ${c.method} ${c.path} (${c.operationId})`
      : `OpenAPI: ${c.method} ${c.path}`,
    line: idx + 1, // Synthetic line — spec files don't have per-op lines
    metadata: {
      method: c.method,
      ...(c.operationId ? { operationId: c.operationId } : {}),
      ...(c.summary ? { summary: c.summary } : {}),
      ...(c.tags?.length ? { tags: c.tags.join(",") } : {}),
      source: "openapi_spec",
    },
  }));

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
