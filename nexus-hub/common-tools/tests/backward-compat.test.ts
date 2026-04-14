// ─────────────────────────────────────────────────────────────
// Backward compatibility tests — ensure public API shape
// hasn't changed after the parser refactoring.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

// Import everything through the barrel (index.ts)
import {
  CodeParser,
  parseSource,
  detectLanguage,
  EXTENSION_MAP,
  toLegacyFunctionInfo,
} from "../src/index.js";

import type {
  SupportedLanguage,
  SymbolKind,
  SymbolInfo,
  Parameter,
  FunctionCall,
  InfraKind,
  InfraPattern,
  ClassInfo,
  FunctionInfo,
  ParseResult,
  DagTaskInfo,
  DagInfo,
} from "../src/index.js";

describe("Public API — exports", () => {
  it("CodeParser class is exported and constructible", () => {
    expect(CodeParser).toBeDefined();
    const p = new CodeParser();
    expect(p).toBeInstanceOf(CodeParser);
    expect(typeof p.detectLanguage).toBe("function");
    expect(typeof p.parseFile).toBe("function");
    expect(typeof p.parseSource).toBe("function");
  });

  it("free functions are exported", () => {
    expect(typeof parseSource).toBe("function");
    expect(typeof detectLanguage).toBe("function");
  });

  it("EXTENSION_MAP is exported with correct entries", () => {
    expect(EXTENSION_MAP[".go"]).toBe("go");
    expect(EXTENSION_MAP[".py"]).toBe("python");
    expect(EXTENSION_MAP[".ts"]).toBe("typescript");
    expect(EXTENSION_MAP[".java"]).toBe("java");
    expect(EXTENSION_MAP[".cs"]).toBe("csharp");
    expect(EXTENSION_MAP[".yml"]).toBe("yaml");
  });

  it("toLegacyFunctionInfo converts correctly", () => {
    const sym: SymbolInfo = {
      name: "test",
      kind: "function",
      params: [{ name: "a", type: "int" }],
      returnType: "void",
      docstring: "docs",
      calls: [{ name: "foo", line: 1 }],
      startLine: 1,
      endLine: 5,
    };
    const legacy = toLegacyFunctionInfo(sym);
    expect(legacy.name).toBe("test");
    expect(legacy.parameters).toEqual(sym.params);
    expect(legacy.returnType).toBe("void");
    expect(legacy.calls).toEqual(sym.calls);
    expect(legacy.startLine).toBe(1);
    expect(legacy.endLine).toBe(5);
    // Legacy doesn't have kind or docstring
    expect("kind" in legacy).toBe(false);
  });
});

describe("Public API — free functions", () => {
  it("detectLanguage works without instantiation", () => {
    expect(detectLanguage("foo.py")).toBe("python");
    expect(detectLanguage("bar.go")).toBe("go");
    expect(detectLanguage("unknown.xyz")).toBeNull();
  });

  it("parseSource works without instantiation", async () => {
    const result = await parseSource("test.py", `def hello(): pass`);
    expect(result.language).toBe("python");
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0].name).toBe("hello");
    expect(result.functions.length).toBe(1);
    expect(result.functions[0].name).toBe("hello");
  });
});

describe("ParseResult shape", () => {
  it("has all expected fields", async () => {
    const result = await parseSource(
      "test.py",
      `
class Foo:
    def bar(self):
        pass
`,
    );

    // Check all fields exist
    expect(result).toHaveProperty("file");
    expect(result).toHaveProperty("language");
    expect(result).toHaveProperty("symbols");
    expect(result).toHaveProperty("functions");
    expect(result).toHaveProperty("classes");
    expect(result).toHaveProperty("infraPatterns");
    expect(result).toHaveProperty("dags");
    expect(result).toHaveProperty("parseErrors");

    // Type checks
    expect(typeof result.file).toBe("string");
    expect(typeof result.language).toBe("string");
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.functions)).toBe(true);
    expect(Array.isArray(result.classes)).toBe(true);
    expect(Array.isArray(result.infraPatterns)).toBe(true);
    expect(Array.isArray(result.dags)).toBe(true);
    expect(Array.isArray(result.parseErrors)).toBe(true);
  });

  it("SymbolInfo has correct shape", async () => {
    const result = await parseSource(
      "test.py",
      `
def greet(name: str) -> str:
    """Say hello."""
    return f"Hello {name}"
`,
    );
    const sym = result.symbols[0];
    expect(sym).toHaveProperty("name");
    expect(sym).toHaveProperty("kind");
    expect(sym).toHaveProperty("params");
    expect(sym).toHaveProperty("returnType");
    expect(sym).toHaveProperty("docstring");
    expect(sym).toHaveProperty("calls");
    expect(sym).toHaveProperty("startLine");
    expect(sym).toHaveProperty("endLine");
    expect(typeof sym.startLine).toBe("number");
    expect(typeof sym.endLine).toBe("number");
    expect(sym.startLine).toBeLessThanOrEqual(sym.endLine);
  });
});
