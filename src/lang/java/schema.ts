/**
 * Java type -> JSON Schema conversion.
 *
 * Handles primitives, standard library types, collections, arrays, records,
 * POJOs and enums. Referenced model types become components via the same
 * lazy ensure/collect pattern used by the Go schema layer.
 */

import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { JavaAnalysis, JavaTypeDef } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findFirst } from "../treesitter/ast.js";

const STRING_TYPES = new Set([
  "String",
  "CharSequence",
  "Character",
  "char",
  "UUID",
  "URI",
  "URL",
  "UriComponents",
]);

const INTEGER_TYPES = new Set([
  "Integer",
  "int",
  "Long",
  "long",
  "Short",
  "short",
  "Byte",
  "byte",
  "BigInteger",
]);

const NUMBER_TYPES = new Set([
  "Double",
  "double",
  "Float",
  "float",
  "BigDecimal",
]);

const BOOLEAN_TYPES = new Set(["Boolean", "boolean"]);

const DATE_TIME_TYPES = new Set([
  "Instant",
  "Date",
  "Timestamp",
  "LocalDateTime",
  "OffsetDateTime",
  "ZonedDateTime",
  "Calendar",
]);

const DATE_TYPES = new Set(["LocalDate"]);
const TIME_TYPES = new Set(["LocalTime", "OffsetTime"]);

const COLLECTION_TYPES = new Set([
  "List",
  "Collection",
  "Set",
  "SortedSet",
  "NavigableSet",
  "Iterable",
  "Collection",
  "Page",
  "Slice",
  "Flux",
]);

/** Unwrapping wrappers expose their generic argument directly. */
const WRAPPER_TYPES = new Set(["Mono", "ResponseEntity", "Optional"]);

export interface JavaModelIndex {
  readonly byName: Map<string, JavaTypeDef>;
  readonly components: Map<string, JsonSchema>;
}

export function buildJavaModelIndex(analysis: JavaAnalysis): JavaModelIndex {
  return { byName: analysis.types, components: new Map() };
}

function simpleTypeName(node: TsNode): string | null {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "scoped_identifier") {
    return node.namedChildren[node.namedChildren.length - 1]?.text ?? null;
  }
  return null;
}

function genericArguments(node: TsNode): TsNode[] {
  const args = findFirst(node, (n) => n.type === "type_arguments");
  return args ? args.namedChildren : [];
}

export function ensureJavaComponent(
  name: string,
  index: JavaModelIndex,
  stack: Set<string> = new Set(),
): void {
  if (index.components.has(name)) return;
  const def = index.byName.get(name);
  if (!def) return;
  if (stack.has(name)) return;
  stack.add(name);
  index.components.set(name, {}); // reserve to break recursion
  index.components.set(name, buildTypeSchema(def, index));
  stack.delete(name);
}

