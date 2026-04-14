// ─────────────────────────────────────────────────────────────
// Extractor Registry — maps language → extractor function
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SupportedLanguage, SymbolInfo, ClassInfo } from "../../types.js";

import { extractGo } from "./go.js";
import { extractPython, extractPythonClasses } from "./python.js";
import { extractPHP } from "./php.js";
import { extractTypeScript, extractTSClasses } from "./typescript.js";
import { extractJava, extractJavaClasses } from "./java.js";
import { extractCSharp, extractCSharpClasses } from "./csharp.js";

// Tree-sitter languages (excludes "yaml" which uses js-yaml)
export type TreeSitterLanguage = Exclude<SupportedLanguage, "yaml">;

export const EXTRACTORS: Record<
  TreeSitterLanguage,
  (root: SyntaxNode) => SymbolInfo[]
> = {
  go: extractGo,
  python: extractPython,
  php: extractPHP,
  typescript: extractTypeScript,
  javascript: extractTypeScript, // JS uses same AST structure as TS
  java: extractJava,
  csharp: extractCSharp,
};

export const CLASS_EXTRACTORS: Partial<
  Record<SupportedLanguage, (root: SyntaxNode) => ClassInfo[]>
> = {
  python: extractPythonClasses,
  csharp: extractCSharpClasses,
  java: extractJavaClasses,
  typescript: extractTSClasses,
  javascript: extractTSClasses,
};
