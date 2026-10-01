/**
 * C# type -> JSON Schema conversion.
 *
 * Handles predefined types, nullable value types, generics (collections,
 * Dictionary, Task/ActionResult wrappers), arrays, records/classes and enums.
 * Referenced model types become components via lazy ensure.
 */

import type { JsonSchema } from "../../core/types.js";
import type { CsTypeDef, CSharpAnalysis } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType } from "../treesitter/ast.js";

const INTEGER_TYPES = new Set(["int", "long", "short", "byte", "uint", "ulong", "ushort", "sbyte"]);
const NUMBER_TYPES = new Set(["float", "double", "decimal"]);
const STRING_TYPES = new Set(["string", "char", "Guid", "Uri", "Guid"]);
const DATE_TIME_TYPES = new Set(["DateTime", "DateTimeOffset"]);
const DATE_TYPES = new Set(["DateOnly"]);
const TIME_TYPES = new Set(["TimeOnly"]);

const COLLECTION_TYPES = new Set([
  "List",
  "IList",
  "ICollection",
  "IReadOnlyList",
  "IEnumerable",
  "IAsyncEnumerable",
  "Collection",
  "HashSet",
  "ISet",
  "Array",
]);

/** Unwrapping wrappers expose their generic argument directly. */
const WRAPPER_TYPES = new Set([
  "Task",
  "ValueTask",
  "ActionResult",
  "IHttpActionResult",
  "Nullable",
]);

export interface CsModelIndex {
  readonly byName: Map<string, CsTypeDef>;
  readonly components: Map<string, JsonSchema>;
}

export function buildCsModelIndex(analysis: CSharpAnalysis): CsModelIndex {
  return { byName: analysis.types, components: new Map() };
}

