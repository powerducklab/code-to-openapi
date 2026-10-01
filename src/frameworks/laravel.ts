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
import { phpStringText, parseRulesMethod } from "../lang/php/index.js";
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
          const resource = parseResourceCall(
            args,
            name === "resource",
            analysis,
            model,
            rel,
            joinRoute(groupPrefixChain(call), ""),
          );
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
    if (current.type === "scoped_call_expression") {
      const method = routeCallName(current);
      if (method === "group" || method === "prefix") return current;
    }
    if (current.type === "member_call_expression") {
      // Route::prefix('v1')->middleware('api')->group(closure)
      const method = current.namedChildren.find((c) => c.type === "name")?.text;
      if (method === "group" || method === "prefix") return current;
    }
    current = current.parent ?? null;
  }
  return null;
}

function groupOptionsPrefix(groupCall: TsNode): string {
  // Chained form: Route::prefix('v1')->...->group(closure). Walk the receiver
  // chain outward collecting prefix() arguments in outer-to-inner order.
  const prefixes: string[] = [];
  let cursor: TsNode | null = groupCall;
  while (cursor) {
    let scoped: TsNode | null = null;
    if (cursor.type === "scoped_call_expression") {
      if (routeCallName(cursor) === "prefix") {
        const arg = callArguments(cursor)[0];
        const text = arg ? phpStringText(arg.type === "string" ? arg : arg.namedChildren.find((c) => c.type === "string")) : null;
        if (text) prefixes.unshift(normalizeRoute(text));
      }
      scoped = null;
    }
    if (cursor.type === "member_call_expression") {
      const method = cursor.namedChildren.find((c) => c.type === "name")?.text;
      if (method === "prefix") {
        const args = cursor.namedChildren.find((c) => c.type === "arguments");
        const arg = args ? childrenOfType(args, "argument")[0] : undefined;
        const text = arg ? phpStringText(arg.type === "string" ? arg : arg.namedChildren.find((c) => c.type === "string")) : null;
        if (text) prefixes.unshift(normalizeRoute(text));
      }
      scoped = cursor.namedChildren.find(
        (c) => c.type === "member_call_expression" || c.type === "scoped_call_expression",
      ) ?? null;
    }
    if (!scoped) break;
    cursor = scoped;
  }
  if (prefixes.length) return prefixes.join("");

  // Array form: Route::group(['prefix' => 'v1'], closure).
  const args = callArguments(groupCall);
  const options = args.find((a) => a.namedChildren.some((c) => c.type === "array_creation_expression"))
    ?.namedChildren.find((c) => c.type === "array_creation_expression");
  if (!options) return "";
  for (const element of childrenOfType(options, "array_element_initializer")) {
    const strings = childrenOfType(element, "string");
    if (phpStringText(strings[0]) === "prefix") {
      return normalizeRoute(phpStringText(strings[1]) ?? "");
    }
  }
  return "";
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

    // FormRequest subclass -> JSON or multipart request body from rules().
    if (cls && (cls.formRules.length || cls.extends?.endsWith("FormRequest"))) {
      const schema = cls.formRules.length
        ? formRulesToSchema(cls.formRules, model)
        : undefined;
      if (schema && Object.keys(schema.properties ?? {}).length) {
        const fileFields = fileFieldsFromRules(cls.formRules);
        const mediaType = fileFields.size ? "multipart/form-data" : "application/json";
        const ruleProperties = schema.properties as Record<string, JsonSchema> | undefined;
        for (const field of fileFields) {
          if (ruleProperties) ruleProperties[field] = { type: "string", format: "binary" };
        }
        requestBody = {
          required: true,
          content: [{ mediaType, schema }],
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
      const { bodyKeys, seesAll, inlineRules } = collectRequestCalls(
        handler,
        variable.text,
        verb,
        addParam,
        gaps,
      );
      const writesBody = ["post", "put", "patch"].includes(verb);
      if (writesBody && inlineRules && !requestBody) {
        const schema = formRulesToSchema(inlineRules, model);
        if (Object.keys(schema.properties ?? {}).length) {
          const fileFields = fileFieldsFromRules(inlineRules);
          const mediaType = fileFields.size ? "multipart/form-data" : "application/json";
          const ruleProperties = schema.properties as Record<string, JsonSchema> | undefined;
          for (const field of fileFields) {
            if (ruleProperties) ruleProperties[field] = { type: "string", format: "binary" };
          }
          requestBody = {
            required: true,
            content: [{ mediaType, schema }],
            confidence: "high",
          };
        }
      } else if (writesBody && bodyKeys.length && !requestBody) {
        const properties: Record<string, JsonSchema> = {};
        for (const key of bodyKeys) properties[key.name] = key.schema;
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema: { type: "object", properties } }],
          confidence: "medium",
        };
      } else if (writesBody && seesAll && !requestBody) {
        gaps.push("body-schema-unknown");
      }
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

/** Rule field names that carry an uploaded file (multipart, not JSON). */
function fileFieldsFromRules(rules: { name: string; rules: string }[]): Set<string> {
  const fields = new Set<string>();
  for (const rule of rules) {
    const field = rule.name.replace(/\.\*$/, "");
    const tokens = rule.rules.split("|").map((t) => t.trim().toLowerCase());
    if (
      tokens.some(
        (t) =>
          t === "file" ||
          t === "image" ||
          t.startsWith("mimes:") ||
          t.startsWith("mimetypes:") ||
          t.startsWith("dimensions:"),
      )
    ) {
      fields.add(field);
    }
  }
  return fields;
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
    location: "query" | "header" | "path" | "cookie",
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required: boolean,
  ) => void,
  gaps: GapCode[],
): { bodyKeys: { name: string; schema: JsonSchema }[]; seesAll: boolean; inlineRules: Parameters<typeof formRulesToSchema>[0] | null } {
  let seesAll = false;
  const bodyKeys: { name: string; schema: JsonSchema }[] = [];
  let inlineRules: Parameters<typeof formRulesToSchema>[0] | null = null;
  const writesBody = ["post", "put", "patch"].includes(verb);
  for (const call of findAll(handler, (n) => n.type === "member_call_expression")) {
    const receiver = call.namedChildren.find((c) => c.type === "variable_name");
    if (receiver?.text !== variableText) continue;
    const method = call.namedChildren.find((c) => c.type === "name")?.text;
    const args = call.namedChildren.find((c) => c.type === "arguments");
    const firstArg = args ? childrenOfType(args, "argument")[0] ?? null : null;
    const key = firstArg ? phpStringText(firstArg.namedChildren.find((c) => c.type === "string")) : null;
    if (writesBody && method === "validate") {
      const rules = parseRulesMethod(call);
      if (rules.length) inlineRules = rules;
      continue;
    }
    if ((method === "query" || method === "boolean") && key) {
      addParam("query", key, method === "boolean" ? { type: "boolean" } : { type: "string" }, "high", false);
    } else if (method === "header" && key) {
      addParam("header", key, { type: "string" }, "high", false);
    } else if (method === "cookie" && key) {
      addParam("cookie", key, { type: "string" }, "high", false);
    } else if ((method === "input" || method === "get" || method === "post" || method === "json") && key) {
      if (writesBody) {
        bodyKeys.push({ name: key, schema: { type: "string" } });
      } else {
        addParam("query", key, { type: "string" }, "medium", false);
      }
    } else if (method === "only") {
      // $request->only('a', 'b'): explicit key list usable on either side.
      const keyArgs = args ? childrenOfType(args, "argument") : [];
      for (const arg of keyArgs) {
        const literal = arg.type === "string" ? arg : arg.namedChildren.find((c) => c.type === "string");
        const text = literal ? phpStringText(literal) : null;
        if (!text) continue;
        if (writesBody) bodyKeys.push({ name: text, schema: { type: "string" } });
        else addParam("query", text, { type: "string" }, "medium", false);
      }
    } else if (method === "all" || method === "validated") {
      seesAll = true;
    }
  }
  return { bodyKeys, seesAll, inlineRules };
}

