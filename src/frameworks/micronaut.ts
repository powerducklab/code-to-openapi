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
  annotationStringArg,
  buildJavaModelIndex,
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

    for (const [rel, file] of analysis.files) {
      const classes = findAll(file.root, (n) => n.type === "class_declaration");
      for (const cls of classes) {
        const anns = listAnnotations(cls);
        const controllerAnn = anns.find((a) => a.name === "Controller");
        if (!controllerAnn) continue;
        const basePath = normalizePath(annotationStringArg(controllerAnn.node) ?? "");
        scanController(cls, basePath, analysis, model, rel, candidates);
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
    );

    const returnType = declaredReturnType(method);
    const isHttpResponseReturn = returnsHttpResponse(returnType, analysis, rel);

    const responses = isHttpResponseReturn
      ? collectHttpResponses(method, returnType, model, gaps, rel)
      : collectBareResponses(method, returnType, model, gaps, rel, fieldTypes);

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

function collectParameters(
  method: TsNode,
  model: JavaModelIndex,
  pathParams: Set<string>,
  rel: string,
  gaps: GapCode[],
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
}

/** Walk HttpResponse.<factory>(...).body(x).status(c) chains. */
function collectBuiltResponses(
  method: TsNode,
  model: JavaModelIndex,
  rel: string,
): BuiltResponse[] {
  const localVars = localVarTypes(method);
  const out: BuiltResponse[] = [];
  const returns = findAll(method, (n) => n.type === "return_statement");
  for (const ret of returns) {
    const call = ret.namedChildren.find((n) => n.type === "method_invocation");
    if (!call) continue;
    const built = walkHttpChain(call, localVars, model, rel);
    if (built) out.push(built);
  }
  return out;
}

function walkHttpChain(
  root: TsNode,
  localVars: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): BuiltResponse | null {
  let status = "200";
  let entityArg: TsNode | undefined;
  let node: TsNode | undefined = root;
  let guard = 0;
  while (node && node.type === "method_invocation" && guard++ < 8) {
    const mname = node.namedChildren[1]?.text ?? "";
    const argList = childrenOfType(node, "argument_list")[0];
    const posArgs = argList ? argList.namedChildren : [];
    if (mname === "ok") {
      status = "200";
      if (posArgs.length) entityArg = posArgs[0];
    } else if (mname === "body") {
      if (posArgs.length) entityArg = posArgs[0];
    } else if (mname === "status") {
      const parsed = parseStatusArg(posArgs[0]);
      if (parsed) status = parsed;
    } else if (FACTORY_STATUS[mname]) {
      status = FACTORY_STATUS[mname]!;
      // ok(entity) / accepted(entity) carry the entity positionally;
      // created(uri) carries a Location URI, not the entity.
      if (posArgs.length && (mname === "ok" || mname === "accepted")) {
        entityArg = posArgs[0];
      }
    }
    node = node.namedChildren[0];
  }
  const entity = entityArg ? entityArgToSchema(entityArg, localVars, model, rel) : undefined;
  return { status, ...(entity ? { entity } : {}) };
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

function collectHttpResponses(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
): DiscoveredResponse[] {
  // HttpResponse<T>: the generic argument T is the entity type when the handler
  // does not pin one via .body(). Prefer explicit builder chains; fall back to T.
  const built = collectBuiltResponses(method, model, rel);
  if (built.length) {
    const byStatus = new Map<string, DiscoveredResponse>();
    for (const b of built) {
      if (byStatus.has(b.status)) continue;
      byStatus.set(b.status, {
        statusCode: b.status,
        description: "",
        confidence: "high",
        ...(b.entity
          ? { content: [{ mediaType: "application/json", schema: b.entity }] }
          : b.status.startsWith("204") || b.status.startsWith("304")
            ? {}
            : { content: [{ mediaType: "application/json", schema: {} }] }),
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
