/**
 * ASP.NET Core framework pack (C#, tree-sitter based).
 *
 * Supports two mainstream programming models:
 *  - Controller classes with [ApiController]/[Route] + [HttpGet] attributes,
 *    [FromRoute]/[FromQuery]/[FromHeader]/[FromBody] bindings and
 *    [ProducesResponseType] declarations.
 *  - Minimal APIs: app.MapGet/MapPost/... with lambda handlers, Results.Ok /
 *    Results.Created / Results.NoContent and [From*] parameter attributes.
 */

import { readFileSync } from "node:fs";
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
  SourceLocation,
} from "../core/types.js";
import type { CSharpAnalysis } from "../lang/csharp/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  attributeArguments,
  attributeStringArg,
  buildCsModelIndex,
  csTypeToSchema,
  ensureCsComponent,
  findAttribute,
  listAttributes,
  type CsModelIndex,
} from "../lang/csharp/schema.js";

const HTTP_VERB_ATTRIBUTES = new Set([
  "HttpGet",
  "HttpPost",
  "HttpPut",
  "HttpDelete",
  "HttpPatch",
  "HttpHead",
  "HttpOptions",
]);

const MINIMAL_VERB_METHODS = new Map<string, string>([
  ["MapGet", "get"],
  ["MapPost", "post"],
  ["MapPut", "put"],
  ["MapDelete", "delete"],
  ["MapPatch", "patch"],
  ["MapHead", "head"],
  ["MapMethods", "methods"],
]);

const HTTP_VERB_SET = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

/** Results.* / TypedResults.* helper methods -> HTTP status code. */
const RESULT_STATUS_METHODS: Record<string, string> = {
  BadRequest: "400",
  Unauthorized: "401",
  PaymentRequired: "402",
  Forbidden: "403",
  NotFound: "404",
  Conflict: "409",
  UnprocessableEntity: "422",
  TooManyRequests: "429",
  ValidationProblem: "400",
};

const RESULT_METHOD_NAMES = new Set([
  "Ok",
  "Created",
  "CreatedAtRoute",
  "CreatedAtAction",
  "NoContent",
  "Json",
  "Accepted",
  "Stream",
  "Redirect",
  "RedirectPermanent",
  "File",
  "Bytes",
  "FileStream",
  ...Object.keys(RESULT_STATUS_METHODS),
]);

const INJECTED_PARAMETER_TYPES = new Set([
  "CancellationToken",
  "HttpContext",
  "HttpRequest",
  "HttpResponse",
  "ILogger",
  "ILoggerFactory",
  "IWebHostEnvironment",
  "IHostEnvironment",
  "IServiceProvider",
  "IFormFile",
  "IFormFileCollection",
  "IFormCollection",
  "ClaimsPrincipal",
  "IMediator",
  "ISender",
  "IScheduler",
]);

function isInjectedService(typeNode: TsNode | undefined): boolean {
  if (!typeNode) return false;
  const text = typeNode.text.replace(/<.*>/, "");
  if (INJECTED_PARAMETER_TYPES.has(text)) return true;
  return /(?:DbContext|Service|Client|Repository|Handler|Store|Cache|Bus)$/.test(text);
}

/** FileResult and its derived types always stream a binary response body. */
function isBinaryReturnType(returnType: TsNode | undefined): boolean {
  if (!returnType) return false;
  return /\bFile(Stream|Content|Physical|Virtual)?Result\b/.test(returnType.text);
}

