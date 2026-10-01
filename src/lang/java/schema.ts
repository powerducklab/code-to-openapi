/**
 * Java type -> JSON Schema conversion.
 *
 * Handles primitives, standard library types, collections, maps, arrays,
 * records, POJOs, enums, interfaces (getter-derived properties), generic
 * specialization and fully qualified references. Referenced model types become
 * components via a lazy ensure/collect pattern keyed by FQN, so classes that
 * share a simple name across packages never overwrite each other.
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
  "CharBuffer",
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
  "AtomicInteger",
  "AtomicLong",
]);

const NUMBER_TYPES = new Set([
  "Double",
  "double",
  "Float",
  "float",
  "BigDecimal",
  "Number",
]);

const BOOLEAN_TYPES = new Set(["Boolean", "boolean", "AtomicBoolean"]);

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

/** Anything that serializes as a JSON array of its first type argument. */
const COLLECTION_TYPES = new Set([
  "List",
  "Collection",
  "Set",
  "SortedSet",
  "NavigableSet",
  "Iterable",
  "ArrayList",
  "LinkedList",
  "Vector",
  "Stack",
  "HashSet",
  "LinkedHashSet",
  "TreeSet",
  "EnumSet",
  "Queue",
  "Deque",
  "ArrayDeque",
  "PriorityQueue",
  "Stream",
  "LongStream",
  "IntStream",
  "DoubleStream",
  "Flux",
  "Flowable",
  "Observable",
]);

/** Scalar stream types (no element argument). */
const SCALAR_STREAM_TYPES = new Set(["LongStream", "IntStream", "DoubleStream"]);

/** Anything that serializes as a JSON object keyed by its second type argument. */
const MAP_TYPES = new Set([
  "Map",
  "HashMap",
  "LinkedHashMap",
  "TreeMap",
  "ConcurrentHashMap",
  "SortedMap",
  "NavigableMap",
  "WeakHashMap",
  "EnumMap",
]);

/** Spring Data pagination envelopes (content + page metadata). */
const PAGE_TYPES = new Set(["Page", "PageImpl", "Slice", "SliceImpl"]);

/** Unwrapping wrappers expose their generic argument directly. */
const WRAPPER_TYPES = new Set([
  "Mono",
  "Single",
  "Maybe",
  "CompletableFuture",
  "CompletionStage",
  "ListenableFuture",
  "Future",
  "Callable",
  "Supplier",
  "ResponseEntity",
  "Optional",
]);

/** Free-form JSON objects (no statically known properties). */
const JSON_OBJECT_TYPES = new Set(["JSONObject", "ObjectNode", "JsonObject", "Object"]);

/** Free-form JSON arrays; elements are unconstrained JSON values. */
const JSON_ARRAY_TYPES = new Set(["JSONArray", "ArrayNode", "JsonArray"]);

/** Dynamic JSON trees; rendered as free-form objects to stay explicit. */
const JSON_VALUE_TYPES = new Set(["JsonNode", "JsonElement", "JsonValue"]);

/**
 * Maps a generic class's type parameter names to the concrete type nodes used at
 * a particular instantiation, e.g. CommonResult<Foo> maps "T" to the Foo node.
 */
type Subst = Map<string, TsNode>;

export interface JavaModelIndex {
  readonly byName: Map<string, JavaTypeDef>;
  readonly components: Map<string, JsonSchema>;
  resolveDef(name: string, fileRel?: string): JavaTypeDef | undefined;
  resolveFqn(fqn: string): JavaTypeDef | undefined;
}

