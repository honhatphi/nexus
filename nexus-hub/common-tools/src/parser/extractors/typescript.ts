// ─────────────────────────────────────────────────────────────
// TypeScript Extractor — also reused for JavaScript
// function_declaration, method_definition, arrow_function, class_declaration
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SymbolInfo, Parameter, ClassInfo } from "../../types.js";
import {
  textOf,
  findAll,
  extractCalls,
  resolveKind,
  extractDocstring,
  ancestorName,
} from "../ast-helpers.js";

export function extractTypeScript(root: SyntaxNode): SymbolInfo[] {
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
      className:
        node.type === "method_definition"
          ? ancestorName(node, ["class_declaration"])
          : null,
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

export function extractTSClasses(root: SyntaxNode): ClassInfo[] {
  const classNodes = findAll(root, ["class_declaration"]);
  return classNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const bodyNode = node.childForFieldName("body");

    const bases: string[] = [];
    const heritageClauses = findAll(node, ["class_heritage"]);
    for (const clause of heritageClauses) {
      for (const child of clause.namedChildren) {
        if (!child) continue;
        bases.push(child.text.trim());
      }
    }

    const methods: string[] = [];
    if (bodyNode) {
      const methodNodes = findAll(bodyNode, ["method_definition"]);
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
