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

    return { routes: dedupe(candidates), unresolved, components, securitySchemes, servers };
  },
};

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

function extractControllers(
  root: TsNode,
  rel: string,
  model: CsModelIndex,
  out: RouteCandidate[],
): void {
  const classes = findAll(root, (n) => n.type === "class_declaration");
  for (const cls of classes) {
    const attributes = listAttributes(cls);
    const routeAttr = attributes.find((a) => a.name === "Route")?.node ?? null;
    const isApiController = attributes.some((a) => a.name === "ApiController");
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
    const classRoute = routeAttr
      ? normalizeRoute(
          (attributeStringArg(routeAttr, new Set(["Template", "Name", "Pattern"])) ?? "")
            .replace(/\[controller\]/g, controllerToken)
            .replace(/\[action\]/g, "{action}"),
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
      const template = subTemplate
        .replace(/\[action\]/g, methodName)
        .replace(/\[controller\]/g, controllerToken);
      const fullPath = joinRoute(classRoute, normalizeRoute(template));
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
        operationId: methodName || undefined,
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

  const schema = returnType ? csTypeToSchema(returnType, model) : {};
  if (producesSse && schema) {
    return [
      {
        statusCode: "200",
        description: "Server-sent events",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", ...(schema ? { itemSchema: schema } : {}) }],
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
      if (typeNode) schema = csTypeToSchema(typeNode, model);
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
    existing.content = existing.content ?? response.content;
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
    const routeArg = argumentNodes[0];
    const handlerArg = argumentNodes[1];
    const routeText = routeTextFromArg(routeArg);
    if (routeText === null || !handlerArg) continue;

    let verb = MINIMAL_VERB_METHODS.get(methodName)!;
    if (verb === "methods") {
      const methodsLiteral = argumentNodes[1]?.text ?? "";
      verb = /"POST"/i.test(methodsLiteral) ? "post" : "get";
    }

    const lambda = findFirst(handlerArg, (n) => n.type === "lambda_expression") ?? handlerArg;
    const paramsNode = lambda.namedChildren.find((c) => c.type === "parameter_list");
    const fullPath = normalizeRoute(routeText);
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
    const responses = inferMinimalResponses(lambda, model, gaps);
    const withName = findChainedString(invocation, "WithName");
    const isSse = responses.some((r) =>
      r.content?.some((media) => media.mediaType === "text/event-stream"),
    );

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
    return (
      name === "Ok" ||
      name === "Created" ||
      name === "CreatedAtRoute" ||
      name === "CreatedAtAction" ||
      name === "NoContent" ||
      name === "Json" ||
      name === "Accepted" ||
      name === "Stream"
    );
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
        content: [{ mediaType: "text/event-stream" }],
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
      addParam("query", explicit ?? name, schema, "high", !optional);
      continue;
    }
    if (fromHeader) {
      const explicit = attributeStringArg(fromHeader);
      addParam("header", (explicit ?? name).toLowerCase(), schema, "high", !optional);
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
