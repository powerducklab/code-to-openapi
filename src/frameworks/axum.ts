/**
 * Axum framework pack (Rust, tree-sitter based).
 *
 * Recognizes Router::new().route("/path", get(handler).post(handler)) chains,
 * .nest()/.merge() with router functions, extractor-based handler parameters
 * (Path<T>, Query<T>, Json<T>, Form<T>), tuple status responses and Sse<T>.
 */

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
  SourceLocation,
} from "../core/types.js";
import type { RustAnalysis } from "../lang/rust/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  buildRustModelIndex,
  ensureRustComponent,
  expandStructFields,
  functionParameters,
  rustTypeToSchema,
  rustSerializationIndex,
  type RustModelIndex,
} from "../lang/rust/schema.js";

const VERB_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

const SKIP_EXTRACTORS = new Set([
  "State",
  "Extension",
  "HeaderMap",
  "TypedHeader",
  "Multipart",
  "ConnectInfo",
  "RawQuery",
  "RawPath",
  "OriginalUri",
  "Host",
  "CachedHeader",
  "Request",
  "WebSocketUpgrade",
  "DefaultBodyLimit",
  "BodyStream",
]);

const STATUS_CONSTANTS: Record<string, string> = {
  OK: "200",
  CREATED: "201",
  ACCEPTED: "202",
  NO_CONTENT: "204",
  MOVED_PERMANENTLY: "301",
  FOUND: "302",
  BAD_REQUEST: "400",
  UNAUTHORIZED: "401",
  FORBIDDEN: "403",
  NOT_FOUND: "404",
  CONFLICT: "409",
  UNPROCESSABLE_ENTITY: "422",
  INTERNAL_SERVER_ERROR: "500",
};

export const axumPack: FrameworkPack<RustAnalysis> = {
  id: "axum",
  language: "rust",
  dependencyHints: ["axum"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) => f.language === "rust" && /(?:^|\n)\s*use[^\n]*\baxum\b/.test(f.content) || /\baxum::/.test(f.content),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildRustModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      // Router functions referenced by .nest()/.merge() own their routes; the
      // global scan must not double-count them without the nested prefix.
      const nestedRouterFns = new Set<string>();
      for (const nestCall of findAll(file.root, isNestCall)) {
        const args = childrenOfType(nestCall, "arguments")[0];
        const routerCall = args?.namedChildren.find((a) => a.type === "call_expression");
        const fnName = routerCall ? calleeIdentifier(routerCall) : null;
        if (fnName) nestedRouterFns.add(fnName);
      }

      // Top-level route chains.
      for (const call of findAll(file.root, isRouteCall)) {
        if (insideNamedFunction(call, nestedRouterFns)) continue;
        const args = childrenOfType(call, "arguments")[0];
        const argNodes = args ? args.namedChildren : [];
        const routeLiteral = argNodes.find((a) => a.type === "string_literal");
        const handlerExpr = argNodes.find((a) => a.type === "call_expression");
        if (!routeLiteral || !handlerExpr) continue;
        const route = stringLiteralText(routeLiteral);
        for (const { verb, handler } of collectVerbHandlers(handlerExpr)) {
          const candidate = buildCandidate(
            analysis,
            model,
            verb,
            route,
            handler,
            rel,
            handler.startPosition.row + 1,
            "",
          );
          if (candidate) candidates.push(candidate);
        }
      }

      // .nest("/prefix", router_fn()) / .merge(router_fn()).
      for (const call of findAll(file.root, isNestCall)) {
        const args = childrenOfType(call, "arguments")[0];
        const argNodes = args ? args.namedChildren : [];
        const fieldName = chainFieldName(call);
        const prefix =
          fieldName === "nest"
            ? normalizeRoute(stringLiteralText(argNodes.find((a) => a.type === "string_literal")!))
            : "";
        const routerCall = argNodes.find((a) => a.type === "call_expression");
        const fnName = routerCall ? calleeIdentifier(routerCall) : null;
        if (!fnName) continue;
        // Modules commonly each define their own `router()`; all same-named
        // builders are expanded and deduped by method+path downstream.
        for (const routerFn of analysis.functions.get(fnName) ?? []) {
          collectRouterFunctionRoutes(analysis, model, routerFn, rel, prefix, candidates);
        }
      }
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers = detectServers(ctx);

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

// Two handlers may synthesize the same operationId (e.g. two closures named
// "root"/"handler"). Keep the first occurrence and suffix the rest so the
// emitted document has unique operationIds.
function disambiguateOperationIds(routes: RouteCandidate[]): void {
  const counts = new Map<string, number>();
  for (const r of routes) {
    if (!r.operationId) continue;
    counts.set(r.operationId, (counts.get(r.operationId) ?? 0) + 1);
  }
  const firstSeen = new Set<string>();
  const used = new Set(routes.map((r) => r.operationId).filter((x): x is string => !!x));
  for (const r of routes) {
    if (!r.operationId || (counts.get(r.operationId) ?? 1) === 1) continue;
    if (!firstSeen.has(r.operationId)) {
      firstSeen.add(r.operationId);
      continue;
    }
    let n = 2;
    let candidate = `${r.operationId}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${r.operationId}_${n}`;
    }
    used.delete(r.operationId);
    r.operationId = candidate;
    used.add(candidate);
  }
}

