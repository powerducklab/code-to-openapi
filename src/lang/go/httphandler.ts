/**
 * Shared analysis for plain Go `func(w http.ResponseWriter, r *http.Request)`
 * handlers, used by the net/http and gorilla/mux packs. Echo and Fiber use
 * their own context objects (c.JSON / c.BodyParser) and are handled separately.
 *
 * Evidence model (never fabricated):
 *  - path params: r.PathValue("name") (Go 1.22) or a pack-supplied reader such
 *    as mux.Vars(r)["name"]; declared-but-unread params stay medium confidence.
 *  - query params: r.URL.Query().Get("q"), an aliased q.Get, r.FormValue.
 *  - headers/cookies: r.Header.Get / r.Cookie.
 *  - request body: json.NewDecoder(r.Body).Decode(&x) -> component $ref.
 *  - responses: w.WriteHeader(code) block-scoped around
 *    json.NewEncoder(w).Encode(x); w.Write([]byte(...)) -> text/plain 200;
 *    http.ServeFile -> octet-stream; http.Error -> plain-text status.
 *  - SSE: a text/event-stream Content-Type header.
 * Anything not statically provable becomes an explicit GapCode.
 */

import type { GapCode, RouteCandidate, RouteParameter } from "../../core/types.js";
import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoFunction } from "./index.js";
import {
  ensureGoComponent,
  goTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  type GoModelIndex,
} from "./schema.js";
import type { TsNode } from "../treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  literalString,
  positionalArguments,
} from "../treesitter/ast.js";

export const HTTP_STATUS: Record<string, string> = {
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

export function statusCodeOf(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "int_literal") return node.text.trim();
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field ? HTTP_STATUS[field.text] ?? null : null;
  }
  return null;
}

export function selectorCall(node: TsNode): { receiver: TsNode; method: string } | null {
  if (node.type !== "call_expression") return null;
  const selector = node.namedChildren[0];
  if (!selector || selector.type !== "selector_expression") return null;
  const receiver = selector.namedChildren[0];
  const field = selector.namedChildren[1];
  if (!receiver || !field || field.type !== "field_identifier") return null;
  return { receiver, method: field.text };
}

function unwrapElement(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  return node.type === "literal_element" ? node.namedChildren[0] ?? node : node;
}

export function scalarLiteral(node: TsNode): JsonSchema | null {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    return { type: "string" };
  }
  if (node.type === "int_literal") return { type: "integer" };
  if (node.type === "float_literal") return { type: "number" };
  if (node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "nil") return { type: "null" };
  return null;
}

/** Literal maps/slices/structs used as an inline JSON body. */
export function literalSchema(node: TsNode | null, index: GoModelIndex, depth = 0): JsonSchema | null {
  if (!node || depth > 6) return null;
  if (node.type === "unary_expression") {
    return literalSchema(node.namedChildren[0], index, depth + 1);
  }
  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    const value = node.namedChildren[1];
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      const inner = typeNode.namedChildren[0];
      return { type: "array", items: inner ? goTypeToSchema(inner, index, depth + 1) : {} };
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
        const keyText = keyNode ? literalString(keyNode) : null;
        if (!keyText || !valNode) continue;
        properties[keyText] = scalarLiteral(valNode) ?? literalSchema(valNode, index, depth + 1) ?? {};
      }
    }
    if (Object.keys(properties).length > 0) return { type: "object", properties };
    if (typeNode && typeNode.type === "map_type") return { type: "object" };
  }
  return null;
}

/** Resolve `&x` / `x` to the local variable's declared type node. */
export function referencedTypeOf(arg: TsNode | undefined, body: TsNode): TsNode | null {
  if (!arg) return null;
  const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
  if (!target || target.type !== "identifier") return null;
  return resolveLocalType(body, target.text);
}

export interface StdHandlerEvidence {
  parameters: RouteParameter[];
  requestBody: RouteCandidate["requestBody"];
  responses: RouteCandidate["responses"];
  gaps: Set<GapCode>;
  extensions: RouteCandidate["extensions"];
}

export interface StdHandlerOptions {
  body: TsNode | null;
  declaredPathParams: string[];
  modelIndex: GoModelIndex;
  analysis: GoAnalysis;
  /**
   * Pack-specific path-param reader. Given a call node and its selector, return
   * the path parameter name it reads (e.g. mux.Vars(r)["id"]) or null.
   */
  readPathParam?: (call: TsNode, sel: { receiver: TsNode; method: string }, args: TsNode[]) => string | null;
}

