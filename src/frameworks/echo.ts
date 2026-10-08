/**
 * Echo (labstack/echo v4) framework pack (Go).
 *
 * Routing idioms covered:
 *  - e := echo.New() then e.GET/e.POST/e.PUT/e.PATCH/e.DELETE(path, handler, ...mw).
 *  - Groups: g := e.Group("/api") then g.GET("/items", h); nested groups compose.
 *  - Handlers are `func(c echo.Context) error`; evidence comes from c.Param,
 *    c.QueryParam, c.Request().Header.Get, c.Bind and c.JSON/c.String/c.NoContent.
 *  - c.JSON status/payload follows constructor/service return types via the
 *    shared Go payload resolver; unproven payloads keep an honest gap.
 */

import { goSourceFile, resolveGoCall, resolveGoPackageFunction } from "../lang/go/symbols.js";
import { goStaticString } from "../lang/go/static-string.js";
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
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import {
  buildGoModelIndex,
  ensureGoComponent,
  functionResultTypeNode,
  goTypeToSchema,
  goConstructedTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  type GoModelIndex,
} from "../lang/go/schema.js";
import { convertedParameterSchema, literalSchema, scalarLiteral } from "../lang/go/httphandler.js";
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

/** Echo uses :id and *wildcard; convert to OpenAPI {id}. */
function echoPathToOas(path: string): { path: string; params: string[] } {
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
        const args = positionalArguments(value);
        return args[0] ?? null;
      }
    }
  }
  return null;
}

function unwrapTypeNode(node: TsNode | null): TsNode | null {
  let current = node;
  while (current && current.type === "pointer_type") {
    current = current.namedChildren[0] ?? null;
  }
  return current;
}

function typeNodeName(node: TsNode | null): string | null {
  const inner = unwrapTypeNode(node);
  return inner && inner.type === "type_identifier" ? inner.text : null;
}

/**
 * Resolves the request struct behind a receiver variable in a handler:
 *   req := &userRegisterRequest{}
 *   req := newUserRegisterRequest()   // constructor returning *T or new(T)
 *
 * Only names present in the package model index are accepted.
 */
