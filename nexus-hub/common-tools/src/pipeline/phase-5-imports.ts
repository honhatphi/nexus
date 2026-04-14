// ─────────────────────────────────────────────────────────────
// Phase 2b — Import Resolution
// Extracts import statements from parsed ASTs and resolves
// cross-file import edges. Upserts IMPORTS edges into graph.
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
import type { ParseResult } from "../types.js";
import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
  ImportEdge,
} from "./types.js";

// ── Import Extraction Patterns ───────────────────────────────

interface RawImport {
  sourceFile: string;
  targetModule: string;
  importedNames: string[];
  line: number;
}

/**
 * Extract import statements from source code using regex.
 * Tree-sitter AST would be more accurate, but regex works for the
 * common patterns and is cheaper since we already have source text.
 */
function extractImports(
  filePath: string,
  source: string,
  language: string,
): RawImport[] {
  const imports: RawImport[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    switch (language) {
      case "typescript": {
        // import { X, Y } from "./module"
        const namedMatch = line.match(
          /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
        );
        if (namedMatch) {
          const names = namedMatch[1]
            .split(",")
            .map((n) =>
              n
                .trim()
                .split(/\s+as\s+/)[0]
                .trim(),
            )
            .filter(Boolean);
          imports.push({
            sourceFile: filePath,
            targetModule: namedMatch[2],
            importedNames: names,
            line: lineNum,
          });
          break;
        }
        // import X from "./module"
        const defaultMatch = line.match(
          /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/,
        );
        if (defaultMatch) {
          imports.push({
            sourceFile: filePath,
            targetModule: defaultMatch[2],
            importedNames: [defaultMatch[1]],
            line: lineNum,
          });
          break;
        }
        // import * as X from "./module"
        const starMatch = line.match(
          /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/,
        );
        if (starMatch) {
          imports.push({
            sourceFile: filePath,
            targetModule: starMatch[2],
            importedNames: ["*"],
            line: lineNum,
          });
        }
        break;
      }

      case "python": {
        // from .module import func, func2
        const fromMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
        if (fromMatch) {
          const names = fromMatch[2]
            .split(",")
            .map((n) =>
              n
                .trim()
                .split(/\s+as\s+/)[0]
                .trim(),
            )
            .filter(Boolean);
          imports.push({
            sourceFile: filePath,
            targetModule: fromMatch[1],
            importedNames: names,
            line: lineNum,
          });
          break;
        }
        // import module
        const importMatch = line.match(/^import\s+([\w.]+)/);
        if (importMatch) {
          imports.push({
            sourceFile: filePath,
            targetModule: importMatch[1],
            importedNames: ["*"],
            line: lineNum,
          });
        }
        break;
      }

      case "go": {
        // "github.com/org/pkg"
        const goMatch = line.match(/^\s*"([^"]+)"/);
        if (goMatch) {
          imports.push({
            sourceFile: filePath,
            targetModule: goMatch[1],
            importedNames: ["*"],
            line: lineNum,
          });
        }
        break;
      }

      case "php": {
        // use App\Services\UserService;
        const useMatch = line.match(/^use\s+([\w\\]+)(?:\s+as\s+\w+)?;/);
        if (useMatch) {
          const parts = useMatch[1].split("\\");
          imports.push({
            sourceFile: filePath,
            targetModule: useMatch[1],
            importedNames: [parts[parts.length - 1]],
            line: lineNum,
          });
        }
        break;
      }

      case "csharp": {
        // using MyNamespace.MyClass;
        const usingMatch = line.match(/^using\s+([\w.]+);/);
        if (usingMatch) {
          imports.push({
            sourceFile: filePath,
            targetModule: usingMatch[1],
            importedNames: ["*"],
            line: lineNum,
          });
        }
        break;
      }
    }
  }

  return imports;
}

