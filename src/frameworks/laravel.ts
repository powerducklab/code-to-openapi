/**
 * Laravel framework pack (PHP, tree-sitter based).
 *
 * Recognizes Route::get/post/..., Route::group(['prefix'=>...], closure),
 * Route::apiResource/resource, [Controller::class, 'method'] handlers,
 * closures, FormRequest rules(), response()->json/noContent/stream and
 * Eloquent static calls for response component inference.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  buildPhpModelIndex,
  ensurePhpComponent,
  formalParameters,
  formRulesToSchema,
  phpTypeToSchema,
  type PhpModelIndex,
} from "../lang/php/schema.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "any"]);
const RESOURCE_VERBS = new Set(["resource", "apiresource"]);

const COLLECTION_METHODS = new Set([
  "all",
  "get",
  "paginate",
  "simplepaginate",
  "cursor",
  "collection",
]);
const ITEM_METHODS = new Set([
  "find",
  "findorfail",
  "first",
  "firstorfail",
  "create",
  "firstorcreate",
  "updateorcreate",
  "findornew",
  "firstwhere",
  "save",
]);

export const laravelPack: FrameworkPack<PhpAnalysis> = {
  id: "laravel",
  language: "php",
  dependencyHints: ["laravel/framework"],

  applies(ctx) {
    const hasRoutes = ctx.index.files.some(
      (f) => f.language === "php" && /Route::(?:get|post|put|patch|delete|group|apiResource|resource)\b/.test(f.content),
    );
    if (hasRoutes) return true;
    if (existsSync(join(ctx.root, "composer.json"))) {
      try {
        const composer = JSON.parse(readFileSync(join(ctx.root, "composer.json"), "utf8"));
        return Boolean(composer?.require?.["laravel/framework"]);
      } catch {
        return false;
      }
    }
    return false;
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildPhpModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      const routeCalls = findAll(
        file.root,
        (n) => n.type === "scoped_call_expression" && routeCallName(n) !== null,
      );

      for (const call of routeCalls) {
        const name = routeCallName(call)!;
        const args = callArguments(call);
        if (RESOURCE_VERBS.has(name)) {
          const resource = parseResourceCall(args, name === "resource", analysis, model, rel);
          candidates.push(...resource);
          continue;
        }
        if (name !== "group" && name !== "prefix") {
          if (!VERBS.has(name)) continue;
          const prefix = groupPrefixChain(call);
          const verbs = name === "any" ? ["get", "post", "put", "patch", "delete"] : expandMatchVerbs(name, args);
          for (const verb of verbs) {
            // Route::match(['get','post'], $path, $handler) shifts the path
            // and handler past the verb-list argument.
            const shiftedArgs = name === "match" ? args.slice(1) : args;
            const candidate = buildRoute(
              analysis,
              model,
              verb,
              shiftedArgs,
              joinRoute(prefix, ""),
              rel,
              call,
            );
            if (candidate) candidates.push(candidate);
          }
        }
      }
    }

    const components = [...model.components.entries()].map(([cName, schema]) => ({
      name: cName,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers = detectServers(ctx);

    return { routes: dedupe(candidates), unresolved, components, securitySchemes, servers };
  },
};

function routeCallName(node: TsNode): string | null {
  if (node.type !== "scoped_call_expression") return null;
  const names = childrenOfType(node, "name");
  // scope::method — the last two names are "Route" and the method; scope may
  // itself be a qualified name with multiple parts.
  const method = names[names.length - 1]?.text.toLowerCase() ?? null;
  const scope = names[names.length - 2]?.text;
  return scope === "Route" ? method : null;
}

function callArguments(node: TsNode): TsNode[] {
  const list = node.namedChildren.find((c) => c.type === "arguments");
  return list ? childrenOfType(list, "argument") : [];
}

function groupPrefixChain(call: TsNode): string {
  const prefixes: string[] = [];
  let current: TsNode | null = call.parent ?? null;
  while (current) {
    if (current.type === "anonymous_function_creation_expression" || current.type === "closure_expression") {
      const groupCall = findEnclosingGroupCall(current);
      if (groupCall) {
        const prefix = groupOptionsPrefix(groupCall);
        if (prefix) prefixes.unshift(prefix);
      }
    }
    current = current.parent ?? null;
  }
  return prefixes.join("");
}

function findEnclosingGroupCall(closure: TsNode): TsNode | null {
  let current: TsNode | null = closure.parent ?? null;
  while (current) {
    if (
      current.type === "scoped_call_expression" &&
      (routeCallName(current) === "group" || routeCallName(current) === "prefix")
    ) {
      return current;
    }
    current = current.parent ?? null;
  }
  return null;
}

function groupOptionsPrefix(groupCall: TsNode): string {
  const args = callArguments(groupCall);
  const options =
    groupCallNameIs(groupCall, "prefix")
      ? args[0]
      : args.find((a) => a.namedChildren.some((c) => c.type === "array_creation_expression"))
        ?.namedChildren.find((c) => c.type === "array_creation_expression");
  if (!options) return "";
  if (options.type === "string") return normalizeRoute(phpStringText(options) ?? "");
  for (const element of childrenOfType(options, "array_element_initializer")) {
    const strings = childrenOfType(element, "string");
    if (phpStringText(strings[0]) === "prefix") {
      return normalizeRoute(phpStringText(strings[1]) ?? "");
    }
  }
  return "";
}

function groupCallNameIs(call: TsNode, expected: string): boolean {
  return routeCallName(call) === expected;
}

function expandMatchVerbs(name: string, args: TsNode[]): string[] {
  if (name !== "match") return [name];
  // Route::match(['get','post'], ...)
  const first = args[0];
  const array = first?.namedChildren.find((c) => c.type === "array_creation_expression");
  if (!array) return ["get"];
  const verbs = childrenOfType(array, "string")
    .map((s) => phpStringText(s)?.toLowerCase() ?? "")
    .filter((v) => VERBS.has(v) && v !== "any");
  return verbs.length ? verbs : ["get"];
}

function buildRoute(
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  verb: string,
  args: TsNode[],
  groupPrefix: string,
  rel: string,
  call: TsNode,
): RouteCandidate | null {
  // The first argument is the path string (possibly wrapped in an argument
  // node); the handler is the second argument.
  const pathArg =
    args[0]?.type === "string"
      ? args[0]
      : args[0]?.namedChildren.find((c) => c.type === "string");
  const handlerArg = args[1];
  if (!pathArg) return null;
  const rawPath = phpStringText(pathArg) ?? "";
  const fullPath = joinRoute(groupPrefix, normalizeRoute(rawPath));
  const pathParams = new Set(
    [...fullPath.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!),
  );

  const handler = resolveHandler(handlerArg, analysis);
  const handlerNode = handler?.node ?? null;
  const controllerName = handler?.controller ?? null;
  const methodName = handler?.method ?? null;

  const { parameters, requestBody, gaps } = handlerNode
    ? collectParameters(handlerNode, analysis, model, verb, pathParams)
    : { parameters: [], requestBody: undefined, gaps: ["response-unknown"] as GapCode[] };

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "low",
      });
    }
  }

  const responses = handlerNode
    ? collectResponses(handlerNode, model, gaps)
    : [
        {
          statusCode: "200",
          description: "",
          confidence: "low" as Confidence,
        },
      ];

  const tag = controllerName ? controllerName.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase()) : null;

  return {
    method: verb,
    path: fullPath,
    fullPath,
    ...(methodName && controllerName ? { operationId: `${controllerName}.${methodName}` } : {}),
    origin: { file: rel, line: call.startPosition.row + 1 },
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    ...(tag ? { tags: [tag] } : { tags: [] }),
    ...(responses.some((r) =>
      r.content?.some((media) => media.mediaType === "text/event-stream"),
    )
      ? { extensions: { "x-protocol": "sse" } }
      : {}),
    confidence: gaps.length ? "medium" : "high",
    gaps,
    components: [],
    handlerSource: handlerNode?.text.slice(0, 8192),
  };
}

interface ResolvedHandler {
  node: TsNode;
  controller: string | null;
  method: string | null;
}

function resolveHandler(
  handlerArg: TsNode | undefined,
  analysis: PhpAnalysis,
): ResolvedHandler | null {
  if (!handlerArg) return null;
  const inner = handlerArg.namedChildren[0] ?? handlerArg;

  // Closure.
  const closure =
    inner.type === "anonymous_function_creation_expression"
      ? inner
      : findFirst(inner, (n) => n.type === "anonymous_function_creation_expression");
  if (closure && inner.type !== "array_creation_expression") {
    return { node: closure, controller: null, method: null };
  }

  // [Controller::class, 'method'].
  if (inner.type === "array_creation_expression") {
    const elements = childrenOfType(inner, "array_element_initializer");
    const classAccess = elements
      .map((e) => e.namedChildren.find((c) => c.type === "class_constant_access_expression"))
      .find(Boolean);
    const methodString = elements
      .map((e) => e.namedChildren.find((c) => c.type === "string"))
      .find(Boolean);
    const controller = classAccess
      ? (childrenOfType(classAccess!, "name")[0]?.text ?? null)
      : null;
    const method = methodString ? phpStringText(methodString) : null;
    const cls = controller ? analysis.classes.get(controller) : null;
    const node = cls && method ? cls.methods.get(method) ?? null : null;
    if (node) return { node, controller, method };
    if (controller && method) {
      // Controller outside the scanned tree: return a synthetic marker.
      return { node: null as unknown as TsNode, controller, method };
    }
    return null;
  }

  // Invokable controller: Controller::class.
  if (inner.type === "class_constant_access_expression") {
    const controller = childrenOfType(inner, "name")[0]?.text ?? null;
    const cls = controller ? analysis.classes.get(controller) : null;
    const node = cls?.methods.get("__invoke") ?? null;
    if (node) return { node, controller, method: "__invoke" };
  }

  return null;
}

function collectParameters(
  handler: TsNode,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  verb: string,
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

  for (const param of formalParameters(handler)) {
    const variable = param.namedChildren.find((c) => c.type === "variable_name");
    const name = variable?.text.replace(/^\$/, "") ?? "";
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "named_type" ||
        c.type === "primitive_type" ||
        c.type === "optional_type",
    );
    if (!name || !typeNode || !variable) continue;
    const typeName =
      typeNode.type === "named_type"
        ? (typeNode.namedChildren.find((c) => c.type === "name")?.text ?? typeNode.text)
        : typeNode.type === "optional_type"
          ? (typeNode.namedChildren.find((c) => c.type === "named_type")?.namedChildren.find((x) => x.type === "name")?.text ?? "")
          : typeNode.text;
    const shortType = typeName.split("\\").pop()!;
    const cls = analysis.classes.get(shortType);

    // FormRequest subclass -> JSON request body from rules().
    if (cls && (cls.formRules.length || cls.extends?.endsWith("FormRequest"))) {
      const schema = cls.formRules.length
        ? formRulesToSchema(cls.formRules, model)
        : undefined;
      if (schema && Object.keys(schema.properties ?? {}).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema }],
          confidence: "high",
        };
        // Register the request as a component too, for references elsewhere.
      } else {
        gaps.push("body-schema-unknown");
      }
      continue;
    }

    // Generic Illuminate Request: inspect ->query()/->input()/->all().
    if (shortType === "Request") {
      collectRequestCalls(handler, variable.text, verb, addParam, gaps);
      continue;
    }

    // Route model binding: typed model parameter.
    if (cls && !cls.formRules.length) {
      const binding = camelBinding(name);
      addParam("path", binding, { type: "string" }, "high", true);
      continue;
    }

    // Scalar handler parameter: route binding if the path declares it.
    const scalarSchema = phpTypeToSchema(typeNode, model);
    if (pathParams.has(name)) {
      addParam("path", name, scalarSchema, "high", true);
    } else if (typeNode.type === "primitive_type" && shortType === "string") {
      // Unmatched scalar params are almost always route-bound in Laravel.
      addParam("path", name, scalarSchema, "medium", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}), gaps };
}

function camelBinding(variable: string): string {
  // Route binding key is the type-hinted variable name, e.g. $userProfile -> userProfile.
  return variable;
}

function collectRequestCalls(
  handler: TsNode,
  variableText: string,
  verb: string,
  addParam: (
    location: "query" | "header" | "path",
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required: boolean,
  ) => void,
  gaps: GapCode[],
): void {
  let seesAll = false;
  for (const call of findAll(handler, (n) => n.type === "member_call_expression")) {
    const receiver = call.namedChildren.find((c) => c.type === "variable_name");
    if (receiver?.text !== variableText) continue;
    const method = call.namedChildren.find((c) => c.type === "name")?.text;
    const args = call.namedChildren.find((c) => c.type === "arguments");
    const firstArg = args ? childrenOfType(args, "argument")[0] : null;
    const key = firstArg ? phpStringText(firstArg.namedChildren.find((c) => c.type === "string")) : null;
    if ((method === "query" || method === "boolean") && key) {
      addParam("query", key, method === "boolean" ? { type: "boolean" } : { type: "string" }, "high", false);
    } else if (method === "input" && key) {
      const location = ["post", "put", "patch"].includes(verb) ? "query" : "query";
      addParam(location, key, { type: "string" }, "medium", false);
    } else if (method === "all" || method === "validated" || method === "only") {
      seesAll = true;
    }
  }
  if (seesAll && ["post", "put", "patch"].includes(verb)) gaps.push("body-schema-unknown");
}

function collectResponses(handler: TsNode, model: PhpModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const returns = findAll(handler, (n) => n.type === "return_statement");
  const responses: DiscoveredResponse[] = [];

  for (const ret of returns) {
    const expression = ret.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "scoped_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "variable_name" ||
        c.type === "array_creation_expression",
    );
    if (!expression) continue;
    const response = interpretResponse(expression, model, gaps);
    if (response) responses.push(response);
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low", content: [{ mediaType: "application/json" }] }];
  }

  // Merge identical status codes, keeping the highest-confidence candidate.
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
  model: PhpModelIndex,
  gaps: GapCode[],
): DiscoveredResponse | null {
  // response()->json($data, 201)
  if (expression.type === "member_call_expression") {
    const method = expression.namedChildren.find((c) => c.type === "name")?.text;
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];

    if (method === "noContent" || method === "noContent") {
      const status = integerText(argNodes[0]) ?? "204";
      return { statusCode: status, description: "", confidence: "high" };
    }

    if (method === "stream" || method === "streamDownload") {
      const status = integerText(argNodes[1]) ?? "200";
      const headersArray = argNodes[2]?.namedChildren.find((c) => c.type === "array_creation_expression");
      const isSse = headersArray
        ? childrenOfType(headersArray, "array_element_initializer").some((element) => {
            const strings = childrenOfType(element, "string");
            return phpStringText(strings[0])?.toLowerCase() === "content-type" &&
              phpStringText(strings[1])?.includes("text/event-stream");
          })
        : false;
      if (isSse) {
        gaps.push("sse-events-unknown");
        return {
          statusCode: status,
          description: "Server-sent events",
          confidence: "medium",
          content: [{ mediaType: "text/event-stream" }],
        };
      }
      return { statusCode: status, description: "", confidence: "low" };
    }

    if (method === "json") {
      const status = integerText(argNodes[1]) ?? "200";
      const payload = argNodes[0];
      const schema = payload ? inferValueSchema(payload, model) : undefined;
      if (!schema || !Object.keys(schema).length) {
        gaps.push("response-schema-unknown");
        return {
          statusCode: status,
          description: "",
          confidence: "low",
          content: [{ mediaType: "application/json" }],
        };
      }
      return {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema }],
      };
    }

    // Chained Eloquent calls, e.g. User::where(...)->get().
    if (method && COLLECTION_METHODS.has(method.toLowerCase())) {
      const schema = inferChainedModel(expression, model);
      if (schema) {
        return {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema }],
        };
      }
    }
  }

  // User::all(), User::find($id), User::create(...).
  if (expression.type === "scoped_call_expression") {
    const schema = inferStaticModel(expression, model);
    if (schema) {
      return {
        statusCode: "200",
        description: "",
        confidence: "medium",
        content: [{ mediaType: "application/json", schema }],
      };
    }
  }

  // new User(...).
  if (expression.type === "object_creation_expression") {
    const name = expression.namedChildren.find((c) => c.type === "name")?.text;
    if (name && model.analysis.classes.has(name)) {
      const ref = ensurePhpComponent(name, model);
      if (ref) {
        return {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema: ref }],
        };
      }
    }
  }

  return null;
}

function inferValueSchema(node: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const inner = node.namedChildren[0] ?? node;

  if (inner.type === "scoped_call_expression") {
    return inferStaticModel(inner, model);
  }
  if (inner.type === "member_call_expression") {
    const method = inner.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    const chained = inferChainedModel(inner, model);
    if (chained) return chained;
    if (method === "paginate" || method === "simplepaginate") return { type: "object" };
  }
  if (inner.type === "object_creation_expression") {
    const name = inner.namedChildren.find((c) => c.type === "name")?.text;
    if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? {};
  }
  if (inner.type === "array_creation_expression") {
    // Associative arrays cannot be typed without analyzing values; emit an
    // object and let AI gap resolution fill properties.
    return { type: "object" };
  }
  if (inner.type === "variable_name") return undefined;
  return undefined;
}

function inferStaticModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const names = childrenOfType(call, "name");
  const modelName = names[0]?.text;
  const method = names[names.length - 1]?.text.toLowerCase();
  if (!modelName || !model.analysis.classes.has(modelName)) return undefined;
  const ref = ensurePhpComponent(modelName, model);
  if (!ref) return undefined;
  if (method && COLLECTION_METHODS.has(method)) return { type: "array", items: ref };
  if (method && ITEM_METHODS.has(method)) return ref;
  return ref;
}

function inferChainedModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const scoped = findFirst(call, (n) => n.type === "scoped_call_expression");
  if (!scoped) return undefined;
  const modelName = childrenOfType(scoped, "name")[0]?.text;
  if (!modelName || !model.analysis.classes.has(modelName)) return undefined;
  const ref = ensurePhpComponent(modelName, model);
  if (!ref) return undefined;
  const method = call.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
  return method && ITEM_METHODS.has(method) ? ref : { type: "array", items: ref };
}

function integerText(node: TsNode | undefined): string | null {
  if (!node) return null;
  const int = node.type === "integer" ? node : node.namedChildren.find((c) => c.type === "integer");
  return int?.text ?? null;
}

function parseResourceCall(
  args: TsNode[],
  fullResource: boolean,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  rel: string,
): RouteCandidate[] {
  const pathArg = args[0]?.namedChildren.find((c) => c.type === "string");
  const handlerArg = args[1];
  const basePath = normalizeRoute(phpStringText(pathArg) ?? "");
  const handler = resolveHandler(handlerArg, analysis);
  const controller = handler?.controller ?? resourceControllerName(handlerArg);
  const binding = singular(basePath.split("/").pop() ?? "resource");
  const itemPath = `${basePath}/{${binding}}`;

  const operations: { verb: string; path: string; method: string }[] = [
    { verb: "get", path: basePath, method: "index" },
    { verb: "post", path: basePath, method: "store" },
    { verb: "get", path: itemPath, method: "show" },
    { verb: "put", path: itemPath, method: "update" },
    { verb: "patch", path: itemPath, method: "update" },
    { verb: "delete", path: itemPath, method: "destroy" },
  ];
  if (fullResource) {
    operations.push(
      { verb: "get", path: `${basePath}/create`, method: "create" },
      { verb: "get", path: `${itemPath}/edit`, method: "edit" },
    );
  }

  return operations.map(({ verb, path, method }) => {
    const cls = controller ? analysis.classes.get(controller) : null;
    const methodNode = cls?.methods.get(method) ?? null;
    const gaps: GapCode[] = [];
    const parameters: RouteParameter[] = ["show", "update", "destroy"].includes(method)
      ? [{ name: binding, in: "path", required: true, schema: { type: "string" }, confidence: "medium" }]
      : [];
    const responses: DiscoveredResponse[] = methodNode
      ? collectResponses(methodNode, model, gaps)
      : [{ statusCode: "200", description: "", confidence: "low" }];
    if (!methodNode) gaps.push("response-unknown");

    return {
      method: verb,
      path,
      fullPath: path,
      ...(controller ? { operationId: `${controller}.${method}` } : {}),
      origin: { file: rel, line: 0 },
      parameters,
      responses,
      tags: [controller ? controller.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase()) : "resource"],
      confidence: methodNode ? ("medium" as Confidence) : ("low" as Confidence),
      gaps,
      components: [],
    } satisfies RouteCandidate;
  });
}

function resourceControllerName(handlerArg: TsNode | undefined): string | null {
  if (!handlerArg) return null;
  const access = findFirst(handlerArg, (n) => n.type === "class_constant_access_expression");
  return access ? childrenOfType(access, "name")[0]?.text ?? null : null;
}

function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function normalizeRoute(raw: string): string {
  let route = raw.trim();
  if (!route) return "/";
  if (!route.startsWith("/")) route = `/${route}`;
  // Optional Laravel params: /users/{id?} -> /users/{id}
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
      c.responses.length * 2 +
      c.parameters.length +
      (c.requestBody ? 2 : 0) -
      c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

function detectServers(ctx: ScanContext): DiscoveredServer[] {
  const urls = new Set<string>();
  // Laravel keeps APP_URL in the project root .env, which the indexer skips.
  const candidates = [".env", ".env.example", ".env.local"];
  for (const candidate of candidates) {
    const envPath = join(ctx.root, candidate);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf8");
      const match = /^APP_URL=(.+)$/m.exec(content);
      if (match) {
        const url = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (url && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(url)) {
          urls.add(url);
        }
      }
    } catch {
      // Unreadable env file; Laravel serves without a declared URL.
    }
  }
  return [...urls].map((url) => ({ url }));
}
