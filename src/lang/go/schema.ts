/**
 * Go struct -> JSON Schema conversion.
 *
 * Honors `json` struct tags, pointer/slice/map types, time.Time and named
 * struct references. Components are emitted by the framework pack through
 * ensureComponent.
 */

import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoField, GoStruct } from "./index.js";
import { jsonTag } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";

const GO_PRIMITIVES: Record<string, JsonSchema> = {
  string: { type: "string" },
  bool: { type: "boolean" },
  int: { type: "integer", format: "int64" },
  int8: { type: "integer", format: "int32" },
  int16: { type: "integer", format: "int32" },
  int32: { type: "integer", format: "int32" },
  int64: { type: "integer", format: "int64" },
  uint: { type: "integer", format: "int64" },
  uint8: { type: "integer", format: "int32" },
  uint16: { type: "integer", format: "int32" },
  uint32: { type: "integer", format: "int32" },
  uint64: { type: "integer", format: "int64" },
  float32: { type: "number", format: "float" },
  float64: { type: "number", format: "double" },
};

export interface GoModelIndex {
  readonly byName: Map<string, GoStruct>;
  readonly components: Map<string, JsonSchema>;
}

export function buildGoModelIndex(analysis: GoAnalysis): GoModelIndex {
  const byName = new Map<string, GoStruct>();
  for (const struct of analysis.structs.values()) {
    // First declaration wins; duplicate names are uncommon in one package.
    if (!byName.has(struct.name)) byName.set(struct.name, struct);
  }
  return { byName, components: new Map() };
}

function fieldName(field: GoField): string {
  const tagged = jsonTag(field).name;
  if (tagged) return tagged;
  // Gin/encoding/json uses the exported Go field name when untagged.
  return field.goName;
}

function isSkipped(field: GoField): boolean {
  const tag = jsonTag(field);
  return tag.name === null && field.tag !== null && /json:"-"/.test(field.tag);
}

function isRequired(field: GoField): boolean {
  // No omitempty and no pointer -> required. Standard encoding/json treats
  // pointer and omitempty fields as optional.
  if (jsonTag(field).omitempty) return false;
  if (field.typeNode.type === "pointer_type") return false;
  return true;
}

export function buildStructSchema(
  struct: GoStruct,
  index: GoModelIndex,
  depth = 0,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const field of struct.fields) {
    if (isSkipped(field)) continue;
    const name = fieldName(field);
    if (!name) continue;
    properties[name] = goTypeToSchema(field.typeNode, index, depth + 1);
    if (isRequired(field)) required.push(name);
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function ensureGoComponent(
  name: string,
  index: GoModelIndex,
  stack: Set<string> = new Set(),
): void {
  if (index.components.has(name)) return;
  const struct = index.byName.get(name);
  if (!struct) return;
  if (stack.has(name)) return;
  stack.add(name);
  // Reserve the slot to break recursive references.
  index.components.set(name, {});
  index.components.set(name, buildStructSchema(struct, index));
  stack.delete(name);
}

export function goTypeToSchema(
  node: TsNode,
  index: GoModelIndex,
  depth = 0,
): JsonSchema {
  if (depth > 6) return {};

  if (node.type === "pointer_type") {
    const inner = node.namedChildren[0];
    return inner ? goTypeToSchema(inner, index, depth + 1) : {};
  }

  if (node.type === "slice_type" || node.type === "array_type") {
    const inner = node.namedChildren[0];
    return {
      type: "array",
      items: inner ? goTypeToSchema(inner, index, depth + 1) : {},
    };
  }

  if (node.type === "map_type") {
    const value = node.namedChildren[1];
    const schema: JsonSchema = { type: "object" };
    if (value) schema.additionalProperties = goTypeToSchema(value, index, depth + 1);
    return schema;
  }

  if (node.type === "qualified_type") {
    const pkg = node.namedChildren[0];
    const typeName = node.namedChildren[1];
    if (pkg?.text === "time" && typeName?.text === "Time") {
      return { type: "string", format: "date-time" };
    }
    // Types from other packages are opaque without cross-package resolution.
    return {};
  }

  if (node.type === "interface_type") {
    return {};
  }

  if (node.type === "struct_type") {
    const fieldList = node.namedChildren.find((child) => child.type === "field_declaration_list");
    const properties: Record<string, JsonSchema> = {};
    if (fieldList) {
      for (const fieldNode of fieldList.namedChildren.filter((c) => c.type === "field_declaration")) {
        const names = fieldNode.namedChildren.filter((c) => c.type === "field_identifier");
        const typeNode = fieldNode.namedChildren.find((c) => c.type !== "field_identifier" && c.type !== "raw_string_literal");
        if (!typeNode) continue;
        for (const nameNode of names) {
          properties[nameNode.text] = goTypeToSchema(typeNode, index, depth + 1);
        }
      }
    }
    return { type: "object", properties };
  }

  if (node.type === "type_identifier") {
    const primitive = GO_PRIMITIVES[node.text];
    if (primitive) return { ...primitive };
    if (index.byName.has(node.text)) {
      ensureGoComponent(node.text, index);
      return { $ref: `#/components/schemas/${node.text}` };
    }
    return {};
  }

  return {};
}

/**
 * Resolve a variable identifier to its declared type node, scanning handler
 * bodies for `var x Type` / `x := Type{...}` / `var x = Type{...}` patterns.
 */
export function resolveLocalType(
  body: TsNode | null,
  variableName: string,
): TsNode | null {
  if (!body) return null;

  for (const declaration of body.namedChildren.flatMap((child) =>
    findNamed(child, "var_declaration"),
  )) {
    for (const spec of declaration.namedChildren.filter((c) => c.type === "var_spec")) {
      const names = spec.namedChildren.filter((c) => c.type === "identifier");
      const typeNode = spec.namedChildren.find(
        (c) => !names.includes(c) && c.type !== "expression_list",
      );
      if (names.some((n) => n.text === variableName) && typeNode) {
        return typeNode;
      }
    }
  }

  for (const declaration of findNamed(body, "short_var_declaration")) {
    const left = declaration.namedChildren.find((c) => c.type === "expression_list");
    const right = declaration.namedChildren.find((c) => c.type === "expression_list");
    if (!left || !right) continue;
    const index = left.namedChildren.findIndex((c) => c.text === variableName);
    if (index < 0) continue;
    const value = right.namedChildren[index];
    if (!value) continue;
    // x := Type{...} or x := &Type{...}.
    const composite = findFirstNamed(value, "composite_literal");
    if (composite) return composite.namedChildren[0] ?? null;
  }

  return null;
}

function findNamed(node: TsNode, type: string): TsNode[] {
  const result: TsNode[] = [];
  const walk = (current: TsNode) => {
    if (current.type === type) result.push(current);
    for (const child of current.namedChildren) walk(child);
  };
  walk(node);
  return result;
}

function findFirstNamed(node: TsNode, type: string): TsNode | null {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findFirstNamed(child, type);
    if (found) return found;
  }
  return null;
}
