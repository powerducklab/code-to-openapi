/**
 * Java type -> JSON Schema conversion.
 *
 * Handles primitives, standard library types, collections, arrays, records,
 * POJOs and enums. Referenced model types become components via the same
 * lazy ensure/collect pattern used by the Go schema layer.
 */

import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { JavaAnalysis, JavaField, JavaTypeDef } from "./index.js";
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

/**
 * Maps a generic class's type parameter names to the concrete type nodes used at
 * a particular instantiation, e.g. CommonResult<Foo> maps "T" to the Foo node.
 */
type Subst = Map<string, TsNode>;

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

/** Resolve a type variable to its substituted node; pass other nodes through. */
function resolveSubst(node: TsNode, subst?: Subst): TsNode {
  if (node.type === "type_identifier" && subst?.has(node.text)) {
    return subst.get(node.text)!;
  }
  return node;
}

/** Jackson camelCase to snake_case conversion used by SnakeCaseStrategy. */
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function propertyName(field: JavaField, naming: JavaTypeDef["naming"]): string {
  if (field.jsonName) return field.jsonName;
  return naming === "snake_case" ? toSnakeCase(field.name) : field.name;
}

/**
 * Deterministic, filesystem-safe key describing a concrete type argument, used
 * to name specialized generic components such as CommonResult_Foo.
 */
function typeKey(node: TsNode, subst?: Subst): string {
  const resolved = resolveSubst(node, subst);
  if (resolved.type === "type_identifier") return resolved.text;
  if (resolved.type === "scoped_identifier") return simpleTypeName(resolved) ?? "Object";
  if (resolved.type === "integral_type") {
    return resolved.text === "long" ? "Long" : resolved.text.charAt(0).toUpperCase() + resolved.text.slice(1);
  }
  if (resolved.type === "floating_point_type") {
    return resolved.text === "double" ? "Double" : "Float";
  }
  if (resolved.type === "boolean_type") return "Boolean";
  if (resolved.type === "array_type") {
    const inner = resolved.namedChildren.find((c) => c.type === "type_identifier" || c.type === "generic_type");
    return `${typeKey(inner ?? resolved, subst)}Array`;
  }
  if (resolved.type === "generic_type") {
    const name = simpleTypeName(resolved) ?? "Object";
    const args = genericArguments(resolved);
    if (COLLECTION_TYPES.has(name)) {
      return `${typeKey(args[0] ?? resolved, subst)}List`;
    }
    if (name === "Map") return `Map_${typeKey(args[1] ?? resolved, subst)}`;
    return args.length
      ? `${name}_${args.map((arg) => typeKey(arg, subst)).join("_")}`
      : name;
  }
  return "Object";
}

function uniqueComponentName(base: string, index: JavaModelIndex): string {
  if (!index.components.has(base) && !index.byName.has(base)) return base;
  let suffix = 2;
  while (index.components.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
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
  index.components.set(name, buildTypeSchema(def, index, undefined, 0));
  stack.delete(name);
}

/**
 * Build (once) a specialized component for a generic class instantiated with
 * concrete type arguments, substituting its type parameters throughout the
 * class hierarchy (including generic superclasses).
 */
function ensureSpecializedComponent(
  def: JavaTypeDef,
  index: JavaModelIndex,
  subst: Subst,
  args: TsNode[],
  depth: number,
): string {
  const base = `${def.name}_${args.map((arg) => typeKey(arg, subst)).join("_")}`;
  const name = uniqueComponentName(base, index);
  if (index.components.has(name)) return name;
  index.components.set(name, {}); // reserve to break recursion
  const local = new Map(subst);
  def.typeParameters.forEach((parameter, i) => {
    if (args[i]) local.set(parameter, resolveSubst(args[i]!, subst));
  });
  index.components.set(name, buildTypeSchema(def, index, local, depth + 1));
  return name;
}

interface ChainField {
  field: JavaField;
  subst?: Subst;
}

/**
 * Collect fields from the full inheritance chain, most abstract first. The
 * superclass's type parameters are mapped from the concrete type arguments used
 * by each subclass (which may themselves be type variables).
 */
function collectChainFields(
  def: JavaTypeDef,
  index: JavaModelIndex,
  subst: Subst | undefined,
  depth: number,
  guard: Set<string>,
): ChainField[] {
  if (depth > 6 || guard.has(def.name)) return [];
  guard.add(def.name);
  const out: ChainField[] = [];
  if (def.superclass) {
    const superNode = resolveSubst(def.superclass, subst);
    const superName = simpleTypeName(superNode);
    const superDef = superName ? index.byName.get(superName) : undefined;
    if (superDef) {
      const superSubst = new Map(subst ?? []);
      if (superNode.type === "generic_type") {
        const args = genericArguments(superNode);
        superDef.typeParameters.forEach((parameter, i) => {
          if (args[i]) superSubst.set(parameter, resolveSubst(args[i]!, subst));
        });
      }
      out.push(
        ...collectChainFields(superDef, index, superSubst, depth + 1, guard),
      );
    }
  }
  for (const field of def.fields) {
    out.push({ field, subst });
  }
  return out;
}

/**
 * Jackson naming strategies are inherited: @JsonNaming on a superclass also
 * renames the properties it contributes to a subtype. Walk the superclass
 * chain so subtype components serialize with the same property names.
 */
function effectiveNaming(
  def: JavaTypeDef,
  index: JavaModelIndex,
): "snake_case" | "default" {
  const guard = new Set<string>();
  let current: JavaTypeDef | undefined = def;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current.naming === "snake_case") return "snake_case";
    if (!current.superclass) break;
    const superName = simpleTypeName(current.superclass);
    if (!superName || guard.has(superName)) break;
    guard.add(superName);
    current = index.byName.get(superName);
  }
  return "default";
}

