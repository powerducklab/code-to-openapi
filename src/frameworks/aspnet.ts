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

import { mergeResponseVariants } from "../core/response-variants.js";
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
import { LRT_MARKER } from "../lang/csharp/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  attributeArguments,
  attributeStringArg,
  buildCsModelIndex,
  csTypeToSchema,
  csSerializationIndex,
  scopedName,
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

const SUCCESS_RESULT_STATUS: Record<string, string> = {
  Ok: "200",
  Created: "201",
  CreatedAtRoute: "201",
  CreatedAtAction: "201",
  CreatedAtUri: "201",
  Accepted: "202",
  AcceptedAtRoute: "202",
  AcceptedAtAction: "202",
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
  "IDbConnection",
  "DbConnection",
  "SqlConnection",
  "SqliteConnection",
  "NpgsqlConnection",
  "MySqlConnection",
  "OracleConnection",
]);

function isInjectedService(typeNode: TsNode | undefined, model?: CsModelIndex): boolean {
  if (!typeNode) return false;
  // Generic DI wrappers from MinimalApis.Extensions are value binders, not services.
  const text = typeNode.text.replace(/<.*>/, "");
  if (INJECTED_PARAMETER_TYPES.has(text)) return true;
  if (/(?:DbContext|Service|Client|Repository|Handler|Store|Cache|Bus|Db)$/.test(text)) return true;
  // A type deriving from DbContext (e.g. TodoDb) is always DI-injected.
  if (model) {
    const genericName =
      typeNode.type === "generic_name"
        ? typeNode.namedChildren.find((c) => c.type === "identifier")?.text
        : undefined;
    const base = genericName ?? text;
    const def = model.byName.get(base);
    if (def?.baseList && /DbContext/.test(def.baseList.text)) return true;
  }
  return false;
}

/**
 * MinimalApis.Extensions value-binder wrappers whose inner type is the request
 * body: Body<T>, Bind<T>, ModelBinder<T>. Returns the inner type node when matched.
 */