export const aspnetPack: FrameworkPack<CSharpAnalysis> = {
  id: "aspnet",
  language: "csharp",
  dependencyHints: ["Microsoft.AspNetCore.App", "Microsoft.AspNetCore.Mvc"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        f.language === "csharp" &&
        /Microsoft\.AspNetCore|MapGet|MapPost|ControllerBase/.test(f.content),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildCsModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      extractControllers(file.root, rel, model, candidates);
      extractMinimalApis(file.root, rel, model, candidates);
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

// Two actions may synthesize the same operationId (e.g. two "Get" actions on
// the same controller). Keep the first occurrence and suffix the rest.
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

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * Resolves the effective [Route] template and [ApiController] flag for a
 * controller. ASP.NET inherits class-level attributes from the controller's
 * base class chain (a very common pattern: an abstract `BaseController :
 * ControllerBase` carries [ApiController] and [Route("api/[controller]/[action]")]
 * while derived controllers add only their action methods).
 */
function resolveControllerRouting(
  cls: TsNode,
  model: CsModelIndex,
): { routeAttr: TsNode | null; isApiController: boolean } {
  let routeAttr = listAttributes(cls).find((a) => a.name === "Route")?.node ?? null;
  let isApi = listAttributes(cls).some((a) => a.name === "ApiController");

  let current: TsNode | null = cls;
  const guard = new Set<string>();
  while (current) {
    const baseList = current.namedChildren.find((c) => c.type === "base_list");
    if (!baseList) break;
    let baseName: string | null = null;
    for (const cand of baseList.namedChildren) {
      if (
        cand.type !== "identifier" &&
        cand.type !== "generic_name" &&
        cand.type !== "qualified_name"
      ) {
        continue;
      }
      const simple =
        cand.type === "identifier"
          ? cand.text
          : cand.type === "qualified_name"
            ? cand.namedChildren[cand.namedChildren.length - 1]?.text ?? null
            : (cand.namedChildren.find((c) => c.type === "identifier")?.text ?? null);
      if (simple) {
        baseName = simple;
        break;
      }
    }
    if (!baseName || guard.has(baseName)) break;
    guard.add(baseName);
    const baseDef = model.byName.get(baseName);
    // Framework base classes (ControllerBase, ApiController<T>, ...) are not
    // in the model index, so the chain stops here.
    if (!baseDef) break;
    if (!routeAttr) {
      routeAttr = listAttributes(baseDef.node).find((a) => a.name === "Route")?.node ?? null;
    }
    if (!isApi) {
      isApi = listAttributes(baseDef.node).some((a) => a.name === "ApiController");
    }
    current = baseDef.node;
  }
  return { routeAttr, isApiController: isApi };
}

function extractControllers(
  root: TsNode,
  rel: string,
  model: CsModelIndex,
  out: RouteCandidate[],
): void {
  const classes = findAll(root, (n) => n.type === "class_declaration");
  for (const cls of classes) {
    const attributes = listAttributes(cls);
    const routing = resolveControllerRouting(cls, model);
    const routeAttr = routing.routeAttr;
    const isApiController = routing.isApiController;
    const className = cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "";
    const looksLikeController = className.endsWith("Controller");
    if (!routeAttr && !isApiController && !looksLikeController) continue;

    const body = childrenOfType(cls, "declaration_list")[0];
    if (!body) continue;
    const methods = childrenOfType(body, "method_declaration");
    const verbMethods = methods.filter((m) =>
      listAttributes(m).some((a) => HTTP_VERB_ATTRIBUTES.has(a.name)),
    );
    if (!verbMethods.length && !routeAttr) continue;

    const controllerToken = className.replace(/Controller$/, "");
    // Class-level template: [controller] is substituted now. [action] stays a
    // literal token here because it only resolves per-method to the action name
    // (it is NOT a request path parameter).
    const classRouteRaw = routeAttr
      ? (attributeStringArg(routeAttr, new Set(["Template", "Name", "Pattern"])) ?? "").replace(
          /\[controller\]/g,
          controllerToken,
        )
      : "";

    for (const method of verbMethods) {
      const attrs = listAttributes(method);
      const verbAttr = attrs.find((a) => HTTP_VERB_ATTRIBUTES.has(a.name));
      if (!verbAttr) continue;
      const verb = verbAttr.name.replace("Http", "").toLowerCase();
      const subTemplate =
        attributeStringArg(verbAttr.node, new Set(["Template", "Name", "Pattern"])) ?? "";
      const methodName =
        method.childForFieldName("name")?.text ??
        method.namedChildren.find((c) => c.type === "identifier")?.text ??
        "";
      const expandTokens = (raw: string) =>
        raw
          .replace(/\[action\]/g, methodName)
          .replace(/\[controller\]/g, controllerToken);
      const fullPath = joinRoute(
        normalizeRoute(expandTokens(classRouteRaw)),
        normalizeRoute(expandTokens(subTemplate)),
      );
      const pathParams = new Set(
        [...fullPath.matchAll(/\{([^}?]+)\??\}/g)].map((m) => stripConstraint(m[1]!)),
      );

      const origin: SourceLocation = { file: rel, line: method.startPosition.row + 1 };
      const paramsNode = method.namedChildren.find((c) => c.type === "parameter_list");
      const { parameters, requestBody } = collectParameters(
        paramsNode,
        model,
        pathParams,
        isApiController,
      );

      const returnType = method.namedChildren.find(
        (c) =>
          c.type === "identifier" ||
          c.type === "generic_name" ||
          c.type === "predefined_type" ||
          c.type === "nullable_type" ||
          c.type === "void_keyword",
      );

      const gaps: GapCode[] = [];
      const responses = collectControllerResponses(method, verb, returnType, model, gaps);
      const isSse = responses.some((r) =>
        r.content?.some((media) => media.mediaType === "text/event-stream"),
      );

      out.push({
        method: verb,
        path: fullPath,
        fullPath,
        // Qualify with the controller token: action method names (GetAll, Create,
        // Update, Delete) collide across controllers otherwise, which produces
        // non-unique operationIds. Minimal APIs keep their explicit WithName.
        operationId: methodName ? `${controllerToken}_${methodName}` : undefined,
        origin,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
        tags: [controllerToken.charAt(0).toLowerCase() + controllerToken.slice(1)],
        ...(isSse ? { extensions: { "x-protocol": "sse" } } : {}),
        confidence: gaps.length ? "medium" : "high",
        gaps,
        components: [],
        handlerSource: sliceNode(method),
      });
    }
  }
}

function collectControllerResponses(
  method: TsNode,
  verb: string,
  returnType: TsNode | undefined,
  model: CsModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const explicit = listAttributes(method)
    .filter((a) => a.name === "ProducesResponseType" || a.name === "Produces")
    .flatMap((a) => parseProducesAttribute(a.node, model));

  if (explicit.length) return mergeResponses(explicit);

  const producesSse = listAttributes(method).some(
    (a) => a.name === "Produces" && /text\/event-stream/i.test(a.node.text),
  );

  // FileResult and its subclasses (FileStreamResult, PhysicalFileResult, ...)
  // always stream a binary payload, regardless of the generic envelope.
  if (isBinaryReturnType(returnType)) {
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [
          {
            mediaType: "application/octet-stream",
            schema: { type: "string", format: "binary" },
          },
        ],
      },
    ];
  }

  const schema = returnType ? csTypeToSchema(returnType, model) : {};
  if (producesSse && schema) {
    return [
      {
        statusCode: "200",
        description: "Server-sent events",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: schema && Object.keys(schema).length ? schema : {} }],
      },
    ];
  }

  // Generic ActionResult<T>/Task<T> unwrap to a payload schema; bare
  // IActionResult, void and parameterless Task do not.
  const bareName = returnType?.text.replace(/<.*>/, "") ?? "";
  const isEmpty =
    !returnType ||
    returnType.type === "void_keyword" ||
    (returnType.type !== "generic_name" &&
      /^(?:void|Task|ValueTask|IActionResult|ActionResult|IResult)$/.test(bareName));
  if (isEmpty) {
    if (/IActionResult|ActionResult|IResult/.test(returnType?.text ?? "")) {
      gaps.push("response-unknown");
    }
    return [{ statusCode: verb === "post" ? "200" : "200", description: "", confidence: "low" }];
  }
  if (!schema || !Object.keys(schema).length) {
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
  return [
    {
      statusCode: "200",
      description: "",
      confidence: "high",
      content: [{ mediaType: "application/json", schema }],
    },
  ];
}