function collectRouterFunctionRoutes(
  analysis: RustAnalysis,
  model: RustModelIndex,
  fn: TsNode,
  rel: string,
  prefix: string,
  out: RouteCandidate[],
): void {
  for (const call of findAll(fn, isRouteCall)) {
    const args = childrenOfType(call, "arguments")[0];
    const argNodes = args ? args.namedChildren : [];
    const routeLiteral = argNodes.find((a) => a.type === "string_literal");
    const handlerExpr = argNodes.find((a) => a.type === "call_expression");
    if (!routeLiteral || !handlerExpr) continue;
    const route = joinRoute(prefix, normalizeRoute(stringLiteralText(routeLiteral)));
    for (const { verb, handler } of collectVerbHandlers(handlerExpr)) {
      const candidate = buildCandidate(
        analysis,
        model,
        verb,
        route,
        handler,
        rel,
        handler.startPosition.row + 1,
        "",
      );
      if (candidate) out.push(candidate);
    }
  }
}

function isRouteCall(node: TsNode): boolean {
  if (node.type !== "call_expression") return false;
  return chainFieldName(node) === "route";
}

function isNestCall(node: TsNode): boolean {
  if (node.type !== "call_expression") return false;
  const name = chainFieldName(node);
  return name === "nest" || name === "merge";
}

function chainFieldName(node: TsNode): string | null {
  const fieldExpression = node.namedChildren.find((c) => c.type === "field_expression");
  if (!fieldExpression) return null;
  return fieldExpression.namedChildren.find((c) => c.type === "field_identifier")?.text ?? null;
}

interface VerbHandler {
  verb: string;
  handler: TsNode;
}

function collectVerbHandlers(expr: TsNode): VerbHandler[] {
  const out: VerbHandler[] = [];
  let current: TsNode | null = expr;
  while (current && current.type === "call_expression") {
    const args = childrenOfType(current, "arguments")[0];
    // Handlers may be plain identifiers (`get(index)`), scoped paths
    // (`get(listing::list_articles)`), or service expressions such as
    // `get(kv_get.layer(CompressionLayer::new()))` / `post_service(kv_set
    //   .layer(...).with_state(state))`, whose base handler is the receiver
    // at the bottom of the `.layer`/`.with_state` decoration chain.
    const handlerArg =
      args?.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "scoped_identifier",
      ) ?? resolveDecoratedHandler(args);

    const callee: TsNode | undefined = current.namedChildren.find(
      (c) =>
        c.type === "identifier" ||
        c.type === "field_expression" ||
        c.type === "scoped_identifier",
    );

    if (callee?.type === "field_expression") {
      const rawVerb = callee.namedChildren.find((c) => c.type === "field_identifier")?.text;
      // axum exposes `get_service`/`post_service`/... method routers that take
      // a service rather than a handler function; they bind the same verb.
      const verb = rawVerb?.replace(/_service$/, "");
      if (verb && VERB_METHODS.has(verb) && handlerArg) {
        out.push({ verb, handler: handlerArg });
      }
      current = callee.namedChildren.find((c) => c.type === "call_expression") ?? null;
      continue;
    }

    const verb =
      callee?.type === "identifier"
        ? callee.text
        : callee?.type === "scoped_identifier"
          ? callee.text.split("::").pop()
          : null;
    if (verb && VERB_METHODS.has(verb) && handlerArg) {
      out.push({ verb, handler: handlerArg });
    }
    break;
  }
  return out;
}

