/**
 * C# type -> JSON Schema conversion.
 *
 * Handles predefined types, nullable value types, generics (collections,
 * Dictionary, Task/ActionResult wrappers), arrays, records/classes and enums.
 * Referenced model types become components via lazy ensure.
 */

import type { JsonSchema } from "../../core/types.js";
import {extractTypeDef, type CsField, type CsTypeDef, type CSharpAnalysis} from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll } from "../treesitter/ast.js";

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
  readonly qualified?: Map<string, CsTypeDef>;
  readonly serialization?:boolean;
  readonly componentNames?:Map<string,string>;
  readonly enumSerializationUncertain?:boolean;
}

export function buildCsModelIndex(analysis: CSharpAnalysis): CsModelIndex {
  const definitions=analysis.declarations??[...analysis.files.values()].flatMap(file=>findAll(file.root,n=>['class_declaration','struct_declaration','record_declaration','enum_declaration'].includes(n.type))).map(extractTypeDef).filter((d):d is CsTypeDef=>!!d);
  const counts=new Map<string,number>();for(const d of definitions)counts.set(d.name,(counts.get(d.name)??0)+1);
  const byName=new Map<string,CsTypeDef>(),qualified=new Map<string,CsTypeDef>();
  for(const original of definitions){const full=csScope(original.node,true).join('.');const def={...original,name:(counts.get(original.name)??0)>1?full:original.name};byName.set(def.name,def);qualified.set(full,def);}
  const enumSerializationUncertain = [...analysis.files.values()].some(file => findAll(file.root, n =>
    (n.type === 'object_creation_expression' && /(?:JsonStringEnumConverter|StringEnumConverter)/.test(n.childForFieldName('type')?.text ?? '')) ||
    (n.type === 'invocation_expression' && /\bAddNewtonsoftJson\b/.test(n.namedChildren[0]?.text ?? ''))).length > 0);
  return { byName, qualified, components: new Map(), enumSerializationUncertain };
}

const outputIndexes=new WeakMap<CsModelIndex,CsModelIndex>();
export function csSerializationIndex(index:CsModelIndex):CsModelIndex{
 const cached=outputIndexes.get(index);if(cached)return cached;
 const names=new Map<string,string>(),reserved=new Set(index.byName.keys());
 for(const name of index.byName.keys()){let candidate='serialized_'+name;while(reserved.has(candidate))candidate='_'+candidate;reserved.add(candidate);names.set(name,candidate);}
 const output={...index,serialization:true,componentNames:names};outputIndexes.set(index,output);return output;
}

