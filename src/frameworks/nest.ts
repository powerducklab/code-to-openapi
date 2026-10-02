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
  SourceLocation,
} from "../core/types.js";
import type { TsAnalysis } from "../lang/typescript/index.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";

const VERBS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "Head",
  "Options",
  "All",
]);

const NEST_PACKAGE = "@nestjs/common";

interface NestImport {
  /** Local decorator name -> exported Nest decorator name. */
  names: Map<string, string>;
}

function joinPrefix(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return joined ? `/${joined}` : "";
}

function normalizeNestPath(raw: string): string {
  return raw
    .replace(/:([A-Za-z0-9_]+)\??/g, "{**$1}")
    .replace(/\{\*\*([A-Za-z0-9_]+)\}/g, "{$1}")
    .replace(/\*+[A-Za-z0-9_]*/g, "{wildcard}");
}

function decoratorsOf(ts: any, node: any): any[] {
  if (typeof ts.getDecorators === "function") {
    return ts.getDecorators(node) ?? [];
  }
  return node?.decorators ?? [];
}

function decoratorInfo(
  ts: any,
  decorator: any,
): { name: string; args: any[] } | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    const target = expr.expression;
    if (ts.isIdentifier(target)) {
      return { name: target.text, args: [...expr.arguments] };
    }
    return null;
  }
  if (ts.isIdentifier(expr)) return { name: expr.text, args: [] };
  return null;
}

function firstStringArg(ts: any, args: any[]): string {
  const first = args[0];
  if (first && ts.isStringLiteralLike(first)) return first.text;
  return "";
}

