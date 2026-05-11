// ─────────────────────────────────────────────────────────────
// Pipeline Types — Context, Phase interface, and Result types
// for the multi-phase sync pipeline.
// ─────────────────────────────────────────────────────────────

import type { ParseResult, ClassInfo } from "../types.js";

// ─────────────────────────────────────────────────────────────
// File Entry
// ─────────────────────────────────────────────────────────────

export interface FileEntry {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Service-relative path (e.g. "warehouse-2.0/dags/foo.py"). */
  relativePath: string;
  /** File content (loaded in filesystem phase). */
  content?: string;
  /** Content hash for staleness detection. */
  contentHash?: string;
  /** Whether the file changed since last sync. */
  changed: boolean;
}

// ─────────────────────────────────────────────────────────────
// Import & Call Resolution
// ─────────────────────────────────────────────────────────────

export interface ImportEdge {
  sourceFile: string;
  targetModule: string;
  resolvedFile: string | null;
  importedNames: string[];
  isExternal: boolean;
  confidence: number;
}

export interface ResolvedCall {
  callerName: string;
  callerFile: string;
  calleeName: string;
  calleeFile: string | null;
  line: number;
  confidence: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────
// Heritage
// ─────────────────────────────────────────────────────────────

export interface HeritageEdge {
  childClass: string;
  childFile: string;
  parentClass: string;
  parentFile: string | null;
  kind: "extends" | "implements";
  confidence: number;
}

// ─────────────────────────────────────────────────────────────
// Community
// ─────────────────────────────────────────────────────────────

export interface Community {
  id: number;
  name: string;
  members: string[];
}

// ─────────────────────────────────────────────────────────────
// Process Trace
// ─────────────────────────────────────────────────────────────

export interface ProcessTrace {
  name: string;
  entryPoint: string;
  steps: string[];
}

// ─────────────────────────────────────────────────────────────
// Pipeline Context — accumulated state flowing through phases
// ─────────────────────────────────────────────────────────────

export interface PipelineContext {
  serviceName: string;
  servicePath: string;
  forceUpdate: boolean;

  // Phase 0 output
  sourceFiles: FileEntry[];
  changedFiles: FileEntry[];

  // Phase 1 output
  parseResults: Map<string, ParseResult>;

  // Phase 2 output  (future: import resolution)
  importGraph: ImportEdge[];

  // Phase 3 output  (future: call resolution)
  resolvedCalls: ResolvedCall[];

  // Phase 4 output  (future: heritage detection)
  heritageEdges: HeritageEdge[];

  // Phase 5 output  (future: community detection)
  communities: Community[];

  // Phase 6 output  (future: process tracing)
  processes: ProcessTrace[];

  // Metadata
  gitCommitHash: string | null;
  startedAt: number;
  errors: PhaseError[];

  // Counters (accumulated across phases)
  stats: PipelineStats;
}

export interface PipelineStats {
  filesScanned: number;
  filesSkipped: number;
  totalSymbols: number;
  totalClasses: number;
  totalRelationships: number;
  totalInfraPatterns: number;
  totalInfraRels: number;
  totalDagNodes: number;
  totalDagRels: number;
  totalDagVectors: number;
  totalVectors: number;
  languages: Set<string>;
}

// ─────────────────────────────────────────────────────────────
// Phase Interface
// ─────────────────────────────────────────────────────────────

export interface PhaseError {
  phase: string;
  message: string;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  stats: Record<string, number>;
  errors: string[];
  durationMs: number;
}

export interface PipelinePhase {
  name: string;
  order: number;
  run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult>;
}

// ─────────────────────────────────────────────────────────────
// Pipeline Dependencies — injected clients
// ─────────────────────────────────────────────────────────────

export interface GraphClient {
  write(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
  query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

export interface VectorClient {
  upsert(
    ids: string[],
    documents: string[],
    metadatas: Record<string, string | number | boolean>[],
  ): Promise<void>;
}

export interface CodeParserInterface {
  parseSource(filePath: string, source: string): Promise<ParseResult>;
}

export interface PipelineDeps {
  graph: GraphClient;
  vectors: VectorClient;
  parser: CodeParserInterface;
  /**
   * Optional persistent hash store for incremental indexing (PR 9).
   * When provided, file hashes survive MCP server restarts and only
   * changed files are re-parsed on subsequent syncs.
   */
  hashStore?: FileHashLookup;
}

/**
 * Minimal interface for persistent file-hash lookup.
 * Structurally compatible with `JsonFileHashStore` from @nexus-hub/core.
 */
export interface FileHashLookup {
  get(absolutePath: string): Promise<{ contentHash: string } | null>;
  set(
    absolutePath: string,
    entry: { contentHash: string; lastIndexedAt: string },
  ): Promise<void>;
  flush(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Pipeline Report — final output
// ─────────────────────────────────────────────────────────────

export interface PipelineReport {
  service: string;
  path: string;
  success: boolean;
  summary: string;
  phases: PhaseResult[];
  details: {
    filesScanned: number;
    filesSkipped: number;
    totalSymbols: number;
    totalClasses: number;
    totalRelationships: number;
    totalInfraPatterns: number;
    totalInfraRels: number;
    totalDagNodes: number;
    totalDagRels: number;
    totalDagVectors: number;
    totalVectors: number;
    languages: string[];
    forceUpdate: boolean;
    gitCommitHash: string | null;
    durationMs: number;
  };
  errors: string[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

export function createEmptyContext(
  serviceName: string,
  servicePath: string,
  forceUpdate: boolean,
): PipelineContext {
  return {
    serviceName,
    servicePath,
    forceUpdate,
    sourceFiles: [],
    changedFiles: [],
    parseResults: new Map(),
    importGraph: [],
    resolvedCalls: [],
    heritageEdges: [],
    communities: [],
    processes: [],
    gitCommitHash: null,
    startedAt: Date.now(),
    errors: [],
    stats: {
      filesScanned: 0,
      filesSkipped: 0,
      totalSymbols: 0,
      totalClasses: 0,
      totalRelationships: 0,
      totalInfraPatterns: 0,
      totalInfraRels: 0,
      totalDagNodes: 0,
      totalDagRels: 0,
      totalDagVectors: 0,
      totalVectors: 0,
      languages: new Set(),
    },
  };
}
