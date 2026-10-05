/**
 * Micronaut framework pack (Java, io.micronaut.http.annotation.*).
 *
 * Recognises @Controller("/base") classes with @Get/@Post/@Put/@Delete/@Patch
 * method annotations (uri fragments incl. {id}), @PathVariable/@QueryValue/
 * @Header/@Body parameters, and HttpResponse.ok(x)/HttpResponse.created(..)
 * .body(x)/noContent()/notFound() response builders, plus bare entity returns.
 * The annotation shape is close to Spring; extraction shares the same Java model
 * machinery without editing spring.ts.
 */

import {mergeResponseVariants} from "../core/response-variants.js";

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
import type { JavaAnalysis } from "../lang/java/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  annotationElement,
  annotationStringArg,
  buildJavaModelIndex,
  javaTypeToSchema,
  listAnnotations,
  type JavaModelIndex,
} from "../lang/java/schema.js";
import {
  hasOnlyThrowingExit,
  disambiguateOperationIds,
  dedupeRoutes,
  fieldTypesOf,
  followServiceReturnType,
  HTTP_STATUS,
  isConcreteSchema,
  joinPath,
  normalizePath,
  pathParamsOf,
  sliceNode,
  typeNameOf,
} from "../lang/java/http-shared.js";

const VERB_ANNOTATIONS: Record<string, string> = {
  Get: "get",
  Post: "post",
  Put: "put",
  Delete: "delete",
  Patch: "patch",
  Head: "head",
  Options: "options",
};

/** HttpResponse.<method>() factory -> default status. */
const FACTORY_STATUS: Record<string, string> = {
  ok: "200",
  created: "201",
  accepted: "202",
  noContent: "204",
  badRequest: "400",
  unauthorized: "401",
  forbidden: "403",
  notFound: "404",
  notAllowed: "405",
  conflict: "409",
  serverError: "500",
  unprocessableEntity: "422",
  notModified: "304",
  seeOther: "303",
  temporaryRedirect: "307",
  permanentRedirect: "308",
};

function emptyResult() {
  return {
    routes: [] as RouteCandidate[],
    unresolved: [] as DiscoveredUnresolved[],
    components: [],
    securitySchemes: [] as DiscoveredSecurityScheme[],
    servers: [] as DiscoveredServer[],
  };
}

/**
 * Built-in Micronaut HTTP status exceptions (io.micronaut.http.exceptions),
 * keyed by simple class name. Only trusted when the name is imported from a
 * micronaut package, so user exceptions sharing a name are not coerced.
 */
const MICRONAUT_HTTP_EXCEPTION_STATUS: Record<string, string> = {
  BadRequestException: "400",
  UnauthorizedException: "401",
  ForbiddenException: "403",
  NotFoundException: "404",
  MethodNotAllowedException: "405",
  NotAcceptableException: "406",
  ConflictException: "409",
  GoneException: "410",
  UnsupportedMediaException: "415",
  UnprocessableEntityException: "422",
  InternalServerException: "500",
  ServiceUnavailableException: "503",
};

/** A resolved error-producing Java method (handler body) and its source file. */
interface ErrorHandlerRef {
  method: TsNode;
  rel: string;
}

interface ErrorHandlerIndex {
  /** Global ExceptionHandler<ExceptionType, …> beans keyed by exception name. */
  exceptionHandlers: Map<string, ErrorHandlerRef>;
  /** @Error(exception = X.class) methods not local to a controller. */
  byException: Map<string, ErrorHandlerRef>;
  /** @Error(status = HttpStatus.N) methods not local to a controller. */
  byStatus: Map<string, ErrorHandlerRef>;
  /** @Error methods declared inside a controller, keyed by controller class id. */
  local: Map<number, { byException: Map<string, ErrorHandlerRef>; byStatus: Map<string, ErrorHandlerRef> }>;
}