export function analyzeStdHTTPHandler(opts: StdHandlerOptions): StdHandlerEvidence {
  const { body, declaredPathParams, modelIndex: index, analysis, readPathParam } = opts;
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  let isSse = false;

  const addResponse = (status: string, response: RouteCandidate["responses"][number]) => {
    responseStatus.set(status, response);
  };

  if (body) {
    // Aliases such as `q := r.URL.Query()`; later q.Get("x") reads a query param.
    const queryAlias = new Set<string>();
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const left = decl.namedChildren.find((c) => c.type === "expression_list");
      const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
      const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
      const hasQueryCall = findAll(right ?? decl, (c) => c.type === "call_expression").some(
        (call) => call.text.includes(".URL.Query()"),
      );
      if (hasQueryCall && left) {
        for (const id of left.namedChildren) {
          if (id.type === "identifier") queryAlias.add(id.text);
        }
      }
    }

    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (!sel) continue;
      const args = positionalArguments(call);

      const customPath = readPathParam?.(call, sel, args);
      if (customPath && declaredPathParams.includes(customPath) &&
        !parameters.some((p) => p.name === customPath)) {
        parameters.push({ name: customPath, in: "path", required: true, schema: { type: "string" }, confidence: "high" });
        continue;
      }

      // r.PathValue("name") — Go 1.22 ServeMux path wildcard.
      if (sel.method === "PathValue" && sel.receiver.type === "identifier") {
        const name = literalString(args[0]);
        if (name && declaredPathParams.includes(name) && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "high" });
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
          parameters.push({ name, in: "query", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      // r.Header.Get("X")
      if (sel.method === "Get" && call.text.includes(".Header.Get(")) {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "header", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      // r.Cookie("session")
      if (sel.method === "Cookie" && sel.receiver.type === "identifier") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({ name, in: "cookie", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      // r.FormValue("q") / r.PostFormValue("q") — ad-hoc query/form field.
      if (sel.method === "FormValue" || sel.method === "PostFormValue") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "query", required: false, schema: { type: "string" }, confidence: "high" });
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

      // w.WriteHeader(status)
      if (sel.receiver.type === "identifier" && sel.method === "WriteHeader") {
        const status = statusCodeOf(args[0]);
        if (status && !responseStatus.has(status)) {
          addResponse(status, { statusCode: status, description: "", confidence: "high" });
        }
        continue;
      }

      // w.Write([]byte("...")) — plain text body.
      if (sel.receiver.type === "identifier" && sel.method === "Write") {
        const arg = args[0];
        const writesBytes =
          (arg?.type === "call_expression" || arg?.type === "type_conversion_expression") &&
          /^\s*\[\s*\]byte\s*\(/.test(arg.text);
        if (writesBytes && !responseStatus.has("200")) {
          addResponse("200", {
            statusCode: "200",
            description: "",
            confidence: "medium",
            content: [{ mediaType: "text/plain", schema: { type: "string" }, confidence: "medium" }],
          });
        }
        continue;
      }

      // http.ServeFile(w, r, name) — file/binary response.
      if (sel.receiver.type === "identifier" && sel.receiver.text === "http" && sel.method === "ServeFile") {
        if (!responseStatus.has("200")) {
          addResponse("200", {
            statusCode: "200",
            description: "",
            confidence: "high",
            content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" }, confidence: "medium" }],
          });
        }
        continue;
      }

      // http.Error(w, msg, code) — plain-text error response.
      if (sel.receiver.type === "identifier" && sel.receiver.text === "http" && sel.method === "Error") {
        const status = statusCodeOf(args[2]) ?? "500";
        if (!responseStatus.has(status)) {
          addResponse(status, {
            statusCode: status,
            description: "",
            confidence: "high",
            content: [{ mediaType: "text/plain", schema: { type: "string" }, confidence: "high" }],
          });
        }
        continue;
      }
    }

    // json.NewDecoder(r.Body).Decode(&x) — request body component.
    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (sel?.method === "Decode" && call.text.includes("NewDecoder")) {
        const typeNode = referencedTypeOf(positionalArguments(call)[0], body);
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [{ mediaType: "application/json", schema: goTypeToSchema(typeNode, index), confidence: "high" }],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
      }
    }

    // json.NewEncoder(w).Encode(x) — JSON responses with block-scoped status.
    collectEncodeResponses(body, analysis, index, (status, schema) => {
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

    // Declared path params never touched by the handler are still valid params.
    for (const name of declaredPathParams) {
      if (!parameters.some((p) => p.name === name && p.in === "path")) {
        parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
      }
    }
  } else {
    for (const name of declaredPathParams) {
      parameters.push({ name, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
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

  return {
    parameters,
    requestBody,
    responses: [...responseStatus.values()],
    gaps,
    extensions: isSse ? { "x-protocol": "sse" } : undefined,
  };
}

/** Walk handler statements in source order with block-scoped WriteHeader status. */
function collectEncodeResponses(
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

  const walkBlock = (block: TsNode, inherited: string | null) => {
    let status = inherited;
    for (const statement of block.namedChildren) {
      const isBranch =
        statement.type === "if_statement" || statement.type === "for_statement" ||
        statement.type === "range_statement" || statement.type === "switch_statement" ||
        statement.type === "select_statement";
      for (const call of shallowCalls(statement)) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (sel.receiver.type === "identifier" && sel.method === "WriteHeader") {
          status = statusCodeOf(positionalArguments(call)[0]) ?? status;
        }
        if (sel.method === "Encode" && call.text.includes("NewEncoder")) {
          const arg = positionalArguments(call)[0];
          emit(status ?? "200", responsePayloadSchema(arg, body, analysis, index));
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

/** Resolve an Encode payload to a JSON schema (constructor call / local var / literal). */
function responsePayloadSchema(
  arg: TsNode | undefined,
  body: TsNode,
  analysis: GoAnalysis,
  index: GoModelIndex,
): JsonSchema | null {
  if (!arg) return null;
  if (arg.type === "call_expression") {
    return resolveGoPayloadValue(arg, body, analysis, index, analysis.vars).schema;
  }
  if (arg.type === "identifier") {
    const typeNode = resolveLocalType(body, arg.text);
    return typeNode ? goTypeToSchema(typeNode, index) : null;
  }
  return literalSchema(arg, index);
}
