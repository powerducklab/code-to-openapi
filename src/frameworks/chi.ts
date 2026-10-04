import {mergeResponseVariants} from "../core/response-variants.js";
import { namespaceComponents, remapSchemaReferences } from "../core/schema-references.js";
import { goExpressionType, goSourceFile, resolveGoCall } from "../lang/go/symbols.js";
import { convertedParameterSchema } from "../lang/go/httphandler.js";
/**
 * Chi router framework pack (Go).
 *
 * Supports chi.NewRouter, r.Route/Group scoped blocks, r.Mount with inline
 * sub-routers or router factory functions, net/http handler evidence
 * (URLParam, URL.Query, json.Decoder/Encoder, WriteHeader) and SSE detection.
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
import type { JsonSchema, DiscoveredUnresolved } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import { receiverTypeName } from "../lang/go/index.js";
import {
  buildGoModelIndex,
  ensureGoComponent,
  goTypeToSchema,
  goConstructedTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  type GoModelIndex,
} from "../lang/go/schema.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  literalString,
  positionalArguments,
} from "../lang/treesitter/ast.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

const STATUS_CONSTANTS: Record<string, string> = {
  StatusOK: "200",
  StatusCreated: "201",
  StatusAccepted: "202",
  StatusNoContent: "204",
  StatusBadRequest: "400",
  StatusUnauthorized: "401",
  StatusForbidden: "403",
  StatusNotFound: "404",
  StatusMethodNotAllowed: "405",
  StatusConflict: "409",
  StatusUnprocessableEntity: "422",
  StatusTooManyRequests: "429",
  StatusInternalServerError: "500",
};

interface RouteSite {
  middleware?: TsNode[];
  handlerReference?: TsNode;
  method: string;
  path: string;
  handlerName: string | null;
  handlerNode: TsNode | null;
  origin: SourceLocation;
}

function selectorCall(node: TsNode): { receiver: TsNode; method: string } | null {
  if (node.type !== "call_expression") return null;
  const selector = node.namedChildren[0];
  if (!selector || selector.type !== "selector_expression") return null;
  const receiver = selector.namedChildren[0];
  const field = selector.namedChildren[1];
  if (!receiver || !field || field.type !== "field_identifier") return null;
  return { receiver, method: field.text };
}

// Base type name of a composite-literal receiver such as `usersResource{}`
// or `pkg.Resource{}`; null for anything else.
function compositeReceiverTypeName(node: TsNode): string | null {
  if (node.type !== "composite_literal") return null;
  const typeNode = node.namedChildren[0];
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "selector_expression") return typeNode.namedChildren[1]?.text ?? null;
  return null;
}

function statusCode(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "int_literal") return node.text.trim();
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field ? STATUS_CONSTANTS[field.text] ?? null : null;
  }
  return null;
}

function pathParams(path: string): string[] {
  const result: string[] = [];
  const regex = /{([^}]+)}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path))) result.push(match[1]);
  return result;
}

function unwrapElement(node: TsNode): TsNode {
  return node.type === "literal_element" ? node.namedChildren[0] ?? node : node;
}

/** Literal maps/slices/structs for response evidence. */
function literalSchema(node: TsNode | null, index: GoModelIndex, depth = 0): JsonSchema | null {
  if (!node || depth > 6) return null;
  if (node.type === "unary_expression") {
    return literalSchema(node.namedChildren[0], index, depth + 1);
  }
  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    const value = node.namedChildren[1];

    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      return goConstructedTypeToSchema(typeNode, index);
    }
    if (typeNode && typeNode.type === "type_identifier") {
      if (index.byName.has(typeNode.text)) {
        return goTypeToSchema(typeNode, index, depth + 1);
      }
      return {};
    }

    const properties: Record<string, JsonSchema> = {};
    if (value) {
      for (const element of childrenOfType(value, "keyed_element")) {
        const keyNode = unwrapElement(element.namedChildren[0]);
        const valNode = unwrapElement(element.namedChildren[1]);
        const keyText = literalString(keyNode);
        if (!keyText) continue;
        const scalar = scalarLiteral(valNode);
        properties[keyText] = scalar ?? literalSchema(valNode, index, depth + 1) ?? {};
      }
    }
    if (Object.keys(properties).length > 0) return { type: "object", properties };
    if (typeNode && (typeNode.type === "map_type" || typeNode.type === "selector_expression")) {
      return { type: "object" };
    }
  }
  return null;
}