function csScope(node:TsNode,includeSelf=false):string[]{
 const types:string[]=[];let namespace='';let current:TsNode|null=includeSelf?node:node.parent;
 while(current){
  if(['class_declaration','record_declaration','struct_declaration'].includes(current.type)){const name=current.childForFieldName('name')?.text;if(name)types.unshift(name);}
  if(['namespace_declaration','file_scoped_namespace_declaration'].includes(current.type)){const name=current.childForFieldName('name')?.text;if(name)namespace=name+(namespace?'.'+namespace:'');}
  if(!current.parent&&!namespace){const declaration=current.namedChildren.find(n=>n.type==='file_scoped_namespace_declaration');namespace=declaration?.childForFieldName('name')?.text??'';}
  current=current.parent;
 }
 return [...(namespace?namespace.split('.'):[]),...types];
}
export function scopedName(node:TsNode,index:CsModelIndex):string|null{
 const name=node.type==='qualified_name'?node.text:genericName(node);if(!name)return null;
 if(index.qualified){
  const scope=csScope(node);
  for(let i=scope.length;i>=0;i--){const found=index.qualified.get([...scope.slice(0,i),name].join('.'));if(found&&(node.type!=='generic_name'||found.typeParameters.length===typeArguments(node).length))return found.name;}
  let root=node;while(root.parent)root=root.parent;
  const matches=new Set<string>();
  for(const directive of root.namedChildren.filter(n=>n.type==='using_directive')){
   const match=/^using\s+([\w.]+)\s*;/.exec(directive.text);const found=match&&index.qualified.get(match[1]+'.'+name);if(found&&(node.type!=='generic_name'||found.typeParameters.length===typeArguments(node).length))matches.add(found.name);
  }
  if(matches.size===1)return [...matches][0]!;if(matches.size>1)return null;
 }
 return index.byName.has(name)?name:null;
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
  const componentName=index.componentNames?.get(name)??name;
  if (index.components.has(componentName)) return;
  const def = index.byName.get(name);
  if (!def) return;
  if (stack.has(name)) return;
  stack.add(name);
  index.components.set(componentName, {});
  index.components.set(componentName, buildTypeSchema(def, index, undefined, 0));
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
      return specialized ? index.serialization&&specialized.startsWith('serialized_')?specialized.slice(11):specialized : name;
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
  const name = scopedName(node,index);
  if (!name) return null;
  const def = index.byName.get(name);
  if (!def || def.typeParameters.length === 0) return null;
  const rawArgs = typeArguments(node);
  if (!rawArgs.length) return null;
  const args: SubstValue[] = rawArgs.map((arg) => resolveValue(arg, outerSubst));

  const suffix = args.map((arg) => typeKey(arg, index, outerSubst)).join("_");
  const desired = `${index.componentNames?.get(name)??name}_${suffix}`;
  // The suffix is deterministic from base name + concrete arguments, so an
  // existing specialization is structurally identical and can be reused.
  if (index.components.has(desired)) return desired;
  const componentName = index.byName.has(desired)
    ? uniqueComponentName(index, desired)
    : desired;
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
      const baseName = scopedName(candidate,index);
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
    if (index.serialization) {
      const converter = listAttributes(def.node).find(a => /(?:^|\.)JsonConverter(?:Attribute)?$/.test(a.name));
      if (converter) {
        if (/typeof\s*\(\s*(?:System\.Text\.Json\.Serialization\.)?JsonStringEnumConverter(?:<[^>]+>)?\s*\)/.test(converter.node.text)) {
          const flags = listAttributes(def.node).some(a => /(?:^|\.)Flags(?:Attribute)?$/.test(a.name));
          return {anyOf:[flags ? {type:'string'} : {type:'string',enum:[...def.enumValues]}, {type:'integer'}]};
        }
        return {description:'Custom enum JSON converter requires runtime contract verification'};
      }
      if (index.enumSerializationUncertain) return {description:'Global enum serialization configuration requires runtime contract verification'};
      // System.Text.Json writes enum numbers by default, including unnamed
      // underlying values and flag combinations. A string enum is incorrect.
      return {type:'integer'};
    }
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
    if(field.ignoreJson)continue;
    const propertyName = field.jsonName ?? field.name;
    properties[propertyName] = csTypeToSchema(field.typeNode, index, depth + 1, fieldSubst);
    if (index.serialization && field.conditionalJson) {
      const value = properties[propertyName]!;
      if (Array.isArray(value.type)) {
        const types = value.type.filter(type => type !== 'null');
        value.type = types.length === 1 ? types[0] : types;
      }
      for (const keyword of ['anyOf', 'oneOf'] as const) {
        if (!Array.isArray(value[keyword])) continue;
        const branches = value[keyword].filter(branch => !(branch && typeof branch === 'object' && (branch as JsonSchema).type === 'null'));
        if (branches.length === 1) {
          const {[keyword]: ignored, ...siblings} = value;
          properties[propertyName] = {...branches[0] as JsonSchema, ...siblings};
        } else value[keyword] = branches;
      }
    }
    if(index.serialization?!field.conditionalJson:field.required)required.push(propertyName);
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
  if (node.type === "nullable_type") return withNull(csTypeToSchema(node.namedChildren[0], index, depth + 1, subst));
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
      return { type: "integer", format: t === "long" || t === "ulong" ? "int64" : "int32" };
    }
    if (NUMBER_TYPES.has(t)) return { type: "number" };
    if (t === "object") return { type: "object" };
    if (t === "void") return {};
    return {};
  }

  if (resolved.type === "generic_name") {
    const name = scopedName(resolved,index)??genericName(resolved);
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
    if (name === "Nullable" && args[0]) return withNull(csTypeToSchema(args[0], index, depth + 1, subst));
    if (name && WRAPPER_TYPES.has(name) && args[0]) {
      return csTypeToSchema(args[0], index, depth + 1, subst);
    }
    if (name && index.byName.has(name)) {
      if (args.length && index.byName.get(name)?.typeParameters.length) {
        const specialized = ensureSpecializedCsComponent(resolved, index, subst, depth);
        if (specialized) return { $ref: `#/components/schemas/${specialized}` };
      }
      ensureCsComponent(name, index);
      return { $ref: `#/components/schemas/${index.componentNames?.get(name)??name}` };
    }
    return {};
  }

  if (resolved.type === "identifier") {
    const name = scopedName(resolved,index)??resolved.text;
    if (name === "Guid") return { type: "string", format: "uuid" };
    if (STRING_TYPES.has(name)) return { type: "string" };
    if (INTEGER_TYPES.has(name)) {
      return { type: "integer", format: name === "long" || name === "ulong" ? "int64" : "int32" };
    }
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
      return { $ref: `#/components/schemas/${index.componentNames?.get(name)??name}` };
    }
    return {};
  }

  if (node.type === "qualified_name") {
    const local=scopedName(node,index);
    if(local){ensureCsComponent(local,index);return {$ref:`#/components/schemas/${index.componentNames?.get(local)??local}`};}
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

function withNull(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type)) return { ...schema, type: [...new Set([...schema.type, "null"])] };
  if (!Object.keys(schema).length) return schema;
  return { anyOf: [schema, { type: "null" }] };
}
