/**
 * Go struct -> JSON Schema conversion.
 *
 * Honors `json` struct tags, pointer/slice/map types, time.Time and named
 * struct references. Components are emitted by the framework pack through
 * ensureComponent.
 */

import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoField, GoFunction, GoStruct } from "./index.js";
import { jsonTag } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  positionalArguments,
} from "../treesitter/ast.js";

/** Shared HTTP status constants, mirrored from net/http. */
const HTTP_STATUS: Record<string, string> = {
  StatusContinue: "100",
  StatusOK: "200",
  StatusCreated: "201",
  StatusAccepted: "202",
  StatusNoContent: "204",
  StatusBadRequest: "400",
  StatusUnauthorized: "401",
  StatusForbidden: "403",
  StatusNotFound: "404",
  StatusMethodNotAllowed: "405",
  StatusConflict: "409",
  StatusUnprocessableEntity: "422",
  StatusTooManyRequests: "429",
  StatusInternalServerError: "500",
  StatusNotImplemented: "501",
  StatusBadGateway: "502",
  StatusServiceUnavailable: "503",
};

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
  stack: Set<string> = new Set(),
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  // Declared fields win over promoted (embedded) fields on JSON name conflicts.
  const declaredNames = new Set<string>();
  for (const field of struct.fields) {
    if (field.embedded) continue;
    if (isSkipped(field)) continue;
    const name = fieldName(field);
    if (!name) continue;
    declaredNames.add(name);
    properties[name] = goTypeToSchema(field.typeNode, index, depth + 1, stack);
    if (isRequired(field)) required.push(name);
  }

  for (const field of struct.fields) {
    if (!field.embedded) continue;
    const inner = field.typeNode.type === "pointer_type" ? field.typeNode.namedChildren[0] : field.typeNode;
    const embeddedName = inner?.type === "type_identifier" ? inner.text : null;
    const embeddedStruct = embeddedName ? index.byName.get(embeddedName) : undefined;
    if (inner && embeddedStruct) {
      // encoding/json promotes the embedded struct's fields to the same level.
      ensureGoComponent(embeddedName!, index, stack);
      const promoted = index.components.get(embeddedName!);
      const promotedProps = (promoted?.properties ?? {}) as Record<string, JsonSchema>;
      for (const [name, schema] of Object.entries(promotedProps)) {
        if (declaredNames.has(name)) continue;
        properties[name] = schema;
        declaredNames.add(name);
        // Pointer-embedded structs may be nil; their fields stay optional.
        if (
          field.typeNode.type !== "pointer_type" &&
          Array.isArray(promoted?.required) &&
          (promoted!.required as string[]).includes(name)
        ) {
          required.push(name);
        }
      }
      continue;
    }
    // Non-struct embedding (primitive alias, external package type): the JSON
    // key is the unqualified type name.
    const key = (embeddedName ?? field.goName.split(".").pop() ?? field.goName).replace(/^\*/, "");
    if (!declaredNames.has(key)) {
      properties[key] = goTypeToSchema(field.typeNode, index, depth + 1, stack);
      declaredNames.add(key);
      if (isRequired(field)) required.push(key);
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = [...new Set(required)];
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
  index.components.set(name, buildStructSchema(struct, index, 0, stack));
  stack.delete(name);
}

export function goTypeToSchema(
  node: TsNode,
  index: GoModelIndex,
  depth = 0,
  stack: Set<string> = new Set(),
): JsonSchema {
  if (depth > 6) return {};

  if (node.type === "pointer_type") {
    const inner = node.namedChildren[0];
    return inner ? goTypeToSchema(inner, index, depth + 1, stack) : {};
  }

  if (node.type === "slice_type" || node.type === "array_type") {
    const inner = node.namedChildren[0];
    return {
      type: "array",
      items: inner ? goTypeToSchema(inner, index, depth + 1, stack) : {},
    };
  }

  if (node.type === "map_type") {
    const value = node.namedChildren[1];
    const schema: JsonSchema = { type: "object" };
    if (value) schema.additionalProperties = goTypeToSchema(value, index, depth + 1, stack);
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
    const lists = declaration.namedChildren.filter((c) => c.type === "expression_list");
    const left = lists[0];
    const right = lists[1];
    if (!left || !right) continue;
    const index = left.namedChildren.findIndex((c) => c.text === variableName);
    if (index < 0) continue;
    const value = right.namedChildren[index];
    if (!value) continue;
    // x := Type{...} or x := &Type{...}.
    const composite = findFirstNamed(value, "composite_literal");
    if (composite) return composite.namedChildren[0] ?? null;
    // x := new(Type).
    if (
      value.type === "call_expression" &&
      value.namedChildren[0]?.type === "identifier" &&
      value.namedChildren[0]?.text === "new"
    ) {
      const args = value.namedChildren.filter((c) => c.type === "type_identifier");
      if (args[0]) return args[0];
    }
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

/**
 * Result of resolving a render/JSON payload value to a JSON schema and, when a
 * constructor literally sets one, a statically provable HTTP status code.
 */
export interface ResolvedGoValue {
  schema: JsonSchema | null;
  status: string | null;
}

const MAX_RESOLVE_DEPTH = 5;

/** Unqualified callee name of a call: `NewX` or `pkg.NewX`. */
function calleeName(call: TsNode): string | null {
  const callee = call.namedChildren[0];
  if (!callee) return null;
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "selector_expression") {
    return callee.namedChildren[1]?.text ?? null;
  }
  return null;
}

/** The declared result (return) type node of a function/method, or null. */
export function functionResultTypeNode(fn: GoFunction): TsNode | null {
  const kids = fn.node.namedChildren;
  let paramsIndex = -1;
  kids.forEach((kid, index) => {
    if (kid.type === "parameter_list") paramsIndex = index;
  });
  if (paramsIndex < 0) return null;
  const next = kids[paramsIndex + 1];
  if (!next || next.type === "block") return null;
  if (next.type === "parameter_list") {
    const decl = childrenOfType(next, "parameter_declaration")[0];
    const typeNode = decl?.namedChildren.find((child) => child.type !== "identifier");
    return typeNode ?? null;
  }
  return next;
}

/** int_literal or http.StatusX selector -> status string. */
function literalToStatus(node: TsNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "int_literal") return node.text.trim();
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field ? HTTP_STATUS[field.text] ?? null : null;
  }
  return null;
}

