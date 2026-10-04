/**
 * Fiber (gofiber/fiber v2, fasthttp-based) framework pack (Go).
 *
 * Routing idioms covered:
 *  - app := fiber.New() then app.Get/app.Post/app.Put/app.Patch/app.Delete(path, handler).
 *  - Groups: grp := app.Group("/api"); nested groups compose.
 *  - Handlers are `func(c *fiber.Ctx) error`; evidence comes from c.Params,
 *    c.Query, c.Get (request header), c.BodyParser and c.JSON/c.SendString/
 *    c.Status(code).JSON(...)/c.SendFile.
 *  - c.JSON follows constructor/service return types via the shared Go payload
 *    resolver; unproven payloads keep an honest gap.
 *
 * Detection requires the github.com/gofiber/fiber import, so this pack never
 * claims Express (JavaScript) projects or any other Go framework.
 */

import { mergeResponseVariants } from "../core/response-variants.js";
import { namespaceComponents, remapSchemaReferences } from "../core/schema-references.js";
import type {
  Confidence,
  ExtractionResult,
  FrameworkPack,
  GapCode,
  RouteCandidate,
  RouteParameter,
  SourceLocation,
} from "../core/types.js";
import type { DiscoveredUnresolved, JsonSchema } from "@powerduck/x-to-openapi";
import { jsonTag } from "../lang/go/index.js";
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import {
  buildGoModelIndex,
  ensureGoComponent,
  goTypeToSchema,
  goConstructedTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  localGoTypeToSchema as fiberTypeSchema,
  type GoModelIndex,
} from "../lang/go/schema.js";
import { resolveGoPackageFunction } from "../lang/go/symbols.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  literalString,
  positionalArguments,
} from "../lang/treesitter/ast.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

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
  StatusNotImplemented: "501",
  StatusBadGateway: "502",
  StatusServiceUnavailable: "503",
  StatusGatewayTimeout: "504",
  StatusHTTPVersionNotSupported: "505",
  StatusInsufficientStorage: "507",
};

function selectorCall(node: TsNode): { receiver: TsNode; method: string } | null {
  if (node.type !== "call_expression") return null;
  const selector = node.namedChildren[0];
  if (!selector || selector.type !== "selector_expression") return null;
  const receiver = selector.namedChildren[0];
  const field = selector.namedChildren[1];
  if (!receiver || !field || field.type !== "field_identifier") return null;
  return { receiver, method: field.text };
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

/** Fiber uses :id and *wildcard; convert to OpenAPI {id}. */
function fiberPathToOas(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
      params.push(name);
      return `{${name}}`;
    })
    .replace(/\*([A-Za-z0-9_]*)/g, (_m, name: string) => {
      if (name) params.push(name);
      return "{wildcard}";
    });
  return { path: converted, params };
}

function joinPath(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/\/$/, "");
  if (!path || path === "/") return cleanPrefix || "/";
  const cleanPath = path.replace(/^\//, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanPath}` : `/${cleanPath}`;
}

