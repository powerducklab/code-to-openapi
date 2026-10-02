/**
 * Framework-agnostic PHP response-payload inference.
 *
 * Symfony and Slim controllers both return JSON built from PHP arrays and
 * models (as does the Laravel pack, which ships its own copy). This module
 * ports the shared, framework-neutral subset: literal/assignment-built arrays,
 * scalar literals, typed model components and conservative property-name
 * heuristics. Dynamic values become honest `{}` schemas rather than fabricated
 * types. Framework-specific response methods (`$this->json(...)`,
 * `$response->withJson(...)`, `render(...)`, redirects) are interpreted by the
 * packs themselves on top of these primitives.
 */

import type {
  DiscoveredResponse,
  GapCode,
  JsonSchema,
} from "../../core/types.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";
import { phpStringText } from "./index.js";
import type { PhpModelIndex } from "./schema.js";
import { ensurePhpComponent, formalParameters } from "./schema.js";

/** Read an integer literal node as its decimal text, or null. */
export function integerText(node: TsNode | undefined): string | null {
  if (!node) return null;
  const int = node.type === "integer" ? node : node.namedChildren.find((c) => c.type === "integer");
  return int?.text ?? null;
}

/** Read a static string literal argument, or null when dynamic. */
export function staticString(node: TsNode | undefined): string | null {
  if (!node) return null;
  const str = node.type === "string" ? node : node.namedChildren.find((c) => c.type === "string");
  return str ? phpStringText(str) : null;
}

/**
 * A file / binary / streamed response is always an opaque octet-stream body.
 * When a download filename is a static string, emit a Content-Disposition
 * attachment header backed by that literal.
 */
