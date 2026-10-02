/**
 * actix-web framework pack (Rust, tree-sitter based).
 *
 * Recognizes the two idiomatic actix registration styles:
 *  - Macro-annotated handlers: `#[get("/users/{id}")] async fn h(...)`. The route
 *    lives on the attribute; the handler function carries the extractors.
 *  - Imperative registration: `web::scope("/api").service(handler)` and
 *    `web::resource("/x").route(web::get().to(handler))`, wired through
 *    `App::new().service(...)` / `.configure(fn)`.
 *
 * Extractors map to parameters/bodies: `web::Path<T>`, `web::Query<T>`,
 * `web::Json<T>`; `web::Data<T>` and request guards are skipped. Responses are
 * inferred from the `HttpResponse::<Status>().json/.body/.streaming` builder
 * chain because actix returns an opaque `HttpResponse`.
 */

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
} from "../core/types.js";
import type { RustAnalysis } from "../lang/rust/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  buildRustModelIndex,
  ensureRustComponent,
  expandStructFields,
  functionParameters,
  rustTypeToSchema,
  type RustModelIndex,
} from "../lang/rust/schema.js";

const ROUTE_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

const SKIP_EXTRACTORS = new Set([
  "Data",
  "HttpRequest",
  "Payload",
  "Headers",
  "ReqData",
]);

const STATUS_BUILDERS: Record<string, string> = {
  Ok: "200",
  Created: "201",
  Accepted: "202",
  NoContent: "204",
  MovedPermanently: "301",
  Found: "302",
  BadRequest: "400",
  Unauthorized: "401",
  Forbidden: "403",
  NotFound: "404",
  Conflict: "409",
  Gone: "410",
  UnprocessableEntity: "422",
  InternalServerError: "500",
};