export const nestPack: FrameworkPack<TsAnalysis> = {
  id: "nest",
  language: "typescript",
  dependencyHints: ["@nestjs/common", "@nestjs/core"],

  applies(ctx) {
    return (
      ctx.manifest.packages.has("@nestjs/common") ||
      ctx.manifest.packages.has("@nestjs/core") ||
      ctx.index.files.some((f) => f.content.includes(`from "${NEST_PACKAGE}"`))
    );
  },

  extract(analysis, ctx) {
    const { ts, checker } = analysis;
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    let bearerAuth = false;
    let globalPrefix = "";
    const listenPorts: number[] = [];

    const schemaOfTypeNode = (node: any, hint?: string): JsonSchema | undefined => {
      try {
        const type = checker.getTypeFromTypeNode(node);
        const schema = typeToSchema(type, analysis.schemaContext, hint);
        return schema && Object.keys(schema).length ? schema : undefined;
      } catch {
        return undefined;
      }
    };

    const schemaOfValue = (node: any, hint?: string): JsonSchema | undefined => {
      try {
        const type = checker.getTypeAtLocation(node);
        if (type && !(type.flags & ts.TypeFlags.Any) && !(type.flags & ts.TypeFlags.Unknown)) {
          const schema = typeToSchema(type, analysis.schemaContext, hint);
          if (schema && Object.keys(schema).length) return schema;
        }
      } catch {
        // ignore untyped nodes
      }
      return undefined;
    };

    // First pass: bootstrap signals (global prefix, listen port) can live in
    // any file, often main.ts which indexes after controllers alphabetically.
    for (const [, source] of analysis.sourceByPath) {
      const visitBootstrap = (node: any) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "setGlobalPrefix" &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          globalPrefix = node.arguments[0].text;
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "listen" &&
          ts.isNumericLiteral(node.arguments[0])
        ) {
          listenPorts.push(Number(node.arguments[0].text));
        }
        ts.forEachChild(node, visitBootstrap);
      };
      visitBootstrap(source);
    }

    for (const [rel, source] of analysis.sourceByPath) {
      // Nest named imports in this file.
      const nestImport: NestImport = { names: new Map() };
      source.forEachChild((child: any) => {
        if (
          ts.isImportDeclaration(child) &&
          ts.isStringLiteral(child.moduleSpecifier) &&
          child.moduleSpecifier.text === NEST_PACKAGE &&
          child.importClause?.namedBindings &&
          ts.isNamedImports(child.importClause.namedBindings)
        ) {
          for (const element of child.importClause.namedBindings.elements) {
            nestImport.names.set(
              element.name.text,
              element.propertyName?.text ?? element.name.text,
            );
          }
        }
      });

      const localName = (decoratorName: string) => {
        for (const [local, imported] of nestImport.names) {
          if (imported === decoratorName) return local;
        }
        return decoratorName;
      };

      const visit = (node: any) => {
        if (ts.isClassDeclaration(node) && node.name) {
          const classDecorators = decoratorsOf(ts, node);
          const controllerDec = classDecorators.find((dec) => {
            const info = decoratorInfo(ts, dec);
            return info && info.name === localName("Controller");
          });
          if (controllerDec) {
            const info = decoratorInfo(ts, controllerDec)!;
            const ctrlPrefix = firstStringArg(ts, info.args);
            const classGuarded = hasBearerGuard(ts, classDecorators);
            const classApiBearer = classDecorators.some((dec) => {
              const di = decoratorInfo(ts, dec);
              return di && /ApiBearerAuth|BearerAuth/.test(di.name);
            });
            const apiTags = collectApiTags(ts, classDecorators);
            const baseTag =
              apiTags[0] ??
              (node.name.text.replace(/Controller$/, "").toLowerCase() ||
                "default");

            for (const member of node.members) {
              if (!ts.isMethodDeclaration(member)) continue;
              const methodDecorators = decoratorsOf(ts, member);
              const verbDec = methodDecorators.find((dec) => {
                const di = decoratorInfo(ts, dec);
                if (!di) return false;
                for (const verb of VERBS) {
                  if (di.name === localName(verb)) return true;
                }
                return false;
              });
              const sseDec = methodDecorators.find((dec) => {
                const di = decoratorInfo(ts, dec);
                return di && di.name === localName("Sse");
              });
              if (!verbDec && !sseDec) continue;

              const verbInfo = verbDec
                ? decoratorInfo(ts, verbDec)!
                : decoratorInfo(ts, sseDec!)!;
              const verb = verbDec
                ? [...VERBS].find((v) => verbInfo.name === localName(v))!
                : "Get";
              const subPath = firstStringArg(ts, verbInfo.args);
              const fullPath = joinPrefix(globalPrefix, ctrlPrefix, subPath);
              const normalized = normalizeNestPath(fullPath || "/");
              const pathParams = new Set(
                [...normalized.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
              );

              const origin: SourceLocation = {
                file: rel,
                line:
                  ts.getLineAndCharacterOfPosition(source, member.getStart(source))
                    .line + 1,
              };

              const { parameters, requestBody, gaps } = collectParameters(
                ts,
                analysis,
                member,
                pathParams,
              );

              const methodGuarded = hasBearerGuard(ts, methodDecorators);
              const methodApiBearer = methodDecorators.some((dec) => {
                const di = decoratorInfo(ts, dec);
                return di && /ApiBearerAuth|BearerAuth/.test(di.name);
              });
              const authed = classGuarded || methodGuarded || classApiBearer || methodApiBearer;
              if (authed) bearerAuth = true;

              const httpCode = collectHttpCode(ts, methodDecorators);
              const isSse = Boolean(sseDec);
              const responses = isSse
                ? collectSseResponse(ts, member, schemaOfTypeNode)
                : collectResponses(
                    ts,
                    member,
                    verb,
                    httpCode,
                    schemaOfTypeNode,
                    schemaOfValue,
                    gaps,
                  );
              const methodName = member.name?.getText(source) ?? "";
              const className = node.name?.text ?? "";
              // Qualify with the controller class so shared method names
              // (findAll/create/update) across controllers stay unique.
              const operationId =
                className && methodName ? `${className}_${methodName}` : methodName || undefined;
              const candidate: RouteCandidate = {
                method: verb.toLowerCase() === "all" ? "get" : verb.toLowerCase(),
                path: normalized,
                fullPath: normalized,
                operationId,
                origin,
                parameters,
                ...(requestBody ? { requestBody } : {}),
                responses,
                tags: [baseTag],
                ...(authed ? { security: [{ bearerAuth: [] }] } : {}),
                ...(isSse ? { extensions: { "x-protocol": "sse" } } : {}),
                confidence: gaps.length ? "medium" : "high",
                gaps,
                components: [],
                handlerSource: sliceMember(ts, source, member),
              };
              candidates.push(candidate);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    const components = [...analysis.schemaContext.components.entries()].map(
      ([name, schema]) => ({ name, schema }),
    );
    const securitySchemes: DiscoveredSecurityScheme[] = bearerAuth
      ? [{ name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } }]
      : [];
    const servers: DiscoveredServer[] = listenPorts.length
      ? [{ url: `http://localhost:${listenPorts[0]}` }]
      : [];

    return {
      routes: dedupe(candidates),
      unresolved,
      components,
      securitySchemes,
      servers,
    };
  },
};

interface ParamFacts {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
  gaps: GapCode[];
}

function collectParameters(
  ts: any,
  analysis: TsAnalysis,
  method: any,
  pathParams: Set<string>,
): ParamFacts {
  const { checker } = analysis;
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  let requestBody: ParamFacts["requestBody"];

  const schemaFromType = (param: any): JsonSchema | undefined => {
    if (!param.type) return undefined;
    try {
      const type = checker.getTypeFromTypeNode(param.type);
      const schema = typeToSchema(type, analysis.schemaContext);
      return schema && Object.keys(schema).length ? schema : undefined;
    } catch {
      return undefined;
    }
  };

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required?: boolean,
  ) => {
    if (parameters.some((p) => p.in === location && p.name === name)) return;
    parameters.push({
      name,
      in: location,
      required: required ?? location === "path",
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    });
  };

  // Whole-object decorators (e.g. @Query() dto: SearchDto) resolve to a $ref
  // component; dereference it before expanding parameter properties.
  const dereference = (schema: JsonSchema): JsonSchema => {
    if (schema.$ref) {
      const name = (schema.$ref as string).split("/").pop();
      if (name && analysis.schemaContext.components.has(name)) {
        return analysis.schemaContext.components.get(name)!;
      }
    }
    return schema;
  };

  const expandObject = (
    schema: JsonSchema | undefined,
    location: RouteParameter["in"],
    requiredDefault: boolean,
  ) => {
    if (!schema) return;
    const resolved = dereference(schema);
    const props = resolved.properties as Record<string, JsonSchema> | undefined;
    if (!props) return;
    const required = new Set(
      Array.isArray(resolved.required) ? (resolved.required as string[]) : [],
    );
    for (const [name, prop] of Object.entries(props)) {
      addParam(location, name, prop, "high", required.has(name) || requiredDefault);
    }
  };

  for (const param of method.parameters ?? []) {
    const decs = decoratorsOf(ts, param);
    for (const dec of decs) {
      const info = decoratorInfo(ts, dec);
      if (!info) continue;
      const schema = schemaFromType(param);
      switch (info.name) {
        case "Param": {
          const nameArg = info.args[0];
          if (nameArg && ts.isStringLiteralLike(nameArg)) {
            // At the HTTP layer every path parameter arrives as a string. When
            // the handler omits the type annotation (`@Param('slug') slug`),
            // default to { type: string } instead of leaving an untyped gap.
            // An explicit annotation (`: number`) is preserved as-is.
            addParam(
              "path",
              nameArg.text,
              schema ?? { type: "string" },
              "high",
              true,
            );
          } else if (schema?.properties || schema?.$ref) {
            expandObject(schema, "path", true);
          }
          break;
        }
        case "Query": {
          const nameArg = info.args[0];
          if (nameArg && ts.isStringLiteralLike(nameArg)) {
            addParam("query", nameArg.text, schema, "high", false);
          } else if (schema?.properties || schema?.$ref) {
            expandObject(schema, "query", false);
          } else {
            gaps.add("query-unknown");
          }
          break;
        }
        case "Headers": {
          const nameArg = info.args[0];
          if (nameArg && ts.isStringLiteralLike(nameArg)) {
            addParam("header", nameArg.text.toLowerCase(), schema, "high", false);
          } else if (schema?.properties || schema?.$ref) {
            const resolved = dereference(schema);
            const props = (resolved.properties ?? {}) as Record<string, JsonSchema>;
            for (const name of Object.keys(props)) {
              addParam("header", name.toLowerCase(), props[name], "high", false);
            }
          }
          break;
        }
        case "Body": {
          // `@Body('article') dto` selects req.body.article; the wire body still
          // carries the envelope key, so wrap the DTO schema in `{article: dto}`.
          const keyArg = info.args[0];
          const bodyKey =
            keyArg && ts.isStringLiteralLike(keyArg) ? keyArg.text : undefined;
          if (schema) {
            const wrapped: JsonSchema = bodyKey
              ? {
                  type: "object",
                  properties: { [bodyKey]: schema },
                  required: [bodyKey],
                }
              : schema;
            requestBody = {
              required: true,
              content: [{ mediaType: "application/json", schema: wrapped }],
              confidence: "high",
            };
          } else {
            gaps.add("body-schema-unknown");
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Route path params must always be present even if the handler omits @Param.
  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return { parameters, ...(requestBody ? { requestBody } : {}), gaps: [...gaps] };
}

function collectHttpCode(ts: any, decorators: any[]): string | null {
  for (const dec of decorators) {
    const info = decoratorInfo(ts, dec);
    if (info && info.name === "HttpCode" && info.args[0]) {
      const text = info.args[0].getText?.() ?? "";
      if (/^\d{3}$/.test(text)) return text;
    }
  }
  return null;
}

function hasBearerGuard(ts: any, decorators: any[]): boolean {
  for (const dec of decorators) {
    const info = decoratorInfo(ts, dec);
    if (!info) continue;
    if (/UseGuards|AuthGuard|Jwt|Bearer/.test(info.name)) {
      const text = dec.getText();
      if (/jwt|bearer|authguard/i.test(text)) return true;
    }
  }
  return false;
}

function collectApiTags(ts: any, decorators: any[]): string[] {
  const tags: string[] = [];
  for (const dec of decorators) {
    const info = decoratorInfo(ts, dec);
    if (info && info.name === "ApiTags") {
      for (const arg of info.args) {
        if (ts.isStringLiteralLike(arg)) tags.push(arg.text);
      }
    }
  }
  return tags;
}

function defaultStatus(verb: string, httpCode: string | null): string {
  if (httpCode) return httpCode;
  return verb === "Post" ? "201" : "200";
}

function collectResponses(
  ts: any,
  method: any,
  verb: string,
  httpCode: string | null,
  schemaOfTypeNode: (node: any, hint?: string) => JsonSchema | undefined,
  schemaOfValue: (node: any, hint?: string) => JsonSchema | undefined,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const responses: DiscoveredResponse[] = [];
  const status = defaultStatus(verb, httpCode);

  let schema: JsonSchema | undefined;
  if (method.type) {
    const { node } = unwrapTypeReference(ts, method.type);
    schema = schemaOfTypeNode(node);
  }

  // Observe explicit status branches and returned payloads:
  //   return new HttpStatusException(...) style is ignored; `@HttpCode` wins.
  if (!schema) {
    const returnSchemas: JsonSchema[] = [];
    const visit = (n: any) => {
      if (
        ts.isReturnStatement(n) &&
        n.expression &&
        !ts.isStringLiteral(n.expression)
      ) {
        const observed = schemaOfValue(n.expression);
        if (observed) returnSchemas.push(observed);
      }
      ts.forEachChild(n, visit);
    };
    if (method.body) visit(method.body);
    schema = mergeReturnSchemas(returnSchemas);
  }

  if (schema) {
    responses.push({
      statusCode: status,
      description: "",
      confidence: "high",
      content: [{ mediaType: "application/json", schema }],
    });
  } else {
    // No type information at all: explicit gap for the AI resolver.
    gaps.push("response-unknown");
    responses.push({
      statusCode: status,
      description: "",
      confidence: "low",
      content: [{ mediaType: "application/json" }],
    });
  }
  return responses;
}

function collectSseResponse(
  ts: any,
  method: any,
  schemaOfTypeNode: (node: any, hint?: string) => JsonSchema | undefined,
): DiscoveredResponse[] {
  let itemSchema: JsonSchema | undefined;
  if (method.type) {
    const { node, wrapper } = unwrapTypeReference(ts, method.type);
    if (wrapper === "Observable" && ts.isTypeReferenceNode(node)) {
      // Observable<MessageEvent<T>> -> payload type T.
      const arg = node.typeArguments?.[0];
      if (arg) {
        const inner = schemaOfTypeNode(arg);
        const dataProp = (inner?.properties as Record<string, JsonSchema> | undefined)?.data;
        itemSchema = dataProp ?? inner;
      }
    } else {
      itemSchema = schemaOfTypeNode(node);
    }
  }
  return [
    {
      statusCode: "200",
      description: "Server-sent events",
      confidence: itemSchema ? "high" : "medium",
      content: [{ mediaType: "text/event-stream", itemSchema: itemSchema ?? {} }],
    },
  ];
}

function unwrapTypeReference(
  ts: any,
  node: any,
): { node: any; wrapper?: string } {
  if (node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if ((name === "Promise" || name === "Observable") && node.typeArguments?.[0]) {
      return { node: node.typeArguments[0], wrapper: name };
    }
  }
  return { node };
}

function mergeReturnSchemas(schemas: JsonSchema[]): JsonSchema | undefined {
  if (!schemas.length) return undefined;
  if (schemas.length === 1) return schemas[0];
  return { oneOf: schemas };
}

function sliceMember(ts: any, source: any, node: any): string | undefined {
  try {
    const text = node.getText(source) as string;
    return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
  } catch {
    return undefined;
  }
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
