/**
 * JAX-RS framework pack (Java), shared across Jersey, Quarkus RESTEasy Reactive
 * and Dropwizard.
 *
 * Recognises both the modern `jakarta.ws.rs.*` and legacy `javax.ws.rs.*`
 * annotation sets through a single pack. Routes come from a class-level @Path
 * prefix concatenated with method-level @Path fragments; HTTP verbs are the
 * @GET/@POST/@PUT/@DELETE/@PATCH/@HEAD/@OPTIONS annotations. Parameters are
 * bound by @PathParam/@QueryParam/@HeaderParam/@CookieParam/@FormParam and
 * unfolded from @BeanParam carriers. Responses come either from a bare entity
 * return or from a `Response.ok(e).status(c).build()` /
 * `Response.status(c).entity(e).build()` builder chain. SSE is recognised from
 * @Produces(text/event-stream) on a `Multi<X>`/`Flux<X>` return or an injected
 * SseEventSink. Anything not statically provable becomes an honest gap.
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
import type { JavaAnalysis, JavaTypeDef } from "../lang/java/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  annotationStringArg,
  buildJavaModelIndex,
  javaBeanProperties,
  javaTypeToSchema,
  listAnnotations,
  type JavaModelIndex,
} from "../lang/java/schema.js";
import {
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

const HTTP_VERBS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

/** Response.xxx() factory method -> default status code. */
const FACTORY_STATUS: Record<string, string> = {
  ok: "200",
  created: "201",
  accepted: "202",
  noContent: "204",
  notModified: "304",
  badRequest: "400",
  unauthorized: "401",
  forbidden: "403",
  notFound: "404",
  methodNotAllowed: "405",
  notAcceptable: "406",
  conflict: "409",
  gone: "410",
  preconditionFailed: "412",
  unsupportedMediaType: "415",
  serverError: "500",
  serviceUnavailable: "503",
};

const SIMPLE_TYPES = new Set([
  "String",
  "CharSequence",
  "Integer",
  "int",
  "Long",
  "long",
  "Short",
  "short",
  "Byte",
  "byte",
  "Boolean",
  "boolean",
  "Double",
  "double",
  "Float",
  "float",
  "BigDecimal",
  "BigInteger",
  "UUID",
  "LocalDate",
  "LocalDateTime",
  "OffsetDateTime",
  "ZonedDateTime",
  "Instant",
  "Date",
]);

function emptyResult() {
  return {
    routes: [] as RouteCandidate[],
    unresolved: [] as DiscoveredUnresolved[],
    components: [],
    securitySchemes: [] as DiscoveredSecurityScheme[],
    servers: [] as DiscoveredServer[],
  };
}