function genericName(node: TsNode): string | null {
  if (node.type === "generic_name") {
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  if (node.type === "identifier") return node.text;
  if (node.type === "qualified_name") {
    const right = node.namedChildren[node.namedChildren.length - 1];
    return right?.type === "identifier" ? right.text : null;
  }
  return null;
}

function typeArguments(node: TsNode): TsNode[] {
  const list = node.namedChildren.find((c) => c.type === "type_argument_list");
  return list ? list.namedChildren : [];
}

export function ensureCsComponent(
  name: string,
  index: CsModelIndex,
  stack: Set<string> = new Set(),
): void {
  if (index.components.has(name)) return;
  const def = index.byName.get(name);
  if (!def) return;
  if (stack.has(name)) return;
  stack.add(name);
  index.components.set(name, {});
  index.components.set(name, buildTypeSchema(def, index));
  stack.delete(name);
}

function buildTypeSchema(def: CsTypeDef, index: CsModelIndex): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length ? { type: "string", enum: [...def.enumValues] } : { type: "string" };
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of def.fields) {
    properties[field.name] = csTypeToSchema(field.typeNode, index);
    if (field.required) required.push(field.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function csTypeToSchema(
  node: TsNode | undefined,
  index: CsModelIndex,
  depth = 0,
): JsonSchema {
  if (!node || depth > 6) return {};

  if (node.type === "nullable_type") {
    const inner = node.namedChildren.find((c) => c.type !== "predefined_type" || true);
    return csTypeToSchema(inner, index, depth);
  }

  if (node.type === "array_type") {
    const inner = node.namedChildren.find(
      (c) =>
        c.type === "predefined_type" ||
        c.type === "identifier" ||
        c.type === "generic_name" ||
        c.type === "array_type" ||
        c.type === "nullable_type",
    );
    return {
      type: "array",
      items: inner ? csTypeToSchema(inner, index, depth + 1) : {},
    };
  }

  if (node.type === "predefined_type") {
    const t = node.text.trim();
    if (t === "string" || t === "char") return { type: "string" };
    if (t === "bool") return { type: "boolean" };
    if (INTEGER_TYPES.has(t)) {
      return { type: "integer", ...(t === "long" || t === "ulong" ? { format: "int64" } : {}) };
    }
    if (NUMBER_TYPES.has(t)) return { type: "number" };
    if (t === "object") return { type: "object" };
    if (t === "void") return {};
    return {};
  }

  if (node.type === "generic_name") {
    const name = genericName(node);
    const args = typeArguments(node);
    if (name && COLLECTION_TYPES.has(name)) {
      return {
        type: "array",
        items: args[0] ? csTypeToSchema(args[0], index, depth + 1) : {},
      };
    }
    if (name && (name === "Dictionary" || name === "IDictionary")) {
      return {
        type: "object",
        ...(args[1]
          ? { additionalProperties: csTypeToSchema(args[1], index, depth + 1) }
          : {}),
      };
    }
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return csTypeToSchema(args[0], index, depth + 1);
    }
    if (name && index.byName.has(name)) {
      ensureCsComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return {};
  }

  if (node.type === "identifier") {
    const name = node.text;
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) return { type: "integer" };
    if (NUMBER_TYPES.has(name)) return { type: "number" };
    if (name === "bool" || name === "Boolean") return { type: "boolean" };
    if (DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (DATE_TYPES.has(name)) return { type: "string", format: "date" };
    if (TIME_TYPES.has(name)) return { type: "string", format: "time" };
    if (name === "object" || name === "JsonElement" || name === "JsonDocument") {
      return { type: "object" };
    }
    if (index.byName.has(name)) {
      ensureCsComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return {};
  }

  if (node.type === "qualified_name") {
    const name = genericName(node);
    if (name && DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (name && STRING_TYPES.has(name)) return { type: "string" };
    return {};
  }

  return {};
}

/** All attributes on a declaration, as {name, node}. */
export function listAttributes(node: TsNode): { name: string; node: TsNode }[] {
  const out: { name: string; node: TsNode }[] = [];
  for (const list of childrenOfType(node, "attribute_list")) {
    for (const attr of childrenOfType(list, "attribute")) {
      const id = attr.namedChildren.find((c) => c.type === "identifier");
      if (id) out.push({ name: id.text.replace(/Attribute$/, ""), node: attr });
    }
  }
  return out;
}

export function findAttribute(node: TsNode, names: Set<string>): TsNode | null {
  return listAttributes(node).find((a) => names.has(a.name))?.node ?? null;
}

/** First string argument of an attribute, honoring Name= / Template= pairs. */
export function attributeStringArg(
  attribute: TsNode,
  argNames: Set<string> = new Set(["Name", "Template"]),
): string | null {
  const args = attribute.namedChildren.find((c) => c.type === "attribute_argument_list");
  if (!args) return null;
  for (const arg of childrenOfType(args, "attribute_argument")) {
    const pair = arg.namedChildren.find((c) => c.type === "name_equals");
    const literal = findStringLiteral(arg);
    if (!literal) continue;
    if (!pair) return literal;
    const key = pair.namedChildren.find((c) => c.type === "identifier");
    if (key && argNames.has(key.text)) return literal;
  }
  return null;
}

/** Positional or named argument node by order. */
export function attributeArguments(attribute: TsNode): TsNode[] {
  const args = attribute.namedChildren.find((c) => c.type === "attribute_argument_list");
  return args ? childrenOfType(args, "attribute_argument") : [];
}

function findStringLiteral(node: TsNode): string | null {
  let literal: TsNode | null = null;
  const walk = (n: TsNode) => {
    if (literal) return;
    if (n.type === "string_literal") {
      literal = n;
      return;
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
  const found = literal as TsNode | null;
  if (!found) return null;
  const raw = found.text;
  // Verbatim (@"...") and regular strings; strip quotes and unescape minimally.
  return raw
    .replace(/^[@$]?"/, "")
    .replace(/"$/, "")
    .replace(/""/g, '"')
    .replace(/\\"/g, '"');
}
