import { belongsToPhpFunction } from "../lang/php/scope.js";
import {mergeResponseVariants} from "../core/response-variants.js";
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
import { phpStringText, parseRulesMethod, resolvePhpClass, findPhpMethod } from "../lang/php/index.js";
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

import { declaredPhpPropertySchema } from "../lang/php/response.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
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
          const { only, except } = resourceModifiers(call);
          const resource = parseResourceCall(
            args,
            name === "resource",
            analysis,
            model,
            rel,
            joinRoute(groupPrefixChain(call), ""),
            only,
            except,
          );
          candidates.push(...resource);
          continue;
        }
        if (name !== "group" && name !== "prefix") {
          if (!VERBS.has(name) && name !== "any" && name !== "match") continue;
          const prefix = groupPrefixChain(call);
          const verbs = name === "any" ? ["get", "head", "post", "put", "patch", "delete", "options"] : expandMatchVerbs(name, args);
          if (!verbs.length) {
            unresolved.push({reason: "dynamic-methods", message: "Cannot statically resolve Laravel Route::match HTTP methods", origin: {file: rel, line: call.startPosition.row + 1}});
          }
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

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
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
  if (!array) return [];
  const verbs = childrenOfType(array, "array_element_initializer")
    .map(element => element.namedChildren.find(child => child.type === "string"))
    .map((s) => phpStringText(s)?.toLowerCase() ?? "")
    .filter((v) => VERBS.has(v));
  return [...new Set(verbs)];
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

  let handler = resolveHandler(handlerArg, analysis, analysis.files.get(rel)?.imports);
  if (!handler) {
    // Route::controller(C::class)->prefix('x')->group(function () {
    //     Route::get('path', 'someMethod');   // bare string handler
    // });
    // The controller comes from the enclosing ->controller(...) chain.
    const inherited = resolveInheritedController(call, analysis, rel);
    if (inherited && handlerArg) {
      const methodName = phpStringText(
        handlerArg.type === "string" ? handlerArg : handlerArg.namedChildren.find((c) => c.type === "string"),
      );
      const cls = analysis.classes.get(inherited);
      const node = methodName && cls ? cls.methods.get(methodName) ?? null : null;
      if (node) handler = { node, controller: inherited, method: methodName };
    }
  }
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
  routeImports?: Map<string, string>,
): ResolvedHandler | null {
  if (!handlerArg) return null;
  const inner = handlerArg.namedChildren[0] ?? handlerArg;

  // Resolve a use-alias to the short name of the declared class, e.g.
  // `use ...\EnrollController as EnrollTwoFactorController` maps the route
  // reference back to "EnrollController" as indexed. Namespaced references such
  // as `Api\OrderController` (after `use App\Http\Controllers\Api;`) are resolved
  // by mapping the first segment through the import table.
  const resolveClassName = (raw: string | null): string | null => {
    if (!raw) return null;
    const cls = resolvePhpClass(raw, analysis, handlerArg);
    if (!cls) return raw;
    return analysis.classes.get(cls.name) === cls ? cls.name : cls.fqcn;
  };

  // Read the class reference from a ::class constant access, excluding the
  // literal "class" keyword token that tree-sitter also exposes as a name.
  const classRefName = (access: TsNode): string | null => {
    const qualified = access.namedChildren.find((c) => c.type === "qualified_name");
    if (qualified) return qualified.text;
    const names = childrenOfType(access, "name").filter((n) => n.text !== "class");
    return names[names.length - 1]?.text ?? null;
  };

  // Closure (traditional closure or arrow function).
  const closure =
    inner.type === "anonymous_function_creation_expression"
      ? inner
      : inner.type === "arrow_function"
        ? inner
        : findFirst(
            inner,
            (n) =>
              n.type === "anonymous_function_creation_expression" ||
              n.type === "arrow_function",
          );
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
    const controllerRaw = classAccess ? classRefName(classAccess) : null;
    const controller = resolveClassName(controllerRaw);
    const method = methodString ? phpStringText(methodString) : null;
    const cls = controller ? analysis.classes.get(controller) : null;
    const node = cls && method ? findPhpMethod(cls, method, analysis) ?? null : null;
    if (node) return { node, controller, method };
    if (controller && method) {
      // Controller outside the scanned tree: return a synthetic marker.
      return { node: null as unknown as TsNode, controller, method };
    }
    return null;
  }

  // Invokable controller: Controller::class.
  if (inner.type === "class_constant_access_expression") {
    const controllerRaw = classRefName(inner);
    const controller = resolveClassName(controllerRaw);
    const cls = controller ? analysis.classes.get(controller) : null;
    const node = cls ? findPhpMethod(cls, "__invoke", analysis) ?? null : null;
    if (node) return { node, controller, method: "__invoke" };
  }

  return null;
}

/**
 * Resolve the controller class introduced by an enclosing
 * `Route::controller(C::class)->prefix(...)->group(closure)` chain, so that
 * inner routes registered with a bare string handler (`Route::get('p', 'method')`)
 * resolve to the right controller. Returns null when no such chain exists.
 */
