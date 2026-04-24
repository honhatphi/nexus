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

export const parsePhase: PipelinePhase = {
  name: "parse",
  order: 1,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let parsed = 0;

    for (const file of ctx.changedFiles) {
      if (!file.content) continue;

      try {
        let parseResult;

        if (isOpenApiFile(file.absolutePath)) {
          // OpenAPI / Swagger spec — use dedicated parser
          parseResult = parseOpenApiSpec(file.absolutePath, file.content);
        } else {
          parseResult = await deps.parser.parseSource(
            file.absolutePath,
            file.content,
          );
        }

        // Override file path to service-relative
        parseResult.file = `${ctx.serviceName}/${file.relativePath}`;
        ctx.parseResults.set(file.absolutePath, parseResult);
        ctx.stats.languages.add(parseResult.language);
        ctx.stats.filesScanned++;
        parsed++;

        if (parseResult.parseErrors.length > 0) {
          errors.push(
            ...parseResult.parseErrors.map((e) => `${file.relativePath}: ${e}`),
          );
        }
      } catch (err) {
        errors.push(
          `${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