export const micronautPack: FrameworkPack<JavaAnalysis> = {
  id: "micronaut",
  language: "java",
  dependencyHints: ["micronaut-http", "micronaut-http-server-netty"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        /\.java$/.test(f.path) &&
        /io\.micronaut\.http\.annotation\./.test(f.content),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildJavaModelIndex(analysis);
    const errorIndex = buildErrorHandlerIndex(analysis);

    for (const [rel, file] of analysis.files) {
      const classes = findAll(file.root, (n) => n.type === "class_declaration");
      for (const cls of classes) {
        const anns = listAnnotations(cls);
        const controllerAnn = anns.find((a) => a.name === "Controller");
        if (!controllerAnn) continue;
        const basePath = normalizePath(annotationStringArg(controllerAnn.node) ?? "");
        scanController(cls, basePath, analysis, model, rel, candidates, errorIndex);
      }
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const routes = disambiguateOperationIds(dedupeRoutes(candidates));
    return { routes, unresolved, components, securitySchemes: [], servers: [] };
  },
};

function scanController(
  cls: TsNode,
  basePath: string,
  analysis: JavaAnalysis,
  model: JavaModelIndex,
  rel: string,
  candidates: RouteCandidate[],
  errorIndex: ErrorHandlerIndex,
): void {
  const className =
    cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "controller";
  const tagName = className.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase());
  const body = childrenOfType(cls, "class_body")[0];
  if (!body) return;
  const fieldTypes = fieldTypesOf(cls);

  for (const method of childrenOfType(body, "method_declaration")) {
    const anns = listAnnotations(method);
    const verbAnn = anns.find((a) => VERB_ANNOTATIONS[a.name]);
    if (!verbAnn) continue;
    const verb = VERB_ANNOTATIONS[verbAnn.name]!;
    const subPath = normalizePath(annotationStringArg(verbAnn.node) ?? "");
    const fullPath = joinPath(basePath, subPath);
    const pathParams = pathParamsOf(fullPath);

    const origin: SourceLocation = { file: rel, line: method.startPosition.row + 1 };
    const gaps: GapCode[] = [];

    const { parameters, requestBody } = collectParameters(
      method,
      model,
      pathParams,
      rel,
      gaps,
      verb,
    );

    const returnType = declaredReturnType(method);
    const isHttpResponseReturn = returnsHttpResponse(returnType, analysis, rel);

    const errorResponses = collectErrorResponses(
      method,
      cls,
      rel,
      analysis,
      model,
      errorIndex,
      gaps,
    );

    const throwing = hasOnlyThrowingExit(method);
    let responses: DiscoveredResponse[];
    if (throwing) {
      responses = errorResponses.length
        ? errorResponses
        : [{ statusCode: "default", description: "Exception response requires handler resolution", confidence: "low" }];
      if (!responses.some((r) => r.statusCode !== "default")) gaps.push("response-unknown");
    } else {
      const success = isHttpResponseReturn
        ? collectHttpResponses(method, returnType, model, gaps, rel, analysis)
        : collectBareResponses(method, returnType, model, gaps, rel, fieldTypes);
      responses = mergeErrorResponses(success, errorResponses);
    }

    const methodName =
      method.namedChildren.find((c) => c.type === "identifier")?.text ?? "op";

    candidates.push({
      method: verb,
      path: fullPath,
      fullPath,
      operationId: `${className}_${methodName}`,
      origin,
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses,
      tags: [tagName],
      confidence: gaps.length ? "medium" : "high",
      gaps,
      components: [],
      handlerSource: sliceNode(method),
    });
  }
}

function declaredReturnType(method: TsNode): TsNode | null {
  return (
    method.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "void_type" ||
        c.type === "array_type" ||
        c.type === "scoped_identifier" ||
        c.type === "scoped_type_identifier",
    ) ?? null
  );
}

function returnsHttpResponse(
  returnType: TsNode | null,
  analysis: JavaAnalysis,
  rel: string,
): boolean {
  if (!returnType) return false;
  if (/io\.micronaut\.http\.HttpResponse/.test(returnType.text)) return true;
  if (typeNameOf(returnType) !== "HttpResponse") return false;
  const table = analysis.imports.get(rel);
  const imported = table?.explicit.get("HttpResponse");
  return Boolean(imported && imported.includes("micronaut.http.HttpResponse"));
}

/** Verbs that carry a (JSON) request body and can bind one POJO implicitly. */
const BODY_VERBS = new Set(["post", "put", "patch"]);

/**
 * Simple / JDK types Micronaut binds from query/form/header values even without
 * an annotation; these must never be promoted to an implicit JSON body.
 */
const SIMPLE_BINDING_TYPES = new Set([
  "String",
  "CharSequence",
  "Integer",
  "Long",
  "Short",
  "Byte",
  "Boolean",
  "Double",
  "Float",
  "Character",
  "Number",
  "BigInteger",
  "BigDecimal",
  "UUID",
  "Instant",
  "LocalDate",
  "LocalDateTime",
  "LocalTime",
  "OffsetDateTime",
  "ZonedDateTime",
  "Date",
  "URI",
  "URL",
  "MultipartFile",
  "StreamingFileUpload",
  "CompletedFileUpload",
]);