function resolveIndirectRequestType(
  body: TsNode,
  varName: string,
  analysis: GoAnalysis,
  index: GoModelIndex,
): TsNode | null {
  const direct = unwrapTypeNode(resolveLocalType(body, varName));
  if (direct && typeNodeName(direct) && index.byName.has(typeNodeName(direct)!)) {
    return direct;
  }

  // Constructor call on the right-hand side of `req := newX()`.
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
    const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
    if (lists.length < 2) continue;
    const at = lists[0].namedChildren.findIndex((c) => c.text === varName);
    if (at < 0) continue;
    const value = lists[1].namedChildren[at];
    if (!value || value.type !== "call_expression") continue;
    const callee = value.namedChildren[0];
    if (!callee || callee.type !== "identifier") continue;
    const fn = analysis.functions.get(callee.text)?.[0];
    if (!fn?.body) continue;

    // Declared result type, e.g. `func newX() *X`.
    const resultType = unwrapTypeNode(functionResultTypeNode(fn));
    if (resultType && typeNodeName(resultType) && index.byName.has(typeNodeName(resultType)!)) {
      return resultType;
    }
    // Body returns new(T) or &T{}.
    for (const ret of findAll(fn.body, (n) => n.type === "return_statement")) {
      const newCall = findFirst(
        ret,
        (n) =>
          n.type === "call_expression" &&
          n.namedChildren[0]?.type === "identifier" &&
          n.namedChildren[0]?.text === "new",
      );
      if (newCall) {
        const arg = positionalArguments(newCall)[0];
        if (arg && arg.type === "type_identifier" && index.byName.has(arg.text)) return arg;
      }
      const composite = findFirst(ret, (n) => n.type === "composite_literal");
      const compositeType = unwrapTypeNode(composite?.namedChildren[0] ?? null);
      if (
        compositeType &&
        compositeType.type === "type_identifier" &&
        index.byName.has(compositeType.text)
      ) {
        return compositeType;
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
  groupVar: string | null;
}

/** Resolve a c.JSON payload to a schema (constructor / local var / literal). */
function payloadSchema(
  arg: TsNode | undefined,
  body: TsNode | null,
  analysis: GoAnalysis,
  index: GoModelIndex,
): JsonSchema | null {
  if (!arg) return null;
  const shared = resolveGoPayloadValue(arg, body, analysis, index, analysis.vars).schema
    ?? scalarLiteral(arg)
    ?? literalSchema(arg, index, 0, value => resolveGoPayloadValue(value, body, analysis, index, analysis.vars).schema);
  if (shared) return shared;
  if (arg.type === "identifier") {
    if (body) {
      const typeNode = resolveLocalType(body, arg.text);
      if (typeNode) return goTypeToSchema(typeNode, index);
    }
    return null;
  }
  // Composite literal struct -> $ref (or array of $ref for slices).
  if (arg.type === "composite_literal") {
    const typeNode = arg.namedChildren[0];
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      return goConstructedTypeToSchema(typeNode, index);
    }
    let t: TsNode | undefined = typeNode;
    while (t && t.type === "pointer_type") t = t.namedChildren[0];
    if (t && t.type === "type_identifier" && index.byName.has(t.text)) {
      return goTypeToSchema(t, index);
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

function echoContexts(fn: GoFunction, analysis: GoAnalysis): Set<string> {
  const file = goSourceFile(fn.node, analysis);
  const aliases = new Set<string>();
  for (const spec of file ? findAll(file.root, node => node.type === "import_spec") : []) {
    const path = spec.childForFieldName("path") ?? spec.namedChildren.find(node => node.type === "interpreted_string_literal");
    if (path && /"github\.com\/labstack\/echo(?:\/v\d+)?"/.test(path.text)) aliases.add(spec.childForFieldName("name")?.text ?? "echo");
  }
  const result = new Set<string>();
  const parameters = fn.node.childForFieldName("parameters");
  for (const parameter of parameters?.namedChildren ?? []) {
    const type = parameter.childForFieldName("type");
    // Handlers may take the context by value (`c echo.Context`) or by pointer
    // (`c *echo.Context`); both are valid across echo major versions.
    if (!type) continue;
    const normalized = type.text.replace(/^\*/, "");
    if (![...aliases].some(alias => normalized === `${alias}.Context`)) continue;
    for (const name of parameter.namedChildren.filter(node => node.type === "identifier")) result.add(name.text);
  }
  return result;
}

function analyzeEchoHandler(
  fn: GoFunction,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  inputModel: GoModelIndex,
  declaredParams: string[],
): Evidence {
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const body = fn.body;
  const contexts = echoContexts(fn, analysis);
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  const addResponse = (status: string, response: RouteCandidate["responses"][number]) => {
    const previous = responseStatus.get(status);
    responseStatus.set(status, previous ? mergeResponseVariants(previous, response) : response);
  };

  if (body) {
    for (const call of findAll(body, (n) => n.type === "call_expression")) {
      const sel = selectorCall(call);
      if (!sel) continue;
      const args = positionalArguments(call);
      let ancestor = call.parent;
      while (ancestor && ancestor.id !== body.id && ancestor.type !== "func_literal") ancestor = ancestor.parent;
      if (ancestor?.type === "func_literal") continue;
      const isContext = sel.receiver.type === "identifier" && contexts.has(sel.receiver.text);
      const isHeader = [...contexts].some(name => sel.receiver.text === `${name}.Request().Header`);
      if (!isContext && !isHeader && !["bind", "Bind"].includes(sel.method)) continue;


      if (sel.method === "Param") {
        const name = literalString(args[0]);
        if (name && declaredParams.includes(name) && !parameters.some((p) => p.name === name && p.in === "path")) {
          parameters.push({ name, in: "path", required: true, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        }
        continue;
      }

      if (sel.method === "QueryParam") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "query")) {
          parameters.push({ name, in: "query", required: false, schema: convertedParameterSchema(call, analysis), confidence: "high" });
        }
        continue;
      }

      // c.Request().Header.Get("X")
      if (sel.method === "Get" && call.text.includes(".Request().Header.Get(")) {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "header")) {
          parameters.push({ name, in: "header", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      if (sel.method === "Cookie") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({ name, in: "cookie", required: false, schema: { type: "string" }, confidence: "high" });
        }
        continue;
      }

      if (sel.method === "Validate") gaps.add("body-schema-unknown");
      if (isContext && sel.method === "Bind" && args[0]) {
        const typeNode = referencedType(args[0], body);
        if (typeNode) {
          requestBody = {
            required: true,
            confidence: "high",
            content: [{ mediaType: "application/json", schema: goTypeToSchema(typeNode, inputModel), confidence: "high" }],
          };
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      // Indirect bind: `req.bind(c, ...)` / `req.Bind(c, ...)` where the
      // request struct owns a helper method that calls c.Bind internally
      // (the canonical echo realworld layout).
      if (
        (sel.method === "bind" || sel.method === "Bind") &&
        sel.receiver.type === "identifier" &&
        !requestBody
      ) {
        const typeNode = resolveIndirectRequestType(
          body,
          sel.receiver.text,
          analysis,
          modelIndex,
        );
        const helper = resolveGoCall(call, analysis);
        const helperContexts = helper ? echoContexts(helper, analysis) : new Set<string>();
        const receiverNames = new Set(helper?.receiver ? findAll(helper.receiver, node => node.type === "identifier").map(node => node.text) : []);
        const methodBinds = helper?.body && findAll(helper.body, node => node.type === "call_expression").some(inner => {
          let parent = inner.parent;
          while (parent && parent.id !== helper.body!.id && parent.type !== "func_literal") parent = parent.parent;
          if (parent?.type === "func_literal") return false;
          const selected = selectorCall(inner);
          let target = positionalArguments(inner)[0];
          if (target?.type === "unary_expression") target = target.namedChildren[0];
          return selected?.method === "Bind" && helperContexts.has(selected.receiver.text) && !!target && receiverNames.has(target.text);
        });
        if (typeNode && methodBinds) {
          gaps.add("body-schema-unknown"); // Helper validation can impose additional constraints.
          requestBody = {
            required: true,
            confidence: "high",
            content: [{ mediaType: "application/json", schema: goTypeToSchema(typeNode, inputModel), confidence: "high" }],
          };
        }
        continue;
      }

      if (sel.method === "JSON") {
        const status = statusCode(args[0]) ?? "default";
        const candidate = payloadSchema(args[1], body, analysis, modelIndex);
        const schema = candidate ?? {};
        if (status === "default") gaps.add("response-unknown");
        addResponse(status, {
          statusCode: status,
          description: "",
          confidence: schema ? "high" : "medium",
          ...(schema
            ? { content: [{ mediaType: "application/json", schema, confidence: "high" }] }
            : {}),
        });
        if (!candidate) gaps.add("response-schema-unknown");
        continue;
      }

      if (sel.method === "String") {
        const status = statusCode(args[0]) ?? "default";
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

      if (sel.method === "NoContent") {
        const status = statusCode(args[0]) ?? "default";
        if (status === "default") gaps.add("response-unknown");
        {
          addResponse(status, { statusCode: status, description: "", confidence: "high" });
        }
        continue;
      }

      if (sel.method === "File" || sel.method === "Attachment") {
        {
          addResponse("200", {
            statusCode: "200",
            description: "",
            confidence: "high",
            content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" }, confidence: "medium" }],
          });
        }
        continue;
      }
    }

    // Returning an opaque error delegates status/body selection to Echo's
    // error handler. A known success response must not hide this missing branch.
    for (const ret of findAll(body, n => n.type === "return_statement")) {
      let parent = ret.parent;
      while (parent && parent.id !== body.id && parent.type !== "func_literal") parent = parent.parent;
      if (parent?.type === "func_literal") continue;
      const value = ret.namedChildren[0]?.type === "expression_list" ? ret.namedChildren[0].namedChildren[0] : ret.namedChildren[0];
      if (value?.type === "identifier" && value.text !== "nil") gaps.add("response-unknown");
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

export const echoPack: FrameworkPack<GoAnalysis> = {
  id: "echo",
  language: "go",
  dependencyHints: ["github.com/labstack/echo/v4", "github.com/labstack/echo"],

  applies(ctx) {
    if (
      ctx.manifest.packages.has("github.com/labstack/echo/v4") ||
      ctx.manifest.packages.has("github.com/labstack/echo")
    ) {
      return true;
    }
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /labstack\/echo/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    // Echo handlers validate bound requests with c.Validate(r), which runs
    // go-playground/validator `validate:"required"` tags.
    const usesValidator = [...analysis.files.values()].some((f) =>
      findAll(f.root, (n) => n.type === "call_expression").some((n) => selectorCall(n)?.method === "Validate"),
    );
    const inputModel: GoModelIndex = {...modelIndex, input: true, validated: usesValidator, components: new Map()};
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    type Binding = {prefix: string; key: string; middleware: TsNode[]};
    const groupDecls: Array<{name: string; middleware: TsNode[]}> = [];
    const seenSites = new Set<string>();
    const isEchoConstructor = (node: TsNode): boolean => {
      const sel = selectorCall(node);
      const file = goSourceFile(node, analysis);
      if (!sel || sel.method !== "New" || !file) return false;
      return findAll(file.root, n => n.type === "import_spec").some(spec => {
        const path = literalString(spec.childForFieldName("path") ?? spec.namedChildren.find(n => n.type === "interpreted_string_literal"));
        const alias = spec.childForFieldName("name")?.text ?? "echo";
        return (path === "github.com/labstack/echo/v4" || path === "github.com/labstack/echo") && sel.receiver.text === alias;
      });
    };
    // Each registration invocation owns its bindings. Passing a group into a
    // helper must neither register unused helpers nor merge independent mounts.
    const walk = (node: TsNode, env: Map<string, Binding>, stack: Set<number>): Binding | undefined => {
      const file = goSourceFile(node, analysis);
      if (!file || node.type === "func_literal") return;
      if (node.type === "block") {
        const local = new Map(env);
        for (const child of node.namedChildren) {
          const returned = walk(child, local, stack);
          if (returned) return returned;
        }
        return;
      }
      if (node.type === "return_statement") {
        const value = node.namedChildren[0]?.type === "expression_list" ? node.namedChildren[0].namedChildren[0] : node.namedChildren[0];
        return value?.type === "identifier" ? env.get(value.text) : undefined;
      }
      if (node.type === "statement_list") {
        for (const child of node.namedChildren) {
          const returned = walk(child, env, stack);
          if (returned) return returned;
        }
        return;
      }
      if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
        const lists = node.namedChildren.filter(n => n.type === "expression_list");
        const names = lists[0]?.namedChildren ?? [];
        const values = lists[1]?.namedChildren ?? [];
        for (let i = 0; i < names.length; i++) {
          const name = names[i]!;
          const value = values[i];
          if (name.type !== "identifier") continue;
          let binding: Binding | undefined;
          if (value?.type === "identifier") binding = env.get(value.text);
          else if (value?.type === "call_expression") {
            const sel = selectorCall(value);
            if (isEchoConstructor(value)) binding = {prefix: "", key: `${file.path}:${node.startIndex}`, middleware: []};
            else if (sel?.method === "Group" && env.has(sel.receiver.text)) {
              const parent = env.get(sel.receiver.text)!;
              const args = positionalArguments(value);
              const prefix = goStaticString(args[0], file);
              if (prefix === null) unresolved.push({reason: "dynamic-path", message: "Echo group prefix cannot be statically resolved", origin: {file: file.path, line: value.startPosition.row + 1}});
              else binding = {prefix: joinPath(parent.prefix, prefix), key: `${parent.key}:${node.startIndex}`, middleware: [...parent.middleware, ...args.slice(1)]};
            } else {
              const factory = resolveGoCall(value, analysis);
              const resultType = factory ? functionResultTypeNode(factory)?.text : undefined;
              const routerType = resultType?.match(/^\*(\w+)\.(?:Echo|Group)$/);
              const owner = factory ? analysis.files.get(factory.file) : undefined;
              const returnsEcho = routerType && owner && findAll(owner.root, n => n.type === "import_spec").some(spec => {
                const path = literalString(spec.childForFieldName("path") ?? spec.namedChildren.find(n => n.type === "interpreted_string_literal"));
                return (path === "github.com/labstack/echo/v4" || path === "github.com/labstack/echo") && (spec.childForFieldName("name")?.text ?? "echo") === routerType[1];
              });
              if (returnsEcho && factory?.body && !stack.has(factory.node.id)) {
                const returns = findAll(factory.body, n => {
                  if (n.type !== "return_statement") return false;
                  let parent = n.parent;
                  while (parent && parent.id !== factory.body!.id) {
                    if (parent.type === "func_literal") return false;
                    parent = parent.parent;
                  }
                  return true;
                });
                // Multiple return branches need a union of bindings; do not guess.
                if (returns.length === 1) binding = walk(factory.body, new Map(), new Set([...stack, factory.node.id]));
              }
            }
          }
          if (binding) {
            env.set(name.text, binding);
            groupDecls.push({name: binding.key, middleware: binding.middleware});
          } else env.delete(name.text);
        }
      }
      if (node.type === "call_expression") {
        const sel = selectorCall(node);
        const binding = sel ? env.get(sel.receiver.text) : undefined;
        const args = positionalArguments(node);
        const verb = sel?.method.toLowerCase();
        if (binding && verb && VERBS.has(verb)) {
          const raw = goStaticString(args[0], file);
          if (raw === null) unresolved.push({reason: "dynamic-path", message: "Echo route path cannot be statically resolved", origin: {file: file.path, line: node.startPosition.row + 1}});
          else {
            const {path, params} = echoPathToOas(raw);
            const fullPath = joinPath(binding.prefix, path);
            const key = `${file.path}:${node.startIndex}:${verb}:${fullPath}`;
            if (!seenSites.has(key)) {
              seenSites.add(key);
              sites.push({method: verb, path: fullPath, params, handler: args[1] ?? null, origin: {file: file.path, line: node.startPosition.row + 1}, groupVar: binding.key});
            }
          }
        } else if (binding && (sel?.method === "Use" || sel?.method === "Pre")) {
          binding.middleware.push(...args);
        } else if (binding && sel?.method === "Start") {
          const addr = literalString(args[0]);
          if (addr) servers.add(addrToUrl(addr));
        } else if (args.some(arg => arg.type === "identifier" && env.has(arg.text))) {
          const target = resolveGoCall(node, analysis);
          if (target?.body && !stack.has(target.node.id)) {
            const params = target.node.childForFieldName("parameters")?.namedChildren.flatMap(p => p.namedChildren.filter(n => n.type === "identifier")) ?? [];
            const passed = new Map<string, Binding>();
            args.forEach((arg, i) => {
              const value = arg.type === "identifier" ? env.get(arg.text) : undefined;
              if (value && params[i]) passed.set(params[i]!.text, value);
            });
            if (passed.size) walk(target.body, passed, new Set([...stack, target.node.id]));
          }
        }
      }
      for (const child of node.namedChildren) walk(child, env, stack);
    };
    for (const functions of analysis.functions.values()) {
      for (const fn of functions) if (fn.body) walk(fn.body, new Map(), new Set([fn.node.id]));
    }
    for (const fn of analysis.methods) if (fn.body) walk(fn.body, new Map(), new Set([fn.node.id]));

    // Resolve group-level middleware contracts (e.g. JWT returning 401/403) so
    // protected routes inherit the authentication error responses.
    const groupContracts = new Map<string, GroupMiddlewareContract>();
    const unknownMiddleware = new Set<string>();
    for (const group of groupDecls) {
      for (const mw of group.middleware) {
        const contract = resolveGroupMiddleware(mw, analysis, modelIndex);
        if (!contract) unknownMiddleware.add(group.name);
        if (contract) {
          const previous = groupContracts.get(group.name);
          if (previous) {
            const merged = new Map<string, RouteCandidate["responses"][number]>();
            for (const r of [...previous.responses, ...contract.responses]) {
              const p = merged.get(r.statusCode);
              merged.set(r.statusCode, p ? mergeResponseVariants(p, r) : r);
            }
            groupContracts.set(group.name, {
              responses: [...merged.values()],
              skipGetExcept: contract.skipGetExcept ?? previous.skipGetExcept,
            });
          } else {
            groupContracts.set(group.name, contract);
          }
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
      } else if (handlerNode?.type === "call_expression") {
        const factory = resolveGoCall(handlerNode, analysis);
        const returned = factory?.body ? findAll(factory.body, node => {
          if (node.type !== "return_statement") return false;
          let parent = node.parent;
          while (parent && parent.id !== factory.body!.id) {
            if (parent.type === "func_literal") return false;
            parent = parent.parent;
          }
          return true;
        }) : [];
        // A single explicitly returned closure is proven to handle requests;
        // arbitrary callbacks elsewhere in a factory are not handlers.
        const value = returned.length === 1 ? returned[0]!.namedChildren[0] : undefined;
        const closure = value?.type === "expression_list" ? value.namedChildren[0] : value;
        const block = closure?.type === "func_literal" ? closure.namedChildren.find(node => node.type === "block") : undefined;
        if (block && factory && closure) fn = {...factory, node: closure, body: block};
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
            resolveGoCall(handlerNode, analysis) ??
            null;
        }
      }

      const evidence: Evidence = fn
        ? analyzeEchoHandler(fn, analysis, modelIndex, inputModel, site.params)
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

      if (site.groupVar && unknownMiddleware.has(site.groupVar)) evidence.gaps.add("response-unknown");
      const confidence: Confidence = evidence.gaps.size > 0 ? "medium" : "high";

      // Inherit group middleware responses (authentication 401/403), honoring a
      // Skipper that exposes GET requests publicly.
      const groupContract = site.groupVar ? groupContracts.get(site.groupVar) : null;
      if (groupContract) {
        const skipped = groupContract.skipGetExcept !== null
          && site.method === "get" && site.path !== groupContract.skipGetExcept;
        if (!skipped) {
          const byStatus = new Map<string, RouteCandidate["responses"][number]>();
          for (const r of evidence.responses) byStatus.set(r.statusCode, r);
          for (const mr of groupContract.responses) {
            const previous = byStatus.get(mr.statusCode);
            byStatus.set(mr.statusCode, previous ? mergeResponseVariants(previous, mr) : mr);
          }
          evidence.responses = [...byStatus.values()];
        }
      }

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

    const inputs = namespaceComponents(inputModel.components, new Set([...modelIndex.byName.keys(), ...modelIndex.components.keys()]), "input");
    for (const route of routes) if (route.requestBody) route.requestBody = remapSchemaReferences(route.requestBody, inputs.names);
    return {
      routes: dedupeRoutes(routes),
      unresolved,
      components: [...[...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })), ...inputs.components],
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

interface GroupMiddlewareContract {
  responses: RouteCandidate["responses"];
  // When the middleware config skips GET requests except one path (a JWT
  // Skipper), only that GET path inherits the middleware responses.
  skipGetExcept: string | null;
}

/** Resolve a group middleware argument (variable or constructor call) to the
 * status responses its per-request closure emits. */
function resolveGroupMiddleware(
  expr: TsNode,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
): GroupMiddlewareContract | null {
  let call: TsNode | undefined = expr;
  // `jwtMiddleware := middleware.JWT(secret)` -> follow the local variable.
  if (expr.type === "identifier") {
    let resolved: TsNode | undefined;
    for (const file of analysis.files.values()) {
      for (const decl of findAll(file.root, (n) => n.type === "short_var_declaration")) {
        const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
        const left = lists[0];
        const right = lists[lists.length - 1];
        if (!left || !right) continue;
        const idx = left.namedChildren.findIndex((c) => c.type === "identifier" && c.text === expr.text);
        if (idx >= 0) {
          resolved = right.namedChildren[idx] ?? right.namedChildren[0];
          break;
        }
      }
      if (resolved) break;
    }
    if (!resolved) return null;
    call = resolved;
  }
  if (call.type !== "call_expression") return null;
  const calleeNode = call.namedChildren[0];
  const callee = selectorCall(call);
  const fnName = callee?.method ?? (calleeNode?.type === "identifier" ? calleeNode.text : null);
  let fn = fnName ? ((analysis.functions.get(fnName) ?? [])[0] ?? null) : null;
  for (let hop = 0; hop < 4 && fn?.body; hop++) {
    if (findAll(fn.body, (n) => n.type === "func_literal").length > 0) break;
    const returned = findAll(fn.body, (n) => n.type === "return_statement")
      .flatMap((r) => findAll(r, (c) => c.type === "call_expression"))
      .find((c) => {
        const calleeNode = c.namedChildren[0];
        const name = calleeNode?.type === "identifier" ? calleeNode.text : selectorCall(c)?.method;
        return !!name && (analysis.functions.get(name) ?? []).length > 0;
      });
    const returnedCallee = returned ? returned.namedChildren[0] : null;
    const nextName = returnedCallee?.type === "identifier" ? returnedCallee.text : (returned ? selectorCall(returned)?.method : null);
    const nextFn = nextName ? (analysis.functions.get(nextName) ?? [])[0] : null;
    if (!nextFn || nextFn === fn) break;
    fn = nextFn;
  }
  if (!fn?.body) return null;

  // Select the request-handling closure: the func literal whose own block emits
  // c.JSON calls, excluding calls nested inside other (callback) literals.
  const ownedJsonCount = (literal: TsNode): number => {
    const block = findFirst(literal, (n) => n.type === "block") ?? literal;
    return findAll(block, (n) => {
      if (n.type !== "call_expression" || selectorCall(n)?.method !== "JSON") return false;
      let owner = n.parent;
      while (owner && owner.id !== block.id) {
        if (owner.type === "func_literal") return false;
        owner = owner.parent;
      }
      return true;
    }).length;
  };
  const literals = findAll(fn.body, (n) => n.type === "func_literal")
    .filter((l) => ownedJsonCount(l) > 0)
    .sort((a, b) => ownedJsonCount(b) - ownedJsonCount(a));
  const closure = literals[0];
  const block = closure ? (findFirst(closure, (n) => n.type === "block") ?? closure) : fn.body;

  const responses: RouteCandidate["responses"] = [];
  for (const jsonCall of findAll(block, (n) => n.type === "call_expression")) {
    const sel = selectorCall(jsonCall);
    if (sel?.method !== "JSON") continue;
    const jsonArgs = positionalArguments(jsonCall);
    const status = statusCode(jsonArgs[0]);
    if (!status) continue;
    const schema = payloadSchema(jsonArgs[1], block, analysis, modelIndex);
    responses.push({
      statusCode: status,
      description: "",
      confidence: schema ? "high" : "medium",
      ...(schema ? { content: [{ mediaType: "application/json", schema, confidence: "high" as Confidence }] } : {}),
    });
  }

  // Detect a JWTConfig Skipper of the form
  // `c.Request().Method == "GET" && c.Path() != "/api/articles/feed"`.
  let skipGetExcept: string | null = null;
  const callText = call.text;
  if (/Skipper/.test(callText)) {
    const pathMatch = callText.match(/Path\(\)\s*!==?\s*"([^"]+)"/);
    if (pathMatch && /Method[^\n;]{0,40}==\s*"GET"/.test(callText)) {
      skipGetExcept = pathMatch[1]!;
    }
  }
  return responses.length ? { responses, skipGetExcept } : null;
}

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
