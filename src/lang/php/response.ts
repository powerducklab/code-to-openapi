/**
 * Framework-agnostic PHP response-payload inference.
 *
 * Symfony and Slim controllers both return JSON built from PHP arrays and
 * models (as does the Laravel pack, which ships its own copy). This module
 * ports the shared, framework-neutral subset: literal/assignment-built arrays,
 * scalar literals and typed model components. Dynamic values become honest `{}` schemas rather than fabricated
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
import { phpStringText, resolvePhpClass, findPhpMethod, type PhpClass } from "./index.js";
import type { PhpModelIndex } from "./schema.js";
import { ensurePhpResponseComponent, ensurePhpSerializedComponent, formalParameters, phpTypeToSchema, docTypeToSerializedSchema } from "./schema.js";

/** Read an integer literal node as its decimal text, or null. */
export function integerText(node: TsNode | undefined): string | null {
  if (!node) return null;
  const int = node.type === "integer" ? node : node.namedChildren.find((c) => c.type === "integer");
  if (int) return int.text.replace(/[_\s]/g, "");
  return phpHttpConstantText(node);
}

/**
 * Symfony HttpFoundation (and PSR-7) `Response::HTTP_*` status constants.
 * These are fixed framework constants, so the mapping is stable evidence
 * rather than a project-specific assumption.
 */
const HTTP_STATUS_CONSTANTS: Record<string, string> = {
  HTTP_CONTINUE: "100",
  HTTP_SWITCHING_PROTOCOLS: "101",
  HTTP_PROCESSING: "102",
  HTTP_EARLY_HINTS: "103",
  HTTP_OK: "200",
  HTTP_CREATED: "201",
  HTTP_ACCEPTED: "202",
  HTTP_NON_AUTHORITATIVE_INFORMATION: "203",
  HTTP_NO_CONTENT: "204",
  HTTP_RESET_CONTENT: "205",
  HTTP_PARTIAL_CONTENT: "206",
  HTTP_MULTI_STATUS: "207",
  HTTP_ALREADY_REPORTED: "208",
  HTTP_IM_USED: "226",
  HTTP_MULTIPLE_CHOICES: "300",
  HTTP_MOVED_PERMANENTLY: "301",
  HTTP_FOUND: "302",
  HTTP_SEE_OTHER: "303",
  HTTP_NOT_MODIFIED: "304",
  HTTP_USE_PROXY: "305",
  HTTP_RESERVED: "306",
  HTTP_TEMPORARY_REDIRECT: "307",
  HTTP_PERMANENTLY_REDIRECT: "308",
  HTTP_BAD_REQUEST: "400",
  HTTP_UNAUTHORIZED: "401",
  HTTP_PAYMENT_REQUIRED: "402",
  HTTP_FORBIDDEN: "403",
  HTTP_NOT_FOUND: "404",
  HTTP_METHOD_NOT_ALLOWED: "405",
  HTTP_NOT_ACCEPTABLE: "406",
  HTTP_PROXY_AUTHENTICATION_REQUIRED: "407",
  HTTP_REQUEST_TIMEOUT: "408",
  HTTP_CONFLICT: "409",
  HTTP_GONE: "410",
  HTTP_LENGTH_REQUIRED: "411",
  HTTP_PRECONDITION_FAILED: "412",
  HTTP_REQUEST_ENTITY_TOO_LARGE: "413",
  HTTP_REQUEST_URI_TOO_LONG: "414",
  HTTP_UNSUPPORTED_MEDIA_TYPE: "415",
  HTTP_REQUESTED_RANGE_NOT_SATISFIABLE: "416",
  HTTP_EXPECTATION_FAILED: "417",
  HTTP_I_AM_A_TEAPOT: "418",
  HTTP_MISDIRECTED_REQUEST: "421",
  HTTP_UNPROCESSABLE_ENTITY: "422",
  HTTP_LOCKED: "423",
  HTTP_FAILED_DEPENDENCY: "424",
  HTTP_TOO_EARLY: "425",
  HTTP_UPGRADE_REQUIRED: "426",
  HTTP_PRECONDITION_REQUIRED: "428",
  HTTP_TOO_MANY_REQUESTS: "429",
  HTTP_REQUEST_HEADER_FIELDS_TOO_LARGE: "431",
  HTTP_UNAVAILABLE_FOR_LEGAL_REASONS: "451",
  HTTP_INTERNAL_SERVER_ERROR: "500",
  HTTP_NOT_IMPLEMENTED: "501",
  HTTP_BAD_GATEWAY: "502",
  HTTP_SERVICE_UNAVAILABLE: "503",
  HTTP_GATEWAY_TIMEOUT: "504",
  HTTP_VERSION_NOT_SUPPORTED: "505",
  HTTP_VARIANT_ALSO_NEGOTIATES_EXPERIMENTAL: "506",
  HTTP_INSUFFICIENT_STORAGE: "507",
  HTTP_LOOP_DETECTED: "508",
  HTTP_NOT_EXTENDED: "510",
  HTTP_NETWORK_AUTHENTICATION_REQUIRED: "511",
};