const COLLECTION_BINDING_TYPES = /^(?:[A-Za-z0-9_$.]*\.)?(?:List|Set|Collection|Iterable|Map|HashMap|TreeMap|ArrayList|LinkedList|HashSet|TreeSet|Optional)(?:<.*>)?$/;

/**
 * Micronaut binds a single unannotated POJO parameter of a body-bearing route as
 * the JSON request body (an implicit @Body). Only user-defined class/record
 * models qualify; primitives, wrappers, collections, maps and uploads stay out.
 */
function isImplicitBodyType(typeNode: TsNode, model: JavaModelIndex, rel: string): boolean {
  if (
    ["integral_type", "floating_point_type", "boolean_type", "array_type", "generic_type"].includes(
      typeNode.type,
    )
  ) {
    return false;
  }
  const name = typeNameOf(typeNode);
  if (!name) return false;
  const simple = name.split(".").pop() ?? name;
  if (SIMPLE_BINDING_TYPES.has(simple) || COLLECTION_BINDING_TYPES.test(simple)) return false;
  const def = model.resolveDef(simple, rel, typeNode);
  return Boolean(def && (def.kind === "class" || def.kind === "record"));
}

function collectParameters(
  method: TsNode,
  model: JavaModelIndex,
  pathParams: Set<string>,
  rel: string,
  gaps: GapCode[],
  verb: string,
): {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence };
} {
  const parameters: RouteParameter[] = [];
  let requestBody:
    | { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence }
    | undefined;

  const paramsNode = childrenOfType(method, "formal_parameters")[0];
  if (!paramsNode) return { parameters };

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

  for (const param of childrenOfType(paramsNode, "formal_parameter")) {
    const anns = listAnnotations(param);
    const nameNode = childrenOfType(param, "identifier").pop();
    const typeNode = param.namedChildren.find((c) =>
      [
        "type_identifier",
        "generic_type",
        "array_type",
        "integral_type",
        "floating_point_type",
        "boolean_type",
        "scoped_type_identifier",
      ].includes(c.type),
    );

    const pathVar = anns.find((a) => a.name === "PathVariable");
    const queryValue = anns.find((a) => a.name === "QueryValue");
    const header = anns.find((a) => a.name === "Header");
    const cookie = anns.find((a) => a.name === "CookieValue");
    const body = anns.find((a) => a.name === "Body");

    if (pathVar) {
      const name = annotationStringArg(pathVar.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "path",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : { type: "string" },
          "high",
          true,
        );
      }
      continue;
    }

    if (queryValue) {
      const name = annotationStringArg(queryValue.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "query",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : undefined,
          "high",
          false,
        );
      }
      continue;
    }

    if (header) {
      const explicit = annotationStringArg(header.node);
      const name = explicit ?? nameNode?.text;
      if (name) {
        addParam(
          "header",
          explicit ? name : name.toLowerCase(),
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : { type: "string" },
          "high",
          false,
        );
      }
      continue;
    }

    if (cookie) {
      const name = annotationStringArg(cookie.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "cookie",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : { type: "string" },
          "high",
          false,
        );
      }
      continue;
    }

    if (body && typeNode) {
      const schema = javaTypeToSchema(typeNode, model, 0, undefined, rel);
      if (schema && Object.keys(schema).length) {
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

    // A single unannotated POJO on a body-bearing route is Micronaut's implicit
    // JSON @Body. Unannotated simple types default to query binding and are left
    // unresolved rather than being guessed.
    if (
      !pathVar &&
      !queryValue &&
      !header &&
      !cookie &&
      !body &&
      BODY_VERBS.has(verb) &&
      !requestBody &&
      typeNode &&
      isImplicitBodyType(typeNode, model, rel)
    ) {
      const schema = javaTypeToSchema(typeNode, model, 0, undefined, rel);
      if (schema && Object.keys(schema).length) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
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

interface BuiltResponse {
  status: string;
  entity?: JsonSchema;
  bodyless?: boolean;
}

/** Walk HttpResponse.<factory>(...).body(x).status(c) chains. */
function collectBuiltResponses(
  method: TsNode,
  model: JavaModelIndex,
  rel: string,
  analysis: JavaAnalysis,
): BuiltResponse[] {
  const localVars = localVarTypes(method);
  const out: BuiltResponse[] = [];
  const returns = findAll(method, (n) => n.type === "return_statement");
  for (const ret of returns) {
    let owner = ret.parent;
    while (owner && owner.id !== method.id && !["lambda_expression", "method_declaration", "class_body"].includes(owner.type)) owner = owner.parent;
    if (owner?.id !== method.id) continue;
    const call = ret.namedChildren.find((n) => n.type === "method_invocation");
    if (!call) continue;
    const built = walkHttpChain(call, localVars, model, rel, analysis);
    if (built) out.push(built);
  }
  return out;
}

function walkHttpChain(
  root: TsNode,
  localVars: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
  analysis: JavaAnalysis,
): BuiltResponse | null {
  let status = "default";
  let bodyless = false;
  const uriName = (name: string) => name === "java.net.URI" || name === "URI" && analysis.imports.get(rel)?.explicit.get(name) === "java.net.URI" && !model.resolveDef(name, rel);
  const uriValue = (arg: TsNode | undefined): boolean => {
    if (!arg) return false;
    if (arg.type === "identifier") return uriName(localVars.get(arg.text)?.text ?? "");
    if (arg.type === "object_creation_expression") return uriName(arg.childForFieldName("type")?.text ?? "");
    return arg.type === "method_invocation" && arg.namedChildren[1]?.text === "create" && uriName(arg.namedChildren[0]?.text ?? "") && !localVars.has(arg.namedChildren[0]?.text ?? "");
  };
  let entityArg: TsNode | undefined;
  let node: TsNode | undefined = root;
  const chain: TsNode[] = [];
  while (node?.type === "method_invocation" && chain.length < 16) {
    chain.unshift(node);
    node = node.namedChildren[0];
  }
  if (!node || !/^(?:io\.micronaut\.http\.)?HttpResponse$/.test(node.text) || localVars.has(node.text)) return null;
  for (const step of chain) {
    const mname = step.namedChildren[1]?.text ?? "";
    const posArgs = childrenOfType(step, "argument_list")[0]?.namedChildren ?? [];
    if (mname === "body") {
      entityArg = posArgs[0];
      bodyless = !entityArg || entityArg.type === "null_literal";
    } else if (mname === "status") {
      status = parseStatusArg(posArgs[0]) ?? "default";
      // A static status factory starts without a body; an instance status
      // update preserves the entity chosen earlier in the chain.
      if (step === chain[0]) bodyless = true;
    } else if (FACTORY_STATUS[mname]) {
      status = FACTORY_STATUS[mname]!;
      const bodyFactory = ["ok", "created", "badRequest", "notFound", "serverError"].includes(mname);
      entityArg = bodyFactory && !(mname === "created" && posArgs.length === 1 && uriValue(posArgs[0])) ? posArgs[0] : undefined;
      bodyless = !entityArg || entityArg.type === "null_literal";
    }
  }
  const entity = entityArg ? entityArgToSchema(entityArg, localVars, model, rel) : undefined;
  return { status, bodyless, ...(entity ? { entity } : {}) };
}

function parseStatusArg(arg: TsNode | undefined): string | null {
  if (!arg) return null;
  const numeric = /^\d{3}$/.exec(arg.text.trim());
  if (numeric) return numeric[0];
  let leaf = arg;
  while (leaf.type === "field_access" || leaf.type === "scoped_identifier") {
    const id = leaf.namedChildren[leaf.namedChildren.length - 1];
    if (id && HTTP_STATUS[id.text]) return HTTP_STATUS[id.text];
    leaf = leaf.namedChildren[0] ?? leaf;
  }
  if (HTTP_STATUS[arg.text.trim()]) return HTTP_STATUS[arg.text.trim()];
  return null;
}

function entityArgToSchema(
  arg: TsNode,
  localVars: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  if (arg.type === "identifier") {
    const typeNode = localVars.get(arg.text);
    if (typeNode) return javaTypeToSchema(typeNode, model, 0, undefined, rel);
    return undefined;
  }
  if (arg.type === "object_creation_expression") {
    const typeId = arg.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "scoped_type_identifier"].includes(c.type),
    );
    if (typeId) return javaTypeToSchema(typeId, model, 0, undefined, rel);
    return undefined;
  }
  if (arg.type === "string_literal") return { type: "string" };
  return undefined;
}

function localVarTypes(method: TsNode): Map<string, TsNode> {
  const map = new Map<string, TsNode>();
  for (const decl of findAll(method, (n) => n.type === "local_variable_declaration")) {
    const typeNode = decl.namedChildren.find((c) =>
      [
        "type_identifier",
        "generic_type",
        "scoped_identifier",
        "scoped_type_identifier",
      ].includes(c.type),
    );
    if (!typeNode) continue;
    for (const declarator of childrenOfType(decl, "variable_declarator")) {
      const name = declarator.namedChildren.find((c) => c.type === "identifier");
      if (name) map.set(name.text, typeNode);
    }
  }
  return map;
}

/**
 * The concrete entity schema declared by `HttpResponse<T>` / `MutableHttpResponse<T>`.
 * Returns undefined for a raw/wildcard/Object body so a bodiless or an
 * untyped response is never given a fabricated schema.
 */
function declaredHttpEntity(
  returnType: TsNode | null,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  if (!returnType || returnType.type !== "generic_type") return undefined;
  const typeArguments = findFirst(returnType, (n) => n.type === "type_arguments");
  const first = typeArguments?.namedChildren[0];
  if (!first || first.type === "wildcard") return undefined;
  const name = typeNameOf(first);
  if (!name || ["Object", "java.lang.Object", "Void", "void"].includes(name)) return undefined;
  const schema = javaTypeToSchema(first, model, 0, undefined, rel);
  return schema && isConcreteSchema(schema) ? schema : undefined;
}

function collectHttpResponses(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
  analysis: JavaAnalysis,
): DiscoveredResponse[] {
  // HttpResponse<T>: the generic argument T is the entity type when the handler
  // does not pin one via .body(). Prefer explicit builder chains; fall back to T
  // when the body expression cannot be typed expression-locally (e.g.
  // `ok().body(opt.get())` or `ok().body(service.createBook(dto))`).
  const fallbackEntity = declaredHttpEntity(returnType, model, rel);
  const built = collectBuiltResponses(method, model, rel, analysis);
  if (built.length) {
    const byStatus = new Map<string, DiscoveredResponse>();
    for (const b of built) {
      if (b.status === "default") gaps.push("response-unknown");
      const bodyless = b.bodyless || b.status.startsWith("204") || b.status.startsWith("304");
      const entity =
        b.entity ?? (!bodyless && /^2\d\d$/.test(b.status) ? fallbackEntity : undefined);
      const existing = byStatus.get(b.status);
      const response: DiscoveredResponse = {
        statusCode: b.status,
        description: "",
        confidence: "high",
        ...(entity
          ? { content: [{ mediaType: "application/json", schema: entity }] }
          : bodyless
            ? {}
            : { content: [{ mediaType: "application/json", schema: {} }] }),
      };
      byStatus.set(b.status, existing ? mergeResponseVariants(existing, response) : response);
    }
    return [...byStatus.values()];
  }
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

function collectBareResponses(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
  fieldTypes: Map<string, TsNode>,
): DiscoveredResponse[] {
  if (returnType && returnType.type === "void_type") {
    return [{ statusCode: "204", description: "", confidence: "high" }];
  }
  const schema = returnType
    ? javaTypeToSchema(returnType, model, 0, undefined, rel)
    : {};
  if (!schema || !Object.keys(schema).length) {
    const followed = followServiceReturnType(method, fieldTypes, model, rel);
    if (followed && isConcreteSchema(followed)) {
      return [
        {
          statusCode: "200",
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: followed }],
        },
      ];
    }
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

// --- Exception handler resolution ---------------------------------------

/** Merge error responses into success responses, combining shared statuses. */
function mergeErrorResponses(
  success: DiscoveredResponse[],
  errors: DiscoveredResponse[],
): DiscoveredResponse[] {
  const byStatus = new Map<string, DiscoveredResponse>();
  for (const response of success) byStatus.set(response.statusCode, response);
  for (const response of errors) {
    const existing = byStatus.get(response.statusCode);
    byStatus.set(
      response.statusCode,
      existing ? mergeResponseVariants(existing, response) : response,
    );
  }
  return [...byStatus.values()];
}

/** Convert a handler method's HttpResponse builder chains to responses. */
function handlerMethodResponses(
  ref: ErrorHandlerRef,
  model: JavaModelIndex,
  analysis: JavaAnalysis,
): DiscoveredResponse[] {
  const built = collectBuiltResponses(ref.method, model, ref.rel, analysis);
  if (!built.length) return [];
  const byStatus = new Map<string, DiscoveredResponse>();
  for (const b of built) {
    const response: DiscoveredResponse = {
      statusCode: b.status,
      description: "",
      confidence: "high",
      ...(b.entity
        ? { content: [{ mediaType: "application/json", schema: b.entity }] }
        : b.bodyless
          ? {}
          : { content: [{ mediaType: "application/json", schema: {} }] }),
    };
    const existing = byStatus.get(b.status);
    byStatus.set(b.status, existing ? mergeResponseVariants(existing, response) : response);
  }
  return [...byStatus.values()];
}

/** Parse an @Error annotation into an exception-class and/or status selector. */
function errorAnnotationSpec(method: TsNode): { exception?: string; status?: string } | null {
  const error = listAnnotations(method).find((a) => a.name === "Error");
  if (!error) return null;
  const spec: { exception?: string; status?: string } = {};
  const exceptionNode = annotationElement(error.node, "exception");
  if (exceptionNode) {
    const simple = exceptionNode.text.replace(/\.class\b/g, "").split(".").pop();
    if (simple) spec.exception = simple;
  }
  const statusNode = annotationElement(error.node, "status");
  if (statusNode) {
    const status = parseStatusArg(statusNode);
    if (status) spec.status = status;
  }
  return spec;
}

/** First generic argument of `implements ExceptionHandler<Exc, Response>`. */
function implementedExceptionType(cls: TsNode): string | null {
  for (const superInterfaces of childrenOfType(cls, "super_interfaces")) {
    for (const generic of findAll(superInterfaces, (n) => n.type === "generic_type")) {
      const base = generic.namedChildren.find((c) => c.type === "type_identifier");
      if (base?.text !== "ExceptionHandler") continue;
      const typeArguments = childrenOfType(generic, "type_arguments")[0];
      const first = typeArguments?.namedChildren[0];
      const simple = typeNameOf(first ?? null);
      if (simple && !["Object", "Throwable", "Exception", "RuntimeException"].includes(simple)) {
        return simple;
      }
    }
  }
  return null;
}

function findHandleMethod(cls: TsNode): TsNode | null {
  const body = childrenOfType(cls, "class_body")[0];
  if (!body) return null;
  const methods = childrenOfType(body, "method_declaration").filter(
    (m) => m.namedChildren.find((c) => c.type === "identifier")?.text === "handle",
  );
  return (
    methods.find((m) => {
      const params = childrenOfType(m, "formal_parameters")[0];
      const count = params
        ? childrenOfType(params, "formal_parameter").length
        : 0;
      return count === 2;
    }) ??
    methods[0] ??
    null
  );
}

function buildErrorHandlerIndex(analysis: JavaAnalysis): ErrorHandlerIndex {
  const exceptionHandlers = new Map<string, ErrorHandlerRef>();
  const byException = new Map<string, ErrorHandlerRef>();
  const byStatus = new Map<string, ErrorHandlerRef>();
  const local = new Map<
    number,
    { byException: Map<string, ErrorHandlerRef>; byStatus: Map<string, ErrorHandlerRef> }
  >();

  for (const [rel, file] of analysis.files) {
    for (const cls of findAll(file.root, (n) => n.type === "class_declaration")) {
      const isController = listAnnotations(cls).some((a) => a.name === "Controller");
      const body = childrenOfType(cls, "class_body")[0];
      if (body) {
        // A @Error method is only activated inside a @Controller bean. A controller
        // that declares route methods scopes its @Error handlers locally; a controller
        // with no route methods acts as a global error handler. @Error methods on plain
        // classes are not registered by Micronaut and are intentionally ignored.
        const hasRouteMethod = childrenOfType(body, "method_declaration").some((m) =>
          listAnnotations(m).some((a) => Boolean(VERB_ANNOTATIONS[a.name])),
        );
        for (const method of childrenOfType(body, "method_declaration")) {
          const spec = errorAnnotationSpec(method);
          if (!spec || !isController) continue;
          const ref: ErrorHandlerRef = { method, rel };
          if (hasRouteMethod) {
            let bucket = local.get(cls.id);
            if (!bucket) {
              bucket = { byException: new Map(), byStatus: new Map() };
              local.set(cls.id, bucket);
            }
            if (spec.exception) bucket.byException.set(spec.exception, ref);
            if (spec.status) bucket.byStatus.set(spec.status, ref);
          } else {
            if (spec.exception) byException.set(spec.exception, ref);
            if (spec.status) byStatus.set(spec.status, ref);
          }
        }
      }
      const exceptionType = implementedExceptionType(cls);
      if (exceptionType) {
        const handle = findHandleMethod(cls);
        if (handle && !exceptionHandlers.has(exceptionType)) {
          exceptionHandlers.set(exceptionType, { method: handle, rel });
        }
      }
    }
  }

  return { exceptionHandlers, byException, byStatus, local };
}

interface ThrownException {
  name: string;
  statusArg?: TsNode;
}

/** Exceptions constructed and thrown directly in this method (not nested helpers). */
function directThrownCreations(method: TsNode): ThrownException[] {
  const out: ThrownException[] = [];
  for (const throwStatement of findAll(method, (n) => n.type === "throw_statement")) {
    let owner = throwStatement.parent;
    while (
      owner &&
      owner.id !== method.id &&
      !["lambda_expression", "method_declaration", "class_body"].includes(owner.type)
    ) {
      owner = owner.parent;
    }
    if (owner?.id !== method.id) continue;
    const creation = findAll(throwStatement, (n) => n.type === "object_creation_expression")[0];
    if (!creation) continue;
    const typeNode = creation.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "scoped_type_identifier"].includes(c.type),
    );
    const name = typeNameOf(typeNode ?? null);
    if (!name) continue;
    const argumentList = childrenOfType(creation, "argument_list")[0];
    const statusArg = argumentList?.namedChildren[0];
    out.push({ name, ...(statusArg ? { statusArg } : {}) });
  }
  return out;
}

