/**
 * Gin framework pack (Go).
 *
 * Deterministic gates:
 *  - receivers must trace through gin.New()/gin.Default() and .Group() chains;
 *  - route paths must be static string literals;
 *  - handler bodies are resolved to package-level functions;
 *  - request/response evidence comes from ShouldBind/Param/Query/JSON calls;
 *  - everything unproven is recorded as an explicit gap, never invented.
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
import { formTag } from "../lang/go/index.js";
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
  StatusContinue: "100",
  StatusOK: "200",
  StatusCreated: "201",
  StatusAccepted: "202",
  StatusNoContent: "204",
  StatusMovedPermanently: "301",
  StatusFound: "302",
  StatusNotModified: "304",
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
};

interface Instance {
  id: string;
  file: string;
  name: string;
  prefix: string;
}

function selectorCall(node: TsNode): { receiver: TsNode; method: string; call: TsNode } | null {
  if (node.type !== "call_expression") return null;
  const selector = node.namedChildren[0];
  const args = node.namedChildren[1];
  if (!selector || selector.type !== "selector_expression" || !args || args.type !== "argument_list") {
    return null;
  }
  const receiver = selector.namedChildren[0];
  const field = selector.namedChildren[1];
  if (!receiver || !field || field.type !== "field_identifier") return null;
  return { receiver, method: field.text, call: node };
}

function callName(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field?.text ?? null;
  }
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

/** Literal composite values (gin.H maps, slices, struct literals). */
function literalSchema(node: TsNode | null, index: GoModelIndex, depth = 0): JsonSchema | null {
  if (!node || depth > 6) return null;

  if (node.type === "unary_expression") {
    return literalSchema(node.namedChildren[0], index, depth + 1);
  }

  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    const value = node.namedChildren[1];

    // Empty slice literal: []Type{} -> array of $ref.
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      const inner = typeNode.namedChildren[0];
      if (inner) return { type: "array", items: goTypeToSchema(inner, index, depth + 1) };
      return { type: "array", items: {} };
    }

    // Named struct literal: Type{} -> $ref (or inline for anonymous structs).
    if (typeNode && typeNode.type === "type_identifier") {
      if (index.byName.has(typeNode.text)) {
        ensureGoComponent(typeNode.text, index);
        return { $ref: `#/components/schemas/${typeNode.text}` };
      }
      return {};
    }

    // gin.H{...} (selector type) or map literal.
    const properties: Record<string, JsonSchema> = {};
    const elements = value
      ? childrenOfType(value, "keyed_element")
      : [];
    for (const element of elements) {
      const keyNode = unwrapElement(element.namedChildren[0]);
      const valNode = unwrapElement(element.namedChildren[1]);
      if (!keyNode || !valNode) continue;
      const keyText = literalString(keyNode);
      if (!keyText) continue;
      properties[keyText] = scalarLiteral(valNode) ?? literalSchema(valNode, index, depth + 1) ?? {};
    }
    if (value && Object.keys(properties).length > 0) return { type: "object", properties };
    if (typeNode && typeNode.type === "selector_expression") return { type: "object" };
    return null;
  }

  return null;
}

function unwrapElement(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  return node.type === "literal_element" ? node.namedChildren[0] ?? node : node;
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

function ginPathToOas(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
      params.push(name);
      return `{${name}}`;
    })
    .replace(/\*([A-Za-z0-9_]+)/g, (_match, name) => {
      params.push(name);
      return `{${name}}`;
    });
  return { path: converted, params };
}

