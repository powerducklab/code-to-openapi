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
  const fn = resolveGoCall(call, analysis);
  if (!fn) return { schema: null, status: null };

  const resultType = functionResultTypeNode(fn);
  let schema: JsonSchema | null = null;
  if (resultType) {
    const resolved = localGoTypeToSchema(resultType, analysis, index);
    schema = Object.keys(resolved).length ? resolved : null;
    // A declared pointer can be nil; prove non-null constructions/local flows
    // independently for every return. Do not infer this from a name.
    if (schema && resultType.type === 'pointer_type' && fn.body) {
      const returns = findAll(fn.body, node => node.type === 'return_statement');
      const directAddress = (statement: TsNode) => {
        let owner = statement.parent;
        while (owner && owner.id !== fn.body!.id) {
          if (owner.type === 'func_literal') return false;
          owner = owner.parent;
        }
        const expression = statement.namedChildren.find(node => node.type === 'expression_list')?.namedChildren[0];
        return !!expression && (provenNonNilConstruction(expression, fn.body!, analysis) || provenNonNilLocalValue(expression, fn.body!, analysis));
      };
      if (returns.length && returns.every(directAddress)) schema = nonNullGoSchema(schema);
    }
  }

  if (!schema || ((schema.type === "array" || Array.isArray(schema.type) && schema.type.includes('array')) && schema.items && Object.keys(schema.items).length === 0)) {
    // Opaque declared return (interface): follow the body for the concrete type.
    const concrete = bodyFollowConcreteStruct(fn, index, analysis, vars, depth + 1);
    schema = concrete ?? schema;
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
      if (Object.keys(inferred).length) return { schema: handlerBody && provenNonNilLocalValue(node, handlerBody, analysis) ? nonNullGoSchema(inferred) : inferred, status: null };
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
  if (!initializer || !provenNonNilConstruction(initializer, body, analysis)) return false;
  if (findAll(body, node => node.type === 'unary_expression' && /^&\s*/.test(node.text) && node.namedChildren[0]?.text === value.text).length) return false;
  const assignments = findAll(body, node => node.type === 'assignment_statement' && node.namedChildren[0]?.namedChildren.some(child => child.text === value.text));
  const appendShadowed = analysis.functions.has('append') || analysis.vars.has('append') || findAll(body.parent ?? body, node => ['short_var_declaration','var_spec','parameter_declaration'].includes(node.type) &&
    (node.type === 'short_var_declaration' ? node.namedChildren[0]?.namedChildren : node.namedChildren)?.some(child => child.type === 'identifier' && child.text === 'append')).length > 0;
  return assignments.every(assignment => {
    const sides = assignment.namedChildren.filter(child => child.type === 'expression_list');
    const at = sides[0]?.namedChildren.findIndex(child => child.text === value.text) ?? -1;
    const right = sides[1]?.namedChildren[at];
    return !appendShadowed && right?.type === 'call_expression' && right.namedChildren[0]?.text === 'append' && positionalArguments(right)[0]?.text === value.text;
  });
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