function parseProducesAttribute(
  attribute: TsNode,
  model: CsModelIndex,
): DiscoveredResponse[] {
  const args = attributeArguments(attribute);
  let statusCode = "200";
  let schema: JsonSchema | undefined;
  let mediaType = "application/json";

  for (const arg of args) {
    const typeOf = findFirst(arg, (n) => n.type === "type_of_expression");
    if (typeOf) {
      const typeNode = typeOf.namedChildren[0];
      if (typeNode) {
        const typeText = typeNode.text;
        if (/File(Result|StreamResult|ContentResult)?$|^byte\[\]$/.test(typeText) && /File|byte/.test(typeText)) {
          schema = { type: "string", format: "binary" };
        } else {
          schema = csTypeToSchema(typeNode, model);
        }
      }
      continue;
    }
    const numeric = /\b(2\d{2}|4\d{2}|5\d{2})\b/.exec(arg.text);
    if (numeric) {
      statusCode = numeric[1]!;
      continue;
    }
    const statusConstant = /Status(\d{3})\w*/.exec(arg.text);
    if (statusConstant) {
      statusCode = statusConstant[1]!;
      continue;
    }
    const stringLit = findFirst(arg, (n) => n.type === "string_literal");
    if (stringLit && /\//.test(stringLit.text)) {
      mediaType = stringLit.text.replace(/^[@$]?"/, "").replace(/"$/, "");
    }
  }

  // Non-JSON media (binary downloads, PDFs, images) always carries a binary
  // schema even when the declared CLR type cannot be resolved.
  if (
    (!schema || !Object.keys(schema).length) &&
    mediaType !== "application/json" &&
    mediaType !== "text/event-stream"
  ) {
    schema = { type: "string", format: "binary" };
  }

  const response: DiscoveredResponse = {
    statusCode,
    description: "",
    confidence: schema ? "high" : "medium",
  };
  if (schema && mediaType !== "text/event-stream") {
    response.content = [{ mediaType, schema }];
  } else if (mediaType === "text/event-stream") {
    response.content = [{ mediaType, ...(schema ? { itemSchema: schema } : {}) }];
  }
  return [response];
}

