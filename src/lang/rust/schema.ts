/**
 * Rust type -> JSON Schema conversion.
 *
 * Handles primitives, String/&str, Option<T>, Vec/HashSet/slices, HashMap,
 * Box/Arc/Rc, Result, chrono/uuid external types, named structs, tuple
 * structs, unit enums and simple generic instantiation (Page<User>).
 */

import type { JsonSchema } from "../../core/types.js";
import type { RustAnalysis, RustTypeDef } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType } from "../treesitter/ast.js";

const INTEGER_TYPES = new Set([
  "i8",
  "i16",
  "i32",
  "i64",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "usize",
]);
const NUMBER_TYPES = new Set(["f32", "f64"]);
const STRING_TYPES = new Set(["String", "str", "Cow", "char"]);
const DATE_TIME_TYPES = new Set([
  "DateTime",
  "NaiveDateTime",
  "SystemTime",
  "OffsetDateTime",
  "PrimitiveDateTime",
]);
const DATE_TYPES = new Set(["NaiveDate", "Date"]);
const TIME_TYPES = new Set(["NaiveTime", "Time"]);

const COLLECTION_TYPES = new Set([
  "Vec",
  "HashSet",
  "BTreeSet",
  "IndexSet",
  "LinkedList",
  "VecDeque",
]);

const WRAPPER_TYPES = new Set(["Option", "Box", "Arc", "Rc", "Result", "Cow"]);

export interface RustModelIndex {
  readonly byName: Map<string, RustTypeDef>;
  readonly components: Map<string, JsonSchema>;
}

export function buildRustModelIndex(analysis: RustAnalysis): RustModelIndex {
  return { byName: analysis.types, components: new Map() };
}

function genericName(node: TsNode): string | null {
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier") {
    const parts = node.text.split("::");
    return parts[parts.length - 1] ?? null;
  }
  return null;
}

function typeArguments(node: TsNode): TsNode[] {
  const list = node.namedChildren.find((c) => c.type === "type_arguments");
  return list ? list.namedChildren : [];
}

export function ensureRustComponent(
  name: string,
  index: RustModelIndex,
  stack: Set<string> = new Set(),
  genericArgs: TsNode[] = [],
  outerSubst: Map<string, TsNode> = new Map(),
): JsonSchema | null {
  const def = index.byName.get(name);
  if (!def) return null;

  // Generic instantiation produces an inline schema; concrete types become
  // components.
  if (def.generics.length && genericArgs.length === def.generics.length) {
    return instantiateGeneric(def, genericArgs, index, stack, outerSubst);
  }
  if (def.generics.length) return null;

  if (index.components.has(name)) {
    return { $ref: `#/components/schemas/${name}` };
  }
  if (stack.has(name)) return { $ref: `#/components/schemas/${name}` };
  stack.add(name);
  index.components.set(name, {});
  index.components.set(name, buildTypeSchema(def, index, stack));
  stack.delete(name);
  return { $ref: `#/components/schemas/${name}` };
}

