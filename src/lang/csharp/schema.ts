/**
 * C# type -> JSON Schema conversion.
 *
 * Handles predefined types, nullable value types, generics (collections,
 * Dictionary, Task/ActionResult wrappers), arrays, records/classes and enums.
 * Referenced model types become components via lazy ensure.
 */

import type { JsonSchema } from "../../core/types.js";
import type { CsField, CsTypeDef, CSharpAnalysis } from "./index.js";
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
  index.components.set(name, buildTypeSchema(def, index, undefined, 0));
  stack.delete(name);
}

/**
 * Type variable bindings. A binding is either a syntax node (plain identifier
 * chains) or a precomputed schema (compound expressions such as List<T> used
 * as a base-class generic argument, where the variable is shadowed in the
 * derived scope).
 */
type SubstValue = TsNode | JsonSchema;
type Subst = Map<string, SubstValue>;

function isNodeValue(value: SubstValue): value is TsNode {
  return typeof (value as TsNode).namedChildren !== "undefined";
}

function unwrapNullable(node: TsNode): TsNode {
  if (node.type === "nullable_type") {
    const inner = node.namedChildren.find((c) => c.type !== "predefined_type" || true);
    return inner ?? node;
  }
  return node;
}

/** Follows identifier-to-identifier bindings in the given scope. */
function resolveNode(node: TsNode, subst?: Subst): TsNode {
  if (node.type !== "identifier" || !subst?.has(node.text)) return node;
  const guard = new Set<string>([node.text]);
  let current: TsNode = node;
  while (current.type === "identifier" && subst.has(current.text)) {
    const bound = subst.get(current.text)!;
    if (!isNodeValue(bound)) return current;
    if (bound === current || guard.has(bound.text)) return current;
    guard.add(bound.text);
    current = bound;
  }
  return current;
}

/** Resolves a type expression to a node binding or a precomputed schema. */
function resolveValue(node: TsNode, subst?: Subst): SubstValue {
  const unwrapped = unwrapNullable(node);
  if (unwrapped.type === "identifier" && subst?.has(unwrapped.text)) {
    const bound = subst.get(unwrapped.text)!;
    if (!isNodeValue(bound)) return bound;
    return unwrapNullable(resolveNode(unwrapped, subst));
  }
  return unwrapped;
}

function schemaKey(schema: JsonSchema): string {
  const ref = (schema as { $ref?: string }).$ref;
  if (ref) return ref.split("/").pop() ?? "Type";
  const s = schema as {
    type?: string;
    items?: JsonSchema;
  };
  if (s.type === "array") {
    return `${schemaKey((s.items ?? {}) as JsonSchema)}List`;
  }
  if (s.type === "string") return "String";
  if (s.type === "integer") return "Int";
  if (s.type === "number") return "Double";
  if (s.type === "boolean") return "Boolean";
  if (s.type === "object") return "Object";
  return "Type";
}

const BOXED_PRIMITIVE_NAMES: Record<string, string> = {
  int: "Int",
  long: "Long",
  short: "Short",
  byte: "Byte",
  uint: "UInt",
  ulong: "ULong",
  ushort: "UShort",
  sbyte: "SByte",
  float: "Float",
  double: "Double",
  decimal: "Decimal",
  bool: "Boolean",
  char: "Char",
  string: "String",
  Guid: "Guid",
  DateTime: "DateTime",
  DateTimeOffset: "DateTimeOffset",
  DateOnly: "DateOnly",
  TimeOnly: "TimeOnly",
  object: "Object",
};