function analyzeHandler(
  fn: GoFunction,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  routeParams: string[],
): {
  parameters: RouteParameter[];
  requestBody: RouteCandidate["requestBody"];
  responses: RouteCandidate["responses"];
  security: RouteCandidate["security"];
  gaps: Set<GapCode>;
  extensions: RouteCandidate["extensions"];
  components: RouteCandidate["components"];
} {
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const body = fn.body;
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();

  const addResponse = (status: string, response: RouteCandidate["responses"][number]) => {
    responseStatus.set(status, response);
  };

  const referencedVarType = (arg: TsNode | undefined): TsNode | null => {
    if (!arg) return null;
    const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
    if (!target || target.type !== "identifier") return null;
    return resolveLocalType(body, target.text);
  };

  if (body) {
    const calls = findAll(body, (n) => n.type === "call_expression");
    let isSse = false;

    for (const call of calls) {
      const sel = selectorCall(call);
      if (!sel) continue;
      if (sel.receiver.type !== "identifier") continue;
      const args = positionalArguments(sel.call);
      const method = sel.method;

      if (method === "Param" && args[0]) {
        const name = literalString(args[0]);
        if (name && routeParams.includes(name) && !parameters.some((p) => p.name === name)) {
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

      if (method === "Query" || method === "DefaultQuery") {
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

      if (method === "GetHeader" || method === "Header") {
        // c.Header is used both for reading and writing; GetHeader is the read.
        if (method === "GetHeader") {
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
        }
        continue;
      }

      if ((method === "ShouldBindJSON" || method === "BindJSON" || method === "ShouldBind") && args[0]) {
        const typeNode = referencedVarType(args[0]);
        if (typeNode) {
          const schema =
            typeNode.type === "type_identifier"
              ? goTypeToSchema(typeNode, modelIndex)
              : goTypeToSchema(typeNode, modelIndex);
          if (typeNode.type === "struct_type") {
            // Anonymous struct: inline.
          }
          addBody(schema);
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      if ((method === "ShouldBindQuery" || method === "BindQuery") && args[0]) {
        const typeNode = referencedVarType(args[0]);
        if (typeNode?.type === "type_identifier") {
          const struct = modelIndex.byName.get(typeNode.text);
          if (struct) {
            for (const field of struct.fields) {
              const name = formTag(field) ??
                field.goName.charAt(0).toLowerCase() + field.goName.slice(1);
              const required = /binding:"[^"]*required/.test(field.tag ?? "");
              parameters.push({
                name,
                in: "query",
                required,
                schema: goTypeToSchema(field.typeNode, modelIndex),
                confidence: "high",
              });
            }
          }
        }
        continue;
      }

      if (method === "SSEvent") {
        isSse = true;
        continue;
      }

      if (method === "Stream") {
        const hasEventStream = calls.some((other) => {
          const otherSel = selectorCall(other);
          if (!otherSel || otherSel.method !== "Header") return false;
          const headerArgs = positionalArguments(other);
          return (
            literalString(headerArgs[0]) === "Content-Type" &&
            (literalString(headerArgs[1]) ?? "").includes("text/event-stream")
          );
        });
        if (hasEventStream) isSse = true;
        continue;
      }

      if (method === "JSON" || method === "IndentedJSON" || method === "PureJSON") {
        const status = statusCode(args[0]) ?? "200";
        let schema: JsonSchema | null = null;
        const payload = args[1];
        if (payload) {
          if (payload.type === "identifier") {
            const typeNode = resolveLocalType(body, payload.text);
            if (typeNode) schema = goTypeToSchema(typeNode, modelIndex);
          } else {
            schema = literalSchema(payload, modelIndex);
          }
        }
        addResponse(status, {
          statusCode: status,
          description: "",
          confidence: schema ? "high" : "medium",
          ...(schema
            ? { content: [{ mediaType: "application/json", schema, confidence: schema ? "high" : "medium" }] }
            : {}),
        });
        if (!schema) gaps.add("response-schema-unknown");
        continue;
      }

      if (method === "Status") {
        const status = statusCode(args[0]);
        if (status) {
          addResponse(status, { statusCode: status, description: "", confidence: "high" });
        }
        continue;
      }
    }

    // Declared path params never read via c.Param are still valid (middleware).
    for (const name of routeParams) {
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

    if (isSse) {
      addResponse("200", {
        statusCode: "200",
        description: "Server-Sent Events stream",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: {}, confidence: "medium" }],
      });
      gaps.add("sse-events-unknown");
    }
  }

  function addBody(schema: JsonSchema) {
    requestBody = {
      required: true,
      confidence: "high",
      content: [{ mediaType: "application/json", schema, confidence: "high" }],
    };
  }

  if (responsesEmpty(responseStatus)) {
    gaps.add("response-unknown");
  }

  return {
    parameters,
    requestBody,
    responses: [...responseStatus.values()],
    security: undefined,
    gaps,
    extensions: isSseExtension(responseStatus),
    components: [],
  };
}

function isSseExtension(
  responses: Map<string, RouteCandidate["responses"][number]>,
): RouteCandidate["extensions"] {
  for (const response of responses.values()) {
    if (response.content?.some((media) => media.mediaType === "text/event-stream")) {
      return { "x-protocol": "sse" };
    }
  }
  return undefined;
}

function responsesEmpty(responses: Map<string, unknown>): boolean {
  return responses.size === 0;
}

function operationId(method: string, path: string): string {
  const parts = path
    .replace(/[{}*:]/g, "")
    .split(/[/\-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return method.toLowerCase() + parts.join("");
}

export const ginPack: FrameworkPack<GoAnalysis> = {
  id: "gin",
  language: "go",
  dependencyHints: ["github.com/gin-gonic/gin"],

  applies(ctx) {
    if (ctx.manifest.packages.has("github.com/gin-gonic/gin")) return true;
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /gin-gonic\/gin/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const servers = new Set<string>();

    for (const file of analysis.files.values()) {
      const instances = new Map<string, Instance>();

      const registerInstance = (name: string, prefix: string) => {
        instances.set(name, { id: `${file.path}::${name}`, file: file.path, name, prefix });
      };

      // Pass 1: engines and groups.
      for (const declaration of findAll(file.root, (n) =>
        n.type === "short_var_declaration" || n.type === "var_declaration" || n.type === "assignment_statement",
      )) {
        const assignments = declaration.type === "var_declaration"
          ? childrenOfType(declaration, "var_spec")
          : [declaration];

        for (const spec of assignments) {
          const names = findAll(spec, (n) => n.type === "identifier");
          const calls = findAll(spec, (n) => n.type === "call_expression");
          for (const call of calls) {
            const sel = selectorCall(call);
            if (!sel || sel.receiver.type !== "identifier") continue;
            const args = positionalArguments(call);

            if (sel.receiver.text === "gin" && (sel.method === "New" || sel.method === "Default")) {
              const name = names[0]?.text;
              if (name) registerInstance(name, "");
            } else if (sel.method === "Group") {
              const parent = instances.get(sel.receiver.text);
              const name = names[0]?.text;
              if (parent && name) {
                const groupPath = literalString(args[0]) ?? "";
                registerInstance(name, joinPath(parent.prefix, groupPath));
              }
            }
          }
        }
      }

      // Pass 2: routes.
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel || sel.receiver.type !== "identifier") continue;
        const instance = instances.get(sel.receiver.text);
        if (!instance) continue;
        const args = positionalArguments(call);

        const methods: string[] = [];
        let pathNode: TsNode | undefined;
        if (HTTP_METHODS.has(sel.method.toLowerCase())) {
          methods.push(sel.method.toLowerCase());
          pathNode = args[0];
        } else if (sel.method === "Any") {
          methods.push(...HTTP_METHODS);
          pathNode = args[0];
        } else if (sel.method === "Handle") {
          const verb = literalString(args[0])?.toLowerCase();
          if (verb && HTTP_METHODS.has(verb)) methods.push(verb);
          pathNode = args[1];
        } else {
          continue;
        }

        const rawPath = pathNode ? literalString(pathNode) : null;
        if (rawPath === null) {
          if (pathNode) {
            unresolved.push({
              reason: "dynamic-path",
              message: "Gin route path is not a static string literal",
              origin: { file: file.path, line: call.startPosition.row + 1 },
            });
          }
          continue;
        }

        const converted = ginPathToOas(rawPath);
        const fullPath = joinPath(instance.prefix, converted.path);
        const handlerRefs = args.slice(pathNode === args[0] ? 1 : 2).filter((a) => a.type === "identifier");
        const primaryHandler = handlerRefs[0]?.text;
        const handlerFn = primaryHandler
          ? analysis.functions.get(primaryHandler)?.[0]
          : undefined;

        const origin: SourceLocation = {
          file: file.path,
          line: call.startPosition.row + 1,
          symbol: primaryHandler,
        };

        for (const method of methods) {
          const analyzed = handlerFn
            ? analyzeHandler(handlerFn, analysis, modelIndex, converted.params)
            : {
                parameters: converted.params.map((name) => ({
                  name,
                  in: "path" as const,
                  required: true,
                  schema: { type: "string" },
                  confidence: "medium" as Confidence,
                })),
                requestBody: undefined,
                responses: [] as RouteCandidate["responses"],
                security: undefined,
                gaps: new Set<GapCode>(["response-unknown"]),
                extensions: undefined,
                components: [] as RouteCandidate["components"],
              };

          const confidence: Confidence = analyzed.gaps.size > 0 ? "medium" : "high";
          routes.push({
            method,
            path: fullPath,
            fullPath,
            origin,
            operationId: operationId(method, fullPath),
            tags: [],
            parameters: analyzed.parameters,
            ...(analyzed.requestBody ? { requestBody: analyzed.requestBody } : {}),
            responses: analyzed.responses,
            ...(analyzed.security?.length ? { security: analyzed.security } : {}),
            ...(analyzed.extensions ? { extensions: analyzed.extensions } : {}),
            confidence,
            gaps: [...analyzed.gaps],
            components: analyzed.components,
            handlerSource: handlerFn?.node.text.slice(0, 8192),
          });
        }
      }

      // Server detection: r.Run(":8080") or http.ListenAndServe(addr, engine).
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        const args = positionalArguments(call);
        if (sel.method === "Run" && instances.has(sel.receiver.text)) {
          const addr = literalString(args[0]);
          if (addr) servers.add(addrToUrl(addr));
        }
        if (
          sel.receiver.type === "identifier" &&
          sel.receiver.text === "http" &&
          sel.method === "ListenAndServe"
        ) {
          const addr = literalString(args[0]);
          if (addr) servers.add(addrToUrl(addr));
        }
      }
    }

    return {
      routes: dedupe(routes),
      unresolved,
      components: [...modelIndex.components.entries()].map(([name, schema]) => ({
        name,
        schema,
      })),
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (candidate: RouteCandidate) =>
      candidate.parameters.length * 2 +
      candidate.responses.length * 3 +
      (candidate.requestBody ? 4 : 0) -
      candidate.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path || "/";
  if (!path) return prefix;
  return `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function addrToUrl(addr: string): string {
  const match = addr.match(/(?::(\d+))?/);
  const port = match?.[1];
  return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
}