/** Read `HTTPStatusCode: <code>` out of a single composite literal node. */
function compositeStatus(comp: TsNode): string | null {
  const value = comp.namedChildren[1];
  if (!value) return null;
  for (const element of childrenOfType(value, "keyed_element")) {
    const keyNode = unwrapLiteral(element.namedChildren[0]);
    if (keyNode?.text === "HTTPStatusCode") {
      const status = literalToStatus(unwrapLiteral(element.namedChildren[1]));
      if (status) return status;
    }
  }
  return null;
}

/** Unwrap a `literal_element` wrapper used inside composite literal bodies. */
function unwrapLiteral(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  return node.type === "literal_element" ? node.namedChildren[0] ?? node : node;
}

/** Scan a function body for an `HTTPStatusCode: <code>` composite literal. */
function extractStatus(body: TsNode | null): string | null {
  if (!body) return null;
  for (const comp of findAll(body, (n) => n.type === "composite_literal")) {
    const status = compositeStatus(comp);
    if (status) return status;
  }
  return null;
}

/** True when the type node names a known struct (pointer/qualified unwrapped). */
function structRefSchema(typeNode: TsNode, index: GoModelIndex): JsonSchema | null {
  let node: TsNode | undefined = typeNode;
  while (node && node.type === "pointer_type") node = node.namedChildren[0];
  if (!node) return null;
  if (node.type === "type_identifier") {
    if (index.byName.has(node.text)) {
      ensureGoComponent(node.text, index);
      return { $ref: `#/components/schemas/${node.text}` };
    }
    const primitive = GO_PRIMITIVES[node.text];
    return primitive ? { ...primitive } : null;
  }
  if (node.type === "qualified_type") {
    const name = node.namedChildren[1]?.text;
    if (name && index.byName.has(name)) {
      ensureGoComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
    }
  }
  return null;
}

interface DerivedStruct {
  name: string;
  kind: "obj" | "array";
}

