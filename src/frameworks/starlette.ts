/**
 * Starlette framework pack (Python).
 *
 * Starlette routes are declared as a list literal passed to
 * `Starlette(routes=[...])`:
 *  - Route("/path", endpoint, methods=["GET"])  (function or HTTPEndpoint class)
 *  - WebSocketRoute("/ws", endpoint)            (WebSocketEndpoint class)
 *  - Mount("/sub", app=sub_app | routes=[...]) nests routes under a prefix.
 *
 * Starlette is the platform FastAPI is built on, so this pack must NOT claim a
 * project that also uses FastAPI: applies() requires starlette routing evidence
 * and the absence of a fastapi dependency/import.
 *
 * Path params come straight from the `{name}` path template. Request bodies
 * read via `await request.json()` are dynamic, so they become an honest `{}`
 * gap rather than a fabricated schema.
 */

import type {
  Confidence,
  ExtractionResult,
  FrameworkPack,
  GapCode,
  RouteCandidate,
  RouteParameter,
  SourceLocation,
} from "../core/types.js";
import type { PythonAnalysis, PyClass, PyFunction } from "../lang/python/index.js";
import {pythonBindingResolver, isModuleDefinition} from "../lang/python/symbols.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  findAll,
  keywordArgument,
  listElements,
  literalInteger,
  literalString,
  positionalArguments,
} from "../lang/treesitter/ast.js";

type JsonSchemaLocal = Record<string, unknown>;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function callName(node: TsNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.namedChildren[1]?.text ?? null;
  return null;
}

function joinPath(prefix: string, sub: string): string {
  const cleanPrefix = prefix.replace(/\/+$/g, "");
  const cleanSub = sub.replace(/^\/+|\/+$/g, "");
  if (!cleanSub) return cleanPrefix ? `${cleanPrefix}/` : "/";
  return `${cleanPrefix}/${cleanSub}`;
}

function pathParams(path: string): RouteParameter[] {
  const params: RouteParameter[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    params.push({
      name: match[1]!.split(":")[0]!,
      in: "path",
      required: true,
      schema: { type: match[1]!.endsWith(":int") ? "integer" : match[1]!.endsWith(":float") ? "number" : "string" },
      confidence: "high",
    });
  }
  return params;
}

function operationId(method: string, path: string, symbol?: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, ""))
    .map((s) => s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const tail = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  const op = `${method.toLowerCase()}${tail || "Root"}`;
  // Disambiguate routes across separately-assembled apps that share a path.
  return symbol ? `${op}_${symbol.replace(/[^A-Za-z0-9]/g, "")}` : op;
}

