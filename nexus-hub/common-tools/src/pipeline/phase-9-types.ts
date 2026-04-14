// ─────────────────────────────────────────────────────────────
// Phase 9 — Type Resolution (Simplified)
// Builds a per-file TypeEnvironment from:
//   Tier 0: explicit type annotations (confidence 1.0)
//   Tier 1: constructor calls `new X()` (confidence 0.9)
//   Tier 2: return type inference (confidence 0.8)
// Then upgrades CALLS edges with resolved types.
// ─────────────────────────────────────────────────────────────

import type {
  PipelinePhase,
  PipelineContext,
  PipelineDeps,
  PhaseResult,
} from "./types.js";
import type { SymbolInfo, ClassInfo } from "../types.js";

// ── Type Binding ─────────────────────────────────────────────

interface TypeBinding {
  varName: string;
  resolvedType: string;
  tier: 0 | 1 | 2;
  confidence: number;
}

interface TypeEnvironment {
  bindings: Map<string, TypeBinding>;
}

// ── Regex-Based Type Extraction ──────────────────────────────

/**
 * Extract type bindings from source code lines using regex heuristics.
 * Not as accurate as full AST analysis but sufficient for the simplified model.
 */
function buildTypeEnvironment(
  source: string,
  language: string,
  classIndex: Map<string, string>,
  functionReturnTypes: Map<string, string>,
): TypeEnvironment {
  const env: TypeEnvironment = { bindings: new Map() };
  const lines = source.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    switch (language) {
      case "typescript": {
        // Tier 0: const x: MyType = ...
        const annotationMatch = trimmed.match(
          /(?:const|let|var)\s+(\w+)\s*:\s*([\w.]+)/,
        );
        if (annotationMatch) {
          addBinding(env, annotationMatch[1], annotationMatch[2], 0, 1.0);
          break;
        }
        // Tier 1: const x = new MyClass(...)
        const ctorMatch = trimmed.match(
          /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(\w+)/,
        );
        if (ctorMatch) {
          addBinding(env, ctorMatch[1], ctorMatch[2], 1, 0.9);
          break;
        }
        // Tier 2: const x = getUser() where getUser returns User
        const callMatch = trimmed.match(
          /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\(/,
        );
        if (callMatch) {
          const returnType = functionReturnTypes.get(callMatch[2]);
          if (returnType) {
            addBinding(env, callMatch[1], returnType, 2, 0.8);
          }
        }
        break;
      }

      case "python": {
        // Tier 0: x: MyType = ...
        const pyAnnotation = trimmed.match(/(\w+)\s*:\s*([\w.]+)\s*=/);
        if (pyAnnotation) {
          addBinding(env, pyAnnotation[1], pyAnnotation[2], 0, 1.0);
          break;
        }
        // Tier 1: x = MyClass(...)
        const pyCtorMatch = trimmed.match(/(\w+)\s*=\s*([A-Z]\w+)\(/);
        if (pyCtorMatch && classIndex.has(pyCtorMatch[2])) {
          addBinding(env, pyCtorMatch[1], pyCtorMatch[2], 1, 0.9);
        }
        break;
      }

      case "csharp": {
        // Tier 0: MyType x = ...
        const csAnnotation = trimmed.match(
          /([A-Z]\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*=/,
        );
        if (csAnnotation) {
          addBinding(env, csAnnotation[2], csAnnotation[1], 0, 1.0);
          break;
        }
        // Tier 0: var x = ... (still need tier 1 fallback)
        // Tier 1: var x = new MyClass(...)
        const csCtorMatch = trimmed.match(
          /(?:var|[A-Z]\w+)\s+(\w+)\s*=\s*new\s+(\w+)/,
        );
        if (csCtorMatch) {
          addBinding(env, csCtorMatch[1], csCtorMatch[2], 1, 0.9);
        }
        break;
      }

      case "go": {
        // Tier 0: var x MyType or x := ...
        const goVarMatch = trimmed.match(/var\s+(\w+)\s+(\*?[\w.]+)/);
        if (goVarMatch) {
          addBinding(
            env,
            goVarMatch[1],
            goVarMatch[2].replace(/^\*/, ""),
            0,
            1.0,
          );
          break;
        }
        // Tier 1: x := &MyStruct{} or x := MyStruct{}
        const goCtorMatch = trimmed.match(/(\w+)\s*:=\s*&?([A-Z]\w+)\s*\{/);
        if (goCtorMatch) {
          addBinding(env, goCtorMatch[1], goCtorMatch[2], 1, 0.9);
        }
        break;
      }

      case "php": {
        // Tier 0: /** @var MyClass $x */ or MyClass $x
        const phpTypeMatch = trimmed.match(/(?:@var\s+)?([A-Z]\w+)\s+\$(\w+)/);
        if (phpTypeMatch) {
          addBinding(env, phpTypeMatch[2], phpTypeMatch[1], 0, 1.0);
          break;
        }
        // Tier 1: $x = new MyClass(...)
        const phpCtorMatch = trimmed.match(/\$(\w+)\s*=\s*new\s+(\w+)/);
        if (phpCtorMatch) {
          addBinding(env, phpCtorMatch[1], phpCtorMatch[2], 1, 0.9);
        }
        break;
      }
    }
  }

  return env;
}

function addBinding(
  env: TypeEnvironment,
  varName: string,
  resolvedType: string,
  tier: 0 | 1 | 2,
  confidence: number,
): void {
  const existing = env.bindings.get(varName);
  // Higher tier (lower number) takes precedence
  if (!existing || tier < existing.tier) {
    env.bindings.set(varName, { varName, resolvedType, tier, confidence });
  }
}

// ── Phase Definition ─────────────────────────────────────────

export const typeResolutionPhase: PipelinePhase = {
  name: "type-resolution",
  order: 9,

  async run(ctx: PipelineContext, deps: PipelineDeps): Promise<PhaseResult> {
    const errors: string[] = [];
    let edgesUpgraded = 0;
    let totalBindings = 0;

    // Build global class index: className → file
    const classIndex = new Map<string, string>();
    for (const [, parseResult] of ctx.parseResults) {
      for (const cls of parseResult.classes) {
        classIndex.set(cls.name, parseResult.file);
      }
    }

    // Build global function return type map
    const functionReturnTypes = new Map<string, string>();
    for (const [, parseResult] of ctx.parseResults) {
      for (const sym of parseResult.symbols) {
        if (sym.returnType) {
          functionReturnTypes.set(sym.name, sym.returnType);
        }
      }
    }

    // Build class method index: className → Set<methodName>
    const classMethodIndex = new Map<string, Set<string>>();
    for (const [, parseResult] of ctx.parseResults) {
      for (const cls of parseResult.classes) {
        classMethodIndex.set(cls.name, new Set(cls.methods));
      }
    }

    // Process each file
    for (const [absPath, parseResult] of ctx.parseResults) {
      const file = ctx.changedFiles.find((f) => f.absolutePath === absPath);
      if (!file?.content) continue;

      const env = buildTypeEnvironment(
        file.content,
        parseResult.language,
        classIndex,
        functionReturnTypes,
      );
      totalBindings += env.bindings.size;

      // For each symbol in this file, check if any call can be type-resolved
      for (const sym of parseResult.symbols) {
        for (const call of sym.calls) {
          // Check for obj.method() pattern
          const dotIdx = call.name.lastIndexOf(".");
          if (dotIdx === -1) continue;

          const objName = call.name.slice(0, dotIdx);
          const methodName = call.name.slice(dotIdx + 1);

          const binding = env.bindings.get(objName);
          if (!binding) continue;

          // Verify the class has this method
          const classMethods = classMethodIndex.get(binding.resolvedType);
          if (!classMethods || !classMethods.has(methodName)) continue;

          const classFile = classIndex.get(binding.resolvedType);
          const qualifiedCallee = `${binding.resolvedType}.${methodName}`;

          // Upgrade the CALLS edge with type information
          try {
            await deps.graph.write(
              `MATCH (caller:Function {name: $callerName, file: $callerFile})
               MATCH (callee:Function {name: $calleeName})
               WHERE callee.file = $calleeFile OR callee.name = $qualifiedCallee
               MERGE (caller)-[r:CALLS]->(callee)
               SET r.confidence = $confidence,
                   r.reason = $reason,
                   r.resolvedType = $resolvedType,
                   r.line = $line,
                   r.updatedAt = timestamp()`,
              {
                callerName: sym.name,
                callerFile: parseResult.file,
                calleeName: methodName,
                calleeFile: classFile ?? "",
                qualifiedCallee,
                confidence: binding.confidence,
                reason:
                  binding.tier === 0
                    ? "type_annotation"
                    : binding.tier === 1
                      ? "constructor_inference"
                      : "return_type_inference",
                resolvedType: binding.resolvedType,
                line: call.line,
              },
            );
            edgesUpgraded++;
          } catch (err) {
            errors.push(
              `${sym.name}.${call.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    return {
      phase: "type-resolution",
      success: true,
      stats: {
        totalBindings,
        edgesUpgraded,
      },
      errors,
      durationMs: 0,
    };
  },
};
