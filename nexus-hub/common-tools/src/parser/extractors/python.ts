// ─────────────────────────────────────────────────────────────
// Python Extractor — function_definition, class_definition
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

export function extractPython(root: SyntaxNode): SymbolInfo[] {
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
      className: isMethod ? ancestorName(node, ["class_definition"]) : null,
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

export function extractPythonClasses(root: SyntaxNode): ClassInfo[] {
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