function bodyWrapperInner(typeNode: TsNode): TsNode | undefined {
  if (typeNode.type !== "generic_name") return undefined;
  const name = typeNode.namedChildren.find((c) => c.type === "identifier")?.text;
  if (name !== "Body" && name !== "Bind" && name !== "ModelBinder" && name !== "ValidatedWrapper" && name !== "Validated") {
    return undefined;
  }
  const args = typeNode.namedChildren.find((c) => c.type === "type_argument_list");
  const first = args?.namedChildren.find(
    (c) =>
      c.type === "predefined_type" ||
      c.type === "identifier" ||
      c.type === "generic_name" ||
      c.type === "array_type" ||
      c.type === "nullable_type",
  );
  return first;
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

    const convention=controllerPrefix(analysis);
    for (const [rel, file] of analysis.files) {
      const start=candidates.length;
      extractControllers(file.root, rel, model, candidates);
      if(convention)for(const route of candidates.slice(start)){
        route.path=('/'+convention.prefix+'/'+route.path).replace(/\/+/g,'/');route.fullPath=route.path;
        if(convention.dynamic)route.gaps=[...new Set([...(route.gaps??[]),'path-dynamic' as const])];
      }
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

/** Recognize a registered, source-proven controller route-prefix convention. */
function controllerPrefix(analysis:CSharpAnalysis):{prefix:string;dynamic:boolean}|undefined{
 const conventions=new Set<string>();
 for(const file of analysis.files.values())for(const declaration of findAll(file.root,n=>n.type==='class_declaration')){
  const bases=declaration.namedChildren.find(n=>n.type==='base_list');
  if(!bases?.text.includes('IApplicationModelConvention'))continue;
  const text=declaration.text;
  if(!/new\s*\(\s*new\s+RouteAttribute\(prefix\)\)/.test(text)&&!/new\s+AttributeRouteModel\(\s*new\s+RouteAttribute\(prefix\)\)/.test(text))continue;
  if(!/AttributeRouteModel\.CombineAttributeRouteModel\(\s*_prefix\s*,\s*selector\.AttributeRouteModel\s*\)/.test(text))continue;
  if(!/application\.Controllers\.SelectMany\(\s*\w+\s*=>\s*\w+\.Selectors\s*\)/.test(text))continue;
  const name=declaration.childForFieldName('name')?.text;if(name)conventions.add(name);
 }
 const found:Array<{prefix:string;dynamic:boolean}>=[];
 for(const file of analysis.files.values())for(const call of findAll(file.root,n=>n.type==='invocation_expression')){
  const callee=call.namedChildren.find(n=>n.type==='member_access_expression');if(!callee?.text.endsWith('.Conventions.Add'))continue;
  const creation=findFirst(call,n=>n.type==='object_creation_expression');
  const name=creation?.childForFieldName('type')?.text??creation?.namedChildren.find(n=>n.type==='identifier')?.text;
  if(!creation||!name||!conventions.has(name))continue;
  const args=creation.namedChildren.find(n=>n.type==='argument_list');const argument=args?.namedChildren[0];
  const value=argument?.namedChildren[0];if(!value)continue;
  if(value.type==='string_literal')found.push({prefix:value.text.slice(1,-1),dynamic:false});
  else if(value.type==='binary_expression'&&value.children.some(c=>c.text==='??')){
   const right=value.namedChildren.at(-1);if(right?.type==='string_literal')found.push({prefix:right.text.slice(1,-1),dynamic:true});
  }
 }
 return found.length===1?found[0]:undefined;
}

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
      const responses = collectControllerResponses(method, verb, returnType, csSerializationIndex(model), gaps);
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

  // MVC's NoContent() remains 204 when wrapped in Task/ValueTask<IActionResult>.
  // Only inspect returns belonging to this method, never nested lambdas/helpers.
  const controller = enclosingNode(method, 'class_declaration');
  const ownedReturns = findAll(method, n => n.type === 'return_statement').filter(n => {
    let parent = n.parent;
    while (parent && parent.id !== method.id) {
      if (['lambda_expression', 'anonymous_method_expression', 'local_function_statement'].includes(parent.type)) return false;
      parent = parent.parent;
    }
    return parent?.id === method.id;
  });
  const returnedExpressions = ownedReturns.map(n => n.namedChildren[0]);
  const expressionBody = method.namedChildren.find(n => n.type === 'arrow_expression_clause');
  if (expressionBody) returnedExpressions.push(expressionBody.namedChildren[0]);
  const mvcBase = controller?.namedChildren.find(n => n.type === 'base_list')?.namedChildren.some(n => /^(?:Microsoft\.AspNetCore\.Mvc\.)?Controller(?:Base)?$/.test(n.text));
  const overridden = controller && findAll(controller, n => n.type === 'method_declaration').some(n => n.childForFieldName('name')?.text === 'NoContent');
  if (mvcBase && !overridden && returnedExpressions.length && returnedExpressions.every(n =>
    n?.type === 'invocation_expression' && ['NoContent', 'base.NoContent', 'this.NoContent'].includes(n.namedChildren[0]?.text ?? '') &&
    n.namedChildren.find(c => c.type === 'argument_list')?.namedChildren.length === 0)) {
    return [{statusCode:'204',description:'',confidence:'high'}];
  }

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

  // A source-proven mediator request carries its declared response via IRequest<T>.
  const mediatorCalls=findAll(method,n=>n.type==='invocation_expression'&&/\bmediator\.Send$/.test(n.namedChildren.find(c=>c.type==='member_access_expression')?.text??''));
  const owner=enclosingNode(method,'class_declaration');
  if(mediatorCalls.length===1&&/\bIMediator\s+mediator\b/.test(owner?.text??'')){
    const call=mediatorCalls[0]!;const arg=call.namedChildren.find(n=>n.type==='argument_list')?.namedChildren[0]?.namedChildren[0];
    let requestType:TsNode|undefined;
    if(arg?.type==='identifier')requestType=childrenOfType(method,'parameter_list')[0]?.namedChildren.find(p=>p.type==='parameter'&&p.namedChildren.at(-1)?.text===arg.text)?.childForFieldName('type')??undefined;
    else if(arg?.type==='object_creation_expression')requestType=arg.childForFieldName('type')??undefined;
    const requestName=requestType?scopedName(requestType,model):undefined;const def=requestName?model.byName.get(requestName):undefined;
    const requestInterface=def?.baseList?.namedChildren.find(n=>n.type==='generic_name'&&n.namedChildren[0]?.text==='IRequest');
    const reply=requestInterface?.namedChildren.find(n=>n.type==='type_argument_list')?.namedChildren[0];
    if(reply){
      const observed=csTypeToSchema(reply,model);
      const statuses=findAll(method,n=>n.type==='member_access_expression').map(n=>/^StatusCodes\.Status(\d{3})\w+$/.exec(n.text)?.[1]).filter((x):x is string=>!!x);
      if(new Set(statuses).size<=1&&Object.keys(observed).length)return [{statusCode:statuses[0]??'200',description:'',confidence:'medium',content:[{mediaType:'application/json',schema:observed}]}];
    }
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
      else if (incomingHasSchema && existingHasSchema) {
        byStatus.set(response.statusCode, mergeResponseVariants(existing, response));
        continue;
      }
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
    const bareIdentifier =
      handlerArg.type === "identifier"
        ? handlerArg
        : findFirst(handlerArg, (n) => n.type === "identifier" && n.parent?.type === "argument");
    if (!lambda && bareIdentifier && !findFirst(handlerArg, (n) => n.type === "member_access_expression")) {
      handlerMethod = findMethodByName(root, bareIdentifier.text);
    } else if (!lambda) {
      // Selector method group, e.g. MapGet("/x", Endpoints.HelloWorldFunc).
      const selectorAccess =
        handlerArg.type === "member_access_expression"
          ? handlerArg
          : findFirst(handlerArg, (n) => n.type === "member_access_expression");
      const owner = selectorAccess?.namedChildren[0];
      const selector = selectorAccess?.namedChildren[selectorAccess.namedChildren.length - 1];
      if (owner?.type === "identifier" && selector?.type === "identifier") {
        const clsNode = model.byName.get(owner.text)?.node;
        if (clsNode) {
          handlerMethod =
            findFirst(
              clsNode,
              (c) => c.type === "method_declaration" && c.childForFieldName("name")?.text === selector.text,
            ) ?? null;
        }
        if (!handlerMethod) handlerMethod = findSelectorMethod(root, owner.text, selector.text);
      }
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
    const responses = inferMinimalResponses(handlerSource, csSerializationIndex(model), gaps);
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
  for (const m of findAll(
    root,
    (n) => n.type === "method_declaration" || n.type === "local_function_statement" || n.type === "local_function",
  )) {
    const decl =
      m.type === "local_function_statement"
        ? (findFirst(m, (c) => c.type === "local_function") ?? m)
        : m;
    if (decl.childForFieldName("name")?.text === name || m.childForFieldName("name")?.text === name) return m;
  }
  return null;
}

/** Resolve a `Class.Method` selector method group to its declaration. */
function findSelectorMethod(root: TsNode, className: string, methodName: string): TsNode | null {
  for (const cls of findAll(root, (n) =>
    n.type === "class_declaration" || n.type === "record_declaration" || n.type === "struct_declaration")) {
    if (cls.childForFieldName("name")?.text !== className) continue;
    const method = cls.namedChildren.find(
      (c) => c.type === "method_declaration" && c.childForFieldName("name")?.text === methodName,
    );
    if (method) return method;
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

/** Split a generic argument list on top-level commas (respecting nesting). */
function splitTopCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Build a JSON Schema from a C# type expressed as text (e.g. "Todo",
 * "List<Todo>", "Results<Ok<Todo>, NotFound>"). Used for contracts only
 * available as preserved type text, never for runtime values.
 */
function schemaFromCsTypeText(raw: string, model: CsModelIndex): JsonSchema | undefined {
  let t = raw.trim().replace(/\s+/g, " ");
  if (!t) return undefined;
  if (t.endsWith("?")) t = t.slice(0, -1).trim();
  if (t === "void" || t === "Task" || t === "ValueTask") return undefined;

  if (t.endsWith("[]")) {
    const inner = schemaFromCsTypeText(t.slice(0, -2).trim(), model);
    return { type: "array", items: inner ?? {} };
  }

  const generic = /^([A-Za-z_][\w.]*)\s*<(.*)>$/.exec(t);
  if (generic) {
    const name = generic[1]!.split(".").pop()!;
    const args = splitTopCommas(generic[2]!).map((a) => schemaFromCsTypeText(a, model));
    if (COLLECTION_TYPE_NAMES.has(name)) return { type: "array", items: args[0] ?? {} };
    if (name === "Dictionary" || name === "IDictionary") {
      return { type: "object", ...(args[1] ? { additionalProperties: args[1] } : {}) };
    }
    if (WRAPPER_TYPE_NAMES.has(name)) return args[0];
    if (model.byName.has(name)) {
      ensureCsComponent(name, model);
      return { $ref: `#/components/schemas/${model.componentNames?.get(name) ?? name}` };
    }
    return undefined;
  }

  const simple = t.split(".").pop()!;
  if (simple === "string" || simple === "char" || simple === "Guid" || simple === "string?") {
    return { type: "string", ...(simple === "Guid" ? { format: "uuid" } : {}) };
  }
  if (simple === "bool" || simple === "Boolean") return { type: "boolean" };
  if (new Set(["int", "long", "short", "byte", "uint", "ulong", "ushort", "sbyte"]).has(simple)) {
    return { type: "integer", ...(simple === "long" || simple === "ulong" ? { format: "int64" } : {}) };
  }
  if (new Set(["double", "float", "decimal", "Double", "Single"]).has(simple)) return { type: "number" };
  if (new Set(["DateTime", "DateTimeOffset", "DateOnly"]).has(simple)) return { type: "string", format: "date-time" };
  if (simple === "TimeOnly" || simple === "TimeSpan") return { type: "string", format: "time" };
  if (simple === "object" || simple === "JsonElement" || simple === "JsonDocument") return { type: "object" };
  if (simple === "byte" || /Stream$/.test(simple)) return { type: "string", format: "binary" };
  if (model.byName.has(simple)) {
    ensureCsComponent(simple, model);
    return { $ref: `#/components/schemas/${model.componentNames?.get(simple) ?? simple}` };
  }
  return undefined;
}

const COLLECTION_TYPE_NAMES = new Set([
  "List", "IList", "ICollection", "IEnumerable", "Collection", "IReadOnlyList",
  "IReadOnlyCollection", "HashSet", "ISet", "Array",
]);
const WRAPPER_TYPE_NAMES = new Set(["Task", "ValueTask", "ActionResult", "Nullable"]);

/** Typed result type name -> HTTP status code (Microsoft.AspNetCore.Http.HttpResults). */
const TYPED_RESULT_STATUS: Record<string, string> = {
  Ok: "200",
  Created: "201",
  CreatedAtRoute: "201",
  CreatedAtAction: "201",
  Accepted: "202",
  NoContent: "204",
  BadRequest: "400",
  ValidationProblem: "400",
  ProblemHttpResult: "400",
  UnauthorizedHttpResult: "401",
  Unauthorized: "401",
  ForbidHttpResult: "403",
  Forbidden: "403",
  NotFound: "404",
  Conflict: "409",
  UnprocessableEntity: "422",
  UnprocessableEntityHttpResult: "422",
  TooManyDocuments: "429",
};

const BINARY_RESULT_TYPES = /^(FileContent|FileStream|PhysicalFile|VirtualFile|File|Content)HttpResult$/;

/** Parse `Name<A, B>` into its name and top-level raw type arguments. */
function splitGeneric(text: string): { name: string; args: string[] } | null {
  const m = /^([A-Za-z_][\w.]*)\s*<(.*)>$/.exec(text.trim());
  if (!m) return { name: text.trim().split(".").pop()!, args: [] };
  return { name: m[1]!.split(".").pop()!, args: splitTopCommas(m[2]!) };
}

/**
 * Expand a preserved explicit lambda return type into typed-result responses,
 * e.g. Task<Results<Ok<Todo>, NotFound>> -> 200 Todo + 404.
 */
function responsesFromDeclaredReturnType(
  lambda: TsNode,
  model: CsModelIndex,
): DiscoveredResponse[] | null {
  let typeText: string | null = null;
  for (const decl of findAll(lambda, (n) => n.type === "variable_declarator" || n.type === "assignment_expression")) {
    const isMarker = findFirst(
      decl,
      (n) => n.type === "identifier" && n.text === LRT_MARKER,
    );
    if (!isMarker) continue;
    const lit = findFirst(
      decl,
      (n) =>
        n.type === "string_literal" ||
        n.type === "verbatim_string_literal" ||
        n.type === "raw_string_literal",
    );
    if (lit) typeText = lit.text.replace(/^@?\$?"?/, "").replace(/"\$?$/, "");
  }
  if (!typeText) return null;

  // Unwrap Task<> / ValueTask<> / ActionResult<>.
  let inner = typeText.trim();
  for (;;) {
    const g = /^(Task|ValueTask|ActionResult)\s*<(.*)>$/.exec(inner);
    if (!g) break;
    inner = g[2]!.trim();
  }

  const json = (statusCode: string, schema: JsonSchema | undefined, confidence: Confidence): DiscoveredResponse => ({
    statusCode,
    description: "",
    confidence,
    ...(schema ? { content: [{ mediaType: "application/json", schema }] } : {}),
  });

  const resultForType = (raw: string): DiscoveredResponse | null => {
    const { name, args } = splitGeneric(raw)!;
    if (BINARY_RESULT_TYPES.test(name)) {
      return {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } }],
      };
    }
    if (name === "EmptyHttpResult" || name === "NoContent") {
      return { statusCode: TYPED_RESULT_STATUS[name] ?? "204", description: "", confidence: "high" };
    }
    if (name === "RedirectHttpResult" || name === "Redirect") {
      return { statusCode: "302", description: "", confidence: "high" };
    }
    if (name === "StreamHttpResult") {
      return {
        statusCode: "200",
        description: "Streamed response",
        confidence: "medium",
        content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } }],
      };
    }
    if (TYPED_RESULT_STATUS[name]) {
      // Created* payload is the last type argument; Ok<T>/BadRequest<T> the first.
      const payloadArg = /Created|Accepted/.test(name) ? args[args.length - 1] : args[0];
      const schema = payloadArg ? schemaFromCsTypeText(payloadArg, model) : undefined;
      return json(TYPED_RESULT_STATUS[name]!, schema, schema ? "high" : "medium");
    }
    if (name === "Results") {
      return null; // expanded by caller
    }
    // A concrete DTO return (Task<Todo>, Todo) is a 200 JSON body.
    const dto = schemaFromCsTypeText(raw, model);
    if (dto) return json("200", dto, "medium");
    return null;
  };

  const resultsUnion = /^Results\s*<(.*)>$/.exec(inner);
  const typeList = resultsUnion ? splitTopCommas(resultsUnion[1]!) : [inner];
  const out: DiscoveredResponse[] = [];
  for (const t of typeList) {
    const r = resultForType(t.trim());
    if (r && !out.some((e) => e.statusCode === r.statusCode)) out.push(r);
  }
  return out.length ? out : null;
}