function mergeResponses(responses: DiscoveredResponse[]): DiscoveredResponse[] {
  const byStatus = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = byStatus.get(response.statusCode);
    if (!existing) {
      byStatus.set(response.statusCode, response);
      continue;
    }
    const existingSse = existing.content?.some((m) => m.mediaType === "text/event-stream");
    const incomingSse = response.content?.some((m) => m.mediaType === "text/event-stream");
    if (existingSse || incomingSse) {
      // Pair [Produces("text/event-stream")] with [ProducesResponseType(typeof(T))]:
      // the typed schema describes the SSE event payload.
      const sseBase = existingSse ? existing : response;
      const typed = existingSse ? response : existing;
      const typedSchema = typed.content?.find((m) => m.schema)?.schema;
      sseBase.content = [
        {
          mediaType: "text/event-stream",
          ...(typedSchema ? { itemSchema: typedSchema } : {}),
        },
      ];
      sseBase.confidence = typedSchema ? "high" : "medium";
      byStatus.set(response.statusCode, sseBase);
      continue;
    }
    if (!existing.content && response.content) {
      existing.content = response.content;
    } else if (existing.content && response.content) {
      const existingHasSchema = existing.content.some((m) => m.schema || m.itemSchema);
      const incomingHasSchema = response.content.some((m) => m.schema || m.itemSchema);
      if (incomingHasSchema && !existingHasSchema) existing.content = response.content;
    }
    existing.confidence =
      existing.confidence === "high" || response.confidence === "high" ? "high" : "medium";
  }
  return [...byStatus.values()];
}

// ---------------------------------------------------------------------------
// Minimal APIs
// ---------------------------------------------------------------------------

function extractMinimalApis(
  root: TsNode,
  rel: string,
  model: CsModelIndex,
  out: RouteCandidate[],
): void {
  const invocations = findAll(root, (n) => n.type === "invocation_expression");
  const groupVarPrefixes = collectGroupVarPrefixes(root);
  for (const invocation of invocations) {
    const methodAccess = invocation.namedChildren.find(
      (c) => c.type === "member_access_expression",
    );
    if (!methodAccess) continue;
    const methodName = methodAccess.namedChildren[methodAccess.namedChildren.length - 1]?.text;
    if (!methodName || !MINIMAL_VERB_METHODS.has(methodName)) continue;

    const args = invocation.namedChildren.find((c) => c.type === "argument_list");
    if (!args) continue;
    const argumentNodes = childrenOfType(args, "argument");

    let verbs: string[];
    let handlerArg: TsNode | undefined;
    let routeText: string;
    if (methodName === "MapMethods") {
      // MapMethods(route, new[] { "GET", "POST" }, handler)
      const methods: string[] = [];
      for (const lit of findAll(argumentNodes[1] ?? args, (n) => n.type === "string_literal")) {
        const verb = lit.text.replace(/^[@$]?"/, "").replace(/"$/, "").toLowerCase();
        if (HTTP_VERB_SET.has(verb)) methods.push(verb);
      }
      if (!methods.length) continue;
      verbs = methods;
      routeText = routeTextFromArg(argumentNodes[0]) ?? "";
      handlerArg = argumentNodes[2];
    } else {
      verbs = [MINIMAL_VERB_METHODS.get(methodName)!];
      // Standard minimal API: MapGet("/path", handler). The IEndpointGroup
      // convention swaps them: MapPost(handler) / MapPut(handler, "{id}").
      const firstIsRoute = routeTextFromArg(argumentNodes[0]) !== null;
      if (firstIsRoute) {
        routeText = routeTextFromArg(argumentNodes[0]) ?? "";
        handlerArg = argumentNodes[1];
      } else {
        routeText = routeTextFromArg(argumentNodes[1]) ?? "";
        handlerArg = argumentNodes[0];
      }
    }
    if (!handlerArg) continue;

    // Resolve a method-group handler (e.g. MapPost(CreateTodoItem)) to the
    // static method declaration so its parameters/return shape drive the op.
    const lambda = findFirst(handlerArg, (n) => n.type === "lambda_expression") ?? null;
    let handlerMethod: TsNode | null = null;
    if (!lambda && handlerArg.type === "identifier") {
      handlerMethod = findMethodByName(root, handlerArg.text);
    }
    const handlerSource = lambda ?? handlerMethod ?? handlerArg;
    const paramsNode = handlerSource.namedChildren.find((c) => c.type === "parameter_list");

    // IEndpointGroup convention: Map(RouteGroupBuilder) on a class gets an
    // implicit /api/{ClassName} route prefix.
    let prefix = "";
    const mapMethod = enclosingNode(invocation, "method_declaration");
    if (mapMethod) {
      const pl = mapMethod.namedChildren.find((c) => c.type === "parameter_list");
      const firstParam = pl?.namedChildren[0];
      const firstParamType = firstParam?.namedChildren[0]?.text ?? "";
      if (firstParamType.includes("RouteGroupBuilder")) {
        const className = enclosingNode(mapMethod, "class_declaration")?.childForFieldName("name")?.text;
        if (className) prefix = `/api/${className}`;
      }
    }

    // MapGroup prefix: either chained (app.MapGroup("/p").MapGet(...)) or via a
    // variable (var g = app.MapGroup("/p"); g.MapGet(...)).
    const receiver = methodAccess.namedChildren[0];
    let groupPrefix = "";
    if (receiver?.type === "invocation_expression") {
      const recvAccess = receiver.namedChildren.find((c) => c.type === "member_access_expression");
      const recvName = recvAccess?.namedChildren[recvAccess.namedChildren.length - 1]?.text;
      if (recvName === "MapGroup") {
        groupPrefix = routeTextFromArg(
          receiver.namedChildren.find((c) => c.type === "argument_list")?.namedChildren[0],
        ) ?? "";
      }
    } else if (receiver?.type === "identifier" && groupVarPrefixes.has(receiver.text)) {
      groupPrefix = groupVarPrefixes.get(receiver.text)!;
    }

    const rawCombined = [prefix, groupPrefix, routeText].filter(Boolean).join("/").replace(/\/+/g, "/");
    const fullPath = normalizeRoute(rawCombined || "/");
    const pathParams = new Set(
      [...fullPath.matchAll(/\{([^}?]+)\??\}/g)].map((m) => stripConstraint(m[1]!)),
    );

    const origin: SourceLocation = { file: rel, line: invocation.startPosition.row + 1 };
    const { parameters, requestBody } = collectParameters(
      paramsNode,
      model,
      pathParams,
      true,
    );

    const gaps: GapCode[] = [];
    const responses = inferMinimalResponses(handlerSource, model, gaps);
    const withName = findChainedString(invocation, "WithName");
    const isSse = responses.some((r) =>
      r.content?.some((media) => media.mediaType === "text/event-stream"),
    );

    for (const verb of verbs) {
      out.push({
        method: verb,
        path: fullPath,
        fullPath,
        ...(withName ? { operationId: withName } : {}),
        origin,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
        tags: [],
        ...(isSse ? { extensions: { "x-protocol": "sse" } } : {}),
        confidence: gaps.length ? "medium" : "high",
        gaps,
        components: [],
        handlerSource: sliceNode(invocation),
      });
    }
  }
}