export const actixPack: FrameworkPack<RustAnalysis> = {
  id: "actix",
  language: "rust",
  dependencyHints: ["actix-web"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        f.language === "rust" &&
        (/\buse\s+actix_web\b/.test(f.content) ||
          /\bactix_web::/.test(f.content) ||
          /\bHttpResponse::/.test(f.content)),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildRustModelIndex(analysis);

    // handler function name -> scope prefixes it is .service()'d under.
    const handlerPrefixes = new Map<string, string[]>();

    for (const [rel, file] of analysis.files) {
      collectServiceRegistrations(file.root, handlerPrefixes);
      collectMacroHandlers(analysis, file.root, rel, model, handlerPrefixes, candidates);
      collectResourceRoutes(analysis, file.root, rel, model, candidates);
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers = detectServers(ctx);

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

// ---------------------------------------------------------------------------
// Attribute routing
// ---------------------------------------------------------------------------

interface MacroRoute {
  verb: string;
  route: string;
}

/** Parses a `#[get("/x")]` / `#[actix_web::post("/y")]` attribute item. */
function macroRouteFromAttribute(item: TsNode): MacroRoute | null {
  const attr = childrenOfType(item, "attribute")[0];
  if (!attr) return null;
  // The attribute text may be a bare `get(...)` or a qualified `actix_web::get(...)`.
  const head = attr.text.trim();
  const m = /^(?:actix_web::)?([A-Za-z]+)\s*\(/.exec(head);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  if (!ROUTE_VERBS.has(verb)) return null;
  const lit = findFirst(attr, (n) => n.type === "string_literal");
  if (!lit) return null;
  return { verb, route: unquoteRustString(lit.text) };
}

function collectMacroHandlers(
  analysis: RustAnalysis,
  root: TsNode,
  rel: string,
  model: RustModelIndex,
  handlerPrefixes: Map<string, string[]>,
  out: RouteCandidate[],
): void {
  const children = root.namedChildren;
  let pending: TsNode[] = [];
  for (const child of children) {
    if (child.type === "attribute_item") {
      pending.push(child);
      continue;
    }
    if (child.type === "function_item") {
      const route = pending
        .map((a) => macroRouteFromAttribute(a))
        .find((r): r is MacroRoute => Boolean(r));
      if (route) {
        const fnName =
          child.namedChildren.find((c) => c.type === "identifier")?.text ?? "";
        const prefixes = handlerPrefixes.get(fnName) ?? [""];
        for (const prefix of prefixes) {
          const candidate = buildMacroCandidate(
            analysis,
            model,
            route.verb,
            route.route,
            prefix,
            child,
            fnName,
            rel,
            child.startPosition.row + 1,
          );
          if (candidate) out.push(candidate);
        }
      }
    }
    pending = [];
  }
}

function buildMacroCandidate(
  analysis: RustAnalysis,
  model: RustModelIndex,
  verb: string,
  rawRoute: string,
  prefix: string,
  fn: TsNode,
  fnName: string,
  rel: string,
  line: number,
): RouteCandidate | null {
  const route = joinRoute(normalizeRoute(prefix), normalizeRoute(rawRoute));
  const pathParams = new Set(
    [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
  );

  const { parameters, requestBody, gaps } = collectParameters(fn, model, pathParams);
  const responses = collectResponses(fn, model, gaps);

  return {
    method: verb,
    path: route,
    fullPath: route,
    operationId: fnName || undefined,
    origin: { file: rel, line },
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    confidence: gaps.length ? "medium" : "high",
    gaps,
    components: [],
    handlerSource: sliceNode(fn),
  };
}

// ---------------------------------------------------------------------------
// Scope / service registration
// ---------------------------------------------------------------------------

/** callee text of a call_expression, e.g. `web::scope` or `HttpResponse::Ok`. */
function calleeText(call: TsNode): string | null {
  const callee = call.namedChildren.find(
    (c) => c.type === "identifier" || c.type === "scoped_identifier",
  );
  return callee?.text ?? null;
}

function chainMethod(call: TsNode): string | null {
  const fe = call.namedChildren.find((c) => c.type === "field_expression");
  if (!fe) return null;
  return fe.namedChildren.find((c) => c.type === "field_identifier")?.text ?? null;
}

/**
 * Collects `.service(handler_fn)` registrations and the `web::scope("/p")`
 * prefix chain they live in.
 */
function collectServiceRegistrations(
  root: TsNode,
  handlerPrefixes: Map<string, string[]>,
): void {
  for (const call of findAll(root, (n) => n.type === "call_expression")) {
    if (chainMethod(call) !== "service") continue;
    const args = childrenOfType(call, "arguments")[0];
    const arg = args?.namedChildren[0];
    if (!arg) continue;
    // Only bare handler identifiers are route handlers; web::scope / web::resource
    // arguments are nested service builders.
    if (arg.type !== "identifier") continue;
    const prefix = scopePrefixOf(call);
    const list = handlerPrefixes.get(arg.text) ?? [];
    if (!list.includes(prefix)) list.push(prefix);
    handlerPrefixes.set(arg.text, list);
  }
}

/** Walks the receiver chain of a `.service(x)` call to accumulate scope prefixes. */
function scopePrefixOf(serviceCall: TsNode): string {
  const fe = serviceCall.namedChildren.find((c) => c.type === "field_expression");
  let receiver: TsNode | undefined = fe?.namedChildren[0];
  const parts: string[] = [];
  let guard = 0;
  while (receiver && guard++ < 30) {
    if (receiver.type === "call_expression" && calleeText(receiver) === "web::scope") {
      const lit = findFirst(receiver, (n) => n.type === "string_literal");
      if (lit) parts.unshift(unquoteRustString(lit.text));
      break;
    }
    if (receiver.type === "call_expression") {
      const innerFe = receiver.namedChildren.find((c) => c.type === "field_expression");
      receiver = innerFe?.namedChildren[0];
      continue;
    }
    break;
  }
  return parts.join("").replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// resource().route() chains
// ---------------------------------------------------------------------------

function collectResourceRoutes(
  analysis: RustAnalysis,
  root: TsNode,
  rel: string,
  model: RustModelIndex,
  out: RouteCandidate[],
): void {
  for (const routeCall of findAll(root, (n) => n.type === "call_expression")) {
    if (chainMethod(routeCall) !== "route") continue;
    const fe = routeCall.namedChildren.find((c) => c.type === "field_expression");
    const receiver = fe?.namedChildren[0];
    if (!receiver || receiver.type !== "call_expression" || calleeText(receiver) !== "web::resource") {
      continue;
    }
    const lit = findFirst(receiver, (n) => n.type === "string_literal");
    if (!lit) continue;
    const route = normalizeRoute(unquoteRustString(lit.text));

    const routeArg = childrenOfType(routeCall, "arguments")[0]?.namedChildren[0];
    const { verb, handlerName } = parseRouteTo(routeArg);
    if (!verb || !handlerName) continue;
    const fn = analysis.functions.get(handlerName)?.[0];
    if (!fn) continue;

    const pathParams = new Set([...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
    const { parameters, requestBody, gaps } = collectParameters(fn, model, pathParams);
    const responses = collectResponses(fn, model, gaps);
    out.push({
      method: verb,
      path: route,
      fullPath: route,
      operationId: handlerName,
      origin: { file: rel, line: routeCall.startPosition.row + 1 },
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses,
      tags: [],
      confidence: gaps.length ? "medium" : "high",
      gaps,
      components: [],
      handlerSource: sliceNode(fn),
    });
  }
}

/** Parses `web::get().to(handler)` into verb + handler name. */
function parseRouteTo(routeArg: TsNode | undefined): {
  verb: string | null;
  handlerName: string | null;
} {
  if (!routeArg || routeArg.type !== "call_expression") return { verb: null, handlerName: null };
  const fe = routeArg.namedChildren.find((c) => c.type === "field_expression");
  if (!fe || fe.namedChildren.find((c) => c.type === "field_identifier")?.text !== "to") {
    return { verb: null, handlerName: null };
  }
  const verbCall = fe.namedChildren[0];
  const verbRaw =
    verbCall && verbCall.type === "call_expression" ? calleeText(verbCall) : null;
  const verb = verbRaw?.split("::").pop()?.toLowerCase() ?? null;
  const handlerName = childrenOfType(routeArg, "arguments")[0]?.namedChildren[0]?.text ?? null;
  return {
    verb: verb && ROUTE_VERBS.has(verb) ? verb : null,
    handlerName,
  };
}

// ---------------------------------------------------------------------------
// Handler parameters
// ---------------------------------------------------------------------------

function extractorBase(typeNode: TsNode): string | null {
  const base = typeNode.namedChildren.find(
    (c) => c.type === "type_identifier" || c.type === "scoped_type_identifier",
  );
  if (!base) return null;
  return base.text.split("::").pop() ?? null;
}

function genericArgsOf(typeNode: TsNode): TsNode[] {
  const list = typeNode.namedChildren.find((c) => c.type === "type_arguments");
  return list ? list.namedChildren : [];
}

function collectParameters(
  fn: TsNode,
  model: RustModelIndex,
  pathParams: Set<string>,
): {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence };
  gaps: GapCode[];
} {
  const parameters: RouteParameter[] = [];
  const gaps: GapCode[] = [];
  let requestBody:
    | { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence }
    | undefined;

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required: boolean,
  ) => {
    if (parameters.some((p) => p.in === location && p.name === name)) return;
    parameters.push({
      name,
      in: location,
      required: location === "path" ? true : required,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    });
  };

  for (const param of functionParameters(fn)) {
    const binding = param.namedChildren.find((c) => c.type === "identifier")?.text;
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "generic_type" ||
        c.type === "type_identifier" ||
        c.type === "scoped_type_identifier" ||
        c.type === "reference_type",
    );
    if (!typeNode) continue;

    let base: string | null = null;
    let inner: TsNode | undefined;
    if (typeNode.type === "generic_type") {
      base = extractorBase(typeNode);
      inner = genericArgsOf(typeNode)[0];
    } else if (typeNode.type === "scoped_type_identifier") {
      base = typeNode.text.split("::").pop() ?? null;
    } else if (typeNode.type === "type_identifier") {
      base = typeNode.text;
    }
    if (!base || SKIP_EXTRACTORS.has(base)) continue;

    if (base === "Path") {
      const tupleArgs =
        inner?.type === "tuple_type"
          ? inner.namedChildren.filter((c) => c.type !== ",")
          : [];
      if (tupleArgs.length) {
        const names = [...pathParams];
        tupleArgs.forEach((argType, i) => {
          const name = names[i] ?? binding ?? `param${i + 1}`;
          addParam("path", name, rustTypeToSchema(argType, model), "high", true);
        });
      } else if (inner && model.byName.has(typeNameOf(inner))) {
        for (const field of expandStructFields(inner, model)) {
          addParam("path", field.name, field.schema, "high", true);
        }
      } else {
        const name = singlePathParam(pathParams) ?? binding ?? "id";
        addParam("path", name, inner ? rustTypeToSchema(inner, model) : { type: "string" }, "high", true);
      }
      continue;
    }

    if (base === "Query") {
      if (inner) {
        for (const field of expandStructFields(inner, model)) {
          addParam("query", field.name, field.schema, "high", field.required);
        }
      } else {
        gaps.push("query-unknown");
      }
      continue;
    }

    if (base === "Json") {
      const schema = inner ? rustTypeToSchema(inner, model) : {};
      if (inner && Object.keys(schema).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
      }
      continue;
    }

    // Unknown extractors are left out rather than guessed.
  }

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}), gaps };
}

function typeNameOf(node: TsNode): string {
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? "";
  }
  return node.type === "type_identifier" ? node.text : "";
}

function singlePathParam(pathParams: Set<string>): string | null {
  const only = [...pathParams];
  return only.length === 1 ? only[0]! : null;
}

// ---------------------------------------------------------------------------
// Responses: HttpResponse::<Status>().<method>(...)
// ---------------------------------------------------------------------------

function collectResponses(fn: TsNode, model: RustModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const builders = findAll(fn, (n) => n.type === "scoped_identifier").filter((n) =>
    /^HttpResponse::/.test(n.text),
  );

  const responses: DiscoveredResponse[] = [];
  for (const builder of builders) {
    const statusName = builder.text.split("::")[1] ?? "";
    const status = STATUS_BUILDERS[statusName];
    if (!status) continue;
    // `HttpResponse::Ok()` is the inner call; the `.json/.body/.streaming`
    // methods chain on top of it, so climb UP through the field-expression chain.
    let parentFe: TsNode | null = builder.parent?.parent?.type === "field_expression"
      ? builder.parent.parent
      : null;
    let mediaType: string | null = null;
    let schema: JsonSchema | undefined;
    let streaming = false;
    while (parentFe && parentFe.type === "field_expression") {
      const outerCall = parentFe.parent;
      if (!outerCall || outerCall.type !== "call_expression") break;
      const method = parentFe.namedChildren.find((c) => c.type === "field_identifier")?.text;
      const args = childrenOfType(outerCall, "arguments")[0];
      const firstArg = args?.namedChildren[0];
      if (method === "json") {
        mediaType = "application/json";
        schema = payloadSchema(firstArg, model);
      } else if (method === "body") {
        mediaType = "text/plain";
        schema = { type: "string" };
      } else if (method === "streaming") {
        streaming = true;
      } else if (method === "content_type" && firstArg) {
        const ct = unquoteRustString(firstArg.text);
        if (/stream|octet/.test(ct)) mediaType = ct;
      }
      parentFe = outerCall.parent?.type === "field_expression" ? outerCall.parent : null;
    }

    if (streaming) {
      responses.push({
        statusCode: status,
        description: "",
        confidence: "high",
        content: [
          { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
        ],
      });
      continue;
    }
    if (mediaType === "application/json") {
      responses.push({
        statusCode: status,
        description: "",
        confidence: schema ? "high" : "medium",
        ...(schema ? { content: [{ mediaType, schema }] } : {}),
      });
      continue;
    }
    if (mediaType === "text/plain") {
      responses.push({
        statusCode: status,
        description: "",
        confidence: "high",
        content: [{ mediaType, schema: { type: "string" } }],
      });
      continue;
    }
    // .finish() / plain builder with no body.
    responses.push({ statusCode: status, description: "", confidence: "high" });
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }
  return mergeByStatus(responses);
}

/** Best-effort payload schema from `.json(arg)`. */
function payloadSchema(arg: TsNode | undefined, model: RustModelIndex): JsonSchema | undefined {
  if (!arg) return undefined;
  if (arg.type === "struct_expression") {
    const name = arg.namedChildren.find((c) => c.type === "type_identifier")?.text;
    if (name) return ensureRustComponent(name, model) ?? undefined;
  }
  if (arg.type === "macro_invocation" && /^vec!/.test(arg.text)) {
    const inner = findFirst(arg, (n) => n.type === "struct_expression");
    const name = inner?.namedChildren.find((c) => c.type === "type_identifier")?.text;
    if (name) {
      const ref = ensureRustComponent(name, model);
      if (ref) return { type: "array", items: ref };
    }
  }
  return undefined;
}

function mergeByStatus(responses: DiscoveredResponse[]): DiscoveredResponse[] {
  const byStatus = new Map<string, DiscoveredResponse>();
  for (const r of responses) {
    const existing = byStatus.get(r.statusCode);
    if (!existing) {
      byStatus.set(r.statusCode, r);
      continue;
    }
    if (!existing.content && r.content) existing.content = r.content;
  }
  return [...byStatus.values()];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRoute(raw: string): string {
  let route = (raw ?? "").trim();
  if (!route) return "/";
  if (!route.startsWith("/")) route = `/${route}`;
  return route;
}

function joinRoute(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
}

function unquoteRustString(raw: string): string {
  const m = /^"([^"]*)"$/.exec(raw.trim());
  return m ? m[1]! : raw.replace(/^"/, "").replace(/"$/, "");
}

function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
}

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (c: RouteCandidate) =>
      c.responses.length * 2 + c.parameters.length + (c.requestBody ? 2 : 0) - c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

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

function detectServers(ctx: ScanContext): DiscoveredServer[] {
  const urls = new Set<string>();
  for (const file of ctx.index.files) {
    if (file.language !== "rust") continue;
    for (const match of file.content.matchAll(
      /\.bind\s*\(\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*\)/g,
    )) {
      urls.add(`http://${match[1]}:${match[2]}`);
    }
  }
  return [...urls].map((url) => ({ url }));
}
