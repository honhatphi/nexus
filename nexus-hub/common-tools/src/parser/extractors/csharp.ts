// ─────────────────────────────────────────────────────────────
// C# Extractor — method_declaration, constructor_declaration, class/interface
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
} from "../ast-helpers.js";

export function extractCSharp(root: SyntaxNode): SymbolInfo[] {
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

export function extractCSharpClasses(root: SyntaxNode): ClassInfo[] {
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