export const starlettePack: FrameworkPack<PythonAnalysis> = {
  id: "starlette",
  language: "python",
  dependencyHints: ["starlette"],

  applies(ctx) {
    // Never claim FastAPI projects: FastAPI subclasses Starlette.
    if (ctx.manifest.packages.has("fastapi")) return false;
    const hasStarlette = ctx.index.files
      .filter((f) => f.language === "python")
      .some((f) => /from starlette|import starlette/.test(f.content));
    if (!hasStarlette) return false;
    const usesFastApi = ctx.index.files
      .filter((f) => f.language === "python")
      .some((f) => /from fastapi|import fastapi|FastAPI\(/.test(f.content));
    if (usesFastApi) return false;
    const hasRoutingFeature = ctx.index.files
      .filter((f) => f.language === "python")
      .some((f) =>
        /Starlette\(|WebSocketRoute|HTTPEndpoint|WebSocketEndpoint|routing import/.test(f.content),
      );
    return hasRoutingFeature;
  },

  extract(analysis, ctx) {
    const routes: RouteCandidate[] = [];
    const unresolved: ExtractionResult["unresolved"] = [];
    const servers: ExtractionResult["servers"] = [];

    const bindings = pythonBindingResolver(analysis);
    function endpointBinding(node: TsNode | null) {
      const file = node && bindings.fileOf(node);
      return file && node ? bindings.resolve(file, node.text) : undefined;
    }
    function endpointFunction(node: TsNode | null): PyFunction | undefined {
      const binding = endpointBinding(node);
      const matches = binding ? analysis.functions.filter(fn => fn.file === binding.file && fn.name === binding.name && isModuleDefinition(fn.node)) : [];
      return matches.length === 1 ? matches[0] : undefined;
    }
    function endpointClass(node: TsNode | null): PyClass | undefined {
      const binding = endpointBinding(node);
      const matches = binding ? analysis.classes.filter(cls => cls.file === binding.file && cls.name === binding.name && isModuleDefinition(cls.node)) : [];
      return matches.length === 1 ? matches[0] : undefined;
    }

    // Locate the routes list literal for a Starlette(...) call or a Mount's
    // `routes=` / `app=Starlette(routes=...)` argument.
    const routesListOf = (node: TsNode | null): TsNode | null => {
      if (!node) return null;
      if (node.type === "list") return node;
      if (node.type === "call" && callName(node.namedChildren[0] ?? null) === "Starlette") {
        return keywordArgument(node, "routes");
      }
      return null;
    };

    const bindingKey = (node: TsNode): string | undefined => {
      const binding = endpointBinding(node);
      return binding ? `${binding.file}:${binding.name}` : undefined;
    };
    const findListByName = (node: TsNode, seen = new Set<string>()): TsNode | null => {
      const binding = endpointBinding(node);
      if (!binding) return null;
      const key = `${binding.file}:${binding.name}`;
      if (seen.has(key) || seen.size > 32) return null;
      const file = analysis.files.get(binding.file);
      if (!file) return null;
      const declarations = ownedNodes(file.root, n => n.type === "assignment" && n.namedChildren[0]?.text === binding.name);
      if (declarations.length !== 1) return null;
      const value = declarations[0]!.namedChildren.at(-1);
      const list = value && ["identifier", "attribute"].includes(value.type) ? value : value ? routesListOf(value) : null;
      return list && ["identifier", "attribute"].includes(list.type)
        ? findListByName(list, new Set(seen).add(key)) : list;
    };
    const activeLists = new Set<number>();

    const endpointMethods = (
      endpointNode: TsNode | null,
      defaultMethods: string[],
    ): { kind: "function" | "class"; methods: string[]; node: TsNode | null } => {
      const cls = endpointClass(endpointNode);
      if (cls) {
        const methods: string[] = [];
        // HTTPEndpoint dispatches by HTTP verb to same-named methods.
        for (const method of HTTP_METHODS) {
          const has = analysis.functions.some(
            (f) => f.name === method && withinClass(cls, f),
          );
          if (has) methods.push(method);
        }
        if (methods.length) {
          return { kind: "class", methods, node: cls.node };
        }
      }
      const fn = endpointFunction(endpointNode);
      if (fn) return { kind: "function", methods: defaultMethods, node: fn.node };
      return { kind: "function", methods: defaultMethods, node: null };
    };

    const walk = (listNode: TsNode, prefix: string): void => {
      if (activeLists.has(listNode.id)) {
        unresolved.push({reason: "dynamic-path", message: "Recursive Starlette mount cannot be expanded into finite paths",
          origin: {file: bindings.fileOf(listNode) ?? "", line: listNode.startPosition.row + 1}});
        return;
      }
      activeLists.add(listNode.id);
      for (const el of listElements(listNode)) {
        if (el.type !== "call") continue;
        const name = callName(el.namedChildren[0] ?? null);
        if (!name) continue;
        const args = positionalArguments(el);

        if (name === "Route" || name === "WebSocketRoute") {
          const pathNode = args[0];
          const endpointNode = args[1] ?? null;
          const rawPath = pathNode ? literalString(pathNode) : null;
          if (rawPath === null) {
            unresolved.push({
              reason: "dynamic-path",
              message: "Route path is not a static string literal",
              origin: { file: "", line: el.startPosition.row + 1 },
            });
            continue;
          }
          const endpointName = callName(endpointNode);
          const fullPath = joinPath(prefix, rawPath);

          if (name === "WebSocketRoute") {
            routes.push({
              method: "get",
              path: fullPath,
              fullPath,
              operationId: operationId("get", fullPath, endpointName ?? "websocket"),
              origin: { file: "", line: el.startPosition.row + 1, symbol: endpointName ?? "websocket" },
              parameters: pathParams(fullPath),
              responses: [],
              tags: [],
              confidence: "high",
              gaps: [],
              components: [],
              extensions: { "x-websocket": true },
            });
            continue;
          }

          const methodsNode = keywordArgument(el, "methods");
          const defaultMethods = methodsNode
            ? listElements(methodsNode)
                .map((n) => literalString(n)?.toLowerCase())
                .filter((m): m is string => !!m && HTTP_METHODS.has(m))
            : ["get"];
          const ep = endpointName
            ? endpointMethods(endpointNode, defaultMethods)
            : { kind: "function" as const, methods: defaultMethods, node: null };

          // Resolve the endpoint function body for status-code evidence.
          for (const method of ep.methods) {
            const cls = ep.kind === "class" ? endpointClass(endpointNode) : undefined;
            const endpointFn = cls
              ? analysis.functions.find(fn => fn.name === method && fn.file === cls.file && withinClass(cls, fn))
              : endpointFunction(endpointNode);
            const statuses = endpointFn ? scanStatuses(endpointFn) : ["200"];
            routes.push(
              buildRoute({
                method,
                path: fullPath,
                line: el.startPosition.row + 1,
                symbol: endpointName ?? "endpoint",
                statuses,
                handler: endpointFn,
              }),
            );
          }
          continue;
        }

        if (name === "Mount") {
          const pathNode = args[0];
          const rawPath = pathNode ? literalString(pathNode) : "";
          if (rawPath === null) {
            unresolved.push({ reason: "dynamic-path", message: "Starlette mount prefix is not a static string literal",
              origin: { file: bindings.fileOf(el) ?? "", line: el.startPosition.row + 1 } });
            continue;
          }
          const mountPrefix = joinPath(prefix, rawPath);
          const routesKw = keywordArgument(el, "routes");
          const appKw = keywordArgument(el, "app");
          const explicitRoutes = routesKw?.type === "identifier" ? findListByName(routesKw) : routesKw;
          if (explicitRoutes?.type === "list") {
            walk(explicitRoutes, mountPrefix);
          } else if (appKw) {
            // Mount("/users", app=users_app) — resolve the assigned Starlette.
            if (appKw.type === "identifier" || appKw.type === "attribute") {
              const nested = findListByName(appKw);
              if (nested) walk(nested, mountPrefix);
            } else {
              const nested = routesListOf(appKw);
              if (nested) walk(nested, mountPrefix);
            }
          }
        }
      }
      activeLists.delete(listNode.id);
    };

    // Seed: every Starlette(routes=[...]) list literal, EXCEPT sub-apps that are
    // only referenced through Mount(app=...) (they are reached via the mount).
    const visited = new Set<TsNode>();
    const mountAppNames = new Set<string>();
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        if (callName(call.namedChildren[0] ?? null) !== "Mount") continue;
        const appKw = keywordArgument(call, "app");
        if (appKw && (appKw.type === "identifier" || appKw.type === "attribute")) {
          const key = bindingKey(appKw); if (key) mountAppNames.add(key);
        }
      }
    }
    for (const file of analysis.files.values()) {
      for (const assignment of ownedNodes(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!value || value.type !== "call") continue;
        if (callName(value.namedChildren[0] ?? null) !== "Starlette") continue;
        if (target?.type === "identifier" && mountAppNames.has(`${file.path}:${target.text}`)) continue;
        let routesList = keywordArgument(value, "routes");
        if (routesList?.type === "identifier" || routesList?.type === "attribute") {
          routesList = findListByName(routesList);
        }
        if (!routesList || routesList.type !== "list") {
          if (keywordArgument(value, "routes")) unresolved.push({ reason: "dynamic-path",
            message: "Starlette route list cannot be statically resolved",
            origin: { file: file.path, line: value.startPosition.row + 1 } });
          continue;
        }
        if (visited.has(routesList)) continue;
        visited.add(routesList);
        walk(routesList, "");
      }
    }

    // Legacy Starlette decorators remain common in deployed applications.
    // Only accept receivers constructed as Starlette in the same source file.
    for (const fn of analysis.functions) {
      const file = analysis.files.get(fn.file);
      if (!file) continue;
      const apps = new Set(findAll(file.root, n => n.type === "assignment")
        .filter(n => {
          const value = n.namedChildren[n.namedChildren.length - 1];
          return value?.type === "call" && callName(value.namedChildren[0] ?? null) === "Starlette";
        }).map(n => n.namedChildren[0]?.text));
      for (const decorator of fn.decorators) {
        const call = decorator.namedChildren[0];
        if (call?.type !== "call") continue;
        const target = call.namedChildren[0];
        if (target?.type !== "attribute" || callName(target) !== "route" ||
            !apps.has(target.namedChildren[0]?.text)) continue;
        const pathNode = positionalArguments(call)[0];
        const path = pathNode ? literalString(pathNode) : null;
        if (path === null) {
          unresolved.push({ reason: "dynamic-path", message: "Starlette decorator path is dynamic",
            origin: { file: fn.file, line: call.startPosition.row + 1 } });
          continue;
        }
        const methodsNode = keywordArgument(call, "methods");
        const methods = methodsNode ? listElements(methodsNode).map(n => literalString(n)?.toLowerCase())
          .filter((m): m is string => !!m && HTTP_METHODS.has(m)) : ["get"];
        for (const method of methods) {
          const route = buildRoute({ method, path, line: call.startPosition.row + 1,
            symbol: fn.name, statuses: scanStatuses(fn), handler: fn });
          route.origin = { ...route.origin, file: fn.file };
          routes.push(route);
        }
      }
    }

    // uvicorn.run(app, host=..., port=...) server hint.
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const fn = call.namedChildren[0] ?? null;
        const isUvicornRun =
          callName(fn) === "run" &&
          fn?.type === "attribute" &&
          fn.namedChildren[0]?.text === "uvicorn";
        if (!isUvicornRun) continue;
        const portNode = keywordArgument(call, "port");
        const port = portNode ? literalInteger(portNode) : null;
        const hostNode = keywordArgument(call, "host");
        const host = hostNode ? literalString(hostNode) ?? "127.0.0.1" : "127.0.0.1";
        if (port) servers.push({ url: `http://${host}:${port}` });
      }
    }

    // Deduplicate operationIds (separate apps can share a path/endpoint name).
    const seenIds = new Map<string, number>();
    for (const route of routes) {
      const base = route.operationId ?? "op";
      const count = seenIds.get(base) ?? 0;
      seenIds.set(base, count + 1);
      if (count > 0) route.operationId = `${base}_${count + 1}`;
    }

    return { routes, unresolved, components: [], securitySchemes: [], servers };
  },
};

