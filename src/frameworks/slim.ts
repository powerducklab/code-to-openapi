/**
 * Slim framework pack (PHP, tree-sitter based).
 *
 * Recognizes Slim 4 routing:
 *
 *   $app->get('/users/{id}', function (Request $req, Response $res, array $args) {
 *       return $res->withJson(['id' => $args['id']], 200);
 *   });
 *   $app->group('/api/v1', function () use ($app) {
 *       $app->post('/items', $handler);
 *   });
 *
 * It supports the get/post/put/patch/delete/options/head verbs and `group`
 * prefixes, `{name}` path placeholders, closure handlers whose signature is
 * `(ServerRequestInterface $request, ResponseInterface $response, array $args)`,
 * `$request->getQueryParams()['k']` query extraction, `$request->getParsedBody()`
 * request bodies, and `$response->withJson($data, $status)` / `withStatus` /
 * `withHeader` responses. Dynamic/untyped bodies and payloads stay `{}` plus an
 * honest gap; Slim 3 closure handlers share the same shape and are covered.
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
import type { PhpAnalysis } from "../lang/php/index.js";
import { phpStringText } from "../lang/php/index.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import {
  buildPhpModelIndex,
  formalParameters,
  type PhpModelIndex,
} from "../lang/php/schema.js";
import {
  binaryResponse,
  inferArraySchema,
  inferValueSchema,
  inferVariableModel,
  integerText,
  unknownJsonResponse,
} from "../lang/php/response.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

export const slimPack: FrameworkPack<PhpAnalysis> = {
  id: "slim",
  language: "php",
  dependencyHints: ["slim/slim"],

  applies(ctx) {
    // Route-feature signal: verb/group registration on the $app router. Laravel
    // uses the Route:: facade and Symfony uses #[Route] attributes, so neither
    // cross-claims this pack.
    const hasRoutes = ctx.index.files.some(
      (f) =>
        f.language === "php" &&
        /\$app\s*->\s*(?:get|post|put|patch|delete|options|head|any|map|group)\s*\(/.test(f.content),
    );
    if (!hasRoutes) return false;
    // Dependency signal: slim/slim installed, or Slim request/response imports.
    if (ctx.manifest.packages.has("slim/slim")) return true;
    return ctx.index.files.some(
      (f) =>
        f.language === "php" &&
        (f.content.includes("Slim\\") ||
          f.content.includes("Psr\\Http\\Message\\ServerRequestInterface") ||
          f.content.includes("Psr\\Http\\Message\\ResponseInterface")),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildPhpModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      // Every verb registration: $app->verb('/path', $handler).
      const calls = findAll(
        file.root,
        (n) => n.type === "member_call_expression" && isAppVerbCall(n),
      );
      for (const call of calls) {
        const method = call.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase() ?? "";
        if (!VERBS.has(method)) continue;
        const args = call.namedChildren.find((c) => c.type === "arguments");
        const argNodes = args ? childrenOfType(args, "argument") : [];
        const pathStr = argNodes[0]?.type === "string"
          ? argNodes[0]
          : argNodes[0]?.namedChildren.find((c) => c.type === "string");
        const rawPath = pathStr ? phpStringText(pathStr) : null;
        if (rawPath === null) continue;
        const closure = findClosureHandler(argNodes[1]);
        const prefix = groupPrefixChain(call);
        const fullPath = joinRoute(prefix, normalizeRoute(rawPath));

        const candidate = buildRoute({
          analysis,
          model,
          rel,
          call,
          verb: method,
          path: fullPath,
          closure,
        });
        if (candidate) candidates.push(candidate);
      }
    }

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    const components = [...model.components.entries()].map(([cName, schema]) => ({
      name: cName,
      schema,
    }));
    return { routes, unresolved, components, securitySchemes: [] as DiscoveredSecurityScheme[], servers: [] as DiscoveredServer[] };
  },
};

// ---------------------------------------------------------------------------
// Call-site recognition
// ---------------------------------------------------------------------------

/** True when the member call is `$app->...` on the Slim router variable. */
function isAppCall(node: TsNode): boolean {
  const receiver = node.namedChildren.find((c) => c.type === "variable_name");
  return receiver?.text === "$app";
}

function isAppVerbCall(node: TsNode): boolean {
  if (!isAppCall(node)) return false;
  const method = node.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase() ?? "";
  return VERBS.has(method) || method === "group";
}

/** Unwrap a handler argument into a closure (or null for a resolvable class-string). */
function findClosureHandler(arg: TsNode | undefined): TsNode | null {
  if (!arg) return null;
  if (arg.type === "anonymous_function_creation_expression") return arg;
  return findFirst(
    arg,
    (n) => n.type === "anonymous_function_creation_expression" || n.type === "arrow_function",
  );
}

/**
 * Walk up from a verb call, collecting every enclosing `$app->group('/prefix',
 * closure)` prefix in outer-to-inner order.
 */
