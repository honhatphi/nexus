// ─────────────────────────────────────────────────────────────
// Unified Schema — Shared output format for all parsed languages.
// This schema feeds into both Memgraph (graph nodes/edges) and
// ChromaDB (vector embeddings).
// ─────────────────────────────────────────────────────────────

export type SupportedLanguage = "go" | "python" | "php" | "typescript" | "csharp";

export const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".go": "go",
  ".py": "python",
  ".php": "php",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cs": "csharp",
};

// ── Symbol-level types ───────────────────────────────────────

/** The kind of a top-level symbol extracted from source code. */
export type SymbolKind = "function" | "method" | "arrow_function" | "class" | "interface";

export interface Parameter {
  name: string;
  type: string | null;
}

export interface FunctionCall {
  name: string;
  line: number;
}

// ── Infrastructure pattern types ─────────────────────────────

export type InfraKind =
  | "kafka_produce"
  | "kafka_consume"
  | "db_postgres"
  | "db_mongo"
  | "db_elasticsearch"
  | "http_request"
  | "class_inherit";

/**
 * An infrastructure relationship detected from code patterns.
 * E.g. a function that produces to a Kafka topic or connects to a database.
 */
export interface InfraPattern {
  /** What kind of infrastructure interaction this is. */
  kind: InfraKind;
  /** The target resource: topic name, db/collection, URL, base class. */
  target: string;
  /** Human-readable description of the relationship. */
  detail: string;
  /** 1-based source line where the pattern was detected. */
  line: number;
  /** Optional metadata (group_id, conn_id, index name, etc.). */
  metadata?: Record<string, string>;
}

/**
 * A class definition with its base classes.
 */
export interface ClassInfo {
  name: string;
  bases: string[];
  methods: string[];
  docstring: string | null;
  startLine: number;
  endLine: number;
}

/**
 * A single code symbol (function, method, arrow function …).
 * This is the **core unit** of the Unified Schema.
 */
export interface SymbolInfo {
  /** Symbol name (e.g. "handleRequest", "PaymentService.charge"). */
  name: string;
  /** What kind of symbol this is. */
  kind: SymbolKind;
  /** Ordered list of parameters with optional type annotations. */
  params: Parameter[];
  /** Return type annotation, if present. */
  returnType: string | null;
  /** Doc-comment / docstring attached to this symbol (raw text). */
  docstring: string | null;
  /** Functions/methods called inside this symbol's body. */
  calls: FunctionCall[];
  /** 1-based start line in the source file. */
  startLine: number;
  /** 1-based end line in the source file. */
  endLine: number;
}

// ── Backward-compatible alias ────────────────────────────────

/**
 * @deprecated Use `SymbolInfo` instead. Kept for backward compatibility.
 */
export interface FunctionInfo {
  name: string;
  parameters: Parameter[];
  returnType: string | null;
  calls: FunctionCall[];
  startLine: number;
  endLine: number;
}

/** Convert a SymbolInfo to the legacy FunctionInfo shape. */
export function toLegacyFunctionInfo(s: SymbolInfo): FunctionInfo {
  return {
    name: s.name,
    parameters: s.params,
    returnType: s.returnType,
    calls: s.calls,
    startLine: s.startLine,
    endLine: s.endLine,
  };
}

// ── File-level result ────────────────────────────────────────

export interface ParseResult {
  file: string;
  language: SupportedLanguage;
  /** All extracted symbols (Unified Schema). */
  symbols: SymbolInfo[];
  /**
   * @deprecated Use `symbols` instead. Populated automatically for backward compat.
   */
  functions: FunctionInfo[];
  /** Classes found in the file with inheritance info. */
  classes: ClassInfo[];
  /** Infrastructure patterns detected (Kafka, DB, HTTP, etc.). */
  infraPatterns: InfraPattern[];
  parseErrors: string[];
}
