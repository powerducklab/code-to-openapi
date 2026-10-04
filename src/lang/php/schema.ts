/**
 * PHP type -> JSON Schema conversion.
 *
 * Handles primitive and named scalar types, nullable types, model classes
 * (constructor promotion / public properties), backed enums and Laravel
 * FormRequest rule strings.
 */

import type { JsonSchema } from "../../core/types.js";
import type { PhpAnalysis, PhpClass, PhpRule } from "./index.js";
import { phpStringText, resolvePhpClass, findPhpMethod } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";

export interface PhpModelIndex {
  readonly analysis: PhpAnalysis;
  readonly components: Map<string, JsonSchema>;
}

export function buildPhpModelIndex(analysis: PhpAnalysis): PhpModelIndex {
  return { analysis, components: new Map() };
}

const SCALAR_NAMES: Record<string, JsonSchema> = {
  string: { type: "string" },
  int: { type: "integer" },
  integer: { type: "integer" },
  float: { type: "number" },
  double: { type: "number" },
  number: { type: "number" },
  bool: { type: "boolean" },
  boolean: { type: "boolean" },
  array: { type: "array", items: {} },
  object: { type: "object" },
  mixed: {},
  null: { type: "null" },
};

export function phpTypeToSchema(
  node: TsNode | undefined,
  index: PhpModelIndex,
  stack: Set<string> = new Set(),
  depth = 0,
  output = false,
): JsonSchema {
  if (!node || depth > 6) return {};

  if (node.type === "optional_type" || node.type === "nullable_type") {
    const inner = node.namedChildren.find(
      (c) =>
        c.type === "primitive_type" ||
        c.type === "named_type" ||
        c.type === "union_type",
    );
    const schema = phpTypeToSchema(inner, index, stack, depth + 1, output);
    if (!Object.keys(schema).length) return {};
    if (typeof schema.type === "string") return {...schema,type:[schema.type,"null"]};
    return {anyOf:[schema,{type:"null"}]};
  }

  if (node.type === "primitive_type") {
    return SCALAR_NAMES[node.text.trim()] ?? {};
  }

  if (node.type === "union_type") {
    const members = node.namedChildren.filter(c => c.type === "primitive_type" || c.type === "named_type" || c.type === "optional_type" || c.type === "union_type");
    const alternatives = members.map(member => phpTypeToSchema(member, index, stack, depth + 1, output));
    return combinePhpAlternatives(alternatives);
  }

  if (node.type === "named_type") {
    const name = node.text;
    const short = name.split("\\").pop()!;
    if (SCALAR_NAMES[short]) return SCALAR_NAMES[short]!;
    if (short === "Collection" || short === "LengthAwarePaginator" || short === "Paginator") {
      return { type: "array", items: {} };
    }
    if (index.analysis.enums.has(short)) {
      return ensurePhpComponent(short, index, stack) ?? { type: "string" };
    }
    const cls = resolvePhpClass(name, index.analysis, node);
    if (cls) return (output ? ensurePhpResponseComponent(cls.fqcn, index) : ensurePhpComponent(cls.fqcn, index, stack)) ?? {};
    return {};
  }

  return {};
}

