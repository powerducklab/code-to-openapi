/**
 * FastEndpoints framework pack (C#, tree-sitter based).
 *
 * FastEndpoints maps one endpoint to one class deriving from
 * `Endpoint<TRequest, TResponse>` or `EndpointWithoutRequest<TResponse>`. The
 * HTTP verb(s) and route(s) are declared in an overridden `Configure()` method
 * via `Verbs(Http.POST)`/`Routes("/x")` or the convenience `Get(x)`/`Post(x)`
 * helpers, and the response is produced in `HandleAsync` via SendAsync helpers.
 * The generic request/response arguments become the request body and response
 * components respectively.
 */

import { mergeResponseVariants } from "../core/response-variants.js";
import type {
  Confidence,
  DiscoveredMediaType,
  DiscoveredResponse,
  DiscoveredSecurityScheme,
  DiscoveredServer,
  DiscoveredUnresolved,
  FrameworkPack,
  GapCode,
  JsonSchema,
  RouteCandidate,
  RouteParameter,
  ScanContext,
  SourceLocation,
} from "../core/types.js";
import { buildCsSerializationIndex, serializedComponents, remapSchemaReferences } from "../lang/csharp/serialization.js";
import { inferExpressionSchema } from "./aspnet.js";
import type { CSharpAnalysis } from "../lang/csharp/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  buildCsModelIndex,
  csTypeToSchema,
  findAttribute,
  scopedName,
  type CsModelIndex,
} from "../lang/csharp/schema.js";

const HTTP_VERB_NAMES = new Set(["get", "post", "put", "delete", "patch", "head"]);

const SEND_STATUS: Record<string, string> = {
  SendOkAsync: "200",
  SendCreatedAsync: "201",
  SendNoContentAsync: "204",
  SendNotFoundAsync: "404",
  SendUnauthorizedAsync: "401",
  SendForbiddenAsync: "403",
  SendNoContent: "204",
};

