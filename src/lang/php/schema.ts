/**
 * PHP type -> JSON Schema conversion.
 *
 * Handles primitive and named scalar types, nullable types, model classes
 * (constructor promotion / public properties), backed enums and Laravel
 * FormRequest rule strings.
 */

import type { JsonSchema } from "../../core/types.js";
import type { PhpAnalysis, PhpClass, PhpRule } from "./index.js";
import { phpStringText } from "./index.js";
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
};

export function phpTypeToSchema(
  node: TsNode | undefined,
  index: PhpModelIndex,
  stack: Set<string> = new Set(),
  depth = 0,
): JsonSchema {
  if (!node || depth > 6) return {};

  if (node.type === "optional_type" || node.type === "nullable_type") {
    const inner = node.namedChildren.find(
      (c) =>
        c.type === "primitive_type" ||
        c.type === "named_type" ||
        c.type === "union_type",
    );
    return phpTypeToSchema(inner, index, stack, depth);
  }

  if (node.type === "primitive_type") {
    return SCALAR_NAMES[node.text.trim()] ?? {};
  }

  if (node.type === "union_type") {
    // Pick the first non-null member.
    const members = node.namedChildren.filter(
      (c) => c.type === "primitive_type" || c.type === "named_type",
    );
    const nonNull = members.find((c) => c.text.trim().toLowerCase() !== "null") ?? members[0];
    return nonNull ? phpTypeToSchema(nonNull, index, stack, depth) : {};
  }

  if (node.type === "named_type") {
    const name = node.namedChildren.find((c) => c.type === "name")?.text ?? node.text;
    const short = name.split("\\").pop()!;
    if (SCALAR_NAMES[short]) return SCALAR_NAMES[short]!;
    if (short === "Collection" || short === "LengthAwarePaginator" || short === "Paginator") {
      return { type: "array", items: {} };
    }
    if (index.analysis.enums.has(short)) {
      return ensurePhpComponent(short, index, stack) ?? { type: "string" };
    }
    if (index.analysis.classes.has(short)) {
      return ensurePhpComponent(short, index, stack) ?? {};
    }
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
  if (index.components.has(name)) return { $ref: `#/components/schemas/${name}` };
  if (stack.has(name)) return { $ref: `#/components/schemas/${name}` };
  stack.add(name);
  index.components.set(name, {});
  index.components.set(name, buildClassSchema(cls, index, stack));
  stack.delete(name);
  return { $ref: `#/components/schemas/${name}` };
}

function buildClassSchema(cls: PhpClass, index: PhpModelIndex, stack: Set<string>): JsonSchema {
  if (cls.resourceKind) {
    const resource = buildResourceSchema(cls, index, stack);
    if (resource) return resource;
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const prop of cls.properties) {
    const docType = cls.propertyDoc.get(prop.name);
    properties[prop.name] = docType
      ? docTypeToSchema(docType, index, stack)
      : phpTypeToSchema(prop.typeNode, index, stack);
    if (!prop.nullable && !prop.hasDefault) required.push(prop.name);
  }
  // Eloquent @property docblocks describe attributes without real properties.
  for (const [name, docType] of cls.docPropertyTypes) {
    if (!(name in properties)) {
      properties[name] = docTypeToSchema(docType, index, stack);
    }
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

/** Map a PHPDoc type (string[], Collection<string>, int|null) to a schema. */
function docTypeToSchema(docType: string, index: PhpModelIndex, stack: Set<string>): JsonSchema {
  const type = docType.trim().split(/[|&]/)[0]!.replace(/^\?/, "").trim();
  const arrayMatch = type.match(/^([\w\\]+)\[\]$/);
  if (arrayMatch) {
    return { type: "array", items: docTypeToSchema(arrayMatch[1]!, index, stack) };
  }
  const genericMatch = type.match(/^(?:Collection|array|list|Illuminate\\Support\\Collection|Illuminate\\Database\\Eloquent\\Collection)<(?:[^,]+,\s*)?([\w\\]+)>$/i);
  if (genericMatch) {
    return { type: "array", items: docTypeToSchema(genericMatch[1]!, index, stack) };
  }
  const short = type.split("\\").pop()!;
  if (SCALAR_NAMES[short]) return SCALAR_NAMES[short]!;
  if (index.analysis.enums.has(short)) {
    return ensurePhpComponent(short, index, stack) ?? { type: "string" };
  }
  if (index.analysis.classes.has(short)) {
    return ensurePhpComponent(short, index, stack) ?? {};
  }
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
    for (const branch of branches.slice(1)) {
      const schema = resourceValueSchema(branch, index, stack, mixinModel, ownerClass, depth + 1);
      if (schema && Object.keys(schema).length) return schema;
    }
    return null;
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
      const candidates = methodName === "when"
        ? [argNodes[1], argNodes[2]]
        : [argNodes[1]];
      for (const candidate of candidates) {
        const inner = candidate?.namedChildren[0];
        const schema = resourceValueSchema(inner, index, stack, mixinModel, ownerClass, depth + 1);
        if (schema && Object.keys(schema).length) return schema;
      }
      return null;
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
    return heuristicPropertySchema(propName);
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

/** Conservative scalar inference for common Laravel property names. */
function heuristicPropertySchema(prop: string): JsonSchema | null {
  if (/^(id|.*_id)$/.test(prop) || /(count|quantity|size|age)$/.test(prop)) {
    return { type: "integer" };
  }
  if (/^(is_|has_|should_)/.test(prop) || /^(active|enabled|deleted|archived)$/.test(prop)) {
    return { type: "boolean" };
  }
  if (/(price|amount|cost|fee|balance|total)$/.test(prop)) return { type: "number" };
  if (/(url|uri|link|href)$/.test(prop)) return { type: "string", format: "uri" };
  if (/(at)$/.test(prop)) return { type: "string", format: "date-time" };
  if (/(name|title|sku|slug|email|phone|token|key|status|type|description|caption|filename)$/.test(prop)) {
    return { type: "string" };
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
      const valueNode = element.namedChildren.find(
        (c) => c.type !== "string" && c.type !== "string_content",
      );
      const schema = resourceValueSchema(valueNode, index, stack, mixinModel, cls);
      if (schema && Object.keys(schema).length) {
        properties[key] = schema;
      }
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
    const inRule = tokens.find((t) => t.startsWith("in:"));
    if (inRule) {
      schema.enum = inRule
        .slice(3)
        .split(",")
        .map((v) => v.trim());
    }
    properties[field] = schema;
    if (tokens.includes("required") || tokens.includes("present")) required.push(field);
  }

  for (const [field, items] of arrayItems) {
    if (properties[field]?.type === "array") {
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
  if (tokens.includes("array")) return { type: "array", items: {} };
  if (tokens.some((t) => t.startsWith("exists:") || t === "string" || t.startsWith("string"))) {
    return { type: "string" };
  }
  if (tokens.includes("integer") || tokens.includes("int")) return { type: "integer" };
  if (tokens.includes("numeric") || tokens.includes("number")) return { type: "number" };
  if (tokens.includes("boolean") || tokens.includes("bool")) return { type: "boolean" };
  if (tokens.some((t) => t.startsWith("in:"))) return { type: "string" };
  return {};
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