export function ensurePhpComponent(
  name: string,
  index: PhpModelIndex,
  stack: Set<string> = new Set(),
): JsonSchema | null {
  const cls = index.analysis.classes.get(name);
  const en = index.analysis.enums.get(name);

  if (en) {
    if (index.components.has(name)) return { $ref: `#/components/schemas/${name}` };
    const schema: JsonSchema =
      en.backing === "integer"
        ? { type: "integer", enum: en.values.map((v) => Number(v.value)) }
        : { type: "string", enum: en.values.map((v) => v.value) };
    index.components.set(name, schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  if (!cls) return null;
  name = index.analysis.classes.get(cls.name) === cls ? cls.name : cls.fqcn.replace(/\\/g, ".");
  if (index.components.has(name)) return { $ref: `#/components/schemas/${name}` };
  if (stack.has(name)) return { $ref: `#/components/schemas/${name}` };
  stack.add(name);
  index.components.set(name, {});
  index.components.set(name, buildClassSchema(cls, index, stack));
  stack.delete(name);
  return { $ref: `#/components/schemas/${name}` };
}

/** JSON output follows jsonSerialize(), not the visibility of its source fields. */
export function ensurePhpResponseComponent(name: string, index: PhpModelIndex): JsonSchema | null {
  const cls = index.analysis.classes.get(name);
  if (!cls) return ensurePhpComponent(name, index);
  if (cls.resourceKind) return ensurePhpComponent(name, index);
  const lineage: PhpClass[] = [];
  let ancestor: PhpClass | undefined = cls;
  while (ancestor && !lineage.includes(ancestor) && lineage.length < 16) {
    lineage.push(ancestor);
    ancestor = ancestor.extends ? resolvePhpClass(ancestor.extends, index.analysis, ancestor.node) : undefined;
  }
  const serializable = lineage.some(parent => parent.jsonSerializable);
  const component = `output_${index.analysis.classes.get(cls.name) === cls ? cls.name : cls.fqcn.replace(/\\/g, ".")}`;
  if (index.components.has(component)) return { $ref: `#/components/schemas/${component}` };
  index.components.set(component, {});
  if (!serializable) {
    index.components.set(component, buildClassSchema(cls, index, new Set(), true));
    return { $ref: `#/components/schemas/${component}` };
  }
  const serializer = findPhpMethod(cls, "jsonSerialize", index.analysis);
  const returns = serializer ? findAll(serializer, node => node.type === "return_statement") : [];
  const array = returns.length === 1 ? returns[0]?.namedChildren[0] : undefined;
  if (array?.type === "array_creation_expression") {
    const properties: Record<string, JsonSchema> = {};
    let complete = true;
    for (const element of childrenOfType(array, "array_element_initializer")) {
      const [key, value] = element.namedChildren;
      if (key?.type !== "string" || !value) { complete = false; break; }
      const keyName = phpStringText(key)!;
      if (value.type === "member_access_expression" && value.namedChildren[0]?.text === "$this") {
        const property = lineage.flatMap(parent => parent.properties).find(prop => prop.name === value.namedChildren.at(-1)?.text);
        properties[keyName] = property ? phpTypeToSchema(property.typeNode, index, new Set(), 0, true) : {};
      } else {
        properties[keyName] = phpLiteralSchema(value) ?? {};
      }
    }
    if (complete) index.components.set(component, {
      type: "object", properties, ...(Object.keys(properties).length ? { required: Object.keys(properties) } : {}),
    });
  }
  return { $ref: `#/components/schemas/${component}` };
}

function buildClassSchema(cls: PhpClass, index: PhpModelIndex, stack: Set<string>, publicOnly = false): JsonSchema {
  if (cls.resourceKind) {
    const resource = buildResourceSchema(cls, index, stack);
    if (resource) return resource;
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const lineage: PhpClass[] = [cls];
  if (publicOnly) {
    let parent = cls.extends ? resolvePhpClass(cls.extends, index.analysis, cls.node) : undefined;
    while (parent && !lineage.includes(parent) && lineage.length < 16) {
      lineage.push(parent);
      parent = parent.extends ? resolvePhpClass(parent.extends, index.analysis, parent.node) : undefined;
    }
  }
  for (const owner of lineage) for (const prop of owner.properties) {
    if (prop.name in properties) continue;
    if (publicOnly && prop.visibility && prop.visibility !== "public") continue;
    const docType = owner.propertyDoc.get(prop.name);
    properties[prop.name] = docType
      ? docTypeToSchema(docType, index, stack, publicOnly, prop.typeNode)
      : phpTypeToSchema(prop.typeNode, index, stack, 0, publicOnly);
    // Native json_encode omits uninitialized typed properties. Initialized
    // defaults and promoted properties are present even when their value is null.
    if (publicOnly ? prop.hasDefault || prop.promoted : !prop.nullable && !prop.hasDefault) required.push(prop.name);
  }
  // Eloquent @property docblocks describe attributes without real properties.
  for (const [name, docType] of publicOnly ? [] : cls.docPropertyTypes) {
    if (!(name in properties)) {
      properties[name] = docTypeToSchema(docType, index, stack);
    }
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function combinePhpAlternatives(alternatives: JsonSchema[]): JsonSchema {
  if (!alternatives.length || alternatives.some(schema => !Object.keys(schema).length)) return {};
  const unique = alternatives.filter((schema, i) => alternatives.findIndex(other => JSON.stringify(other) === JSON.stringify(schema)) === i);
  if (unique.length === 1) return unique[0]!;
  if (unique.every(schema => typeof schema.type === "string" && Object.keys(schema).length === 1)) {
    return { type: unique.map(schema => schema.type as string) };
  }
  return { anyOf: unique };
}

/** Map a PHPDoc type (string[], Collection<string>, int|null) to a schema. */
export function docTypeToSchema(docType: string, index: PhpModelIndex, stack: Set<string>, output = false, at?: TsNode): JsonSchema {
  const type = docType.trim();
  if (type.startsWith("?")) {
    return combinePhpAlternatives([docTypeToSchema(type.slice(1), index, stack, output, at), { type: "null" }]);
  }
  // Only split at the outer level: array<int|string> is an array of a union.
  let nesting = 0;
  let from = 0;
  const union: string[] = [];
  for (let i = 0; i < type.length; i++) {
    if ("<([".includes(type[i]!)) nesting++;
    else if (">)]".includes(type[i]!)) nesting--;
    else if (type[i] === "|" && nesting === 0) {
      union.push(type.slice(from, i));
      from = i + 1;
    }
    // Intersections need object compatibility analysis; never pick one member.
    else if (type[i] === "&" && nesting === 0) return {};
  }
  if (union.length) {
    union.push(type.slice(from));
    return combinePhpAlternatives(union.map(part => docTypeToSchema(part, index, stack, output, at)));
  }
  const arrayMatch = type.match(/^([\w\\]+)\[\]$/);
  if (arrayMatch) {
    return { type: "array", items: docTypeToSchema(arrayMatch[1]!, index, stack, output, at) };
  }
  const genericMatch = type.match(/^(?:Collection|array|list|Illuminate\\Support\\Collection|Illuminate\\Database\\Eloquent\\Collection)<(?:[^,]+,\s*)?([\w\\]+)>$/i);
  if (genericMatch) {
    return { type: "array", items: docTypeToSchema(genericMatch[1]!, index, stack, output, at) };
  }
  const short = type.split("\\").pop()!;
  if (SCALAR_NAMES[short]) return SCALAR_NAMES[short]!;
  if (index.analysis.enums.has(short)) {
    return ensurePhpComponent(short, index, stack) ?? { type: "string" };
  }
  const cls = resolvePhpClass(type, index.analysis, at);
  if (cls) return (output ? ensurePhpResponseComponent(cls.fqcn, index) : ensurePhpComponent(cls.fqcn, index, stack)) ?? {};
  return {};
}

const PAGINATOR_INTEGER_METHODS = new Set([
  "currentPage",
  "perPage",
  "lastPage",
  "total",
  "count",
  "id",
]);

function phpLiteralSchema(node: TsNode): JsonSchema | null {
  if (node.type === "string" || node.type === "string_content") return { type: "string" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "float") return { type: "number" };
  if (node.type === "boolean" || node.type === "true" || node.type === "false") {
    return { type: "boolean" };
  }
  if (node.type === "null") return { type: "null" };
  return null;
}

const DATE_METHODS = new Set([
  "toiso8601string",
  "todatestring",
  "tojson",
  "format",
  "todatetimestring",
  "toimms3339string",
]);

function pascalize(word: string): string {
  return word
    .replace(/[-_]+/g, " ")
    .replace(/(?:^\w|\s\w)/g, (c) => c.trim().toUpperCase());
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Resolve a value expression inside an API Resource toArray() table.
 * Covers `$this->field`, conditional `when`/`whenLoaded`, nested resources,
 * `XResource::collection()`, literals, pagination getters and arrays.
 * Returns null when the value cannot be statically typed (honest gap).
 */
function resourceValueSchema(
  node: TsNode | undefined,
  index: PhpModelIndex,
  stack: Set<string>,
  mixinModel: PhpClass | null,
  ownerClass: PhpClass | null,
  depth = 0,
): JsonSchema | null {
  if (!node || depth > 6) return null;

  const literal = phpLiteralSchema(node);
  if (literal) return literal;

  if (node.type === "conditional_expression") {
    const branches = node.namedChildren.filter((c) => c.type !== "else");
    const schemas = branches.slice(1).map(branch => resourceValueSchema(branch, index, stack, mixinModel, ownerClass, depth + 1) ?? {});
    return combinePhpAlternatives(schemas);
  }

  // new CategoryResource($this->category)
  if (node.type === "object_creation_expression") {
    const typeName = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text
      .split("\\").pop();
    if (typeName && index.analysis.classes.has(typeName)) {
      return ensurePhpComponent(typeName, index, stack) ?? null;
    }
    return null;
  }

  // ProductResource::collection($this->items)
  if (node.type === "scoped_call_expression") {
    const directNames = node.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
    const scopeName = directNames[0]?.text.split("\\").pop();
    const method = directNames[1]?.text;
    if (method === "collection" && scopeName && index.analysis.classes.has(scopeName)) {
      const ref = ensurePhpComponent(scopeName, index, stack);
      return ref ? { type: "array", items: ref } : null;
    }
    return null;
  }

  // Nullsafe calls: $this->created_at?->toIso8601String()
  if (node.type === "nullsafe_member_call_expression" || node.type === "member_call_expression") {
    const methodName = node.namedChildren.filter((c) => c.type === "name").pop()?.text;

    // $this->when($condition, $value) / when($condition, $value, $default)
    if (methodName === "when" || methodName === "unless") {
      const args = node.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      const value = argNodes[1]?.namedChildren[0];
      let schema = resourceValueSchema(value, index, stack, mixinModel, ownerClass, depth + 1);
      // when($this->field, $this->field) emits the field only when non-null.
      const condition = argNodes[0]?.namedChildren[0];
      if (schema && methodName === "when" && condition?.type === "member_access_expression" && condition.text === value?.text) {
        if (Array.isArray(schema.type)) {
          const types = schema.type.filter(type => type !== "null");
          schema = { ...schema, type: types.length === 1 ? types[0] : types };
        } else if (Array.isArray(schema.anyOf)) {
          const alternatives = schema.anyOf.filter((item: JsonSchema) => item.type !== "null");
          schema = combinePhpAlternatives(alternatives);
        }
      }
      if (argNodes[2]) {
        const fallback = resourceValueSchema(argNodes[2].namedChildren[0], index, stack, mixinModel, ownerClass, depth + 1);
        return combinePhpAlternatives([schema ?? {}, fallback ?? {}]);
      }
      return schema;
    }

    // $this->whenLoaded('reviews', ReviewResource::collection(...))
    if (methodName === "whenLoaded") {
      const args = node.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      const explicitValue = argNodes[1]?.namedChildren[0];
      const explicit = resourceValueSchema(explicitValue, index, stack, mixinModel, ownerClass, depth + 1);
      if (explicit && Object.keys(explicit).length) return explicit;
      const relation = phpStringText(argNodes[0]?.namedChildren.find((c) => c.type === "string"));
      if (relation) {
        const guessed = `${pascalize(singularize(relation))}Resource`;
        if (index.analysis.classes.has(guessed)) {
          const ref = ensurePhpComponent(guessed, index, stack);
          if (ref) return { type: "array", items: ref };
        }
        return { type: "array", items: {} };
      }
      return null;
    }

    if (methodName && DATE_METHODS.has(methodName.toLowerCase())) return { type: "string", format: "date-time" };
    if (methodName && PAGINATOR_INTEGER_METHODS.has(methodName)) return { type: "integer" };
    if (methodName === "toArray") return { type: "object" };
    if (methodName === "collection") {
      const paired = pairedResource(ownerClass, index);
      return paired ? { type: "array", items: paired } : { type: "array", items: {} };
    }
    return null;
  }

  // $this->name
  if (node.type === "member_access_expression" || node.type === "nullsafe_member_access_expression") {
    const propName = node.namedChildren.filter((c) => c.type === "name").pop()?.text;
    if (!propName) return null;

    // Backed enum ->value retains the enum's scalar wire values.
    if (propName === "value" && node.namedChildren[0]?.type === "member_access_expression") {
      const base = resourceValueSchema(node.namedChildren[0], index, stack, mixinModel, ownerClass, depth + 1);
      if (typeof base?.$ref === "string" && index.analysis.enums.has(base.$ref.split("/").at(-1)!)) return base;
    }

    // ResourceCollection's $this->collection is the wrapped resource list.
    if (propName === "collection" && ownerClass?.resourceKind === "resource-collection") {
      const paired = pairedResource(ownerClass, index);
      return paired ? { type: "array", items: paired } : { type: "array", items: {} };
    }

    const modelProp = mixinModel?.properties.find((p) => p.name === propName);
    if (modelProp && mixinModel) {
      const docType = mixinModel.propertyDoc.get(propName) ?? mixinModel.docPropertyTypes.get(propName);
      return docType
        ? docTypeToSchema(docType, index, stack)
        : phpTypeToSchema(modelProp.typeNode, index, stack);
    }
    if (mixinModel?.docPropertyTypes.has(propName)) {
      return docTypeToSchema(mixinModel.docPropertyTypes.get(propName)!, index, stack);
    }
    return {};
  }

  if (node.type === "array_creation_expression") {
    const elements = childrenOfType(node, "array_element_initializer");
    if (elements.length === 0) return { type: "array", items: {} };
    const keyed = elements.filter((element) => childrenOfType(element, "string")[0]);
    if (keyed.length) {
      const properties: Record<string, JsonSchema> = {};
      for (const element of keyed) {
        const key = phpStringText(childrenOfType(element, "string")[0]);
        const valueNode = element.namedChildren.find((c) => c.type !== "string");
        if (!key || !valueNode) continue;
        const schema = resourceValueSchema(valueNode, index, stack, mixinModel, ownerClass, depth + 1);
        if (schema && Object.keys(schema).length) properties[key] = schema;
      }
      return { type: "object", properties };
    }
    const itemSchemas = elements.map((element) =>
      resourceValueSchema(element.namedChildren[0], index, stack, mixinModel, ownerClass, depth + 1),
    );
    const first = itemSchemas[0];
    if (first && itemSchemas.every((s) => s && JSON.stringify(s) === JSON.stringify(first))) {
      return { type: "array", items: first };
    }
    return null;
  }

  return null;
}

function pairedResource(
  ownerClass: PhpClass | null,
  index: PhpModelIndex,
): JsonSchema | null {
  if (!ownerClass) return null;
  const base = ownerClass.name.replace(/Collection$/, "");
  const candidate = `${base}Resource`;
  if (index.analysis.classes.has(candidate)) {
    return ensurePhpComponent(candidate, index) ?? null;
  }
  return null;
}


function buildResourceSchema(
  cls: PhpClass,
  index: PhpModelIndex,
  stack: Set<string>,
): JsonSchema | null {
  const toArray = cls.methods.get("toArray");
  const mixinModel = cls.mixinModel ? index.analysis.classes.get(cls.mixinModel) ?? null : null;

  if (!toArray) {
    if (cls.resourceKind === "json-resource" && mixinModel) {
      // A bare JsonResource serializes the underlying model attributes.
      return buildClassSchema(mixinModel, index, stack);
    }
    if (cls.resourceKind === "resource-collection") {
      const paired = pairedResource(cls, index);
      return {
        type: "object",
        properties: {
          data: { type: "array", items: paired ?? {} },
        },
      };
    }
    return null;
  }

  const properties: Record<string, JsonSchema> = {};
  const returns = findAll(toArray, (n) => n.type === "return_statement");
  const arrayReturn = returns
    .map((ret) => ret.namedChildren.find((c) => c.type === "array_creation_expression"))
    .find((arr): arr is TsNode => Boolean(arr));

  if (arrayReturn) {
    for (const element of childrenOfType(arrayReturn, "array_element_initializer")) {
      const keyNode = childrenOfType(element, "string")[0];
      const key = keyNode
        ? keyNode.namedChildren.find((c) => c.type === "string_content")?.text ??
          keyNode.text.replace(/^['"]|['"]$/g, "")
        : null;
      if (!key) continue;
      const valueNode = element.namedChildren[1];
      const schema = resourceValueSchema(valueNode, index, stack, mixinModel, cls);
      properties[key] = schema ?? {};
    }
  }

  if (Object.keys(properties).length === 0) return null;
  return { type: "object", properties };
}

/** Convert a FormRequest rules() table into a JSON Schema object. */
export function formRulesToSchema(rules: PhpRule[], index: PhpModelIndex): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const arrayItems = new Map<string, JsonSchema>();

  for (const rule of rules) {
    const field = rule.name.replace(/\.\*$/, "");
    if (rule.name.includes(".*")) {
      arrayItems.set(field, ruleStringToSchema(rule.rules, index));
      continue;
    }
    const tokens = rule.rules.split("|").map((t) => t.trim().toLowerCase());
    const schema = ruleStringToSchema(rule.rules, index);
    const inRule = rule.rules.split("|").map(t => t.trim()).find((t) => t.toLowerCase().startsWith("in:"));
    if (inRule) {
      schema.enum = inRule
        .slice(3)
        .split(",")
        .map((v) => v.trim());
    }
    properties[field] = schema;
    if (!tokens.includes("sometimes") && (tokens.includes("required") || tokens.includes("present"))) required.push(field);
  }

  for (const [field, items] of arrayItems) {
    if (properties[field]?.type === "array" || (Array.isArray(properties[field]?.type) && properties[field]!.type.includes("array"))) {
      properties[field]!.items = Object.keys(items).length ? items : {};
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function ruleStringToSchema(rules: string, _index: PhpModelIndex): JsonSchema {
  const tokens = rules.split("|").map((t) => t.trim().toLowerCase());
  if (
    tokens.some(
      (t) =>
        t === "file" ||
        t === "image" ||
        t.startsWith("mimes:") ||
        t.startsWith("mimetypes:"),
    )
  ) {
    return { type: "string", format: "binary" };
  }
  let schema: JsonSchema = {};
  if (tokens.includes("array")) schema = { type: "array", items: {} };
  else if (tokens.includes("string") || tokens.some(t => t === "email" || t.startsWith("email:"))) schema = { type: "string" };
  else if (tokens.includes("integer") || tokens.includes("int")) schema = { type: "integer" };
  else if (tokens.includes("numeric") || tokens.includes("number")) schema = { type: "number" };
  else if (tokens.includes("boolean") || tokens.includes("bool")) schema = { type: "boolean" };
  else if (tokens.some(t => t.startsWith("in:"))) schema = {type: "string"};
  if (tokens.some(t => t === "email" || t.startsWith("email:"))) schema.format = "email";
  if (tokens.includes("uuid")) { schema.type = "string"; schema.format = "uuid"; }
  for (const token of tokens) {
    const match = /^(min|max|size):(-?\d+(?:\.\d+)?)$/.exec(token);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const kind = schema.type;
    const minimum = kind === "string" ? "minLength" : kind === "array" ? "minItems" : kind === "integer" || kind === "number" ? "minimum" : null;
    const maximum = kind === "string" ? "maxLength" : kind === "array" ? "maxItems" : kind === "integer" || kind === "number" ? "maximum" : null;
    if ((kind === "string" || kind === "array") && (!Number.isInteger(value) || value < 0)) continue;
    if (minimum && match[1] !== "max") schema[minimum] = value;
    if (maximum && match[1] !== "min") schema[maximum] = value;
  }
  if (tokens.includes("required")) {
    if (schema.type === "string") schema.minLength = Math.max(1, Number(schema.minLength ?? 0));
    if (schema.type === "array") schema.minItems = Math.max(1, Number(schema.minItems ?? 0));
  }
  // Required rejects null even when nullable is also specified.
  if (tokens.includes("nullable") && !tokens.includes("required") && typeof schema.type === "string") schema.type = [schema.type, "null"];
  return schema;
}

/** Formal parameters of a method or closure. */
export function formalParameters(node: TsNode): TsNode[] {
  const params = node.namedChildren.find((c) => c.type === "formal_parameters");
  if (!params) return [];
  return [
    ...childrenOfType(params, "simple_parameter"),
    ...childrenOfType(params, "property_promotion_parameter"),
  ];
}
