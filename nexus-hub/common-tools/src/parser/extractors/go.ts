// ─────────────────────────────────────────────────────────────
// Go Extractor — function_declaration, method_declaration
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SymbolInfo, Parameter } from "../../types.js";
import {
  textOf,
  findAll,
  extractCalls,
  resolveKind,
  extractDocstring,
} from "../ast-helpers.js";

export function extractGo(root: SyntaxNode): SymbolInfo[] {
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