function scalarLiteral(node: TsNode): JsonSchema | null {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    return { type: "string" };
  }
  if (node.type === "int_literal") return { type: "integer" };
  if (node.type === "float_literal") return { type: "number" };
  if (node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "nil") return { type: "null" };
  return null;
}

function joinPath(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/\/$/, "");
  // A group-relative route "/" maps onto the group prefix itself, avoiding a
  // trailing slash (e.g. Route("/articles") + Get("/") -> "/articles").
  if (!path || path === "/") return cleanPrefix || "/";
  const cleanPath = path.replace(/^\//, "");
  if (!cleanPath) return cleanPrefix || "/";
  return `${cleanPrefix}/${cleanPath}`;
}

/**
 * Normalize a chi route pattern to OpenAPI path syntax. Chi supports regex
 * constraints in params, e.g. `{articleSlug:[a-z-]+}`, which OpenAPI does not
 * model; keep only the parameter name.
 */
function normalizeChiPath(raw: string): string {
  return raw.replace(/\{([^}:]+):[^}]*\}/g, "{$1}");
}

function operationId(method: string, path: string): string {
  const parts = path
    .replace(/[{}]/g, "")
    .split(/[/\-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return method.toLowerCase() + parts.join("");
}

function addrToUrl(addr: string): string {
  const port = addr.match(/:(\d+)/)?.[1];
  return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
}

export const chiPack: FrameworkPack<GoAnalysis> = {
  id: "chi",
  language: "go",
  dependencyHints: ["github.com/go-chi/chi", "github.com/go-chi/chi/v5"],

  applies(ctx) {
    if (
      ctx.manifest.packages.has("github.com/go-chi/chi") ||
      ctx.manifest.packages.has("github.com/go-chi/chi/v5")
    ) {
      return true;
    }
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /go-chi\/chi/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const inputModel = {...modelIndex,input:true,components:new Map()};
    const validatedModel = {...inputModel,validated:true,components:new Map()};
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    for (const file of analysis.files.values()) {
      // Router declarations local to a function body (excluding nested func
      // literals, whose receiver is a parameter rather than a new router).
      const routersInBody = (body: TsNode): Set<string> => {
        const names = new Set<string>();
        const walk = (node: TsNode) => {
          if (node.type === "func_literal") return;
          if (node.type === "short_var_declaration") {
            const isRouter = findAll(node, (c) => c.type === "call_expression").some((call) => {
              const sel = selectorCall(call);
              return sel?.receiver.type === "identifier" &&
                sel.receiver.text === "chi" &&
                sel.method === "NewRouter";
            });
            if (isRouter) {
              const left = node.namedChildren.find((c) => c.type === "expression_list");
              for (const name of left?.namedChildren ?? []) {
                if (name.type === "identifier") names.add(name.text);
              }
            }
          }
          for (const child of node.namedChildren) walk(child);
        };
        walk(body);
        return names;
      };

      const collectCalls = (
        scope: TsNode,
        receiverName: string,
        prefix: string,
        visited: Set<TsNode>,
        inherited: TsNode[] = [],
      ) => {
        if (visited.has(scope)) return;
        visited.add(scope);
        const middleware = [...inherited];
        // Walk without descending into nested func literals: their receiver is
        // a different (often shadowing) parameter and is handled explicitly
        // through Route/Group below.
        const walk = (node: TsNode) => {
          if (node.type === "func_literal" && node !== scope) return;
          if (node.type === "call_expression") {
            handleCall(node);
          }
          for (const child of node.namedChildren) walk(child);
        };

        // Resolve the router that a verb call targets, unwrapping middleware
        // chains such as `r.With(mw).Get(...)` or `r.Group(...).Get(...)`.
        const routerBase = (call: TsNode): string | null => {
          const sel = selectorCall(call);
          if (!sel) return null;
          if (sel.receiver.type === "identifier") return sel.receiver.text;
          if (sel.receiver.type === "call_expression") {
            let cur: TsNode = sel.receiver;
            while (cur.type === "call_expression") {
              const s = selectorCall(cur);
              if (!s) return null;
              if (s.receiver.type === "identifier") {
                return s.method === "With" || s.method === "Group" ? s.receiver.text : null;
              }
              cur = s.receiver;
            }
          }
          return null;
        };

        const handleCall = (call: TsNode) => {
          const sel = selectorCall(call);
          if (!sel) return;
          const base = routerBase(call);
          if (base !== receiverName) return;
          const args = positionalArguments(call);
          if (sel.method === "Use") { middleware.push(...args); return; }

          if (HTTP_METHODS.has(sel.method.toLowerCase())) {
            const rawPath = literalString(args[0]);
            if (rawPath === null) {
              unresolved.push({
                reason: "dynamic-path",
                message: "Chi route path is not a static string literal",
                origin: { file: file.path, line: call.startPosition.row + 1 },
              });
              return;
            }
            const handler = args[1];
            const methodHandlerName =
              handler?.type === "identifier"
                ? handler.text
                : handler?.type === "selector_expression"
                  ? (handler.namedChildren[1]?.type === "field_identifier"
                      ? handler.namedChildren[1].text
                      : null)
                  : null;
            sites.push({
              middleware: [...middleware],
              handlerReference: handler,
              method: sel.method.toLowerCase(),
              path: joinPath(prefix, normalizeChiPath(rawPath)),
              handlerName: methodHandlerName,
              handlerNode: handler?.type === "func_literal" ? handler : null,
              origin: { file: file.path, line: call.startPosition.row + 1 },
            });
            return;
          }

          if (sel.method === "Route" || sel.method === "Group") {
            const funcLiteral = args.find((a) => a.type === "func_literal");
            // Group blocks may be prefix-less: the first argument is then the
            // function literal itself.
            const prefixArg = args[0] && args[0].type !== "func_literal" ? args[0] : null;
            const nestedPrefix = prefixArg ? literalString(prefixArg) : "";
            if (nestedPrefix === null || !funcLiteral) return;
            const innerParam = funcLiteral.namedChildren
              .find((c) => c.type === "parameter_list")
              ?.namedChildren.find((c) => c.type === "parameter_declaration")
              ?.namedChildren[0];
            const innerBlock = findFirst(funcLiteral, (c) => c.type === "block");
            if (innerParam?.type === "identifier" && innerBlock) {
              collectCalls(
                innerBlock,
                innerParam.text,
                joinPath(prefix, nestedPrefix),
                visited,
                middleware,
              );
            }
            return;
          }

          if (sel.method === "Mount") {
            const mountPrefix = literalString(args[0]);
            if (mountPrefix === null) return;
            const target = args[1];
            if (target?.type === "call_expression") {
              const factorySel = selectorCall(target);
              const factoryName = factorySel
                ? factorySel.method
                : target.namedChildren[0]?.type === "identifier"
                  ? target.namedChildren[0].text
                  : null;
              let factory: GoFunction | undefined = factoryName
                ? analysis.functions.get(factoryName)?.find((fn) => fn.file === file.path)
                : undefined;
              // Method-value factory on a value, e.g. `usersResource{}.Routes()`.
              if (!factory && factorySel) {
                const receiverType = compositeReceiverTypeName(factorySel.receiver);
                if (receiverType) {
                  const matches = analysis.methods.filter(
                    (m) =>
                      m.name === factorySel.method &&
                      receiverTypeName(m) === receiverType,
                  );
                  factory = matches.find((m) => m.file === file.path) ?? matches[0];
                }
              }
              if (factory?.body) collectFactory(factory, joinPath(prefix, mountPrefix), visited);
            }
          }
        };

        walk(scope);
      };

      const collectFactory = (fn: GoFunction, prefix: string, visited: Set<TsNode>) => {
        if (!fn.body) return;
        const returnNames = findAll(fn.body, (n) => n.type === "return_statement")
          .flatMap((statement) => {
            const list = statement.namedChildren.find((c) => c.type === "expression_list");
            const inList = list?.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text) ?? [];
            // Single-value `return r` exposes the identifier directly.
            const direct = statement.namedChildren
              .filter((c) => c.type === "identifier")
              .map((c) => c.text);
            return [...inList, ...direct];
          });
        for (const routerName of routersInBody(fn.body)) {
          if (returnNames.includes(routerName)) {
            collectCalls(fn.body, routerName, prefix, visited);
          }
        }
      };

      // Entry points: routers declared in main-like top-level functions.
      // Follow registration helpers such as `setupRoutes(r)` so apps that
      // factor route groups out of main are still fully discovered.
      const followQueue: Array<{ fn: GoFunction; routerParam: string; prefix: string }> = [];
      const enqueueSetupCalls = (body: TsNode, knownRouters: Set<string>) => {
        for (const call of findAll(body, (n) => n.type === "call_expression")) {
          const callee = call.namedChildren[0];
          if (!callee || callee.type !== "identifier") continue;
          const args = positionalArguments(call);
          const routerArg = args.find(
            (a) => a.type === "identifier" && knownRouters.has(a.text),
          );
          if (!routerArg) continue;
          const target = analysis.functions.get(callee.text)?.[0];
          if (!target?.body) continue;
          const paramList = target.node.namedChildren.find((c) => c.type === "parameter_list");
          const routerParam =
            paramList?.namedChildren.find((c) => /chi\.Router|Router/.test(c.text))
              ?.namedChildren.find((c) => c.type === "identifier")?.text;
          if (routerParam) followQueue.push({ fn: target, routerParam, prefix: "" });
        }
      };

      for (const fn of file.root.namedChildren.filter((c) => c.type === "function_declaration")) {
        const name = fn.namedChildren[0];
        const body = fn.namedChildren.find((c) => c.type === "block");
        if (!body) continue;
        const isMain = name?.type === "identifier" && name.text === "main";
        if (!isMain) continue;
        const mainRouters = routersInBody(body);
        for (const routerName of mainRouters) {
          collectCalls(body, routerName, "", new Set());
        }
        enqueueSetupCalls(body, mainRouters);
        for (const call of findAll(body, (n) => n.type === "call_expression")) {
          const sel = selectorCall(call);
          if (
            sel &&
            sel.receiver.type === "identifier" &&
            sel.receiver.text === "http" &&
            sel.method === "ListenAndServe"
          ) {
            const addr = literalString(positionalArguments(call)[0]);
            if (addr) servers.add(addrToUrl(addr));
          }
        }
      }

      // Breadth-first expansion of setup helpers.
      const visitedSetups = new Set<string>();
      while (followQueue.length) {
        const item = followQueue.shift()!;
        const key = `${item.fn.file}::${item.fn.name}`;
        if (visitedSetups.has(key)) continue;
        visitedSetups.add(key);
        const body = item.fn.body!;
        collectCalls(body, item.routerParam, item.prefix, new Set());
        enqueueSetupCalls(body, new Set([item.routerParam]));
      }
    }

    const routes = sites.map((site) => buildRoute(site, analysis, modelIndex, inputModel, validatedModel));
    const reserved = new Set([...modelIndex.byName.keys(), ...modelIndex.components.keys()]);
    const raw = namespaceComponents(inputModel.components, reserved, "input");
    const validated = namespaceComponents(validatedModel.components, reserved, "validated_input");
    for (const route of routes) if (route.requestBody) {
      route.requestBody = remapSchemaReferences(route.requestBody, validatedBodies.has(route.requestBody) ? validated.names : raw.names);
    }
    return {
      routes,
      unresolved,
      components: [...[...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })), ...raw.components, ...validated.components],
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

/** Validate rules only when a checked error prevents the handler continuing. */
function rejectsValidationError(call: TsNode, body: TsNode, analysis: GoAnalysis): boolean {
  let assignment = call.parent;
  while (assignment && assignment.type !== "assignment_statement" && assignment.type !== "short_var_declaration" && assignment.id !== body.id) assignment = assignment.parent;
  if (!assignment || assignment.id === body.id) return false;
  const name = assignment.namedChildren[0]?.namedChildren[0]?.text;
  if (!name || name === "_") return false;
  const nextWrite = findAll(body, n => (n.type === "assignment_statement" || n.type === "short_var_declaration") && n.startIndex > assignment!.startIndex && n.namedChildren[0]?.namedChildren.some(c => c.text === name))
    .reduce((end,n)=>Math.min(end,n.startIndex),Infinity);
  return findAll(body, n => n.type === "if_statement").some(statement => {
    const condition = statement.childForFieldName("condition");
    const consequence = statement.childForFieldName("consequence");
    if (!condition || condition.startIndex < call.startIndex || condition.startIndex >= nextWrite || !consequence ||
        !findAll(consequence,n=>n.type === "return_statement").length) return false;
    if (condition.text.replace(/\s/g, "") === `${name}!=nil`) return true;
    if (condition.type !== "call_expression") return false;
    const helper = resolveGoCall(condition, analysis);
    if (!helper?.body) return false;
    const at = positionalArguments(condition).findIndex(arg => arg.text === name);
    const params = helper.node.childForFieldName("parameters")?.namedChildren.flatMap(p=>p.namedChildren.filter(n=>n.type === "identifier")) ?? [];
    const errorName = params[at]?.text;
    if (!errorName) return false;
    const compact = helper.body.text.replace(/\s/g, "");
    const returns = findAll(helper.body,n=>n.type === "return_statement");
    return compact.startsWith(`{if${errorName}==nil{returnfalse}`) && compact.endsWith("returntrue}") && returns.length === 2;
  });
}

const validatedBodies = new WeakSet<object>();

function buildRoute(
  site: RouteSite,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  inputModel: GoModelIndex,
  validatedModel: GoModelIndex,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const declaredParams = pathParams(site.path);
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  let isSse = false;

  const namedFn = site.handlerReference && site.handlerReference.type !== "func_literal"
    ? resolveGoCall(site.handlerReference, analysis) : undefined;
  const inlineBlock = site.handlerNode
    ? (findFirst(site.handlerNode, (c) => c.type === "block") ?? null)
    : null;
  const fn: GoFunction | null = namedFn
    ?? (site.handlerNode && inlineBlock
      ? {
          name: "<anonymous>",
          file: site.origin.file,
          node: site.handlerNode,
          body: inlineBlock,
          receiver: null,
        }
      : null);
  const body = fn?.body ?? null;
  for (const reference of site.middleware ?? []) {
    const middleware = resolveGoCall(reference, analysis);
    if (!middleware?.body) continue;
    const owner = goSourceFile(middleware.node, analysis);
    if (!owner || !findAll(owner.root,n=>n.type === "import_spec").some(n=>n.childForFieldName("path")?.text === '"net/http"' && (n.childForFieldName("name")?.text ?? "http") === "http")) continue;
    const returnedHandlers = findAll(middleware.body, n => n.type === "return_statement").flatMap(statement =>
      findAll(statement, n => n.type === "call_expression" && selectorCall(n)?.receiver.text === "http" && selectorCall(n)?.method === "HandlerFunc"));
    for (const handler of returnedHandlers) {
      const closure = positionalArguments(handler)[0];
      if (closure?.type !== "func_literal") continue;
      const params = closure.namedChildren.find(n => n.type === "parameter_list");
      const writer = params?.namedChildren.find(p => p.childForFieldName("type")?.text === "http.ResponseWriter")?.namedChildren[0]?.text;
      for (const call of findAll(closure, n => n.type === "call_expression")) {
        let parent = call.parent;
        let active = true;
        while (parent && parent.id !== closure.id) {
          if (parent.type === "func_literal" && (parent.parent?.type !== "call_expression" || parent.parent.parent?.type !== "defer_statement" ||
              (parent.namedChildren.find(n=>n.type === "parameter_list")?.namedChildren.length ?? 0) > 0)) { active = false; break; }
          parent = parent.parent;
        }
        if (!active) continue;
        const sel = selectorCall(call), args = positionalArguments(call);
        if (sel?.receiver.text !== "http" || sel.method !== "Error" || !writer || args[0]?.text !== writer) continue;
        const status = statusCode(args[2]);
        if (status) responseStatus.set(status,{statusCode:status,description:"Middleware response",confidence:"medium",content:[{mediaType:"text/plain",schema:{type:"string"}}]});
      }
    }
  }


  if (body) {
    // Aliases such as `q := r.URL.Query()` — later q.Get("x") calls are query
    // parameters even though the receiver is a local variable.
    const queryAlias = new Set<string>();
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const left = decl.namedChildren.find((c) => c.type === "expression_list");
      const expressionLists = decl.namedChildren.filter((c) => c.type === "expression_list");
      const right = expressionLists.length > 1
        ? expressionLists[expressionLists.length - 1]
        : undefined;
      const hasQueryCall = findAll(right ?? decl, (c) => c.type === "call_expression").some(
        (call) => call.text.includes(".URL.Query()"),
      );
      if (hasQueryCall && left) {
        for (const id of left.namedChildren) {
          if (id.type === "identifier") queryAlias.add(id.text);
        }
      }
    }

    // Aliases for split-statement decoders: `decoder := json.NewDecoder(r.Body)`.
    const decoderVars = new Set<string>();
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const expressionLists = decl.namedChildren.filter((c) => c.type === "expression_list");
      const left = expressionLists[0];
      const right = expressionLists[1];
      if (!left || !right) continue;
      const isDecoder = findAll(right, (c) => c.type === "call_expression").some(
        (call) => {
          const s = selectorCall(call);
          return s?.receiver.type === "identifier" && s.receiver.text === "json" && s.method === "NewDecoder";
        },
      );
      if (isDecoder) {
        for (const id of left.namedChildren.filter((c) => c.type === "identifier")) {
          decoderVars.add(id.text);
        }
      }
    }

    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (!sel) continue;
      const args = positionalArguments(call);

      // chi.URLParam(r, "name")
      if (sel.receiver.type === "identifier" && sel.receiver.text === "chi" && sel.method === "URLParam") {
        const name = literalString(args[1]);
        if (name && declaredParams.includes(name) && !parameters.some((p) => p.name === name)) {
          parameters.push({
            name,
            in: "path",
            required: true,
            schema: convertedParameterSchema(call, analysis),
            confidence: "high",
          });
        }
        continue;
      }

      // r.URL.Query().Get("q") or q.Get("q") with q aliasing URL.Query().
      if (
        sel.method === "Get" &&
        (call.text.includes(".URL.Query()") ||
          (sel.receiver.type === "identifier" && queryAlias.has(sel.receiver.text)))
      ) {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({
            name,
            in: "query",
            required: false,
            schema: { type: "string" },
            confidence: "high",
          });
        }
        continue;
      }

      // r.Header.Get("X")
      if (sel.method === "Get" && call.text.includes(".Header.Get(")) {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({
            name,
            in: "header",
            required: false,
            schema: { type: "string" },
            confidence: "high",
          });
        }
        continue;
      }

      // r.Cookie("session")
      if (sel.method === "Cookie" && sel.receiver.type === "identifier") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({
            name,
            in: "cookie",
            required: false,
            schema: { type: "string" },
            confidence: "high",
          });
        }
        continue;
      }

      // json.NewDecoder(r.Body).Decode(&x), or decoder.Decode(&x) with a
      // split-statement decoder, or json.Unmarshal(data, &x).
      if (
        sel.method === "Decode" &&
        (call.text.includes("NewDecoder") ||
          (sel.receiver.type === "identifier" && decoderVars.has(sel.receiver.text)))
      ) {
        const typeNode = referencedType(args[0], body);
        const variable = args[0]?.text.replace(/^&/, "");
        const validated = findAll(body, n => n.type === "call_expression").some(call => {
          const sel = selectorCall(call);
          if (sel?.method !== "Struct" || positionalArguments(call)[0]?.text !== variable || !rejectsValidationError(call, body, analysis)) return false;
          const type = goExpressionType(sel.receiver, analysis);
          const owner = type ? goSourceFile(type, analysis) : undefined;
          const qualifier = type?.text.replace(/^\*/, "").split(".");
          return qualifier?.[1] === "Validate" && !!owner && findAll(owner.root, n => n.type === "import_spec").some(n =>
            /"github\.com\/go-playground\/validator(?:\/v10)?"/.test(n.childForFieldName("path")?.text ?? "") &&
            (n.childForFieldName("name")?.text ?? "validator") === qualifier[0]);
        });
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [
              { mediaType: "application/json", schema: goTypeToSchema(typeNode, validated ? validatedModel : inputModel), confidence: "high" },
            ],
          };
          if (validated && requestBody) validatedBodies.add(requestBody);
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      if (
        sel.receiver.type === "identifier" &&
        sel.receiver.text === "json" &&
        sel.method === "Unmarshal"
      ) {
        const typeNode = referencedType(args[1], body);
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [
              { mediaType: "application/json", schema: goTypeToSchema(typeNode, inputModel), confidence: "high" },
            ],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      if (sel.receiver.text === "http" && sel.method === "Error") {
        const status = statusCode(args[2]) ?? "default";
        responseStatus.set(status,{statusCode:status,description:"",confidence:"high",content:[{mediaType:"text/plain",schema:{type:"string"}}]});
        continue;
      }

      // w.Header().Set("Content-Type", "text/event-stream")
      if (sel.method === "Set" && call.text.includes(".Header().Set(")) {
        if (
          literalString(args[0]) === "Content-Type" &&
          (literalString(args[1]) ?? "").includes("text/event-stream")
        ) {
          isSse = true;
        }
        continue;
      }

      // w.WriteHeader(status): register the status (no body unless an Encode
      // follows in the same block scope).
      if (sel.receiver.type === "identifier" && sel.method === "WriteHeader") {
        const status = statusCode(args[0]);
        if (status && !responseStatus.has(status)) {
          responseStatus.set(status, {
            statusCode: status,
            description: "",
            confidence: "high",
          });
        }
        continue;
      }

      // w.Write([]byte("...")): plain-text body written directly to the
      // ResponseWriter (very common in net/http and chi handlers). The
      // conversion function is a slice_type node, so match by source text.
      if (sel.receiver.type === "identifier" && sel.method === "Write") {
        const arg = args[0];
        const writesBytes =
          (arg?.type === "call_expression" || arg?.type === "type_conversion_expression") &&
          /^\s*\[\s*\]byte\s*\(/.test(arg.text);
        if (writesBytes && !responseStatus.has("200")) {
          responseStatus.set("200", {
            statusCode: "200",
            description: "",
            confidence: "medium",
            content: [
              { mediaType: "text/plain", schema: { type: "string" }, confidence: "medium" },
            ],
          });
        }
        continue;
      }
    }

    // json.NewEncoder(w).Encode(x): status follows statement order within
    // each block, so a WriteHeader inside an if-branch cannot leak to the
    // handler's main flow.
    collectEncodeResponses(body, modelIndex, (status, schema) => {
      const existing = responseStatus.get(status);
      const response: RouteCandidate["responses"][number] = {
        statusCode: status,
        description: "",
        confidence: schema ? "high" : "medium",
        content: [{mediaType: "application/json", schema: schema ?? {}}],
      };
      responseStatus.set(status, existing ? mergeResponseVariants(existing, response) : response);
      if (!schema) gaps.add("response-schema-unknown");
    });

    // go-chi/render idiom: render.Render / render.RenderList / render.Status.
    collectRenderResponses(body, analysis, modelIndex, (status, schema) => {
      const existing = responseStatus.get(status);
      const response: RouteCandidate["responses"][number] = {
        statusCode: status,
        description: "",
        confidence: schema ? "high" : "medium",
        content: [{mediaType: "application/json", schema: schema ?? {}}],
      };
      responseStatus.set(status, existing ? mergeResponseVariants(existing, response) : response);
      if (!schema) gaps.add("response-schema-unknown");
    });

    // Declared but unproven path params.
    for (const name of declaredParams) {
      if (!parameters.some((p) => p.name === name && p.in === "path")) {
        parameters.push({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
          confidence: "medium",
        });
      }
    }
  } else {
    for (const name of declaredParams) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "medium",
      });
    }
    gaps.add("response-unknown");
  }

  if (isSse) {
    responseStatus.set("200", {
      statusCode: "200",
      description: "Server-Sent Events stream",
      confidence: "medium",
      content: [{ mediaType: "text/event-stream", itemSchema: {}, confidence: "medium" }],
    });
    gaps.add("sse-events-unknown");
  }

  if (responseStatus.size === 0) gaps.add("response-unknown");

  const confidence: Confidence = gaps.size > 0 ? "medium" : "high";
  return {
    method: site.method,
    path: site.path,
    fullPath: site.path,
    origin: site.origin,
    operationId: operationId(site.method, site.path),
    tags: [],
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: [...responseStatus.values()],
    ...(isSse ? { extensions: { "x-protocol": "sse" } } : {}),
    confidence,
    gaps: [...gaps],
    components: [],
    handlerSource: fn?.node.text.slice(0, 8192),
  };
}

