// ─────────────────────────────────────────────────────────────
// NexusCore — central façade for the Knowledge Engine.
// Sits between the MCP adapter layer and the Knowledge Engine
// (Memgraph + ChromaDB + pipeline). Tool logic delegates here
// so ports can be swapped without touching MCP handlers.
// ─────────────────────────────────────────────────────────────

import type { GraphStore } from "./ports/graph-store.js";
import type { VectorStore } from "./ports/vector-store.js";
import type {
  Retriever,
  SearchInput,
  SearchResult,
} from "./ports/retriever.js";
import type {
  CodeIndexer,
  SyncInput,
  SyncSummary,
} from "./ports/code-indexer.js";
import type { MemoryStore } from "./ports/memory-store.js";
import type { ArtifactStore } from "./ports/artifact-store.js";

// ── Input / Output types ──────────────────────────────────────

export interface SymbolContextInput {
  name: string;
  service?: string;
}

export interface SymbolContext {
  symbol: Record<string, unknown> | null;
  callers: Record<string, unknown>[];
  callees: Record<string, unknown>[];
  communities: Record<string, unknown>[];
  processes: Record<string, unknown>[];
  heritage: Record<string, unknown>[];
  infraPatterns: Record<string, unknown>[];
  staleness: StalenessInfo[];
}

export interface StalenessInfo {
  service: string;
  stale: boolean;
  lastSyncCommit: string;
  currentHead: string;
  commitsBehind: number;
  message: string;
}

// ── NexusCore interface ───────────────────────────────────────

export interface INexusCore {
  search(input: SearchInput): Promise<SearchResult[]>;
  getSymbolContext(input: SymbolContextInput): Promise<SymbolContext>;
  syncService(input: SyncInput): Promise<SyncSummary>;
  readonly graph: GraphStore;
  readonly vector: VectorStore;
  readonly memory?: MemoryStore;
  readonly artifacts?: ArtifactStore;
}

// ── NexusCore dependencies ────────────────────────────────────

export interface NexusCoreOptions {
  graph: GraphStore;
  vector: VectorStore;
  retriever: Retriever;
  indexer: CodeIndexer;
  memory?: MemoryStore;
  artifacts?: ArtifactStore;
}

// ── NexusCore implementation ──────────────────────────────────

export class NexusCore implements INexusCore {
  readonly graph: GraphStore;
  readonly vector: VectorStore;
  readonly memory?: MemoryStore;
  readonly artifacts?: ArtifactStore;

  private readonly retriever: Retriever;
  private readonly indexer: CodeIndexer;

  constructor(opts: NexusCoreOptions) {
    this.graph = opts.graph;
    this.vector = opts.vector;
    this.retriever = opts.retriever;
    this.indexer = opts.indexer;
    this.memory = opts.memory;
    this.artifacts = opts.artifacts;
  }

  // ── search ──────────────────────────────────────────────────

  search(input: SearchInput): Promise<SearchResult[]> {
    return this.retriever.search(input);
  }

  // ── syncService ─────────────────────────────────────────────

  syncService(input: SyncInput): Promise<SyncSummary> {
    return this.indexer.sync(input);
  }

  // ── getSymbolContext ─────────────────────────────────────────
  // Delegates the multi-query symbol context lookup to the graph
  // store, keeping the exact same Cypher as context.ts.

  async getSymbolContext(input: SymbolContextInput): Promise<SymbolContext> {
    const { name, service } = input;
    const svcFilter = service ? "AND n.service = $service" : "";
    const svcParam = service ?? "";

    const [
      symbols,
      callers,
      callees,
      communities,
      processes,
      heritage,
      infraPatterns,
    ] = await Promise.all([
      this.graph.query(
        `MATCH (n)
           WHERE (n:Function OR n:Class OR n:Method)
             AND n.name = $name ${svcFilter}
           RETURN n.name AS name, n.file AS file, n.service AS service,
                  n.language AS language, n.startLine AS startLine,
                  n.endLine AS endLine, n.params AS params,
                  n.returnType AS returnType, labels(n)[0] AS type
           LIMIT 5`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (caller)-[r:CALLS]->(target)
           WHERE target.name = $name ${service ? "AND target.service = $service" : ""}
           RETURN DISTINCT caller.name AS name, caller.file AS file,
                  caller.service AS service, labels(caller)[0] AS type,
                  coalesce(r.confidence, 1.0) AS confidence,
                  coalesce(r.reason, '') AS reason
           ORDER BY confidence DESC LIMIT 15`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (source)-[r:CALLS]->(callee)
           WHERE source.name = $name ${service ? "AND source.service = $service" : ""}
           RETURN DISTINCT callee.name AS name, callee.file AS file,
                  callee.service AS service, labels(callee)[0] AS type,
                  coalesce(r.confidence, 1.0) AS confidence,
                  coalesce(r.reason, '') AS reason
           ORDER BY confidence DESC LIMIT 15`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (n)-[:MEMBER_OF]->(c:Community)
           WHERE n.name = $name ${service ? "AND n.service = $service" : ""}
           RETURN c.name AS communityName, c.memberCount AS memberCount,
                  c.service AS service LIMIT 3`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (n)-[r:STEP_IN_PROCESS]->(p:Process)
           WHERE n.name = $name ${service ? "AND n.service = $service" : ""}
           RETURN p.name AS processName, p.entryPoint AS entryPoint,
                  p.stepCount AS stepCount, r.step AS stepPosition
           ORDER BY p.stepCount DESC LIMIT 5`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (n)-[r:EXTENDS|IMPLEMENTS]->(parent)
           WHERE n.name = $name ${service ? "AND n.service = $service" : ""}
           RETURN parent.name AS parentName, parent.file AS parentFile,
                  parent.service AS parentService,
                  labels(parent)[0] AS parentType, type(r) AS relation
           LIMIT 10`,
        { name, service: svcParam },
      ),
      this.graph.query(
        `MATCH (n)-[:USES_INFRA]->(infra:InfraPattern)
           WHERE n.name = $name ${service ? "AND n.service = $service" : ""}
           RETURN infra.kind AS kind, infra.target AS target,
                  infra.method AS method LIMIT 10`,
        { name, service: svcParam },
      ),
    ]);

    return {
      symbol: symbols[0] ?? null,
      callers,
      callees,
      communities,
      processes,
      heritage,
      infraPatterns,
      staleness: [],
    };
  }
}
