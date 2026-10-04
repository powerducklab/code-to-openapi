/**
 * Rust type -> JSON Schema conversion.
 *
 * Handles primitives, String/&str, Option<T>, Vec/HashSet/slices, HashMap,
 * Box/Arc/Rc, Result, chrono/uuid external types, named structs, tuple
 * structs, unit enums and simple generic instantiation (Page<User>).
 */

import type { JsonSchema } from "../../core/types.js";
import { extractTypeDef, type RustAnalysis, type RustTypeDef } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll } from "../treesitter/ast.js";

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
  readonly serialization?: boolean;
  readonly byName: Map<string, RustTypeDef>;
  readonly components: Map<string, JsonSchema>;
  readonly componentNames?: Map<string, string>;
  readonly aliases?: Map<string, TsNode>;
}

const typeOwners = new WeakMap<RustAnalysis, Map<string, Set<string>>>();

export function buildRustModelIndex(analysis: RustAnalysis, file?: string): RustModelIndex {
  if (!file) return { byName: analysis.types, components: new Map() };
  const byName = new Map(analysis.types);
  const componentNames = new Map<string, string>();
  const aliases = new Map<string, TsNode>();
  const root = analysis.files.get(file)?.root;
  let owners = typeOwners.get(analysis);
  if (!owners) {
    owners = new Map<string, Set<string>>();
    for (const [path, source] of analysis.files) for (const declaration of findAll(source.root, n => n.type === "struct_item" || n.type === "enum_item")) {
      const name = declaration.namedChildren.find(n => n.type === "type_identifier")?.text;
      if (name) { const files = owners.get(name) ?? new Set<string>(); files.add(path); owners.set(name, files); }
    }
    typeOwners.set(analysis, owners);
  }
  // Ambiguous names from other modules must not resolve to the first file.
  for (const [name, files] of owners) if (files.size > 1) byName.delete(name);
  if (root) for (const declaration of root.namedChildren) {
    const definition = extractTypeDef(declaration);
    if ((declaration.type === "struct_item" || declaration.type === "enum_item") && definition) {
      byName.set(definition.name, definition);
      if ((owners.get(definition.name)?.size ?? 0) > 1) componentNames.set(definition.name, `module_${Buffer.from(file).toString("hex")}_${definition.name}`);
    }
    if (declaration.type === "type_item") {
      const name = declaration.namedChildren.find(n => n.type === "type_identifier");
      const value = declaration.namedChildren.at(-1);
      if (name && value && value !== name) aliases.set(name.text, value);
    }
  }
  return { byName, components: new Map(), componentNames, aliases };
}

const serializationIndexes = new WeakMap<RustModelIndex, RustModelIndex>();
/** Separate serialized components: nullable input does not imply omitted output. */
export function rustSerializationIndex(index: RustModelIndex): RustModelIndex {
  const cached = serializationIndexes.get(index);
  if (cached) return cached;
  const names = new Map<string, string>();
  const reserved = new Set([...index.byName.keys(), ...index.components.keys(), ...(index.componentNames?.values() ?? [])]);
  for (const name of index.byName.keys()) {
    const base = `serialized_${index.componentNames?.get(name) ?? name}`;
    let candidate = base, suffix = 2;
    while (reserved.has(candidate)) candidate = `${base}_${suffix++}`;
    reserved.add(candidate); names.set(name, candidate);
  }
  const result = { ...index, serialization: true, componentNames: names };
  serializationIndexes.set(index, result);
  return result;
}