export function buildJavaModelIndex(analysis: JavaAnalysis): JavaModelIndex {
  const components = new Map<string, JsonSchema>();
  const aliasByFqn = new Map<string, string>();
  const aliasTaken = new Set<string>();

  const aliasForDef = (def: JavaTypeDef): string => {
    const cached = aliasByFqn.get(def.fqn);
    if (cached) return cached;
    let alias = def.name;
    if (aliasTaken.has(alias)) {
      let suffix = 2;
      while (aliasTaken.has(`${def.name}_${suffix}`)) suffix += 1;
      alias = `${def.name}_${suffix}`;
    }
    aliasTaken.add(alias);
    aliasByFqn.set(def.fqn, alias);
    return alias;
  };

  const resolveFqn = (fqn: string): JavaTypeDef | undefined =>
    analysis.typesByFqn.get(fqn);

  const resolveDef = (name: string, fileRel?: string): JavaTypeDef | undefined => {
    // Fully qualified reference.
    if (name.includes(".")) {
      const exact = analysis.typesByFqn.get(name);
      if (exact) return exact;
      const tail = name.slice(name.lastIndexOf(".") + 1);
      return analysis.types.get(tail);
    }
    if (fileRel) {
      const table = analysis.imports.get(fileRel);
      if (table) {
        const explicit = table.explicit.get(name);
        if (explicit) {
          const def = analysis.typesByFqn.get(explicit);
          if (def) return def;
        }
        // Same-package type.
        if (table.packageName) {
          const samePackage = analysis.typesByFqn.get(`${table.packageName}.${name}`);
          if (samePackage) return samePackage;
        }
        // Wildcard imports: first matching package wins.
        for (const pkg of table.wildcards) {
          const wildcard = analysis.typesByFqn.get(`${pkg}.${name}`);
          if (wildcard) return wildcard;
        }
      }
    }
    return analysis.types.get(name);
  };

  const index: JavaModelIndex = {
    byName: analysis.types,
    components,
    resolveDef,
    resolveFqn,
  };

  // Attach component-name helpers as non-enumerable internals.
  Object.defineProperty(index, "aliasForDef", { value: aliasForDef });
  return index;
}

interface InternalIndex extends JavaModelIndex {
  aliasForDef(def: JavaTypeDef): string;
}

function internal(index: JavaModelIndex): InternalIndex {
  return index as unknown as InternalIndex;
}

function simpleTypeName(node: TsNode): string | null {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    const tail = node.namedChildren[node.namedChildren.length - 1];
    return tail && tail.type === "type_identifier" ? tail.text : null;
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

/** Bounded wildcard `? extends Foo` / `? super Foo`; null for unbounded `?`. */
function wildcardBound(node: TsNode): TsNode | null {
  if (node.type !== "wildcard") return null;
  return (
    node.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "scoped_type_identifier" ||
        c.type === "array_type",
    ) ?? null
  );
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

function isStandardScalar(name: string): boolean {
  return (
    STRING_TYPES.has(name) ||
    INTEGER_TYPES.has(name) ||
    NUMBER_TYPES.has(name) ||
    BOOLEAN_TYPES.has(name) ||
    DATE_TIME_TYPES.has(name) ||
    DATE_TYPES.has(name) ||
    TIME_TYPES.has(name)
  );
}

/**
 * Stable key describing a concrete type for specialized generic component
 * names (e.g. CommonResult_Foo). Project types resolve to their component
 * alias so same-simple-name classes never collide.
 */
function typeKey(node: TsNode, index: JavaModelIndex, subst?: Subst, fileRel?: string): string {
  const resolved = resolveSubst(node, subst);
  if (resolved.type === "wildcard") {
    const bound = wildcardBound(resolved);
    return bound ? typeKey(bound, index, subst, fileRel) : "Object";
  }
  if (resolved.type === "type_identifier") {
    const def = index.resolveDef(resolved.text, fileRel);
    return def ? internal(index).aliasForDef(def) : resolved.text;
  }
  if (resolved.type === "scoped_identifier" || resolved.type === "scoped_type_identifier") {
    const name = simpleTypeName(resolved) ?? "Object";
    if (resolved.type === "scoped_type_identifier") {
      const def = index.resolveFqn(resolved.text) ?? index.resolveDef(resolved.text, fileRel);
      if (def) return internal(index).aliasForDef(def);
    }
    return name;
  }
  if (resolved.type === "integral_type") {
    return resolved.text === "long" ? "Long" : resolved.text.charAt(0).toUpperCase() + resolved.text.slice(1);
  }
  if (resolved.type === "floating_point_type") {
    return resolved.text === "double" ? "Double" : "Float";
  }
  if (resolved.type === "boolean_type") return "Boolean";
  if (resolved.type === "array_type") {
    const inner = resolved.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "scoped_identifier", "scoped_type_identifier", "integral_type", "floating_point_type", "boolean_type"].includes(c.type),
    );
    return `${typeKey(inner ?? resolved, index, subst, fileRel)}Array`;
  }
  if (resolved.type === "generic_type") {
    const name = simpleTypeName(resolved) ?? "Object";
    const args = genericArguments(resolved);
    if (SCALAR_STREAM_TYPES.has(name)) {
      return name === "IntStream" || name === "LongStream" ? "LongList" : "DoubleList";
    }
    if (COLLECTION_TYPES.has(name)) {
      return `${typeKey(args[0] ?? { text: "Object", type: "type_identifier" } as TsNode, index, subst, fileRel)}List`;
    }
    if (MAP_TYPES.has(name)) {
      return `Map_${typeKey(args[1] ?? { text: "Object", type: "type_identifier" } as TsNode, index, subst, fileRel)}`;
    }
    if (PAGE_TYPES.has(name)) {
      const pageBase = name === "Slice" || name === "SliceImpl" ? "Slice" : "Page";
      return `${pageBase}_${typeKey(args[0] ?? { text: "Object", type: "type_identifier" } as TsNode, index, subst, fileRel)}`;
    }
    if (WRAPPER_TYPES.has(name) && args[0]) {
      return typeKey(args[0], index, subst, fileRel);
    }
    const def = index.resolveDef(name, fileRel);
    const base = def ? internal(index).aliasForDef(def) : name;
    return args.length
      ? `${base}_${args.map((arg) => typeKey(arg, index, subst, fileRel)).join("_")}`
      : base;
  }
  return "Object";
}

