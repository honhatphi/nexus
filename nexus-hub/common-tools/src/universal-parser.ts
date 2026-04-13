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
import yaml from "js-yaml";
import { Parser, Language, Node as SyntaxNode } from "web-tree-sitter";
import type {
  SupportedLanguage,
  SymbolKind,
  SymbolInfo,
  Parameter,
  FunctionCall,
  InfraPattern,
  InfraKind,
  ClassInfo,
  ParseResult,
  DagInfo,
  DagTaskInfo,
} from "./types.js";
import { EXTENSION_MAP, toLegacyFunctionInfo } from "./types.js";

// ─────────────────────────────────────────────────────────────
// CodeParser
// ─────────────────────────────────────────────────────────────

type TreeSitterLanguage = Exclude<SupportedLanguage, "yaml">;

export class CodeParser {
  private static initPromise: Promise<void> | null = null;
  private static languageCache = new Map<TreeSitterLanguage, Language>();

  private static readonly WASM_FILES: Record<TreeSitterLanguage, string> = {
    go: "tree-sitter-go.wasm",
    python: "tree-sitter-python.wasm",
    php: "tree-sitter-php.wasm",
    typescript: "tree-sitter-typescript.wasm",
    csharp: "tree-sitter-c_sharp.wasm",
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
      require.resolve("tree-sitter-wasms/package.json"),
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
      return this.parseYamlDag(filePath, source);
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

  // ── YAML DAG Parser ─────────────────────────────────────

  private parseYamlDag(filePath: string, source: string): ParseResult {
    const parseErrors: string[] = [];
    const dags: DagInfo[] = [];

    let doc: unknown;
    try {
      doc = yaml.load(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parseErrors.push(`YAML parse error: ${msg}`);
      return {
        file: filePath,
        language: "yaml",
        symbols: [],
        functions: [],
        classes: [],
        infraPatterns: [],
        dags: [],
        parseErrors,
      };
    }

    if (!doc || typeof doc !== "object") {
      return {
        file: filePath,
        language: "yaml",
        symbols: [],
        functions: [],
        classes: [],
        infraPatterns: [],
        dags: [],
        parseErrors: ["YAML file has no top-level object."],
      };
    }

    // Each top-level key is a DAG name (Airflow dag-factory convention)
    for (const [dagName, dagDef] of Object.entries(
      doc as Record<string, unknown>,
    )) {
      if (!dagDef || typeof dagDef !== "object") continue;

      const dagObj = dagDef as Record<string, unknown>;
      const defaultArgs = (dagObj.default_args ?? {}) as Record<
        string,
        unknown
      >;
      const tasksObj = dagObj.tasks as Record<string, unknown> | undefined;

      const dagInfo: DagInfo = {
        name: dagName,
        scheduleInterval: asString(dagObj.schedule_interval),
        description: asString(dagObj.description),
        owner: asString(defaultArgs.owner),
        concurrency:
          typeof dagObj.concurrency === "number" ? dagObj.concurrency : null,
        tasks: [],
      };

      if (tasksObj && typeof tasksObj === "object") {
        for (const [taskName, taskDef] of Object.entries(tasksObj)) {
          if (!taskDef || typeof taskDef !== "object") continue;
          const t = taskDef as Record<string, unknown>;

          const task: DagTaskInfo = {
            name: taskName,
            operator: asString(t.operator) ?? "unknown",
            pythonCallableFile: asString(t.python_callable_file),
            pythonCallableName: asString(t.python_callable_name),
            bashCommand: asString(t.bash_command),
            sql: asString(t.sql),
            postgresConnId: asString(t.postgres_conn_id),
            dependencies: asStringArray(t.dependencies),
            opKwargs:
              t.op_kwargs && typeof t.op_kwargs === "object"
                ? (t.op_kwargs as Record<string, unknown>)
                : null,
            retries: typeof t.retries === "number" ? t.retries : null,
            executionTimeoutSecs:
              typeof t.execution_timeout_secs === "number"
                ? t.execution_timeout_secs
                : null,
          };

          dagInfo.tasks.push(task);
        }
      }

      dags.push(dagInfo);
    }

    return {
      file: filePath,
      language: "yaml",
      symbols: [],
      functions: [],
      classes: [],
      infraPatterns: [],
      dags,
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

// ─────────────────────────────────────────────────────────────
// AST Helpers (private)
// ─────────────────────────────────────────────────────────────

function textOf(node: SyntaxNode | null): string {
  return node?.text?.trim() ?? "";
}

function findAll(root: SyntaxNode, types: string[]): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  const cursor = root.walk();
  let reachedEnd = false;

  while (!reachedEnd) {
    if (types.includes(cursor.nodeType)) {
      results.push(cursor.currentNode);
    }
    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;
    while (true) {
      if (!cursor.gotoParent()) {
        reachedEnd = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
  }
  return results;
}

function extractCalls(body: SyntaxNode): FunctionCall[] {
  // "call_expression" → Go, TS; "function_call_expression" → PHP; "call" → Python; "invocation_expression" → C#
  const callNodes = findAll(body, [
    "call_expression",
    "function_call_expression",
    "call",
    "invocation_expression",
  ]);
  const calls: FunctionCall[] = [];
  for (const node of callNodes) {
    const fn = node.childForFieldName("function") ?? node.firstChild;
    if (fn) {
      calls.push({
        name: fn.text.trim(),
        line: node.startPosition.row + 1,
      });
    }
  }
  return calls;
}

// ─────────────────────────────────────────────────────────────
// Docstring Extraction
// ─────────────────────────────────────────────────────────────

function extractDocstring(node: SyntaxNode): string | null {
  // Strategy 1: consecutive comment siblings directly above the node
  let prev = node.previousNamedSibling;
  const commentLines: string[] = [];

  while (prev) {
    const type = prev.type;
    if (
      type === "comment" ||
      type === "doc_comment" ||
      type === "line_comment" ||
      type === "block_comment"
    ) {
      commentLines.unshift(prev.text.trim());
      prev = prev.previousNamedSibling;
    } else {
      break;
    }
  }

  if (commentLines.length > 0) {
    return cleanDocstring(commentLines.join("\n"));
  }

  // Strategy 2: Python docstring — expression_statement > string as first child of body
  const body = node.childForFieldName("body");
  if (body) {
    const firstStmt = body.firstNamedChild;
    if (firstStmt?.type === "expression_statement") {
      const strNode = firstStmt.firstNamedChild;
      if (
        strNode?.type === "string" ||
        strNode?.type === "concatenated_string"
      ) {
        return cleanDocstring(strNode.text);
      }
    }
  }

  // Strategy 3: PHP — doc_comment as first child of the declaration node itself
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === "doc_comment" || child.type === "comment")) {
      return cleanDocstring(child.text);
    }
    if (child && child.isNamed) break;
  }

  return null;
}

function cleanDocstring(raw: string): string {
  return raw
    .replace(/^\/\*\*?|\*\/$/g, "")
    .replace(/^['"`]{3}|['"`]{3}$/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\*\s?/, "")
        .replace(/^\s*\/{2,3}\s?/, "")
        .replace(/^\s*#\s?/, "")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Language-Specific Extractors
// ─────────────────────────────────────────────────────────────

function resolveKind(nodeType: string): SymbolKind {
  switch (nodeType) {
    case "method_declaration":
    case "method_definition":
    case "constructor_declaration":
      return "method";
    case "arrow_function":
      return "arrow_function";
    default:
      return "function";
  }
}

// ── Go ───────────────────────────────────────────────────────

function extractGo(root: SyntaxNode): SymbolInfo[] {
  const funcNodes = findAll(root, [
    "function_declaration",
    "method_declaration",
  ]);
  return funcNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const paramsNode = node.childForFieldName("parameters");
    const resultNode = node.childForFieldName("result");
    const bodyNode = node.childForFieldName("body");

    const params: Parameter[] = [];
    if (paramsNode) {
      const paramDecls = findAll(paramsNode, ["parameter_declaration"]);
      for (const pd of paramDecls) {
        const pName = pd.childForFieldName("name");
        const pType = pd.childForFieldName("type");
        params.push({ name: textOf(pName), type: textOf(pType) || null });
      }
    }

    return {
      name: textOf(nameNode),
      kind: resolveKind(node.type),
      params,
      returnType: textOf(resultNode) || null,
      docstring: extractDocstring(node),
      calls: bodyNode ? extractCalls(bodyNode) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

// ── Python ───────────────────────────────────────────────────

function extractPython(root: SyntaxNode): SymbolInfo[] {
  const funcNodes = findAll(root, ["function_definition"]);
  return funcNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const paramsNode = node.childForFieldName("parameters");
    const returnNode = node.childForFieldName("return_type");
    const bodyNode = node.childForFieldName("body");

    const params: Parameter[] = [];
    if (paramsNode) {
      for (const child of paramsNode.namedChildren) {
        if (!child) continue;
        if (child.type === "identifier") {
          params.push({ name: child.text, type: null });
        } else if (
          child.type === "typed_parameter" ||
          child.type === "typed_default_parameter"
        ) {
          const pName = child.firstNamedChild;
          const pType = child.childForFieldName("type");
          params.push({ name: textOf(pName), type: textOf(pType) || null });
        } else if (child.type === "default_parameter") {
          const pName = child.childForFieldName("name");
          params.push({ name: textOf(pName), type: null });
        }
      }
    }

    const isMethod =
      node.parent?.type === "block" &&
      node.parent.parent?.type === "class_definition";

    return {
      name: textOf(nameNode),
      kind: isMethod ? ("method" as SymbolKind) : ("function" as SymbolKind),
      params,
      returnType: textOf(returnNode) || null,
      docstring: extractDocstring(node),
      calls: bodyNode ? extractCalls(bodyNode) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

// ── PHP ──────────────────────────────────────────────────────

function extractPHP(root: SyntaxNode): SymbolInfo[] {
  const funcNodes = findAll(root, [
    "function_definition",
    "method_declaration",
  ]);
  return funcNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const paramsNode = node.childForFieldName("parameters");
    const returnNode = node.childForFieldName("return_type");
    const bodyNode = node.childForFieldName("body");

    const params: Parameter[] = [];
    if (paramsNode) {
      const simpleParams = findAll(paramsNode, ["simple_parameter"]);
      for (const sp of simpleParams) {
        const pName = sp.childForFieldName("name");
        const pType = sp.childForFieldName("type");
        params.push({ name: textOf(pName), type: textOf(pType) || null });
      }
    }

    return {
      name: textOf(nameNode),
      kind: resolveKind(node.type),
      params,
      returnType: textOf(returnNode) || null,
      docstring: extractDocstring(node),
      calls: bodyNode ? extractCalls(bodyNode) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

// ── TypeScript ───────────────────────────────────────────────

function extractTypeScript(root: SyntaxNode): SymbolInfo[] {
  const funcNodes = findAll(root, [
    "function_declaration",
    "method_definition",
    "arrow_function",
  ]);
  return funcNodes.map((node) => {
    const nameNode =
      node.childForFieldName("name") ??
      (node.parent?.type === "variable_declarator"
        ? node.parent.childForFieldName("name")
        : null);

    const paramsNode = node.childForFieldName("parameters");
    const returnNode = node.childForFieldName("return_type");
    const bodyNode = node.childForFieldName("body");

    const params: Parameter[] = [];
    if (paramsNode) {
      for (const child of paramsNode.namedChildren) {
        if (!child) continue;
        if (
          child.type === "required_parameter" ||
          child.type === "optional_parameter"
        ) {
          const pName =
            child.childForFieldName("pattern") ?? child.firstNamedChild;
          const pType = child.childForFieldName("type");
          params.push({ name: textOf(pName), type: textOf(pType) || null });
        } else if (child.type === "identifier") {
          params.push({ name: child.text, type: null });
        }
      }
    }

    // For arrow functions, docstring may be on the parent variable declaration
    const docNode =
      node.type === "arrow_function" &&
      node.parent?.type === "variable_declarator"
        ? (node.parent.parent ?? node)
        : node;

    return {
      name: textOf(nameNode),
      kind: resolveKind(node.type),
      params,
      returnType: textOf(returnNode) || null,
      docstring: extractDocstring(docNode),
      calls: bodyNode ? extractCalls(bodyNode) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

// ── C# ───────────────────────────────────────────────────────

function extractCSharp(root: SyntaxNode): SymbolInfo[] {
  const funcNodes = findAll(root, [
    "method_declaration",
    "constructor_declaration",
  ]);
  return funcNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const paramsNode = node.childForFieldName("parameters");
    const returnNode = node.childForFieldName("type");
    const bodyNode = node.childForFieldName("body");

    const params: Parameter[] = [];
    if (paramsNode) {
      for (const child of paramsNode.namedChildren) {
        if (!child || child.type !== "parameter") continue;
        const pName = child.childForFieldName("name");
        const pType = child.childForFieldName("type");
        params.push({ name: textOf(pName), type: textOf(pType) || null });
      }
    }

    const isMethod =
      node.parent?.type === "declaration_list" &&
      node.parent.parent?.type === "class_declaration";

    return {
      name: textOf(nameNode),
      kind: isMethod ? ("method" as SymbolKind) : ("function" as SymbolKind),
      params,
      returnType: textOf(returnNode) || null,
      docstring: extractDocstring(node),
      calls: bodyNode ? extractCalls(bodyNode) : [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

// ── Extractor Registry ───────────────────────────────────────

const EXTRACTORS: Record<
  TreeSitterLanguage,
  (root: SyntaxNode) => SymbolInfo[]
> = {
  go: extractGo,
  python: extractPython,
  php: extractPHP,
  typescript: extractTypeScript,
  csharp: extractCSharp,
};

// ─────────────────────────────────────────────────────────────
// Class Extraction
// ─────────────────────────────────────────────────────────────

function extractPythonClasses(root: SyntaxNode): ClassInfo[] {
  const classNodes = findAll(root, ["class_definition"]);
  return classNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const superclassNode = node.childForFieldName("superclasses");
    const bodyNode = node.childForFieldName("body");

    const bases: string[] = [];
    if (superclassNode) {
      for (const child of superclassNode.namedChildren) {
        if (!child) continue;
        bases.push(child.text.trim());
      }
    }

    const methods: string[] = [];
    if (bodyNode) {
      const methodNodes = findAll(bodyNode, ["function_definition"]);
      for (const m of methodNodes) {
        const mName = m.childForFieldName("name");
        if (mName) methods.push(mName.text.trim());
      }
    }

    return {
      name: textOf(nameNode),
      bases,
      methods,
      docstring: extractDocstring(node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

function extractCSharpClasses(root: SyntaxNode): ClassInfo[] {
  const classNodes = findAll(root, [
    "class_declaration",
    "interface_declaration",
  ]);
  return classNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const basesNode = node.childForFieldName("bases");
    const bodyNode = node.childForFieldName("body");

    const bases: string[] = [];
    if (basesNode) {
      for (const child of basesNode.namedChildren) {
        if (!child) continue;
        bases.push(child.text.trim());
      }
    }

    const methods: string[] = [];
    if (bodyNode) {
      const methodNodes = findAll(bodyNode, [
        "method_declaration",
        "constructor_declaration",
      ]);
      for (const m of methodNodes) {
        const mName = m.childForFieldName("name");
        if (mName) methods.push(mName.text.trim());
      }
    }

    return {
      name: textOf(nameNode),
      bases,
      methods,
      docstring: extractDocstring(node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}

const CLASS_EXTRACTORS: Partial<
  Record<SupportedLanguage, (root: SyntaxNode) => ClassInfo[]>
> = {
  python: extractPythonClasses,
  csharp: extractCSharpClasses,
};

// ─────────────────────────────────────────────────────────────
// Infrastructure Pattern Detection
// ─────────────────────────────────────────────────────────────

/**
 * Known function/method call patterns that indicate infrastructure usage.
 * Maps a regex pattern (matched against the callee text) to an InfraKind
 * and a strategy for extracting the target resource name.
 */
interface InfraRule {
  /** Regex matched against the full callee expression (e.g. "producer.produce") */
  pattern: RegExp;
  kind: InfraKind;
  /** Which positional argument (0-based) or keyword arg name holds the target */
  targetArg?: number | string;
  /** Fallback target label when we can't extract the arg */
  fallbackTarget: string;
  /** Human-readable description template. {target} is replaced. */
  detailTemplate: string;
  /** Extra keyword arguments to capture as metadata */
  metadataKeys?: string[];
}

const INFRA_RULES: InfraRule[] = [
  // ── Kafka Produce ──────────────────────────────────────
  {
    pattern: /\.produce$|\.send_async$|\.batch_produce$|MessageProducer/,
    kind: "kafka_produce",
    targetArg: 0,
    fallbackTarget: "<topic>",
    detailTemplate: "Produces to Kafka topic: {target}",
  },
  {
    pattern: /KafkaProducer$/,
    kind: "kafka_produce",
    fallbackTarget: "<kafka>",
    detailTemplate: "Creates Kafka producer",
  },
  // ── Kafka Consume ──────────────────────────────────────
  {
    pattern:
      /\.consume_batch$|\.sequential_consume$|MessageConsumer\.from_config|\.consume$|consume_cdc_messages/,
    kind: "kafka_consume",
    targetArg: "topic",
    fallbackTarget: "<topic>",
    detailTemplate: "Consumes from Kafka topic: {target}",
    metadataKeys: ["group_id"],
  },
  {
    pattern: /KafkaConsumer$/,
    kind: "kafka_consume",
    targetArg: 0,
    fallbackTarget: "<kafka>",
    detailTemplate: "Creates Kafka consumer for: {target}",
    metadataKeys: ["group_id"],
  },
  // ── PostgreSQL ─────────────────────────────────────────
  {
    pattern: /psycopg2\.connect$|PostgresHook$/,
    kind: "db_postgres",
    targetArg: "postgres_conn_id",
    fallbackTarget: "postgres",
    detailTemplate: "Connects to PostgreSQL: {target}",
  },
  {
    pattern: /execute_values$|\.execute$|\.executemany$/,
    kind: "db_postgres",
    fallbackTarget: "postgres",
    detailTemplate: "Executes SQL on PostgreSQL",
  },
  // ── MongoDB ────────────────────────────────────────────
  {
    pattern: /MongoHook$/,
    kind: "db_mongo",
    targetArg: "conn_id",
    fallbackTarget: "mongo",
    detailTemplate: "Connects to MongoDB: {target}",
  },
  {
    pattern: /\.insert_many$|\.insert_one$|\.find$|\.update_many$|\.aggregate$/,
    kind: "db_mongo",
    targetArg: "mongo_collection",
    fallbackTarget: "mongo",
    detailTemplate: "MongoDB operation on: {target}",
  },
  // ── Elasticsearch ──────────────────────────────────────
  {
    pattern: /^Elastic$|Elasticsearch$/,
    kind: "db_elasticsearch",
    targetArg: "index",
    fallbackTarget: "elasticsearch",
    detailTemplate: "Connects to Elasticsearch index: {target}",
  },
  {
    pattern: /helpers\.bulk$|\.search$|\.get_pit$|\.index$/,
    kind: "db_elasticsearch",
    fallbackTarget: "elasticsearch",
    detailTemplate: "Elasticsearch operation: {target}",
  },
  // ── HTTP ───────────────────────────────────────────────
  {
    pattern:
      /requests\.post$|requests\.get$|requests\.put$|requests\.patch$|requests\.delete$/,
    kind: "http_request",
    targetArg: 0,
    fallbackTarget: "<url>",
    detailTemplate: "HTTP request to: {target}",
  },
];

/**
 * Scan the entire file AST for infrastructure patterns.
 * Works for all supported languages but infra rules are tuned for Python patterns.
 */
function detectInfraPatterns(
  root: SyntaxNode,
  _language: string,
): InfraPattern[] {
  const patterns: InfraPattern[] = [];

  // Python uses "call" nodes; others use "call_expression"
  const callNodes = findAll(root, [
    "call",
    "call_expression",
    "function_call_expression",
  ]);

  for (const callNode of callNodes) {
    const fnNode =
      callNode.childForFieldName("function") ?? callNode.firstChild;
    if (!fnNode) continue;
    const callee = fnNode.text.trim();

    for (const rule of INFRA_RULES) {
      if (!rule.pattern.test(callee)) continue;

      const argsNode = callNode.childForFieldName("arguments");
      let target = rule.fallbackTarget;
      const metadata: Record<string, string> = {};

      if (argsNode) {
        // Try to extract target from arguments
        if (typeof rule.targetArg === "number") {
          target =
            extractPositionalStringArg(argsNode, rule.targetArg) ??
            rule.fallbackTarget;
        } else if (typeof rule.targetArg === "string") {
          target =
            extractKeywordStringArg(argsNode, rule.targetArg) ??
            rule.fallbackTarget;
        }

        // Extract metadata keys
        if (rule.metadataKeys) {
          for (const key of rule.metadataKeys) {
            const val = extractKeywordStringArg(argsNode, key);
            if (val) metadata[key] = val;
          }
        }
      }

      patterns.push({
        kind: rule.kind,
        target,
        detail: rule.detailTemplate.replace("{target}", target),
        line: callNode.startPosition.row + 1,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      break; // one rule per call node
    }
  }

  // Deduplicate: same kind+target within the same file → keep first occurrence
  const seen = new Set<string>();
  return patterns.filter((p) => {
    const key = `${p.kind}::${p.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract the string value of a positional argument (0-based index).
 * Handles Python argument_list: (pos0, pos1, key=val, ...)
 */
function extractPositionalStringArg(
  argsNode: SyntaxNode,
  index: number,
): string | null {
  let posIdx = 0;
  for (const child of argsNode.namedChildren) {
    if (!child) continue;
    // Skip keyword arguments (type = "keyword_argument" in Python)
    if (
      child.type === "keyword_argument" ||
      child.type === "spread_element" ||
      child.type === "dictionary_splat" ||
      child.type === "list_splat"
    )
      continue;
    if (posIdx === index) {
      return extractStringValue(child);
    }
    posIdx++;
  }
  return null;
}

/**
 * Extract the string value of a keyword argument by key name.
 */
function extractKeywordStringArg(
  argsNode: SyntaxNode,
  keyName: string,
): string | null {
  for (const child of argsNode.namedChildren) {
    if (!child) continue;
    if (child.type === "keyword_argument") {
      const nameNode = child.childForFieldName("name");
      const valueNode = child.childForFieldName("value");
      if (nameNode && nameNode.text.trim() === keyName && valueNode) {
        return extractStringValue(valueNode);
      }
    }
  }
  return null;
}

/**
 * Try to get a plain string value from a node (string literal, list of strings, env var).
 */
function extractStringValue(node: SyntaxNode): string | null {
  // String literal: "topic_name" or 'topic_name'
  if (node.type === "string") {
    const inner = node.text
      .replace(/^[bruf]*['"]{1,3}/i, "")
      .replace(/['"]{1,3}$/i, "");
    return inner || null;
  }
  // List literal: ["topic1", "topic2"]
  if (node.type === "list") {
    const items: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      const val = extractStringValue(child);
      if (val) items.push(val);
    }
    return items.length > 0 ? items.join(",") : null;
  }
  // os.getenv("VAR") or os.environ["VAR"] → extract the var name
  if (node.type === "call" || node.type === "call_expression") {
    const fn = node.childForFieldName("function") ?? node.firstChild;
    if (fn && /getenv|environ\.get/.test(fn.text)) {
      const args = node.childForFieldName("arguments");
      if (args) return extractPositionalStringArg(args, 0);
    }
  }
  // Variable reference or attribute access — return as-is for context
  if (node.type === "identifier" || node.type === "attribute") {
    return `$${node.text.trim()}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// YAML Helper Functions
// ─────────────────────────────────────────────────────────────

function asString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return String(val);
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => v != null).map(String);
}