function instantiateGeneric(
  def: RustTypeDef,
  genericArgs: TsNode[],
  index: RustModelIndex,
  stack: Set<string>,
  outerSubst: Map<string, TsNode> = new Map(),
): JsonSchema {
  const substitution = new Map<string, TsNode>(outerSubst);
  def.generics.forEach((param, i) => {
    if (genericArgs[i]) {
      // The argument may itself be an outer generic parameter (B<T> inside A<T>).
      const arg = genericArgs[i]!;
      substitution.set(
        param,
        arg.type === "type_identifier" && outerSubst.has(arg.text)
          ? outerSubst.get(arg.text)!
          : arg,
      );
    }
  });
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of def.fields) {
    properties[field.name] = rustTypeToSchema(field.typeNode, index, stack, 0, substitution);
    if (field.required) required.push(field.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function buildTypeSchema(
  def: RustTypeDef,
  index: RustModelIndex,
  stack: Set<string>,
): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length
      ? { type: "string", enum: [...def.enumValues] }
      : { type: "string" };
  }
  if (def.kind === "tuple-struct") {
    const items = def.tupleFields.map((field) =>
      rustTypeToSchema(field, index, stack, 0),
    );
    return { type: "array", items: items[0] ?? {} };
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of def.fields) {
    properties[field.name] = rustTypeToSchema(field.typeNode, index, stack, 0);
    if (field.required) required.push(field.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function rustTypeToSchema(
  node: TsNode | undefined,
  index: RustModelIndex,
  stack: Set<string> = new Set(),
  depth = 0,
  subst: Map<string, TsNode> = new Map(),
): JsonSchema {
  if (!node || depth > 6) return {};

  // Generic parameter in scope (T inside ApiResponse<T>): use the bound type.
  if (node.type === "type_identifier" && subst.has(node.text)) {
    return rustTypeToSchema(subst.get(node.text), index, stack, depth, subst);
  }

  if (node.type === "reference_type") {
    // &T / &str / &[T]
    const inner = node.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "primitive_type" ||
        c.type === "scoped_type_identifier" ||
        c.type === "array_type",
    );
    if (node.text.includes("[") && node.text.includes("]")) {
      const sliceInner = node.namedChildren.find((c) => c.type === "array_type");
      if (sliceInner) {
        const item = sliceInner.namedChildren.find(
          (c) =>
            c.type === "type_identifier" ||
            c.type === "generic_type" ||
            c.type === "primitive_type",
        );
        return { type: "array", items: item ? rustTypeToSchema(item, index, stack, depth + 1, subst) : {} };
      }
    }
    return inner ? rustTypeToSchema(inner, index, stack, depth, subst) : { type: "string" };
  }

  if (node.type === "primitive_type") {
    const t = node.text.trim();
    if (t === "bool") return { type: "boolean" };
    if (INTEGER_TYPES.has(t)) {
      return { type: "integer", ...(t === "i64" || t === "u64" || t === "isize" || t === "usize" ? { format: "int64" } : {}) };
    }
    if (NUMBER_TYPES.has(t)) return { type: "number" };
    if (t === "char") return { type: "string" };
    return {};
  }

  if (node.type === "array_type") {
    const item = node.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "primitive_type",
    );
    return { type: "array", items: item ? rustTypeToSchema(item, index, stack, depth + 1, subst) : {} };
  }

  if (node.type === "generic_type") {
    const name = genericName(node);
    const args = typeArguments(node);
    if (name && COLLECTION_TYPES.has(name)) {
      return {
        type: "array",
        items: args[0] ? rustTypeToSchema(args[0], index, stack, depth + 1, subst) : {},
      };
    }
    if (name === "Option") {
      return args[0] ? rustTypeToSchema(args[0], index, stack, depth, subst) : {};
    }
    if (name && (name === "HashMap" || name === "BTreeMap" || name === "IndexMap")) {
      return {
        type: "object",
        ...(args[1]
          ? { additionalProperties: rustTypeToSchema(args[1], index, stack, depth + 1, subst) }
          : {}),
      };
    }
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return rustTypeToSchema(args[0], index, stack, depth, subst);
    }
    if (name && (name === "Json" || name === "Extension")) {
      return args[0] ? rustTypeToSchema(args[0], index, stack, depth, subst) : {};
    }
    if (name && index.byName.has(name)) {
      const ref = ensureRustComponent(name, index, stack, args, subst);
      return ref ?? {};
    }
    return {};
  }

  if (node.type === "tuple_type") {
    const types = node.namedChildren.filter(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "primitive_type",
    );
    return {
      type: "array",
      items: types[0] ? rustTypeToSchema(types[0], index, stack, depth + 1, subst) : {},
    };
  }

  if (node.type === "type_identifier" || node.type === "scoped_type_identifier") {
    const name = genericName(node)!;
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) return { type: "integer" };
    if (NUMBER_TYPES.has(name)) return { type: "number" };
    if (name === "bool" || name === "Boolean") return { type: "boolean" };
    if (DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (DATE_TYPES.has(name)) return { type: "string", format: "date" };
    if (TIME_TYPES.has(name)) return { type: "string", format: "time" };
    if (name === "Uuid" || name === "Ulid") return { type: "string", format: "uuid" };
    if (name === "Value" || name === "JsonValue" || name === "serde_json::Value") {
      return { type: "object" };
    }
    if (index.byName.has(name)) {
      const ref = ensureRustComponent(name, index, stack);
      return ref ?? {};
    }
    return {};
  }

  if (node.type === "abstract_type") {
    // impl Trait — cannot be statically resolved.
    return {};
  }

  return {};
}

/** Struct fields as JSON Schema properties; used by extractor expansion. */
export function expandStructFields(
  typeNode: TsNode,
  index: RustModelIndex,
): { name: string; schema: JsonSchema; required: boolean }[] {
  const name =
    typeNode.type === "generic_type"
      ? typeNode.namedChildren.find((c) => c.type === "type_identifier")?.text
      : typeNode.type === "type_identifier"
        ? typeNode.text
        : null;
  if (!name) return [];
  const def = index.byName.get(name);
  if (!def) return [];
  const args = typeNode.type === "generic_type" ? typeArguments(typeNode) : [];
  const substitution = new Map<string, TsNode>();
  def.generics.forEach((param, i) => {
    if (args[i]) substitution.set(param, args[i]!);
  });
  return def.fields.map((field) => {
    return {
      name: field.name,
      schema: rustTypeToSchema(field.typeNode, index, new Set(), 0, substitution),
      required: field.required,
    };
  });
}

/** Named children of a parameter list. */
export function functionParameters(fn: TsNode): TsNode[] {
  const params = childrenOfType(fn, "parameters")[0];
  return params ? childrenOfType(params, "parameter") : [];
}