function buildTypeSchema(
  def: JavaTypeDef,
  index: JavaModelIndex,
  subst?: Subst,
  depth = 0,
): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length ? { type: "string", enum: [...def.enumValues] } : { type: "string" };
  }

  // Jackson @JsonTypeInfo(NAME) + @JsonSubTypes: emit a discriminated oneOf.
  // Subtype components carry the inherited base fields through the normal
  // superclass chain, so every member schema stays self-contained.
  if (def.discriminator) {
    const oneOf: JsonSchema[] = [];
    const mapping: Record<string, string> = {};
    for (const subtype of def.discriminator.subtypes) {
      if (!index.byName.has(subtype.type)) continue;
      ensureJavaComponent(subtype.type, index);
      const ref = `#/components/schemas/${subtype.type}`;
      oneOf.push({ $ref: ref });
      mapping[subtype.name] = ref;
    }
    if (oneOf.length) {
      return {
        oneOf,
        discriminator: {
          propertyName: def.discriminator.property,
          mapping,
        },
      };
    }
  }

  // The inheritance chain gets its own cycle guard; it must not reuse the
  // component-recursion stack, which already contains the root class name.
  const chain = collectChainFields(def, index, subst, depth, new Set());
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const naming = effectiveNaming(def, index);
  for (const { field, subst: fieldSubst } of chain) {
    if (field.ignored) continue;
    const name = propertyName(field, naming);
    properties[name] = javaTypeToSchema(field.typeNode, index, depth + 1, fieldSubst);
    if (field.required) required.push(name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function javaTypeToSchema(
  node: TsNode,
  index: JavaModelIndex,
  depth = 0,
  subst?: Subst,
): JsonSchema {
  if (depth > 6 || !node) return {};
  node = resolveSubst(node, subst);

  if (node.type === "array_type") {
    const inner = node.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "integral_type", "floating_point_type", "boolean_type", "scoped_identifier"].includes(c.type),
    );
    return {
      type: "array",
      items: inner ? javaTypeToSchema(inner, index, depth + 1, subst) : {},
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
        items: args[0] ? javaTypeToSchema(args[0], index, depth + 1, subst) : {},
      };
    }
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return javaTypeToSchema(args[0], index, depth + 1, subst);
    }
    if (name === "Map" && args[1]) {
      return { type: "object", additionalProperties: javaTypeToSchema(args[1], index, depth + 1, subst) };
    }
    if (name && index.byName.has(name)) {
      const def = index.byName.get(name)!;
      if (def.typeParameters.length && args.length) {
        const componentName = ensureSpecializedComponent(def, index, subst ?? new Map(), args, depth);
        return { $ref: `#/components/schemas/${componentName}` };
      }
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
    if (name === "Object" || name === "JsonObject" || name === "JsonNode" || name === "ObjectNode" || name === "JsonElement" || name === "JsonValue") return { type: "object" };
    if (name === "ArrayNode" || name === "JsonArray") return { type: "array", items: {} };
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