/**
 * Resolve what struct an arbitrary returned/appended expression actually
 * constructs, following local assignments and nested constructor calls.
 */
function deriveStructFromExpr(
  expr: TsNode,
  body: TsNode,
  index: GoModelIndex,
  analysis: GoAnalysis,
  vars: Map<string, { value: TsNode | null }>,
  depth: number,
): DerivedStruct | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  let node: TsNode = expr;
  while (node.type === "unary_expression") node = node.namedChildren[0] ?? node;

  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
      return { name: t.text, kind: "obj" };
    }
    return null;
  }

  if (node.type === "call_expression") {
    const callee = node.namedChildren[0];
    if (callee?.type === "identifier" && callee.text === "append") {
      const args = positionalArguments(node);
      const names = new Set<string>();
      for (const element of args.slice(1)) {
        const derived = deriveStructFromExpr(element, body, index, analysis, vars, depth + 1);
        if (derived?.name) names.add(derived.name);
      }
      if (names.size === 1) return { name: [...names][0], kind: "array" };
      return null;
    }
    const resolved = followCallToSchema(node, analysis, index, vars, depth + 1);
    const refSchema = resolved.schema as { $ref?: string } | null | undefined;
    const refName = refSchema?.$ref?.split("/").pop();
    if (refName) return { name: refName, kind: "obj" };
    const items = resolved.schema?.items as JsonSchema | undefined;
    const itemsRef = (items as { $ref?: string } | undefined)?.$ref?.split("/").pop();
    if (resolved.schema?.type === "array" && itemsRef) {
      return { name: itemsRef, kind: "array" };
    }
    return null;
  }

  if (node.type === "identifier") {
    // x := Constructor(...) or x := Type{...}
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const left = decl.namedChildren.find((c) => c.type === "expression_list");
      const right = decl.namedChildren.filter((c) => c.type === "expression_list")[1];
      if (!left || !right) continue;
      const at = left.namedChildren.findIndex((c) => c.text === node.text);
      if (at >= 0 && right.namedChildren[at]) {
        const derived = deriveStructFromExpr(right.namedChildren[at], body, index, analysis, vars, depth + 1);
        if (derived) return derived;
      }
    }
    // x = append(x, ...) / x = Constructor(...)
    for (const decl of findAll(body, (n) => n.type === "assignment_statement")) {
      const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
      const left = lists[0];
      const right = lists[lists.length - 1];
      if (!left || !right) continue;
      const at = left.namedChildren.findIndex((c) => c.text === node.text);
      if (at >= 0 && right.namedChildren[at]) {
        const derived = deriveStructFromExpr(right.namedChildren[at], body, index, analysis, vars, depth + 1);
        if (derived) return derived;
      }
    }
  }
  return null;
}

/**
 * Follow a constructor/service function's declared return type, and when that
 * type is opaque (e.g. `render.Renderer` or `[]render.Renderer`) follow the
 * function body to learn the concrete struct it builds. Also extracts a
 * statically provable HTTP status from an `HTTPStatusCode: <code>` literal.
 */
export function followCallToSchema(
  call: TsNode,
  analysis: GoAnalysis,
  index: GoModelIndex,
  vars: Map<string, { value: TsNode | null }>,
  depth = 0,
): ResolvedGoValue {
  if (depth > MAX_RESOLVE_DEPTH) return { schema: null, status: null };
  const name = calleeName(call);
  if (!name) return { schema: null, status: null };
  const candidates = analysis.functions.get(name) ?? [];
  const fn = candidates.find((candidate) => candidate.body) ?? candidates[0];
  if (!fn) return { schema: null, status: null };

  const resultType = functionResultTypeNode(fn);
  let schema: JsonSchema | null = null;
  if (resultType) {
    let node: TsNode = resultType;
    while (node.type === "pointer_type") node = node.namedChildren[0] ?? node;
    if (node.type === "slice_type" || node.type === "array_type") {
      const inner = node.namedChildren[0];
      const innerSchema = inner ? structRefSchema(inner, index) : null;
      if (innerSchema) schema = { type: "array", items: innerSchema };
    } else {
      schema = structRefSchema(resultType, index);
    }
  }

  if (!schema) {
    // Opaque declared return (interface): follow the body for the concrete type.
    const concrete = bodyFollowConcreteStruct(fn, index, analysis, vars, depth + 1);
    schema = concrete;
  }
  return { schema, status: extractStatus(fn.body) };
}

