// ─────────────────────────────────────────────────────────────
// Pipeline — integration tests with mock graph/vector clients
// Tests the pipeline engine + phases without real DBs.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PipelineEngine } from "../src/pipeline/index.js";
import { filesystemPhase } from "../src/pipeline/phase-0-filesystem.js";
import { parsePhase } from "../src/pipeline/phase-1-parse.js";
import { createEmptyContext } from "../src/pipeline/types.js";
import type {
  PipelineDeps,
  GraphClient,
  VectorClient,
} from "../src/pipeline/types.js";
import { CodeParser } from "../src/universal-parser.js";

// ── Mock clients ─────────────────────────────────────────────

function createMockGraph(): GraphClient & {
  calls: { cypher: string; params?: Record<string, unknown> }[];
} {
  const calls: { cypher: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    async write(cypher: string, params?: Record<string, unknown>) {
      calls.push({ cypher, params });
      return [];
    },
    async query(cypher: string, params?: Record<string, unknown>) {
      calls.push({ cypher, params });
      // Return empty results — sufficient for testing pipeline flow
      return [];
    },
  };
}

function createMockVectors(): VectorClient & {
  upserted: { ids: string[]; documents: string[] }[];
} {
  const upserted: { ids: string[]; documents: string[] }[] = [];
  return {
    upserted,
    async upsert(
      ids: string[],
      documents: string[],
      _metadatas: Record<string, string | number | boolean>[],
    ) {
      upserted.push({ ids, documents });
    },
  };
}

// ── Test fixture: create a temp service dir ──────────────────

let tmpDir: string;
let servicePath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-test-"));
  servicePath = path.join(tmpDir, "test-service");
  await fs.mkdir(servicePath, { recursive: true });

  // Create sample files
  await fs.writeFile(
    path.join(servicePath, "handler.py"),
    `
def handle_request(request):
    """Handle incoming request."""
    validate(request)
    return process(request)

class RequestHandler:
    def post(self, data):
        return self.save(data)
`,
  );

  await fs.writeFile(
    path.join(servicePath, "utils.py"),
    `
def validate(data):
    if not data:
        raise ValueError("empty")
    return True
`,
  );

  await fs.writeFile(
    path.join(servicePath, "config.yml"),
    `
daily_etl:
  schedule_interval: "@daily"
  tasks:
    step_one:
      operator: PythonOperator
      python_callable_name: run_step
      dependencies: []
`,
  );
});

// ─────────────────────────────────────────────────────────────
// Pipeline Engine
// ─────────────────────────────────────────────────────────────

describe("PipelineEngine", () => {
  it("registers and runs phases in order", async () => {
    const engine = new PipelineEngine();
    const order: string[] = [];

    engine.register({
      name: "phase-a",
      order: 1,
      async run() {
        order.push("a");
        return {
          phase: "phase-a",
          success: true,
          stats: {},
          errors: [],
          durationMs: 0,
        };
      },
    });
    engine.register({
      name: "phase-b",
      order: 0,
      async run() {
        order.push("b");
        return {
          phase: "phase-b",
          success: true,
          stats: {},
          errors: [],
          durationMs: 0,
        };
      },
    });

    const ctx = createEmptyContext("test", "/tmp/test", false);
    const deps = {
      graph: createMockGraph(),
      vectors: createMockVectors(),
      parser: new CodeParser(),
    };

    const report = await engine.run(ctx, deps);
    expect(report.success).toBe(true);
    expect(order).toEqual(["b", "a"]); // sorted by order
  });
});

// ─────────────────────────────────────────────────────────────
// Filesystem Phase
// ─────────────────────────────────────────────────────────────

describe("Phase 0 — Filesystem", () => {
  it("discovers source files in the service directory", async () => {
    const ctx = createEmptyContext("test-service", servicePath, true);
    const deps: PipelineDeps = {
      graph: createMockGraph(),
      vectors: createMockVectors(),
      parser: new CodeParser(),
    };

    const result = await filesystemPhase.run(ctx, deps);
    expect(result.success).toBe(true);
    expect(ctx.sourceFiles.length).toBeGreaterThanOrEqual(2); // .py files
    const pyFiles = ctx.sourceFiles.filter((f) =>
      f.relativePath.endsWith(".py"),
    );
    expect(pyFiles.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// Parse Phase
// ─────────────────────────────────────────────────────────────

describe("Phase 1 — Parse", () => {
  it("parses all discovered files and populates parseResults", async () => {
    const ctx = createEmptyContext("test-service", servicePath, true);
    const deps: PipelineDeps = {
      graph: createMockGraph(),
      vectors: createMockVectors(),
      parser: new CodeParser(),
    };

    // Run filesystem first to populate sourceFiles
    await filesystemPhase.run(ctx, deps);

    // Then run parse
    const result = await parsePhase.run(ctx, deps);
    expect(result.success).toBe(true);
    expect(ctx.parseResults.size).toBeGreaterThanOrEqual(2);

    // Verify Python files were parsed
    for (const [filePath, parseResult] of ctx.parseResults) {
      if (filePath.endsWith(".py")) {
        expect(parseResult.symbols.length).toBeGreaterThanOrEqual(1);
        expect(parseResult.language).toBe("python");
      }
      if (filePath.endsWith(".yml")) {
        expect(parseResult.language).toBe("yaml");
      }
    }
  });

  it("accumulates stats correctly", async () => {
    const ctx = createEmptyContext("test-service", servicePath, true);
    const deps: PipelineDeps = {
      graph: createMockGraph(),
      vectors: createMockVectors(),
      parser: new CodeParser(),
    };

    await filesystemPhase.run(ctx, deps);
    await parsePhase.run(ctx, deps);

    // Parse phase tracks filesScanned and languages;
    // totalSymbols/totalClasses are accumulated by graph phase (phase 2)
    expect(ctx.stats.filesScanned).toBeGreaterThanOrEqual(2);
    expect(ctx.stats.languages.size).toBeGreaterThanOrEqual(2); // python, yaml

    // Verify parseResults contain the expected symbols
    let totalSymbols = 0;
    let totalClasses = 0;
    for (const [, pr] of ctx.parseResults) {
      totalSymbols += pr.symbols.length;
      totalClasses += pr.classes.length;
    }
    expect(totalSymbols).toBeGreaterThanOrEqual(3); // handle_request, post, validate
    expect(totalClasses).toBeGreaterThanOrEqual(1); // RequestHandler
  });
});

// ─────────────────────────────────────────────────────────────
// Full pipeline mini-run (filesystem + parse)
// ─────────────────────────────────────────────────────────────

describe("Pipeline — filesystem + parse integration", () => {
  it("produces a valid report", async () => {
    const engine = new PipelineEngine();
    engine.register(filesystemPhase);
    engine.register(parsePhase);

    const ctx = createEmptyContext("test-service", servicePath, true);
    const deps: PipelineDeps = {
      graph: createMockGraph(),
      vectors: createMockVectors(),
      parser: new CodeParser(),
    };

    const report = await engine.run(ctx, deps);
    expect(report.success).toBe(true);
    expect(report.phases.length).toBe(2);
    expect(report.details.filesScanned).toBeGreaterThanOrEqual(2);
    // totalSymbols stays 0 without graph phase; verify via parseResults
    expect(report.details.languages).toContain("python");
  });
});