/**
 * Finds the base handler behind a decorated service expression, following the
 * receiver of `.layer(...)`/`.route_layer(...)`/`.with_state(...)`/`.boxed()`
 * calls until it reaches the handler identifier/scoped path. Constructor
 * arguments are deliberately ignored so a layer's own services are not
 * mistaken for the handler.
 */
function resolveDecoratedHandler(args: TsNode | undefined): TsNode | undefined {
  if (!args) return undefined;
  let node: TsNode | undefined = args.namedChildren.find(
    (c) => c.type === "call_expression",
  );
  let guard = 0;
  while (node && guard < 12) {
    guard += 1;
    const callee = node.namedChildren.find(
      (c) =>
        c.type === "field_expression" ||
        c.type === "identifier" ||
        c.type === "scoped_identifier",
    );
    if (!callee) return undefined;
    if (callee.type === "identifier" || callee.type === "scoped_identifier") {
      return callee;
    }
    // field_expression: descend into the receiver (the value before `.layer`).
    const receiver = callee.namedChildren.find(
      (c) => c.type === "call_expression" || c.type === "identifier" || c.type === "scoped_identifier",
    );
    if (!receiver) return undefined;
    if (receiver.type === "identifier" || receiver.type === "scoped_identifier") {
      return receiver;
    }
    node = receiver;
  }
  return undefined;
}

function calleeIdentifier(call: TsNode): string | null {
  const callee = call.namedChildren.find(
    (c) => c.type === "identifier" || c.type === "scoped_identifier",
  );
  return callee?.text.split("::").pop() ?? null;
}

function insideNamedFunction(node: TsNode, names: Set<string>): boolean {
  let current: TsNode | null = node.parent ?? null;
  while (current) {
    if (current.type === "function_item") {
      const name = current.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name && names.has(name)) return true;
    }
    current = current.parent ?? null;
  }
  return false;
}

function buildCandidate(
  analysis: RustAnalysis,
  model: RustModelIndex,
  verb: string,
  route: string,
  handlerRef: TsNode,
  rel: string,
  line: number,
  _prefix: string,
): RouteCandidate | null {
  const fnName =
    handlerRef.type === "identifier" || handlerRef.type === "scoped_identifier"
      ? handlerRef.text.split("::").pop()!
      : null;
  const fn = fnName ? analysis.functions.get(fnName)?.[0] ?? null : null;
  if (!fn) return null;

  const fullPath = normalizeRoute(route);
  const pathParams = new Set(
    [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
  );

  const { parameters, requestBody, gaps } = collectHandlerParameters(fn, model, pathParams);
  const responses = collectResponses(fn, rustSerializationIndex(model), gaps);

  return {
    method: verb,
    path: fullPath,
    fullPath,
    operationId: fnName ?? undefined,
    origin: { file: rel, line },
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    ...(responses.some((r) =>
      r.content?.some((media) => media.mediaType === "text/event-stream"),
    )
      ? { extensions: { "x-protocol": "sse" } }
      : {}),
    confidence: gaps.length ? "medium" : "high",
    gaps,
    components: [],
    handlerSource: sliceNode(fn),
  };
}

function collectHandlerParameters(
  fn: TsNode,
  model: RustModelIndex,
  pathParams: Set<string>,
): {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
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

  for (const param of functionParameters(fn)) {
    const pattern = param.namedChildren.find(
      (c) => c.type === "tuple_struct_pattern" || c.type === "identifier",
    );
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "generic_type" ||
        c.type === "type_identifier" ||
        c.type === "reference_type" ||
        c.type === "primitive_type",
    );
    if (!typeNode) continue;

    let extractor: string | null = null;
    let binding: string | null = null;
    if (pattern?.type === "tuple_struct_pattern") {
      const ids = childrenOfType(pattern, "identifier");
      extractor = ids[0]?.text ?? null;
      binding = ids[1]?.text ?? null;
    } else if (pattern?.type === "identifier") {
      binding = pattern.text;
    }
    if (!extractor && typeNode.type === "generic_type") {
      extractor =
        typeNode.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
    }
    if (!extractor) extractor = typeNode.type === "type_identifier" ? typeNode.text : null;
    if (!extractor || SKIP_EXTRACTORS.has(extractor)) continue;

    const genericArgs = typeNode.type === "generic_type" ? genericArgumentsOf(typeNode) : [];
    const inner = genericArgs[0];

    if (extractor === "Path") {
      const tupleArgs =
        inner?.type === "tuple_type" ? inner.namedChildren.filter((c) => c.type !== ",") : [];
      if (tupleArgs.length) {
        // Path<(String, Uuid)> binds route parameters positionally.
        const routeNames = [...pathParams];
        tupleArgs.forEach((argType, index) => {
          const name = routeNames[index] ?? binding ?? `param${index + 1}`;
          addParam("path", name, rustTypeToSchema(argType, model), "high", true);
        });
      } else if (inner && model.byName.has(typeIdName(inner))) {
        for (const field of expandStructFields(inner, model)) {
          addParam("path", field.name, field.schema, "high", true);
        }
      } else {
        const name = binding ?? pathParamName(pathParams) ?? "id";
        addParam(
          "path",
          name,
          inner ? rustTypeToSchema(inner, model) : { type: "string" },
          "high",
          true,
        );
      }
      continue;
    }

    if (extractor === "Query") {
      if (inner) {
        for (const field of expandStructFields(inner, model)) {
          addParam("query", field.name, field.schema, "high", field.required);
        }
      } else {
        gaps.push("query-unknown");
      }
      continue;
    }

    if (extractor === "Json") {
      const schema = inner ? rustTypeToSchema(inner, model) : {};
      if (inner && Object.keys(schema).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
      }
      continue;
    }

    if (extractor === "Form") {
      const schema = inner ? rustTypeToSchema(inner, model) : {};
      if (inner && Object.keys(schema).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/x-www-form-urlencoded", schema }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
      }
      continue;
    }

    // Unknown extractors are left out rather than guessed.
  }

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}), gaps };
}