function groupPrefixChain(call: TsNode): string {
  const prefixes: string[] = [];
  let cur: TsNode | null = call.parent ?? null;
  while (cur) {
    if (
      cur.type === "anonymous_function_creation_expression" ||
      cur.type === "closure_expression" ||
      cur.type === "arrow_function"
    ) {
      // Find the $app->group(...) that owns this closure.
      let p: TsNode | null = cur.parent ?? null;
      while (p) {
        if (p.type === "member_call_expression" && isAppCall(p)) {
          const method = p.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
          if (method === "group") {
            const gArgs = p.namedChildren.find((c) => c.type === "arguments");
            const first = gArgs ? childrenOfType(gArgs, "argument")[0] : undefined;
            const str = first?.type === "string" ? first : first?.namedChildren.find((c) => c.type === "string");
            const text = str ? phpStringText(str) : null;
            if (text) prefixes.unshift(normalizeRoute(text));
            break;
          }
        }
        p = p.parent ?? null;
      }
    }
    cur = cur.parent ?? null;
  }
  return prefixes.join("");
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

interface BuildArgs {
  analysis: PhpAnalysis;
  model: PhpModelIndex;
  rel: string;
  call: TsNode;
  verb: string;
  path: string;
  closure: TsNode | null;
}

function buildRoute(args: BuildArgs): RouteCandidate | null {
  const { analysis, model, rel, call, verb, path, closure } = args;
  const declaredPathParams = new Set([...path.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!));

  let parameters: RouteParameter[] = [];
  let requestBody: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence } | undefined;
  const gaps: GapCode[] = [];
  let responses: DiscoveredResponse[];

  if (closure) {
    const sig = closureSignature(closure);
    parameters = collectParameters(closure, sig);
    const usesBody = findAll(closure, (n) => {
      if (n.type !== "member_call_expression") return false;
      const receiver = n.namedChildren.find((c) => c.type === "variable_name");
      if (receiver?.text !== sig.requestVar) return false;
      const method = n.namedChildren.find((c) => c.type === "name")?.text;
      return method === "getParsedBody";
    }).length;
    const writesBody = ["post", "put", "patch"].includes(verb);
    if (writesBody && usesBody) {
      // The parsed body is dynamically consumed; its shape is not statically
      // provable, so emit an honest empty-object body with a gap.
      gaps.push("body-schema-unknown");
      requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema: {} }],
        confidence: "low",
      };
    }
    responses = collectResponses(closure, sig, model, gaps);
  } else {
    gaps.push("response-unknown");
    responses = [{ statusCode: "200", description: "", confidence: "low" }];
  }

  for (const p of declaredPathParams) {
    if (!parameters.some((prm) => prm.in === "path" && prm.name === p)) {
      parameters.push({ name: p, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
    }
  }

  return {
    method: verb,
    path,
    fullPath: path,
    origin: { file: rel, line: call.startPosition.row + 1 },
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    confidence: gaps.length ? "medium" : "high",
    gaps,
    components: [],
    handlerSource: closure?.text.slice(0, 8192),
  };
}

interface ClosureSignature {
  requestVar: string;
  responseVar: string;
  argsVar: string;
}

/** Resolve $request / $response / $args variable names from the closure signature. */
function closureSignature(closure: TsNode): ClosureSignature {
  const params = formalParameters(closure);
  const nameOf = (p: TsNode) => p.namedChildren.find((c) => c.type === "variable_name")?.text ?? "";
  const requestVar = params[0] ? nameOf(params[0]) : "$request";
  const responseVar = params[1] ? nameOf(params[1]) : "$response";
  const argsVar = params[2] ? nameOf(params[2]) : "$args";
  return { requestVar, responseVar, argsVar };
}

function collectParameters(
  closure: TsNode,
  sig: ClosureSignature,
): RouteParameter[] {
  const parameters: RouteParameter[] = [];
  const push = (location: RouteParameter["in"], name: string, schema: JsonSchema | undefined, confidence: Confidence, required: boolean) => {
    if (parameters.some((p) => p.in === location && p.name === name)) return;
    parameters.push({
      name,
      in: location,
      required: location === "path" ? true : required,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    });
  };

  // $request->getQueryParams()['key'] -> query parameter.
  for (const sub of findAll(closure, (n) => n.type === "subscript_expression")) {
    const base = sub.namedChildren[0];
    if (!base || base.type !== "member_call_expression") continue;
    const receiver = base.namedChildren.find((c) => c.type === "variable_name");
    if (receiver?.text !== sig.requestVar) continue;
    const method = base.namedChildren.find((c) => c.type === "name")?.text;
    if (method !== "getQueryParams") continue;
    const keyNode = sub.namedChildren[1];
    const key = keyNode ? phpStringText(keyNode) : null;
    if (key) push("query", key, { type: "string" }, "high", false);
  }

  // $response->getHeaderLine('X-Request-Id') / withHeader('X-...', ...) hints at
  // consumed request headers; treat explicit getHeader/getHeaderLine keys as
  // header parameters.
  for (const call of findAll(closure, (n) => n.type === "member_call_expression")) {
    const receiver = call.namedChildren.find((c) => c.type === "variable_name");
    if (receiver?.text !== sig.requestVar) continue;
    const method = call.namedChildren.find((c) => c.type === "name")?.text;
    if (method !== "getHeader" && method !== "getHeaderLine") continue;
    const args = call.namedChildren.find((c) => c.type === "arguments");
    const first = args ? childrenOfType(args, "argument")[0] : undefined;
    const key = first ? phpStringText(first) : null;
    if (key) push("header", key, { type: "string" }, "high", false);
  }

  // $args['id'] confirms a path parameter; the path template itself is static,
  // so this is not a "dynamic path" gap.
  for (const sub of findAll(closure, (n) => n.type === "subscript_expression")) {
    const base = sub.namedChildren[0];
    if (!base || base.type !== "variable_name") continue;
    if (base.text !== sig.argsVar) continue;
    const keyNode = sub.namedChildren[1];
    const key = keyNode ? phpStringText(keyNode) : null;
    if (key) {
      push("path", key, { type: "string" }, "high", true);
    }
  }

  return parameters;
}

// ---------------------------------------------------------------------------
// Response collection
// ---------------------------------------------------------------------------

function collectResponses(
  closure: TsNode,
  sig: ClosureSignature,
  model: PhpModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const responses: DiscoveredResponse[] = [];

  for (const ret of findAll(closure, (n) => n.type === "return_statement")) {
    const expression = ret.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "array_creation_expression" ||
        c.type === "variable_name",
    );
    if (!expression) continue;

    let response: DiscoveredResponse | null = null;
    if (expression.type === "member_call_expression") {
      response = interpretResponse(expression, sig, model, gaps, closure);
    } else if (expression.type === "array_creation_expression") {
      const schema = inferArraySchema(expression, model, closure);
      if (schema && Object.keys(schema).length) {
        response = {
          statusCode: "200",
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema }],
        };
      }
    } else if (expression.type === "variable_name") {
      // return $response; — the response object itself is returned (e.g. after
      // withHeader/withBody). Treat as an opaque 200 unless it is the response
      // parameter (which carries an unknown body).
      const assigned = inferVariableModel(closure, expression, model);
      if (assigned && expression.text !== sig.responseVar) {
        response = {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema: assigned }],
        };
      } else {
        gaps.push("response-unknown");
        response = { statusCode: "200", description: "", confidence: "low" };
      }
    }
    if (response) responses.push(response);
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }

  const merged = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = merged.get(response.statusCode);
    if (!existing || confidenceRank(response.confidence) > confidenceRank(existing.confidence)) {
      merged.set(response.statusCode, response);
    }
  }
  return [...merged.values()];
}