function buildTypeSchema(def: JavaTypeDef, index: JavaModelIndex): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length ? { type: "string", enum: [...def.enumValues] } : { type: "string" };
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of def.fields) {
    properties[field.name] = javaTypeToSchema(field.typeNode, index);
    if (field.required) required.push(field.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function javaTypeToSchema(
  node: TsNode,
  index: JavaModelIndex,
  depth = 0,
): JsonSchema {
  if (depth > 6 || !node) return {};

  if (node.type === "array_type") {
    const inner = node.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "integral_type", "floating_point_type", "boolean_type", "scoped_identifier"].includes(c.type),
    );
    return {
      type: "array",
      items: inner ? javaTypeToSchema(inner, index, depth + 1) : {},
    };
  }

  if (node.type === "integral_type") {
    return { type: "integer", ...(node.text === "long" ? { format: "int64" } : {}) };
  }
  if (node.type === "floating_point_type") return { type: "number" };
  if (node.type === "boolean_type") return { type: "boolean" };
  if (node.type === "void_type") return {};

  if (node.type === "generic_type") {
    const name = simpleTypeName(node);
    const args = genericArguments(node);
    if (name && COLLECTION_TYPES.has(name)) {
      return {
        type: "array",
        items: args[0] ? javaTypeToSchema(args[0], index, depth + 1) : {},
      };
    }
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return javaTypeToSchema(args[0], index, depth + 1);
    }
    if (name === "Map" && args[1]) {
      return { type: "object", additionalProperties: javaTypeToSchema(args[1], index, depth + 1) };
    }
    if (name && index.byName.has(name)) {
      ensureJavaComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return {};
  }

  if (node.type === "scoped_identifier") {
    // Qualified standard types are opaque unless they map to known formats.
    const name = simpleTypeName(node);
    if (name && DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (name && DATE_TYPES.has(name)) return { type: "string", format: "date" };
    if (name && TIME_TYPES.has(name)) return { type: "string", format: "time" };
    if (name && STRING_TYPES.has(name)) return { type: "string" };
    return {};
  }

  if (node.type === "type_identifier") {
    const name = node.text;
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) {
      return name === "Long" || name === "long" || name === "BigInteger"
        ? { type: "integer", format: "int64" }
        : { type: "integer", format: "int32" };
    }
    if (NUMBER_TYPES.has(name)) return { type: "number" };
    if (BOOLEAN_TYPES.has(name)) return { type: "boolean" };
    if (DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (DATE_TYPES.has(name)) return { type: "string", format: "date" };
    if (TIME_TYPES.has(name)) return { type: "string", format: "time" };
    if (name === "Object" || name === "JsonObject" || name === "JsonNode") return { type: "object" };
    if (index.byName.has(name)) {
      ensureJavaComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return {};
  }

  return {};
}

/** Finds the first named annotation on a declaration (method/parameter). */
export function findAnnotation(node: TsNode, names: Set<string>): TsNode | null {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return null;
  for (const mod of mods.namedChildren) {
    if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
    const id = mod.namedChildren.find((c) => c.type === "identifier");
    if (id && names.has(id.text)) return mod;
  }
  return null;
}

/** All annotations on a declaration, as {name, node}. */
export function listAnnotations(
  node: TsNode,
): { name: string; node: TsNode }[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return [];
  return mods.namedChildren
    .filter((c) => c.type === "annotation" || c.type === "marker_annotation")
    .map((c) => ({
      name: c.namedChildren.find((n) => n.type === "identifier")?.text ?? "",
      node: c,
    }))
    .filter((a) => a.name);
}

/** First string argument of an annotation, supporting value/path/name pairs. */
export function annotationStringArg(
  annotation: TsNode,
  elementNames: Set<string> = new Set(["value", "path", "name"]),
): string | null {
  const args = childrenOfType(annotation, "annotation_argument_list")[0];
  if (!args) return null;
  for (const literal of findAllStrings(args)) {
    const pair = ancestorPair(annotation, literal);
    if (!pair || elementNames.has(pair)) return literal.text;
  }
  return null;
}

function findAllStrings(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  const walk = (n: TsNode) => {
    if (n.type === "string_literal") {
      const fragment = n.namedChildren.find((c) => c.type === "string_fragment");
      if (fragment) out.push(fragment);
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
  return out;
}

function ancestorPair(annotation: TsNode, fragment: TsNode): string | null {
  // Walk up from the fragment to see if it belongs to an element_value_pair.
  let current: TsNode | null = fragment;
  while (current && current !== annotation) {
    if (current.type === "element_value_pair") {
      const key = current.namedChildren.find((c) => c.type === "identifier");
      return key ? key.text : null;
    }
    current = current.parent;
  }
  return null;
}

/** annotation `required = false` / `required=false` presence. */
export function annotationElement(
  annotation: TsNode,
  elementName: string,
): TsNode | null {
  const args = childrenOfType(annotation, "annotation_argument_list")[0];
  if (!args) return null;
  for (const pair of childrenOfType(args, "element_value_pair")) {
    const key = pair.namedChildren.find((c) => c.type === "identifier");
    if (key && key.text === elementName) {
      return pair.namedChildren[pair.namedChildren.length - 1] ?? null;
    }
  }
  return null;
}