function withinClass(cls: PyClass, fn: PyFunction): boolean {
  return findWithin(cls, fn.node);
}

function findWithin(cls: PyClass, target: TsNode): boolean {
  const stack: TsNode[] = [cls.node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    for (const child of cur.namedChildren) stack.push(child);
  }
  return false;
}

/** Stay in the endpoint's execution scope; nested declarations are not responses. */
function ownedNodes(body: TsNode, predicate: (node: TsNode) => boolean): TsNode[] {
  const found: TsNode[] = [];
  function walk(node: TsNode): void {
    if (["function_definition", "class_definition", "lambda"].includes(node.type)) return;
    if (predicate(node)) found.push(node);
    for (const child of node.namedChildren) walk(child);
  }
  walk(body);
  return found;
}

function returnedCalls(body: TsNode): TsNode[] {
  const calls: TsNode[] = [];
  const returns = ownedNodes(body, node => node.type === "return_statement");
  for (const statement of returns) {
    let value: TsNode | undefined = statement.namedChildren[0];
    if (value?.type === "identifier") {
      const writes = ownedNodes(body, node =>
        ["assignment", "augmented_assignment"].includes(node.type) && node.namedChildren[0]?.text === value!.text);
      const assignment = writes.length === 1 ? writes[0] : undefined;
      // A direct, preceding assignment is evidence; conditional writes aren't.
      if (assignment && assignment.startIndex < statement.startIndex && assignment.parent?.parent?.id === body.id) {
        value = assignment.namedChildren.at(-1);
      }
    }
    if (value?.type === "call") calls.push(value);
  }
  return calls;
}