function collectResponses(handler: TsNode, model: PhpModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const returns = findAll(handler, (n) => n.type === "return_statement");
  const responses: DiscoveredResponse[] = [];

  for (const ret of returns) {
    const expression = ret.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "scoped_call_expression" ||
        c.type === "function_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "variable_name" ||
        c.type === "array_creation_expression",
    );
    if (!expression) continue;
    let response = interpretResponse(expression, model, gaps, handler);
    if (!response && expression.type === "variable_name") {
      const schema = inferVariableModel(handler, expression, model);
      if (schema) {
        response = {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema }],
        };
      }
    }
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
  handler: TsNode,
): DiscoveredResponse | null {
  // response()->json($data, 201)
  if (expression.type === "member_call_expression") {
    // (new ProductResource($model))->response()->setStatusCode(201)
    const chained = chainedResourceResponse(expression, model);
    if (chained) {
      return {
        statusCode: chained.statusCode,
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema: chained.schema }],
      };
    }

    const method = expression.namedChildren.find((c) => c.type === "name")?.text;
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];

    if (method === "noContent" || method === "noContent") {
      const status = integerText(argNodes[0]) ?? "204";
      return { statusCode: status, description: "", confidence: "high" };
    }

    if (method === "redirect" || method === "redirectRoute" || method === "redirectGuest") {
      const status = integerText(argNodes[1]) ?? "302";
      return { statusCode: status, description: "", confidence: "high" };
    }

    if (method === "download") {
      const status = integerText(argNodes[2]) ?? "200";
      return {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [
          { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
        ],
      };
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
          content: [{ mediaType: "text/event-stream", itemSchema: {} }],
        };
      }
      if (method === "streamDownload") {
        return {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [
            { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
          ],
        };
      }
      return { statusCode: status, description: "", confidence: "low" };
    }

    if (method === "json") {
      const status = integerText(argNodes[1]) ?? "200";
      const payload = argNodes[0];
      const schema = payload ? inferValueSchema(payload, model, handler) : undefined;
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

  // Global helper redirect('/path', 301).
  if (expression.type === "function_call_expression") {
    const fnName = expression.namedChildren.find((c) => c.type === "name")?.text;
    if (fnName === "redirect") {
      const args = expression.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      const status = integerText(argNodes[1]) ?? "302";
      return { statusCode: status, description: "", confidence: "high" };
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

function inferVariableModel(
  handler: TsNode,
  variable: TsNode,
  model: PhpModelIndex,
): JsonSchema | undefined {
  const varText = variable.text;
  // $x = Model::findOrFail(...) / Model::where(...)->first() / new Model().
  for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
    if (lhs?.text !== varText) continue;
    const scoped = findFirst(assignment, (c) => c.type === "scoped_call_expression");
    if (scoped) {
      const schema = inferStaticModel(scoped, model);
      if (schema) return schema;
    }
    const creation = findFirst(assignment, (c) => c.type === "object_creation_expression");
    if (creation) {
      const name = creation.namedChildren.find((c) => c.type === "name")?.text;
      if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? undefined;
    }
    // $path = $request->file('image')->store('products') — uploaded file paths.
    const memberCall = findFirst(assignment, (c) => c.type === "member_call_expression");
    if (memberCall) {
      const callMethod = memberCall.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
      if (callMethod && ["store", "storeas", "path", "url", "getclientoriginalname"].includes(callMethod)) {
        return { type: "string" };
      }
      if (["input", "query", "get", "post", "json", "route"].includes(callMethod ?? "")) {
        return { type: "string" };
      }
      if (callMethod === "boolean" || callMethod === "has") return { type: "boolean" };
      if (callMethod === "integer") return { type: "integer" };
    }
  }
  // Typed model parameter, e.g. function update(Order $order).
  for (const param of formalParameters(handler)) {
    const paramVar = param.namedChildren.find((c) => c.type === "variable_name");
    if (paramVar?.text !== varText) continue;
    const typeName = param.namedChildren
      .find((c) => c.type === "named_type")
      ?.namedChildren.find((c) => c.type === "name")?.text;
    if (typeName && model.analysis.classes.has(typeName)) {
      return ensurePhpComponent(typeName, model) ?? undefined;
    }
  }
  return undefined;
}

function inferValueSchema(node: TsNode, model: PhpModelIndex, handler?: TsNode): JsonSchema | undefined {
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
    return inferArraySchema(inner, model, handler);
  }
  if (inner.type === "variable_name" && handler) {
    return inferVariableModel(handler, inner, model);
  }
  return undefined;
}

/**
 * Resolve a response()->json([...]) payload table. Keyed arrays become objects
 * with per-value inference; positional homogeneous arrays become array schemas.
 */
function inferArraySchema(
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
  // split by child count rather than by node type (otherwise literal string
  // values were mistaken for keys and the property silently dropped).
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
    if (schema && Object.keys(schema).length) properties[key] = schema;
  }
  return { type: "object", properties };
}