// Walk up the parent chain to the nearest ancestor of the given node type.
function enclosingNode(node: TsNode, type: string): TsNode | null {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === type) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Maps a local variable to its MapGroup prefix, e.g.
 * `var v1 = app.MapGroup("/api/v1");` -> v1 => "/api/v1". Lets later
 * `v1.MapGet(...)` calls inherit the group prefix.
 */
function collectGroupVarPrefixes(root: TsNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const call of findAll(root, (n) => n.type === "invocation_expression")) {
    const access = call.namedChildren.find((c) => c.type === "member_access_expression");
    const name = access?.namedChildren[access.namedChildren.length - 1]?.text;
    if (name !== "MapGroup") continue;
    const prefix = routeTextFromArg(
      call.namedChildren.find((c) => c.type === "argument_list")?.namedChildren[0],
    );
    if (!prefix) continue;
    // The assigned variable is the identifier on the enclosing declarator:
    // `var v1 = app.MapGroup(...)` -> variable_declaration > variable_declarator > v1.
    const varDecl = enclosingNode(call, "variable_declaration");
    const declarator = varDecl
      ? findFirst(varDecl, (n) => n.type === "variable_declarator")
      : null;
    const varName = declarator?.namedChildren.find((c) => c.type === "identifier")?.text;
    if (varName) map.set(varName, prefix);
  }
  return map;
}

// Find a method declaration in the current file by name (method-group handler).
function findMethodByName(root: TsNode, name: string): TsNode | null {
  for (const m of findAll(root, (n) => n.type === "method_declaration")) {
    if (m.childForFieldName("name")?.text === name) return m;
  }
  return null;
}

function routeTextFromArg(arg: TsNode | undefined): string | null {
  if (!arg) return null;
  const literal = findFirst(arg, (n) => n.type === "string_literal");
  if (!literal) return null;
  if (literal.text.startsWith("$")) {
    // Interpolated route: turn {identifier...} into {identifier}.
    return literal.text
      .replace(/^[@$]?"/, "")
      .replace(/"$/, "")
      .replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\??\}/g, "{$1}");
  }
  return literal.text.replace(/^[@$]?"/, "").replace(/"$/, "");
}