export function binaryResponse(status: string, filename?: string | null): DiscoveredResponse {
  const response: DiscoveredResponse = {
    statusCode: status,
    description: "",
    confidence: "high",
    content: [
      { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
    ],
  };
  if (filename) {
    response.headers = {
      "Content-Disposition": { type: "string", enum: [`attachment; filename="${filename}"`] },
    };
  }
  return response;
}

/** Conservative scalar inference for common PHP property names. */
export function heuristicPropertySchema(prop: string): JsonSchema {
  if (/^(id|.*_id)$/.test(prop) || /(count|total|quantity|size|age)$/.test(prop)) {
    return { type: "integer" };
  }
  if (/^(is_|has_|should_)/.test(prop) || /^(active|enabled|deleted|archived)$/.test(prop)) {
    return { type: "boolean" };
  }
  if (/(price|amount|cost|fee|balance)$/.test(prop)) return { type: "number" };
  if (/(url|uri|path|link|href)$/.test(prop)) return { type: "string", format: "uri" };
  if (/(at)$/.test(prop)) return { type: "string", format: "date-time" };
  if (/(name|title|sku|slug|email|phone|token|key|status|type|description|caption|filename)$/.test(prop)) {
    return { type: "string" };
  }
  return {};
}

/**
 * Resolve a value expression: literal scalars, nested arrays, new/known model
 * classes, static model factories, member calls, and variables assigned in the
 * handler. Returns an empty-object schema for "certain property, unknown
 * type" and undefined for "cannot be resolved at all".
 */
export function inferValueSchema(
  node: TsNode,
  model: PhpModelIndex,
  handler?: TsNode,
  depth = 0,
): JsonSchema | undefined {
  const inner = node.namedChildren[0] ?? node;

  if (inner.type === "array_creation_expression") {
    return inferArraySchema(inner, model, handler, depth + 1);
  }
  if (inner.type === "object_creation_expression") {
    const name = inner.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text
      .split("\\").pop();
    if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? {};
    return undefined;
  }
  if (inner.type === "scoped_call_expression") {
    const schema = inferStaticModel(inner, model);
    if (schema) return schema;
    return {};
  }
  if (inner.type === "member_call_expression") {
    const method = inner.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    if (method === "toarray" || method?.startsWith("toarray")) return { type: "object" };
    if (method === "json") return { type: "object" };
    // $dto->toArray() / array serialization always yields a JSON object.
    return {};
  }
  if (inner.type === "variable_name" && handler) {
    return inferVariableModel(handler, inner, model);
  }
  return inferArrayValue(node, model, handler, depth + 1);
}

function inferArrayValue(
  node: TsNode | undefined,
  model: PhpModelIndex,
  handler: TsNode | undefined,
  depth: number,
): JsonSchema | undefined {
  if (!node || depth > 6) return undefined;
  if (node.type === "string" || node.type === "encapsed_string") return { type: "string" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "float") return { type: "number" };
  if (node.type === "boolean" || node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "null") return { type: "null" };
  if (node.type === "array_creation_expression") return inferArraySchema(node, model, handler, depth);
  if (node.type === "object_creation_expression") {
    const name = node.namedChildren.find((c) => c.type === "name")?.text;
    if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? {};
  }
  if (node.type === "scoped_call_expression") return inferStaticModel(node, model) ?? {};
  if (node.type === "member_call_expression") {
    const method = node.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    if (method === "toarray" || method?.startsWith("toarray")) return { type: "object" };
    // A known array key whose value comes from an untyped service/repository
    // call keeps the property with an unconstrained schema rather than being
    // silently dropped (the property name itself is certain).
    return {};
  }
  if (node.type === "member_access_expression") {
    const prop = node.namedChildren.filter((c) => c.type === "name").pop()?.text ?? "";
    return heuristicPropertySchema(prop);
  }
  if (node.type === "variable_name" && handler) {
    return inferVariableModel(handler, node, model);
  }
  return undefined;
}

/**
 * Resolve a response()->json([...]) payload table. Keyed arrays become objects
 * with per-value inference; positional homogeneous arrays become array schemas.
 */
export function inferArraySchema(
  array: TsNode,
  model: PhpModelIndex,
  handler?: TsNode,
  depth = 0,
): JsonSchema | undefined {
  if (depth > 5) return { type: "object" };
  const elements = childrenOfType(array, "array_element_initializer");
  if (elements.length === 0) return { type: "object" };

  // A keyed element (`'key' => $value`) carries two named children, the key and
  // the value; a positional element carries a single child, the value. String
  // values share the "string" node type with string keys, so the two kinds are
  // split by child count.
  const keyed = elements.filter((element) => element.namedChildren.length === 2);
  if (keyed.length === 0) {
    const itemSchemas = elements.map((element) =>
      inferArrayValue(element.namedChildren[0], model, handler, depth + 1),
    );
    const first = itemSchemas[0];
    if (first && itemSchemas.every((s) => s && JSON.stringify(s) === JSON.stringify(first))) {
      return { type: "array", items: first };
    }
    return { type: "array", items: {} };
  }

  const properties: Record<string, JsonSchema> = {};
  for (const element of keyed) {
    const [keyNode, valueNode] = element.namedChildren;
    const key = keyNode?.type === "string" ? phpStringText(keyNode) : null;
    if (!key || !valueNode) continue;
    const schema = inferArrayValue(valueNode, model, handler, depth + 1);
    // An empty-object schema means "any type, not statically known": the key
    // itself is certain, so keep the property instead of silently dropping it.
    if (schema) properties[key] = schema;
  }
  return { type: "object", properties };
}

/**
 * Resolve a response variable (`return $data;`) back to the array it was built
 * from: either a literal `$x = [ ... ]`, or a typed model parameter. Dynamic
 * scalar service calls keep an unconstrained `{}`.
 */
export function inferVariableModel(
  handler: TsNode,
  variable: TsNode,
  model: PhpModelIndex,
): JsonSchema | undefined {
  const varText = variable.text;
  for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
    if (lhs?.text !== varText) continue;
    const rhs = assignment.namedChildren.find(
      (c) => c.type !== "variable_name" || c !== lhs,
    );
    if (!rhs) continue;
    if (rhs.type === "array_creation_expression") return inferArraySchema(rhs, model, handler);
    if (rhs.type === "object_creation_expression") {
      const name = rhs.namedChildren.find((c) => c.type === "name")?.text;
      if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? undefined;
    }
    const memberCall = findFirst(rhs, (n) => n.type === "member_call_expression");
    if (memberCall) {
      const method = memberCall.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
      // Request accessors yield dynamically-shaped data: keep the property with
      // an unconstrained schema rather than asserting an object.
      if (["getqueryparams", "getparsedbody", "input", "query", "get", "post"].includes(method ?? "")) {
        return {};
      }
      return {};
    }
    const scoped = findFirst(rhs, (n) => n.type === "scoped_call_expression");
    if (scoped) {
      const schema = inferStaticModel(scoped, model);
      if (schema) return schema;
    }
  }
  // Typed model parameter, e.g. function show(Book $book).
  for (const param of formalParameters(handler)) {
    const paramVar = param.namedChildren.find((c) => c.type === "variable_name");
    if (paramVar?.text !== varText) continue;
    const typeName = param.namedChildren
      .find((c) => c.type === "named_type")
      ?.namedChildren.find((c) => c.type === "name")?.text;
    if (typeName && model.analysis.classes.has(typeName)) {
      return ensurePhpComponent(typeName, model) ?? undefined;
    }
  }
  return undefined;
}

/** Resolve a static model factory call (Model::all/find/...) to a component ref. */
export function inferStaticModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const names = call.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
  const qualified = call.namedChildren.find((c) => c.type === "qualified_name");
  const method = names[names.length - 1]?.text.toLowerCase();
  const modelName = qualified
    ? qualified.text.split("\\").filter(Boolean).pop()
    : names.length >= 2
      ? names[names.length - 2]?.text
      : undefined;
  if (!modelName || !model.analysis.classes.has(modelName)) return undefined;
  const ref = ensurePhpComponent(modelName, model);
  if (!ref) return undefined;
  if (method && ["all", "get", "collection", "paginate"].includes(method)) {
    return { type: "array", items: ref };
  }
  return ref;
}

/** Mark a JSON response whose payload could not be statically inferred. */
export function unknownJsonResponse(status: string, gaps: GapCode[]): DiscoveredResponse {
  gaps.push("response-schema-unknown");
  return {
    statusCode: status,
    description: "",
    confidence: "low",
    content: [{ mediaType: "application/json" }],
  };
}
