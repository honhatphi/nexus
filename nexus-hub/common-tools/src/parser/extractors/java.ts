// ─────────────────────────────────────────────────────────────
// Java Extractor — method_declaration, constructor_declaration, class_declaration
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type {
  SymbolInfo,
  SymbolKind,
  Parameter,
  ClassInfo,
} from "../../types.js";
import {
  textOf,
  findAll,
  extractCalls,
  extractDocstring,
  ancestorName,
} from "../ast-helpers.js";

export function extractJava(root: SyntaxNode): SymbolInfo[] {
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
      const paramDecls = findAll(paramsNode, [
        "formal_parameter",
        "spread_parameter",
      ]);
      for (const pd of paramDecls) {
        const pName = pd.childForFieldName("name");
        const pType = pd.childForFieldName("type");
        params.push({ name: textOf(pName), type: textOf(pType) || null });
      }
    }

    const isMethod =
      node.parent?.type === "class_body" &&
      node.parent.parent?.type === "class_declaration";

    return {
      name: textOf(nameNode),
      className: isMethod
        ? ancestorName(node, ["class_declaration", "interface_declaration"])
        : null,
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

export function extractJavaClasses(root: SyntaxNode): ClassInfo[] {
  const classNodes = findAll(root, [
    "class_declaration",
    "interface_declaration",
  ]);
  return classNodes.map((node) => {
    const nameNode = node.childForFieldName("name");
    const bodyNode = node.childForFieldName("body");

    const bases: string[] = [];
    const superclass = node.childForFieldName("superclass");
    if (superclass) {
      bases.push(superclass.text.trim());
    }
    const interfaces = node.childForFieldName("interfaces");
    if (interfaces) {
      for (const child of interfaces.namedChildren) {
        if (!child) continue;
        bases.push(child.text.trim());
      }
    }

    const methods: string[] = [];
    if (bodyNode) {
      const methodNodes = findAll(bodyNode, ["method_declaration"]);
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