export const fastendpointsPack: FrameworkPack<CSharpAnalysis> = {
  id: "fastendpoints",
  language: "csharp",
  dependencyHints: ["FastEndpoints"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        f.language === "csharp" &&
        (/:\s*Endpoint(WithoutRequest)?(\s*[<:{]|\s*$)/m.test(f.content) ||
          /\b(UseFastEndpoints|MapFastEndpoints)\s*\(/.test(f.content)),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildCsModelIndex(analysis);
    const responseModel = buildCsSerializationIndex(analysis);

    for (const [rel, file] of analysis.files) {
      for (const error of findAll(file.root, n => n.type === "ERROR")) unresolved.push({ reason: "handler-unresolved", message: "C# syntax could not be parsed; API coverage and DTO fields in this file are unverified.", origin: { file: rel, line: error.startPosition.row + 1 } });
      extractEndpoints(file.root, rel, model, responseModel, candidates);
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const serialized = serializedComponents(responseModel, new Set([...model.byName.keys(), ...model.components.keys()]));
    components.push(...serialized.components);
    for (const route of candidates) route.responses = remapSchemaReferences(route.responses, serialized.names);
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers: DiscoveredServer[] = [];

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

function extractEndpoints(
  root: TsNode,
  rel: string,
  model: CsModelIndex,
  responseModel: CsModelIndex,
  out: RouteCandidate[],
): void {
  for (const cls of findAll(root, (n) => n.type === "class_declaration")) {
    const base = endpointBase(cls);
    if (!base) continue;
    const className = cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "";

    const cfg = findMethod(cls, "Configure");
    const handler = findMethod(cls, "HandleAsync");
    const verbsRoutes = parseConfigure(cfg);

    const requestType = base.requestType;
    const responseType = base.responseType;
    // Resolve the generic DTO name through the endpoint's own namespace. Many
    // features declare a class named `Request`, so the index disambiguates
    // them to qualified names and a bare `requestType.text` lookup would miss.
    const requestTypeName = requestType
      ? (scopedName(requestType, model) ?? requestType.text)
      : null;

    for (const { verb, route } of verbsRoutes) {
      const fullPath = normalizeRoute(route || "/");
      const pathParams = new Set(
        [...fullPath.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!),
      );
      const parameters: RouteParameter[] = [...pathParams].map((name) => ({
        name,
        in: "path" as const,
        required: true,
        schema: { type: "string" },
        confidence: "high" as Confidence,
      }));

      const gaps: GapCode[] = [];
      const requestDef = requestTypeName ? model.byName.get(requestTypeName) : undefined;
      if (requestTypeName && !requestDef && !["EmptyRequest", "object"].includes(requestTypeName)) gaps.push("body-schema-unknown");
      for (const parameter of parameters) {
        const field = requestDef?.fields.find(field => field.name.toLowerCase() === parameter.name.toLowerCase());
        if (field) parameter.schema = csTypeToSchema(field.typeNode, model);
      }
      const queryProperties = requestDef ? findAll(requestDef.node, n => n.type === "property_declaration" && Boolean(findAttribute(n, new Set(["FromQuery"])))) : [];
      for (const property of queryProperties) {
        const name = property.childForFieldName("name")?.text;
        const field = requestDef?.fields.find(field => field.name.toLowerCase() === name?.toLowerCase());
        if (field) collectComplexQuery(field.typeNode, model, parameters, gaps);
      }
      let requestBody:
        | { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence }
        | undefined;
      if (requestTypeName && requestTypeName !== "EmptyRequest" && requestTypeName !== "object") {
        let schema = csTypeToSchema(requestType!, model);
        if (queryProperties.length && requestDef) {
          const excluded = new Set(queryProperties.map(property => property.childForFieldName("name")?.text.toLowerCase()));
          const fields = requestDef.fields.filter(field => !excluded.has(field.name.toLowerCase()));
          schema = fields.length ? { type: "object", properties: Object.fromEntries(fields.map(field => [field.jsonName ?? field.name, csTypeToSchema(field.typeNode, model)])), required: fields.filter(field => field.required).map(field => field.jsonName ?? field.name) } : {};
        }
        if (requestDef && !requestDef.fields.length) schema = {};
        if (!cfg || !findAll(cfg, n => n.type === "invocation_expression").some(n => invocationName(n) === "DontAutoValidate")) schema = applyRequestValidation(schema, requestTypeName, model);
        // Route binding supplies matching DTO properties independently of
        // JSON input. Do not demand a duplicate copy in the request body.
        if (pathParams.size && requestDef) {
          const bodySchema = typeof schema.$ref === "string" ? model.components.get(schema.$ref.split("/").pop()!) : schema;
          if (bodySchema && Array.isArray(bodySchema.required)) {
            const bound = new Set(requestDef.fields.filter(field => [...pathParams].some(name => name.toLowerCase() === field.name.toLowerCase())).map(field => field.jsonName ?? field.name));
            if (bodySchema.required.some(name => bound.has(String(name)))) schema = { ...bodySchema, required: bodySchema.required.filter(name => !bound.has(String(name))) };
          }
        }
        if (Object.keys(schema).length) {
          requestBody = {
            required: true,
            content: [{ mediaType: "application/json", schema }],
            confidence: "high",
          };
        }
      }

      const responses = collectResponses(handler, responseType, responseModel, gaps);

      out.push({
        method: verb,
        path: fullPath,
        fullPath,
        operationId: className,
        origin: { file: rel, line: cls.startPosition.row + 1 },
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
        tags: [className],
        confidence: gaps.length ? "medium" : "high",
        gaps,
        components: [],
        handlerSource: sliceNode(handler ?? cls),
      });
    }
  }
}

/** Apply only direct, unconditional rules; never mutate response/shared DTOs. */
function applyRequestValidation(input: JsonSchema, type: string, model: CsModelIndex): JsonSchema {
  const definition = model.byName.get(type);
  if (!definition || !Object.keys(input).length) return input;
  const base = typeof input.$ref === "string" ? model.components.get(input.$ref.split("/").pop()!) : input;
  if (!base?.properties) return input;
  const schema = structuredClone(base);
  const properties = schema.properties as Record<string, JsonSchema>;
  const required = new Set(schema.required as string[] ?? []);
  let changed = false;
  const validators = [...model.byName.values()].filter(validator => {
    const parent = validator.baseList?.namedChildren.find(n => n.type === "generic_name");
    return parent?.namedChildren.find(n => n.type === "identifier")?.text === "Validator" && parent.namedChildren.find(n => n.type === "type_argument_list")?.namedChildren[0]?.text === type;
  });
  if (validators.length !== 1) return input;
  for (const validator of validators) {
    for (const constructor of findAll(validator.node, n => n.type === "constructor_declaration")) {
      const body = constructor.namedChildren.find(n => n.type === "block");
      for (const statement of body?.namedChildren ?? []) {
        if (statement.type !== "expression_statement") continue;
        let call = statement.namedChildren[0];
        const calls: TsNode[] = [];
        while (call?.type === "invocation_expression") {
          calls.unshift(call);
          const receiver = call.namedChildren.find(n => n.type === "member_access_expression")?.namedChildren[0];
          if (!receiver || receiver.type !== "invocation_expression") break;
          call = receiver;
        }
        if (!calls.length || invocationName(calls[0]!) !== "RuleFor" || calls.some(c => ["When", "Unless", "WhenAsync", "UnlessAsync", "DependentRules", "Transform", "TransformAsync"].includes(invocationName(c) ?? ""))) continue;
        const lambda = findFirst(calls[0], n => n.type === "lambda_expression");
        const access = lambda?.namedChildren.at(-1);
        if (access?.type !== "member_access_expression" || access.namedChildren[0]?.type !== "identifier") continue;
        const field = definition.fields.find(f => f.name.toLowerCase() === access.namedChildren.at(-1)?.text.toLowerCase());
        const key = field?.jsonName ?? field?.name;
        if (!key || !properties[key]) continue;
        let property = properties[key]!;
        for (const rule of calls.slice(1)) {
          const name = invocationName(rule);
          const args = rule.namedChildren.find(n => n.type === "argument_list");
          const value = args?.namedChildren[0]?.text;
          const number = value && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
          const types = Array.isArray(property.type) ? property.type : [property.type];
          if (name === "NotEmpty" || name === "NotNull") {
            const declaration = findAll(definition.node, n => n.type === "property_declaration").find(n => n.childForFieldName("name")?.text.toLowerCase() === field?.name.toLowerCase());
            if (!declaration?.children.some(n => n.text === "=")) required.add(key);
            changed = true;
            if (Array.isArray(property.anyOf)) property.anyOf = property.anyOf.filter(s => !(s && typeof s === "object" && (s as JsonSchema).type === "null"));
            const nonNull = types.filter(t => t !== "null");
            if (nonNull.length && nonNull[0]) property.type = nonNull.length === 1 ? nonNull[0] : nonNull;
            if (name === "NotEmpty" && types.includes("string")) property.minLength = Math.max(Number(property.minLength ?? 0), 1);
            if (name === "NotEmpty" && types.includes("array")) property.minItems = Math.max(Number(property.minItems ?? 0), 1);
          }
          if (number !== undefined && Number.isSafeInteger(Math.ceil(number)) && Number.isSafeInteger(Math.floor(number)) && ["GreaterThan", "GreaterThanOrEqualTo"].includes(name ?? "") && types.includes("integer")) {
            property.minimum = Math.max(Number(property.minimum ?? -Infinity), name === "GreaterThan" ? Math.floor(number) + 1 : Math.ceil(number)); changed = true;
          }
          if (number !== undefined && Number.isSafeInteger(Math.ceil(number)) && Number.isSafeInteger(Math.floor(number)) && ["LessThan", "LessThanOrEqualTo"].includes(name ?? "") && types.includes("integer")) {
            property.maximum = Math.min(Number(property.maximum ?? Infinity), name === "LessThan" ? Math.ceil(number) - 1 : Math.floor(number)); changed = true;
          }
        }
        properties[key] = property;
      }
    }
  }
  if (!changed) return input;
  schema.required = [...required];
  return schema;
}

interface EndpointBase {
  requestType: TsNode | null;
  responseType: TsNode | null;
}

/** Returns the generic base info when the class derives from Endpoint<..>. */
function endpointBase(cls: TsNode): EndpointBase | null {
  const baseList = cls.namedChildren.find((c) => c.type === "base_list");
  if (!baseList) return null;
  for (const candidate of baseList.namedChildren) {
    if (candidate.type === "generic_name") {
      const name = candidate.namedChildren.find((c) => c.type === "identifier")?.text;
      const args = candidate.namedChildren.find((c) => c.type === "type_argument_list");
      const argTypes = args ? args.namedChildren : [];
      if (name === "Endpoint" && argTypes.length >= 1) {
        return { requestType: argTypes[0] ?? null, responseType: argTypes[1] ?? null };
      }
      if (name === "EndpointWithoutRequest") {
        return { requestType: null, responseType: argTypes[0] ?? null };
      }
      continue;
    }
    // Non-generic `EndpointWithoutRequest` (no response DTO).
    if (candidate.type === "identifier" && candidate.text === "EndpointWithoutRequest") {
      return { requestType: null, responseType: null };
    }
  }
  return null;
}

function findMethod(cls: TsNode, name: string): TsNode | null {
  const body = childrenOfType(cls, "declaration_list")[0];
  if (!body) return null;
  return (
    childrenOfType(body, "method_declaration").find(
      (m) => m.childForFieldName("name")?.text === name,
    ) ?? null
  );
}

interface VerbRoute {
  verb: string;
  route: string;
}

/** Parses Configure() for Verbs/Routes and the Get(x)/Post(x) helpers. */
function parseConfigure(cfg: TsNode | null): VerbRoute[] {
  if (!cfg) return [];
  let verbs: string[] = [];
  let routes: string[] = [];

  for (const call of findAll(cfg, (n) => n.type === "invocation_expression")) {
    const name = invocationName(call);
    const args = call.namedChildren.find((c) => c.type === "argument_list");
    const argNodes = args ? childrenOfType(args, "argument") : [];

    if (name === "Verbs") {
      for (const arg of argNodes) {
        // Http.POST / Http.GET
        const access = findFirst(arg, (n) => n.type === "member_access_expression");
        const verb = access?.namedChildren[access.namedChildren.length - 1]?.text.toLowerCase();
        if (verb && HTTP_VERB_NAMES.has(verb)) verbs.push(verb);
      }
    } else if (name === "Routes") {
      for (const lit of findAll(call, (n) => n.type === "string_literal")) {
        routes.push(unquote(lit.text));
      }
    } else if (name && HTTP_VERB_NAMES.has(name.toLowerCase())) {
      // Get("/path") / Post("/path") convenience helper.
      const lit = argNodes[0] ? findFirst(argNodes[0], (n) => n.type === "string_literal") : null;
      if (lit) {
        verbs.push(name.toLowerCase());
        routes.push(unquote(lit.text));
      }
    }
  }

  if (!routes.length) routes.push("/");
  if (!verbs.length) verbs = ["get"];
  const out: VerbRoute[] = [];
  for (const verb of verbs) {
    for (const route of routes) out.push({ verb, route });
  }
  return out;
}

function invocationName(call: TsNode): string | null {
  // Bare Verbs(...) or member access Http.POST / this.Verbs(...).
  const direct = call.namedChildren.find((c) => c.type === "identifier");
  if (direct) return direct.text;
  const access = call.namedChildren.find((c) => c.type === "member_access_expression");
  return access?.namedChildren[access.namedChildren.length - 1]?.text ?? null;
}

function collectResponses(
  handler: TsNode | null,
  responseType: TsNode | null,
  model: CsModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const responses: DiscoveredResponse[] = [];
  const declared = responseType?.text === "EmptyResponse" && !model.byName.has("EmptyResponse")
    ? { type: "object", properties: {} } : responseType ? csTypeToSchema(responseType, model) : {};
  if (handler) for (const call of findAll(handler, n => n.type === "invocation_expression")) {
    const name = invocationName(call);
    if (!name) continue;
    const access = call.namedChildren.find(n => n.type === "member_access_expression");
    const receiver = access?.namedChildren[0]?.text;
    const modern = receiver === "Send" || receiver === "this.Send";
    const modernStatus: Record<string, string> = { OkAsync: "200", CreatedAtAsync: "201", NoContentAsync: "204", NotFoundAsync: "404", UnauthorizedAsync: "401", ForbiddenAsync: "403" };
    let status = SEND_STATUS[name] ?? (modern ? modernStatus[name] : undefined);
    const args = call.namedChildren.find(n => n.type === "argument_list");
    const values = args ? childrenOfType(args, "argument") : [];
    if (name === "SendAsync" || (modern && name === "Async")) status = values[1]?.namedChildren.find(n => n.type === "integer_literal")?.text ?? "200";
    if (!status) continue;
    const noBody = status === "204" || ["NotFoundAsync", "UnauthorizedAsync", "ForbiddenAsync", "SendNotFoundAsync", "SendUnauthorizedAsync", "SendForbiddenAsync"].includes(name) || !values.length;
    let schema = !noBody && values[0] ? inferExpressionSchema(values[0], model, handler) : undefined;
    if (schema?.properties && values[0] && findFirst(values[0], n => n.type === "anonymous_object_creation_expression")) schema = { ...schema, required: Object.keys(schema.properties) };
    if (!schema && !noBody && Object.keys(declared).length) schema = declared;
    if (!noBody && !schema) gaps.push("response-unknown");
    responses.push({ statusCode: status, description: "", confidence: noBody || schema ? "high" : "low", ...(schema ? { content: [{ mediaType: "application/json", schema }] } : {}) });
  }
  if (!responses.length) {
    if (!Object.keys(declared).length) gaps.push("response-unknown");
    responses.push({ statusCode: "200", description: "", confidence: "low", ...(Object.keys(declared).length ? { content: [{ mediaType: "application/json", schema: declared }] } : {}) });
  }
  const merged = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = merged.get(response.statusCode);
    if (!existing) { merged.set(response.statusCode, response); continue; }
    merged.set(response.statusCode, mergeResponseVariants(existing, response));
  }
  return [...merged.values()];
}

/** Complex FromQuery uses flattened dot-separated keys, not a JSON body. */
function collectComplexQuery(type: TsNode, model: CsModelIndex, parameters: RouteParameter[], gaps: GapCode[], prefix = "", seen = new Set<string>()): void {
  const name = type.text.replace(/\?$/, "");
  const definition = model.byName.get(name);
  if (!definition || seen.has(name) || seen.size >= 8) { gaps.push("query-unknown"); return; }
  const next = new Set(seen).add(name);
  for (const field of definition.fields) {
    const key = prefix + field.name;
    const schema = csTypeToSchema(field.typeNode, model);
    const nested = field.typeNode.text.replace(/\?$/, "");
    if (model.byName.has(nested)) collectComplexQuery(field.typeNode, model, parameters, gaps, key + ".", next);
    else if (schema.type === "array" && (schema.items as JsonSchema | undefined)?.$ref) gaps.push("query-unknown");
    else parameters.push({ name: key, in: "query", required: false, schema, confidence: "medium" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRoute(raw: string): string {
  if (!raw) return "/";
  let route = raw.trim();
  if (!route.startsWith("/")) route = `/${route}`;
  route = route.replace(/\{(\*+)?([A-Za-z0-9_]+)(?::[^}?]+)?(\?)?\}/g, "{$2}");
  return route;
}

function unquote(raw: string): string {
  return raw.replace(/^[@$]?"/, "").replace(/"$/, "");
}

function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
}

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    if (!seen.has(key)) seen.set(key, route);
  }
  return [...seen.values()];
}

// Several test endpoints share the same simple class name (e.g. multiple
// `Endpoint` classes). Append a numeric suffix to keep operationIds unique.
function disambiguateOperationIds(routes: RouteCandidate[]): void {
  const counts = new Map<string, number>();
  for (const r of routes) {
    if (!r.operationId) continue;
    counts.set(r.operationId, (counts.get(r.operationId) ?? 0) + 1);
  }
  const firstSeen = new Set<string>();
  const used = new Set(routes.map((r) => r.operationId).filter((x): x is string => !!x));
  for (const r of routes) {
    if (!r.operationId || (counts.get(r.operationId) ?? 1) === 1) continue;
    if (!firstSeen.has(r.operationId)) {
      firstSeen.add(r.operationId);
      continue;
    }
    let n = 2;
    let candidate = `${r.operationId}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${r.operationId}_${n}`;
    }
    used.delete(r.operationId);
    r.operationId = candidate;
    used.add(candidate);
  }
}
