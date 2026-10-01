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
import {
  buildGoModelIndex,
  ensureGoComponent,
  goTypeToSchema,
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
      const inner = typeNode.namedChildren[0];
      return {
        type: "array",
        items: inner ? goTypeToSchema(inner, index, depth + 1) : {},
      };
    }
    if (typeNode && typeNode.type === "type_identifier") {
      if (index.byName.has(typeNode.text)) {
        ensureGoComponent(typeNode.text, index);
        return { $ref: `#/components/schemas/${typeNode.text}` };
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
  if (!prefix) return path || "/";
  if (!path) return prefix;
  return `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
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
      ) => {
        if (visited.has(scope)) return;
        visited.add(scope);
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

        const handleCall = (call: TsNode) => {
          const sel = selectorCall(call);
          if (!sel || sel.receiver.type !== "identifier" || sel.receiver.text !== receiverName) {
            return;
          }
          const args = positionalArguments(call);

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
            sites.push({
              method: sel.method.toLowerCase(),
              path: joinPath(prefix, rawPath),
              handlerName: handler?.type === "identifier" ? handler.text : null,
              handlerNode: handler?.type === "func_literal" ? handler : null,
              origin: { file: file.path, line: call.startPosition.row + 1 },
            });
            return;
          }

          if (sel.method === "Route" || sel.method === "Group") {
            const nestedPrefix = literalString(args[0]);
            const funcLiteral = args.find((a) => a.type === "func_literal");
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
              const factory = factoryName
                ? analysis.functions.get(factoryName)?.find((fn) => fn.file === file.path)
                : undefined;
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
            return list?.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text) ?? [];
          });
        for (const routerName of routersInBody(fn.body)) {
          if (returnNames.includes(routerName)) {
            collectCalls(fn.body, routerName, prefix, visited);
          }
        }
      };

      // Entry points: routers declared in main-like top-level functions.
      for (const fn of file.root.namedChildren.filter((c) => c.type === "function_declaration")) {
        const name = fn.namedChildren[0];
        const body = fn.namedChildren.find((c) => c.type === "block");
        if (!body) continue;
        const isMain = name?.type === "identifier" && name.text === "main";
        if (!isMain) continue;
        for (const routerName of routersInBody(body)) {
          collectCalls(body, routerName, "", new Set());
        }
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
    }

    const routes = sites.map((site) => buildRoute(site, analysis, modelIndex));
    return {
      routes,
      unresolved,
      components: [...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })),
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

function buildRoute(
  site: RouteSite,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const declaredParams = pathParams(site.path);
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  let isSse = false;

  const namedFn = site.handlerName
    ? analysis.functions.get(site.handlerName)?.[0]
    : undefined;
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

  if (body) {
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
            schema: { type: "string" },
            confidence: "high",
          });
        }
        continue;
      }

      // r.URL.Query().Get("q")
      if (sel.method === "Get" && call.text.includes(".URL.Query()")) {
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

      // json.NewDecoder(r.Body).Decode(&x)
      if (sel.method === "Decode" && call.text.includes("NewDecoder")) {
        const typeNode = referencedType(args[0], body);
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [
              { mediaType: "application/json", schema: goTypeToSchema(typeNode, modelIndex), confidence: "high" },
            ],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
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
    }

    // json.NewEncoder(w).Encode(x): status follows statement order within
    // each block, so a WriteHeader inside an if-branch cannot leak to the
    // handler's main flow.
    collectEncodeResponses(body, modelIndex, (status, schema) => {
      const existing = responseStatus.get(status);
      if (existing?.content) return;
      responseStatus.set(status, {
        statusCode: status,
        description: "",
        confidence: schema ? "high" : "medium",
        ...(schema
          ? { content: [{ mediaType: "application/json", schema, confidence: "high" }] }
          : {}),
      });
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