function pathParamName(pathParams: Set<string>): string | null {
  const only = [...pathParams];
  return only.length === 1 ? only[0]! : null;
}

function typeIdName(node: TsNode): string {
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? "";
  }
  return node.type === "type_identifier" ? node.text : "";
}

function genericArgumentsOf(node: TsNode): TsNode[] {
  const list = node.namedChildren.find((c) => c.type === "type_arguments");
  return list ? list.namedChildren : [];
}

/** Last path segment of a generic's base type, handling scoped paths such as
 *  `http::Result` or `std::result::Result`. */
function genericBaseName(node: TsNode): string | null {
  const base = node.namedChildren.find(
    (c) =>
      c.type === "type_identifier" ||
      c.type === "scoped_identifier" ||
      c.type === "scoped_type_identifier",
  );
  return base?.text.split("::").pop() ?? null;
}

function collectResponses(fn: TsNode, model: RustModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const returnType = findReturnType(fn);
  if (!returnType) {
    // A Rust handler with no `-> T` returns the unit type `()`. axum's
    // IntoResponse for `()` is an empty 200 with no body — a complete
    // contract, not an unknown response (common for DELETE handlers).
    return [{ statusCode: "200", description: "", confidence: "high" }];
  }

  // Explicit `-> ()` is the same unit/empty-body case.
  if (
    returnType.type === "tuple_type" &&
    returnType.namedChildren.filter((child) => child.type.endsWith("_type")).length === 0
  ) {
    return [{ statusCode: "200", description: "", confidence: "high" }];
  }

  // Sse<T> stream.
  const sseType = unwrapNamedGeneric(returnType, "Sse");
  if (sseType) {
    let itemSchema = sseEventType(sseType, model);
    if (!itemSchema || !Object.keys(itemSchema).length) {
      // Fall back to the payload constructed inside the handler, e.g.
      // Event::default().json_data(OrderEvent { .. }).
      itemSchema = ssePayloadFromBody(fn, model);
    }
    if (!itemSchema || !Object.keys(itemSchema).length) {
      itemSchema = {};
      gaps.push("sse-events-unknown");
    }
    return [
      {
        statusCode: "200",
        description: "Server-sent events",
        confidence: Object.keys(itemSchema).length ? "high" : "medium",
        content: [
          {
            mediaType: "text/event-stream",
            itemSchema,
          },
        ],
      },
    ];
  }

  // axum::response::Redirect has no body. Redirect::to() answers 307 and
  // Redirect::permanent() answers 308.
  if (returnType.type === "type_identifier" && returnType.text === "Redirect") {
    const permanent = /Redirect::permanent/.test(fn.text);
    return [
      {
        statusCode: permanent ? "308" : "307",
        description: "",
        confidence: "high",
      },
    ];
  }

  // (StatusCode, Json<T>) tuples.
  if (returnType.type === "tuple_type") {
    const jsonNode = findGenericInTuple(returnType, "Json");
    const status = scanBlockStatus(fn) ?? "200";
    if (jsonNode) {
      const args = genericArgumentsOf(jsonNode);
      const schema = args[0] ? rustTypeToSchema(args[0], model) : {};
      return [
        {
          statusCode: status,
          description: "",
          confidence: "high",
          ...(Object.keys(schema).length
            ? { content: [{ mediaType: "application/json", schema }] }
            : {}),
        },
      ];
    }
    const bareStatus = scanBlockStatus(fn);
    return [{ statusCode: bareStatus ?? status, description: "", confidence: "medium" }];
  }

  const jsonInner = unwrapNamedGeneric(returnType, "Json");
  if (jsonInner) {
    const schema = rustTypeToSchema(jsonInner, model);
    if (!Object.keys(schema).length) gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: Object.keys(schema).length ? "high" : "low",
        content: [
          {
            mediaType: "application/json",
            ...(Object.keys(schema).length ? { schema } : {}),
          },
        ],
      },
    ];
  }

  // Plain StatusCode return.
  if (returnType.type === "type_identifier" && returnType.text === "StatusCode") {
    return [{ statusCode: scanBlockStatus(fn) ?? "200", description: "", confidence: "medium" }];
  }

  // String/&str -> plain text.
  if (isTextType(returnType)) {
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [{ mediaType: "text/plain", schema: { type: "string" } }],
      },
    ];
  }

  // bytes::Bytes / axum::body::Bytes -> raw binary body.
  if (isBytesType(returnType)) {
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [
          { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
        ],
      },
    ];
  }

  // Result<T, E> unwrap.
  const resultInner = unwrapNamedGeneric(returnType, "Result");
  if (resultInner) {
    if (isBytesType(resultInner)) {
      return [
        {
          statusCode: "200",
          description: "",
          confidence: "high",
          content: [
            { mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } },
          ],
        },
      ];
    }
    const schema = rustTypeToSchema(resultInner, model);
    if (Object.keys(schema).length) {
      return [
        {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema }],
        },
      ];
    }
  }

  // impl IntoResponse or anything opaque.
  gaps.push("response-unknown");
  return [
    {
      statusCode: "200",
      description: "",
      confidence: "low",
      content: [{ mediaType: "application/json" }],
    },
  ];
}

