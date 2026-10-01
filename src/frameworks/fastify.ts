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
import type { TsAnalysis } from "../lang/typescript/index.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";
import { resolveHandler, resolveImportedFile } from "./express-handler.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);

interface RouteSite {
  instance: string;
  method: string;
  url: string;
  /** Native JSON Schema node from route options (`schema`), when present. */
  schemaNode: any | null;
  /** Full route options text, used for auth hint matching. */
  optionsText: string;
  handler: any | null;
  origin: SourceLocation;
}

interface RegisterEdge {
  parent: string;
  /** Local plugin identifier, when the plugin is imported/defined by name. */
  pluginName: string | null;
  /** Inline plugin function/arrow node, when registered directly. */
  inlineNode: any | null;
  prefix: string;
}

interface FileModel {
  rel: string;
  source: any;
  /** Local binding name of the fastify default import/factory. */
  factoryBindings: Set<string>;
  /** Root instance variable names (Fastify() call). */
  roots: Set<string>;
  moduleBindings: Map<string, { specifier: string; exportName: string }>;
  routes: RouteSite[];
  edges: RegisterEdge[];
  listenPorts: number[];
}

function joinPrefix(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return joined ? `/${joined}` : "";
}

/**
 * Fastify path templates use `:param` and a trailing `*` wildcard. Named
 * wildcards (`*splat`) are not valid in v4; normalize both to OAS `{...}`.
 */
function normalizeFastifyPath(raw: string): { path: string; dynamic: boolean } {
  if (raw.includes("(.*)") || /[\^$]/.test(raw)) return { path: raw, dynamic: true };
  const path = raw
    .replace(/:([A-Za-z0-9_]+)\??/g, "{**$1}")
    .replace(/\{\*\*([A-Za-z0-9_]+)\}/g, "{$1}")
    .replace(/\*+[A-Za-z0-9_]*/g, "{wildcard}");
  return { path, dynamic: false };
}