/**
 * Infer a 200 response for a lambda that returns a value directly (no Results.*
 * call): string -> text/plain; anonymous object / DTO / array -> JSON.
 */
function inferDirectReturn(lambda: TsNode, model: CsModelIndex): DiscoveredResponse | null {
  // Expression-bodied lambda: the value after `=>`; otherwise return statements.
  const exprs: TsNode[] = [];
  for (const ret of findAll(lambda, (n) => n.type === "return_statement")) {
    const v = ret.namedChildren.find((c) => !/^;?$/.test(c.type));
    if (v) exprs.push(v);
  }
  if (!exprs.length) {
    // Expression lambda: named children are parameter_list then the body expr.
    const last = lambda.namedChildren[lambda.namedChildren.length - 1];
    if (last && last.type !== "block" && last.type !== "parameter_list") exprs.push(last);
  }

  let sawString = false;
  for (const expr of exprs) {
    // The return value itself is a string literal (possibly interpolated):
    // always a text response regardless of embedded calls/formatters.
    if (
      expr.type === "string_literal" ||
      expr.type === "interpolated_string_expression" ||
      expr.type === "verbatim_string_literal" ||
      expr.type === "raw_string_literal"
    ) {
      sawString = true;
      continue;
    }
    const hasString = findFirst(
      expr,
      (n) => n.type === "string_literal" || n.type === "interpolated_string_expression",
    );
    const hasDataCall = findFirst(
      expr,
      (n) =>
        n.type === "invocation_expression" &&
        !/Results|TypedResults/.test(n.text.slice(0, 40)) &&
        !/^\s*nameof\s*\(/.test(n.text) &&
        !/\.\s*ToString\s*\(\s*\)/.test(n.text),
    );
    if (hasString && !hasDataCall) sawString = true;
  }

  // Prefer an explicit object/array creation or anonymous object.
  const creation =
    findFirst(lambda, (n) => n.type === "anonymous_object_creation_expression") ??
    findFirst(lambda, (n) => n.type === "object_creation_expression") ??
    findFirst(lambda, (n) => n.type === "array_creation_expression") ??
    findFirst(lambda, (n) => n.type === "implicit_array_creation_expression") ??
    null;
  if (creation) {
    const schema = inferExpressionSchema(creation, model, lambda);
    if (schema && Object.keys(schema).length) {
      return { statusCode: "200", description: "", confidence: "medium", content: [{ mediaType: "application/json", schema }] };
    }
  }
  if (sawString) {
    return { statusCode: "200", description: "", confidence: "medium", content: [{ mediaType: "text/plain", schema: { type: "string" } }] };
  }
  // Data-access calls: EF Core DbSet ToListAsync/FindAsync, JsonDocument.Parse.
  for (const expr of exprs) {
    const data = inferDataCallSchema(expr, lambda, model);
    if (data) {
      return { statusCode: "200", description: "", confidence: "medium", content: [{ mediaType: "application/json", schema: data }] };
    }
  }
  return null;
}

/** Map a lambda's parameter names to their declared type short name. */
function lambdaParamTypes(lambda: TsNode): Map<string, string> {
  const map = new Map<string, string>();
  const params = lambda.namedChildren.find((c) => c.type === "parameter_list");
  if (!params) return map;
  for (const param of childrenOfType(params, "parameter")) {
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "predefined_type" ||
        c.type === "identifier" ||
        c.type === "generic_name" ||
        c.type === "qualified_name",
    );
    const nameNode = param.namedChildren.filter((c) => c.type === "identifier").pop();
    if (typeNode && nameNode) map.set(nameNode.text, typeNode.text.replace(/<.*>/, ""));
  }
  return map;
}