// ── Resolution ───────────────────────────────────────────────

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const PY_EXTENSIONS = [".py"];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveImport(
  raw: RawImport,
  servicePath: string,
  language: string,
): Promise<ImportEdge> {
  const isRelative =
    raw.targetModule.startsWith(".") || raw.targetModule.startsWith("/");
  const isExternal = !isRelative;

  if (isExternal) {
    return {
      sourceFile: raw.sourceFile,
      targetModule: raw.targetModule,
      resolvedFile: null,
      importedNames: raw.importedNames,
      isExternal: true,
      confidence: 0.6,
    };
  }

  const sourceDir = path.dirname(raw.sourceFile);

  // Try to resolve relative import
  let resolvedFile: string | null = null;
  let confidence = 0.85;

  if (language === "typescript") {
    // Try: ./foo → ./foo.ts, ./foo.tsx, ./foo/index.ts, etc.
    const basePath = path.resolve(sourceDir, raw.targetModule);
    for (const ext of TS_EXTENSIONS) {
      if (await fileExists(basePath + ext)) {
        resolvedFile = basePath + ext;
        confidence = 0.9;
        break;
      }
    }
    // Try index file
    if (!resolvedFile) {
      for (const ext of TS_EXTENSIONS) {
        if (await fileExists(path.join(basePath, `index${ext}`))) {
          resolvedFile = path.join(basePath, `index${ext}`);
          confidence = 0.85;
          break;
        }
      }
    }
  } else if (language === "python") {
    // from .module import X → ./module.py or ./module/__init__.py
    const modulePath = raw.targetModule.replace(/\./g, "/");
    const basePath = path.resolve(sourceDir, modulePath);
    for (const ext of PY_EXTENSIONS) {
      if (await fileExists(basePath + ext)) {
        resolvedFile = basePath + ext;
        confidence = 0.9;
        break;
      }
    }
    if (
      !resolvedFile &&
      (await fileExists(path.join(basePath, "__init__.py")))
    ) {
      resolvedFile = path.join(basePath, "__init__.py");
      confidence = 0.85;
    }
  }

  return {
    sourceFile: raw.sourceFile,
    targetModule: raw.targetModule,
    resolvedFile,
    importedNames: raw.importedNames,
    isExternal: false,
    confidence,
  };
}

// ── Phase Definition ─────────────────────────────────────────

export const importResolutionPhase: PipelinePhase = {
  name: "import-resolution",
  order: 5,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let edgesCreated = 0;

    for (const [absPath, parseResult] of ctx.parseResults) {
      const file = ctx.changedFiles.find((f) => f.absolutePath === absPath);
      if (!file?.content) continue;

      try {
        const rawImports = extractImports(
          absPath,
          file.content,
          parseResult.language,
        );

        for (const raw of rawImports) {
          const edge = await resolveImport(
            raw,
            ctx.servicePath,
            parseResult.language,
          );
          ctx.importGraph.push(edge);

          // Resolve to service-relative path for graph storage
          const sourceRelPath = parseResult.file;
          const targetRelPath = edge.resolvedFile
            ? `${ctx.serviceName}/${path.relative(ctx.servicePath, edge.resolvedFile)}`
            : null;

          // Upsert IMPORTS edge into graph
          if (targetRelPath) {
            await deps.graph.write(
              `MERGE (source:File {path: $sourceFile})
               MERGE (target:File {path: $targetFile})
               MERGE (source)-[r:IMPORTS]->(target)
               SET r.importedNames = $names,
                   r.confidence = $confidence,
                   r.updatedAt = timestamp()`,
              {
                sourceFile: sourceRelPath,
                targetFile: targetRelPath,
                names: edge.importedNames.join(","),
                confidence: edge.confidence,
              },
            );
            edgesCreated++;
          }
        }
      } catch (err) {
        errors.push(
          `${parseResult.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      phase: "import-resolution",
      success: true,
      stats: {
        totalImports: ctx.importGraph.length,
        resolvedImports: ctx.importGraph.filter((e) => e.resolvedFile !== null)
          .length,
        externalImports: ctx.importGraph.filter((e) => e.isExternal).length,
        edgesCreated,
      },
      errors,
      durationMs: 0,
    };
  },
};