function operationId(method: string, fullPath: string): string {
  const segments = fullPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ""))
    .map((segment) => segment.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const tail = segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${method.toLowerCase()}${tail}` || `${method.toLowerCase()}Root`;
}

function tagForPath(fullPath: string, file: string): string[] {
  const segment = fullPath.split("/").filter(Boolean)[0];
  if (segment && !segment.startsWith("{")) return [segment];
  const base = file.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "default";
  return [base === "index" ? "default" : base];
}

function literalValue(ts: any, node: any, depth = 0): unknown {
  if (!node || depth > 14) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el: any) => literalValue(ts, el, depth + 1));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText ? prop.name.getText().replace(/^['"]|['"]$/g, "") : undefined;
        if (name) out[name] = literalValue(ts, prop.initializer, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

export const fastifyPack: FrameworkPack<TsAnalysis> = {
  id: "fastify",
  language: "typescript",
  dependencyHints: ["fastify"],

  applies(ctx) {
    return (
      ctx.manifest.packages.has("fastify") ||
      ctx.index.files.some((f) =>
        /require\(["']fastify["']\)|from ["']fastify["']/.test(f.content),
      )
    );
  },

  extract(analysis, ctx) {
    const { ts } = analysis;
    const models = new Map<string, FileModel>();
    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const servers: DiscoveredServer[] = [];
    let bearerAuth = false;

    // Resolve a plugin identifier (imported or local function) to the function
    // node and the file it lives in.
    const resolvePlugin = (
      model: FileModel,
      name: string,
    ): { file: any; node: any; instanceParam: string } | null => {
      // Local function/arrow in the same file.
      let local: any = null;
      model.source.forEachChild((child: any) => {
        if (local) return;
        if (ts.isFunctionDeclaration(child) && child.name?.text === name) local = child;
        if (ts.isVariableStatement(child)) {
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === name &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              local = decl.initializer;
            }
          }
        }
      });
      if (local) {
        const param = local.parameters?.[0]?.name?.getText?.(model.source);
        return param ? { file: model.source, node: local, instanceParam: param } : null;
      }

      const binding = model.moduleBindings.get(name);
      if (!binding) return null;
      const imported = resolveImportedFile(analysis, model.source, name);
      if (!imported) return null;
      const { file, exportName } = imported;
      let target: any = null;
      file.forEachChild((child: any) => {
        if (target) return;
        if (
          (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child)) &&
          (exportName === "default" || child.name?.text === exportName)
        ) {
          target = child;
        }
        if (ts.isExportAssignment(child)) {
          if (ts.isArrowFunction(child.expression) || ts.isFunctionExpression(child.expression)) {
            target = child.expression;
          } else if (ts.isIdentifier(child.expression)) {
            const ownerRel = relOfSource(file, models);
            const owner = ownerRel ? models.get(ownerRel) : undefined;
            const nested = resolvePlugin(owner ?? model, child.expression.text);
            if (nested) target = nested.node;
          }
        }
      });
      if (!target) return null;
      const param = target.parameters?.[0]?.name?.getText?.(file);
      return param ? { file, node: target, instanceParam: param } : null;
    };

    const visitedScopes = new Set<string>();

    const processScope = (
      model: FileModel,
      scopeNode: any,
      instanceName: string,
      prefix: string,
      depth: number,
    ) => {
      if (depth > 12) return;
      const scopeKey = `${model.rel}:${instanceName}:${prefix}:${scopeNode?.pos ?? 0}`;
      if (visitedScopes.has(scopeKey)) return;
      visitedScopes.add(scopeKey);

      const sites = collectSites(
        ts,
        model,
        scopeNode ?? model.source,
        instanceName,
        prefix,
      );

      for (const site of sites.routes) {
        const normalized = normalizeFastifyPath(site.url);
        if (normalized.dynamic) {
          unresolved.push({
            reason: "dynamic-path",
            message: "Fastify route path is not a static string literal",
            origin: site.origin,
          });
          continue;
        }
        const fullPath = joinPrefix(prefix, normalized.path);
        const pathParams = new Set(
          [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
        );

        const schemaFacts = extractRouteSchema(ts, analysis, site.schemaNode);
        const handlerFacts = site.handler
          ? analyzeFastifyHandler(analysis, model.source, site.handler, site.origin, pathParams)
          : { parameters: [], responses: [], gaps: ["response-unknown" as GapCode], sse: false, bodyKnown: false };

        // Merge: explicit JSON Schema (high confidence) wins over inferred.
        const merged = mergeFacts(schemaFacts, handlerFacts, pathParams);
        if (/(^|[^a-z])(auth|authenticate|jwt|bearer|guard|preHandler)/i.test(site.optionsText)) {
          bearerAuth = true;
        }

        const method = site.method === "all" ? "get" : site.method;
        const candidate: RouteCandidate = {
          method,
          path: normalized.path,
          fullPath,
          operationId: operationId(method, fullPath),
          origin: site.origin,
          parameters: merged.parameters,
          ...(merged.requestBody ? { requestBody: merged.requestBody } : {}),
          responses: merged.responses,
          tags: tagForPath(fullPath, model.rel),
          ...(bearerAuth ? { security: [{ bearerAuth: [] }] } : {}),
          confidence: rankConfidence(merged.gaps),
          gaps: merged.gaps,
          components: [],
          handlerSource: sliceNode(ts, model.source, site.handler),
        };
        candidates.push(candidate);
      }

      for (const edge of sites.edges) {
        const childPrefix = joinPrefix(prefix, edge.prefix);
        if (edge.inlineNode) {
          const param =
            edge.inlineNode.parameters?.[0]?.name?.getText?.(model.source) ??
            instanceName;
          processScope(model, edge.inlineNode.body ?? edge.inlineNode, param, childPrefix, depth + 1);
        } else if (edge.pluginName) {
          const resolved = resolvePlugin(model, edge.pluginName);
          if (resolved) {
            const childRel = relOfSource(resolved.file, models);
            const childModel = childRel ? models.get(childRel) : undefined;
            if (childModel) {
              processScope(childModel, resolved.node.body, resolved.instanceParam, childPrefix, depth + 1);
            }
          } else {
            unresolved.push({
              reason: "handler-unresolved",
              message: `Fastify plugin "${edge.pluginName}" could not be resolved`,
              origin: { file: model.rel },
            });
          }
        }
      }
    };

    for (const model of models.values()) {
      for (const root of model.roots) {
        processScope(model, model.source, root, "", 0);
      }
    }

    for (const model of models.values()) {
      const port = model.listenPorts[0];
      if (port) servers.push({ url: `http://localhost:${port}` });
    }

    // Files that only export a plugin (no root instance) are reached via edges;
    // nothing to do for them here.
    const deduped = dedupe(candidates);

    const components = [...analysis.schemaContext.components.entries()].map(
      ([name, schema]) => ({ name, schema }),
    );
    const securitySchemes: DiscoveredSecurityScheme[] = bearerAuth
      ? [{ name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } }]
      : [];

    return {
      routes: deduped,
      unresolved,
      components,
      securitySchemes,
      servers: dedupeServers(servers),
    };
  },
};

