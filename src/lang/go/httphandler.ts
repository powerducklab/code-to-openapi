import {mergeResponseVariants} from "../../core/response-variants.js";
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

import { resolveGoCall, goSourceFile } from "./symbols.js";
import { dirname } from "node:path";
import type { GapCode, RouteCandidate, RouteParameter } from "../../core/types.js";
import type { JsonSchema } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoFunction } from "./index.js";
import {
  ensureGoComponent,
  goTypeToSchema,
  goConstructedTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  extractGoValidatorRequired,
  goTypeBaseName,
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
export function literalSchema(node: TsNode | null, index: GoModelIndex, depth = 0, resolveValue?: (node: TsNode) => JsonSchema | null): JsonSchema | null {
  if (!node || depth > 6) return null;
  if (node.type === "unary_expression") {
    return literalSchema(node.namedChildren[0], index, depth + 1, resolveValue);
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
        const keyText = keyNode ? literalString(keyNode) : null;
        if (!keyText || !valNode) continue;
        properties[keyText] = scalarLiteral(valNode) ?? literalSchema(valNode, index, depth + 1, resolveValue) ?? resolveValue?.(valNode) ?? {};
      }
    }
    if (Object.keys(properties).length > 0) return { type: "object", properties, required: Object.keys(properties) };
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

/**
 * When the decoded variable is passed to a hand-written validator in this
 * handler (validateX(varName) or validateX(&varName)), return the required
 * JSON field set recorded for the validator's parameter type.
 */
function validatorRequiredFields(
  body: TsNode,
  decodedVar: string,
  analysis: GoAnalysis,
  validatorRequired: Map<string, Set<string>>,
): Set<string> | null {
  for (const call of findAll(body, node => node.type === "call_expression")) {
    const callee = call.namedChildren[0];
    const calleeName = callee?.type === "identifier" ? callee.text
      : callee?.type === "selector_expression" ? callee.namedChildren[1]?.text : undefined;
    if (!calleeName || !/^(validate|check|require|ensure)/i.test(calleeName)) continue;
    const firstArg = positionalArguments(call)[0];
    const argName = firstArg?.type === "unary_expression"
      ? firstArg.namedChildren.find(child => child.type === "identifier")?.text
      : firstArg?.type === "identifier" ? firstArg.text : undefined;
    if (argName !== decodedVar) continue;
    // Resolve the validator's first parameter type name.
    const candidates = analysis.functions.get(calleeName) ?? [];
    for (const fn of candidates) {
      const param = fn.node.namedChildren
        .find(node => node.type === "parameter_list")?.namedChildren
        .find(node => node.type === "parameter_declaration");
      const typeNode = param?.childForFieldName?.("type") ?? param?.namedChildren.at(-1);
      const baseName = goTypeBaseName(typeNode);
      if (baseName && validatorRequired.has(baseName)) return validatorRequired.get(baseName)!;
    }
  }
  return null;
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
  inputModel?: GoModelIndex;
  analysis: GoAnalysis;
  /**
   * Pack-specific path-param reader. Given a call node and its selector, return
   * the path parameter name it reads (e.g. mux.Vars(r)["id"]) or null.
   */
  readPathParam?: (call: TsNode, sel: { receiver: TsNode; method: string }, args: TsNode[]) => string | null;
}

/** Recognize an actual local JSON writer, not a helper name convention. */
function jsonWriterHelper(call: TsNode, body: TsNode, analysis: GoAnalysis, depth = 0): { status: TsNode | undefined; payload: TsNode | undefined } | null {
  if (depth > 4) return null;
  const callee = call.namedChildren[0];
  if (callee?.type !== "identifier" || !analysis.functions.has(callee.text)) return null;
  let root = body;
  while (root.parent) root = root.parent;
  const owner = [...analysis.files.values()].find(file => file.root.id === root.id);
  if (!owner) return null;
  const helpers = (analysis.functions.get(callee.text) ?? []).filter(fn => dirname(fn.file) === dirname(owner.path) && fn.body);
  if (helpers.length !== 1) return null;
  const helper = helpers[0]!;
  const parameters = helper.node.namedChildren.find(node => node.type === "parameter_list")?.namedChildren.flatMap(parameter => parameter.namedChildren.filter(node => node.type === "identifier").map(node => ({name:node.text, type:parameter.namedChildren.at(-1)?.text ?? ""}))) ?? [];
  const writer = parameters.find(parameter => /(?:^|\.)ResponseWriter$/.test(parameter.type));
  if (!writer) return null;
  const calls = findAll(helper.body!, node => node.type === "call_expression");
  const headers = calls.filter(node => selectorCall(node)?.method === "WriteHeader" && selectorCall(node)?.receiver.text === writer.name);
  if (!headers.length && calls.length === 1 && !findAll(helper.body!, n => n.type === "assignment_statement" || n.type === "short_var_declaration").length) {
    const nested = jsonWriterHelper(calls[0]!, helper.body!, analysis, depth + 1);
    const args = positionalArguments(call);
    const callerParameters = body.parent?.childForFieldName("parameters");
    const writerIndex = parameters.findIndex(p => p.name === writer.name);
    const callerWriter = callerParameters?.namedChildren.some(p => p.namedChildren.some(n => n.type === "identifier" && n.text === args[writerIndex]?.text) && /(?:^|\.)ResponseWriter$/.test(p.childForFieldName("type")?.text ?? ""));
    if (nested && callerWriter) {
      const substitute = (node: TsNode | undefined) => {
        const at = node?.type === "identifier" ? parameters.findIndex(p => p.name === node.text) : -1;
        return at >= 0 ? args[at] : node;
      };
      return {status: substitute(nested.status), payload: substitute(nested.payload)};
    }
  }
  const encodes = calls.filter(node => {
    const encode = selectorCall(node);
    if (encode?.method !== "Encode") return false;
    const encoder = selectorCall(encode.receiver);
    return encoder?.method === "NewEncoder" && encoder.receiver.text === "json" && positionalArguments(encode.receiver)[0]?.text === writer.name;
  });
  if (headers.length !== 1) return null;
  const status = positionalArguments(headers[0]!)[0];
  let payload = encodes.length === 1 ? positionalArguments(encodes[0]!)[0] : undefined;
  if (!encodes.length) {
    const writes = calls.filter(node => selectorCall(node)?.method === "Write" && selectorCall(node)?.receiver.text === writer.name);
    const output = writes.length === 1 ? positionalArguments(writes[0]!)[0] : undefined;
    if (output?.type === "identifier") {
      const bindings = findAll(helper.body!, n => n.type === "short_var_declaration" || n.type === "assignment_statement")
        .filter(n => n.namedChildren[0] && findAll(n.namedChildren[0], c => c.type === "identifier" && c.text === output.text).length);
      const binding = bindings.length === 1 ? bindings[0] : undefined;
      const lists = binding?.namedChildren.filter(n => n.type === "expression_list");
      const value = lists?.[1]?.namedChildren[0];
      const marshal = value ? selectorCall(value) : null;
      const helperFile = goSourceFile(helper.node, analysis);
      const imported = helperFile && marshal && findAll(helperFile.root, n => n.type === "import_spec").some(n =>
        n.childForFieldName("path")?.text === '"encoding/json"' &&
        (n.childForFieldName("name")?.text ?? "json") === marshal.receiver.text);
      if (imported && !parameters.some(p => p.name === marshal?.receiver.text) && marshal?.method === "Marshal" && lists?.[0]?.namedChildren[0]?.text === output.text &&
          binding!.startIndex + binding!.text.length < writes[0]!.startIndex) payload = positionalArguments(value!)[0];
    }
  }
  if (encodes.length > 1) return null;
  if (status?.type !== "identifier" || payload?.type !== "identifier") return null;
  if (findAll(helper.body!, node => node.type === "assignment_statement").some(node => {
    const left = node.namedChildren[0];
    return left && findAll(left, item => item.type === "identifier" && [status.text, payload.text].includes(item.text)).length > 0;
  })) return null;
  const statusIndex = parameters.findIndex(parameter => parameter.name === status.text);
  const payloadIndex = parameters.findIndex(parameter => parameter.name === payload.text);
  const writerIndex = parameters.findIndex(parameter => parameter.name === writer.name);
  const values = positionalArguments(call);
  // Prove that the caller passed its response writer, not an unrelated buffer.
  const enclosingParams = body.parent?.childForFieldName("parameters") ?? body.parent?.namedChildren.filter(node => node.type === "parameter_list").at(-1);
  const callerWriter = enclosingParams?.namedChildren.some(parameter => parameter.namedChildren.some(node => node.type === "identifier" && node.text === values[writerIndex]?.text) && /(?:^|\.)ResponseWriter$/.test(parameter.namedChildren.at(-1)?.text ?? ""));
  return statusIndex >= 0 && payloadIndex >= 0 && callerWriter ? { status:values[statusIndex], payload:values[payloadIndex] } : null;
}

/** Infer wire parameter types only from a verified standard-library conversion. */
export function convertedParameterSchema(call: TsNode, analysis: GoAnalysis, depth = 0): JsonSchema {
  // Chained numeric coercion helpers such as beego's `com.StrTo(c.Param("id")).MustInt()`
  // wrap the source call in a selector + call. The Must* method name is an explicit
  // conversion and does not depend on a strconv import.
  let ancestor: TsNode | null | undefined = call;
  for (let i = 0; i < 5 && ancestor; i++) {
    if (ancestor.type === "call_expression") {
      const chained = selectorCall(ancestor);
      if (chained?.method === "MustInt" || chained?.method === "MustInt64" || chained?.method === "ParseInt") return { type: "integer" };
      if (chained?.method === "MustFloat64" || chained?.method === "ParseFloat") return { type: "number" };
      if (chained?.method === "MustBool" || chained?.method === "ParseBool") return { type: "boolean" };
    }
    ancestor = ancestor.parent;
  }
  const outer = call.parent?.parent;
  const converter = outer?.type === "call_expression" ? selectorCall(outer) : null;
  const owner = goSourceFile(call, analysis);
  if (!owner) return {type:"string"};
  if (!converter && depth === 0 && call.parent?.type === "expression_list" && call.parent.parent?.type === "short_var_declaration") {
    const declaration = call.parent.parent;
    const lists = declaration.namedChildren.filter(n => n.type === "expression_list");
    const name = lists[0]?.namedChildren[0]?.text;
    let body = declaration.parent;
    while (body && body.type !== "function_declaration" && body.type !== "method_declaration") body = body.parent;
    if (name && body && lists[0]?.namedChildren.length === 1 && lists[1]?.namedChildren.length === 1) {
      const writes = findAll(body, n => (n.type === "assignment_statement" || n.type === "short_var_declaration") && n.namedChildren[0]?.namedChildren.some(c => c.text === name));
      if (writes.length === 1) {
        const types = new Set(findAll(body, n => n.type === "identifier" && n.text === name && n.startIndex > declaration.startIndex)
          .map(n => convertedParameterSchema(n, analysis, 1).type).filter(type => type && type !== "string"));
        if (types.size === 1) return {type:[...types][0]!};
      }
    }
  }
  if (!converter) return {type:"string"};
  const imported = findAll(owner.root, n => n.type === "import_spec").some(n =>
    n.childForFieldName("path")?.text === '"strconv"' &&
    (n.childForFieldName("name")?.text ?? "strconv") === converter.receiver.text);
  // A local binding can shadow the package alias.
  let enclosing: TsNode | null = call;
  while (enclosing && enclosing.type !== "function_declaration" && enclosing.type !== "method_declaration") enclosing = enclosing.parent;
  const shadowed = enclosing && findAll(enclosing, n => n.type === "short_var_declaration" || n.type === "var_spec" || n.type === "parameter_declaration").some(n => {
    const names = n.type === "short_var_declaration" ? n.namedChildren[0]?.namedChildren ?? [] : n.namedChildren;
    return names.some(c => c.type === "identifier" && c.text === converter.receiver.text);
  });
  if (!imported || shadowed) return {type:"string"};
  if (converter.method === "Atoi") return {type:"integer"};
  if (converter.method === "ParseBool") return {type:"boolean"};
  if (converter.method === "ParseFloat") return {type:"number"};
  return {type:"string"};
}

/** Follow only helpers receiving the original request, with bounded cycle protection. */
function helperQueryParameters(body: TsNode, analysis: GoAnalysis): RouteParameter[] {
  const parameters: RouteParameter[] = [];
  const visited = new Set<string>();
  const walk = (current: TsNode, request: string, depth: number) => {
    if (depth > 6 || visited.size >= 64) return;
    const key = `${current.id}:${request}`;
    if (visited.has(key)) return;
    visited.add(key);
    // Rebinding the request invalidates the forwarding proof.
    if (findAll(current, n => n.type === "assignment_statement" || n.type === "short_var_declaration").some(n => n.namedChildren[0]?.namedChildren.some(c => c.text === request))) return;
    const aliases = new Map<string, TsNode>();
    const declarations = findAll(current, n => n.type === "short_var_declaration");
    for (const declaration of declarations) {
      const lists = declaration.namedChildren.filter(n => n.type === "expression_list");
      if (lists[0]?.namedChildren.length !== 1 || lists[1]?.namedChildren.length !== 1) continue;
      const name = lists[0].namedChildren[0]!;
      if (lists[1].namedChildren[0]?.text !== `${request}.URL.Query()`) continue;
      const writes = findAll(current, n => n.type === "assignment_statement" || n.type === "short_var_declaration").filter(n => n.namedChildren[0]?.namedChildren.some(c => c.text === name.text));
      if (writes.length === 1) aliases.set(name.text, declaration);
    }
    for (const call of findAll(current, n => n.type === "call_expression")) {
      let scope = call.parent;
      while (scope && scope.id !== current.id && scope.type !== "func_literal") scope = scope.parent;
      if (scope?.id !== current.id) continue;
      const sel = selectorCall(call);
      const alias = sel ? aliases.get(sel.receiver.text) : undefined;
      let inScope = false;
      if (alias && alias.startIndex < call.startIndex) {
        let ancestor = call.parent;
        while (ancestor && ancestor.id !== current.id) {
          if (ancestor.id === alias.parent?.id) { inScope = true; break; }
          ancestor = ancestor.parent;
        }
        if (alias.parent?.id === current.id) inScope = true;
      }
      if (depth > 0 && sel?.method === "Get" && (sel.receiver.text === `${request}.URL.Query()` || inScope)) {
        const name = literalString(positionalArguments(call)[0]);
        if (name && !parameters.some(p => p.name === name)) {
          parameters.push({name, in:"query", required:false, schema:convertedParameterSchema(call, analysis), confidence:"medium"});
        }
      }
      const args = positionalArguments(call);
      if (!args.some(arg => arg.text === request)) continue;
      const fn = resolveGoCall(call, analysis);
      if (!fn?.body) continue;
      const declarations = fn.node.childForFieldName("parameters")?.namedChildren ?? [];
      const names = declarations.flatMap(p => p.namedChildren.filter(c => c.type === "identifier").map(c => c.text));
      args.forEach((arg, i) => { if (arg.text === request && names[i]) walk(fn.body!, names[i]!, depth + 1); });
    }
  };
  const declarations = body.parent?.childForFieldName("parameters")?.namedChildren ?? [];
  for (const parameter of declarations) {
    const type = parameter.childForFieldName("type")?.text;
    if (type !== "*http.Request") continue;
    for (const name of parameter.namedChildren.filter(n => n.type === "identifier")) walk(body, name.text, 0);
  }
  return parameters;
}

export function analyzeStdHTTPHandler(opts: StdHandlerOptions): StdHandlerEvidence {
  const { body, declaredPathParams, modelIndex: index, analysis, readPathParam } = opts;
  const parameters: RouteParameter[] = body ? helperQueryParameters(body, analysis) : [];
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
      if (!sel) {
        const helper = jsonWriterHelper(call, body, analysis);
        if (helper) {
          const status = statusCodeOf(helper.status) ?? "default";
          const noBody = helper.payload?.text === "nil" || /^(?:1\d\d|204|205|304)$/.test(status);
          const resolved = !noBody && helper.payload ? resolveGoPayloadValue(helper.payload, body, analysis, index, analysis.vars).schema : undefined;
          const schema = resolved ?? (!noBody && helper.payload ? literalSchema(helper.payload, index, 0, (value) => resolveGoPayloadValue(value, body, analysis, index, analysis.vars).schema) ?? undefined : undefined);
          if (status === "default" || (!noBody && (!schema || !Object.keys(schema).length))) gaps.add("response-unknown");
          const previous = responseStatus.get(status)?.content?.[0]?.schema;
          const merged = previous && schema && JSON.stringify(previous) !== JSON.stringify(schema) ? {anyOf:[previous,schema]} : schema ?? previous;
          addResponse(status, {statusCode:status, description:"", confidence:"medium", ...(!noBody ? {content:[{mediaType:"application/json",schema:merged ?? {}}]} : {})});
        }
        continue;
      }
      const args = positionalArguments(call);

      const customPath = readPathParam?.(call, sel, args);
      if (customPath && declaredPathParams.includes(customPath) &&
        !parameters.some((p) => p.name === customPath)) {
        parameters.push({ name: customPath, in: "path", required: true, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        continue;
      }

      // r.PathValue("name") — Go 1.22 ServeMux path wildcard.
      if (sel.method === "PathValue" && sel.receiver.type === "identifier") {
        const name = literalString(args[0]);
        if (name && declaredPathParams.includes(name) && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "path", required: true, schema: convertedParameterSchema(call, analysis), confidence: "high" });
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
          parameters.push({ name, in: "query", required: false, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        }
        continue;
      }

      // r.Header.Get("X")
      if (sel.method === "Get" && call.text.includes(".Header.Get(")) {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "header", required: false, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        }
        continue;
      }

      // r.Cookie("session")
      if (sel.method === "Cookie" && sel.receiver.type === "identifier") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({ name, in: "cookie", required: false, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        }
        continue;
      }

      // r.FormValue("q") / r.PostFormValue("q") — ad-hoc query/form field.
      if (sel.method === "FormValue" || sel.method === "PostFormValue") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({ name, in: "query", required: false, schema: convertedParameterSchema(call, analysis), confidence: "high" });
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

    // Request body decoding:
    //   json.NewDecoder(r.Body).Decode(&x)   (chained)
    //   decoder := json.NewDecoder(r.Body); decoder.Decode(&x)   (split)
    //   json.Unmarshal(data, &x)
    const decoderVars = new Set<string>();
    // Required fields proven by hand-written validators (validateX with
    // `if p.Field == ""` / `p.Field.IsZero()` checks), keyed by type name.
    const validatorRequired = extractGoValidatorRequired(analysis, index);
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
      if (lists.length < 2) continue;
      for (const call of findAll(lists[1]!, (c) => c.type === "call_expression")) {
        const s = selectorCall(call);
        if (s?.receiver.type === "identifier" && s.receiver.text === "json" && s.method === "NewDecoder") {
          for (const id of lists[0]!.namedChildren.filter((c) => c.type === "identifier")) {
            decoderVars.add(id.text);
          }
        }
      }
    }
    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (!sel) continue;
      let targetArg: TsNode | undefined;
      if (sel.method === "Decode") {
        const chained = call.text.includes("NewDecoder");
        const viaVar = sel.receiver.type === "identifier" && decoderVars.has(sel.receiver.text);
        if (!chained && !viaVar) continue;
        targetArg = positionalArguments(call)[0];
      } else if (
        sel.receiver.type === "identifier" &&
        sel.receiver.text === "json" &&
        sel.method === "Unmarshal"
      ) {
        targetArg = positionalArguments(call)[1];
      } else {
        continue;
      }
      const typeNode = referencedTypeOf(targetArg, body);
      if (typeNode) {
        const model = opts.inputModel ?? index;
        let bodySchema: JsonSchema = goTypeToSchema(typeNode, model);
        // Apply hand-written validator required fields when the decoded value
        // is passed to a validateX(...) call in the same handler.
        const decodedVar = targetArg?.type === "unary_expression"
          ? targetArg.namedChildren.find(child => child.type === "identifier")?.text
          : targetArg?.type === "identifier" ? targetArg.text : undefined;
        const requiredFields = decodedVar
          ? validatorRequiredFields(body, decodedVar, analysis, validatorRequired)
          : null;
        if (requiredFields?.size) {
          const component = bodySchema.$ref
            ? model.components.get(String(bodySchema.$ref).split("/").pop()!)
            : bodySchema;
          if (component) {
            bodySchema = { ...structuredClone(component), required: [...requiredFields] };
          }
        }
        requestBody = {
          required: true,
          confidence: "high",
          content: [{ mediaType: "application/json", schema: bodySchema, confidence: "high" }],
        };
      } else {
        gaps.add("body-schema-unknown");
      }
    }

    // json.NewEncoder(w).Encode(x) — JSON responses with block-scoped status.
    collectEncodeResponses(body, analysis, index, (status, schema) => {
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
  const resolved = resolveGoPayloadValue(arg, body, analysis, index, analysis.vars).schema;
  if (resolved) return resolved;
  if (arg.type === "identifier") {
    const typeNode = resolveLocalType(body, arg.text);
    return typeNode ? goTypeToSchema(typeNode, index) : null;
  }
  return literalSchema(arg, index, 0, (value) => resolveGoPayloadValue(value, body, analysis, index, analysis.vars).schema);
}
