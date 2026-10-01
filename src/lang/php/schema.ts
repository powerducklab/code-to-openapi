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
import { childrenOfType } from "../treesitter/ast.js";

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
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const prop of cls.properties) {
    properties[prop.name] = phpTypeToSchema(prop.typeNode, index, stack);
    if (!prop.nullable && !prop.hasDefault) required.push(prop.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
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