// Collect explicit status codes from returned `JSONResponse(..., status_code=N)` calls
// in an endpoint body. Falls back to 200 when none are proven.
function scanStatuses(fn: PyFunction): string[] {
  if (!fn.body) return ["200"];
  if (fn.body.namedChildren.at(-1)?.type === "raise_statement" && !ownedNodes(fn.body, n => n.type === "return_statement").length) return ["default"];
  const statuses = new Set<string>();
  for (const call of returnedCalls(fn.body)) {
    const name = callName(call.namedChildren[0] ?? null);
    if (name !== "JSONResponse" && name !== "Response") continue;
    const kw = keywordArgument(call, "status_code");
    const code = kw ? literalInteger(kw) : null;
    if (code) statuses.add(String(code));
  }
  return statuses.size ? [...statuses] : ["200"];
}

function buildRoute(input: {
  method: string;
  path: string;
  line: number;
  symbol: string;
  statuses: string[];
  handler?: PyFunction;
}): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  gaps.add("response-schema-unknown");
  if (input.statuses.includes("default")) gaps.add("response-unknown");
  const handlerBody = input.handler?.body;
  const requestName = input.handler?.params.find(param => !["self", "cls"].includes(param.name))?.name;
  const jsonReads = handlerBody && requestName ? ownedNodes(handlerBody, node =>
    node.type === "await" && node.text.replace(/\s/g, "") === `await${requestName}.json()`) : [];
  const bodyRequired = jsonReads.some(read => {
    let statement = read;
    while (statement.parent && statement.parent.id !== handlerBody!.id) statement = statement.parent;
    return statement.type === "expression_statement" &&
      !handlerBody!.namedChildren.slice(0, handlerBody!.namedChildren.findIndex(node => node.id === statement.id))
        .some(node => ownedNodes(node, child => child.type === "return_statement" || child.type === "raise_statement").length);
  });
  if (jsonReads.length) gaps.add("body-schema-unknown");
  const confidence: Confidence = gaps.size ? "medium" : "high";
  let responses: RouteCandidate["responses"] = input.statuses.map((status) => ({
    statusCode: status,
    description: "",
    confidence: "medium",
    content: [],
  }));
  if (input.handler?.body) {
    const evidence = new Map<string, JsonSchemaLocal[]>();
    for (const call of returnedCalls(input.handler.body)) {
      if (callName(call.namedChildren[0] ?? null) !== "JSONResponse") continue;
      const code = keywordArgument(call, "status_code");
      const status = String(code ? literalInteger(code) ?? "default" : 200);
      const payload = keywordArgument(call, "content") ?? positionalArguments(call)[0];
      const schema = payload ? literalSchema(payload) : {};
      const alternatives = evidence.get(status) ?? [];
      if (!alternatives.some(s => JSON.stringify(s) === JSON.stringify(schema))) alternatives.push(schema);
      evidence.set(status, alternatives);
    }
    if (evidence.size) responses = [...responses.filter(response => !evidence.has(response.statusCode)), ...[...evidence].map(([statusCode, schemas]) => ({
      statusCode, description: "", confidence: "medium" as const,
      content: [{ mediaType: "application/json", schema: schemas.length === 1 ? schemas[0]! : { anyOf: schemas } }],
    }))];
    for (const call of returnedCalls(input.handler.body)) {
      const target = call.namedChildren[0];
      if (target?.type !== "attribute" || callName(target) !== "TemplateResponse") continue;
      const receiver = target.namedChildren[0]?.text;
      let root = call; while (root.parent) root = root.parent;
      const imported = findAll(root, n => n.type === "import_from_statement" && /from\s+starlette\.templating\s+import\s+Jinja2Templates\s*$/.test(n.text)).length > 0;
      const declarations = findAll(root, n => n.type === "assignment" && n.namedChildren[0]?.text === receiver);
      const value = declarations.length === 1 ? declarations[0]?.namedChildren.at(-1) : undefined;
      if (!imported || value?.type !== "call" || value.namedChildren[0]?.text !== "Jinja2Templates" || input.handler.params.some(p => p.name === receiver)) continue;
      const statusNode = keywordArgument(call, "status_code");
      const statusCode = String(statusNode ? literalInteger(statusNode) ?? "default" : 200);
      const response = {statusCode, description:"", confidence:"medium" as const, content:[{mediaType:"text/html",schema:{type:"string"}}]};
      const previous = responses.find(r => r.statusCode === statusCode);
      if (previous && evidence.has(statusCode)) previous.content?.push(...response.content);
      else responses = [...responses.filter(r => r.statusCode !== statusCode), response];
    }
  }
  return {
    method: input.method,
    path: input.path.replace(/\{([^}:]+):[^}]+\}/g, "{$1}"),
    fullPath: input.path.replace(/\{([^}:]+):[^}]+\}/g, "{$1}"),
    operationId: operationId(input.method, input.path, input.symbol),
    origin: { file: "", line: input.line, symbol: input.symbol },
    parameters,
    ...(jsonReads.length
      ? {
          requestBody: {
            required: bodyRequired,
            confidence: "medium",
            content: [{ mediaType: "application/json", schema: requestKeys(input.handler) }],
          },
        }
      : {}),
    responses,
    tags: [],
    confidence,
    gaps: [...gaps],
    components: [],
  };
}