function inferArrayValue(
  node: TsNode | undefined,
  model: PhpModelIndex,
  handler: TsNode | undefined,
  depth: number,
): JsonSchema | undefined {
  if (!node) return undefined;
  if (node.type === "string") return { type: "string" };
  if (node.type === "integer") return { type: "integer" };
  if (node.type === "float") return { type: "number" };
  if (node.type === "boolean" || node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "null") return { type: "null" };
  if (node.type === "array_creation_expression") return inferArraySchema(node, model, handler, depth);
  if (node.type === "object_creation_expression") {
    const name = node.namedChildren.find((c) => c.type === "name")?.text;
    if (name && model.analysis.classes.has(name)) return ensurePhpComponent(name, model) ?? {};
  }
  if (node.type === "scoped_call_expression") return inferStaticModel(node, model);
  if (node.type === "member_call_expression") {
    const method = node.namedChildren.find((c) => c.type === "name")?.text;
    // $request->input/query/get/post('key') and $request->file('x')->store(...)
    const receiver = node.namedChildren.find((c) => c.type === "variable_name");
    if (receiver?.text === "$request" || receiver?.text === "$this->request") {
      if (["input", "query", "get", "post", "json", "route"].includes(method ?? "")) {
        return { type: "string" };
      }
      if (method === "boolean" || method === "has") return { type: "boolean" };
      if (method === "integer") return { type: "integer" };
      if (method === "store" || method === "storeAs" || method === "path") return { type: "string" };
    }
    if (method === "store" || method === "storeAs" || method === "url" || method === "path") {
      return { type: "string" };
    }
    const chained = inferChainedModel(node, model);
    if (chained) return chained;
  }
  if (node.type === "member_access_expression") {
    const prop = node.namedChildren.filter((c) => c.type === "name").pop()?.text ?? "";
    return heuristicPropertySchema(prop);
  }
  if (node.type === "variable_name" && handler) {
    return inferVariableModel(handler, node, model);
  }
  return undefined;
}