/** Deterministic component suffix for a concrete generic argument. */
function typeKey(value: SubstValue, index: CsModelIndex, subst?: Subst): string {
  if (!isNodeValue(value)) return schemaKey(value);
  const resolved = resolveNode(unwrapNullable(value), subst);
  if (resolved.type === "identifier" && subst?.has(resolved.text)) {
    const bound = subst.get(resolved.text)!;
    if (!isNodeValue(bound)) return schemaKey(bound);
  }
  if (resolved.type === "array_type") {
    const inner = resolved.namedChildren.find(
      (c) =>
        c.type === "predefined_type" ||
        c.type === "identifier" ||
        c.type === "generic_name" ||
        c.type === "array_type" ||
        c.type === "nullable_type",
    );
    return `${typeKey(inner ?? resolved, index, subst)}Array`;
  }
  if (resolved.type === "generic_name") {
    const name = genericName(resolved) ?? "Generic";
    if (COLLECTION_TYPES.has(name)) {
      const args = typeArguments(resolved);
      return args[0] ? `${typeKey(resolveValue(args[0], subst), index, subst)}List` : "List";
    }
    if (name === "Dictionary" || name === "IDictionary") {
      const args = typeArguments(resolved);
      return args[1] ? `Map_${typeKey(resolveValue(args[1], subst), index, subst)}` : "Map";
    }
    const args = typeArguments(resolved);
    // Specialize the referenced type first, then use its component name.
    if (index.byName.has(name) && args.length) {
      const specialized = ensureSpecializedCsComponent(resolved, index, subst, 0);
      return specialized ?? name;
    }
    return BOXED_PRIMITIVE_NAMES[name] ?? name;
  }
  if (resolved.type === "predefined_type") {
    return BOXED_PRIMITIVE_NAMES[resolved.text.trim()] ?? capitalize(resolved.text.trim());
  }
  if (resolved.type === "identifier") {
    if (BOXED_PRIMITIVE_NAMES[resolved.text]) return BOXED_PRIMITIVE_NAMES[resolved.text]!;
    return resolved.text;
  }
  if (resolved.type === "qualified_name") return genericName(resolved) ?? "Type";
  return "Type";
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function uniqueComponentName(index: CsModelIndex, desired: string): string {
  if (!index.components.has(desired) && !index.byName.has(desired)) return desired;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${desired}_${suffix}`;
    if (!index.components.has(candidate)) return candidate;
  }
  return `${desired}_${Date.now()}`;
}

/**
 * Builds a specialized component for a generic user type instantiation, for
 * example Result<UserDto> -> Result_UserDto. Type variables are bound
 * positionally, including through generic base classes.
 */
function ensureSpecializedCsComponent(
  node: TsNode,
  index: CsModelIndex,
  outerSubst: Subst | undefined,
  depth: number,
): string | null {
  if (depth > 6) return null;
  const name = genericName(node);
  if (!name) return null;
  const def = index.byName.get(name);
  if (!def || def.typeParameters.length === 0) return null;
  const rawArgs = typeArguments(node);
  if (!rawArgs.length) return null;
  const args: SubstValue[] = rawArgs.map((arg) => resolveValue(arg, outerSubst));

  const suffix = args.map((arg) => typeKey(arg, index, outerSubst)).join("_");
  const componentName = uniqueComponentName(index, `${name}_${suffix}`);
  if (index.components.has(componentName)) return componentName;
  index.components.set(componentName, {});

  const local: Subst = new Map(outerSubst ?? []);
  def.typeParameters.forEach((parameter, i) => {
    if (args[i]) local.set(parameter, args[i]!);
  });
  index.components.set(
    componentName,
    buildTypeSchema(def, index, local, depth + 1),
  );
  return componentName;
}

interface ChainField {
  field: CsField;
  subst?: Subst;
}

/** Collects fields through the base-class chain, mapping generic arguments. */
function collectChainFields(
  def: CsTypeDef,
  index: CsModelIndex,
  subst: Subst | undefined,
  depth: number,
  guard: Set<string>,
): ChainField[] {
  if (depth > 6 || guard.has(def.name)) return [];
  guard.add(def.name);
  const out: ChainField[] = [];

  if (def.baseList) {
    // The first resolvable class-like candidate is the base class; interfaces
    // are not indexed as type defs and are skipped.
    for (const candidate of def.baseList.namedChildren) {
      if (
        candidate.type !== "identifier" &&
        candidate.type !== "generic_name" &&
        candidate.type !== "qualified_name"
      ) {
        continue;
      }
      const baseName = genericName(candidate);
      const baseDef = baseName ? index.byName.get(baseName) : undefined;
      if (!baseDef) continue;
      const baseSubst = new Map(subst ?? []);
      if (candidate.type === "generic_name") {
        const args = typeArguments(candidate);
        baseDef.typeParameters.forEach((parameter, i) => {
          const arg = args[i];
          if (!arg) return;
          // Compound base arguments (e.g. Result<List<T>>) are evaluated in
          // the derived scope before the base variable shadows the name.
          const unwrapped = unwrapNullable(arg);
          if (
            unwrapped.type === "generic_name" ||
            unwrapped.type === "array_type"
          ) {
            baseSubst.set(
              parameter,
              csTypeToSchema(unwrapped, index, depth + 2, subst),
            );
          } else {
            baseSubst.set(parameter, resolveValue(unwrapped, subst));
          }
        });
      }
      out.push(
        ...collectChainFields(baseDef, index, baseSubst, depth + 1, guard),
      );
      break;
    }
  }

  for (const field of def.fields) out.push({ field, subst });
  return out;
}

function buildTypeSchema(
  def: CsTypeDef,
  index: CsModelIndex,
  subst?: Subst,
  depth = 0,
): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length ? { type: "string", enum: [...def.enumValues] } : { type: "string" };
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const { field, subst: fieldSubst } of collectChainFields(
    def,
    index,
    subst,
    depth,
    new Set(),
  )) {
    const propertyName = field.jsonName ?? field.name;
    properties[propertyName] = csTypeToSchema(field.typeNode, index, depth + 1, fieldSubst);
    if (field.required) required.push(propertyName);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function csTypeToSchema(
  node: TsNode | undefined,
  index: CsModelIndex,
  depth = 0,
  subst?: Subst,
): JsonSchema {
  if (!node || depth > 6) return {};
  const binding = resolveValue(node, subst);
  if (!isNodeValue(binding)) return binding;
  const resolved = binding;

  if (resolved.type === "nullable_type") {
    const inner = resolved.namedChildren.find((c) => c.type !== "predefined_type" || true);
    return csTypeToSchema(inner, index, depth, subst);
  }

  if (resolved.type === "array_type") {
    const inner = resolved.namedChildren.find(
      (c) =>
        c.type === "predefined_type" ||
        c.type === "identifier" ||
        c.type === "generic_name" ||
        c.type === "array_type" ||
        c.type === "nullable_type",
    );
    return {
      type: "array",
      items: inner ? csTypeToSchema(inner, index, depth + 1, subst) : {},
    };
  }

  if (resolved.type === "predefined_type") {
    const t = resolved.text.trim();
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

  if (resolved.type === "generic_name") {
    const name = genericName(resolved);
    const args = typeArguments(resolved);
    if (name && COLLECTION_TYPES.has(name)) {
      return {
        type: "array",
        items: args[0] ? csTypeToSchema(args[0], index, depth + 1, subst) : {},
      };
    }
    if (name && (name === "Dictionary" || name === "IDictionary")) {
      return {
        type: "object",
        ...(args[1]
          ? { additionalProperties: csTypeToSchema(args[1], index, depth + 1, subst) }
          : {}),
      };
    }
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return csTypeToSchema(args[0], index, depth + 1, subst);
    }
    if (name && index.byName.has(name)) {
      if (args.length && index.byName.get(name)?.typeParameters.length) {
        const specialized = ensureSpecializedCsComponent(resolved, index, subst, depth);
        if (specialized) return { $ref: `#/components/schemas/${specialized}` };
      }
      ensureCsComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
    return {};
  }

  if (resolved.type === "identifier") {
    const name = resolved.text;
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