/** Direct JSON key reads; writes and conditional/nested bodies are not required evidence. */
function requestKeys(handler: PyFunction | undefined): JsonSchemaLocal {
  if (!handler?.body) return {};
  const body = handler.body;
  const aliases = new Set<string>();
  const request = handler.params.find(p => p.name !== "self" && p.name !== "cls")?.name;
  if (!request || findAll(body, n => n.type === "assignment" && n.namedChildren[0]?.text === request).length) return {};
  for (const statement of body.namedChildren) {
    const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : statement;
    if (assignment?.type !== "assignment") continue;
    const left = assignment.namedChildren[0], right = assignment.namedChildren.at(-1);
    if (left?.type === "identifier" && right?.type === "await" && right.text.replace(/\s/g, "") === `await${request}.json()`) {
      const writes = findAll(body, n => (n.type === "assignment" || n.type === "augmented_assignment") &&
        (n.namedChildren[0]?.text === left.text || n.namedChildren[0]?.namedChildren[0]?.text === left.text));
      if (writes.length === 1) aliases.add(left.text);
    }
  }
  const properties: Record<string, JsonSchemaLocal> = {};
  for (const statement of body.namedChildren) {
    if (statement.type !== "expression_statement" && statement.type !== "return_statement") continue;
    const expression = statement.namedChildren[0];
    const value = expression?.type === "assignment" ? expression.namedChildren.at(-1) : expression;
    if (!value) continue;
    for (const read of findAll(value, n => n.type === "subscript")) {
      const target = read.namedChildren[0], key = read.namedChildren[1];
      const name = key ? literalString(key) : null;
      if (target && aliases.has(target.text) && name !== null) properties[name] = {};
    }
  }
  return Object.keys(properties).length ? {type:"object",properties,required:Object.keys(properties)} : {};
}