interface Facts {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence };
  responses: DiscoveredResponse[];
  gaps: GapCode[];
  sse: boolean;
  bodyKnown: boolean;
}

function emptyFacts(): Facts {
  return { parameters: [], responses: [], gaps: [], sse: false, bodyKnown: false };
}

function rankConfidence(gaps: GapCode[]): Confidence {
  if (!gaps.length) return "high";
  if (gaps.some((g) => ["response-unknown", "body-unknown"].includes(g))) return "low";
  return "medium";
}

function relOfSource(source: any, models: Map<string, FileModel>): string | null {
  for (const [rel, model] of models) {
    if (model.source === source) return rel;
  }
  return null;
}

function sliceNode(ts: any, file: any, node: any): string | undefined {
  if (!node) return undefined;
  try {
    const text = node.getText(file) as string;
    return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
  } catch {
    return undefined;
  }
}

function modelFile(analysis: TsAnalysis, rel: string, source: any): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    factoryBindings: new Set(),
    roots: new Set(),
    moduleBindings: new Map(),
    routes: [],
    edges: [],
    listenPorts: [],
  };

  source.forEachChild((child: any) => {
    if (ts.isImportDeclaration(child) && ts.isStringLiteral(child.moduleSpecifier)) {
      const specifier = child.moduleSpecifier.text;
      if (specifier === "fastify" && child.importClause?.name) {
        model.factoryBindings.add(child.importClause.name.text);
      } else if (specifier.startsWith(".") && child.importClause) {
        if (child.importClause.name) {
          model.moduleBindings.set(child.importClause.name.text, {
            specifier,
            exportName: "default",
          });
        }
        const named = child.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            model.moduleBindings.set(element.name.text, {
              specifier,
              exportName: element.propertyName?.text ?? element.name.text,
            });
          }
        }
      }
    }
  });

  // Root instances: const app = Fastify(...) / fastify({...})
  const visit = (node: any) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && model.factoryBindings.has(callee.text)) {
        model.roots.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  source.forEachChild((child: any) => visit(child));

  return model;
}

function originOf(ts: any, file: string, source: any, node: any): SourceLocation {
  return {
    file,
    line: ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1,
  };
}

/**
 * Collects route and register calls made on `instanceName` within a scope.
 * Inline registered plugins are returned as edges with their AST node so the
 * caller can descend; identifier plugins are returned by name for cross-file
 * resolution.
 */