function resolveInheritedController(
  call: TsNode,
  analysis: PhpAnalysis,
  rel: string,
): string | null {
  let closure: TsNode | null = null;
  let cur: TsNode | null = call.parent ?? null;
  while (cur) {
    if (cur.type === "anonymous_function_creation_expression" || cur.type === "closure_expression") {
      closure = cur;
      break;
    }
    cur = cur.parent ?? null;
  }
  if (!closure) return null;
  const groupCall = findEnclosingGroupCall(closure);
  if (!groupCall) return null;

  let cursor: TsNode | null = groupCall;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    if (cursor.type === "scoped_call_expression") {
      const names = childrenOfType(cursor, "name");
      const scope = names[names.length - 2]?.text;
      const method = names[names.length - 1]?.text;
      if (scope === "Route" && method === "controller") {
        const args = callArguments(cursor);
        const first = args[0];
        const inner = first ? first.namedChildren[0] ?? first : null;
        const acc =
          inner?.type === "class_constant_access_expression"
            ? inner
            : findFirst(inner, (n) => n.type === "class_constant_access_expression");
        const short = acc ? childrenOfType(acc, "name")[0]?.text : null;
        if (short) {
          const imports = analysis.files.get(rel)?.imports;
          const declared = imports?.get(short)?.split("\\").pop() ?? short;
          return analysis.classes.has(declared) ? declared : short;
        }
      }
      return null;
    }
    if (cursor.type === "member_call_expression") {
      cursor =
        cursor.namedChildren.find(
          (c) => c.type === "member_call_expression" || c.type === "scoped_call_expression",
        ) ?? null;
      continue;
    }
    break;
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
    const cls = resolvePhpClass(typeName, analysis, typeNode);

    // FormRequest subclass -> JSON or multipart request body from rules().
    const rulesMethod = cls ? findPhpMethod(cls, 'rules', analysis) : undefined;
    if (cls && (rulesMethod || cls.extends?.endsWith("FormRequest"))) {
      const rules = rulesMethod ? parseRulesMethod(rulesMethod) : cls.formRules;
      const schema = rules.length
        ? formRulesToSchema(rules, model)
        : undefined;
      if (schema && Object.keys(schema.properties ?? {}).length) {
        if (verb === 'get' || verb === 'head') {
          for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
            addParam('query', field, fieldSchema as JsonSchema, 'medium', Array.isArray(schema.required) && schema.required.includes(field));
          }
          continue;
        }
        const fileFields = fileFieldsFromRules(rules);
        const mediaType = fileFields.size ? "multipart/form-data" : "application/json";
        const ruleProperties = schema.properties as Record<string, JsonSchema> | undefined;
        for (const field of fileFields) {
          if (ruleProperties) ruleProperties[field] = { type: "string", format: "binary" };
        }
        requestBody = {
          required: Array.isArray(schema.required) && schema.required.length > 0,
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

    // Route model binding: a typed parameter is bound to a route segment only
    // when its variable name corresponds to a declared path parameter. Any
    // other typed parameter (repository / service / contract injected by the
    // container) is skipped rather than emitted as a phantom path parameter.
    if (cls && !cls.formRules.length) {
      const snakeName = toSnakeCase(name);
      const matched = [...pathParams].find((p) => p === name || toSnakeCase(p) === snakeName);
      if (matched) {
        addParam("path", matched, { type: "string" }, "high", true);
      }
      continue;
    }

    // Scalar handler parameter: bind it to a path segment only when its name
    // matches the route template. Never speculate that an unmatched scalar param
    // is route-bound — that emits phantom path parameters absent from the path.
    if (pathParams.has(name)) {
      addParam("path", name, { type: "string" }, "high", true);
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

/** Convert a camelCase variable to snake_case, matching Laravel route wildcards. */
function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
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
  // Arrow functions use an expression body without a return statement, e.g.
  // Route::get('ping', fn () => null) or fn () => response()->json(...).
  if (handler.type === "arrow_function") {
    const body = handler.namedChildren[handler.namedChildren.length - 1];
    if (body) {
      if (body.type === "null") {
        return [{ statusCode: "200", description: "", confidence: "medium" }];
      }
      const direct = interpretResponse(body, model, gaps, handler);
      if (direct) return [direct];
    }
  }

  const returns = findAll(handler, (n) => n.type === "return_statement" && belongsToPhpFunction(n, handler));
  const responses: DiscoveredResponse[] = [];
  const factoryVisited = new Set<TsNode>();

  // Resolve every response-producing expression a return can yield, including
  // ternary branches (`return $ok ? Resource::make($x) : response()->noContent()`).
  const candidateExpressions = (ret: TsNode): TsNode[] => {
    const direct = ret.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "scoped_call_expression" ||
        c.type === "function_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "variable_name" ||
        c.type === "array_creation_expression",
    );
    if (direct) return [direct];
    const conditional = ret.namedChildren.find((c) => c.type === "conditional_expression");
    if (conditional) {
      return conditional.namedChildren.filter(
        (c) =>
          c.type === "member_call_expression" ||
          c.type === "scoped_call_expression" ||
          c.type === "function_call_expression" ||
          c.type === "object_creation_expression" ||
          c.type === "variable_name" ||
          c.type === "array_creation_expression",
      );
    }
    // `return match ($x) { ... arm => response(), ... }`: collect each arm body.
    const match = ret.namedChildren.find((c) => c.type === "match_expression");
    if (match) {
      const armBodies: TsNode[] = [];
      for (const arm of findAll(match, (n) => n.type === "match_conditional_expression")) {
        const body = arm.namedChildren[arm.namedChildren.length - 1];
        if (
          body &&
          (body.type === "member_call_expression" ||
            body.type === "scoped_call_expression" ||
            body.type === "function_call_expression" ||
            body.type === "object_creation_expression" ||
            body.type === "variable_name" ||
            body.type === "array_creation_expression")
        ) {
          armBodies.push(body);
        }
      }
      return armBodies;
    }
    return [];
  };

  for (const ret of returns) {
    const rawNull = ret.namedChildren.find((c) => c.type === "null");
    const expressions = candidateExpressions(ret);
    if (!expressions.length && rawNull) {
      responses.push({ statusCode: "200", description: "", confidence: "medium" });
      continue;
    }
    for (const expression of expressions) {
      let response = interpretResponse(expression, model, gaps, handler, factoryVisited);
      if (!response && expression.type === "variable_name") {
        // $r = new StreamedResponse(...); ... return $r; — interpret the
        // response-producing assignment RHS before the generic value inference.
        const assigned = interpretAssignment(handler, expression, model, gaps);
        if (assigned) {
          responses.push(assigned);
          continue;
        }
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
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low", content: [{ mediaType: "application/json" }] }];
  }

  // Preserve all observed response branches sharing a status code.
  const merged = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = merged.get(response.statusCode);
    merged.set(response.statusCode, existing ? mergeResponseVariants(existing, response) : response);
  }
  return [...merged.values()];
}

function interpretResponse(
  expression: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
  handler: TsNode,
  factoryVisited: Set<TsNode> = new Set(),
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

    // SongResource::make($model)->for($user) and similar resource factory
    // chains (additional()/withResponse()/...): the resource is the payload.
    const staticResource = chainedStaticResource(expression, model);
    if (staticResource) {
      return {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema: staticResource }],
      };
    }

    const method = expression.namedChildren.find((c) => c.type === "name")?.text;
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];

    // Decorator chains such as response()->noContent()->header(...) or
    // response()->json($data)->setStatusCode(201): locate the terminal call
    // that actually describes the response and interpret that instead.
    const TERMINAL_RESPONSE_METHODS = new Set([
      "json",
      "nocontent",
      "redirect",
      "redirectroute",
      "redirectguest",
      "download",
      "stream",
      "streamdownload",
      "file",
      "make",
    ]);
    if (method && !TERMINAL_RESPONSE_METHODS.has(method.toLowerCase())) {
      const terminal = findFirst(
        expression,
        (n) =>
          n !== expression &&
          n.type === "member_call_expression" &&
          TERMINAL_RESPONSE_METHODS.has(
            (n.namedChildren.find((c) => c.type === "name")?.text ?? "").toLowerCase(),
          ),
      );
      if (terminal) {
        const inner = interpretResponse(terminal, model, gaps, handler);
        if (inner) return inner;
      }
      // redirect('/')->with('key', $value) or redirect()->away($url): the
      // redirect helper is the terminal response even though with()/away()
      // are the outer member calls.
      const redirectRoot = findFirst(
        expression,
        (n) =>
          n.type === "function_call_expression" &&
          n.namedChildren.find((c) => c.type === "name")?.text === "redirect",
      );
      if (redirectRoot) {
        return { statusCode: "302", description: "", confidence: "high" };
      }
      // view('page')->with('k', $v): a view chain renders an HTML document.
      const viewRoot = findFirst(
        expression,
        (n) =>
          n.type === "function_call_expression" &&
          n.namedChildren.find((c) => c.type === "name")?.text === "view",
      );
      if (viewRoot) {
        return {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "text/html", schema: { type: "string" } }],
        };
      }
    }

    if (method === "noContent") {
      const status = responseStatus(argNodes[0], "204", gaps);
      return { statusCode: status, description: "", confidence: "high" };
    }

    if (method === "redirect" || method === "redirectRoute" || method === "redirectGuest") {
      const status = responseStatus(argNodes[1], "302", gaps);
      return { statusCode: status, description: "", confidence: "high" };
    }

    // Base-class response helpers such as $this->respondDownload($path): resolve
    // the helper on the enclosing controller (and its parent chain) and follow
    // the response its return statement builds.
    const receiverVar = expression.namedChildren.find((c) => c.type === "variable_name");
    if (receiverVar?.text === "$this" && method && /^respond[A-Z]/.test(method)) {
      const helper = resolveControllerHelper(method, model, gaps, handler, factoryVisited);
      if (helper) return helper;
    }

    const downloadLike = downloadLikeResponse(method ?? "", argNodes, gaps);
    if (downloadLike) return downloadLike;

    if (method === "json") {
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
      const payload = argNodes[0];
      if (!payload) {
        // response()->json() with no data is an intentionally empty success body.
        return {
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: {} }],
        };
      }
      const schema = inferValueSchema(payload, model, handler);
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

    // (new SomeTransformer)->transformRow($model): a controller returns the array
    // a transformer builds directly. Follow the callee method to its return array.
    {
      let receiver: TsNode | undefined = expression.namedChildren[0];
      while (receiver && receiver.type === "parenthesized_expression") {
        receiver = receiver.namedChildren[0];
      }
      if (receiver?.type === "object_creation_expression") {
        const schema = followCallToSchema(expression, model, new Set<string>());
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
  }

  // Global helper redirect('/path', 301).
  if (expression.type === "function_call_expression") {
    const fnName = expression.namedChildren.find((c) => c.type === "name")?.text;
    if (fnName === "redirect") {
      const args = expression.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      const status = responseStatus(argNodes[1], "302", gaps);
      return { statusCode: status, description: "", confidence: "high" };
    }
    // view('page') renders an HTML document.
    if (fnName === "view") {
      return {
        statusCode: "200",
        description: "",
        confidence: "medium",
        content: [
          { mediaType: "text/html", schema: { type: "string" } },
        ],
      };
    }
  }

  // Bare array/table return (Laravel serializes it as JSON).
  if (expression.type === "array_creation_expression") {
    const schema = inferArraySchema(expression, model, handler);
    if (schema && Object.keys(schema).length) {
      return {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema }],
      };
    }
  }

  // User::all(), User::find($id), User::create(...).
  if (expression.type === "scoped_call_expression") {
    // Illuminate\Support\Facades\Response::download/streamDownload/make/file/...
    const facade = facadeResponse(expression, gaps);
    if (facade) return facade;

    // self::/static:: factory methods on the enclosing controller class.
    const selfFactory = resolveSelfFactory(expression, model, gaps, handler, factoryVisited);
    if (selfFactory) return selfFactory;

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
    const nameNode = expression.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    const name = nameNode?.text.split("\\").pop();
    // new StreamedResponse(closure, $status, $headers) / new BinaryFileResponse($path, $status, ...)
    if (name === "StreamedResponse" || name === "BinaryFileResponse") {
      const args = expression.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      return binaryResponse(responseStatus(argNodes[1], "200", gaps));
    }
    // new JsonResponse([...], $status, $headers) — Illuminate/Symfony JSON response
    // built directly rather than via the response()->json() helper.
    if (name === "JsonResponse") {
      const args = expression.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
      const payload = argNodes[0];
      if (!payload) {
        return {
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: {} }],
        };
      }
      const schema = inferValueSchema(payload, model, handler);
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