function inferMinimalResponses(
  lambda: TsNode,
  model: CsModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const resultCalls = findAll(lambda, (n) => {
    if (n.type !== "invocation_expression") return false;
    const access = n.namedChildren.find((c) => c.type === "member_access_expression");
    const name = access?.namedChildren[access.namedChildren.length - 1]?.text;
    return name !== undefined && RESULT_METHOD_NAMES.has(name);
  });

  if (!resultCalls.length) {
    // Expression lambda returning `new Product()` directly.
    const creation = findFirst(lambda, (n) => n.type === "object_creation_expression");
    if (creation) {
      const typeNode = creation.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "generic_name",
      );
      const schema = typeNode ? csTypeToSchema(typeNode, model) : undefined;
      if (schema && Object.keys(schema).length) {
        return [
          {
            statusCode: "200",
            description: "",
            confidence: "medium",
            content: [{ mediaType: "application/json", schema }],
          },
        ];
      }
    }    gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "low",
        content: [{ mediaType: "application/json" }],
      },
    ];
  }

  const responses: DiscoveredResponse[] = [];
  for (const call of resultCalls) {
    const access = call.namedChildren.find((c) => c.type === "member_access_expression")!;
    const name = access.namedChildren[access.namedChildren.length - 1]!.text;
    const callArgs = call.namedChildren.find((c) => c.type === "argument_list");
    const firstArg = callArgs ? childrenOfType(callArgs, "argument")[0] : undefined;

    if (name === "NoContent") {
      responses.push({ statusCode: "204", description: "", confidence: "high" });
      continue;
    }
    if (RESULT_STATUS_METHODS[name]) {
      // TypedResults.BadRequest(problem) / Results.NotFound() / Conflict(value):
      // the first argument, when present, is the (optional) error payload.
      const schema = firstArg ? inferExpressionSchema(firstArg, model, lambda) : undefined;
      responses.push({
        statusCode: RESULT_STATUS_METHODS[name]!,
        description: "",
        confidence: schema ? "high" : "medium",
        ...(schema
          ? { content: [{ mediaType: "application/json", schema }] }
          : {}),
      });
      continue;
    }
    if (name === "Redirect") {
      responses.push({ statusCode: "302", description: "", confidence: "high" });
      continue;
    }
    if (name === "RedirectPermanent") {
      responses.push({ statusCode: "301", description: "", confidence: "high" });
      continue;
    }
    if (name === "File" || name === "Bytes" || name === "FileStream") {
      const args = callArgs ? childrenOfType(callArgs, "argument") : [];
      // Results.File(bytes, contentType, fileName) / Results.Bytes(bytes, contentType):
      // the content type is the first string argument containing a slash.
      const contentTypeArg = args
        .map((a) => findFirst(a, (n) => n.type === "string_literal"))
        .find((n) => n && /\//.test(n.text));
      const mediaType = contentTypeArg
        ? contentTypeArg.text.replace(/^[@$]?"/, "").replace(/"$/, "")
        : "application/octet-stream";
      responses.push({
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [
          {
            mediaType: mediaType === "application/json" ? "application/octet-stream" : mediaType,
            schema: { type: "string", format: "binary" },
          },
        ],
      });
      continue;
    }
    if (name === "Created" || name === "CreatedAtRoute" || name === "CreatedAtAction" || name === "Accepted") {
      // Created(uri, value): the payload is the LAST argument.
      const args = callArgs ? childrenOfType(callArgs, "argument") : [];
      const payload = args[args.length - 1];
      const schema = payload ? inferExpressionSchema(payload, model, lambda) : undefined;
      responses.push({
        statusCode: name === "Accepted" ? "202" : "201",
        description: "",
        confidence: schema ? "high" : "medium",
        ...(schema
          ? { content: [{ mediaType: "application/json", schema }] }
          : {}),
      });
      continue;
    }
    if (name === "Stream") {
      responses.push({
        statusCode: "200",
        description: "Server-sent events",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: {} }],
      });
      continue;
    }
    const schema = firstArg ? inferExpressionSchema(firstArg, model, lambda) : undefined;
    responses.push({
      statusCode: "200",
      description: "",
      confidence: schema ? "high" : "medium",
      ...(schema
        ? { content: [{ mediaType: "application/json", schema }] }
        : { content: [{ mediaType: "application/json" }] }),
    });
  }

  const merged = mergeResponses(responses);
  if (merged.some((r) => r.statusCode === "200" && !r.content?.[0]?.schema)) {
    gaps.push("response-unknown");
  }
  return merged;
}