function collectSites(
  ts: any,
  model: FileModel,
  scope: any,
  instanceName: string,
  _prefix: string,
): { routes: RouteSite[]; edges: RegisterEdge[] } {
  const routes: RouteSite[] = [];
  const edges: RegisterEdge[] = [];

  const visit = (node: any) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      const receiver = access.expression;
      const method = access.name.text;

      if (ts.isIdentifier(receiver) && receiver.text === instanceName) {
        const origin = originOf(ts, model.rel, model.source, node);

        if (method === "listen") {
          const first = node.arguments[0];
          if (first && ts.isObjectLiteralExpression(first)) {
            const portProp = first.properties.find(
              (p: any) =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(model.source).replace(/['"]/g, "") === "port",
            );
            if (portProp && ts.isNumericLiteral(portProp.initializer)) {
              model.listenPorts.push(Number(portProp.initializer.text));
            }
          } else if (first && ts.isNumericLiteral(first)) {
            model.listenPorts.push(Number(first.text));
          }
        }

        if (method === "register") {
          const target = node.arguments[0];
          const opts = node.arguments[1];
          let pluginPrefix = "";
          if (opts && ts.isObjectLiteralExpression(opts)) {
            const prefixProp = opts.properties.find(
              (p: any) =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(model.source).replace(/['"]/g, "") === "prefix",
            );
            const raw = prefixProp && literalValue(ts, prefixProp.initializer);
            if (typeof raw === "string") pluginPrefix = raw;
          }
          if (target && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) {
            edges.push({ parent: instanceName, pluginName: null, inlineNode: target, prefix: pluginPrefix });
          } else if (target && ts.isIdentifier(target)) {
            edges.push({ parent: instanceName, pluginName: target.text, inlineNode: null, prefix: pluginPrefix });
          }
        }

        if (HTTP_METHODS.has(method)) {
          const urlArg = node.arguments[0];
          const url = urlArg && ts.isStringLiteralLike(urlArg) ? urlArg.text : null;
          if (url !== null) {
            const fnArgs = [...node.arguments].slice(1);
            const options = fnArgs.find((a: any) => ts.isObjectLiteralExpression(a)) ?? null;
            const handler =
              [...fnArgs].reverse().find(
                (a: any) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a),
              ) ?? null;
            routes.push({
              instance: instanceName,
              method,
              url,
              schemaNode: options ? getObjectProperty(ts, options, "schema") : null,
              optionsText: options ? options.getText(model.source) : "",
              handler,
              origin,
            });
          }
        }

        if (method === "route" && ts.isObjectLiteralExpression(node.arguments[0])) {
          const obj = node.arguments[0];
          const get = (key: string) =>
            obj.properties.find(
              (p: any) =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(model.source).replace(/['"]/g, "") === key,
            )?.initializer ?? null;
          const methodNode = get("method");
          const urlNode = get("url") ?? get("path");
          const schemaNode = get("schema");
          const handlerNode = get("handler");
          const methodText = methodNode
            ? String(literalValue(ts, methodNode) ?? methodNode.getText(model.source)).toLowerCase()
            : null;
          const urlText = urlNode ? literalValue(ts, urlNode) : null;
          if (methodText && HTTP_METHODS.has(methodText) && typeof urlText === "string") {
            routes.push({
              instance: instanceName,
              method: methodText,
              url: urlText,
              schemaNode: schemaNode && ts.isObjectLiteralExpression(schemaNode) ? schemaNode : null,
              optionsText: obj.getText(model.source),
              handler: handlerNode,
              origin,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(scope);
  return { routes, edges };
}

function getObjectProperty(ts: any, obj: any, key: string): any | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const prop = obj.properties.find(
    (p: any) =>
      ts.isPropertyAssignment(p) &&
      p.name.getText().replace(/^['"]|['"]$/g, "") === key,
  );
  return prop?.initializer ?? null;
}

/**
 * Reads Fastify's route `schema` option (native JSON Schema literals):
 * params / querystring / body / headers / response. These are authoritative
 * and emitted at high confidence.
 */function extractRouteSchema(
  ts: any,
  analysis: TsAnalysis,
  schemaNode: any,
): Facts {
  const facts = emptyFacts();
  if (!schemaNode || !ts.isObjectLiteralExpression(schemaNode)) return facts;

  const addParams = (
    node: any,
    location: RouteParameter["in"],
    requiredDefault: boolean,
  ) => {
    const schema = literalValue(ts, node) as JsonSchema | undefined;
    if (!schema || typeof schema !== "object" || schema.type !== "object") return;
    const required = new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    for (const [name, propSchema] of Object.entries(
      (schema.properties ?? {}) as Record<string, JsonSchema>,
    )) {
      facts.parameters.push({
        name,
        in: location,
        required: required.has(name) || requiredDefault,
        schema: (propSchema as JsonSchema) ?? {},
        confidence: "high",
      });
    }
  };

  const paramsNode = getObjectProperty(ts, schemaNode, "params");
  const queryNode =
    getObjectProperty(ts, schemaNode, "querystring") ??
    getObjectProperty(ts, schemaNode, "query");
  const headersNode = getObjectProperty(ts, schemaNode, "headers");
  const bodyNode = getObjectProperty(ts, schemaNode, "body");
  const responseNode = getObjectProperty(ts, schemaNode, "response");

  if (paramsNode) addParams(paramsNode, "path", true);
  if (queryNode) addParams(queryNode, "query", false);
  if (headersNode) addParams(headersNode, "header", false);

  if (bodyNode) {
    const bodySchema = literalValue(ts, bodyNode) as JsonSchema | undefined;
    if (bodySchema && typeof bodySchema === "object") {
      facts.requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema: bodySchema }],
        confidence: "high",
      };
      facts.bodyKnown = true;
    }
  }

  if (responseNode && ts.isObjectLiteralExpression(responseNode)) {
    for (const prop of responseNode.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const status = prop.name.getText().replace(/^['"]|['"]$/g, "");
      if (!/^\d{3}$|^2XX$|^default$/i.test(status)) continue;
      const schema = literalValue(ts, prop.initializer) as JsonSchema | undefined;
      if (schema && typeof schema === "object") {
        facts.responses.push({
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema }],
        });
      }
    }
  }

  return facts;
}

/**
 * Infers contract facts from the handler function: request generics,
 * request.params/query/body/headers access, reply.code().send(), and async
 * return values. Type information wins; bare property accesses become gaps.
 */
function analyzeFastifyHandler(
  analysis: TsAnalysis,
  sourceFile: any,
  handlerNode: any,
  origin: SourceLocation,
  pathParams: Set<string>,
): Facts {
  const { ts, checker } = analysis;
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const paramIndex = new Map<string, RouteParameter>();
  const responses = new Map<string, DiscoveredResponse>();

  const resolved = resolveHandler(analysis, sourceFile, handlerNode);
  const handler = resolved?.node ?? handlerNode;
  const file = resolved?.file ?? sourceFile;

  const reqName = handler.parameters?.[0]?.name?.getText?.(file) ?? "request";
  const replyName = handler.parameters?.[1]?.name?.getText?.(file) ?? "reply";

  const factsBody: {
    schema?: JsonSchema;
    referenced: boolean;
    fields: Map<string, JsonSchema | undefined>;
  } = { referenced: false, fields: new Map() };

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema?: JsonSchema,
    confidence: Confidence = "medium",
    required = location === "path",
  ) => {
    const key = `${location}:${name}`;
    if (paramIndex.has(key)) {
      const existing = paramIndex.get(key)!;
      if (schema && (!existing.schema || !Object.keys(existing.schema).length)) {
        existing.schema = schema;
        existing.confidence = confidence;
      }
      return;
    }
    const param: RouteParameter = {
      name,
      in: location,
      required,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    };
    paramIndex.set(key, param);
    parameters.push(param);
  };

  const schemaOfTypeNode = (node: any): JsonSchema | undefined => {
    try {
      const type = checker.getTypeFromTypeNode(node);
      const schema = typeToSchema(type, analysis.schemaContext);
      return schema && Object.keys(schema).length ? schema : undefined;
    } catch {
      return undefined;
    }
  };

  // FastifyRequest<{ Params: T; Querystring: T; Body: T; Headers: T }>
  const reqType = handler.parameters?.[0]?.type;
  if (reqType && ts.isTypeReferenceNode(reqType) && reqType.typeArguments?.length) {
    const shape = reqType.typeArguments[0];
    if (shape && ts.isTypeLiteralNode(shape)) {
      for (const member of shape.members) {
        if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
        const key = member.name.getText(file);
        const schema = schemaOfTypeNode(member.type);
        if (key === "Params" && schema?.properties) {
          for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
            addParam("path", name, s, "high", true);
          }
        } else if ((key === "Querystring" || key === "Query") && schema?.properties) {
          for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
            addParam("query", name, s, "high", (schema.required as string[] | undefined)?.includes(name) ?? false);
          }
        } else if (key === "Headers" && schema?.properties) {
          for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
            addParam("header", name.toLowerCase(), s, "high", false);
          }
        } else if (key === "Body" && schema) {
          factsBody.schema = schema;
        }
      }
    }
  }

  const queryFields = new Map<string, JsonSchema | undefined>();
  const headerFields = new Map<string, JsonSchema | undefined>();

  const rootIdentifier = (node: any): string | undefined => {
    let cur = node;
    while (cur) {
      if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
        cur = cur.expression;
      } else if (ts.isCallExpression(cur)) {
        cur = ts.isPropertyAccessExpression(cur.expression)
          ? cur.expression.expression
          : cur.expression;
      } else {
        break;
      }
    }
    return ts.isIdentifier(cur) ? cur.text : undefined;
  };

  const typeAt = (node: any): JsonSchema | undefined => {
    try {
      const type = checker.getTypeAtLocation(node);
      if (type && !(type.flags & ts.TypeFlags.Any) && !(type.flags & ts.TypeFlags.Unknown)) {
        const schema = typeToSchema(type, analysis.schemaContext);
        if (schema && Object.keys(schema).length) return schema;
      }
    } catch {
      // ignore
    }
    return undefined;
  };

  const recordResponse = (status: string, schema: JsonSchema | undefined, confidence: Confidence) => {
    const mediaType = "application/json";
    const key = `${status}:${mediaType}`;
    const existing = responses.get(key);
    if (existing?.content?.[0]) {
      if (schema && (!existing.content[0].schema || confidence === "high")) {
        existing.content[0].schema = schema;
      }
      if (confidence === "high") existing.confidence = "high";
    } else {
      responses.set(key, {
        statusCode: status,
        description: "",
        confidence,
        content: [{ mediaType, ...(schema ? { schema } : {}) }],
      });
    }
  };

  const body = handler.body;
  if (body) {
    const visit = (node: any) => {
      // request.<member> access
      if (ts.isPropertyAccessExpression(node) && rootIdentifier(node) === reqName) {
        const full = node.getText(file);
        const member = node.name.text;
        const schema = typeAt(node);
        if (member === "query" && ts.isVariableDeclaration(node.parent) &&
            ts.isObjectBindingPattern(node.parent.name)) {
          for (const el of node.parent.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              queryFields.set(el.name.text, typeAt(el.name));
            }
          }
        } else if (full.startsWith(`${reqName}.query.`) && member !== "query") {
          queryFields.set(member, schema);
        } else if (full.startsWith(`${reqName}.params.`) && member !== "params") {
          addParam("path", member, schema, schema ? "high" : "low");
        } else if (full.startsWith(`${reqName}.headers.`) && member !== "headers") {
          headerFields.set(member.toLowerCase(), schema);
        } else if (full === `${reqName}.body`) {
          factsBody.referenced = true;
          const bodyType = typeAt(node);
          if (bodyType) factsBody.schema = bodyType;
          if (ts.isVariableDeclaration(node.parent) && ts.isObjectBindingPattern(node.parent.name)) {
            for (const el of node.parent.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                factsBody.fields.set(el.name.text, typeAt(el.name));
              }
            }
          }
        } else if (full.startsWith(`${reqName}.body.`) && member !== "body") {
          factsBody.referenced = true;
          factsBody.fields.set(member, schema);
        }
      }

      // request.headers['x'] / request.get('x')
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === reqName &&
        ["get", "header"].includes(node.expression.name.text) &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        headerFields.set(node.arguments[0].text.toLowerCase(), undefined);
      }

      // reply.code(201).send(payload) / reply.send(payload)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === replyName &&
        node.expression.name.text === "send"
      ) {
        let status = "200";
        // Chain form: reply.code(N).send(x)
        let cur: any = node.expression.expression;
        while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (cur.expression.name.text === "code") {
            const raw = cur.arguments[0]?.getText(file);
            if (raw && /^\d{3}$/.test(raw)) status = raw;
          }
          cur = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
        }
        const payload = node.arguments[0];
        if (payload) {
          recordResponse(status, typeAt(payload), "high");
        } else {
          recordResponse(status, undefined, "medium");
        }
      }

      // async return payload
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        handler.modifiers?.some?.((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        const schema = typeAt(node.expression);
        recordResponse("200", schema, schema ? "high" : "medium");
      }

      ts.forEachChild(node, visit);
    };
    visit(body);

    // Explicit async return type annotation.
    if (handler.type && ts.isTypeReferenceNode(handler.type)) {
      const typeNode = handler.type.typeName?.text === "Promise" && handler.type.typeArguments?.[0]
        ? handler.type.typeArguments[0]
        : handler.type;
      const schema = schemaOfTypeNode(typeNode);
      if (schema && responses.size === 0) {
        recordResponse("200", schema, "high");
      }
    }
  }

  for (const [name, schema] of queryFields) {
    addParam("query", name, schema, schema ? "high" : "low", false);
  }
  for (const [name, schema] of headerFields) {
    addParam("header", name, schema, schema ? "high" : "low", false);
  }
  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low");
    }
  }

  let requestBody: Facts["requestBody"];
  if (factsBody.schema) {
    requestBody = {
      required: true,
      content: [{ mediaType: "application/json", schema: factsBody.schema }],
      confidence: "high",
    };
  } else if (factsBody.referenced) {
    if (factsBody.fields.size) {
      const properties: Record<string, JsonSchema> = {};
      let incomplete = false;
      for (const [name, schema] of factsBody.fields) {
        if (!schema) incomplete = true;
        properties[name] = schema ?? {};
      }
      requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema: { type: "object", properties } }],
        confidence: "medium",
      };
      if (incomplete) gaps.add("body-schema-unknown");
    } else {
      gaps.add("body-schema-unknown");
    }
  }

  if (queryFields.size && [...queryFields.values()].some((s) => !s)) {
    gaps.add("query-unknown");
  }
  if (responses.size === 0) gaps.add("response-unknown");
  else if ([...responses.values()].some((r) => !r.content?.[0]?.schema)) {
    gaps.add("response-schema-unknown");
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: [...responses.values()],
    gaps: [...gaps],
    sse: false,
    bodyKnown: Boolean(requestBody),
  };
}

