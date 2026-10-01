/**
 * PHP type -> JSON Schema conversion.
 *
 * Handles primitive and named scalar types, nullable types, model classes
 * (constructor promotion / public properties), backed enums and Laravel
 * FormRequest rule strings.
 */

import type { JsonSchema } from "../../core/types.js";
import type { PhpAnalysis, PhpClass, PhpRule } from "./index.js";
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

/**
 * Resolve a value expression inside an API Resource toArray() table.
 * Covers `$this->field`, nested `new XResource(...)`, `XResource::collection()`,
 * literals, pagination getters and homogeneous arrays. Returns null when the
 * value cannot be statically typed, so callers can emit an honest gap.
 */
function resourceValueSchema(
  node: TsNode | undefined,
  index: PhpModelIndex,
  stack: Set<string>,
  mixinModel: PhpClass | null,
  depth = 0,
): JsonSchema | null {
  if (!node || depth > 6) return null;

  const literal = phpLiteralSchema(node);
  if (literal) return literal;

  if (node.type === "conditional_expression") {
    const branches = node.namedChildren.filter((c) => c.type !== "else");
    for (const branch of branches.slice(1)) {
      const schema = resourceValueSchema(branch, index, stack, mixinModel, depth + 1);
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
    const scope = findFirst(node, (c) => c.type === "name" || c.type === "qualified_name");
    const method = findAll(node, (c) => c.type === "name").map((c) => c.text).pop();
    const scopeName = scope?.text.split("\\").pop();
    if (method === "collection" && scopeName && index.analysis.classes.has(scopeName)) {
      const ref = ensurePhpComponent(scopeName, index, stack);
      return ref ? { type: "array", items: ref } : null;
    }
    return null;
  }

  // $this->currentPage() / $this->total()
  if (node.type === "member_call_expression") {
    const methodName = findAll(node, (c) => c.type === "name").map((c) => c.text).pop();
    if (methodName && PAGINATOR_INTEGER_METHODS.has(methodName)) return { type: "integer" };
    if (methodName === "toArray") return { type: "object" };
    return null;
  }

  // $this->name
  if (node.type === "member_access_expression") {
    const propName = node.namedChildren.filter((c) => c.type === "name").pop()?.text;
    if (!propName) return null;
    const modelProp = mixinModel?.properties.find((p) => p.name === propName);
    if (modelProp) {
      const docType = mixinModel?.propertyDoc.get(propName);
      return docType
        ? docTypeToSchema(docType, index, stack)
        : phpTypeToSchema(modelProp.typeNode, index, stack);
    }
    return null;
  }

  if (node.type === "array_creation_expression") {
    const elements = childrenOfType(node, "array_element_initializer");
    if (elements.length === 0) return { type: "array", items: {} };
    const itemSchemas = elements.map((element) => {
      const value = element.namedChildren.find((c) => c.type !== "string") ?? element;
      return resourceValueSchema(value, index, stack, mixinModel, depth + 1);
    });
    const first = itemSchemas[0];
    if (first && itemSchemas.every((s) => s && JSON.stringify(s) === JSON.stringify(first))) {
      return { type: "array", items: first };
    }
    return null;
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
      const schema = resourceValueSchema(valueNode, index, stack, mixinModel);
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