function inferExpressionSchema(
  node: TsNode,
  model: CsModelIndex,
  lambda: TsNode,
): JsonSchema | undefined {
  const creation = findFirst(node, (n) => n.type === "object_creation_expression");
  if (creation) {
    const typeNode = creation.namedChildren.find(
      (c) => c.type === "identifier" || c.type === "generic_name",
    );
    const schema = typeNode ? csTypeToSchema(typeNode, model) : undefined;
    if (schema && Object.keys(schema).length) return schema;
  }
  // Anonymous objects: new { status = "ok", count = 3 } -> object schema with
  // literal-typed properties.
  const anonymous = findFirst(
    node,
    (n) => n.type === "anonymous_object_creation_expression",
  );
  if (anonymous) {
    const properties: Record<string, JsonSchema> = {};
    let currentName: string | null = null;
    for (const child of anonymous.namedChildren) {
      if (child.type === "name_equals") {
        currentName = child.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
      } else if (currentName) {
        const literal = literalValueSchema(child);
        if (literal) properties[currentName] = literal;
        currentName = null;
      }
    }
    if (Object.keys(properties).length) return { type: "object", properties };
  }
  // Bare identifier referencing a handler parameter, e.g. Results.Created(uri, product).
  const identifier =
    node.type === "identifier"
      ? node
      : node.namedChildCount === 1 && node.namedChildren[0]?.type === "identifier"
        ? node.namedChildren[0]!
        : null;
  if (identifier) {
    const paramList = lambda.namedChildren.find((c) => c.type === "parameter_list");
    if (paramList) {
      for (const param of childrenOfType(paramList, "parameter")) {
        const paramName = param.namedChildren.filter((c) => c.type === "identifier").pop();
        if (paramName?.text !== identifier.text) continue;
        const typeNode = param.namedChildren.find(
          (c) =>
            c.type === "predefined_type" ||
            c.type === "identifier" ||
            c.type === "generic_name" ||
            c.type === "array_type" ||
            c.type === "nullable_type",
        );
        if (typeNode) {
          const schema = csTypeToSchema(typeNode, model);
          if (schema && Object.keys(schema).length) return schema;
        }
      }
    }
  }
  // Implicit new() / collection expressions cannot be typed without flow
  // analysis; leave to AI gap resolution.
  return undefined;
}

function findChainedString(invocation: TsNode, chainMethod: string): string | null {
  // Chained calls appear as invocation_expression(member_access(invocation,...)).
  let current: TsNode | null = invocation.parent;
  while (current) {
    if (current.type === "invocation_expression") {
      const access = current.namedChildren.find((c) => c.type === "member_access_expression");
      const name = access?.namedChildren[access.namedChildren.length - 1]?.text;
      if (name === chainMethod) {
        const args = current.namedChildren.find((c) => c.type === "argument_list");
        const first = args ? childrenOfType(args, "argument")[0] : undefined;
        const literal = first ? findFirst(first, (n) => n.type === "string_literal") : null;
        if (literal) return literal.text.replace(/^[@$]?"/, "").replace(/"$/, "");
      }
    }
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared parameter binding
// ---------------------------------------------------------------------------

function collectParameters(
  paramsNode: TsNode | undefined,
  model: CsModelIndex,
  pathParams: Set<string>,
  apiController: boolean,
): {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
} {
  const parameters: RouteParameter[] = [];
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

  if (!paramsNode) return { parameters };

  for (const param of childrenOfType(paramsNode, "parameter")) {
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "predefined_type" ||
        c.type === "identifier" ||
        c.type === "generic_name" ||
        c.type === "array_type" ||
        c.type === "nullable_type" ||
        c.type === "qualified_name",
    );
    const nameNode = param.namedChildren.filter((c) => c.type === "identifier").pop();
    const name = nameNode?.text;
    if (!typeNode || !name) continue;

    // File uploads bind as multipart/form-data request bodies.
    if (/^(?:IFormFile|IFormFileCollection|IFormCollection)$/.test(typeNode.text.replace(/\?.*$/, ""))) {
      const collection = typeNode.text.includes("Collection") || typeNode.text.includes("IFormCollection");
      requestBody = {
        required: !param.namedChildren.some((c) => c.type === "equals_value_clause"),
        content: [
          {
            mediaType: "multipart/form-data",
            schema: collection
              ? {
                  type: "object",
                  properties: { files: { type: "array", items: { type: "string", format: "binary" } } },
                }
              : {
                  type: "object",
                  properties: { [name]: { type: "string", format: "binary" } },
                  required: [name],
                },
          },
        ],
        confidence: "high",
      };
      continue;
    }

    if (isInjectedService(typeNode)) continue;

    const fromRoute = findAttribute(param, new Set(["FromRoute"]));
    const fromQuery = findAttribute(param, new Set(["FromQuery"]));
    const fromHeader = findAttribute(param, new Set(["FromHeader"]));
    const fromBody = findAttribute(param, new Set(["FromBody"]));
    const hasDefault = Boolean(param.namedChildren.find((c) => c.type === "equals_value_clause"));
    const nullable = typeNode.type === "nullable_type";
    const optional = nullable || hasDefault;
    const schema = csTypeToSchema(typeNode, model);

    if (fromRoute) {
      const explicit = attributeStringArg(fromRoute);
      addParam("path", explicit ?? name, schema, "high", true);
      continue;
    }
    if (fromQuery) {
      const explicit = attributeStringArg(fromQuery);
      if (explicit) {
        addParam("query", explicit, schema, "high", !optional);
      } else if (schema && "$ref" in schema) {
        // A complex [FromQuery] object binds each property as an individual
        // query parameter (ASP.NET model binding), not as one $ref parameter.
        const refName = String(schema.$ref).split("/").pop();
        const dereferenced = refName ? model.components.get(refName) : undefined;
        if (dereferenced && dereferenced.type === "object" && dereferenced.properties) {
          // A complex [FromQuery] object binds each property as an individual
          // query parameter (ASP.NET model binding), not as one $ref parameter.
          const requiredSet = new Set<string>(
            Array.isArray(dereferenced.required)
              ? (dereferenced.required as string[])
              : [],
          );
          for (const [propName, propSchema] of Object.entries(dereferenced.properties)) {
            addParam(
              "query",
              propName,
              propSchema as JsonSchema,
              "high",
              requiredSet.has(propName),
            );
          }
        } else {
          // Scalar and enum query parameters stay a single parameter.
          addParam("query", name, schema, "high", !optional);
        }
      } else {
        addParam("query", name, schema, "high", !optional);
      }
      continue;
    }
    if (fromHeader) {
      const explicit = attributeStringArg(fromHeader);
      addParam("header", explicit ?? name.toLowerCase(), schema, "high", !optional);
      continue;
    }
    if (fromBody) {
      requestBody = {
        required: !optional,
        content: [{ mediaType: "application/json", schema }],
        confidence: "high",
      };
      continue;
    }

    // [ApiController] inference: complex types bind from body (one only),
    // simple types from route/query by name.
    if (apiController) {
      const isComplex = isComplexType(typeNode, model);
      if (isComplex && !requestBody) {
        requestBody = {
          required: !optional,
          content: [{ mediaType: "application/json", schema }],
          confidence: "medium",
        };
        continue;
      }
      if (pathParams.has(name)) {
        addParam("path", name, schema, "medium", true);
      } else if (!isComplex) {
        addParam("query", name, schema, "medium", !optional);
      }
    }
  }

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}) };
}

