/**
 * Go struct -> JSON Schema conversion.
 *
 * Honors `json` struct tags, pointer/slice/map types, time.Time and named
 * struct references. Components are emitted by the framework pack through
 * ensureComponent.
 */

import { goResultType, resolveGoCall, goExpressionType, goTypeDeclaration, goSourceFile } from "./symbols.js";
import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoField, GoFunction, GoStruct } from "./index.js";
import { jsonTag, goStructFields } from "./index.js";
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
  readonly analysis?: GoAnalysis;
  readonly input?: boolean;
  readonly validated?: boolean;
  readonly validationTag?: "validate" | "binding";
  readonly byName: Map<string, GoStruct>;
  readonly components: Map<string, JsonSchema>;
  readonly aliases?: Map<string, string>;
}

export function buildGoModelIndex(analysis: GoAnalysis): GoModelIndex {
  const byName = new Map<string, GoStruct>();
  const aliases = new Map<string, string>();
  const reserved = new Set([...analysis.structs.values()].map(struct => struct.name));
  for (const struct of analysis.structs.values()) {
    let alias = struct.name;
    if (byName.has(alias)) {
      let suffix = 2;
      while (byName.has(`${struct.name}_${suffix}`) || reserved.has(`${struct.name}_${suffix}`)) suffix++;
      alias = `${struct.name}_${suffix}`;
    }
    byName.set(alias, struct);
    aliases.set(`${struct.file}::${struct.name}`, alias);
  }
  return { analysis, byName, aliases, components: new Map() };
}

function fieldName(field: GoField): string {
  const tagged = jsonTag(field).name;
  if (tagged) return tagged;
  // Gin/encoding/json uses the exported Go field name when untagged.
  return field.goName;
}

function isSkipped(field: GoField): boolean {
  const tag = jsonTag(field);
  if (!field.embedded && !/^\p{Lu}/u.test(field.goName)) return true;
  return tag.name === null && field.tag !== null && /json:"-"/.test(field.tag);
}

function isRequired(field: GoField, index: GoModelIndex): boolean {
  // encoding/json leaves omitted input fields at their zero value.
  if (index.input) {
    if (!index.validated) return false;
    const rules = field.tag?.match(new RegExp(`${index.validationTag ?? "validate"}:"([^"]*)"`))?.[1].split(",") ?? [];
    if (rules.includes("omitempty")) return false;
    return rules.includes("required") || (field.typeNode.text === "string" && rules.some(rule => /^min=[1-9][0-9]*$/.test(rule)));
  }
  // A nil pointer without an omission tag is still emitted, with JSON null.
  if (field.tag?.match(/json:"[^"]*,omitzero(?:,|")/)) return false;
  if (jsonTag(field).omitempty) {
    // encoding/json's legacy emptiness test never omits struct values or
    // non-empty fixed arrays, even when every element is zero.
    const type = field.typeNode;
    if (type.type === 'struct_type') return true;
    if (type.type === 'array_type' && /^[1-9]\d*$/.test(type.namedChildren[0]?.text ?? '')) return true;
    if (type.type !== 'pointer_type' && index.analysis && goTypeDeclaration(type, index.analysis)?.type.type === 'struct_type') return true;
    return false;
  }
  return true;
}

function nullableGoSchema(schema: JsonSchema): JsonSchema {
  if (!Object.keys(schema).length) return schema;
  if (schema.type) return {...schema, type: [...new Set([...(Array.isArray(schema.type) ? schema.type : [schema.type]), 'null'])]};
  return {anyOf: [schema, {type: 'null'}]};
}

/** Whether a schema admits null (type union or anyOf null branch). */
function isNullableGoSchema(schema: JsonSchema | null | undefined): boolean {
  if (!schema) return true; // an unproven/empty schema is treated as nullable
  if (Array.isArray(schema.type)) return schema.type.includes('null');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(branch => (branch as JsonSchema)?.type === 'null');
  // A concrete type or $ref is non-null; an empty/unresolved schema is not proof.
  if (schema.type || schema.$ref) return false;
  return true;
}

function nonNullGoSchema(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.type)) {
    const type = schema.type.filter(value => value !== 'null');
    return {...schema, type: type.length === 1 ? type[0] : type};
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(value => (value as JsonSchema).type !== 'null');
    return branches.length === 1 ? branches[0] as JsonSchema : {...schema, anyOf: branches};
  }
  return schema;
}