/**
 * When a controller returns a bare variable (`return $response;`), check whether
 * that variable was assigned a response-producing expression (e.g.
 * `$response = new StreamedResponse(...)` or `$response = response()->download(...)`).
 * Returns the interpreted response, or null when the assignment is not a
 * response factory (callers then fall back to generic value inference).
 */
function interpretAssignment(
  handler: TsNode,
  variable: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
): DiscoveredResponse | null {
  const varText = variable.text;
  for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
    if (lhs?.text !== varText) continue;
    const rhs = assignment.namedChildren.find(
      (c) =>
        c !== lhs &&
        (c.type === "member_call_expression" ||
          c.type === "scoped_call_expression" ||
          c.type === "object_creation_expression" ||
          c.type === "function_call_expression"),
    );
    if (!rhs) continue;
    const resolved = interpretResponse(rhs, model, gaps, handler);
    if (resolved) return resolved;
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

  // apply_filters(Filter::X, [ ... ]) — unwrap a wrapper helper around a literal
  // array payload and infer the array itself.
  if (inner.type === "function_call_expression") {
    const args = inner.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];
    const arrayArg = argNodes
      .map((a) => a.namedChildren[0] ?? a)
      .find((c) => c.type === "array_creation_expression");
    if (arrayArg) return inferArraySchema(arrayArg, model, handler);
  }

  if (inner.type === "scoped_call_expression") {
    // Helper::formatStandardApiResponse(...) / Other::transform(...): follow the
    // callee to the array it returns when it is statically knowable.
    const followed = followCallToSchema(inner, model, new Set());
    if (followed) return followed;
    return inferStaticModel(inner, model);
  }
  if (inner.type === "member_call_expression") {
    // (new OrderItemsTransformer)->transformRows(...) passed straight to
    // response()->json(): follow the transformer to the array it returns.
    const followed = followCallToSchema(inner, model, new Set());
    if (followed) return followed;
    const method = inner.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
    const chained = inferChainedModel(inner, model);
    if (chained) return chained;
    if (method === "paginate" || method === "simplepaginate") return { type: "object" };
    // $dto->toArray() / ->toArrayWithoutApiKey() always yields a JSON object.
    if (method === "toarray" || method?.startsWith("toarray")) return { type: "object" };
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
    // An empty-object schema means "any type, not statically known": the key
    // itself is certain, so keep the property instead of silently dropping it.
    if (schema) properties[key] = schema;
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
  if (node.type === "scoped_call_expression") return inferStaticModel(node, model) ?? {};
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

/**
 * Resolve `self::factoryMethod(...)` / `static::factoryMethod(...)` calls by
 * interpreting the return statements of the named static method on the class
 * enclosing the handler. Used for private response-shaping helpers such as
 * `self::createResourceCollection($models)`. Recursion is bounded by the
 * shared visited set.
 */
function resolveSelfFactory(
  call: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
  handler: TsNode,
  visited: Set<TsNode>,
): DiscoveredResponse | null {
  const names = childrenOfType(call, "name");
  const relative = call.namedChildren.find((c) => c.type === "relative_scope");
  const scope = (relative?.text ?? names[0]?.text ?? "").toLowerCase();
  const methodName = names[names.length - 1]?.text;
  if ((scope !== "self" && scope !== "static") || !methodName) return null;

  let classNode: TsNode | null = handler;
  while (classNode && classNode.type !== "class_declaration") {
    classNode = classNode.parent ?? null;
  }
  const className = classNode?.namedChildren.find((c) => c.type === "name")?.text;
  if (!className) return null;
  const methodNode = model.analysis.classes.get(className)?.methods.get(methodName) ?? null;
  if (!methodNode || visited.has(methodNode)) return null;
  visited.add(methodNode);

  for (const ret of findAll(methodNode, (n) => n.type === "return_statement")) {
    const expressions = ret.namedChildren.filter(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "scoped_call_expression" ||
        c.type === "function_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "variable_name" ||
        c.type === "array_creation_expression" ||
        c.type === "conditional_expression",
    );
    for (const expression of expressions) {
      const branches =
        expression.type === "conditional_expression"
          ? expression.namedChildren.filter(
              (c) =>
                c.type === "member_call_expression" ||
                c.type === "scoped_call_expression" ||
                c.type === "function_call_expression" ||
                c.type === "object_creation_expression",
            )
          : [expression];
      for (const branch of branches) {
        const resolved = interpretResponse(branch, model, gaps, methodNode, visited);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

/**
 * Interpret `Illuminate\Support\Facades\Response::download/streamDownload/
 * make/file/stream(...)` facade calls. The HTTP\Response value class only ever
 * uses `Response::HTTP_*` constants (not calls), so a `Response::` call to a
 * response-factory method unambiguously targets the facade.
 */
function facadeResponse(call: TsNode, gaps: GapCode[]): DiscoveredResponse | null {
  const qualified = call.namedChildren.find((c) => c.type === "qualified_name");
  const names = childrenOfType(call, "name");
  const method = names[names.length - 1]?.text;
  const scope = qualified
    ? qualified.text.split("\\").filter(Boolean).pop()
    : names.length >= 2
      ? names[names.length - 2]?.text
      : null;
  if (scope !== "Response" || !method) return null;
  const args = call.namedChildren.find((c) => c.type === "arguments");
  const argNodes = args ? childrenOfType(args, "argument") : [];
  if (method.toLowerCase() === "nocontent") {
    return { statusCode: responseStatus(argNodes[0], "204", gaps), description: "", confidence: "high" };
  }
  if (method.toLowerCase() === "view") {
    return {
      statusCode: "200",
      description: "",
      confidence: "medium",
      content: [{ mediaType: "text/html", schema: { type: "string" } }],
    };
  }
  return downloadLikeResponse(method, argNodes, gaps);
}

/**
 * Resolve a `$this->respondXxx(...)` controller helper by following its return
 * statement on the enclosing class (walking the parent controller chain).
 * Recursion is bounded by the shared visited set.
 */
function resolveControllerHelper(
  methodName: string,
  model: PhpModelIndex,
  gaps: GapCode[],
  handler: TsNode,
  visited: Set<TsNode>,
): DiscoveredResponse | null {
  let classNode: TsNode | null = handler;
  while (classNode && classNode.type !== "class_declaration") {
    classNode = classNode.parent ?? null;
  }
  let className: string | null = classNode?.namedChildren.find((c) => c.type === "name")?.text ?? null;
  const seen = new Set<string>();
  while (className && !seen.has(className)) {
    seen.add(className);
    const cls = model.analysis.classes.get(className);
    if (!cls) break;
    const methodNode = cls.methods.get(methodName);
    if (methodNode) {
      if (visited.has(methodNode)) return null;
      visited.add(methodNode);
      for (const ret of findAll(methodNode, (n) => n.type === "return_statement")) {
        const expression = ret.namedChildren.find(
          (c) =>
            c.type === "member_call_expression" ||
            c.type === "scoped_call_expression" ||
            c.type === "function_call_expression" ||
            c.type === "object_creation_expression" ||
            c.type === "variable_name" ||
            c.type === "array_creation_expression",
        );
        if (expression) {
          const resolved = interpretResponse(expression, model, gaps, methodNode, visited);
          if (resolved) return resolved;
        }
      }
      return null;
    }
    className = cls.extends?.split("\\").pop() ?? null;
  }
  return null;
}

/**
 * Resolve chains rooted in a static resource factory, e.g.
 * `SongResource::make($model)->for($user)` or
 * `SongResource::collection($models)->additional(['meta' => true])`.
 * Returns the resource item/array schema, or null when the chain is not rooted
 * in a known API Resource class.
 */
function chainedStaticResource(expression: TsNode, model: PhpModelIndex): JsonSchema | null {
  let cursor: TsNode | null = expression;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    if (cursor.type === "scoped_call_expression") {
      const names = childrenOfType(cursor, "name");
      const qualified = cursor.namedChildren.find((c) => c.type === "qualified_name");
      const method = names[names.length - 1]?.text?.toLowerCase();
      const className = qualified
        ? qualified.text.split("\\").filter(Boolean).pop()
        : names.length >= 2
          ? names[names.length - 2]?.text
          : undefined;
      if (className && /(?:Resource|Response|Result|Dto)$/.test(className) && model.analysis.classes.has(className)) {
        const ref = ensurePhpComponent(className, model);
        if (!ref) return null;
        return method === "collection" ? { type: "array", items: ref } : ref;
      }
      return null;
    }
    if (cursor.type === "object_creation_expression") {
      const name = cursor.namedChildren.find((c) => c.type === "name")?.text;
      if (name && /(?:Resource|Response|Result|Dto)$/.test(name) && model.analysis.classes.has(name)) {
        return ensurePhpComponent(name, model);
      }
      return null;
    }
    if (cursor.type === "member_call_expression") {
      cursor =
        cursor.namedChildren.find(
          (c) =>
            c.type === "member_call_expression" ||
            c.type === "scoped_call_expression" ||
            c.type === "object_creation_expression",
        ) ?? null;
      continue;
    }
    return null;
  }
  return null;
}

function inferStaticModel(call: TsNode, model: PhpModelIndex): JsonSchema | undefined {  const names = childrenOfType(call, "name");
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

/**
 * Follow a cross-class method call to the array it returns, statically. Used for
 * transformer rows (`(new AccessoryTransformer)->transformAccessory($m)`) and
 * static response envelopes (`Helper::formatStandardApiResponse(...)`). Only
 * literal/assignment-built arrays produce a schema; dynamic model values become
 * honest `{}` properties. Recursion is bounded by a visited set of
 * `Class::method` keys and never fabricates leaf types.
 */
function followCallToSchema(
  call: TsNode,
  model: PhpModelIndex,
  visited: Set<string>,
  currentClass?: string | null,
): JsonSchema | undefined {
  let className: string | null = null;
  let methodName: string | null = null;

  if (call.type === "member_call_expression") {
    let recv: TsNode | undefined = call.namedChildren[0];
    while (recv && recv.type === "parenthesized_expression") {
      recv = recv.namedChildren[0];
    }
    if (!recv || recv.type !== "object_creation_expression") return undefined;
    className =
      recv.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text ?? null;
    methodName = call.namedChildren.find((c) => c.type === "name")?.text ?? null;
  } else if (call.type === "scoped_call_expression") {
    const qualified = call.namedChildren.find((c) => c.type === "qualified_name");
    const names = childrenOfType(call, "name");
    className = qualified
      ? qualified.text.split("\\").pop() ?? null
      : names.length >= 2
        ? names[names.length - 2]?.text ?? null
        : null;
    methodName = names[names.length - 1]?.text ?? null;
  } else {
    return undefined;
  }

  if (!className || !methodName) return undefined;
  if (className === "self" || className === "static") className = currentClass ?? null;
  className = className?.split("\\").pop() ?? null;
  if (!className) return undefined;

  return followCalleeToSchema(className, methodName, model, visited);
}

function followCalleeToSchema(
  className: string,
  methodName: string,
  model: PhpModelIndex,
  visited: Set<string>,
): JsonSchema | undefined {
  const key = `${className}::${methodName}`;
  if (visited.has(key)) return undefined;
  const cls = model.analysis.classes.get(className);
  const methodNode = cls?.methods.get(methodName);
  if (!cls || !methodNode) return undefined;
  visited.add(key);
  return resolveReturnedArray(methodNode, model, visited, className);
}

function resolveReturnedArray(
  methodNode: TsNode,
  model: PhpModelIndex,
  visited: Set<string>,
  currentClass?: string | null,
): JsonSchema | undefined {
  for (const ret of findAll(methodNode, (n) => n.type === "return_statement")) {
    const expr = ret.namedChildren.find(
      (c) =>
        c.type === "array_creation_expression" ||
        c.type === "variable_name" ||
        c.type === "member_call_expression" ||
        c.type === "scoped_call_expression",
    );
    if (!expr) continue;
    if (expr.type === "array_creation_expression") {
      return inferArraySchema(expr, model, methodNode);
    }
    if (expr.type === "variable_name") {
      const schema = resolveVariableToObject(expr.text, methodNode, model, visited, currentClass);
      if (schema) return schema;
      continue;
    }
    // Delegation: `return (new OtherTransformer)->row($x)` / `return Other::env(...)`.
    const nested = followCallToSchema(expr, model, visited, currentClass);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Resolve the object assigned to a returned variable: either a literal
 * `$x = [ ... ]`, or a series of `$x['key'] = $value` dim assignments (the
 * shape Laravel transformers and response envelopes are built with).
 */
function resolveVariableToObject(
  varText: string,
  methodNode: TsNode,
  model: PhpModelIndex,
  visited: Set<string>,
  currentClass?: string | null,
): JsonSchema | undefined {
  const properties: Record<string, JsonSchema> = {};
  let sawDim = false;
  for (const assignment of findAll(methodNode, (n) => n.type === "assignment_expression")) {
    const left = assignment.namedChildren[0];
    const rhs = assignment.namedChildren[1];
    if (!left || !rhs) continue;
    if (left.type === "variable_name" && left.text === varText) {
      if (rhs.type === "array_creation_expression") {
        const schema = inferArraySchema(rhs, model, methodNode);
        if (schema) return schema;
      }
      continue;
    }
    // $x['key'] = rhs  — the variable is the base of a subscript on the LHS.
    if (left.namedChildren?.some((c) => c.type === "variable_name" && c.text === varText)) {
      const keyNode = left.namedChildren.find(
        (c) => c.type === "string" || c.type === "encapsed_string",
      );
      const key = keyNode ? phpStringText(keyNode) : null;
      if (!key) continue;
      properties[key] = inferArrayValue(rhs, model, methodNode, 0) ?? {};
      sawDim = true;
    }
  }
  return sawDim ? { type: "object", properties } : undefined;
}

function integerText(node: TsNode | undefined): string | null {
  if (!node) return null;
  const int = node.type === "integer" ? node : node.namedChildren.find((c) => c.type === "integer");
  return int?.text ?? null;
}

/** Read a static string literal argument, or null when it is dynamic. */
function staticString(node: TsNode | undefined): string | null {
  if (!node) return null;
  const str = node.type === "string" ? node : node.namedChildren.find((c) => c.type === "string");
  return str ? phpStringText(str) : null;
}

/**
 * A file / binary / streamed response is always an opaque octet-stream body.
 * When a download filename is a static string, emit a Content-Disposition
 * attachment header backed by that literal.
 */
function binaryResponse(status: string, filename?: string | null): DiscoveredResponse {
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

/**
 * Shared interpretation of the response-factory method family
 * (download / streamDownload / stream / file / make). Used by both the
 * `response()->...` member chain and the `Response::...` facade static call.
 */
function downloadLikeResponse(
  method: string,
  argNodes: TsNode[],
  gaps: GapCode[],
): DiscoveredResponse | null {
  const m = method.toLowerCase();
  if (m === "download") {
    return binaryResponse("200", staticString(argNodes[1]));
  }
  if (m === "streamdownload" || m === "stream") {
    const headersArray = argNodes[2]?.namedChildren.find((c) => c.type === "array_creation_expression");
    const isSse = headersArray
      ? childrenOfType(headersArray, "array_element_initializer").some((element) => {
          const strings = childrenOfType(element, "string");
          return (
            phpStringText(strings[0])?.toLowerCase() === "content-type" &&
            phpStringText(strings[1])?.includes("text/event-stream")
          );
        })
      : false;
    if (isSse) {
      gaps.push("sse-events-unknown");
      return {
        statusCode: m === "streamdownload" ? "200" : responseStatus(argNodes[1], "200", gaps),
        description: "Server-sent events",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: {} }],
      };
    }
    if (m === "streamdownload") return binaryResponse("200", staticString(argNodes[1]));
    return { statusCode: responseStatus(argNodes[1], "200", gaps), description: "", confidence: "low" };
  }
  if (m === "file") {
    // ResponseFactory::file accepts only the file and headers.
    return binaryResponse("200");
  }
  if (m === "make") {
    // response()->make($content = '', $status = 200, $headers = [])
    return binaryResponse(responseStatus(argNodes[1], "200", gaps));
  }
  return null;
}

function parseResourceCall(
  args: TsNode[],
  fullResource: boolean,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  rel: string,
  groupPrefix: string,
  onlyActions: Set<string> | null = null,
  exceptActions: Set<string> = new Set(),
): RouteCandidate[] {
  const pathArg = args[0]?.namedChildren.find((c) => c.type === "string");
  const handlerArg = args[1];
  const handler = resolveHandler(handlerArg, analysis, analysis.files.get(rel)?.imports);
  const controller = handler?.controller ?? resourceControllerName(handlerArg);

  // Dot-nested resources ('albums.songs') expand to a nested URI: the
  // collection route is /albums/{album}/songs and the item route appends
  // /{song}. One route binding is derived per resource segment.
  const resourceName = phpStringText(pathArg) ?? "";
  const segments = resourceName
    .split(".")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const bindings = segments.map((seg) => resourceBinding(seg));

  let collectionPath = "";
  segments.forEach((seg, i) => {
    collectionPath += `/${seg}`;
    if (i < segments.length - 1) collectionPath += `/{${bindings[i]}}`;
  });
  const childBinding = bindings[bindings.length - 1] ?? "resource";
  const basePath = joinRoute(groupPrefix, collectionPath || "/");
  const itemPath = `${basePath}/{${childBinding}}`;

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

  return operations.flatMap(({ verb, path, method }) => {
    if (onlyActions && !onlyActions.has(method)) return [];
    if (exceptActions.has(method)) return [];
    const cls = controller ? analysis.classes.get(controller) : null;
    // Laravel registers the conventional actions independently of whether
    // the controller implements them. Missing handlers must remain visible.
    const methodNode = cls ? findPhpMethod(cls, method, analysis) ?? null : null;
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
    // Ensure every binding present in the route URI is declared as a string path
    // parameter. Route segments are always strings at the HTTP layer, so this is
    // an honest OpenAPI default and never carries the path-param-untyped gap,
    // whether or not the controller method itself resolved.
    for (const p of declaredPathParams) {
      if (!parameters.some((prm) => prm.in === "path" && prm.name === p)) {
        parameters.push({ name: p, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
      }
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

/**
 * Read ->only([...]) / ->except([...]) modifiers chained on a resource
 * registration. Walks the parent member-call chain so multiple decorators
 * (->names()->except(...)) are all considered.
 */
function resourceModifiers(call: TsNode): { only: Set<string> | null; except: Set<string> } {
  const only: string[] = [];
  const except: string[] = [];
  let cursor: TsNode | null = call.parent ?? null;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    if (cursor.type === "member_call_expression") {
      const modifier = cursor.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
      if (modifier === "only" || modifier === "except") {
        const argsNode = cursor.namedChildren.find((c) => c.type === "arguments");
        const values: string[] = [];
        if (argsNode) {
          for (const arg of childrenOfType(argsNode, "argument")) {
            const root = arg.namedChildren[0] ?? arg;
            if (root.type === "string") {
              const text = phpStringText(root);
              if (text) values.push(text);
            } else if (root.type === "array_creation_expression") {
              for (const element of childrenOfType(root, "array_element_initializer")) {
                const textNode = element.namedChildren.find((c) => c.type === "string");
                const text = textNode ? phpStringText(textNode) : null;
                if (text) values.push(text);
              }
            }
          }
        }
        if (modifier === "only") only.push(...values);
        else except.push(...values);
      }
    }
    cursor = cursor.parent ?? null;
  }
  return {
    only: only.length ? new Set(only) : null,
    except: new Set(except),
  };
}

function resourceControllerName(handlerArg: TsNode | undefined): string | null {  if (!handlerArg) return null;
  const access = findFirst(handlerArg, (n) => n.type === "class_constant_access_expression");
  return access ? childrenOfType(access, "name")[0]?.text ?? null : null;
}

function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Route binding name for a resource segment: kebab -> snake, then singular. */
function resourceBinding(segment: string): string {
  return singular(segment.replace(/-/g, "_"));
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

/**
 * Laravel aliases the same controller#method at multiple paths (e.g.
 * `Route::apiResource('users')` and `Route::apiResource('user')`, or a
 * deprecated `songs/favorite` next to `songs/favorites`). Keep every path but
 * make operationIds unique by suffixing later collisions with a path slug.
 */
function disambiguateOperationIds(routes: RouteCandidate[]): void {
  const used = new Set<string>();
  for (const route of routes) {
    if (!route.operationId) continue;
    if (!used.has(route.operationId)) {
      used.add(route.operationId);
      continue;
    }
    const slug = (route.fullPath ?? route.path)
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    let candidate = `${route.operationId}_${slug}`;
    let n = 2;
    while (used.has(candidate)) candidate = `${route.operationId}_${slug}_${n++}`;
    route.operationId = candidate;
    used.add(candidate);
  }
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

/** An omitted optional status has a framework default; a dynamic one does not. */
function responseStatus(argument: TsNode | undefined, fallback: string, gaps: GapCode[]): string {
  const status = integerText(argument) ?? (argument ? "default" : fallback);
  if (status === "default") gaps.push("response-unknown");
  return status;
}
