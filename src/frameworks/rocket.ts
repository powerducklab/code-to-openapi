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

import { rustScalarExpression } from "../lang/rust/expression.js";
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
  rustSerializationIndex,
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
    const allComponents = new Map<string, JsonSchema>();

    // handler fn name -> mount prefixes.
    const handlerMounts = new Map<string, string[]>();
    for (const [rel, file] of analysis.files) collectMounts(file.root, handlerMounts, rel);
    for (const [rel, file] of analysis.files) {
      const model = buildRustModelIndex(analysis, rel);
      const first = candidates.length;
      collectRoutes(analysis, file.root, rel, model, handlerMounts, candidates);
      applyCatchers(file.root, candidates.slice(first));
      for (const [name, schema] of model.components) allComponents.set(name, schema);
    }

    const components = [...allComponents.entries()].map(([name, schema]) => ({
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

function modulePath(file: string): string[] {
  const parts = file.replace(/\\/g, "/").replace(/^src\//, "").replace(/\.rs$/, "").split("/");
  if (["main", "lib", "mod"].includes(parts.at(-1) ?? "")) parts.pop();
  return parts;
}
function collectMounts(root: TsNode, handlerMounts: Map<string, string[]>, file: string): void {
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
    const entries = routesMacro.text.slice(routesMacro.text.indexOf("[") + 1, routesMacro.text.lastIndexOf("]")).split(",");
    for (const entry of entries) {
      const text = entry.trim();
      if (!/^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(text)) continue;
      const segments = text.split("::");
      let scope = modulePath(file);
      if (segments[0] === "crate") { scope = []; segments.shift(); }
      else if (segments[0] === "self") segments.shift();
      while (segments[0] === "super") { scope.pop(); segments.shift(); }
      const key = [...scope, ...segments].join("::");
      const list = handlerMounts.get(key) ?? [];
      if (!list.includes(base)) list.push(base);
      handlerMounts.set(key, list);
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
  const data = /\bdata\s*=\s*"<([A-Za-z_][A-Za-z0-9_]*)>"/.exec(attr.text);
  if (data) bodyBinding = data[1]!;
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
        const prefixes = handlerMounts.get([...modulePath(rel), fnName].join("::")) ?? [""];
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
    if (typeNode && typeNode.type === "generic_type" && ["Json", "MsgPack"].includes(baseName(typeNode) ?? "")) {
      const inner = typeNode.namedChildren.find((c) => c.type === "type_arguments")?.namedChildren[0];
      const schema = inner ? rustTypeToSchema(inner, model) : {};
      if (inner && Object.keys(schema).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: baseName(typeNode) === "MsgPack" ? "application/msgpack" : "application/json", schema }],
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
  const responses = responsesForType(findReturnType(fn), rustSerializationIndex(model), gaps);
  const ret = findReturnType(fn)?.text ?? "";
  if (/^(?:Option<)?(?:Value|serde_json::Value)>?$/.test(ret)) {
    const schema = jsonMacroSchema(fn, model);
    const response = responses.find(r => r.statusCode === "200");
    if (schema && response) response.content = [{ mediaType: "application/json", schema }];
  }
  narrowConstructedOptionFields(fn, model, responses);
  return responses;
}

/** Narrow only an unconditional tail construction; other return paths stay broad. */
function narrowConstructedOptionFields(fn: TsNode, model: RustModelIndex, responses: DiscoveredResponse[]): void {
  if (findAll(fn, node => node.type === "return_expression").length) return;
  let value = fn.namedChildren.find(node => node.type === "block")?.namedChildren.at(-1);
  for (let depth = 0; value?.type === "call_expression" && depth < 8; depth++) {
    if (!["Some", "Ok", "Json", "MsgPack"].includes(value.namedChildren[0]?.text ?? "")) return;
    const args = value.namedChildren.find(node => node.type === "arguments")?.namedChildren;
    if (args?.length !== 1) return;
    value = args[0];
  }
  if (value?.type !== "struct_expression") return;
  const definition = model.byName.get(value.namedChildren[0]?.text ?? "");
  if (!definition) return;
  const fields = value.namedChildren.find(node => node.type === "field_initializer_list")?.namedChildren ?? [];
  for (const response of responses.filter(response => response.statusCode === "200")) for (const media of response.content ?? []) {
    const original = media.schema;
    const base = typeof original?.$ref === "string" ? model.components.get(original.$ref.split("/").pop()!) : original;
    if (!base?.properties) continue;
    const properties = { ...base.properties } as Record<string, JsonSchema>;
    let changed = false;
    for (const field of fields) {
      const name = field.namedChildren[0]?.text;
      const expression = field.namedChildren.at(-1);
      const type = definition.fields.find(item => item.name === name)?.typeNode;
      const inner = type?.namedChildren.find(node => node.type === "type_arguments")?.namedChildren.find(node => node.type !== "lifetime");
      // A nested Option can still serialize null inside Some(None).
      if (!name || !type || baseName(type) !== "Option" || !inner || baseName(inner) === "Option" ) continue;
      const innerSchema = rustTypeToSchema(inner, model);
      if (Array.isArray(innerSchema.type) || innerSchema.anyOf || !innerSchema.type) continue;
      if (expression?.type !== "call_expression" || expression.namedChildren[0]?.text !== "Some") continue;
      const property = properties[name];
      if (!property) continue;
      if (Array.isArray(property.type)) { const types = property.type.filter(type => type !== "null"); properties[name] = { ...property, type: types.length === 1 ? types[0] : types }; changed = true; }
      else if (Array.isArray(property.anyOf)) { properties[name] = { ...property, anyOf: property.anyOf.filter(branch => (branch as JsonSchema).type !== "null") }; changed = true; }
    }
    if (changed) media.schema = { ...base, properties };
  }
}

function responsesForType(ret: TsNode | null, model: RustModelIndex, gaps: GapCode[], depth = 0): DiscoveredResponse[] {
  if (depth > 10) return [{ statusCode: "200", description: "", confidence: "low" }];
  if (ret?.type === "generic_type" && baseName(ret) === "Result") {
    const args = ret.namedChildren.find(c => c.type === "type_arguments")?.namedChildren.filter(c => c.type !== "lifetime") ?? [];
    const responses = args.flatMap(arg => responsesForType(arg, model, gaps, depth + 1));
    return responses.filter((response, i) => responses.findIndex(other => JSON.stringify(other) === JSON.stringify(response)) === i);
  }
  if (ret?.type === "generic_type" && baseName(ret) === "Option") {
    const inner = ret.namedChildren.find(c => c.type === "type_arguments")?.namedChildren.find(c => c.type !== "lifetime");
    return [...responsesForType(inner ?? null, model, gaps, depth + 1), { statusCode: "404", description: "Responder returned None", confidence: "high" }];
  }
  if (!ret) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }

  // Json<T> responder.
  if (ret.type === "generic_type" && ["Json", "MsgPack"].includes(baseName(ret) ?? "")) {
    const inner = ret.namedChildren.find((c) => c.type === "type_arguments")?.namedChildren[0];
    const schema = inner ? rustTypeToSchema(inner, model) : {};
    if (!Object.keys(schema).length) gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: Object.keys(schema).length ? "high" : "low",
        ...(Object.keys(schema).length ? { content: [{ mediaType: baseName(ret) === "MsgPack" ? "application/msgpack" : "application/json", schema }] } : {}),
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

/** Read literal JSON token trees without executing a macro or guessing expressions. */
function jsonMacroSchema(fn: TsNode, model?: RustModelIndex): JsonSchema | undefined {
  const schemas: JsonSchema[] = [];
  for (const macro of findAll(fn, n => n.type === "macro_invocation" && /^(?:serde_json::)?json!/.test(n.text))) {
    let node = macro;
    let returned = true;
    while (node.parent && node.parent.id !== fn.id) {
      const parent = node.parent;
      if (parent.type === "let_declaration" || parent.type === "closure_expression") { returned = false; break; }
      if (parent.type === "call_expression" && !/^(?:Some|Ok|Err)\s*\(/.test(parent.text)) { returned = false; break; }
      if (parent.type === "block" && parent.namedChildren.at(-1)?.id !== node.id && node.type !== "return_expression") { returned = false; break; }
      node = parent;
    }
    if (!returned) continue;
    const outer = macro.namedChildren.find(n => n.type === "token_tree");
    const object = outer?.namedChildren.find(n => n.type === "token_tree" && n.text.startsWith("{"));
    if (!object) continue;
    const properties: Record<string, JsonSchema> = {};
    const fields: TsNode[][] = [[]];
    for (const token of object.children.slice(1, -1)) {
      if (token.text === ",") fields.push([]); else fields.at(-1)!.push(token);
    }
    for (const tokens of fields) {
      if (!tokens.length) continue;
      if (tokens[0]?.type !== "string_literal" || tokens[1]?.text !== ":") { returned = false; break; }
      let key: string;
      try { key = JSON.parse(tokens[0].text); } catch { returned = false; break; }
      const value = tokens.length === 3 ? tokens[2] : undefined;
      properties[key] = value?.type === "string_literal" ? { type: "string" }
        : value?.type === "integer_literal" ? { type: "integer" }
        : value?.type === "float_literal" ? { type: "number" }
        : value && ["true", "false"].includes(value.text) ? { type: "boolean" }
        : value?.text === "null" ? { type: "null" } : model ? rustScalarExpression(value, fn, model) : {};
    }
    if (returned) schemas.push({ type: "object", properties, required: Object.keys(properties) });
  }
  return schemas.length === 1 ? schemas[0] : schemas.length ? { anyOf: schemas } : undefined;
}

function applyCatchers(root: TsNode, routes: RouteCandidate[]): void {
  const catchers = new Map<string, { status: string; schema: JsonSchema }>();
  let status: string | undefined;
  for (const node of root.namedChildren) {
    if (node.type === "attribute_item") { status = /catch\s*\(\s*(\d{3})\s*\)/.exec(node.text)?.[1] ?? status; continue; }
    if (node.type === "function_item" && status) {
      const name = node.namedChildren.find(n => n.type === "identifier")?.text;
      const schema = jsonMacroSchema(node);
      if (name && schema) catchers.set(name, { status, schema });
    }
    status = undefined;
  }
  const registrations = findAll(root, n => n.type === "call_expression" && chainMethod(n) === "register");
  const prefixLength = (call: TsNode) => call.namedChildren.find(n => n.type === "arguments")?.namedChildren.find(n => n.type === "string_literal")?.text.length ?? 0;
  // Apply more specific catchers last, independent of registration order.
  for (const call of registrations.sort((a,b) => prefixLength(a)-prefixLength(b))) {
    const args = call.namedChildren.find(n => n.type === "arguments");
    const prefixNode = args?.namedChildren.find(n => n.type === "string_literal");
    const macro = args?.namedChildren.find(n => n.type === "macro_invocation" && n.text.startsWith("catchers!"));
    if (!prefixNode || !macro) continue;
    const prefix = normalizeMount(unquoteRustString(prefixNode.text));
    for (const identifier of findAll(macro, n => n.type === "identifier")) {
      const catcher = catchers.get(identifier.text); if (!catcher) continue;
      for (const route of routes) {
        const path = route.fullPath ?? route.path;
        if (prefix && path !== prefix && !path.startsWith(prefix + "/")) continue;
        const response = route.responses.find(r => r.statusCode === catcher.status);
        if (response) response.content = [{ mediaType: "application/json", schema: catcher.schema }];
      }
    }
  }
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