function referencedType(arg: TsNode | undefined, body: TsNode): TsNode | null {
  if (!arg) return null;
  const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
  if (!target || target.type !== "identifier") return null;
  return resolveLocalType(body, target.text);
}

function responsePayloadSchema(
  arg: TsNode | undefined,
  body: TsNode,
  index: GoModelIndex,
): JsonSchema | null {
  if (!arg) return null;
  if (index.analysis) {
    const shared = resolveGoPayloadValue(arg, body, index.analysis, index, index.analysis.vars).schema;
    if (shared) return shared;
  }
  if (arg.type === "identifier") {
    const typeNode = resolveLocalType(body, arg.text);
    return typeNode ? goTypeToSchema(typeNode, index) : null;
  }
  return literalSchema(arg, index);
}

/**
 * Walk handler statements in source order with block-scoped status.
 * WriteHeader inside an if/for branch only affects Encode calls in that
 * branch; the main flow defaults to 200.
 */
function collectEncodeResponses(
  body: TsNode,
  index: GoModelIndex,
  emit: (status: string, schema: JsonSchema | null) => void,
): void {
  const shallowCalls = (statement: TsNode): TsNode[] => {
    const result: TsNode[] = [];
    const walk = (node: TsNode, isRoot: boolean) => {
      if (!isRoot && (node.type === "block" || node.type === "func_literal")) return;
      if (node.type === "call_expression") result.push(node);
      for (const child of node.namedChildren) walk(child, false);
    };
    walk(statement, true);
    return result;
  };

  const walkBlock = (block: TsNode, inherited: string | null) => {
    let status = inherited;
    for (const statement of block.namedChildren) {
      if (statement.type === "if_statement" || statement.type === "for_statement" ||
        statement.type === "range_statement" || statement.type === "switch_statement" ||
        statement.type === "select_statement") {
        for (const child of statement.namedChildren) {
          if (child.type === "block") walkBlock(child, null);
        }
        continue;
      }
      for (const call of shallowCalls(statement)) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (sel.receiver.type === "identifier" && sel.method === "WriteHeader") {
          status = statusCode(positionalArguments(call)[0]) ?? status;
        }
        if (sel.method === "Encode" && call.text.includes("NewEncoder")) {
          const arg = positionalArguments(call)[0];
          emit(status ?? "200", responsePayloadSchema(arg, body, index));
        }
      }
    }
  };

  walkBlock(body, null);
}