function operationId(method: string, path: string): string {
  const parts = path
    .replace(/[{}*:]/g, "")
    .split(/[/\-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return method.toLowerCase() + parts.join("");
}

function addrToUrl(addr: string): string {
  const port = addr.match(/:(\d+)/)?.[1];
  return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
}

function referencedType(arg: TsNode | undefined, body: TsNode): TsNode | null {
  if (!arg) return null;
  const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
  if (!target || target.type !== "identifier") return null;
  const local = resolveLocalType(body, target.text);
  if (local) return local;
  // in := new(ItemInput) — derive the type from the new(T) call.
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
    const left = decl.namedChildren.find((c) => c.type === "expression_list");
    const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
    const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
    if (!left || !right) continue;
    const at = left.namedChildren.findIndex((c) => c.text === target.text);
    if (at < 0) continue;
    const value = right.namedChildren[at];
    if (value && value.type === "call_expression") {
      const callee = value.namedChildren[0];
      if (callee && callee.type === "identifier" && callee.text === "new") {
        return positionalArguments(value)[0] ?? null;
      }
    }
  }
  return null;
}

interface RouteSite {
  method: string;
  path: string;
  params: string[];
  handler: TsNode | null;
  origin: SourceLocation;
}

/** Resolve a c.JSON payload to a schema (constructor / local var / literal). */
function payloadSchema(
  arg: TsNode | undefined,
  body: TsNode | null,
  analysis: GoAnalysis,
  index: GoModelIndex,
  depth = 0,
): JsonSchema | null {
  if (!arg || depth > 8) return null;
  if (arg.type === "unary_expression") return payloadSchema(arg.namedChildren[0], body, analysis, index, depth + 1);
  if (arg.text === "nil") return { type: "null" };
  if (arg.type === "call_expression") {
    return resolveGoPayloadValue(arg, body, analysis, index, analysis.vars).schema;
  }
  if (arg.type === "identifier") {
    if (body) {
      const typeNode = referencedType(arg, body);
      if (typeNode) return fiberTypeSchema(typeNode, analysis, index);
    }
    return null;
  }
  if (arg.type === "composite_literal") {
    const typeNode = arg.namedChildren[0];
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      return goConstructedTypeToSchema(typeNode, index);
    }
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && (t.type === "qualified_type" || t.type === "type_identifier" && index.byName.has(t.text))) {
      const reference = goTypeToSchema(t, index);
      const alias = typeof reference.$ref === "string" ? reference.$ref.split('/').at(-1) : undefined;
      if (!alias) return reference;
      const definition = index.byName.get(alias)!;
      const base = index.components.get(alias)!;
      const properties = { ...(base.properties as Record<string, JsonSchema> ?? {}) };
      let specialized = false;
      const literal = arg.namedChildren.find(n => n.type === "literal_value");
      for (const entry of literal?.namedChildren ?? []) {
        if (entry.type !== "keyed_element") continue;
        const name = entry.namedChildren[0]?.namedChildren[0]?.text;
        const field = definition.fields.find(field => field.goName === name && field.typeNode.type === "interface_type");
        if (!field) continue;
        const key = jsonTag(field).name ?? field.goName;
        const value = entry.namedChildren[1]?.namedChildren[0];
        const schema = payloadSchema(value, body, analysis, index, depth + 1);
        if (schema && Object.keys(schema).length) { properties[key] = schema; specialized = true; }
      }
      return specialized ? {...base, properties} : reference;
    }
  }
  return null;
}

function hasOpaqueFields(schema: JsonSchema, index: GoModelIndex, seen = new Set<string>()): boolean {
  if (!Object.keys(schema).length || schema["x-code-to-openapi-unresolved-embedded"]) return true;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return false;
    const target = index.components.get(schema.$ref.split("/").pop()!);
    return !target || hasOpaqueFields(target, index, new Set(seen).add(schema.$ref));
  }
  const children = [...Object.values(schema.properties ?? {}), ...(schema.items && !Array.isArray(schema.items) ? [schema.items] : [])];
  return children.some(child => child && typeof child === "object" && hasOpaqueFields(child as JsonSchema, index, seen));
}

interface Evidence {
  parameters: RouteParameter[];
  requestBody: RouteCandidate["requestBody"];
  responses: RouteCandidate["responses"];
  gaps: Set<GapCode>;
}