export function ensureJavaComponent(
  name: string,
  index: JavaModelIndex,
  fileRel?: string,
  stack: Set<string> = new Set(),
): string | null {
  const def = index.resolveDef(name, fileRel);
  if (!def) return null;
  return ensureComponentForDef(def, index, undefined, [], 0, stack);
}

/** Ensure the plain (non-specialized) component for a type definition. */
function ensureComponentForDef(
  def: JavaTypeDef,
  index: JavaModelIndex,
  subst: Subst | undefined,
  args: TsNode[],
  depth: number,
  stack: Set<string>,
): string {
  const alias = internal(index).aliasForDef(def);
  const specialized = def.typeParameters.length && args.length;
  // Specialized names embed the concrete argument type keys. Two call sites
  // with the same generic instantiation share one component; distinct generic
  // classes are already separated by aliasForDef. Reserve cycles also resolve
  // to the same name, so no numeric suffixing is needed.
  const name = specialized
    ? `${alias}_${args.map((arg) => typeKey(arg, index, subst, def.file)).join("_")}`
    : alias;
  if (index.components.has(name)) return name;
  if (stack.has(name)) return name;
  stack.add(name);
  index.components.set(name, {}); // reserve to break recursion
  const local = new Map(subst);
  if (specialized) {
    def.typeParameters.forEach((parameter, i) => {
      if (args[i]) local.set(parameter, resolveSubst(args[i]!, subst));
    });
  }
  // A component is a $ref boundary: the nesting budget resets here so a type
  // first reached through a deeply nested generic is still built completely;
  // reference cycles remain guarded by `stack`.
  index.components.set(name, buildTypeSchema(def, index, local, 0, stack));
  stack.delete(name);
  return name;
}

/**
 * Jackson naming strategies are inherited: @JsonNaming on a superclass also
 * renames the properties it contributes to a subtype.
 */
function effectiveNaming(def: JavaTypeDef, index: JavaModelIndex): "snake_case" | "default" {
  const guard = new Set<string>();
  let current: JavaTypeDef | undefined = def;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current.naming === "snake_case") return "snake_case";
    if (!current.superclass) break;
    const superName = simpleTypeName(current.superclass);
    if (!superName || guard.has(superName)) break;
    guard.add(superName);
    current = index.resolveDef(
      current.superclass.type === "scoped_type_identifier"
        ? current.superclass.text
        : superName,
      current.file,
    );
  }
  return "default";
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
  if (depth > 6 || guard.has(def.fqn)) return [];
  guard.add(def.fqn);
  const out: ChainField[] = [];
  if (def.superclass) {
    const superNode = resolveSubst(def.superclass, subst);
    const superSimple = simpleTypeName(superNode);
    const superDef = superSimple
      ? index.resolveDef(
          superNode.type === "scoped_type_identifier" || superNode.type === "scoped_identifier"
            ? superNode.text
            : superSimple,
          def.file,
        )
      : undefined;
    if (superDef) {
      const superSubst = new Map(subst ?? []);
      if (superNode.type === "generic_type") {
        const args = genericArguments(superNode);
        superDef.typeParameters.forEach((parameter, i) => {
          if (args[i]) superSubst.set(parameter, resolveSubst(args[i]!, subst));
        });
      }
      out.push(...collectChainFields(superDef, index, superSubst, depth + 1, guard));
    }
  }
  for (const field of def.fields) {
    out.push({ field, subst });
  }
  return out;
}

export interface JavaBeanProperty {
  name: string;
  schema: JsonSchema;
  required: boolean;
}