/**
 * Recognize the go-chi/render idiom: render.Status(r, code) sets the status for
 * the following render.Render / render.RenderList call, whose payload is a
 * constructor returning a render.Renderer (or a list of them). Payloads resolve
 * to a real JSON schema by following the constructor's return type (and body
 * when that return is an opaque interface). Status codes set on error renderer
 * composite literals (HTTPStatusCode: 400) are proven and emitted; anything we
 * cannot derive statically stays an honest gap rather than a guess.
 */
function collectRenderResponses(
  body: TsNode,
  analysis: GoAnalysis,
  index: GoModelIndex,
  emit: (status: string, schema: JsonSchema | null) => void,
): void {
  const shallowCalls = (statement: TsNode): TsNode[] => {
    const result: TsNode[] = [];
    const walk = (node: TsNode, isRoot: boolean) => {
      if (!isRoot && (node.type === "block" || node.type === "func_literal")) return;
      if (node.type === "call_expression") result.push(node);
      for (const child of node.namedChildren) walk(child, false);
    };
    walk(statement, true);
    return result;
  };

  const walkBlock = (block: TsNode, pending: string | null) => {
    let status = pending;
    for (const statement of block.namedChildren) {
      const isBranch =
        statement.type === "if_statement" || statement.type === "for_statement" ||
        statement.type === "range_statement" || statement.type === "switch_statement" ||
        statement.type === "select_statement";
      // Process calls directly on this statement first (this catches render calls
      // in if-initializers, e.g. `if err := render.RenderList(...); err != nil {`).
      for (const call of shallowCalls(statement)) {
        const sel = selectorCall(call);
        if (!sel) continue;
        const isRenderPkg = sel.receiver.type === "identifier" && sel.receiver.text === "render";
        if (!isRenderPkg) continue;
        if (sel.method === "Status") {
          // render.Status(r *http.Request, code int) — the code is the 2nd arg.
          status = statusCode(positionalArguments(call)[1]) ?? status;
          continue;
        }
        if (sel.method === "Render" || sel.method === "RenderList") {
          const args = positionalArguments(call);
          const resolved = resolveGoPayloadValue(args[2], body, analysis, index, analysis.vars);
          emit(status ?? resolved.status ?? "200", resolved.schema);
          status = null;
        }
      }
      if (isBranch) {
        for (const child of statement.namedChildren) {
          if (child.type === "block") walkBlock(child, null);
        }
      }
    }
  };

  walkBlock(body, null);
}
