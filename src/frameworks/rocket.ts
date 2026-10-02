/**
 * Rocket framework pack (Rust, tree-sitter based).
 *
 * Recognizes `#[get("/hello/<name>/<age:usize>")]` / `#[post("/users", data =
 * "<body>")]` route attributes on free functions, mounted through
 * `rocket::build().mount("/base", routes![a, b])`. Path segments carry optional
 * type guards (`<age:usize>`); handler parameters bind by name. `Json<T>` serves
 * as both the request body (via `data =`) and a typed responder; request guards
 * (e.g. `BasicAuth`) that are neither path nor body parameters are skipped.
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
  functionParameters,
  rustTypeToSchema,
  type RustModelIndex,
} from "../lang/rust/schema.js";

const ROUTE_VERBS = new Set(["get", "post", "put", "delete", "patch"]);

const STATUS_RESPONDERS: Record<string, string> = {
  Accepted: "202",
  BadRequest: "400",
  Unauthorized: "401",
  Forbidden: "403",
  NotFound: "404",
  Conflict: "409",
  UnprocessableEntity: "422",
  NoContent: "204",
};

export const rocketPack: FrameworkPack<RustAnalysis> = {
  id: "rocket",
  language: "rust",
  dependencyHints: ["rocket"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        f.language === "rust" &&
        (/\buse\s+rocket\b/.test(f.content) ||
          /\brocket::/.test(f.content) ||
          /routes!\s*\[/.test(f.content)),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildRustModelIndex(analysis);

    // handler fn name -> mount prefixes.
    const handlerMounts = new Map<string, string[]>();

    for (const [rel, file] of analysis.files) {
      collectMounts(file.root, handlerMounts);
      collectRoutes(analysis, file.root, rel, model, handlerMounts, candidates);
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers: DiscoveredServer[] = [];

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

function chainMethod(call: TsNode): string | null {
  const fe = call.namedChildren.find((c) => c.type === "field_expression");
  if (!fe) return null;
  return fe.namedChildren.find((c) => c.type === "field_identifier")?.text ?? null;
}

function collectMounts(root: TsNode, handlerMounts: Map<string, string[]>): void {
  for (const call of findAll(root, (n) => n.type === "call_expression")) {
    if (chainMethod(call) !== "mount") continue;
    const args = childrenOfType(call, "arguments")[0];
    if (!args) continue;
    const baseLit = args.namedChildren.find((a) => a.type === "string_literal");
    if (!baseLit) continue;
    const base = normalizeMount(unquoteRustString(baseLit.text));
    // Only this mount call's OWN arguments name the routes; the receiver chain
    // may contain earlier .mount() calls whose routes! macro must not leak in.
    const routesMacro = childrenOfType(args, "macro_invocation")[0];
    if (!routesMacro) continue;
    for (const id of findAll(routesMacro, (n) => n.type === "identifier")) {
      const name = id.text;
      const list = handlerMounts.get(name) ?? [];
      if (!list.includes(base)) list.push(base);
      handlerMounts.set(name, list);
    }
  }
}

// ---------------------------------------------------------------------------
// Route attributes
// ---------------------------------------------------------------------------

interface RouteAttr {
  verb: string;
  route: string;
  bodyBinding: string | null;
}

function routeFromAttribute(item: TsNode): RouteAttr | null {
  const attr = childrenOfType(item, "attribute")[0];
  if (!attr) return null;
  const head = attr.text.trim();
  const m = /^(?:rocket::)?(get|post|put|delete|patch)\s*\(/i.exec(head);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  if (!ROUTE_VERBS.has(verb)) return null;
  const lits = findAll(attr, (n) => n.type === "string_literal");
  if (!lits.length) return null;
  const route = unquoteRustString(lits[0]!.text);
  // data = "<body>" names the request-body parameter.
  let bodyBinding: string | null = null;
  const dataKw = findFirst(attr, (n) => n.type === "identifier" && n.text === "data");
  if (dataKw && lits[1]) {
    bodyBinding = unquoteRustString(lits[1].text).replace(/^<|>$/g, "");
  }
  return { verb, route, bodyBinding };
}

function collectRoutes(
  analysis: RustAnalysis,
  root: TsNode,
  rel: string,
  model: RustModelIndex,
  handlerMounts: Map<string, string[]>,
  out: RouteCandidate[],
): void {
  let pending: TsNode[] = [];
  for (const child of root.namedChildren) {
    if (child.type === "attribute_item") {
      pending.push(child);
      continue;
    }
    if (child.type === "function_item") {
      const route = pending
        .map((a) => routeFromAttribute(a))
        .find((r): r is RouteAttr => Boolean(r));
      if (route) {
        const fnName =
          child.namedChildren.find((c) => c.type === "identifier")?.text ?? "";
        const prefixes = handlerMounts.get(fnName) ?? [""];
        for (const prefix of prefixes) {
          const candidate = buildCandidate(
            analysis,
            model,
            route,
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

interface PathParam {
  name: string;
  guard: string | null;
}

/** "/hello/<name>/<age:usize>" -> path "/hello/{name}/{age}" + param descriptors. */
function parseRocketRoute(raw: string): { path: string; params: PathParam[] } {
  const params: PathParam[] = [];
  const path = raw.replace(/<([A-Za-z_][A-Za-z0-9_]*)(?::([^>]+))?>/g, (_m, name: string, guard?: string) => {
    params.push({ name, guard: guard ?? null });
    return `{${name}}`;
  });
  return { path: normalizePath(path), params };
}