export function phpHttpConstantByName(constant: string): string | null {
  return HTTP_STATUS_CONSTANTS[constant.toUpperCase()] ?? null;
}

function phpHttpConstantText(node: TsNode | undefined): string | null {
  if (!node || node.type !== "class_constant_access_expression") return null;
  const names = node.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
  const constant = names[names.length - 1]?.text;
  return constant ? phpHttpConstantByName(constant) : null;
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

function declaredProperty(cls: PhpClass | undefined, name: string, model: PhpModelIndex) {
  const visited = new Set<string>();
  while (cls && !visited.has(cls.fqcn) && visited.size < 16) {
    visited.add(cls.fqcn);
    const property = cls.properties.find(property => property.name === name);
    if (property) return property;
    cls = cls.extends ? resolvePhpClass(cls.extends, model.analysis, cls.node) : undefined;
  }
  return undefined;
}

function receiverClass(node: TsNode, model: PhpModelIndex, handler?: TsNode, depth = 0): PhpClass | undefined {
  if (depth > 8) return undefined;
  if (node.type === "member_access_expression") {
    const owner = node.namedChildren[0];
    const property = owner ? declaredProperty(receiverClass(owner, model, handler, depth + 1), node.namedChildren.at(-1)?.text ?? '', model) : undefined;
    const type = property?.typeNode;
    return type ? resolvePhpClass(type.text.replace(/^\?/, ''), model.analysis, type) : undefined;
  }
  if (node.type === 'object_creation_expression') {
    const name = node.namedChildren.find(child => child.type === 'name' || child.type === 'qualified_name');
    return name ? resolvePhpClass(name.text, model.analysis, name) : undefined;
  }
  if (node.type !== "variable_name") return undefined;
  if (node.text === "$this") {
    let scope = handler ?? node;
    while (scope.parent && !["class_declaration", "interface_declaration"].includes(scope.type)) scope = scope.parent;
    const className = ["class_declaration", "interface_declaration"].includes(scope.type) ? scope.namedChildren.find(child => child.type === "name")?.text : undefined;
    return className ? resolvePhpClass(className, model.analysis, scope) : undefined;
  }
  if (!handler) return undefined;
  const assignments = findAll(handler, child => child.type === "assignment_expression" && child.namedChildren[0]?.text === node.text);
  if (assignments.length) {
    const value = assignments.length === 1 && assignments[0]!.startIndex < node.startIndex ? assignments[0]!.namedChildren.at(-1) : undefined;
    return value ? receiverClass(value, model, handler, depth + 1) : undefined;
  }
  const param = formalParameters(handler).find(parameter => parameter.namedChildren.some(child => child.type === "variable_name" && child.text === node.text));
  const type = param && findFirst(param, child => child.type === "named_type");
  return type ? resolvePhpClass(type.text, model.analysis, type) : undefined;
}

/** Property names are not type evidence. Resolve only declared receiver types. */
export function declaredPhpPropertySchema(node: TsNode, model: PhpModelIndex, handler?: TsNode): JsonSchema {
  const receiver = node.namedChildren[0];
  const property = receiver ? declaredProperty(receiverClass(receiver, model, handler), node.namedChildren.at(-1)?.text ?? '', model) : undefined;
  return property ? phpTypeToSchema(property.typeNode, model, new Set(), 0, true) : {};
}

/** Resolve typed service/interface methods without guessing from method names. */
export function declaredPhpMethodSchema(node: TsNode, model: PhpModelIndex, handler?: TsNode): JsonSchema | undefined {
  const receiver = node.namedChildren[0];
  const cls = receiver ? receiverClass(receiver, model, handler) : undefined;
  const name = node.namedChildren.find(child => child.type === 'name')?.text;
  const method = cls && name ? findPhpMethod(cls, name, model.analysis) : undefined;
  if (!method) return undefined;
  const type = method.childForFieldName('return_type') ?? method.namedChildren.find(child => ['named_type','primitive_type','optional_type','union_type'].includes(child.type));
  if (type?.text === 'array') {
    const siblings = method.parent?.namedChildren ?? [];
    const previous = siblings[siblings.findIndex(child => child.id === method.id) - 1];
    const itemName = previous?.type === 'comment' ? /@return\s+([\\\w]+)\[\](?=\s|\*)/.exec(previous.text)?.[1] : undefined;
    const item = itemName ? resolvePhpClass(itemName, model.analysis, method) : undefined;
    if (item) return {type:'array',items:ensurePhpResponseComponent(item.fqcn,model)??{}};
  }
  if (type?.type === 'named_type') {
    const returned = resolvePhpClass(type.text, model.analysis, type);
    if (returned) return ensurePhpResponseComponent(returned.fqcn, model) ?? {};
  }
  return type ? phpTypeToSchema(type, model, new Set(), 0, true) : undefined;
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
  if (depth > 6) return undefined;
  const inner = node.type === "argument" ? node.namedChildren[0] ?? node : node;

  if (inner.type === "array_creation_expression") {
    return inferArraySchema(inner, model, handler, depth + 1);
  }
  if (inner.type === "object_creation_expression") {
    const name = inner.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text;
    const cls = name ? resolvePhpClass(name, model.analysis, inner) : undefined;
    if (cls) return ensurePhpResponseComponent(cls.fqcn, model) ?? {};
    return undefined;
  }
  if (inner.type === "scoped_call_expression") {
    const schema = inferStaticModel(inner, model);
    if (schema) return schema;
    return {};
  }
  if (inner.type === "member_call_expression") {
    const declared = declaredPhpMethodSchema(inner, model, handler);
    if (declared) return declared;
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
    const cls = name ? resolvePhpClass(name, model.analysis, node) : undefined;
    if (cls) return ensurePhpResponseComponent(cls.fqcn, model) ?? {};
  }
  if (node.type === "scoped_call_expression") return inferStaticModel(node, model) ?? {};
  if (node.type === "member_call_expression") {
    const declared = declaredPhpMethodSchema(node, model, handler);
    if (declared) return declared;
    const method = node.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    if (method === "toarray" || method?.startsWith("toarray")) return { type: "object" };
    // A known array key whose value comes from an untyped service/repository
    // call keeps the property with an unconstrained schema rather than being
    // silently dropped (the property name itself is certain).
    return {};
  }
  if (node.type === "member_access_expression") {
    return declaredPhpPropertySchema(node, model, handler);
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
      const cls = name ? resolvePhpClass(name, model.analysis, rhs) : undefined;
      if (cls) return ensurePhpResponseComponent(cls.fqcn, model) ?? undefined;
    }
    const memberCall = findFirst(rhs, (n) => n.type === "member_call_expression");
    if (memberCall) {
      const declared = declaredPhpMethodSchema(memberCall, model, handler);
      if (declared) return declared;
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
      return ensurePhpResponseComponent(typeName, model) ?? undefined;
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
  const ref = ensurePhpResponseComponent(modelName, model);
  if (!ref) return undefined;
  if (method && ["all", "get", "collection", "paginate"].includes(method)) {
    return { type: "array", items: ref };
  }
  return ref;
}

const REPO_ARRAY_METHODS = new Set(["findall", "findby", "findallbynames", "findbyids"]);
const REPO_ONE_METHODS = new Set(["find", "findoneby", "findonebyname"]);
const REPO_COUNT_METHODS = new Set(["count", "countby"]);

/** Resolve a `Book::class` class constant or FQCN string argument to a class. */
function classConstantEntity(node: TsNode | undefined, model: PhpModelIndex, handler?: TsNode): PhpClass | undefined {
  if (!node) return undefined;
  // Arguments are wrapped in an `argument` node; unwrap to the expression.
  const expr = node.type === "argument" ? node.namedChildren[0] : node;
  if (!expr) return undefined;
  if (expr.type === "class_constant_access_expression") {
    const nameNode = expr.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    return nameNode ? resolvePhpClass(nameNode.text, model.analysis, nameNode) : undefined;
  }
  if (expr.type === "string") {
    const text = phpStringText(expr);
    if (!text) return undefined;
    return model.analysis.classes.get(text.replace(/^\\/, "")) ?? resolvePhpClass(text, model.analysis, handler);
  }
  return undefined;
}

/** Read the entity bound in a ServiceEntityRepository `parent::__construct($reg, Book::class)`. */
function repoConstructorEntity(cls: PhpClass | undefined, model: PhpModelIndex): PhpClass | undefined {
  const ctor = cls?.methods.get("__construct");
  if (!ctor) return undefined;
  for (const call of findAll(ctor, (n) => n.type === "member_call_expression")) {
    if (call.namedChildren.find((c) => c.type === "name")?.text !== "__construct") continue;
    const args = call.namedChildren.find((c) => c.type === "arguments");
    const list = args ? childrenOfType(args, "argument") : [];
    const entity = classConstantEntity(list[1], model, ctor) ?? classConstantEntity(list[0], model, ctor);
    if (entity) return entity;
  }
  return undefined;
}

/**
 * Resolve a Doctrine ObjectRepository call chain to its entity schema:
 *   $em->getRepository(Book::class)->findAll()  -> Book[]
 *   $em->getRepository(Book::class)->find($id)  -> Book  (success branch)
 * A typed repository variable is supported as well, and its class docblock
 * `@method` annotations provide the precise element/nullability types.
 */
export function inferDoctrineRepositoryCall(call: TsNode, model: PhpModelIndex, handler?: TsNode): JsonSchema | undefined {
  if (call.type !== "member_call_expression") return undefined;
  const method = call.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
  if (!method) return undefined;
  const receiver = call.namedChildren[0];

  let entity: PhpClass | undefined;
  let repoCls: PhpClass | undefined;

  // $em->getRepository(Book::class)->findAll(): the receiver object is the
  // inner getRepository() call itself.
  if (receiver?.type === "member_call_expression") {
    const innerName = receiver.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    if (innerName === "getrepository" || innerName === "getrepositoryforclass") {
      const args = receiver.namedChildren.find((c) => c.type === "arguments");
      const first = args ? childrenOfType(args, "argument")[0] : undefined;
      entity = classConstantEntity(first, model, handler);
    } else {
      repoCls = receiverClass(receiver, model, handler);
    }
  } else if (receiver?.type === "variable_name" || receiver?.type === "member_access_expression") {
    // A typed repository variable ($books->...) or property ($this->repo->...).
    repoCls = receiverClass(receiver, model, handler);
  }
  if (!entity) entity = repoConstructorEntity(repoCls, model);
  if (!entity) return undefined;

  // Collection finders honor a precise `@method Book[] findAll()` docblock.
  if (REPO_ARRAY_METHODS.has(method) && repoCls?.magicMethods.has(method)) {
    const schema = docTypeToSerializedSchema(repoCls.magicMethods.get(method)!, model, new Set());
    if (Object.keys(schema).length) return schema;
  }

  const ref = ensurePhpSerializedComponent(entity.fqcn, model);
  if (!ref) return undefined;
  if (REPO_ARRAY_METHODS.has(method)) return { type: "array", items: ref };
  // The not-found branch is represented by the thrown exception response; the
  // success body is a non-null entity.
  if (REPO_ONE_METHODS.has(method)) return ref;
  if (REPO_COUNT_METHODS.has(method)) return { type: "integer" };
  return undefined;
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