function mergeFacts(schema: Facts, inferred: Facts, pathParams: Set<string>): Facts {
  const parameters = [...schema.parameters];
  const byKey = new Map(parameters.map((p) => [`${p.in}:${p.name}`, p]));
  for (const p of inferred.parameters) {
    const key = `${p.in}:${p.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      parameters.push(p);
      byKey.set(key, p);
    } else if ((!existing.schema || !Object.keys(existing.schema).length) && p.schema) {
      existing.schema = p.schema;
    }
  }
  for (const name of pathParams) {
    const key = `path:${name}`;
    if (!byKey.has(key)) {
      const p: RouteParameter = {
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "low",
      };
      parameters.push(p);
      byKey.set(key, p);
    }
  }

  const requestBody = schema.requestBody ?? inferred.requestBody;
  // Explicit JSON Schema responses win; otherwise use handler inference.
  const responses = schema.responses.length ? schema.responses : inferred.responses;

  // Recompute gaps against the merged evidence instead of trusting either side.
  const gaps = new Set<GapCode>();
  if (!requestBody) {
    if (inferred.gaps.includes("body-unknown")) gaps.add("body-unknown");
    if (inferred.gaps.includes("body-schema-unknown")) gaps.add("body-schema-unknown");
  }
  if (responses.length === 0) {
    gaps.add("response-unknown");
  } else if (
    responses.some((r) => !r.content?.some((m) => m.schema || m.itemSchema))
  ) {
    gaps.add("response-schema-unknown");
  }
  if (
    parameters.some((p) => p.in === "query" && (!p.schema || !Object.keys(p.schema).length))
  ) {
    gaps.add("query-unknown");
  }
  for (const gap of inferred.gaps) {
    if (
      ["path-param-untyped", "header-unknown", "auth-unknown", "sse-events-unknown"].includes(gap)
    ) {
      gaps.add(gap);
    }
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    gaps: [...gaps],
    sse: false,
    bodyKnown: Boolean(requestBody),
  };
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

function dedupeServers(servers: DiscoveredServer[]): DiscoveredServer[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
