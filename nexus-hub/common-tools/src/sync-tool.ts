// ─────────────────────────────────────────────────────────────
// sync_service_knowledge — Scan a service folder, parse every
// source file, and upsert the extracted knowledge into Memgraph
// (graph) and ChromaDB (vectors).
//
// Usage:
//   const tool = new SyncServiceKnowledge({ memgraph: { uri }, chromadb: { url } });
//   const report = await tool.run("/abs/path/to/services/api-gateway");
//   await tool.close();
// ─────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { ChromaClient, type Collection, type Metadata } from "chromadb";

import { CodeParser } from "./universal-parser.js";
import { EXTENSION_MAP } from "./types.js";
import type { ParseResult, SymbolInfo } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface SyncToolConfig {
  memgraph: {
    uri: string;
    user?: string;
    password?: string;
  };
  chromadb: {
    url: string;
    collection?: string;
    token?: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────

export interface SyncReport {
  service: string;
  path: string;
  success: boolean;
  summary: string;
  details: {
    filesScanned: number;
    filesSkipped: number;
    totalSymbols: number;
    totalRelationships: number;
    totalVectors: number;
    languages: string[];
  };
  errors: string[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", "__pycache__", ".venv", "build",
]);
const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await collectSourceFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function buildSignature(sym: SymbolInfo): string {
  const params = sym.params
    .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
    .join(", ");
  const ret = sym.returnType ? ` → ${sym.returnType}` : "";
  return `${sym.name}(${params})${ret}`;
}

// ─────────────────────────────────────────────────────────────
// SyncServiceKnowledge
// ─────────────────────────────────────────────────────────────

export class SyncServiceKnowledge {
  private driver: Driver;
  private chromaClient: ChromaClient;
  private collectionName: string;
  private collection: Collection | null = null;
  private parser: CodeParser;
  private hashCache = new Map<string, string>();

  constructor(config: SyncToolConfig) {
    // ── Memgraph ──
    this.driver = neo4j.driver(
      config.memgraph.uri,
      config.memgraph.user && config.memgraph.password
        ? neo4j.auth.basic(config.memgraph.user, config.memgraph.password)
        : undefined,
    );

    // ── ChromaDB ──
    const chromaOpts: Record<string, unknown> = { path: config.chromadb.url };
    if (config.chromadb.token) {
      chromaOpts.auth = { provider: "token", credentials: config.chromadb.token };
    }
    this.chromaClient = new ChromaClient(
      chromaOpts as ConstructorParameters<typeof ChromaClient>[0],
    );
    this.collectionName = config.chromadb.collection ?? "nexus_code";

    // ── Parser ──
    this.parser = new CodeParser();
  }

  // ── Public API ───────────────────────────────────────────

  async run(servicePath: string, forceUpdate = false): Promise<SyncReport> {
    const absPath = path.resolve(servicePath);
    const serviceName = path.basename(absPath);

    // Validate
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      return this.errorReport(serviceName, absPath, `${absPath} is not a directory.`);
    }

    const sourceFiles = await collectSourceFiles(absPath);
    if (sourceFiles.length === 0) {
      return this.errorReport(serviceName, absPath, "No supported source files found.");
    }

    let filesScanned = 0;
    let filesSkipped = 0;
    let totalSymbols = 0;
    let totalRelationships = 0;
    let totalVectors = 0;
    const languagesSeen = new Set<string>();
    const errors: string[] = [];

    for (const filePath of sourceFiles) {
      const content = await fs.readFile(filePath, "utf-8");

      // Staleness check
      if (!forceUpdate && !this.isChanged(filePath, content)) {
        filesSkipped++;
        continue;
      }

      const parseResult = await this.parser.parseSource(filePath, content);
      const relPath = path.relative(absPath, filePath);
      parseResult.file = `${serviceName}/${relPath}`;
      languagesSeen.add(parseResult.language);
      filesScanned++;

      if (parseResult.parseErrors.length > 0) {
        errors.push(...parseResult.parseErrors.map((e) => `${relPath}: ${e}`));
      }

      if (parseResult.symbols.length === 0) continue;

      // ── Graph Upsert ──
      const graphResult = await this.upsertToGraph(serviceName, parseResult);
      totalSymbols += graphResult.nodesUpserted;
      totalRelationships += graphResult.relsCreated;

      // ── Vector Upsert ──
      const vectorCount = await this.upsertToVector(serviceName, parseResult);
      totalVectors += vectorCount;
    }

    const languages = [...languagesSeen];
    return {
      service: serviceName,
      path: absPath,
      success: true,
      summary: `Đã nạp ${totalSymbols} hàm, ${totalRelationships} quan hệ mới, ${totalVectors} vectors. Ngôn ngữ: ${languages.join(", ") || "none"}.`,
      details: {
        filesScanned,
        filesSkipped,
        totalSymbols,
        totalRelationships,
        totalVectors,
        languages,
      },
      errors,
    };
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ── Graph Operations ─────────────────────────────────────

  private async graphWrite(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const session: Session = this.driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  private async upsertToGraph(
    serviceName: string,
    result: ParseResult,
  ): Promise<{ nodesUpserted: number; relsCreated: number }> {
    let nodesUpserted = 0;
    let relsCreated = 0;

    // Service node
    await this.graphWrite(
      `MERGE (s:Service {name: $service})`,
      { service: serviceName },
    );

    // File node + CONTAINS edge from Service
    await this.graphWrite(
      `MERGE (fi:File {path: $file})
       MERGE (s:Service {name: $service})
       MERGE (s)-[:CONTAINS]->(fi)
       SET fi.language = $language, fi.updatedAt = timestamp()`,
      { file: result.file, service: serviceName, language: result.language },
    );

    for (const sym of result.symbols) {
      const signature = buildSignature(sym);

      // Function node + CONTAINS edge from File
      await this.graphWrite(
        `MERGE (f:Function {name: $name, file: $file, service: $service})
         SET f.kind       = $kind,
             f.language   = $language,
             f.returnType = $returnType,
             f.startLine  = $startLine,
             f.endLine    = $endLine,
             f.signature  = $signature,
             f.docstring  = $docstring,
             f.updatedAt  = timestamp()
         WITH f
         MERGE (fi:File {path: $file})
         MERGE (fi)-[:CONTAINS]->(f)`,
        {
          name: sym.name,
          file: result.file,
          service: serviceName,
          kind: sym.kind,
          language: result.language,
          returnType: sym.returnType ?? "",
          startLine: sym.startLine,
          endLine: sym.endLine,
          signature,
          docstring: sym.docstring ?? "",
        },
      );
      nodesUpserted++;

      // CALLS edges
      for (const call of sym.calls) {
        await this.graphWrite(
          `MERGE (caller:Function {name: $callerName, file: $callerFile, service: $service})
           MERGE (callee:Function {name: $calleeName})
           MERGE (caller)-[r:CALLS]->(callee)
           SET r.line = $line, r.updatedAt = timestamp()`,
          {
            callerName: sym.name,
            callerFile: result.file,
            service: serviceName,
            calleeName: call.name,
            line: call.line,
          },
        );
        relsCreated++;
      }
    }

    return { nodesUpserted, relsCreated };
  }

  // ── Vector Operations ────────────────────────────────────

  private async getCollection(): Promise<Collection> {
    if (!this.collection) {
      this.collection = await this.chromaClient.getOrCreateCollection({
        name: this.collectionName,
      });
    }
    return this.collection;
  }

  private async upsertToVector(
    serviceName: string,
    result: ParseResult,
  ): Promise<number> {
    if (result.symbols.length === 0) return 0;

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Metadata[] = [];

    for (const sym of result.symbols) {
      const id = `${serviceName}::${result.file}::${sym.name}`;
      const signature = buildSignature(sym);
      const callsList = sym.calls.map((c) => c.name).join(", ");
      const doc = [
        `[${result.language}] ${signature}`,
        `Kind: ${sym.kind}`,
        `File: ${result.file}`,
        `Lines: ${sym.startLine}-${sym.endLine}`,
        sym.docstring ? `Doc: ${sym.docstring}` : "",
        callsList ? `Calls: ${callsList}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      ids.push(id);
      documents.push(doc);
      metadatas.push({
        service: serviceName,
        file: result.file,
        language: result.language,
        symbolName: sym.name,
        kind: sym.kind,
        startLine: sym.startLine,
        endLine: sym.endLine,
      });
    }

    const collection = await this.getCollection();
    await collection.upsert({ ids, documents, metadatas });
    return ids.length;
  }

  // ── Staleness Check ──────────────────────────────────────

  private isChanged(filePath: string, content: string): boolean {
    const newHash = contentHash(content);
    const oldHash = this.hashCache.get(filePath);
    this.hashCache.set(filePath, newHash);
    return oldHash !== newHash;
  }

  // ── Error Helper ─────────────────────────────────────────

  private errorReport(service: string, absPath: string, msg: string): SyncReport {
    return {
      service,
      path: absPath,
      success: false,
      summary: msg,
      details: {
        filesScanned: 0,
        filesSkipped: 0,
        totalSymbols: 0,
        totalRelationships: 0,
        totalVectors: 0,
        languages: [],
      },
      errors: [msg],
    };
  }
}