/** Resolve every direct throw site to the handler or framework error contract. */
function collectErrorResponses(
  method: TsNode,
  cls: TsNode,
  rel: string,
  analysis: JavaAnalysis,
  model: JavaModelIndex,
  errorIndex: ErrorHandlerIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const localHandlers = errorIndex.local.get(cls.id);
  const importTable = analysis.imports.get(rel);
  const fromMicronaut = (simple: string): boolean => {
    const fq = importTable?.explicit.get(simple);
    if (fq && fq.includes("micronaut")) return true;
    return (importTable?.wildcards ?? []).some((w) => /micronaut\.http\.exceptions/.test(w));
  };

  const byStatus = new Map<string, DiscoveredResponse>();
  const addHandler = (ref: ErrorHandlerRef | undefined): boolean => {
    if (!ref) return false;
    const resolved = handlerMethodResponses(ref, model, analysis);
    if (!resolved.length) return false;
    for (const response of resolved) {
      const existing = byStatus.get(response.statusCode);
      byStatus.set(
        response.statusCode,
        existing ? mergeResponseVariants(existing, response) : response,
      );
    }
    return true;
  };
  const addJsonError = (status: string): void => {
    if (byStatus.has(status)) return;
    byStatus.set(status, {
      statusCode: status,
      description: "",
      confidence: "medium",
      content: [{ mediaType: "application/json", schema: {} }],
    });
    gaps.push(status === "default" ? "response-unknown" : "response-schema-unknown");
  };

  for (const thrown of directThrownCreations(method)) {
    const exceptionRef =
      localHandlers?.byException.get(thrown.name) ??
      errorIndex.exceptionHandlers.get(thrown.name) ??
      errorIndex.byException.get(thrown.name);
    if (addHandler(exceptionRef)) continue;

    const explicitStatus = thrown.statusArg ? parseStatusArg(thrown.statusArg) : null;
    if (explicitStatus) {
      const statusRef =
        localHandlers?.byStatus.get(explicitStatus) ?? errorIndex.byStatus.get(explicitStatus);
      if (addHandler(statusRef)) continue;
      addJsonError(explicitStatus);
      continue;
    }

    if (thrown.name === "HttpStatusException") {
      addJsonError("default");
      continue;
    }

    const builtin = MICRONAUT_HTTP_EXCEPTION_STATUS[thrown.name];
    if (builtin && fromMicronaut(thrown.name)) {
      addJsonError(builtin);
      continue;
    }

    // An unhandled domain exception surfaces as a framework 500 JSON error.
    addJsonError("500");
  }

  return [...byStatus.values()];
}