export const jaxrsPack: FrameworkPack<JavaAnalysis> = {
  id: "jaxrs",
  language: "java",
  dependencyHints: [
    "jakarta.ws.rs-api",
    "javax.ws.rs-api",
    "jersey",
    "quarkus-resteasy-reactive",
    "dropwizard-core",
  ],

  applies(ctx) {
    // Content is the strong, container-agnostic signal: a project using the JAX-RS
    // annotation API (either namespace) imports jakarta.ws.rs.* or javax.ws.rs.*.
    // Spring projects bind org.springframework.web.bind.annotation and never these.
    return ctx.index.files.some(
      (f) =>
        /\.java$/.test(f.path) &&
        /(jakarta|javax)\.ws\.rs\./.test(f.content),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildJavaModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      const classes = findAll(file.root, (n) => n.type === "class_declaration");
      for (const cls of classes) {
        const anns = listAnnotations(cls);
        const pathAnn = anns.find((a) => a.name === "Path");
        if (!pathAnn) continue;
        const basePath = normalizePath(annotationStringArg(pathAnn.node) ?? "");
        scanResourceClass(
          cls,
          basePath,
          analysis,
          model,
          rel,
          candidates,
          unresolved,
          0,
        );
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

/**
 * Scan a resource class (root or sub-resource) for verb-annotated methods and
 * emit route candidates. Sub-resource locators (a @Path method with no HTTP verb)
 * are followed one level when their return type statically resolves to another
 * resource class.
 */
function scanResourceClass(
  cls: TsNode,
  basePath: string,
  analysis: JavaAnalysis,
  model: JavaModelIndex,
  rel: string,
  candidates: RouteCandidate[],
  unresolved: DiscoveredUnresolved[],
  depth: number,
): void {
  const className =
    cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "resource";
  const tagName = className.replace(/Resource$/, "").replace(/^./, (c) => c.toLowerCase());
  const classProduces = listAnnotations(cls).find((a) => a.name === "Produces");
  const classConsumes = listAnnotations(cls).find((a) => a.name === "Consumes");

  const body = childrenOfType(cls, "class_body")[0];
  if (!body) return;
  const fieldTypes = fieldTypesOf(cls);

  for (const method of childrenOfType(body, "method_declaration")) {
    const anns = listAnnotations(method);
    const verbAnn = anns.find((a) => HTTP_VERBS.has(a.name));
    const pathAnn = anns.find((a) => a.name === "Path");

    if (!verbAnn && pathAnn && depth < 2) {
      // Sub-resource locator: return type names another resource class.
      const locatorSub = normalizePath(annotationStringArg(pathAnn.node) ?? "");
      const ret = declaredReturnType(method);
      const target = ret ? model.resolveDef(typeNameOf(ret), rel) : undefined;
      if (target && target.node.type === "class_declaration") {
        scanResourceClass(
          target.node,
          joinPath(basePath, locatorSub),
          analysis,
          model,
          target.file,
          candidates,
          unresolved,
          depth + 1,
        );
      } else {
        unresolved.push({
          reason: "sub-resource-locator-untracked",
          message: "sub-resource locator return type not statically provable",
          origin: { file: rel, line: method.startPosition.row + 1 },
        });
      }
      continue;
    }
    if (!verbAnn) continue;

    const verb = verbAnn.name.toLowerCase();
    const subPath = pathAnn ? normalizePath(annotationStringArg(pathAnn.node) ?? "") : "";
    const fullPath = joinPath(basePath, subPath);
    const pathParams = pathParamsOf(fullPath);

    const methodProduces = anns.find((a) => a.name === "Produces") ?? classProduces;
    const methodConsumes = anns.find((a) => a.name === "Consumes") ?? classConsumes;

    const origin: SourceLocation = { file: rel, line: method.startPosition.row + 1 };
    const gaps: GapCode[] = [];

    const { parameters, requestBody } = collectParameters(
      method,
      model,
      pathParams,
      rel,
      methodConsumes,
      gaps,
    );

    const returnType = declaredReturnType(method);
    const producesEventStream = methodProduces
      ? /text\/event-stream|SERVER_SENT_EVENTS|TEXT_EVENT_STREAM/i.test(methodProduces.node.text)
      : false;
    const isResponseReturn = returnsJaxRsResponse(returnType, analysis, rel);
    const isSse =
      producesEventStream ||
      (returnType !== null &&
        /SseEventSink|OutboundSseEvent|SseBroadcaster/.test(returnType.text));

    const responses = isSse
      ? collectSseResponse(method, returnType, model, gaps, rel)
      : collectResponses(
          method,
          returnType,
          isResponseReturn,
          model,
          gaps,
          rel,
          fieldTypes,
          methodProduces,
        );

    const extensions = isSse ? { "x-protocol": "sse" } : undefined;
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
      ...(extensions ? { extensions } : {}),
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

/** A bare `Response` return only counts when it resolves to a JAX-RS Response. */
function returnsJaxRsResponse(
  returnType: TsNode | null,
  analysis: JavaAnalysis,
  rel: string,
): boolean {
  if (!returnType) return false;
  if (/ws\.rs\.core\.Response/.test(returnType.text)) return true;
  if (typeNameOf(returnType) !== "Response") return false;
  const table = analysis.imports.get(rel);
  const imported = table?.explicit.get("Response");
  return Boolean(imported && imported.includes("ws.rs.core.Response"));
}

interface CollectedParams {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
}

function collectParameters(
  method: TsNode,
  model: JavaModelIndex,
  pathParams: Set<string>,
  rel: string,
  consumes: { name: string; node: TsNode } | undefined,
  gaps: GapCode[],
): CollectedParams {
  const parameters: RouteParameter[] = [];
  const formFields: { name: string; schema: JsonSchema; required: boolean }[] = [];
  let requestBody: CollectedParams["requestBody"];

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
    const hasDefault = anns.some((a) => a.name === "DefaultValue");

    const pathParam = anns.find((a) => a.name === "PathParam");
    const queryParam = anns.find((a) => a.name === "QueryParam");
    const headerParam = anns.find((a) => a.name === "HeaderParam");
    const cookieParam = anns.find((a) => a.name === "CookieParam");
    const formParam = anns.find((a) => a.name === "FormParam");
    const matrixParam = anns.find((a) => a.name === "MatrixParam");
    const beanParam = anns.find((a) => a.name === "BeanParam");

    if (pathParam) {
      const name =
        annotationStringArg(pathParam.node) ?? nameNode?.text;
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

    if (queryParam) {
      const name = annotationStringArg(queryParam.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "query",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : undefined,
          "high",
          !hasDefault,
        );
      }
      continue;
    }

    if (matrixParam) {
      const name = annotationStringArg(matrixParam.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "query",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : undefined,
          "medium",
          !hasDefault,
        );
      }
      continue;
    }

    if (headerParam) {
      const explicit = annotationStringArg(headerParam.node);
      const name = explicit ?? nameNode?.text;
      if (name) {
        addParam(
          "header",
          explicit ? name : name.toLowerCase(),
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : { type: "string" },
          "high",
          !hasDefault,
        );
      }
      continue;
    }

    if (cookieParam) {
      const name = annotationStringArg(cookieParam.node) ?? nameNode?.text;
      if (name) {
        addParam(
          "cookie",
          name,
          typeNode ? javaTypeToSchema(typeNode, model, 0, undefined, rel) : { type: "string" },
          "high",
          !hasDefault,
        );
      }
      continue;
    }

    if (formParam) {
      const name = annotationStringArg(formParam.node) ?? nameNode?.text;
      if (name && typeNode) {
        formFields.push({
          name,
          schema: javaTypeToSchema(typeNode, model, 0, undefined, rel),
          required: !hasDefault,
        });
      }
      continue;
    }

    if (beanParam && typeNode) {
      unfoldBeanParam(typeNode, model, rel, addParam);
      continue;
    }

    // Unannotated non-scalar parameter = request entity body.
    if (typeNode && !anns.length) {
      const simple = typeNameOf(typeNode);
      const resolves = model.resolveDef(simple, rel);
      if (resolves && !SIMPLE_TYPES.has(simple)) {
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
  }

  if (formFields.length) {
    const mediaType = consumes
      ? /MULTIPART|OCTET_STREAM/i.test(consumes.node.text)
        ? "multipart/form-data"
        : "application/x-www-form-urlencoded"
      : "application/x-www-form-urlencoded";
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const f of formFields) {
      properties[f.name] = f.schema;
      if (f.required) required.push(f.name);
    }
    requestBody = {
      required: true,
      content: [
        {
          mediaType,
          schema: { type: "object", properties, ...(required.length ? { required } : {}) },
        },
      ],
      confidence: "high",
    };
  }

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}) };
}

/**
 * Unfold a @BeanParam carrier: read each field's own JAX-RS binding annotation
 * and add the bound parameter to the matching location.
 */
function unfoldBeanParam(
  typeNode: TsNode,
  model: JavaModelIndex,
  rel: string,
  addParam: (
    location: RouteParameter["in"],
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required: boolean,
  ) => void,
): void {
  const def = model.resolveDef(typeNameOf(typeNode), rel);
  if (!def) return;
  for (const property of javaBeanProperties(def, model)) {
    // javaBeanProperties does not carry the binding annotation; read the field
    // node directly to recover which source (@QueryParam etc) the bean uses.
    const binding = beanFieldBinding(def, property.name);
    if (!binding) continue;
    addParam(
      binding.location,
      property.name,
      Object.keys(property.schema).length ? property.schema : undefined,
      "high",
      property.required,
    );
  }
}

/** Find the JAX-RS binding annotation on a bean field by property name. */
function beanFieldBinding(
  def: JavaTypeDef,
  propertyName: string,
): { location: RouteParameter["in"] } | null {
  const body =
    def.node.namedChildren.find(
      (c) => c.type === "class_body" || c.type === "record_body",
    );
  if (!body) return null;
  const scan = (nodes: TsNode[]) => {
    for (const decl of nodes) {
      const mods = decl.namedChildren.find((c) => c.type === "modifiers");
      if (!mods) continue;
      const ids = findAll(decl, (n) => n.type === "identifier");
      if (!ids.some((id) => id.text === propertyName)) continue;
      for (const mod of mods.namedChildren) {
        if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
        const name = mod.namedChildren.find((c) => c.type === "identifier")?.text;
        if (name === "QueryParam" || name === "MatrixParam") return "query" as const;
        if (name === "HeaderParam") return "header" as const;
        if (name === "PathParam") return "path" as const;
        if (name === "CookieParam") return "cookie" as const;
      }
    }
    return null;
  };
  const loc =
    scan(childrenOfType(body, "field_declaration")) ??
    scan(childrenOfType(body, "record_component"));
  return loc ? { location: loc } : null;
}

interface BuiltResponse {
  status: string;
  entity?: JsonSchema;
}

/**
 * Walk `Response.<factory|status|entity>(...).build()` chains inside the handler
 * body and recover the status code and (when statically known) the entity schema.
 */
function collectBuiltResponses(
  method: TsNode,
  model: JavaModelIndex,
  rel: string,
): BuiltResponse[] {
  const localVars = localVarTypes(method);
  const out: BuiltResponse[] = [];
  const buildCalls = findAll(method, (n) => {
    if (n.type !== "method_invocation") return false;
    return n.namedChildren[1]?.type === "identifier" && n.namedChildren[1].text === "build";
  });
  for (const build of buildCalls) {
    let status = "200";
    let entityArg: TsNode | undefined;
    let node: TsNode | undefined = build.namedChildren[0];
    let guard = 0;
    while (node && node.type === "method_invocation" && guard++ < 8) {
      const mname = node.namedChildren[1]?.text ?? "";
      const argList = childrenOfType(node, "argument_list")[0];
      const posArgs = argList ? argList.namedChildren : [];
      if (mname === "ok") {
        status = "200";
        if (posArgs.length) entityArg = posArgs[0];
      } else if (mname === "status") {
        const parsed = parseStatusArg(posArgs[0]);
        if (parsed) status = parsed;
      } else if (mname === "entity") {
        if (posArgs.length) entityArg = posArgs[0];
      } else if (FACTORY_STATUS[mname]) {
        status = FACTORY_STATUS[mname]!;
        if (posArgs.length && (mname === "ok" || mname === "created" || mname === "accepted")) {
          entityArg = posArgs[0];
        }
      }
      node = node.namedChildren[0];
    }
    const entity = entityArg
      ? entityArgToSchema(entityArg, localVars, model, rel)
      : undefined;
    out.push({ status, ...(entity ? { entity } : {}) });
  }
  return out;
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
  if (arg.type === "class_literal") {
    const typeId = findFirst(arg, (n) => n.type === "type_identifier");
    if (typeId) return javaTypeToSchema(typeId, model, 0, undefined, rel);
    return undefined;
  }
  if (arg.type === "string_literal") return { type: "string" };
  return undefined;
}

/** Local-variable declared types, for resolving `Response.ok(localVar)`. */
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

function collectResponses(
  method: TsNode,
  returnType: TsNode | null,
  isResponseReturn: boolean,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
  fieldTypes: Map<string, TsNode>,
  produces: { name: string; node: TsNode } | undefined,
): DiscoveredResponse[] {
  const mediaType = produces
    ? /APPLICATION_XML|text\/xml/i.test(produces.node.text)
      ? "application/xml"
      : "application/json"
    : "application/json";

  if (returnType && returnType.type === "void_type") {
    return [{ statusCode: "204", description: "", confidence: "high" }];
  }

  if (isResponseReturn) {
    const built = collectBuiltResponses(method, model, rel);
    if (built.length) {
      const byStatus = new Map<string, DiscoveredResponse>();
      for (const b of built) {
        const existing = byStatus.get(b.status);
        if (existing) continue;
        byStatus.set(b.status, {
          statusCode: b.status,
          description: "",
          confidence: "high",
          ...(b.entity
            ? { content: [{ mediaType, schema: b.entity }] }
            : b.status.startsWith("204") || b.status.startsWith("304")
              ? {}
              : { content: [{ mediaType, schema: {} }] }),
        });
      }
      return [...byStatus.values()];
    }
    gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "low",
        content: [{ mediaType }],
      },
    ];
  }

  // Bare entity return.
  if (returnType && /byte\s*\[\s*]|StreamingOutput/.test(returnType.text)) {
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
          content: [{ mediaType, schema: followed }],
        },
      ];
    }
    gaps.push("response-unknown");
    return [
      {
        statusCode: "200",
        description: "",
        confidence: "low",
        content: [{ mediaType }],
      },
    ];
  }
  return [
    {
      statusCode: "200",
      description: "",
      confidence: "high",
      content: [{ mediaType, schema }],
    },
  ];
}

function collectSseResponse(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
): DiscoveredResponse[] {
  let itemSchema: JsonSchema | undefined;
  if (returnType && returnType.type === "generic_type") {
    const typeArgs = findFirst(returnType, (n) => n.type === "type_arguments");
    const first = typeArgs?.namedChildren[0];
    if (first) itemSchema = javaTypeToSchema(first, model, 0, undefined, rel);
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
      content: [{ mediaType: "text/event-stream", itemSchema }],
    },
  ];
}