function analyzeFiberHandler(
  fn: GoFunction,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  inputModel: GoModelIndex,
  declaredParams: string[],
): Evidence {
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const body = fn.body;
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  const addResponse = (status: string, response: RouteCandidate["responses"][number]) => {
    const previous = responseStatus.get(status);
    responseStatus.set(status, previous ? mergeResponseVariants(previous, response) : response);
  };

  const parameterList = fn.node.namedChildren.find(n => n.type === "parameter_list");
  const contextNames = new Set(parameterList ? findAll(parameterList, n => n.type === "parameter_declaration" && /\b\w+\.Ctx\b/.test(n.text))
    .flatMap(n => n.namedChildren.filter(c => c.type === "identifier").map(c => c.text)) : []);
  const contextReceiver = (receiver: TsNode): boolean => {
    let node: TsNode | undefined = receiver;
    for (let hops = 0; node && hops < 20; hops++) {
      if (node.type === "identifier") return contextNames.has(node.text);
      if (node.type !== "call_expression") return false;
      node = selectorCall(node)?.receiver;
    }
    return false;
  };
  const responseCode = (receiver: TsNode): string => {
    let current: TsNode | undefined = receiver;
    for (let depth = 0; current?.type === "call_expression" && depth < 20; depth++) {
      const selected = selectorCall(current);
      if (!selected) break;
      if (selected.method === "Status") {
        const status = statusCode(positionalArguments(current)[0]);
        if (!status) gaps.add("response-unknown");
        return status ?? "default";
      }
      current = selected.receiver;
    }
    return "200";
  };
  if (body) {
    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      let owner = call.parent;
      while (owner && owner.id !== body.id && owner.type !== "func_literal") owner = owner.parent;
      if (owner?.type === "func_literal") continue;
      const sel = selectorCall(call);
      if (!sel || (contextNames.size && !contextReceiver(sel.receiver))) continue;
      const args = positionalArguments(call);

      if (sel.method === "Params") {
        const name = literalString(args[0]);
        if (name && declaredParams.includes(name) && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      if (sel.method === "Query") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "query", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      // c.Get("X-Trace") reads a request header.
      if (sel.method === "Get") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "header", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      if (sel.method === "Cookies") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({ name, in: "cookie", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      const bindBody = sel.method === "Body" && sel.receiver.type === "call_expression" && selectorCall(sel.receiver)?.method === "Bind";
      if ((sel.method === "BodyParser" || bindBody) && args[0]) {
        const typeNode = referencedType(args[0], body);
        if (typeNode) {
          const schema = fiberTypeSchema(typeNode, analysis, inputModel);
          if (hasOpaqueFields(schema, inputModel)) gaps.add("body-schema-unknown");
          requestBody = {
            required: true,
            confidence: "high",
            content: [{ mediaType: "application/json", schema, confidence: hasOpaqueFields(schema, inputModel) ? "low" : "high" }],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      // c.JSON(payload) or c.Status(code).JSON(payload).
      if (sel.method === "JSON") {
        const status = responseCode(sel.receiver);
        const payloadArg = args[0];
        const schema = payloadSchema(payloadArg, body, analysis, modelIndex);
        const mergedSchema = schema ?? {};
        addResponse(status, {
          statusCode: status,
          description: "",
          confidence: schema && !hasOpaqueFields(schema, modelIndex) ? "high" : "low",
          ...(mergedSchema
            ? { content: [{ mediaType: "application/json", schema: mergedSchema, confidence: "high" }] }
            : {}),
        });
        if (!schema || hasOpaqueFields(schema, modelIndex)) gaps.add("response-schema-unknown");
        continue;
      }

      if (sel.method === "SendString" || sel.method === "SendStatus") {
        const status = sel.method === "SendStatus" ? statusCode(args[0]) ?? "default" : responseCode(sel.receiver);
        if (status === "default") gaps.add("response-unknown");
        {
          addResponse(status, {
            statusCode: status,
            description: "",
            confidence: "high",
            content: [{ mediaType: "text/plain", schema: { type: "string" }, confidence: "high" }],
          });
        }
        continue;
      }

      if (sel.method === "SendFile" || sel.method === "Download") {
        const status = responseCode(sel.receiver);
        {
          addResponse(status, {
            statusCode: status,
            description: "",
            confidence: "high",
            content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" }, confidence: "medium" }],
          });
        }
        continue;
      }
    }

    for (const name of declaredParams) {
      if (!parameters.some((p) => p.name === name && p.in === "path")) {
        parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
      }
    }
  } else {
    for (const name of declaredParams) {
      parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
    }
    gaps.add("response-unknown");
  }

  if (responseStatus.size === 0) gaps.add("response-unknown");

  return { parameters, requestBody, responses: [...responseStatus.values()], gaps };
}

export const fiberPack: FrameworkPack<GoAnalysis> = {
  id: "fiber",
  language: "go",
  dependencyHints: ["github.com/gofiber/fiber/v2", "github.com/gofiber/fiber"],

  applies(ctx) {
    if (
      ctx.manifest.packages.has("github.com/gofiber/fiber/v2") ||
      ctx.manifest.packages.has("github.com/gofiber/fiber")
    ) {
      return true;
    }
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /gofiber\/fiber/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const inputModel: GoModelIndex = { ...modelIndex, input: true, components: new Map() };
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    // Router/group variables are resolved PER FUNCTION. Local names such as
    // `r := app.Group("/auth")` and `r := app.Group("/todo")` in two setup
    // functions must not leak prefixes into each other.
    const scopeCache = new Map<TsNode, Map<string, string>>();

    const enclosingFunction = (node: TsNode): TsNode | null => {
      let cur: TsNode | null = node;
      while (cur) {
        if (
          cur.type === "function_declaration" ||
          cur.type === "method_declaration" ||
          cur.type === "func_literal"
        ) {
          return cur;
        }
        cur = cur.parent;
      }
      return null;
    };

    const isRouterType = (typeNode: TsNode | undefined | null): boolean =>
      !!typeNode && /fiber\.(Router|App|Group)|gofiber\/fiber/.test(typeNode.text);

    const buildScope = (fnNode: TsNode): Map<string, string> => {
      const cached = scopeCache.get(fnNode);
      if (cached) return cached;
      const scope = new Map<string, string>();

      // Router-typed parameters are roots (prefix "") inside this function.
      for (const paramList of findAll(fnNode, (n) => n.type === "parameter_list")) {
        if (paramList.parent !== fnNode && paramList.parent?.type !== "function_type" &&
            !["function_declaration", "method_declaration", "func_literal"].includes(paramList.parent?.type ?? "")) {
          continue;
        }
        for (const decl of childrenOfType(paramList, "parameter_declaration")) {
          const typeNode = decl.namedChildren.find((c: TsNode) => /type|pointer|qualified|selector/.test(c.type));
          const names = decl.namedChildren.filter((c: TsNode) => c.type === "identifier");
          if (isRouterType(typeNode)) for (const nameNode of names) scope.set(nameNode.text, "");
        }
      }

      interface GroupDecl {
        name: string;
        parent: string;
        prefix: string;
      }
      const groups: GroupDecl[] = [];
      for (const decl of findAll(fnNode, (n) => n.type === "short_var_declaration" || n.type === "var_declaration")) {
        const left = decl.namedChildren.find((c) => c.type === "expression_list");
        const right = decl.namedChildren.filter((c) => c.type === "expression_list").pop();
        if (!left || !right) continue;
        const names = left.namedChildren.filter((c) => c.type === "identifier");
        for (const call of findAll(right, (c) => c.type === "call_expression")) {
          const sel = selectorCall(call);
          if (!sel || sel.receiver.type !== "identifier") continue;
          if (sel.receiver.text === "fiber" && sel.method === "New") {
            const target = names[0];
            if (target) scope.set(target.text, "");
          }
          if (sel.method === "Group") {
            const prefix = literalString(positionalArguments(call)[0]) ?? "";
            const target = names[0];
            if (target) groups.push({ name: target.text, parent: sel.receiver.text, prefix });
          }
        }
      }

      let grew = true;
      let guard = 0;
      while (grew && guard < 16) {
        grew = false;
        guard++;
        for (const g of groups) {
          const parentPrefix = scope.has(g.parent) ? scope.get(g.parent)! : null;
          if (parentPrefix === null) continue;
          const resolved = joinPath(parentPrefix, g.prefix);
          if (scope.get(g.name) !== resolved) {
            scope.set(g.name, resolved);
            grew = true;
          }
        }
      }
      scopeCache.set(fnNode, scope);
      return scope;
    };

    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel || sel.receiver.type !== "identifier") continue;
        const ownerFn = enclosingFunction(call);
        const scope = ownerFn ? buildScope(ownerFn) : null;
        const prefix = scope?.get(sel.receiver.text);
        if (prefix === undefined) continue;
        const verb = sel.method.toLowerCase();
        if (!VERBS.has(verb)) continue;
        const args = positionalArguments(call);
        const rawPath = args[0] ? literalString(args[0]) : null;
        if (rawPath === null) {
          if (args[0]) {
            unresolved.push({
              reason: "dynamic-path",
              message: "Fiber route path is not a static string literal",
              origin: { file: file.path, line: call.startPosition.row + 1 },
            });
          }
          continue;
        }
        const { path, params } = fiberPathToOas(rawPath);
        sites.push({
          method: verb,
          path: joinPath(prefix, path),
          params,
          handler: args[1] ?? null,
          origin: { file: file.path, line: call.startPosition.row + 1 },
        });
      }

      // Server: app.Listen(":8080").
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (sel.method !== "Listen" || sel.receiver.type !== "identifier") continue;
        const ownerFn = enclosingFunction(call);
        if (ownerFn && !buildScope(ownerFn).has(sel.receiver.text)) continue;
        const addr = literalString(positionalArguments(call)[0]);
        if (addr) servers.add(addrToUrl(addr));
      }
    }

    for (const site of sites) {
      const handlerNode = site.handler;
      let fn: GoFunction | null = null;
      if (handlerNode?.type === "func_literal") {
        const block = findFirst(handlerNode, (c) => c.type === "block");
        if (block) {
          fn = { name: "<anonymous>", file: site.origin.file, node: handlerNode, body: block, receiver: null };
        }
      } else if (handlerNode) {
        let name: string | null = null;
        let qualifier: string | undefined;
        if (handlerNode.type === "identifier") {
          name = handlerNode.text;
        } else if (handlerNode.type === "selector_expression") {
          const field = handlerNode.namedChildren[1];
          const receiver = handlerNode.namedChildren[0];
          name = field?.type === "field_identifier" ? field.text : null;
          if (receiver?.type === "identifier") qualifier = receiver.text;
        }
        if (name) {
          const owner = analysis.files.get(site.origin.file);
          fn =
            resolveGoPackageFunction(analysis, owner, qualifier, name) ??
            analysis.methods.find((m) => m.name === name) ??
            null;
        }
      }

      const evidence: Evidence = fn
        ? analyzeFiberHandler(fn, analysis, modelIndex, inputModel, site.params)
        : {
            parameters: site.params.map((name): RouteParameter => ({
              name,
              in: "path",
              required: true,
              schema: { type: "string" },
              confidence: "medium" as Confidence,
            })),
            requestBody: undefined,
            responses: [] as RouteCandidate["responses"],
            gaps: new Set<GapCode>(["response-unknown"]),
          };

      const confidence: Confidence = evidence.gaps.size > 0 ? "medium" : "high";
      routes.push({
        method: site.method,
        path: site.path,
        fullPath: site.path,
        origin: site.origin,
        operationId: operationId(site.method, site.path),
        tags: [],
        parameters: evidence.parameters,
        ...(evidence.requestBody ? { requestBody: evidence.requestBody } : {}),
        responses: evidence.responses,
        confidence,
        gaps: [...evidence.gaps],
        components: [],
        handlerSource: fn?.node.text.slice(0, 8192),
      });
    }

    const inputComponents = namespaceComponents(inputModel.components, new Set([...modelIndex.byName.keys(), ...modelIndex.components.keys()]), "input");
    for (const route of routes) if (route.requestBody) route.requestBody = remapSchemaReferences(route.requestBody, inputComponents.names);
    return {
      routes: dedupeRoutes(routes),
      unresolved,
      components: [...[...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })), ...inputComponents.components],
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

function dedupeRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (c: RouteCandidate) =>
      c.parameters.length * 2 + c.responses.length * 3 + (c.requestBody ? 4 : 0) - c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}