/** Literal response evidence only; dynamic expressions remain explicit holes. */
function literalSchema(node: TsNode, depth = 0): JsonSchemaLocal {
  if (depth > 8) return {};
  if (node.type === "identifier") {
    let scope = node.parent;
    while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
    if (scope) {
      let assignments = findAll(scope, n => n.type === "assignment" && n.namedChildren[0]?.text === node.text);
      if (!assignments.length && scope.type === "function_definition") {
        const params = scope.childForFieldName("parameters");
        if (params && findAll(params, n => n.type === "identifier" && n.text === node.text).length) return {};
        let module = scope; while (module.parent) module = module.parent;
        assignments = module.namedChildren.flatMap(statement => statement.type === "expression_statement" ? statement.namedChildren : [])
          .filter(n => n.type === "assignment" && n.namedChildren[0]?.text === node.text);
        scope = module;
      }
      const assignment = assignments.length === 1 ? assignments[0] : undefined;
      const value = assignment?.namedChildren.at(-1);
      // Only unconditional single assignments preceding the use are evidence.
      if (assignment && value && assignment.startIndex < node.startIndex &&
          (assignment.parent?.parent?.id === scope.id || assignment.parent?.parent?.parent?.id === scope.id)) {
        return literalSchema(value, depth + 1);
      }
    }
    return {};
  }
  if (node.type === "call" && node.namedChildren[0]?.text === "str") {
    let root = node; while (root.parent) root = root.parent;
    const shadowed = findAll(root, n =>
      (n.type === "assignment" && n.namedChildren[0]?.text === "str") ||
      (n.type === "function_definition" && n.childForFieldName("name")?.text === "str") ||
      (n.type === "parameters" && findAll(n, c => c.type === "identifier" && c.text === "str").length > 0) ||
      ((n.type === "import_statement" || n.type === "import_from_statement") && /\bstr\b/.test(n.text))
    ).length > 0;
    if (!shadowed) return {type:"string"};
  }
  if (node.type === "string" || node.type === "concatenated_string") return { type: "string" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "float") return { type: "number" };
  if (node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "none") return { type: "null" };
  if (node.type === "dictionary") {
    const properties: Record<string, JsonSchemaLocal> = {};
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") return {}; // dictionary unpacking is not fully known
      const key = pair.namedChildren[0];
      const value = pair.namedChildren[1];
      const name = key ? literalString(key) : null;
      if (name === null || !value) return {};
      properties[name] = literalSchema(value, depth + 1);
    }
    return { type: "object", properties, ...(Object.keys(properties).length ? { required: Object.keys(properties) } : {}) };
  }
  return {};
}
