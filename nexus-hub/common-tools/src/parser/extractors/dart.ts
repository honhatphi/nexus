// ─────────────────────────────────────────────────────────────
// Dart Extractor — Flutter + plain Dart
//
// tree-sitter-dart AST structure (differs from most other languages):
//   • Top-level function: function_signature + sibling function_body
//   • Class method:       method_signature(function_signature) + sibling function_body
//   • Class:              class_definition with class_body
//   • Params:             formal_parameter_list → formal_parameter / optional_formal_parameters
//   • Calls:              identifier/chain + selector(argument_part) siblings
// ─────────────────────────────────────────────────────────────

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { SymbolInfo, Parameter, ClassInfo, FunctionCall } from "../../types.js";
import { textOf, findAll, extractDocstring } from "../ast-helpers.js";

// ── Parameter extraction ─────────────────────────────────────

function extractDartParams(paramsNode: SyntaxNode | null): Parameter[] {
  if (!paramsNode) return [];
  const params: Parameter[] = [];

  for (const child of paramsNode.namedChildren) {
    if (!child) continue;

    if (
      child.type === "formal_parameter" ||
      child.type === "field_formal_parameter" ||
      child.type === "super_formal_parameter"
    ) {
      const named = child.namedChildren.filter(Boolean);
      const nameNode = named.find((c) => c!.type === "identifier");
      const typeNode = named.find(
        (c) =>
          c!.type === "type_identifier" ||
          c!.type === "void_type" ||
          c!.type === "predefined_type" ||
          c!.type === "nullable_type",
      );
      if (nameNode) params.push({ name: textOf(nameNode), type: typeNode ? textOf(typeNode) : null });
    } else if (
      child.type === "optional_formal_parameters" ||
      child.type === "named_formal_parameters"
    ) {
      // Wrapper for [] positional or {} named optional params — drill in
      for (const inner of child.namedChildren) {
        if (!inner || (inner.type !== "formal_parameter" && inner.type !== "field_formal_parameter")) continue;
        const named = inner.namedChildren.filter(Boolean);
        const nameNode = named.find((c) => c!.type === "identifier");
        const typeNode = named.find(
          (c) =>
            c!.type === "type_identifier" ||
            c!.type === "void_type" ||
            c!.type === "predefined_type" ||
            c!.type === "nullable_type",
        );
        if (nameNode) params.push({ name: textOf(nameNode), type: typeNode ? textOf(typeNode) : null });
      }
    }
  }
  return params;
}

// ── Call extraction ──────────────────────────────────────────
// In Dart, calls are: [expr chain] + selector(argument_part).
// Reconstruct callee from preceding chain to get the immediate function name.

function extractDartCalls(body: SyntaxNode): FunctionCall[] {
  const calls: FunctionCall[] = [];

  for (const argPart of findAll(body, ["argument_part"])) {
    const selectorNode = argPart.parent; // "selector" wrapping argument_part
    if (!selectorNode) continue;

    const prevSel = selectorNode.previousNamedSibling;
    let name: string | null = null;

    if (prevSel?.type === "selector") {
      // Method call: prev selector has unconditional_assignable_selector ".method"
      const accessor = prevSel.firstNamedChild;
      if (accessor?.type === "unconditional_assignable_selector") {
        const idNode = accessor.namedChildren.find((c) => c?.type === "identifier");
        if (idNode) name = idNode.text;
      }
    } else {
      // Direct call: identifier is a sibling in the parent chain expression
      const chain = selectorNode.parent;
      if (chain) {
        const idNode = chain.namedChildren.find((c) => c?.type === "identifier");
        if (idNode) name = idNode.text;
      }
    }

    if (name) calls.push({ name, line: argPart.startPosition.row + 1 });
  }
  return calls;
}

// ── Symbol extraction ────────────────────────────────────────

export function extractDart(root: SyntaxNode): SymbolInfo[] {
  const results: SymbolInfo[] = [];

  for (const sig of findAll(root, ["function_signature"])) {
    const nameNode = sig.namedChildren.find((c) => c?.type === "identifier");
    if (!nameNode) continue;

    // Return type: first type-like child (before identifier)
    const returnTypeNode = sig.namedChildren.find(
      (c) =>
        c != null &&
        c !== nameNode &&
        (c.type === "type_identifier" || c.type === "void_type" || c.type === "predefined_type"),
    );

    const paramsNode = sig.namedChildren.find((c) => c?.type === "formal_parameter_list") ?? null;

    const isMethod = sig.parent?.type === "method_signature";
    const docAnchor = isMethod ? sig.parent! : sig;
    const rawBodyNode = isMethod ? sig.parent!.nextNamedSibling : sig.nextNamedSibling;
    const validBody = rawBodyNode?.type === "function_body" ? rawBodyNode : null;

    results.push({
      name: textOf(nameNode),
      kind: isMethod ? "method" : "function",
      params: extractDartParams(paramsNode),
      returnType: returnTypeNode ? textOf(returnTypeNode) : null,
      docstring: extractDocstring(docAnchor),
      calls: validBody ? extractDartCalls(validBody) : [],
      startLine: sig.startPosition.row + 1,
      endLine: validBody ? validBody.endPosition.row + 1 : sig.endPosition.row + 1,
    });
  }

  return results;
}

// ── Class extraction ─────────────────────────────────────────

export function extractDartClasses(root: SyntaxNode): ClassInfo[] {
  return findAll(root, ["class_definition"]).map((node) => {
    const nameNode = node.namedChildren.find((c) => c?.type === "identifier");
    const classBody = node.namedChildren.find((c) => c?.type === "class_body");

    const bases: string[] = [];

    // "extends Super with MixinA" — mixins node nested inside superclass
    const superclassNode = node.namedChildren.find((c) => c?.type === "superclass");
    if (superclassNode) {
      const extType = superclassNode.namedChildren.find((c) => c?.type === "type_identifier");
      if (extType) bases.push(textOf(extType));
      const mixinsNode = superclassNode.namedChildren.find((c) => c?.type === "mixins");
      if (mixinsNode) {
        for (const t of mixinsNode.namedChildren) {
          if (t?.type === "type_identifier") bases.push(textOf(t));
        }
      }
    }

    // "implements InterfaceA, InterfaceB"
    const ifaceNode = node.namedChildren.find((c) => c?.type === "interfaces");
    if (ifaceNode) {
      for (const t of ifaceNode.namedChildren) {
        if (t?.type === "type_identifier") bases.push(textOf(t));
      }
    }

    // Methods from class_body
    const methods: string[] = [];
    if (classBody) {
      for (const ms of findAll(classBody, ["method_signature"])) {
        const innerSig = ms.namedChildren.find((c) => c?.type === "function_signature");
        if (innerSig) {
          const mName = innerSig.namedChildren.find((c) => c?.type === "identifier");
          if (mName) methods.push(textOf(mName));
        }
      }
    }

    return {
      name: textOf(nameNode ?? null),
      bases,
      methods,
      docstring: extractDocstring(node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  });
}