/** Conservative scalar inference for common Laravel property names. */
function heuristicPropertySchema(prop: string): JsonSchema {
  if (/^(id|.*_id)$/.test(prop) || /(count|total|quantity|size|age)$/.test(prop)) {
    return { type: "integer" };
  }
  if (/^(is_|has_|should_)/.test(prop) || /^(active|enabled|deleted|archived)$/.test(prop)) {
    return { type: "boolean" };
  }
  if (/(price|amount|cost|fee|balance|total)$/.test(prop)) return { type: "number" };
  if (/(url|uri|path|link|href)$/.test(prop)) return { type: "string", format: "uri" };
  if (/(at)$/.test(prop)) return { type: "string", format: "date-time" };
  if (/(name|title|sku|slug|email|phone|token|key|status|type|description|caption|filename|file_name)$/.test(prop)) {
    return { type: "string" };
  }
  return {};
}

/**
 * Detect `(new XResource($model))->response()->setStatusCode(201)` chains and
 * return the resource component reference plus the declared status code.
 */
function chainedResourceResponse(
  expression: TsNode,
  model: PhpModelIndex,
): { statusCode: string; schema: JsonSchema } | null {
  let statusCode = "200";
  let cursor: TsNode | null = expression;
  let sawResponse = false;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    if (cursor.type === "member_call_expression") {
      const method = cursor.namedChildren.find((c) => c.type === "name")?.text;
      if (method === "setStatusCode") {
        const args = cursor.namedChildren.find((c) => c.type === "arguments");
        const first = args ? childrenOfType(args, "argument")[0] : undefined;
        const code = integerText(first);
        if (code) statusCode = code;
      }
      if (method === "response") sawResponse = true;
      let next: TsNode | null =
        cursor.namedChildren.find(
          (c) =>
            c.type === "member_call_expression" ||
            c.type === "object_creation_expression" ||
            c.type === "parenthesized_expression",
        ) ?? null;
      if (next?.type === "parenthesized_expression") {
        next = next.namedChildren[0] ?? null;
      }
      cursor = next;
      continue;
    }
    if (cursor.type === "object_creation_expression") {
      const name = cursor.namedChildren.find((c) => c.type === "name")?.text;
      if (name && /Resource$/.test(name) && model.analysis.classes.has(name)) {
        const ref = ensurePhpComponent(name, model);
        if (ref) return { statusCode: sawResponse || statusCode !== "200" ? statusCode : "201", schema: ref };
      }
      return null;
    }
    break;
  }
  return null;
}

function inferStaticModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const names = childrenOfType(call, "name");
  const qualified = call.namedChildren.find((c) => c.type === "qualified_name");
  // Qualified calls (\App\Models\Order::all) carry a qualified_name scope.
  const method = names[names.length - 1]?.text.toLowerCase();
  const modelName = qualified
    ? qualified.text.split("\\").filter(Boolean).pop()
    : names.length >= 2
      ? names[names.length - 2]?.text
      : undefined;
  if (!modelName || !model.analysis.classes.has(modelName)) return undefined;
  // Query-builder aggregates return scalars, not model instances.
  if (method === "count" || method === "exists") return { type: method === "exists" ? "boolean" : "integer" };
  if (method === "sum" || method === "avg" || method === "average" || method === "max" || method === "min") {
    return { type: "number" };
  }
  const ref = ensurePhpComponent(modelName, model);
  if (!ref) return undefined;
  if (method && COLLECTION_METHODS.has(method)) return { type: "array", items: ref };
  if (method && ITEM_METHODS.has(method)) return ref;
  return ref;
}

function inferChainedModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  const scoped = findFirst(call, (n) => n.type === "scoped_call_expression");
  if (!scoped) return undefined;
  const qualified = scoped.namedChildren.find((c) => c.type === "qualified_name");
  const names = childrenOfType(scoped, "name");
  const modelName = qualified
    ? qualified.text.split("\\").filter(Boolean).pop()
    : names[0]?.text;
  if (!modelName || !model.analysis.classes.has(modelName)) return undefined;
  const ref = ensurePhpComponent(modelName, model);
  if (!ref) return undefined;
  const method = call.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
  if (method === "count" || method === "exists") {
    return { type: method === "exists" ? "boolean" : "integer" };
  }
  if (method === "sum" || method === "avg" || method === "average" || method === "max" || method === "min") {
    return { type: "number" };
  }
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
  groupPrefix: string,
): RouteCandidate[] {
  const pathArg = args[0]?.namedChildren.find((c) => c.type === "string");
  const handlerArg = args[1];
  const basePath = joinRoute(groupPrefix, normalizeRoute(phpStringText(pathArg) ?? ""));
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
    // update() serves both PUT and PATCH; keep operationIds unique and explicit.
    const operationId =
      controller && method === "update"
        ? `${controller}.update_${verb.toUpperCase()}`
        : controller
          ? `${controller}.${method}`
          : null;
    const declaredPathParams = new Set(
      [...path.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!),
    );
    const collected = methodNode
      ? collectParameters(methodNode, analysis, model, verb, declaredPathParams)
      : { parameters: [], requestBody: undefined, gaps: [] as GapCode[] };
    const parameters = collected.parameters;
    if (methodNode && ["show", "update", "destroy"].includes(method) &&
        !parameters.some((p) => p.in === "path" && p.name === binding)) {
      parameters.push({ name: binding, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
    }
    gaps.push(...collected.gaps);
    const responses: DiscoveredResponse[] = methodNode
      ? collectResponses(methodNode, model, gaps)
      : [{ statusCode: "200", description: "", confidence: "low" }];
    if (!methodNode) gaps.push("response-unknown");

    return {
      method: verb,
      path,
      fullPath: path,
      ...(operationId ? { operationId } : {}),
      origin: { file: rel, line: 0 },
      parameters,
      ...(collected.requestBody ? { requestBody: collected.requestBody } : {}),
      responses,
      tags: [controller ? controller.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase()) : "resource"],
      ...(responses.some((r) =>
        r.content?.some((media) => media.mediaType === "text/event-stream"),
      )
        ? { extensions: { "x-protocol": "sse" } }
        : {}),
      confidence: methodNode ? ("medium" as Confidence) : ("low" as Confidence),
      gaps,
      components: [],
      handlerSource: methodNode?.text.slice(0, 8192),
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
        if (url && /^https?:\/\/\S+$/.test(url)) {
          urls.add(url.replace(/\/+$/, ""));
        }
      }
    } catch {
      // Unreadable env file; Laravel serves without a declared URL.
    }
  }
  return [...urls].map((url) => ({ url }));
}
