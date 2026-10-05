/** Shared Java HTTP-route, type and control-flow helpers. */

import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { RouteCandidate } from "../../core/types.js";
import { childrenOfType, findAll } from "../treesitter/ast.js";
import type { TsNode } from "../treesitter/runtime.js";
import {
  javaTypeToSchema,
  type JavaModelIndex,
} from "./schema.js";

/** HTTP status enum constant -> numeric code. */
export const HTTP_STATUS: Record<string, string> = {
  OK: "200",
  CREATED: "201",
  ACCEPTED: "202",
  NO_CONTENT: "204",
  RESET_CONTENT: "205",
  PARTIAL_CONTENT: "206",
  MOVED_PERMANENTLY: "301",
  FOUND: "302",
  SEE_OTHER: "303",
  NOT_MODIFIED: "304",
  TEMPORARY_REDIRECT: "307",
  PERMANENT_REDIRECT: "308",
  BAD_REQUEST: "400",
  UNAUTHORIZED: "401",
  PAYMENT_REQUIRED: "402",
  FORBIDDEN: "403",
  NOT_FOUND: "404",
  METHOD_NOT_ALLOWED: "405",
  NOT_ACCEPTABLE: "406",
  CONFLICT: "409",
  GONE: "410",
  LENGTH_REQUIRED: "411",
  PRECONDITION_FAILED: "412",
  PAYLOAD_TOO_LARGE: "413",
  UNSUPPORTED_MEDIA_TYPE: "415",
  UNPROCESSABLE_ENTITY: "422",
  INTERNAL_SERVER_ERROR: "500",
  NOT_IMPLEMENTED: "501",
  BAD_GATEWAY: "502",
  SERVICE_UNAVAILABLE: "503",
  GATEWAY_TIMEOUT: "504",
  HTTP_VERSION_NOT_SUPPORTED: "505",
  LOCKED: "423",
  FAILED_DEPENDENCY: "424",
  TOO_MANY_REQUESTS: "429",
  REQUEST_HEADER_FIELDS_TOO_LARGE: "431",
  UNAVAILABLE_FOR_LEGAL_REASONS: "451",
  // Micronaut names the 418 enum constant IM_A_TEAPOT; Spring uses I_AM_A_TEAPOT.
  IM_A_TEAPOT: "418",
  I_AM_A_TEAPOT: "418",
};

/** Best-effort extraction of the simple type name from a type node. */
export function typeNameOf(node: TsNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier" || node.type === "scoped_identifier") {
    return node.text.slice(node.text.lastIndexOf(".") + 1);
  }
  if (node.type === "generic_type") {
    return (
      node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? ""
    );
  }
  if (node.type === "array_type") return typeNameOf(node.namedChildren[0]);
  if (node.type === "integral_type") return node.text;
  if (node.type === "floating_point_type") return node.text;
  if (node.type === "boolean_type") return "boolean";
  return "";
}

/**
 * Normalize a route path fragment: guarantee a leading slash and strip the
 * regex/prefix syntax from path variables (`{id:[0-9]+}` -> `{id}`, `{*path}`
 * -> `{path}`).
 */
export function normalizePath(raw: string | null | undefined): string {
  if (!raw) return "";
  let path = raw.trim().replace(/^"|"$/g, "");
  if (path && !path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\{(\*?)([A-Za-z0-9_]+)(?::[^}]*)?\}/g, "{$2}");
  return path;
}

export function stripRegex(varName: string): string {
  return varName.replace(/^\*/, "");
}

export function joinPath(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
}

/** Extract declared path-parameter names from a path template. */
export function pathParamsOf(fullPath: string): Set<string> {
  return new Set(
    [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => stripRegex(m[1]!)),
  );
}

/** Truncate a handler body for the optional AI gap resolver. */
export function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
}

/**
 * Two controllers in different packages can share a simple class name, which
 * makes `<Class>_<method>` collide. Suffix the 2nd and later collisions; the
 * first occurrence keeps its name.
 */
export function disambiguateOperationIds(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, number>();
  for (const route of routes) {
    const base = route.operationId;
    if (!base) continue;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count > 1) route.operationId = `${base}_${count}`;
  }
  return routes;
}

/**
 * Collapse duplicate method+path candidates, keeping the more informative one
 * (more responses / parameters / body, fewer gaps).
 */
export function dedupeRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (c: RouteCandidate) =>
      c.responses.length * 2 +
      c.parameters.length +
      (c.requestBody ? 2 : 0) -
      c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

/**
 * Injected/collaborator fields declared on a resource class, keyed by field
 * name. Both concrete classes and interface-typed collaborators are recorded;
 * the interface already carries the return types we need.
 */