/**
 * Flattened bean properties (including inherited ones) with their JSON names,
 * used for Spring implicit command-object query binding.
 */
export function javaBeanProperties(
  def: JavaTypeDef,
  index: JavaModelIndex,
): JavaBeanProperty[] {
  const chain = collectChainFields(def, index, undefined, 0, new Set());
  const naming = effectiveNaming(def, index);
  const out: JavaBeanProperty[] = [];
  for (const { field } of chain) {
    if (field.ignored) continue;
    out.push({
      name: propertyName(field, naming),
      schema: javaTypeToSchema(field.typeNode, index, 1, undefined, def.file),
      required: field.required,
    });
  }
  return out;
}

function buildTypeSchema(
  def: JavaTypeDef,
  index: JavaModelIndex,
  subst: Subst | undefined,
  depth: number,
  stack: Set<string>,
): JsonSchema {
  if (def.kind === "enum") {
    return def.enumValues.length ? { type: "string", enum: [...def.enumValues] } : { type: "string" };
  }

  // Jackson @JsonTypeInfo(NAME) + @JsonSubTypes: emit a discriminated oneOf.
  if (def.discriminator) {
    const oneOf: JsonSchema[] = [];
    const mapping: Record<string, string> = {};
    for (const subtype of def.discriminator.subtypes) {
      const subDef = index.resolveDef(subtype.type, def.file);
      if (!subDef) continue;
      const refName = ensureComponentForDef(subDef, index, undefined, [], depth, stack);
      const ref = `#/components/schemas/${refName}`;
      oneOf.push({ $ref: ref });
      mapping[subtype.name] = ref;
    }
    if (oneOf.length) {
      return {
        oneOf,
        discriminator: { propertyName: def.discriminator.property, mapping },
      };
    }
  }

  const chain = collectChainFields(def, index, subst, depth, new Set());
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const naming = effectiveNaming(def, index);
  for (const { field, subst: fieldSubst } of chain) {
    if (field.ignored) continue;
    const name = propertyName(field, naming);
    properties[name] = javaTypeToSchema(field.typeNode, index, depth + 1, fieldSubst, def.file);
    if (field.required) required.push(name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

/** Synthetic Spring Data Page/Slice envelope components. */
function ensurePageComponent(
  pageName: string,
  itemNode: TsNode | undefined,
  index: JavaModelIndex,
  depth: number,
  subst: Subst | undefined,
  fileRel?: string,
): string {
  const itemKey = itemNode ? typeKey(itemNode, index, subst, fileRel) : "Object";
  const isSlice = pageName === "Slice" || pageName === "SliceImpl";
  const base = `${isSlice ? "Slice" : "Page"}_${itemKey}`;
  if (index.components.has(base)) return base;
  index.components.set(base, {});

  if (!index.components.has("Pageable")) {
    index.components.set("Pageable", {
      type: "object",
      properties: {
        pageNumber: { type: "integer", format: "int32" },
        pageSize: { type: "integer", format: "int32" },
        offset: { type: "integer", format: "int64" },
        paged: { type: "boolean" },
        unpaged: { type: "boolean" },
        sort: { $ref: "#/components/schemas/Sort" },
      },
    });
  }
  if (!index.components.has("Sort")) {
    index.components.set("Sort", {
      type: "object",
      properties: {
        empty: { type: "boolean" },
        sorted: { type: "boolean" },
        unsorted: { type: "boolean" },
      },
    });
  }

  const items = itemNode
    ? javaTypeToSchema(itemNode, index, 1, subst, fileRel)
    : {};
  const properties: Record<string, JsonSchema> = {
    content: { type: "array", items },
    pageable: { $ref: "#/components/schemas/Pageable" },
    number: { type: "integer", format: "int32" },
    size: { type: "integer", format: "int32" },
    sort: { $ref: "#/components/schemas/Sort" },
    first: { type: "boolean" },
    last: { type: "boolean" },
    empty: { type: "boolean" },
    numberOfElements: { type: "integer", format: "int32" },
  };
  if (!isSlice) {
    properties.totalElements = { type: "integer", format: "int64" };
    properties.totalPages = { type: "integer", format: "int32" };
  }
  index.components.set(base, { type: "object", properties });
  return base;
}

export function javaTypeToSchema(
  node: TsNode,
  index: JavaModelIndex,
  depth = 0,
  subst?: Subst,
  fileRel?: string,
): JsonSchema {
  if (depth > 6 || !node) return {};
  node = resolveSubst(node, subst);

  if (node.type === "wildcard") {
    const bound = wildcardBound(node);
    return bound
      ? javaTypeToSchema(bound, index, depth, subst, fileRel)
      : { type: "object" };
  }

  if (node.type === "array_type") {
    const inner = node.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "integral_type", "floating_point_type", "boolean_type", "scoped_identifier", "scoped_type_identifier", "wildcard"].includes(c.type),
    );
    return {
      type: "array",
      items: inner ? javaTypeToSchema(inner, index, depth + 1, subst, fileRel) : { type: "object" },
    };
  }

  if (node.type === "integral_type") {
    return {
      type: "integer",
      ...(node.text === "long" ? { format: "int64" } : { format: "int32" }),
    };
  }
  if (node.type === "floating_point_type") return { type: "number" };
  if (node.type === "boolean_type") return { type: "boolean" };
  if (node.type === "void_type") return {};

  if (node.type === "generic_type") {
    const name = simpleTypeName(node);
    const args = genericArguments(node);
    if (name && SCALAR_STREAM_TYPES.has(name)) {
      return {
        type: "array",
        items: { type: "integer", ...(name === "DoubleStream" ? {} : { format: "int64" }) },
      };
    }
    if (name && COLLECTION_TYPES.has(name)) {
      return {
        type: "array",
        items: args[0]
          ? javaTypeToSchema(args[0], index, depth + 1, subst, fileRel)
          : { type: "object" },
      };
    }
    if (name && MAP_TYPES.has(name)) {
      return args[1]
        ? { type: "object", additionalProperties: javaTypeToSchema(args[1], index, depth + 1, subst, fileRel) }
        : { type: "object" };
    }
    if (name && PAGE_TYPES.has(name)) {
      const component = ensurePageComponent(name, args[0], index, depth, subst, fileRel);
      return { $ref: `#/components/schemas/${component}` };
    }
    if (name && JSON_OBJECT_TYPES.has(name)) return { type: "object" };
    if (name && JSON_ARRAY_TYPES.has(name)) {
      return { type: "array", items: { type: "object" } };
    }
    if (name && JSON_VALUE_TYPES.has(name)) return { type: "object" };
    if (name && WRAPPER_TYPES.has(name)) {
      return args[0] ? javaTypeToSchema(args[0], index, depth, subst, fileRel) : {};
    }
    if (name) {
      const def = index.resolveDef(name, fileRel);
      if (def) {
        const component = ensureComponentForDef(def, index, subst ?? new Map(), args, depth, new Set());
        return { $ref: `#/components/schemas/${component}` };
      }
    }
    return {};
  }

  const handleSimple = (name: string): JsonSchema => {
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) {
      return name === "Long" || name === "long" || name === "BigInteger" || name === "AtomicLong"
        ? { type: "integer", format: "int64" }
        : { type: "integer", format: "int32" };
    }
    if (NUMBER_TYPES.has(name)) return { type: "number" };
    if (BOOLEAN_TYPES.has(name)) return { type: "boolean" };
    if (DATE_TIME_TYPES.has(name)) return { type: "string", format: "date-time" };
    if (DATE_TYPES.has(name)) return { type: "string", format: "date" };
    if (TIME_TYPES.has(name)) return { type: "string", format: "time" };
    if (JSON_OBJECT_TYPES.has(name)) return { type: "object" };
    if (JSON_ARRAY_TYPES.has(name)) return { type: "array", items: { type: "object" } };
    if (JSON_VALUE_TYPES.has(name)) return { type: "object" };
    const def = index.resolveDef(name, fileRel);
    if (def) {
      const component = ensureComponentForDef(def, index, undefined, [], depth, new Set());
      return { $ref: `#/components/schemas/${component}` };
    }
    return {};
  };

  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
    const name = simpleTypeName(node);
    if (!name) return {};
    if (node.type === "scoped_type_identifier") {
      const fqn = node.text;
      const def = index.resolveFqn(fqn) ?? index.resolveDef(fqn, fileRel);
      if (def) {
        const component = ensureComponentForDef(def, index, undefined, [], depth, new Set());
        return { $ref: `#/components/schemas/${component}` };
      }
    }
    if (isStandardScalar(name) || JSON_OBJECT_TYPES.has(name) || JSON_ARRAY_TYPES.has(name) || JSON_VALUE_TYPES.has(name)) {
      return handleSimple(name);
    }
    return {};
  }

  if (node.type === "type_identifier") {
    return handleSimple(node.text);
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