function findReturnType(fn: TsNode): TsNode | null {
  const params = fn.namedChildren.find((c) => c.type === "parameters");
  let seenParams = false;
  for (const child of fn.namedChildren) {
    if (child === params) {
      seenParams = true;
      continue;
    }
    if (!seenParams) continue;
    if (child.type === "block" || child.type === "where_clause") continue;
    if (
      child.type === "generic_type" ||
      child.type === "tuple_type" ||
      child.type === "type_identifier" ||
      child.type === "primitive_type" ||
      child.type === "reference_type" ||
      child.type === "abstract_type"
    ) {
      return child;
    }
  }
  return null;
}

function unwrapNamedGeneric(node: TsNode, name: string): TsNode | null {
  let current: TsNode | null = node;
  while (current) {
    if (current.type === "generic_type") {
      const base = genericBaseName(current);
      const args = genericArgumentsOf(current);
      if (base === name) return args[0] ?? null;
      if (base === "Result" || base === "Response") {
        current = args[0] ?? null;
        continue;
      }
    }
    if (current.type === "type_identifier" && current.text === name) return current;
    if (current.type === "scoped_identifier" && current.text.split("::").pop() === name) return current;
    return null;
  }
  return null;
}

function findGenericInTuple(tuple: TsNode, name: string): TsNode | null {
  return (
    tuple.namedChildren.find(
      (c) =>
        c.type === "generic_type" &&
        c.namedChildren.find((x) => x.type === "type_identifier")?.text === name,
    ) ?? null
  );
}