function genericName(node: TsNode): string | null {
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier")?.text.split("::").pop() ?? null;
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
  return list ? list.namedChildren.filter(n => n.type !== "lifetime") : [];
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
  if(index.serialization&&def.serializationSchema)return def.serializationSchema;

  if(def.generics.length&&genericArgs.length<def.generics.length){
    const completed=[...genericArgs];
    for(let i=completed.length;i<def.generics.length;i++){const value=def.genericDefaults?.get(def.generics[i]!);if(!value)break;completed.push(value);}
    genericArgs=completed;
  }
  // Generic instantiation produces an inline schema; concrete types become
  // components.
  if (def.generics.length && genericArgs.length === def.generics.length) {
    // Recursive generic expansion is inline. Bound it before descending;
    // a recursive payload must not overflow the scanner's call stack.
    const key = `generic:${name}`;
    if (stack.has(key) || stack.size >= 16) return {};
    stack.add(key);
    try { return instantiateGeneric(def, genericArgs, index, stack, outerSubst); }
    finally { stack.delete(key); }
  }
  if (def.generics.length) return null;

  const componentName = index.componentNames?.get(name) ?? name;
  if (index.components.has(componentName)) {
    return { $ref: `#/components/schemas/${componentName}` };
  }
  if (stack.has(name)) return { $ref: `#/components/schemas/${componentName}` };
  stack.add(name);
  index.components.set(componentName, {});
  index.components.set(componentName, buildTypeSchema(def, index, stack));
  stack.delete(name);
  return { $ref: `#/components/schemas/${componentName}` };
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
    if (index.serialization ? field.skipSerializing : field.skipDeserializing) continue;
    properties[field.name] = rustTypeToSchema(field.typeNode, index, stack, 0, substitution);
    if (index.serialization ? field.serializeRequired !== false : field.required) required.push(field.name);
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
    if(items.length===1)return items[0]??{};
    return { type: "array", prefixItems:items, minItems:items.length, maxItems:items.length };
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of def.fields) {
    if (index.serialization ? field.skipSerializing : field.skipDeserializing) continue;
    properties[field.name] = rustTypeToSchema(field.typeNode, index, stack, 0);
    if (index.serialization ? field.serializeRequired !== false : field.required) required.push(field.name);
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
    return rustTypeToSchema(subst.get(node.text), index, stack, depth + 1, subst);
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
    return inner ? rustTypeToSchema(inner, index, stack, depth + 1, subst) : { type: "string" };
  }

  if (node.type === "primitive_type") {
    const t = node.text.trim();
    if (t === "bool") return { type: "boolean" };
    if (INTEGER_TYPES.has(t)) {
      return { type: "integer", ...(t === "i32" ? { format: "int32" } : {}), ...(t === "i64" || t === "u64" || t === "isize" || t === "usize" ? { format: "int64" } : {}) };
    }
    if (NUMBER_TYPES.has(t)) return { type: "number" };
    if (t === "char" || t === "str") return { type: "string" };
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
      const inner = args[0] ? rustTypeToSchema(args[0], index, stack, depth + 1, subst) : {};
      // Missing and null are independent: Option fields may be omitted on
      // input, but their JSON value can explicitly be null as well.
      if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
      if (Array.isArray(inner.type)) return { ...inner, type: [...new Set([...inner.type, "null"])] };
      return Object.keys(inner).length ? { anyOf: [inner, { type: "null" }] } : {};
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
      return rustTypeToSchema(args[0], index, stack, depth + 1, subst);
    }
    if (name && (name === "Json" || name === "Extension")) {
      return args[0] ? rustTypeToSchema(args[0], index, stack, depth + 1, subst) : {};
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
    const alias = node.type === "type_identifier" ? index.aliases?.get(name) : undefined;
    if (alias) return rustTypeToSchema(alias, index, stack, depth + 1, subst);
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) return { type: "integer", ...(name === "i32" ? { format: "int32" } : {}) };
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
  return def.fields.filter(field => !field.skipDeserializing).map((field) => {
    return {
      name: field.name,
      schema: rustTypeToSchema(genericName(field.typeNode) === "Option" ? typeArguments(field.typeNode)[0] : field.typeNode, index, new Set(), 0, substitution),
      required: field.required,
    };
  });
}

/** Named children of a parameter list. */
export function functionParameters(fn: TsNode): TsNode[] {
  const params = childrenOfType(fn, "parameters")[0];
  return params ? childrenOfType(params, "parameter") : [];
}