/** Resolve a `db.Todos` DbSet/collection property to its element type name. */
function resolveCollectionElementType(
  ownerType: string,
  property: string,
  model: CsModelIndex,
): string | undefined {
  const def = model.byName.get(ownerType.split(".").pop()!);
  const wanted = property.toLowerCase();
  const field = def?.fields.find((f) => f.name.toLowerCase() === wanted);
  if (!field) return undefined;
  const m = /(?:DbSet|List|IList|ICollection|IEnumerable|Collection|HashSet)\s*<\s*([A-Za-z_][\w.?]*)\s*>/.exec(
    field.typeNode.text,
  );
  return m?.[1]?.replace(/\?$/, "");
}

/**
 * Infer the schema of a data-access return expression, covering EF Core
 * DbSet terminal methods and JSON parsing. Only provable shapes are returned;
 * anything else stays unresolved for AI gap review.
 */
function inferDataCallSchema(
  node: TsNode,
  lambda: TsNode,
  model: CsModelIndex,
): JsonSchema | undefined {
  const invocations =
    node.type === "invocation_expression"
      ? [node, ...findAll(node, (n) => n.type === "invocation_expression")]
      : findAll(node, (n) => n.type === "invocation_expression");
  const outer = invocations[0];
  if (!outer) return undefined;

  const outerAccess = outer.namedChildren.find((c) => c.type === "member_access_expression");
  const method = (outerAccess?.namedChildren[outerAccess.namedChildren.length - 1]?.text ?? "").replace(
    /<.*>$/,
    "",
  );

  // Any receiver's ToString() yields a plain string at runtime.
  if (method === "ToString" && /\(\s*\)$/.test(outer.text.slice(outer.text.indexOf("ToString")))) {
    return { type: "string" };
  }

  // JsonDocument.Parse / JsonSerializer.Deserialize<T>: free-form JSON.
  if (/Parse|Deserialize/.test(method)) {
    const receiver = outerAccess?.namedChildren[0];
    const receiverText = receiver?.text ?? "";
    if (/JsonDocument|JsonElement|JsonNode|JsonSerializer/.test(receiverText)) {
      const generic = /Deserialize(?:Async)?\s*<\s*([A-Za-z_][\w.?]*)\s*>/.exec(outer.text);
      if (generic) return schemaFromCsTypeText(generic[1]!, model);
      return { type: "object" };
    }
  }

  const collectionMethods =
    /(?:ToListAsync|ToArrayAsync|ToList|ToArray|AsAsyncEnumerable|QueryAsync|Query|ReadAsync)$/;
  const singleMethods =
    /(?:FindAsync|Find|FirstAsync|FirstOrDefaultAsync|First|FirstOrDefault|SingleAsync|SingleOrDefaultAsync|Single|SingleOrDefault|LastAsync|LastOrDefault|Last|QueryFirstAsync|QueryFirst|QueryFirstOrDefaultAsync|QueryFirstOrDefault|QuerySingleAsync|QuerySingle|QuerySingleOrDefaultAsync|QuerySingleOrDefault|ExecuteScalarAsync|ExecuteScalar)$/;
  const countMethods =
    /(?:CountAsync|LongCountAsync|Count|LongCount|ExecuteDeleteAsync|ExecuteUpdateAsync|ExecuteSqlRawAsync|ExecuteSqlInterpolatedAsync|ExecuteAsync|Execute)$/;
  const anyMethods = /(?:AnyAsync|Any|AllAsync|All)$/;
  if (!collectionMethods.test(method) && !singleMethods.test(method) && !countMethods.test(method) && !anyMethods.test(method)) {
    return undefined;
  }

  // Dapper/EF expose the row type as the method's own generic argument,
  // e.g. db.QueryAsync<Todo>(sql) or context.Set<Todo>().ToListAsync().
  const genericArg = /<\s*([A-Za-z_][\w.?]*(?:<[^>]*>)?)\s*>/.exec(
    outerAccess?.text ?? "",
  )?.[1];

  // Locate the `param.DbSet` root of the chain.
  const paramTypes = lambdaParamTypes(lambda);
  let elementName = genericArg?.replace(/\?$/, "");
  for (const ma of findAll(outer, (n) => n.type === "member_access_expression")) {
    const obj = ma.namedChildren[0];
    const prop = ma.namedChildren[ma.namedChildren.length - 1];
    if (obj?.type === "identifier" && prop?.type === "identifier" && paramTypes.has(obj.text)) {
      elementName = resolveCollectionElementType(paramTypes.get(obj.text)!, prop.text, model);
      if (elementName) break;
    }
  }

  if (countMethods.test(method)) return { type: "integer" };
  if (anyMethods.test(method)) return { type: "boolean" };
  if (singleMethods.test(method)) return elementName ? schemaFromCsTypeText(elementName, model) : undefined;
  if (collectionMethods.test(method)) {
    const items = elementName ? schemaFromCsTypeText(elementName, model) : {};
    return { type: "array", items: items ?? {} };
  }
  return undefined;
}

