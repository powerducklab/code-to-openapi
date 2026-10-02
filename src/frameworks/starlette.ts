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
      name: match[1]!,
      in: "path",
      required: true,
      schema: { type: "string" },
      confidence: "high",
    });
  }
  return params;
}

function operationId(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, ""))
    .map((s) => s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const tail = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  return `${method.toLowerCase()}${tail || "Root"}`;
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

    const byName = new Map<string, PyFunction>();
    for (const fn of analysis.functions) byName.set(fn.name, fn);
    const classByName = new Map<string, PyClass>();
    for (const cls of analysis.classes) classByName.set(cls.name, cls);

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

    const findListByName = (name: string): TsNode | null => {
      // `users_app = Starlette(routes=[...])`: find the assignment.
      for (const file of analysis.files.values()) {
        for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
          const target = assignment.namedChildren[0];
          if (!target || target.text !== name) continue;
          const value = assignment.namedChildren[assignment.namedChildren.length - 1];
          return routesListOf(value);
        }
      }
      return null;
    };

    const endpointMethods = (
      endpointName: string,
      defaultMethods: string[],
    ): { kind: "function" | "class"; methods: string[]; node: TsNode | null } => {
      const cls = classByName.get(endpointName);
      if (cls) {
        const methods: string[] = [];
        // HTTPEndpoint dispatches by HTTP verb to same-named methods.
        for (const method of ["get", "post", "put", "patch", "delete"]) {
          const has = analysis.functions.some(
            (f) => f.name === method && withinClass(cls, f),
          );
          if (has) methods.push(method);
        }
        if (methods.length) {
          return { kind: "class", methods, node: cls.node };
        }
      }
      const fn = byName.get(endpointName);
      if (fn) return { kind: "function", methods: defaultMethods, node: fn.node };
      return { kind: "function", methods: defaultMethods, node: null };
    };

    const walk = (listNode: TsNode, prefix: string): void => {
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
              operationId: operationId("get", `${fullPath}/ws`),
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
            ? endpointMethods(endpointName, defaultMethods)
            : { kind: "function" as const, methods: defaultMethods, node: null };

          // Resolve the endpoint function body for status-code evidence.
          const endpointFn = endpointName ? byName.get(endpointName) : undefined;
          const statuses = endpointFn ? scanStatuses(endpointFn) : ["200"];

          for (const method of ep.methods) {
            routes.push(
              buildRoute({
                method,
                path: fullPath,
                line: el.startPosition.row + 1,
                symbol: endpointName ?? "endpoint",
                statuses,
              }),
            );
          }
          continue;
        }

        if (name === "Mount") {
          const pathNode = args[0];
          const rawPath = pathNode ? literalString(pathNode) : "";
          const mountPrefix = joinPath(prefix, rawPath ?? "");
          const routesKw = keywordArgument(el, "routes");
          const appKw = keywordArgument(el, "app");
          if (routesKw?.type === "list") {
            walk(routesKw, mountPrefix);
          } else if (appKw) {
            // Mount("/users", app=users_app) — resolve the assigned Starlette.
            if (appKw.type === "identifier") {
              const nested = findListByName(appKw.text);
              if (nested) walk(nested, mountPrefix);
            } else {
              const nested = routesListOf(appKw);
              if (nested) walk(nested, mountPrefix);
            }
          }
        }
      }
    };

    // Seed: every Starlette(routes=[...]) list literal, EXCEPT sub-apps that are
    // only referenced through Mount(app=...) (they are reached via the mount).
    const visited = new Set<TsNode>();
    const mountAppNames = new Set<string>();
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        if (callName(call.namedChildren[0] ?? null) !== "Mount") continue;
        const appKw = keywordArgument(call, "app");
        if (appKw?.type === "identifier") mountAppNames.add(appKw.text);
      }
    }
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!value || value.type !== "call") continue;
        if (callName(value.namedChildren[0] ?? null) !== "Starlette") continue;
        if (target?.type === "identifier" && mountAppNames.has(target.text)) continue;
        const routesList = keywordArgument(value, "routes");
        if (!routesList || visited.has(routesList)) continue;
        visited.add(routesList);
        walk(routesList, "");
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

// Collect explicit status codes from `JSONResponse(..., status_code=N)` calls
// in an endpoint body. Falls back to 200 when none are proven.
function scanStatuses(fn: PyFunction): string[] {
  if (!fn.body) return ["200"];
  const statuses = new Set<string>();
  for (const call of findAll(fn.body, (n) => n.type === "call")) {
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
}): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  gaps.add("response-schema-unknown");
  if (input.method === "post" || input.method === "put" || input.method === "patch") {
    gaps.add("body-schema-unknown");
  }
  const confidence: Confidence = gaps.size ? "medium" : "high";
  const responses: RouteCandidate["responses"] = input.statuses.map((status) => ({
    statusCode: status,
    description: "",
    confidence: "medium",
    ...(status === "204" ? { content: [] } : { content: [{ mediaType: "application/json", schema: {} }] }),
  }));
  return {
    method: input.method,
    path: input.path,
    fullPath: input.path,
    operationId: operationId(input.method, input.path),
    origin: { file: "", line: input.line, symbol: input.symbol },
    parameters,
    ...((input.method === "post" || input.method === "put" || input.method === "patch")
      ? {
          requestBody: {
            required: true,
            confidence: "medium",
            content: [{ mediaType: "application/json", schema: {} }],
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