export function fieldTypesOf(cls: TsNode): Map<string, TsNode> {
  const map = new Map<string, TsNode>();
  const body = childrenOfType(cls, "class_body")[0];
  if (!body) return map;
  for (const field of childrenOfType(body, "field_declaration")) {
    const mods = field.namedChildren.find((c) => c.type === "modifiers");
    if (mods && /\bstatic\b/.test(mods.text)) continue;
    const typeNode = field.namedChildren.find((c) =>
      [
        "type_identifier",
        "generic_type",
        "scoped_identifier",
        "scoped_type_identifier",
      ].includes(c.type),
    );
    if (!typeNode) continue;
    for (const declarator of findAll(field, (n) => n.type === "variable_declarator")) {
      const name = declarator.namedChildren.find((c) => c.type === "identifier");
      if (name) map.set(name.text, typeNode);
    }
  }
  return map;
}

/** Resolve a method-invocation receiver to an injected field name. */
export function receiverFieldName(receiver: TsNode): string | null {
  if (receiver.type === "identifier") return receiver.text;
  if (receiver.type === "field_access") {
    const usesThis = receiver.namedChildren.some((c) => c.type === "this");
    const tail = receiver.namedChildren.find((c) => c.type === "identifier");
    if (usesThis && tail) return tail.text;
  }
  return null;
}

/** Find a method declaration by name within a class/interface body. */
export function findMethodNode(container: TsNode, name: string): TsNode | null {
  const body = container.namedChildren.find(
    (c) => c.type === "class_body" || c.type === "interface_body",
  );
  if (!body) return null;
  for (const method of childrenOfType(body, "method_declaration")) {
    const id = method.namedChildren.find((c) => c.type === "identifier");
    if (id && id.text === name) return method;
  }
  return null;
}

/** Extract the declared return-type node of a method declaration. */
export function declaredReturnTypeOf(method: TsNode): TsNode | null {
  return (
    method.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "void_type" ||
        c.type === "array_type" ||
        c.type === "scoped_identifier" ||
        c.type === "scoped_type_identifier",
    ) ?? null
  );
}

/**
 * A followed schema is only committed when it names a concrete shape: a $ref to
 * a project component, an array of such, or a scalar / populated object. Free
 * forms (`Object`, `Map`, `JsonNode`) are rejected so dynamic responses keep
 * their honest gap instead of being laundered into a fabricated schema.
 */
export function isConcreteSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  const withRef = schema as { $ref?: string };
  if (withRef.$ref) return true;
  const asObject = schema as {
    type?: string;
    items?: JsonSchema;
    properties?: Record<string, unknown>;
  };
  if (asObject.type === "array") {
    return Boolean(asObject.items) && isConcreteSchema(asObject.items);
  }
  if (
    asObject.type === "string" ||
    asObject.type === "integer" ||
    asObject.type === "number" ||
    asObject.type === "boolean"
  ) {
    return true;
  }
  if (asObject.type === "object" && asObject.properties) {
    return Object.keys(asObject.properties).length > 0;
  }
  return false;
}

/**
 * Follow `return collaborator.method(...)` to the bean method's declared return
 * type. Bounded to the handler block and its direct injected fields; only runs
 * when the declared envelope return type did not already resolve.
 */
export function followServiceReturnType(
  method: TsNode,
  fieldTypes: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  if (fieldTypes.size === 0) return undefined;
  const block = childrenOfType(method, "block")[0];
  if (!block) return undefined;
  const returns = findAll(block, (n) => n.type === "return_statement");
  for (const ret of returns) {
    for (const call of findAll(ret, (n) => n.type === "method_invocation")) {
      const schema = schemaFromServiceCall(call, fieldTypes, model, rel);
      if (schema) return schema;
    }
  }
  return undefined;
}

function schemaFromServiceCall(
  call: TsNode,
  fieldTypes: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  const receiver = call.namedChildren[0];
  const methodName = call.namedChildren[1];
  if (!receiver || !methodName || methodName.type !== "identifier") return undefined;
  const fieldName = receiverFieldName(receiver);
  if (!fieldName) return undefined;
  const fieldTypeNode = fieldTypes.get(fieldName);
  if (!fieldTypeNode) return undefined;
  const serviceTypeName = typeNameOf(fieldTypeNode);
  if (!serviceTypeName) return undefined;
  const serviceDef = model.resolveDef(serviceTypeName, rel);
  if (!serviceDef) return undefined;
  const target = findMethodNode(serviceDef.node, methodName.text);
  if (!target) return undefined;
  const returnType = declaredReturnTypeOf(target);
  if (!returnType || returnType.type === "void_type") return undefined;
  const schema = javaTypeToSchema(returnType, model, 0, undefined, serviceDef.file);
  return isConcreteSchema(schema) ? schema : undefined;
}

/** Prove the narrow case of a terminal throw with no reachable-method return.
 * Nested functions are separate control-flow scopes; conditional returns keep
 * the outcome uncertain. Exception status still requires mapper resolution. */
export function hasOnlyThrowingExit(method: TsNode): boolean {
  const body = method.childForFieldName("body");
  if (body?.namedChildren.at(-1)?.type !== "throw_statement") return false;
  return !findAll(body, node => node.type === "return_statement").some(statement => {
    let owner = statement.parent;
    while (owner && owner.id !== body.id) {
      if (["lambda_expression", "method_declaration", "constructor_declaration", "class_body"].includes(owner.type)) return false;
      owner = owner.parent;
    }
    return owner?.id === body.id;
  });
}
