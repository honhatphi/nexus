// ─────────────────────────────────────────────────────────────
// PHP Extractor — function_definition, method_declaration
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SymbolInfo, Parameter } from "../../types.js";
import {
  textOf,
  findAll,
  extractCalls,
  resolveKind,
  extractDocstring,
  ancestorName,
} from "../ast-helpers.js";

export function extractPHP(root: SyntaxNode): SymbolInfo[] {
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
      className:
        node.type === "method_declaration"
          ? ancestorName(node, ["class_declaration", "interface_declaration"])
          : null,
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