function confidenceRank(confidence: Confidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function interpretResponse(
  expression: TsNode,
  sig: ClosureSignature,
  model: PhpModelIndex,
  gaps: GapCode[],
  closure: TsNode,
): DiscoveredResponse | null {
  const receiver = expression.namedChildren.find((c) => c.type === "variable_name");
  const method = expression.namedChildren.find((c) => c.type === "name")?.text ?? "";
  const args = expression.namedChildren.find((c) => c.type === "arguments");
  const argNodes = args ? childrenOfType(args, "argument") : [];
  const onResponse = receiver?.text === sig.responseVar;

  // $response->withJson($data, $status)
  if (onResponse && method === "withJson") {
    const status = integerText(argNodes[1]) ?? "200";
    const payload = argNodes[0];
    if (!payload) {
      return {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema: {} }],
      };
    }
    const schema = inferValueSchema(payload, model, closure);
    if (!schema || !Object.keys(schema).length) return unknownJsonResponse(status, gaps);
    return {
      statusCode: status,
      description: "",
      confidence: "high",
      content: [{ mediaType: "application/json", schema }],
    };
  }

  // $response->withStatus($code) — an empty body (often 204).
  if (onResponse && method === "withStatus") {
    const code = integerText(argNodes[0]) ?? "200";
    return { statusCode: code, description: "", confidence: "high" };
  }

  // $response->withHeader('Content-Type', 'application/octet-stream') writing a
  // body is an opaque binary/text response.
  if (onResponse && method === "withHeader") {
    const contentType = argNodes[1] ? phpStringText(argNodes[1]) : null;
    if (contentType && /octet-stream|binary/i.test(contentType)) {
      return binaryResponse("200");
    }
    gaps.push("response-unknown");
    return { statusCode: "200", description: "", confidence: "low" };
  }

  // $response->getBody()->write(...) is a streamed/opaque body.
  if (onResponse && method === "getBody") {
    gaps.push("response-unknown");
    return { statusCode: "200", description: "", confidence: "low" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeRoute(raw: string): string {
  let route = raw.trim();
  if (!route) return "/";
  if (!route.startsWith("/")) route = `/${route}`;
  route = route.replace(/\{([^}?]+)\?\}/g, "{$1}");
  return route.replace(/\/+$/, "") || "/";
}

function joinRoute(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
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
  // Slim routes are anonymous closures without a natural operationId; leave
  // operationId unset so the engine assigns stable, unique ids.
  void routes;
}