function inferMinimalResponses(
  lambda: TsNode,
  model: CsModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  // An explicit lambda return type (`Task<Results<Ok<T>, NotFound>>`) is the
  // authoritative static contract; it was preserved as a marker statement by
  // the C# normalizer. Prefer it over body inspection.
  const declared = responsesFromDeclaredReturnType(lambda, model);
  if (declared) return declared;

  const resultCalls = findAll(lambda, (n) => {
    if (n.type !== "invocation_expression") return false;
    const access = n.namedChildren.find((c) => c.type === "member_access_expression");
    const name = access?.namedChildren[access.namedChildren.length - 1]?.text;
    return name !== undefined && RESULT_METHOD_NAMES.has(name);
  });

  if (!resultCalls.length) {
    const direct = inferDirectReturn(lambda, model);
    if (direct) return [direct];
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

  const responses: DiscoveredResponse[] = [];
  let explicitEmptySuccess = false;
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
      const status = RESULT_STATUS_METHODS[name]!;
      if (name === "Problem" || name === "ValidationProblem") {
        responses.push({
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/problem+json", schema: problemDetailsSchema() }],
        });
        continue;
      }
      const schema = firstArg ? inferExpressionSchema(firstArg, model, lambda) : undefined;
      if (!schema && /^2\d\d$/.test(status)) explicitEmptySuccess = true;
      responses.push({
        statusCode: status,
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
    const successStatus = SUCCESS_RESULT_STATUS[name];
    if (successStatus) {
      // Ok(value?) carries the payload in the first argument; Created*/Accepted*
      // carry it in the last argument after URI/route metadata.
      const allArgs = callArgs ? childrenOfType(callArgs, "argument") : [];
      const payloadArg =
        name === "Ok" ? firstArg : allArgs.length > 1 ? allArgs[allArgs.length - 1] : undefined;
      const schema = payloadArg ? inferExpressionSchema(payloadArg, model, lambda) : undefined;
      if (!schema) explicitEmptySuccess = true;
      responses.push({
        statusCode: successStatus,
        description: "",
        confidence: schema ? "high" : "medium",
        ...(schema ? { content: [{ mediaType: "application/json", schema }] } : {}),
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
  if (
    !explicitEmptySuccess &&
    merged.some((r) => r.statusCode === "200" && !r.content?.[0]?.schema)
  ) {
    gaps.push("response-unknown");
  }
  return merged;
}

/** RFC 7807 ProblemDetails / ValidationProblemDetails (adds an errors map). */
function problemDetailsSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      type: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      status: { type: "integer", nullable: true },
      detail: { type: "string", nullable: true },
      instance: { type: "string", nullable: true },
      errors: {
        type: "object",
        nullable: true,
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
  };
}

export function inferExpressionSchema(
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
    // Pattern variable introduced by `await FindAsync(...) is Todo todo` or
    // `x is Todo t`. Its declared type is the payload schema.
    if (identifier) {
      const patternSchema = patternVariableSchema(identifier.text, lambda, model);
      if (patternSchema) return patternSchema;
    }
  }
  // A data-access call (EF terminal, JSON parse) used directly as an argument.
  const dataSchema = inferDataCallSchema(node, lambda, model);
  if (dataSchema) return dataSchema;
  // Unwrap a single-expression `argument` node to its inner expression.
  const subject: TsNode =
    node.type === "argument" && node.namedChildCount === 1 && node.namedChildren[0]
      ? node.namedChildren[0]!
      : node;
  // String concatenation with at least one string literal produces a string.
  if (subject.type === "binary_expression" && /["']/.test(subject.text) && /\+/.test(subject.text)) {
    return { type: "string" };
  }
  // Null-coalescing `a ?? b`: take the first side we can type.
  if (subject.type === "binary_expression" && /\?\?/.test(subject.text)) {
    for (const operand of subject.namedChildren) {
      const side = inferExpressionSchema(operand, model, lambda);
      if (side) return side;
    }
  }
  // Bare identifier bound to a local variable, e.g. `var msg = ...; Send(msg)`.
  if (subject.type === "identifier") {
    const local = localVariableSchema(subject.text, lambda, model);
    if (local) return local;
  }
  // Implicit new() / collection expressions cannot be typed without flow
  // analysis; leave to AI gap resolution.
  return undefined;
}

/** Resolve a local `var name = <expr>` initializer to a schema (bounded depth). */
function localVariableSchema(
  name: string,
  scope: TsNode,
  model: CsModelIndex,
  depth = 0,
): JsonSchema | undefined {
  if (depth > 3) return undefined;
  for (const declarator of findAll(scope, (n) => n.type === "variable_declarator")) {
    const id = declarator.namedChildren.find((c) => c.type === "identifier");
    if (id?.text !== name) continue;
    const equals = declarator.namedChildren.find((c) => c.type === "equals_value_clause");
    const initializer = equals?.namedChildren.find(
      (c) => !["variable_declarator", "identifier", "equals_value_clause"].includes(c.type),
    );
    if (initializer) {
      const schema = inferExpressionSchema(initializer, model, scope);
      if (schema) return schema;
    }
  }
  return undefined;
}

/** Resolve a variable introduced by an `is Type name` pattern to its schema. */
function patternVariableSchema(name: string, lambda: TsNode, model: CsModelIndex): JsonSchema | undefined {
  for (const decl of findAll(
    lambda,
    (n) =>
      n.type === "declaration_pattern" ||
      n.type === "is_pattern_expression" ||
      n.type === "binary_expression",
  )) {
    const text = decl.text;
    const m = new RegExp(`\\bis\\s+([A-Za-z_][\\w.]*(?:<[^>]+>)?)\\s+${name}\\b`).exec(text);
    if (m) {
      const schema = schemaFromCsTypeText(m[1]!, model);
      if (schema) return schema;
    }
  }
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

    // This binds arbitrary form fields, not an injected service or a file list.
    if (typeNode.text.replace(/\?.*$/, "") === "IFormCollection") {
      const previous = requestBody?.content.find(content => content.mediaType === "multipart/form-data")?.schema;
      requestBody = {
        required: Boolean(requestBody?.required),
        content: [{ mediaType: "multipart/form-data", schema: {
          ...previous, type: "object", additionalProperties: {},
        }}],
        confidence: "medium",
      };
      continue;
    }

    // File parameters share one multipart object; never overwrite earlier fields.
    if (/^(?:IFormFile|IFormFileCollection)$/.test(typeNode.text.replace(/\?.*$/, ""))) {
      const collection = typeNode.text.replace(/\?.*$/, "") === "IFormFileCollection";
      const fromForm = findAttribute(param, new Set(["FromForm"]));
      const fieldName = (fromForm && attributeStringArg(fromForm)) || name;
      const required = !collection && typeNode.type !== "nullable_type" &&
        !param.namedChildren.some((c) => c.type === "equals_value_clause");
      const previous = requestBody?.content.find(content => content.mediaType === "multipart/form-data")?.schema;
      const properties = previous?.properties as Record<string, JsonSchema> | undefined;
      const requiredFields = new Set(Array.isArray(previous?.required) ? previous.required as string[] : []);
      if (required) requiredFields.add(fieldName);
      requestBody = {
        required: Boolean(requestBody?.required || required),
        content: [{
          mediaType: "multipart/form-data",
          schema: {
            ...previous,
            type: "object",
            properties: {
              ...properties,
              [fieldName]: collection
                ? { type: "array", items: { type: "string", format: "binary" } }
                : { type: "string", format: "binary" },
            },
            ...(requiredFields.size ? { required: [...requiredFields] } : {}),
          },
        }],
        confidence: "high",
      };
      continue;
    }

    // MinimalApis.Extensions Body<T>/Bind<T>/ModelBinder<T>: the inner type is
    // the request body (string/byte[] -> raw, DTO -> JSON).
    const bodyInner = bodyWrapperInner(typeNode);
    if (bodyInner) {
      const innerText = bodyInner.text.replace(/\?.*$/, "");
      const isRaw = /^(?:string|char|byte\[\]|String|Byte\[\])$/.test(innerText) || /ReadOnlyMemory<byte>/.test(typeNode.text);
      const schema = isRaw
        ? innerText.includes("byte") || innerText.includes("Byte")
          ? { type: "string", format: "binary" }
          : { type: "string" }
        : csTypeToSchema(bodyInner, model);
      requestBody = {
        required: !typeNode.type.toString().includes("nullable"),
        content: [{
          mediaType: isRaw && schema.format === "binary" ? "application/octet-stream" : "application/json",
          schema,
        }],
        confidence: "medium",
      };
      continue;
    }

    // Response-shaping wrappers are not request input.
    const bareType = typeNode.text.replace(/<.*>/, "");
    if (/^(?:SuppressDefaultResponse|ValueTuple|Tuple)$/.test(bareType)) continue;

    if (isInjectedService(typeNode, model) || findAttribute(param, new Set(['FromServices', 'FromKeyedServices']))) continue;

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

    // MVC binds simple parameters from route/query even without [ApiController].
    // Only implicit complex-body binding depends on that attribute.
    if (!isComplexType(typeNode, model)) {
      if (pathParams.has(name)) addParam('path', name, schema, 'medium', true);
      else addParam('query', name, schema, 'medium', !optional);
      continue;
    }
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
