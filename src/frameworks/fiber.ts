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
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import {
  buildGoModelIndex,
  ensureGoComponent,
  goTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  type GoModelIndex,
} from "../lang/go/schema.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
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
): JsonSchema | null {
  if (!arg) return null;
  if (arg.type === "call_expression") {
    return resolveGoPayloadValue(arg, body, analysis, index, analysis.vars).schema;
  }
  if (arg.type === "identifier") {
    if (body) {
      const typeNode = resolveLocalType(body, arg.text);
      if (typeNode) return goTypeToSchema(typeNode, index);
    }
    return null;
  }
  if (arg.type === "composite_literal") {
    const typeNode = arg.namedChildren[0];
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      const inner = typeNode.namedChildren[0];
      if (inner) {
        let t: TsNode | undefined = inner;
        while (t && t.type === "pointer_type") t = t.namedChildren[0];
        if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
          ensureGoComponent(t.text, index);
          return { type: "array", items: { $ref: `#/components/schemas/${t.text}` } };
        }
      }
      return { type: "array" };
    }
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
      ensureGoComponent(t.text, index);
      return { $ref: `#/components/schemas/${t.text}` };
    }
  }
  return null;
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
  declaredParams: string[],
): Evidence {
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const body = fn.body;
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();

  if (body) {
    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (!sel) continue;
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

      if (sel.method === "BodyParser" && args[0]) {
        const typeNode = referencedType(args[0], body);
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [{ mediaType: "application/json", schema: goTypeToSchema(typeNode, modelIndex), confidence: "high" }],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      // c.JSON(payload) or c.Status(code).JSON(payload).
      if (sel.method === "JSON") {
        let status = "200";
        let payloadArg = args[0];
        if (sel.receiver.type === "call_expression") {
          const up = selectorCall(sel.receiver);
          if (up && up.method === "Status") {
            status = statusCode(positionalArguments(sel.receiver)[0]) ?? "200";
          }
        }
        const schema = payloadSchema(payloadArg, body, analysis, modelIndex);
        responseStatus.set(status, {
          statusCode: status,
          description: "",
          confidence: schema ? "high" : "medium",
          ...(schema
            ? { content: [{ mediaType: "application/json", schema, confidence: "high" }] }
            : {}),
        });
        if (!schema) gaps.add("response-schema-unknown");
        continue;
      }

      if (sel.method === "SendString") {
        if (!responseStatus.has("200")) {
          responseStatus.set("200", {
            statusCode: "200",
            description: "",
            confidence: "high",
            content: [{ mediaType: "text/plain", schema: { type: "string" }, confidence: "high" }],
          });
        }
        continue;
      }

      if (sel.method === "SendFile" || sel.method === "Download") {
        if (!responseStatus.has("200")) {
          responseStatus.set("200", {
            statusCode: "200",
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
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    // Fiber apps and groups: name -> prefix.
    const appVars = new Map<string, string>();
    const groupDecls: Array<{ name: string; parent: string; prefix: string }> = [];

    for (const file of analysis.files.values()) {
      for (const decl of findAll(file.root, (n) => n.type === "short_var_declaration")) {
        const left = decl.namedChildren.find((c) => c.type === "expression_list");
        const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
        const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
        if (!right) continue;
        for (const call of findAll(right, (c) => c.type === "call_expression")) {
          const sel = selectorCall(call);
          if (!sel) continue;
          const name = left?.namedChildren.find((c) => c.type === "identifier");
          // app := fiber.New()
          if (sel.receiver.type === "identifier" && sel.receiver.text === "fiber" && sel.method === "New") {
            if (name) appVars.set(name.text, "");
          }
          // grp := app.Group("/api")
          if (sel.method === "Group" && sel.receiver.type === "identifier" && name) {
            const prefix = literalString(positionalArguments(call)[0]) ?? "";
            groupDecls.push({ name: name.text, parent: sel.receiver.text, prefix });
          }
        }
      }
    }

    let grew = true;
    let guard = 0;
    while (grew && guard < 16) {
      grew = false;
      guard++;
      for (const g of groupDecls) {
        const parentPrefix = appVars.get(g.parent);
        if (parentPrefix === undefined) continue;
        const resolved = joinPath(parentPrefix, g.prefix);
        if (appVars.get(g.name) !== resolved) {
          appVars.set(g.name, resolved);
          grew = true;
        }
      }
    }

    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (sel.receiver.type !== "identifier" || !appVars.has(sel.receiver.text)) continue;
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
          path: joinPath(appVars.get(sel.receiver.text) ?? "", path),
          params,
          handler: args[1] ?? null,
          origin: { file: file.path, line: call.startPosition.row + 1 },
        });
      }

      // Server: app.Listen(":8080").
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (sel.method === "Listen" && sel.receiver.type === "identifier" && appVars.has(sel.receiver.text)) {
          const addr = literalString(positionalArguments(call)[0]);
          if (addr) servers.add(addrToUrl(addr));
        }
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
        const name =
          handlerNode.type === "identifier"
            ? handlerNode.text
            : handlerNode.type === "selector_expression"
              ? (handlerNode.namedChildren[1]?.type === "field_identifier"
                  ? handlerNode.namedChildren[1].text
                  : null)
              : null;
        if (name) {
          fn =
            (analysis.functions.get(name) ?? [])[0] ??
            analysis.methods.find((m) => m.name === name) ??
            null;
        }
      }

      const evidence: Evidence = fn
        ? analyzeFiberHandler(fn, analysis, modelIndex, site.params)
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

    return {
      routes: dedupeRoutes(routes),
      unresolved,
      components: [...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })),
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
