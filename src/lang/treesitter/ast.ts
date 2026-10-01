/**
 * Small language-neutral navigation layer over web-tree-sitter nodes.
 * Framework packs use these instead of binding to a grammar version.
 */

import type { TsNode } from "./runtime.js";

export function namedChildren(node: TsNode | null | undefined): TsNode[] {
  return node ? node.namedChildren : [];
}

export function childrenOfType(
  node: TsNode | null | undefined,
  type: string,
): TsNode[] {
  return namedChildren(node).filter((child) => child.type === type);
}

export function firstChildOfType(
  node: TsNode | null | undefined,
  type: string,
): TsNode | null {
  return namedChildren(node).find((child) => child.type === type) ?? null;
}

export function findFirst(
  node: TsNode | null | undefined,
  predicate: (node: TsNode) => boolean,
): TsNode | null {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.namedChildren) {
    const hit = findFirst(child, predicate);
    if (hit) return hit;
  }
  return null;
}

export function findAll(
  node: TsNode | null | undefined,
  predicate: (node: TsNode) => boolean,
  acc: TsNode[] = [],
): TsNode[] {
  if (!node) return acc;
  if (predicate(node)) acc.push(node);
  for (const child of node.namedChildren) findAll(child, predicate, acc);
  return acc;
}

/** Unwraps Python's `type` annotation wrapper node. */
export function unwrapType(node: TsNode | null | undefined): TsNode | null {
  let current = node ?? null;
  while (current && current.type === "type") {
    current = current.namedChildren[0] ?? null;
  }
  return current;
}

/** Unquotes a Python/Go string node, returning null for dynamic strings. */
export function literalString(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") {
    // f-strings share the "string" node type but contain interpolations.
    if (/^\s*[fF]/.test(node.text)) return null;
    const content = firstChildOfType(node, "string_content");
    return content ? content.text : node.text.slice(1, -1);
  }
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    // Go-style single string node without child structure.
    const raw = node.text;
    const quote = raw[0];
    if (quote !== '"' && quote !== "'") return null;
    return raw.slice(1, -1);
  }
  return null;
}

/** Keyword argument from a call node, e.g. call(arg_list(keyword_argument)). */
export function keywordArgument(
  callNode: TsNode | null | undefined,
  name: string,
): TsNode | null {
  if (!callNode) return null;
  for (const argList of childrenOfType(callNode, "argument_list")) {
    for (const kw of childrenOfType(argList, "keyword_argument")) {
      const key = kw.namedChildren[0];
      if (key && key.text === name) return kw.namedChildren[1] ?? null;
    }
    // Go-style: call arguments use key: value (handled by language packs).
  }
  return null;
}

/** Positional arguments of a call node. */
export function positionalArguments(
  callNode: TsNode | null | undefined,
): TsNode[] {
  if (!callNode) return [];
  const argList = firstChildOfType(callNode, "argument_list");
  if (!argList) return [];
  return argList.namedChildren.filter((child) => child.type !== "keyword_argument");
}

/**
 * For a call node shaped `receiver.method(...)`, returns [receiverNode, "method"].
 * Returns null for plain function calls.
 */
export function methodCall(
  node: TsNode | null | undefined,
): { receiver: TsNode; method: string; call: TsNode } | null {
  if (!node || node.type !== "call") return null;
  const fn = node.namedChildren[0];
  if (!fn || fn.type !== "attribute") return null;
  const receiver = fn.namedChildren[0];
  const method = fn.namedChildren[1];
  if (!receiver || !method) return null;
  return { receiver, method: method.text, call: node };
}

/** Integer literal value or null. */
export function literalInteger(node: TsNode | null | undefined): number | null {
  if (!node) return null;
  if (node.type === "integer") {
    const value = Number.parseInt(node.text.replace(/[_\s]/g, ""), 10);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** List/tuple/array literal element nodes. */
export function listElements(node: TsNode | null | undefined): TsNode[] {
  if (!node) return [];
  if (["list", "tuple", "array"].includes(node.type)) return node.namedChildren;
  return [];
}
