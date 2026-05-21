// ─────────────────────────────────────────────────────────────
// Phase 1 — Tree-sitter parsing
// Parses all changed files and stores ParseResult in context.
// OpenAPI/Swagger spec files are parsed separately by openapi-spec.ts.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";
import { isOpenApiFile, parseOpenApiSpec } from "../parser/openapi-spec.js";
import {
  isDockerComposeFile,
  parseDockerCompose,
} from "../parser/docker-compose.js";

// Number of files parsed concurrently. High enough for I/O overlap,
// low enough to avoid OOM on large repos (each slot holds one AST in memory).
const PARSE_CONCURRENCY = 16;

export const parsePhase: PipelinePhase = {
  name: "parse",
  order: 1,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let parsed = 0;

    // Process files in concurrent chunks.
    // Sequential parsing of 2,000+ files is the single biggest bottleneck;
    // PARSE_CONCURRENCY slots run in parallel, then the next chunk starts.
    for (let i = 0; i < ctx.changedFiles.length; i += PARSE_CONCURRENCY) {
      const chunk = ctx.changedFiles.slice(i, i + PARSE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (file) => {
          if (!file.content) return;
          try {
            let parseResult;

            if (isOpenApiFile(file.absolutePath)) {
              parseResult = parseOpenApiSpec(file.absolutePath, file.content);
            } else if (isDockerComposeFile(file.absolutePath)) {
              parseResult = parseDockerCompose(file.absolutePath, file.content);
            } else {
              parseResult = await deps.parser.parseSource(
                file.absolutePath,
                file.content,
              );
            }

            // Override file path to service-relative
            parseResult.file = `${ctx.serviceName}/${file.relativePath}`;
            // Map.set + Set.add + ++ are all synchronous — safe in concurrent Promise.all
            ctx.parseResults.set(file.absolutePath, parseResult);
            ctx.stats.languages.add(parseResult.language);
            ctx.stats.filesScanned++;
            parsed++;

            if (parseResult.parseErrors.length > 0) {
              errors.push(
                ...parseResult.parseErrors.map(
                  (e) => `${file.relativePath}: ${e}`,
                ),
              );
            }
          } catch (err) {
            errors.push(
              `${file.relativePath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }),
      );
    }

    return {
      phase: "parse",
      success: true,
      stats: { filesParsed: parsed },
      errors,
      durationMs: 0,
    };
  },
};