function buildCandidate(
  analysis: RustAnalysis,
  model: RustModelIndex,
  route: RouteAttr,
  prefix: string,
  fn: TsNode,
  fnName: string,
  rel: string,
  line: number,
): RouteCandidate | null {
  const { path, params } = parseRocketRoute(route.route);
  const fullPath = joinRoute(prefix, path);
  const pathParamNames = new Set(params.map((p) => p.name));

  const { parameters, requestBody, gaps } = collectParameters(
    fn,
    model,
    params,
    pathParamNames,
    route.bodyBinding,
  );
  const responses = collectResponses(fn, model, gaps);

  return {
    method: route.verb,
    path: fullPath,
    fullPath,
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
// Parameters
// ---------------------------------------------------------------------------

function collectParameters(
  fn: TsNode,
  model: RustModelIndex,
  routeParams: PathParam[],
  pathParamNames: Set<string>,
  bodyBinding: string | null,
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

  // Map handler parameter name -> type node.
  const handlerParams = new Map<string, TsNode>();
  for (const param of functionParameters(fn)) {
    const binding = param.namedChildren.find((c) => c.type === "identifier")?.text;
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "generic_type" ||
        c.type === "type_identifier" ||
        c.type === "reference_type" ||
        c.type === "primitive_type" ||
        c.type === "scoped_type_identifier",
    );
    if (binding && typeNode) handlerParams.set(binding, typeNode);
  }

  // Path parameters: bind by name to the handler type, else use the <guard>.
  for (const rp of routeParams) {
    const typeNode = handlerParams.get(rp.name);
    let schema: JsonSchema | undefined;
    if (typeNode) {
      schema = rustTypeToSchema(typeNode, model);
    } else if (rp.guard) {
      schema = guardSchema(rp.guard);
    }
    parameters.push({
      name: rp.name,
      in: "path",
      required: true,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence: typeNode || rp.guard ? "high" : "low",
    });
  }

  // Body parameter named by `data = "<body>"`.
  if (bodyBinding) {
    const typeNode = handlerParams.get(bodyBinding);
    if (typeNode && typeNode.type === "generic_type" && baseName(typeNode) === "Json") {
      const inner = typeNode.namedChildren.find((c) => c.type === "type_arguments")?.namedChildren[0];
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
    } else {
      gaps.push("body-schema-unknown");
    }
  }

  // Any remaining handler parameters are request guards (e.g. BasicAuth,
  // &State<T>); they are not query/header/cookie params and are skipped honestly.
  return { parameters, ...(requestBody ? { requestBody } : {}), gaps };
}

function guardSchema(guard: string): JsonSchema {
  const g = guard.trim();
  if (/^(i8|i16|i32|i64|isize|u8|u16|u32|u64|usize)$/.test(g)) {
    return { type: "integer", ...(g === "i64" || g === "u64" || g === "isize" || g === "usize" ? { format: "int64" } : {}) };
  }
  if (/^(f32|f64)$/.test(g)) return { type: "number" };
  if (g === "bool") return { type: "boolean" };
  return { type: "string" };
}

function baseName(typeNode: TsNode): string | null {
  const base = typeNode.namedChildren.find(
    (c) => c.type === "type_identifier" || c.type === "scoped_type_identifier",
  );
  return base?.text.split("::").pop() ?? null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function findReturnType(fn: TsNode): TsNode | null {
  const params = fn.namedChildren.find((c) => c.type === "parameters");
  let seenParams = false;
  for (const child of fn.namedChildren) {
    if (child === params) {
      seenParams = true;
      continue;
    }
    if (!seenParams) continue;
    if (child.type === "block" || child.type === "where_clause") continue;
    return child;
  }
  return null;
}

function collectResponses(fn: TsNode, model: RustModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const ret = findReturnType(fn);
  if (!ret) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }

  // Json<T> responder.
  if (ret.type === "generic_type" && baseName(ret) === "Json") {
    const inner = ret.namedChildren.find((c) => c.type === "type_arguments")?.namedChildren[0];
    const schema = inner ? rustTypeToSchema(inner, model) : {};
    if (!Object.keys(schema).length) gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: Object.keys(schema).length ? "high" : "low",
        ...(Object.keys(schema).length ? { content: [{ mediaType: "application/json", schema }] } : {}),
      },
    ];
  }

  // status::Accepted<T> / status::BadRequest responders, incl. generic
  // instantiations such as Accepted<&'static str>.
  const responder =
    ret.type === "scoped_type_identifier" || ret.type === "type_identifier"
      ? ret.text.split("::").pop() ?? ""
      : ret.type === "generic_type"
        ? baseName(ret) ?? ""
        : "";
  if (responder && STATUS_RESPONDERS[responder]) {
    return [{ statusCode: STATUS_RESPONDERS[responder]!, description: "", confidence: "high" }];
  }

  // String / &str responders.
  if (ret.type === "reference_type" && /str\s*$/.test(ret.text.replace(/^&/, "").replace(/'[a-z]+\s*/g, "").trim())) {
    return [
      { statusCode: "200", description: "", confidence: "high", content: [{ mediaType: "text/plain", schema: { type: "string" } }] },
    ];
  }
  if (ret.type === "type_identifier" && ret.text === "String") {
    return [
      { statusCode: "200", description: "", confidence: "high", content: [{ mediaType: "text/plain", schema: { type: "string" } }] },
    ];
  }

  gaps.push("response-unknown");
  return [
    { statusCode: "200", description: "", confidence: "low", content: [{ mediaType: "application/json" }] },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePath(raw: string): string {
  let route = (raw ?? "").trim();
  if (route && !route.startsWith("/")) route = `/${route}`;
  return route || "/";
}

function normalizeMount(raw: string): string {
  return (raw ?? "").replace(/\/+$/, "");
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