function bodyFollowConcreteStruct(
  fn: GoFunction,
  index: GoModelIndex,
  analysis: GoAnalysis,
  vars: Map<string, { value: TsNode | null }>,
  depth: number,
): JsonSchema | null {
  if (depth > MAX_RESOLVE_DEPTH || !fn.body) return null;
  const returns = findAll(fn.body, (n) => n.type === "return_statement").flatMap((statement) => {
    const list = statement.namedChildren.find((c) => c.type === "expression_list");
    return list ? list.namedChildren : (statement.namedChildren[0] ? [statement.namedChildren[0]] : []);
  });
  const names = new Set<string>();
  let isArray = false;
  for (const ret of returns) {
    const derived = deriveStructFromExpr(ret, fn.body, index, analysis, vars, depth);
    if (!derived?.name) continue;
    names.add(derived.name);
    if (derived.kind === "array") isArray = true;
  }
  if (names.size !== 1) return null;
  const name = [...names][0];
  if (!index.byName.has(name)) return null;
  ensureGoComponent(name, index);
  const ref: JsonSchema = { $ref: `#/components/schemas/${name}` };
  return isArray ? { type: "array", items: ref } : ref;
}

/**
 * Resolve a render.Render / c.JSON payload value (a constructor call, a local
 * variable, a package-level render.Renderer var, or a composite literal) to its
 * JSON schema and any provable status. Never throws; returns nulls when the
 * shape cannot be proven statically.
 */
export function resolveGoPayloadValue(
  value: TsNode | null | undefined,
  handlerBody: TsNode | null,
  analysis: GoAnalysis,
  index: GoModelIndex,
  vars: Map<string, { value: TsNode | null }>,
  depth = 0,
): ResolvedGoValue {
  if (!value || depth > MAX_RESOLVE_DEPTH) return { schema: null, status: null };
  let node: TsNode = value;
  while (node.type === "unary_expression") node = node.namedChildren[0] ?? node;

  if (node.type === "call_expression") {
    return followCallToSchema(node, analysis, index, vars, depth + 1);
  }

  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
      ensureGoComponent(t.text, index);
      return {
        schema: { $ref: `#/components/schemas/${t.text}` },
        status: compositeStatus(node),
      };
    }
    return { schema: null, status: null };
  }

  if (node.type === "identifier") {
    // Local variable assigned a constructor call: resp := NewArticleResponse(...)
    if (handlerBody) {
      const callValue = findAssignedCall(handlerBody, node.text);
      if (callValue) return followCallToSchema(callValue, analysis, index, vars, depth + 1);
      const localType = resolveLocalType(handlerBody, node.text);
      if (localType) {
        const schema = structRefSchema(localType, index);
        if (schema) return { schema, status: null };
      }
    }
    // Package-level variable: var ErrNotFound = &ErrResponse{...}
    const variable = vars.get(node.text);
    if (variable?.value) {
      return resolveGoPayloadValue(variable.value, handlerBody, analysis, index, vars, depth + 1);
    }
  }

  return { schema: null, status: null };
}

/** Find `name := Foo(...)` / `name = Foo(...)` and return the call node. */
function findAssignedCall(body: TsNode, name: string): TsNode | null {
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
    const left = decl.namedChildren.find((c) => c.type === "expression_list");
    const right = decl.namedChildren.filter((c) => c.type === "expression_list")[1];
    if (!left || !right) continue;
    const at = left.namedChildren.findIndex((c) => c.text === name);
    if (at >= 0 && right.namedChildren[at]?.type === "call_expression") return right.namedChildren[at];
  }
  for (const decl of findAll(body, (n) => n.type === "assignment_statement")) {
    const left = decl.namedChildren.find((c) => c.type === "expression_list");
    const right = decl.namedChildren.find((c) => c.type === "expression_list");
    if (!left || !right) continue;
    const at = left.namedChildren.findIndex((c) => c.text === name);
    if (at >= 0 && right.namedChildren[at]?.type === "call_expression") return right.namedChildren[at];
  }
  return null;
}
