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

    const throwing = hasOnlyThrowingExit(method);
    if (throwing) gaps.push("response-unknown");
    const responses: DiscoveredResponse[] = throwing ? [{statusCode:"default",description:"Exception response requires handler resolution",confidence:"low"}] : isHttpResponseReturn
      ? collectHttpResponses(method, returnType, model, gaps, rel, analysis)
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

function collectHttpResponses(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
  analysis: JavaAnalysis,
): DiscoveredResponse[] {
  // HttpResponse<T>: the generic argument T is the entity type when the handler
  // does not pin one via .body(). Prefer explicit builder chains; fall back to T.
  const built = collectBuiltResponses(method, model, rel, analysis);
  if (built.length) {
    const byStatus = new Map<string, DiscoveredResponse>();
    for (const b of built) {
      if (b.status === "default") gaps.push("response-unknown");
      const existing = byStatus.get(b.status);
      const response: DiscoveredResponse = {
        statusCode: b.status,
        description: "",
        confidence: "high",
        ...(b.entity
          ? { content: [{ mediaType: "application/json", schema: b.entity }] }
          : b.bodyless || b.status.startsWith("204") || b.status.startsWith("304")
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