function isComplexType(typeNode: TsNode, model: CsModelIndex): boolean {
  if (typeNode.type === "predefined_type") return false;
  if (typeNode.type === "array_type") return true;
  if (typeNode.type === "generic_name") {
    const name = typeNode.namedChildren.find((c) => c.type === "identifier")?.text;
    return !/^(?:List|IList|ICollection|IEnumerable|Nullable|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|Uri)$/.test(
      name ?? "",
    );
  }
  if (typeNode.type === "identifier") {
    const name = typeNode.text;
    if (
      /^(?:string|char|bool|int|long|short|byte|uint|ulong|float|double|decimal|object|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|Uri)$/.test(
        name,
      )
    ) {
      return false;
    }
    return true;
  }
  return model.byName.has(typeNode.text.replace(/\?.*$/, ""));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function literalValueSchema(node: TsNode): JsonSchema | null {
  if (node.type === "string_literal") return { type: "string" };
  if (node.type === "integer_literal") return { type: "integer" };
  if (node.type === "boolean_literal") return { type: "boolean" };
  if (node.type === "real_literal") return { type: "number" };
  if (node.type === "null_literal") return { type: "null" };
  return null;
}

function normalizeRoute(raw: string): string {
  if (!raw) return "";
  let route = raw.trim();
  if (route && !route.startsWith("/")) route = `/${route}`;
  // {id:int} / {id:int?} / {*slug} -> {id} / {slug}
  route = route.replace(/\{(\*+)?([A-Za-z0-9_]+)(?::[^}?]+)?(\?)?\}/g, "{$2}");
  return route;
}

function stripConstraint(token: string): string {
  return token.replace(/^\*+/, "").split(":")[0]!.replace(/\?$/, "");
}

function joinRoute(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
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

  // launchSettings.json is the standard local development entry.
  const settingsCandidates = [
    "Properties/launchSettings.json",
    "src/Properties/launchSettings.json",
  ];
  for (const rel of settingsCandidates) {
    try {
      const content = readFileSync(join(ctx.root, rel), "utf8");
      for (const match of content.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g)) {
        urls.add(`http://localhost:${match[1]}`);
      }
    } catch {
      // File is optional.
    }
  }

  for (const file of ctx.index.files) {
    if (file.language !== "csharp") continue;
    for (const match of file.content.matchAll(
      /\b(?:Run|RunAsync|UseUrls)\s*\(\s*[@$]?"(https?:\/\/[^"]+)"/g,
    )) {
      try {
        const url = new URL(match[1]!);
        urls.add(`${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`);
      } catch {
        // Ignore malformed URLs.
      }
    }
  }

  return [...urls].map((url) => ({ url }));
}