function sseEventType(node: TsNode, model: RustModelIndex): JsonSchema | undefined {
  // Sse<SseItem<T>> or Sse<impl Stream<Item = Result<Event, E>>>.
  if (node.type === "generic_type") {
    const base = node.namedChildren.find((c) => c.type === "type_identifier")?.text;
    if (base === "SseItem") {
      const args = genericArgumentsOf(node);
      return args[0] ? rustTypeToSchema(args[0], model) : undefined;
    }
  }
  // Try to find a Result<Event, _> type argument inside the stream impl.
  const resultGeneric = findFirst(node, (n) => {
    if (n.type !== "generic_type") return false;
    return n.namedChildren.find((c) => c.type === "type_identifier")?.text === "Result";
  });
  if (resultGeneric) {
    const args = genericArgumentsOf(resultGeneric);
    if (args[0]) return rustTypeToSchema(args[0], model);
  }
  return undefined;
}

function ssePayloadFromBody(fn: TsNode, model: RustModelIndex): JsonSchema | undefined {
  // Event::default().json_data(Payload { .. }) or SseItem::new(Payload { .. }).
  const jsonDataCalls = findAll(fn, (n) => {
    if (n.type !== "call_expression") return false;
    return /\.(json_data)\b/.test(n.text.slice(0, 200)) || /SseItem/.test(n.text.slice(0, 120));
  });
  for (const call of jsonDataCalls) {
    for (const creation of findAll(call, (n) => n.type === "struct_expression")) {
      const name = creation.namedChildren.find((c) => c.type === "type_identifier")?.text;
      if (name) {
        const ensured = ensureRustComponent(name, model);
        if (ensured) return ensured;
      }
    }
    for (const id of findAll(call, (n) => n.type === "identifier")) {
      const ensured = ensureRustComponent(id.text, model);
      if (ensured) return ensured;
    }
  }
  return undefined;
}

function scanBlockStatus(fn: TsNode): string | null {
  for (const scoped of findAll(fn, (n) => n.type === "scoped_identifier")) {
    const constant = scoped.namedChildren[scoped.namedChildren.length - 1];
    if (constant && STATUS_CONSTANTS[constant.text]) {
      return STATUS_CONSTANTS[constant.text]!;
    }
  }
  return null;
}

function isTextType(node: TsNode): boolean {
  if (node.type === "reference_type") {
    return node.text.replace(/^&/, "").replace(/'[a-z_]+\s*/g, "").trim() === "str";
  }
  return node.type === "type_identifier" && node.text === "String";
}

function isBytesType(node: TsNode): boolean {
  // bytes::Bytes / axum::body::Bytes surface as a bare `Bytes` type identifier.
  return node.type === "type_identifier" && node.text === "Bytes";
}

function normalizeRoute(raw: string): string {
  let route = raw.trim();
  if (!route) return "/";
  if (!route.startsWith("/")) route = `/${route}`;
  // Axum 0.7 syntax: :id and *catch -> {id} / {catch}; 0.8 already uses {id}.
  route = route.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  route = route.replace(/\*([A-Za-z0-9_]+)/g, "{$1}");
  return route;
}

function joinRoute(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
}

function stringLiteralText(node: TsNode): string {
  const raw = node.text;
  const match = /^"(.*)"$/.exec(raw);
  return match ? match[1]! : raw.replace(/^"/, "").replace(/"$/, "");
}

function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
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
  for (const file of ctx.index.files) {
    if (file.language !== "rust") continue;
    for (const match of file.content.matchAll(
      /TcpListener::bind\s*\(\s*"((?:https?|tcp):\/\/[^"]+|\d{1,3}(?:\.\d{1,3}){3}:\d+|127\.0\.0\.1:\d+|0\.0\.0\.0:\d+)"/g,
    )) {
      const raw = match[1]!;
      if (raw.startsWith("http")) urls.add(raw);
      else urls.add(`http://${raw}`);
    }
    // SocketAddr parsed from a string literal: "127.0.0.1:8080".parse()
    for (const match of file.content.matchAll(
      /"(\d{1,3}(?:\.\d{1,3}){3}:\d+)"\s*\.parse\s*\(/g,
    )) {
      urls.add(`http://${match[1]}`);
    }
  }
  return [...urls].map((url) => ({ url }));
}
