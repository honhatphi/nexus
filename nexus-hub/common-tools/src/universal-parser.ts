// ─────────────────────────────────────────────────────────────
// Universal Parser — web-tree-sitter (WASM) multi-language code parser
//
// Class-based API:
//   const parser = new CodeParser();
//   const result = await parser.parseFile("/path/to/handler.go");
//
// Extracts per symbol: name, kind, params, returnType, docstring, calls
// Output: Unified JSON schema (see ./types.ts)
// ─────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import type { SupportedLanguage, ParseResult } from "./types.js";
import { EXTENSION_MAP, toLegacyFunctionInfo } from "./types.js";

// ── Modular sub-modules ──────────────────────────────────────
import { findAll } from "./parser/ast-helpers.js";
import {
  EXTRACTORS,
  CLASS_EXTRACTORS,
  type TreeSitterLanguage,
} from "./parser/extractors/index.js";
import { detectInfraPatterns } from "./parser/infra-detection.js";
import { parseYamlDag } from "./parser/yaml-dag.js";

// ─────────────────────────────────────────────────────────────
// CodeParser
// ─────────────────────────────────────────────────────────────

// createRequire is used here instead of the global `require` so that:
// (a) the intent is explicit and visible to linters, and
// (b) the call site is trivially migrated to ESM by swapping __filename
//     for import.meta.url when/if this package gains "type": "module".
const _require = createRequire(__filename);

export class CodeParser {
  private static initPromise: Promise<void> | null = null;
  private static languageCache = new Map<TreeSitterLanguage, Language>();

  private static readonly WASM_FILES: Record<TreeSitterLanguage, string> = {
    go: "tree-sitter-go.wasm",
    python: "tree-sitter-python.wasm",
    php: "tree-sitter-php.wasm",
    typescript: "tree-sitter-typescript.wasm",
    javascript: "tree-sitter-javascript.wasm",
    java: "tree-sitter-java.wasm",
    csharp: "tree-sitter-c_sharp.wasm",
    dart: "tree-sitter-dart.wasm",
  };

  // ── Init & Language Loading ──────────────────────────────

  private static async ensureInit(): Promise<void> {
    if (!CodeParser.initPromise) {
      CodeParser.initPromise = Parser.init();
    }
    await CodeParser.initPromise;
  }

  private static async loadLanguage(
    lang: TreeSitterLanguage,
  ): Promise<Language> {
    const cached = CodeParser.languageCache.get(lang);
    if (cached) return cached;

    const wasmDir = path.dirname(
      _require.resolve("tree-sitter-wasms/package.json"),
    );
    const wasmPath = path.join(wasmDir, "out", CodeParser.WASM_FILES[lang]);

    const language = await Language.load(wasmPath);
    CodeParser.languageCache.set(lang, language);
    return language;
  }

  // ── Public API ───────────────────────────────────────────

  detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
  }

  async parseFile(filePath: string): Promise<ParseResult> {
    const source = await fs.readFile(filePath, "utf-8");
    return this.parseSource(filePath, source);
  }

  async parseSource(filePath: string, source: string): Promise<ParseResult> {
    const language = this.detectLanguage(filePath);
    if (!language) {
      return {
        file: filePath,
        language: "typescript",
        symbols: [],
        functions: [],
        classes: [],
        infraPatterns: [],
        dags: [],
        parseErrors: [`Unsupported file extension: ${path.extname(filePath)}`],
      };
    }

    // ── YAML files: use js-yaml instead of tree-sitter ──
    if (language === "yaml") {
      return parseYamlDag(filePath, source);
    }

    // After this point, language is a tree-sitter language
    const tsLang = language as TreeSitterLanguage;

    await CodeParser.ensureInit();

    const parser = new Parser();
    const lang = await CodeParser.loadLanguage(tsLang);
    parser.setLanguage(lang);

    const tree = parser.parse(source);
    if (!tree) {
      return {
        file: filePath,
        language,
        symbols: [],
        functions: [],
        classes: [],
        infraPatterns: [],
        dags: [],
        parseErrors: ["Failed to parse source — tree-sitter returned null."],
      };
    }

    const parseErrors: string[] = [];
    const errorNodes = findAll(tree.rootNode, ["ERROR"]);
    for (const e of errorNodes) {
      parseErrors.push(
        `Syntax error at line ${e.startPosition.row + 1}: ${e.text.slice(0, 80)}`,
      );
    }

    const extractor = EXTRACTORS[tsLang];
    const symbols = extractor(tree.rootNode);

    // Extract classes
    const classes = CLASS_EXTRACTORS[tsLang]
      ? CLASS_EXTRACTORS[tsLang](tree.rootNode)
      : [];

    // Detect infrastructure patterns from all function bodies + imports
    const infraPatterns = detectInfraPatterns(tree.rootNode, language);

    return {
      file: filePath,
      language,
      symbols,
      functions: symbols.map(toLegacyFunctionInfo),
      classes,
      infraPatterns,
      dags: [],
      parseErrors,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Backward-compatible free functions (delegate to a shared instance)
// ─────────────────────────────────────────────────────────────

const _defaultParser = new CodeParser();

export function detectLanguage(filePath: string): SupportedLanguage | null {
  return _defaultParser.detectLanguage(filePath);
}

export async function parseSource(
  filePath: string,
  source: string,
): Promise<ParseResult> {
  return _defaultParser.parseSource(filePath, source);
}
