// ─────────────────────────────────────────────────────────────
// AST Helpers — shared tree-sitter utilities used by all
// language extractors.
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SymbolKind, FunctionCall } from "../types.js";

// ── Node text ────────────────────────────────────────────────

export function textOf(node: SyntaxNode | null): string {
  return node?.text?.trim() ?? "";
}

// ── AST traversal ────────────────────────────────────────────

export function findAll(root: SyntaxNode, types: string[]): SyntaxNode[] {
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

// ── Call extraction ──────────────────────────────────────────

export function extractCalls(body: SyntaxNode): FunctionCall[] {
  // "call_expression" → Go, TS; "function_call_expression" → PHP;
  // "call" → Python; "invocation_expression" → C#
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

// ── Kind resolution ──────────────────────────────────────────

export function resolveKind(nodeType: string): SymbolKind {
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

// ── Docstring extraction ─────────────────────────────────────

export function extractDocstring(node: SyntaxNode): string | null {
  // Strategy 1: consecutive comment siblings directly above the node
  let prev = node.previousNamedSibling;
  const commentLines: string[] = [];

  while (prev) {
    const type = prev.type;
    if (
      type === "comment" ||
      type === "doc_comment" ||
      type === "line_comment" ||
      type === "block_comment" ||
      type === "documentation_comment"
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