export function buildStructSchema(
  struct: GoStruct,
  index: GoModelIndex,
  depth = 0,
  stack: Set<string> = new Set(),
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const unresolvedEmbedded: string[] = [];

  type Candidate = {field: GoField; depth: number; nullableParent: boolean; tagged: boolean};
  const candidates = new Map<string, Candidate[]>();
  const queue = [{owner: struct, depth: 0, nullableParent: false, ancestors: new Set<string>()}];
  while (queue.length) {
    const current = queue.shift()!;
    const identity = `${current.owner.file}:${current.owner.name}`;
    if (current.depth > 16) { unresolvedEmbedded.push(current.owner.name); continue; }
    if (current.ancestors.has(identity)) continue;
    const ancestors = new Set(current.ancestors).add(identity);
    for (const field of current.owner.fields) {
      if (isSkipped(field)) continue;
      const tag = jsonTag(field);
      const inner = field.typeNode.type === "pointer_type" ? field.typeNode.namedChildren[0] : field.typeNode;
      const definition = inner && index.analysis ? goTypeDeclaration(inner, index.analysis) : undefined;
      const embeddedStruct = definition?.type.type === 'struct_type'
        ? {name: definition.name, file: definition.file.path, node: definition.type, fields: goStructFields(definition.type)}
        : inner?.type === 'type_identifier' && !index.analysis ? index.byName.get(inner.text) : undefined;
      if (field.embedded && !tag.name && embeddedStruct) {
        queue.push({owner: embeddedStruct, depth: current.depth + 1,
          nullableParent: current.nullableParent || field.typeNode.type === 'pointer_type', ancestors});
        continue;
      }
      if (field.embedded && !tag.name && inner?.type === 'qualified_type' && !embeddedStruct) {
        unresolvedEmbedded.push(inner.text);
        continue;
      }
      // Unexported anonymous structs can promote exported fields; unexported
      // anonymous scalars cannot become JSON properties, even with a tag.
      if (field.embedded && !embeddedStruct && !/^\p{Lu}/u.test(field.goName.split('.').pop()?.replace(/^\*/, '') ?? '')) continue;
      const name = tag.name ?? (field.embedded ? field.goName.split('.').pop()?.replace(/^\*/, '') : field.goName);
      if (!name) continue;
      const entries = candidates.get(name) ?? [];
      entries.push({field, depth: current.depth, nullableParent: current.nullableParent, tagged: !!tag.name});
      candidates.set(name, entries);
    }
  }
  for (const [name, entries] of candidates) {
    const winningDepth = Math.min(...entries.map(entry => entry.depth));
    let winners = entries.filter(entry => entry.depth === winningDepth);
    if (winners.some(entry => entry.tagged)) winners = winners.filter(entry => entry.tagged);
    // encoding/json drops ambiguous fields, rather than choosing whichever
    // embedded declaration happened to be indexed first.
    if (winners.length !== 1) continue;
    const {field, nullableParent} = winners[0]!;
    properties[name] = goTypeToSchema(field.typeNode, index, depth + 1, stack);
    if (!index.input && jsonTag(field).omitempty) properties[name] = nonNullGoSchema(properties[name]!);
    if (field.tag?.match(/json:"[^"]*,string(?:,|")/) &&
        /^(?:\*\s*)?(?:string|bool|u?int(?:8|16|32|64)?|float(?:32|64))$/.test(field.typeNode.text)) {
      properties[name] = field.typeNode.type === 'pointer_type' && (index.input || !jsonTag(field).omitempty)
        ? {type: ['string', 'null']} : {type: 'string'};
    }
    if (index.input && index.validated) {
      const rules = field.tag?.match(new RegExp(`${index.validationTag ?? "validate"}:"([^"]*)"`))?.[1].split(",") ?? [];
      if (rules.includes("required") && !rules.includes("omitempty")) properties[name] = nonNullGoSchema(properties[name]!);
      const property = properties[name]!;
      const types = Array.isArray(property.type) ? property.type : [property.type];
      if (types.includes("string")) for (const rule of rules) {
        const match = /^(min|max)=([0-9]+)$/.exec(rule);
        if (match) property[match[1] === "min" ? "minLength" : "maxLength"] = Number(match[2]);
      }
    }
    if (!nullableParent && isRequired(field, index)) required.push(name);
  }

  const schema: JsonSchema = { type: "object", properties };
  if (unresolvedEmbedded.length) schema["x-code-to-openapi-unresolved-embedded"] = unresolvedEmbedded;
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

/** A literal slice/array is constructed, so it cannot serialize as nil. */
export function goConstructedTypeToSchema(node: TsNode, index: GoModelIndex, depth = 0): JsonSchema {
  return nonNullGoSchema(goTypeToSchema(node, index, depth));
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
    return inner ? nullableGoSchema(goTypeToSchema(inner, index, depth + 1, stack)) : {};
  }

  if (node.type === "slice_type" || node.type === "array_type") {
    const inner = node.namedChildren.at(-1);
    if (node.type === 'slice_type' && inner && ['byte', 'uint8'].includes(inner.text)) return index.input
      ? {anyOf:[{type:'string',contentEncoding:'base64'},{type:'array',items:{type:'integer',minimum:0,maximum:255}},{type:'null'}]}
      : {type:['string','null'], contentEncoding:'base64'};
    const schema: JsonSchema = {
      type: "array",
      items: inner ? goTypeToSchema(inner, index, depth + 1, stack) : {},
    };
    const length = node.type === 'array_type' ? node.namedChildren[0]?.text : undefined;
    if (!index.input && length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) {
      schema.minItems = schema.maxItems = Number(length);
    }
    return node.type === 'slice_type' ? nullableGoSchema(schema) : schema;
  }

  if (node.type === "map_type") {
    const value = node.namedChildren[1];
    const schema: JsonSchema = { type: "object" };
    if (value) schema.additionalProperties = goTypeToSchema(value, index, depth + 1, stack);
    return nullableGoSchema(schema);
  }

  if (node.type === "qualified_type") {
    const pkg = node.namedChildren[0];
    const typeName = node.namedChildren[1];
    if (pkg?.text === "time" && typeName?.text === "Time") {
      return { type: "string", format: "date-time" };
    }
    return index.analysis ? localGoTypeToSchema(node, index.analysis, index, depth + 1) : {};
  }

  if (node.type === "interface_type") {
    return {};
  }

  if (node.type === "struct_type") {
    return buildStructSchema({ name:"",file:"",node,fields:goStructFields(node) }, index, depth + 1, stack);
  }

  if (node.type === "type_identifier") {
    const primitive = GO_PRIMITIVES[node.text];
    if (primitive) return { ...primitive };
    const declaration = index.analysis ? goTypeDeclaration(node, index.analysis) : undefined;
    const name = declaration ? index.aliases?.get(`${declaration.file.path}::${declaration.name}`) ?? node.text : node.text;
    if (index.byName.has(name)) {
      if (index.analysis && (!declaration || declaration.file.path !== index.byName.get(name)?.file)) return {};
      ensureGoComponent(name, index);
      return { $ref: `#/components/schemas/${name}` };
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
      const explicitType = spec.namedChildren.find(
        (c) => !names.includes(c) && c.type !== "expression_list",
      );
      if (!names.some((n) => n.text === variableName)) continue;
      if (explicitType) return explicitType;
      // `var form = EditForm{...}` inside a var block infers the type from the
      // composite literal / new() call on the right-hand side.
      const exprList = spec.namedChildren.find((c) => c.type === "expression_list");
      const idx = names.findIndex((n) => n.text === variableName);
      const value = exprList?.namedChildren[idx];
      const composite = value ? findFirstNamed(value, "composite_literal") : undefined;
      if (composite) return composite.namedChildren[0] ?? null;
      if (
        value?.type === "call_expression" &&
        value.namedChildren[0]?.type === "identifier" &&
        value.namedChildren[0]?.text === "new"
      ) {
        return value.namedChildren.find((c) => c.type === "type_identifier") ?? null;
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
  return goResultType(fn.node) ?? null;
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
  const schema = goTypeToSchema(typeNode, index);
  return Object.keys(schema).length ? schema : null;
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

/** Unwrap pointer/type layers to the underlying named struct identifier. */
function namedStructOf(node: TsNode | undefined | null): string | null {
  let t = node;
  while (t && t.type === "pointer_type") t = t.namedChildren[0];
  return t?.type === "type_identifier" ? t.text : null;
}

/** Split a dotted/bracketed JSON path into navigation segments. */
function toPathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const part of path.split(".")) {
    const elements = part.split("[]");
    elements.forEach((element, index) => {
      if (element) segments.push(element);
      if (index < elements.length - 1) segments.push("[]");
    });
  }
  return segments;
}

/** Deep-inline a component reference so a constructor can specialize fields. */
function inlineSchema(schema: JsonSchema, index: GoModelIndex, depth = 0, stack = new Set<string>()): JsonSchema {
  if (depth > 6) return {};
  let current = schema;
  if (current.$ref) {
    const name = String(current.$ref).split("/").pop()!;
    if (stack.has(name)) return {};
    const component = index.components.get(name)
      ?? (index.byName.get(name) ? buildStructSchema(index.byName.get(name)!, index, 0, new Set(stack)) : undefined);
    if (!component) return {};
    const next = new Set(stack).add(name);
    return inlineSchema(structuredClone(component), index, depth, next);
  }
  current = structuredClone(current);
  if (current.properties) {
    const props = current.properties as Record<string, JsonSchema>;
    const inlined: Record<string, JsonSchema> = {};
    for (const key of Object.keys(props)) {
      inlined[key] = inlineSchema(props[key]!, index, depth + 1, stack);
    }
    current.properties = inlined;
  }
  if (current.items) current.items = inlineSchema(current.items as JsonSchema, index, depth + 1, stack);
  return current;
}

/** Remove null from the schema at each proven constructor path. */
function narrowNonNullPaths(schema: JsonSchema, segments: string[], index: GoModelIndex, depth = 0): JsonSchema {
  if (schema.$ref) {
    const inlined = inlineSchema(schema, index, depth);
    if (inlined.$ref) return schema;
    schema = inlined;
  }
  if (depth > 8 || segments.length === 0) return nonNullGoSchema(schema);
  const [head, ...rest] = segments;
  if (head === "[]") {
    if (schema.items) return { ...schema, items: narrowNonNullPaths(schema.items as JsonSchema, rest, index, depth + 1) };
    return schema;
  }
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  const property = properties?.[head];
  if (property) {
    return { ...schema, properties: { ...properties, [head]: narrowNonNullPaths(property, rest, index, depth + 1) } };
  }
  return schema;
}

/**
 * Prove non-nil fields of a constructor's returned struct by reading its body.
 * Handles `r := new(T)` / `r := &T{}`, `r.Field = make(...)` / composite
 * literals, and `for { e := new(E); e.Sub = make(...); r.Items = append(r.Items, e) }`,
 * which proves both the slice and every appended element (and the element's
 * initialized fields) are non-nil on the success path. Returns JSON paths.
 */
function constructorNonNullPaths(
  fn: GoFunction,
  rootTypeName: string,
  analysis: GoAnalysis,
  index: GoModelIndex,
): Set<string> {
  const paths = new Set<string>();
  if (!fn.body) return paths;
  const body = fn.body;
  const shadowed = (name: string) => analysis.functions.has(name) || analysis.vars.has(name);

  const nonNilInit = (node: TsNode | undefined): { kind: "array" | "object"; typeName: string | null } | null => {
    if (!node) return null;
    if (node.type === "call_expression" && !shadowed(node.namedChildren[0]?.text ?? "")) {
      const callee = node.namedChildren[0]?.text;
      const args = positionalArguments(node);
      if (callee === "make" && args[0] && ["slice_type", "array_type", "map_type"].includes(args[0]!.type)) {
        return { kind: args[0]!.type === "map_type" ? "object" : "array", typeName: null };
      }
      if (callee === "new" && args[0]?.type === "type_identifier") return { kind: "object", typeName: args[0]!.text };
      return null;
    }
    if (node.type === "unary_expression" && node.text.trimStart().startsWith("&") && node.namedChildren[0]?.type === "composite_literal") {
      const t = namedStructOf(node.namedChildren[0]!.namedChildren[0]);
      return t ? { kind: "object", typeName: t } : null;
    }
    if (node.type === "composite_literal") {
      const typeNode = node.namedChildren[0];
      if (typeNode?.type === "slice_type" || typeNode?.type === "array_type") return { kind: "array", typeName: null };
      const t = namedStructOf(typeNode);
      return t ? { kind: "object", typeName: t } : null;
    }
    return null;
  };

  // Identify the returned receiver variable (`r`).
  let receiver: string | null = null;
  for (const decl of findAll(body, node => node.type === "short_var_declaration")) {
    const lists = decl.namedChildren.filter(child => child.type === "expression_list");
    const left = lists[0];
    const right = lists.at(-1);
    if (!left || !right) continue;
    left.namedChildren.forEach((id, position) => {
      if (id.type !== "identifier") return;
      const init = nonNilInit(right.namedChildren[position]);
      if (init?.kind === "object" && init.typeName === rootTypeName) receiver = id.text;
    });
  }
  if (!receiver) return paths;

  const rootStruct = index.byName.get(rootTypeName);
  if (!rootStruct) return paths;
  const fieldJson = (structName: string | null, goName: string): string | null => {
    const def = structName ? index.byName.get(structName) : rootStruct;
    const field = def?.fields.find(entry => entry.goName === goName || entry.goName.endsWith(`.${goName}`));
    return field ? fieldName(field) : null;
  };
  const sliceElementStruct = (structName: string | null, goName: string): string | null => {
    const def = structName ? index.byName.get(structName) : rootStruct;
    const field = def?.fields.find(entry => entry.goName === goName || entry.goName.endsWith(`.${goName}`));
    if (!field) return null;
    let typeNode: TsNode | undefined = field.typeNode;
    if (typeNode.type === "slice_type" || typeNode.type === "array_type") typeNode = typeNode.namedChildren.at(-1);
    return namedStructOf(typeNode);
  };

  // Locals proven to hold freshly allocated objects: `e := new(E)` / `e := &E{}`.
  const objectLocals = new Map<string, string>();
  for (const decl of findAll(body, node => node.type === "short_var_declaration")) {
    const lists = decl.namedChildren.filter(child => child.type === "expression_list");
    const left = lists[0];
    const right = lists.at(-1);
    if (!left || !right) continue;
    left.namedChildren.forEach((id, position) => {
      if (id.type !== "identifier") return;
      const init = nonNilInit(right.namedChildren[position]);
      if (init?.kind === "object" && init.typeName) objectLocals.set(id.text, init.typeName);
    });
  }

  const selectorOf = (node: TsNode): { base: string; field: string } | null => {
    if (node.type !== "selector_expression") return null;
    const operand = node.namedChildren[0];
    const fieldNode = node.namedChildren[1];
    if (operand?.type !== "identifier" || !fieldNode) return null;
    return { base: operand.text, field: fieldNode.text };
  };

  // element var -> { parent Go field, element struct }
  const appended = new Map<string, { parentField: string; elementStruct: string }>();
  const assignments = findAll(body, node => node.type === "assignment_statement");

  // Pass 1: direct receiver field construction and append bindings.
  for (const assignment of assignments) {
    const sides = assignment.namedChildren.filter(child => child.type === "expression_list");
    const lefts = sides[0]?.namedChildren ?? [];
    const rights = sides[1]?.namedChildren ?? [];
    lefts.forEach((left, position) => {
      const target = selectorOf(left);
      const value = rights[position];
      if (!target || target.base !== receiver || !value) return;
      if (value.type === "call_expression" && value.namedChildren[0]?.text === "append" && !shadowed("append")) {
        const args = positionalArguments(value);
        const sliceTarget = args[0] ? selectorOf(args[0]) : null;
        const element = args[1];
        if (sliceTarget && sliceTarget.base === receiver) {
          const jsonField = fieldJson(null, sliceTarget.field);
          if (jsonField) paths.add(jsonField);
          if (jsonField && element?.type === "identifier") {
            const elementStruct = sliceElementStruct(null, sliceTarget.field);
            if (elementStruct && objectLocals.get(element.text) === elementStruct) {
              paths.add(`${jsonField}[]`);
              appended.set(element.text, { parentField: jsonField, elementStruct });
            }
          }
        }
      } else if (nonNilInit(value)) {
        const jsonField = fieldJson(null, target.field);
        if (jsonField) paths.add(jsonField);
      }
    });
  }

  // Pass 2: field construction on proven appended elements (`e.Sub = make(...)`).
  for (const assignment of assignments) {
    const sides = assignment.namedChildren.filter(child => child.type === "expression_list");
    const lefts = sides[0]?.namedChildren ?? [];
    const rights = sides[1]?.namedChildren ?? [];
    lefts.forEach((left, position) => {
      const target = selectorOf(left);
      if (!target) return;
      const binding = appended.get(target.base);
      if (!binding) return;
      const value = rights[position];
      if (!value || !nonNilInit(value)) return;
      const subField = fieldJson(binding.elementStruct, target.field);
      if (subField) paths.add(`${binding.parentField}[].${subField}`);
    });
  }

  return paths;
}

/**
 * Follow a constructor/service function's declared return type, and when that
 * type is opaque (e.g. `render.Renderer` or `[]render.Renderer`) follow the
 * function body to learn the concrete struct it builds. Also extracts a
 * statically provable HTTP status from an `HTTPStatusCode: <code>` literal.
 */

/** Receiver base type name (pointer stripped) for a method declaration. */
function methodReceiverName(method: GoFunction): string | null {
  const param = method.receiver?.namedChildren.find(child => child.type === 'parameter_declaration') ?? method.receiver;
  const typeNode = param?.childForFieldName?.('type');
  return typeNode?.text?.replace(/^\*/, '') ?? null;
}

/**
 * Resolve an interface method call to the concrete receiver methods that
 * implement the interface in the same package. A candidate qualifies only if
 * its receiver type implements the full interface method set, so an unrelated
 * same-named method is never mistaken for the implementation.
 */
function interfaceMethodImplementations(call: TsNode, methodName: string, analysis: GoAnalysis): GoFunction[] {
  const callee = call.type === 'call_expression' ? call.namedChildren[0] : call;
  if (callee?.type !== 'selector_expression') return [];
  const receiver = callee.namedChildren[0];
  if (!receiver) return [];
  const ifaceType = goExpressionType(receiver, analysis);
  if (!ifaceType) return [];
  const def = goTypeDeclaration(ifaceType, analysis);
  if (!def || def.type.type !== 'interface_type') return [];
  const ifaceMethods = new Set(def.type.namedChildren
    .filter(node => node.type === 'method_spec')
    .map(node => node.namedChildren[0]?.text)
    .filter((text): text is string => !!text));
  if (!ifaceMethods.has(methodName)) return [];

  // Implementations can live in a different package (interface in models,
  // concrete service in the parent package); the full method-set match is the
  // binding constraint, so a same-named unrelated method is still rejected.
  const sameName = analysis.methods.filter(method => method.name === methodName && method.body);
  const implementations = sameName.filter(method => {
    const receiverName = methodReceiverName(method);
    if (!receiverName) return false;
    const provided = new Set(analysis.methods
      .filter(other => methodReceiverName(other) === receiverName)
      .map(other => other.name));
    for (const required of ifaceMethods) {
      if (!provided.has(required)) return false;
    }
    return true;
  });
  return implementations;
}

/** Base name of a possibly qualified/pointer type node (models.User -> User). */
export function goTypeBaseName(typeNode: TsNode | undefined | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === 'pointer_type') return goTypeBaseName(typeNode.namedChildren[0]);
  if (typeNode.type === 'qualified_type') return typeNode.namedChildren[1]?.text ?? null;
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') return typeNode.text;
  return null;
}

/**
 * Extract required request fields from hand-written validator functions:
 *   func validateUser(u User) []string {
 *     if u.Name == "" { errs = append(errs, ...) }
 *     if u.Dob.IsZero() { ... }
 *   }
 * Returns a map keyed by the parameter's (base) type name to the set of JSON
 * field names that are rejected when empty/zero. Only explicit emptiness checks
 * are collected, so a field that is merely read is never marked required.
 */
export function extractGoValidatorRequired(analysis: GoAnalysis, index: GoModelIndex): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const record = (typeName: string, goFieldName: string) => {
    let jsonName = goFieldName;
    const struct = index.byName.get(typeName);
    if (struct) {
      const match = struct.fields.find(field => field.goName === goFieldName);
      if (match) {
        const tagged = jsonTag(match);
        if (tagged.name) jsonName = tagged.name;
      }
    }
    const set = out.get(typeName) ?? new Set<string>();
    set.add(jsonName);
    out.set(typeName, set);
  };

  for (const [fnName, fns] of analysis.functions) {
    if (!/^(validate|check|require|ensure)/i.test(fnName)) continue;
    for (const fn of fns) {
      if (!fn.body || !fn.node) continue;
      const paramList = fn.node.namedChildren.find(node => node.type === 'parameter_list');
      const firstParam = paramList?.namedChildren.find(node => node.type === 'parameter_declaration');
      if (!firstParam) continue;
      const paramName = firstParam.namedChildren.find(node => node.type === 'identifier')?.text;
      const typeName = goTypeBaseName(firstParam.childForFieldName?.('type') ?? firstParam.namedChildren.at(-1));
      if (!paramName || !typeName) continue;

      // `if param.Field == ""` / `"" == param.Field` emptiness checks.
      for (const binary of findAll(fn.body, node => node.type === 'binary_expression')) {
        const operands = binary.namedChildren;
        const selector = operands.find(node => node.type === 'selector_expression' && node.namedChildren[0]?.text === paramName);
        const literal = operands.find(node => node !== selector && node.type === 'interpreted_string_literal' && node.text === '""');
        if (selector && literal && binary.text.includes('==')) {
          const fieldName = selector.namedChildren[1]?.text;
          if (fieldName) record(typeName, fieldName);
        }
      }
      // `if param.Field.IsZero()` time/value zero checks.
      for (const call of findAll(fn.body, node => node.type === 'call_expression')) {
        const method = call.namedChildren[0];
        if (method?.type === 'selector_expression' && method.namedChildren[1]?.text === 'IsZero') {
          const receiver = method.namedChildren[0];
          if (receiver?.type === 'selector_expression' && receiver.namedChildren[0]?.text === paramName) {
            const fieldName = receiver.namedChildren[1]?.text;
            if (fieldName) record(typeName, fieldName);
          }
        }
      }
    }
  }
  return out;
}

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
  const fn = resolveGoCall(call, analysis);
  if (!fn) return { schema: null, status: null };

  const resultType = functionResultTypeNode(fn);
  let schema: JsonSchema | null = null;
  if (resultType) {
    const resolved = localGoTypeToSchema(resultType, analysis, index);
    schema = Object.keys(resolved).length ? resolved : null;
    // A declared pointer can be nil; prove non-null constructions/local flows
    // independently for every return. Do not infer this from a name. The same
    // proof applies to declared slices: make()/append plus a nil guard proves
    // the success-path value serializes as [] rather than null. An interface
    // method has no body, so resolve it to every concrete implementation and
    // require the proof on each one before narrowing.
    if (schema && (resultType.type === 'pointer_type' || resultType.type === 'slice_type')) {
      const isSlice = resultType.type === 'slice_type';
      const targets = fn.body ? [fn] : interfaceMethodImplementations(call, name, analysis);
      const directAddress = (target: GoFunction) => (statement: TsNode) => {
        let owner = statement.parent;
        while (owner && target.body && owner.id !== target.body.id) {
          if (owner.type === 'func_literal') return false;
          owner = owner.parent;
        }
        const expression = statement.namedChildren.find(node => node.type === 'expression_list')?.namedChildren[0];
        if (!expression || !target.body) return false;
        if (expression.type === 'nil') return false;
        if (isSlice) {
          if (expression.type === 'composite_literal') return expression.namedChildren[0]?.type === 'slice_type';
          if (expression.type === 'identifier') return provenNonNilLocalValue(expression, target.body, analysis);
          if (expression.type === 'call_expression') return provenNonNilConstruction(expression, target.body, analysis);
          return false;
        }
        return provenNonNilConstruction(expression, target.body, analysis) || provenNonNilLocalValue(expression, target.body, analysis);
      };
      // Only returns directly owned by this function body; a return nested in
      // a func-literal callback (e.g. sort.Slice) belongs to that callback.
      const ownedReturns = (body: TsNode): TsNode[] => findAll(body, node => node.type === 'return_statement')
        .filter(statement => {
          let owner = statement.parent;
          while (owner && owner.id !== body.id) {
            if (owner.type === 'func_literal') return false;
            owner = owner.parent;
          }
          return true;
        });
      const proven = targets.length > 0 && targets.every(target => {
        if (!target.body) return false;
        const returns = ownedReturns(target.body);
        return returns.length > 0 && returns.every(directAddress(target));
      });
      if (proven) schema = nonNullGoSchema(schema);
    }
  }

  if (!schema || ((schema.type === "array" || Array.isArray(schema.type) && schema.type.includes('array')) && schema.items && Object.keys(schema.items).length === 0)) {
    // Opaque declared return (interface): follow the body for the concrete type.
    const concrete = bodyFollowConcreteStruct(fn, index, analysis, vars, depth + 1);
    schema = concrete ?? schema;
  }
  // Constructor field narrowing: prove non-nil slices/objects from make()/new()
  // assignments in the constructor body instead of trusting the declared
  // pointer/slice nullability. Only applied to a named struct return.
  if (schema) {
    const rootTypeName = namedStructOf(resultType);
    if (rootTypeName && fn.body && (schema.$ref || schema.type === "object" || Array.isArray(schema.type))) {
      const nonNullPaths = constructorNonNullPaths(fn, rootTypeName, analysis, index);
      if (nonNullPaths.size) {
        let specialized = inlineSchema(schema, index);
        if (specialized.$ref) specialized = {};
        if (specialized.type === "object" || Array.isArray(specialized.type)) {
          for (const path of nonNullPaths) {
            specialized = narrowNonNullPaths(specialized, toPathSegments(path), index);
          }
          schema = specialized;
        }
      }
    }
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
    if (node.namedChildren[0]?.text === "len" && positionalArguments(node).length === 1) {
      const owner = goSourceFile(node, analysis);
      // A same-name declaration can shadow the builtin. Prefer unknown to guessing.
      const shadowed = analysis.functions.has("len") || (owner && findAll(owner.root, n =>
        n.type === "short_var_declaration" || n.type === "var_spec" || n.type === "parameter_declaration"
      ).some(n => (n.type === "short_var_declaration" ? n.namedChildren[0]?.namedChildren ?? [] : n.namedChildren)
        .some(c => c.type === "identifier" && c.text === "len")));
      const argument = positionalArguments(node)[0];
      const type = argument ? goExpressionType(argument, analysis) : undefined;
      if (!shadowed && type && (["slice_type", "array_type", "map_type", "channel_type"].includes(type.type) || type.text === "string")) {
        return {schema:{type:"integer", minimum:0}, status:null};
      }
    }
    return followCallToSchema(node, analysis, index, vars, depth + 1);
  }

  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
      const schema = goTypeToSchema(t, index);
      return {schema: Object.keys(schema).length ? schema : null, status: compositeStatus(node)};
    }
    if (t?.type === "qualified_type") {
      const schema = localGoTypeToSchema(t, analysis, index);
      return {schema: Object.keys(schema).length ? schema : null, status: compositeStatus(node)};
    }
    return { schema: null, status: null };
  }

  if (node.type === "identifier") {
    const inferredType = goExpressionType(node, analysis);
    if (inferredType) {
      const inferred = localGoTypeToSchema(inferredType, analysis, index);
      if (Object.keys(inferred).length) {
        const proven = handlerBody && (provenNonNilLocalValue(node, handlerBody, analysis) ||
          (inferredType.type === "slice_type" && provenNonNilSliceVariable(node, handlerBody, analysis, index, vars)));
        return { schema: proven ? nonNullGoSchema(inferred) : inferred, status: null };
      }
    }
    // Local variable assigned a constructor call: resp := NewArticleResponse(...)
    if (handlerBody) {
      const callValue = findAssignedCall(handlerBody, node);
      if (callValue) return resolveGoPayloadValue(callValue, handlerBody, analysis, index, vars, depth + 1);
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

function provenNonNilConstruction(value: TsNode, body: TsNode, analysis: GoAnalysis): boolean {
  if (value.type === 'unary_expression' && value.text.trimStart().startsWith('&') && value.namedChildren[0]?.type === 'composite_literal') return true;
  if (value.type === 'composite_literal') return ['slice_type','map_type'].includes(value.namedChildren[0]?.type ?? '');
  if (value.type !== 'call_expression') return false;
  const name = value.namedChildren[0]?.text;
  if (name !== 'new' && name !== 'make') return false;
  if (analysis.functions.has(name) || analysis.vars.has(name) || findAll(body.parent ?? body, node => ['short_var_declaration','var_spec','parameter_declaration'].includes(node.type) &&
    (node.type === 'short_var_declaration' ? node.namedChildren[0]?.namedChildren : node.namedChildren)?.some(child => child.type === 'identifier' && child.text === name)).length) return false;
  const args = positionalArguments(value);
  return name === 'new' ? args.length === 1 : !!args[0] && ['slice_type','map_type'].includes(args[0].type);
}

/** A top-level slice literal stays non-nil under append. Reject other writes,
 * shadowed declarations and address escapes instead of assuming construction
 * from a declared slice type alone. */
function provenNonNilLocalValue(value: TsNode, body: TsNode, analysis: GoAnalysis): boolean {
  if (value.type !== 'identifier') return false;
  const definitions = findAll(body, node => (node.type === 'short_var_declaration' || node.type === 'var_spec') &&
    (node.type === 'short_var_declaration' ? node.namedChildren[0]?.namedChildren : node.namedChildren)?.some(child => child.type === 'identifier' && child.text === value.text));
  if (definitions.length !== 1) return false;
  const declaration = definitions[0]!;
  if (declaration.startIndex >= value.startIndex) return false;
  let owner = declaration.parent;
  while (owner && owner.id !== body.id) {
    if (!['statement_list', 'var_declaration'].includes(owner.type)) return false;
    owner = owner.parent;
  }
  if (!owner) return false;
  const lists = declaration.namedChildren.filter(child => child.type === 'expression_list');
  const position = declaration.type === 'var_spec' ? declaration.namedChildren.filter(child => child.type === 'identifier').findIndex(child => child.text === value.text) : lists[0]?.namedChildren.findIndex(child => child.text === value.text) ?? -1;
  const initializer = lists.at(-1)?.namedChildren[position];
  // A nil guard `if x == nil { x = []T{} }` normalizes a zero-value slice to an
  // empty, non-nil slice before return. Treat it as a proven allocation.
  const nilGuards = findAll(body, node => {
    if (node.type !== 'if_statement') return false;
    const condition = node.namedChildren.find(child => /==/.test(child.text ?? '') && /\bnil\b/.test(child.text ?? ''));
    const normalized = (condition?.text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized !== `${value.text} == nil` && normalized !== `nil == ${value.text}`) return false;
    return findAll(node, assignment => assignment.type === 'assignment_statement' &&
      assignment.namedChildren[0]?.namedChildren.some(child => child.text === value.text) &&
      assignment.namedChildren[1]?.namedChildren.some(child => child.type === 'composite_literal' && child.namedChildren[0]?.type === 'slice_type')).length > 0;
  });
  const nilGuard = nilGuards.length > 0;
  const baseProven = (initializer && provenNonNilConstruction(initializer, body, analysis)) || nilGuard;
  if (!baseProven) return false;
  if (findAll(body, node => node.type === 'unary_expression' && /^&\s*/.test(node.text) && node.namedChildren[0]?.text === value.text).length) return false;
  const guardIds = new Set(nilGuards.flatMap(guard => findAll(guard, node => node.type === 'assignment_statement').map(node => node.id)));
  const assignments = findAll(body, node => node.type === 'assignment_statement' &&
    node.namedChildren[0]?.namedChildren.some(child => child.text === value.text) && !guardIds.has(node.id));
  const appendShadowed = analysis.functions.has('append') || analysis.vars.has('append') || findAll(body.parent ?? body, node => ['short_var_declaration','var_spec','parameter_declaration'].includes(node.type) &&
    (node.type === 'short_var_declaration' ? node.namedChildren[0]?.namedChildren : node.namedChildren)?.some(child => child.type === 'identifier' && child.text === 'append')).length > 0;
  return assignments.every(assignment => {
    const sides = assignment.namedChildren.filter(child => child.type === 'expression_list');
    const at = sides[0]?.namedChildren.findIndex(child => child.text === value.text) ?? -1;
    const right = sides[1]?.namedChildren[at];
    return !appendShadowed && right?.type === 'call_expression' && right.namedChildren[0]?.text === 'append' && positionalArguments(right)[0]?.text === value.text;
  });
}

/**
 * Prove a slice-typed local variable can never be nil on the success path.
 * Unlike provenNonNilLocalValue this accepts the full set of non-nil slice
 * producers: make()/append, an empty slice literal `[]T{}`, a slice expression
 * `s[lo:hi]` (always non-nil), or a call whose followed result is non-null.
 * An explicit `= nil` write or any unrecognized right-hand side fails closed.
 */
function provenNonNilSliceVariable(
  value: TsNode,
  body: TsNode,
  analysis: GoAnalysis,
  index: GoModelIndex,
  vars: Map<string, { value: TsNode | null }>,
): boolean {
  const name = value.text;
  // Address escape (`mutate(&items)`) lets another function assign nil; fail closed.
  if (findAll(body, node => node.type === 'unary_expression' && /^&\s*/.test(node.text) && node.namedChildren[0]?.text === name).length) {
    return false;
  }
  // A locally shadowed `append` may return nil; never trust `x = append(...)` then.
  const appendShadowed = analysis.functions.has('append') || analysis.vars.has('append') || findAll(body.parent ?? body, node =>
    ['short_var_declaration', 'var_spec', 'parameter_declaration'].includes(node.type) &&
    (node.type === 'short_var_declaration' ? node.namedChildren[0]?.namedChildren : node.namedChildren)?.some(child => child.type === 'identifier' && child.text === 'append')).length > 0;
  const leftIdentifiers = (node: TsNode): TsNode[] => {
    if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
      const list = node.namedChildren.find(child => child.type === 'expression_list');
      return list ? list.namedChildren.filter(child => child.type === 'identifier') : [];
    }
    return node.namedChildren.filter(child => child.type === 'identifier');
  };
  const writes = findAll(body, node =>
    (node.type === 'short_var_declaration' || node.type === 'var_spec' || node.type === 'assignment_statement') &&
    leftIdentifiers(node).some(child => child.text === name));
  if (!writes.length) return false;

  const classify = (rhs: TsNode | undefined): 'nil' | 'anchor' | 'neutral' => {
    if (!rhs) return 'neutral'; // `var x []T` with no initializer; decided by later writes
    if (rhs.type === 'nil') return 'nil';
    if (rhs.type === 'composite_literal' && rhs.namedChildren[0]?.type === 'slice_type') return 'anchor';
    if (rhs.type === 'slice_expression') return 'anchor';
    if (rhs.type === 'call_expression') {
      const callee = rhs.namedChildren[0]?.text;
      if (callee === 'make') return provenNonNilConstruction(rhs, body, analysis) ? 'anchor' : 'neutral';
      if (callee === 'append') return appendShadowed ? 'nil' : 'neutral'; // append zero times leaves nil
      const followed = followCallToSchema(rhs, analysis, index, vars, 1)?.schema;
      return followed && !isNullableGoSchema(followed) ? 'anchor' : 'neutral';
    }
    return 'neutral';
  };

  let hasAnchor = false;
  for (const write of writes) {
    let owner = write.parent;
    while (owner && owner.id !== body.id) {
      if (owner.type === 'func_literal') return false; // closure writes are not tracked here
      owner = owner.parent;
    }
    const lists = write.namedChildren.filter(child => child.type === 'expression_list');
    const positions: number[] = [];
    if (write.type === 'var_spec') {
      write.namedChildren.filter(child => child.type === 'identifier').forEach((id, i) => { if (id.text === name) positions.push(i); });
    } else {
      (lists[0]?.namedChildren ?? []).forEach((id, i) => { if (id.text === name) positions.push(i); });
    }
    for (const at of positions) {
      const rhs = write.type === 'var_spec' ? lists[0]?.namedChildren[at] : lists[1]?.namedChildren[at];
      const kind = classify(rhs);
      if (kind === 'nil') return false;
      if (kind === 'anchor') hasAnchor = true;
    }
  }
  return hasAnchor;
}

/** Find `name := Foo(...)` / `name = Foo(...)` and return the call node. */
function findAssignedCall(body: TsNode, value: TsNode): TsNode | null {
  const writes = findAll(body, node => ["short_var_declaration", "assignment_statement"].includes(node.type) &&
    !!node.namedChildren.find(child => child.type === "expression_list")?.namedChildren.some(child => child.text === value.text));
  // A conditional, subsequent or competing write is not a definite binding.
  if (writes.length !== 1) return null;
  const declaration = writes[0]!;
  if (declaration.startIndex >= value.startIndex) return null;
  let owner = declaration.parent;
  while (owner && owner.id !== body.id) {
    if (owner.type !== "statement_list") return null;
    owner = owner.parent;
  }
  if (!owner) return null;
  const [left, right] = declaration.namedChildren.filter(child => child.type === "expression_list");
  const at = left?.namedChildren.findIndex(child => child.text === value.text) ?? -1;
  const call = at >= 0 ? right?.namedChildren[at] : undefined;
  return call?.type === "call_expression" ? call : null;
}

/** Resolve only unambiguous imported local structs; never match solely by short name. */
export function localGoTypeToSchema(node: TsNode, analysis: GoAnalysis, index: GoModelIndex, depth = 0): JsonSchema {
  if (depth > 8) return {};
  if (["pointer_type", "slice_type", "array_type"].includes(node.type)) return goTypeToSchema(node, index, depth + 1);
  if (node.type === "qualified_type" && node.text === "time.Time") return { type:"string",format:"date-time" };
  if (node.type === "qualified_type" || node.type === "selector_expression") {
    const [qualifier, name] = node.namedChildren;
    if (!qualifier || !name) return {};
    let root = node; while (root.parent) root = root.parent;
    const owner = [...analysis.files.values()].find(file => file.root.id === root.id);
    const spec = owner && findAll(owner.root, n => n.type === "import_spec").find(n => {
      const path = n.namedChildren.find(c => c.type === "interpreted_string_literal")?.text.slice(1, -1);
      const alias = n.namedChildren.find(c => c.type === "package_identifier")?.text ?? path?.split("/").pop();
      return alias === qualifier.text;
    });
    const path = spec?.namedChildren.find(c => c.type === "interpreted_string_literal")?.text.slice(1, -1);
    if (!path) return {};
    const candidates = [...analysis.structs.values()].filter(def => {
      const directory = def.file.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      return def.name === name.text && directory && (path === directory || path.endsWith("/" + directory));
    });
    if (candidates.length !== 1) return {};
    const selected = candidates[0]!;
    const alias = index.aliases?.get(`${selected.file}::${selected.name}`) ?? selected.name;
    if (index.byName.get(alias) !== selected) return {};
    ensureGoComponent(alias, index);
    return { $ref: `#/components/schemas/${alias}` };
  }
  return goTypeToSchema(node, index);
}
