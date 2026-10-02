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
import {
  findExportedDeclaration,
  resolveHandler,
  resolveImportedFile,
} from "./express-handler.js";

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
  /** Route generic `app.get<{ Params; Querystring; Body; Headers }>`, when present. */
  genericNode: any | null;
  /** Full route options text, used for auth hint matching. */
  optionsText: string;
  handler: any | null;
  /** Name of a local handler factory call, e.g. `callback("google")`. */
  handlerFactoryName: string | null;
  origin: SourceLocation;
}

interface RegisterEdge {
  parent: string;
  /** Local plugin identifier, when the plugin is imported/defined by name. */
  pluginName: string | null;
  /** Factory call whose callee name returns a plugin (e.g. `routes(deps)`). */
  pluginCallName: string | null;
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
  /** Bindings imported from external packages (middleware plugins, etc.). */
  externalBindings: Set<string>;
  routes: RouteSite[];
  edges: RegisterEdge[];
  listenPorts: number[];
}

function joinPrefix(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  // OAS paths are absolute: a route mounted at the application root must be
  // "/", never an empty string (which would be rejected by the OAS validator).
  return joined ? `/${joined}` : "/";
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

      // Resolve a plugin export to its function node, following `export *`
      // barrels and `fastifyPlugin(fn)` wrapper calls.
      const resolveExport = (
        sf: any,
        exportName: string,
        seen: Set<string>,
      ): { file: any; node: any } | null => {
        const direct0 = findExportedDeclaration(analysis, sf, exportName, new Set());
        let direct = direct0;
        // `export default usersPlugin` resolves to the local binding name.
        if (direct && ts.isIdentifier(direct.node)) {
          const local = findExportedDeclaration(analysis, sf, direct.node.text, new Set());
          if (local) direct = local;
        }
        if (direct) return direct;
        if (seen.has(sf.fileName)) return null;
        seen.add(sf.fileName);

        // Unwrap a function node or a `fastifyPlugin(fn)` wrapper call.
        const unwrap = (node: any, ownerFile: any): { file: any; node: any } | null => {
          if (
            ts.isArrowFunction(node) ||
            ts.isFunctionExpression(node) ||
            ts.isFunctionDeclaration(node)
          ) {
            return { file: ownerFile, node };
          }
          if (ts.isCallExpression(node)) {
            const arg = node.arguments[0];
            if (
              arg &&
              (ts.isArrowFunction(arg) ||
                ts.isFunctionExpression(arg) ||
                ts.isFunctionDeclaration(arg))
            ) {
              return { file: ownerFile, node: arg };
            }
            if (arg && ts.isIdentifier(arg)) {
              // Fresh seen set: the owner file itself must remain searchable.
              const inner = findExportedDeclaration(analysis, ownerFile, arg.text, new Set());
              if (inner) return inner;
            }
          }
          return null;
        };

        // Raw binding with any initializer (e.g. wrapper calls).
        let raw: any = null;
        sf.forEachChild((child: any) => {
          if (raw) return;
          if (ts.isExportAssignment(child)) {
            if (
              ts.isArrowFunction(child.expression) ||
              ts.isFunctionExpression(child.expression)
            ) {
              raw = child.expression;
              return;
            }
            if (ts.isIdentifier(child.expression) && exportName === "default") {
              const local = findExportedDeclaration(analysis, sf, child.expression.text, new Set());
              if (local) raw = local.node;
            }
          }
          if (!ts.isVariableStatement(child)) return;
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === exportName &&
              decl.initializer
            ) {
              raw = decl.initializer;
            }
          }
        });
        if (raw) {
          const unwrapped = unwrap(raw, sf);
          if (unwrapped) return unwrapped;
        }

        // Follow named and wildcard re-exports.
        const candidates: { spec: string; orig: string }[] = [];
        sf.forEachChild((child: any) => {
          if (!ts.isExportDeclaration(child) || !child.moduleSpecifier) return;
          if (!ts.isStringLiteral(child.moduleSpecifier)) return;
          if (!child.exportClause) {
            candidates.push({ spec: child.moduleSpecifier.text, orig: exportName });
            return;
          }
          if (ts.isNamedExports(child.exportClause)) {
            for (const el of child.exportClause.elements) {
              const publicName = el.propertyName?.text ?? el.name.text;
              if (publicName === exportName) {
                candidates.push({ spec: child.moduleSpecifier.text, orig: el.name.text });
              }
            }
          }
        });
        for (const candidate of candidates) {
          const resolvedName = ts.resolveModuleName
            ? ts.resolveModuleName(
                candidate.spec,
                sf.fileName,
                analysis.program.getCompilerOptions(),
                ts.sys,
              )?.resolvedModule?.resolvedFileName
            : undefined;
          if (!resolvedName || !analysis.isProjectFile(resolvedName)) continue;
          const target = analysis.program.getSourceFile(resolvedName);
          if (!target) continue;
          const nested = resolveExport(target, candidate.orig, seen);
          if (nested) return nested;
        }
        return null;
      };

      const resolvedExport = resolveExport(imported.file, imported.exportName, new Set());
      const target = resolvedExport?.node;
      if (
        !target ||
        !(
          ts.isFunctionDeclaration(target) ||
          ts.isArrowFunction(target) ||
          ts.isFunctionExpression(target)
        )
      ) {
        return null;
      }
      const param = target.parameters?.[0]?.name?.getText?.(resolvedExport.file);
      return param
        ? { file: resolvedExport.file, node: target, instanceParam: param }
        : null;
    };

    // Locate a function-like binding by name in a model's file or an imported
    // module. Returns the raw function node (factory or plugin alike).
    const locateFunction = (
      model: FileModel,
      name: string,
    ): { file: any; node: any } | null => {
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
      if (local) return { file: model.source, node: local };

      if (!model.moduleBindings.has(name)) return null;
      const imported = resolveImportedFile(analysis, model.source, name);
      if (!imported) return null;
      const { file, exportName } = imported;
      let target: any = null;
      file.forEachChild((child: any) => {
        if (target) return;
        if (
          (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) &&
          (exportName === "default" || child.name?.text === exportName)
        ) {
          target = child;
        }
        if (ts.isVariableStatement(child)) {
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === exportName &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              target = decl.initializer;
            }
          }
        }
        if (ts.isExportAssignment(child)) {
          if (
            ts.isArrowFunction(child.expression) ||
            ts.isFunctionExpression(child.expression)
          ) {
            target = child.expression;
          } else if (ts.isIdentifier(child.expression)) {
            const ownerRel = relOfSource(file, models);
            const owner = ownerRel ? models.get(ownerRel) : undefined;
            const nested = owner ? locateFunction(owner, child.expression.text) : null;
            if (nested) target = nested.node;
          }
        }
      });
      return target ? { file, node: target } : null;
    };

    /**
     * Resolve a plugin factory call (`app.register(buildRoutes(deps))`): the
     * named function returns the plugin function/arrow; the plugin's first
     * parameter is the Fastify instance.
     */
    const resolveReturnedPlugin = (
      model: FileModel,
      name: string,
    ): { file: any; node: any; instanceParam: string } | null => {
      const factory = locateFunction(model, name);
      if (!factory) return null;
      const { file, node: factoryNode } = factory;
      let plugin: any = null;

      // Concise arrow whose body is the plugin itself: `(deps) => async (app) => {}`
      if (
        ts.isArrowFunction(factoryNode) &&
        factoryNode.body &&
        !ts.isBlock(factoryNode.body) &&
        (ts.isArrowFunction(factoryNode.body) || ts.isFunctionExpression(factoryNode.body))
      ) {
        plugin = factoryNode.body;
      } else if (factoryNode.body) {
        const visit = (n: any) => {
          if (plugin) return;
          if (
            ts.isReturnStatement(n) &&
            n.expression &&
            (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))
          ) {
            plugin = n.expression;
            return;
          }
          ts.forEachChild(n, visit);
        };
        visit(factoryNode.body);
      }
      if (!plugin) return null;
      const param = plugin.parameters?.[0]?.name?.getText?.(file);
      return param ? { file, node: plugin, instanceParam: param } : null;
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

      // Resolve a handler factory declared inside this scope, e.g.
      // `const callback = (provider) => async (request, reply) => {...}`.
      const resolveLocalHandlerFactory = (name: string): any | null => {
        let factory: any = null;
        const findDecl = (n: any) => {
          if (factory) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === name &&
            n.initializer &&
            (ts.isArrowFunction(n.initializer) ||
              ts.isFunctionExpression(n.initializer) ||
              ts.isFunctionDeclaration(n.initializer))
          ) {
            factory = n.initializer;
          }
          if (ts.isFunctionDeclaration(n) && n.name?.text === name) factory = n;
          ts.forEachChild(n, findDecl);
        };
        findDecl(scopeNode);
        if (!factory) return null;
        if (
          ts.isArrowFunction(factory) &&
          factory.body &&
          !ts.isBlock(factory.body) &&
          (ts.isArrowFunction(factory.body) || ts.isFunctionExpression(factory.body))
        ) {
          return factory.body;
        }
        let inner: any = null;
        const findReturn = (n: any) => {
          if (inner) return;
          if (
            ts.isReturnStatement(n) &&
            n.expression &&
            (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))
          ) {
            inner = n.expression;
            return;
          }
          ts.forEachChild(n, findReturn);
        };
        if (factory.body) findReturn(factory.body);
        return inner;
      };

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

        const schemaLiteral = resolveSchemaLiteral(ts, model, site.schemaNode);
        const schemaFacts = extractRouteSchema(ts, analysis, schemaLiteral);
        let resolvedHandler: any = site.handler;
        let handlerFile: any = model.source;
        // Resolve imported handlers (`listProjects`) and namespaced handlers
        // (`controllers.login`) to their declared function before analysis.
        if (
          resolvedHandler &&
          (ts.isIdentifier(resolvedHandler) ||
            ts.isPropertyAccessExpression(resolvedHandler))
        ) {
          const resolved = resolveHandler(analysis, model.source, resolvedHandler, new Set());
          if (resolved) {
            resolvedHandler = resolved.node;
            handlerFile = resolved.file;
          }
        }
        if (!resolvedHandler && site.handlerFactoryName) {
          resolvedHandler = resolveLocalHandlerFactory(site.handlerFactoryName);
        }
        const handlerFacts = resolvedHandler
          ? analyzeFastifyHandler(analysis, handlerFile, resolvedHandler, site.origin, pathParams, site.genericNode)
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
          handlerSource: sliceNode(ts, handlerFile, resolvedHandler),
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
          if (model.externalBindings.has(edge.pluginName)) {
            // Third-party middleware plugin (helmet, cors, ...): no routes.
            continue;
          }
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
        } else if (edge.pluginCallName) {
          if (model.externalBindings.has(edge.pluginCallName)) continue;
          const returned = resolveReturnedPlugin(model, edge.pluginCallName);
          if (returned) {
            const childRel = relOfSource(returned.file, models);
            const childModel = childRel ? models.get(childRel) : undefined;
            if (childModel) {
              processScope(childModel, returned.node.body ?? returned.node, returned.instanceParam, childPrefix, depth + 1);
            }
          } else {
            unresolved.push({
              reason: "handler-unresolved",
              message: `Fastify plugin factory "${edge.pluginCallName}()" could not be resolved`,
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
    externalBindings: new Set(),
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
      } else if (!specifier.startsWith(".") && child.importClause) {
        // External package (e.g. @fastify/helmet): middleware plugins carry
        // no project routes, so they are never reported as unresolved.
        if (child.importClause.name) {
          model.externalBindings.add(child.importClause.name.text);
        }
        const named = child.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            model.externalBindings.add(element.name.text);
          }
        }
      }
    }
  });

  // Root instances: const app = fastify(...), plus class services that own the
  // server through a property assignment (`this.server = fastify(...)` inside a
  // constructor or field initializer).
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
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isCallExpression(node.right) &&
      ts.isIdentifier(node.right.expression) &&
      model.factoryBindings.has(node.right.expression.text)
    ) {
      model.roots.add(node.left.getText(source));
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

      let matchReceiver = false;
      if (ts.isIdentifier(receiver) && receiver.text === instanceName) {
        matchReceiver = true;
      } else if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.getText(model.source) === instanceName
      ) {
        // Class-owned root instance, e.g. `this.server.register(...)`.
        matchReceiver = true;
      }
      if (matchReceiver) {
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
            edges.push({ parent: instanceName, pluginName: null, pluginCallName: null, inlineNode: target, prefix: pluginPrefix });
          } else if (target && ts.isIdentifier(target)) {
            edges.push({ parent: instanceName, pluginName: target.text, pluginCallName: null, inlineNode: null, prefix: pluginPrefix });
          } else if (
            target &&
            ts.isCallExpression(target) &&
            ts.isIdentifier(target.expression)
          ) {
            // Factory call: `app.register(buildRoutes({ pool }))` — the callee
            // is a local/imported function that returns the plugin function.
            edges.push({ parent: instanceName, pluginName: null, pluginCallName: target.expression.text, inlineNode: null, prefix: pluginPrefix });
          }
        }

        if (HTTP_METHODS.has(method)) {
          const urlArg = node.arguments[0];
          const url = urlArg && ts.isStringLiteralLike(urlArg) ? urlArg.text : null;
          if (url !== null) {
            const fnArgs = [...node.arguments].slice(1);
            const options = fnArgs.find((a: any) => ts.isObjectLiteralExpression(a)) ?? null;
            // The handler is the last function-like argument after dropping
            // the optional options object: an inline function, an identifier
            // (imported handler), or a factory call such as `callback("google")`.
            const handlerArgs = fnArgs.filter((a: any) => a !== options);
            const lastArg = handlerArgs[handlerArgs.length - 1] ?? null;
            let handler: any = null;
            let handlerFactoryName: string | null = null;
            if (
              lastArg &&
              (ts.isArrowFunction(lastArg) ||
                ts.isFunctionExpression(lastArg) ||
                ts.isIdentifier(lastArg) ||
                ts.isPropertyAccessExpression(lastArg))
            ) {
              handler = lastArg;
            } else if (
              lastArg &&
              ts.isCallExpression(lastArg) &&
              ts.isIdentifier(lastArg.expression)
            ) {
              handlerFactoryName = lastArg.expression.text;
            }
            routes.push({
              instance: instanceName,
              method,
              url,
              schemaNode: options ? getObjectProperty(ts, options, "schema") : null,
              genericNode: node.typeArguments?.[0] ?? null,
              optionsText: options ? options.getText(model.source) : "",
              handler,
              handlerFactoryName,
              origin,
            });
          }
        }

        if (method === "route" && ts.isObjectLiteralExpression(node.arguments[0])) {
          const obj = node.arguments[0];
          const get = (key: string) =>
            obj.properties.find(
              (p: any) => {
                const name = p.name?.getText?.(model.source)?.replace(/['"]/g, "");
                if (name !== key) return false;
                return ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p);
              },
            ) ?? null;
          const propOf = (p: any) =>
            !p
              ? null
              : ts.isPropertyAssignment(p)
                ? p.initializer
                : ts.isShorthandPropertyAssignment(p)
                  ? p.name
                  : null;
          const methodNode = propOf(get("method"));
          const urlNode = propOf(get("url")) ?? propOf(get("path"));
          const schemaNode = propOf(get("schema"));
          const handlerNode = propOf(get("handler"));
          const methodText = methodNode
            ? String(literalValue(ts, methodNode) ?? methodNode.getText(model.source)).toLowerCase()
            : null;
          const urlText = urlNode ? literalValue(ts, urlNode) : null;
          if (methodText && HTTP_METHODS.has(methodText) && typeof urlText === "string") {
            routes.push({
              instance: instanceName,
              method: methodText,
              url: urlText,
              schemaNode,
              genericNode: null,
              optionsText: obj.getText(model.source),
              handler: handlerNode,
              handlerFactoryName: null,
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
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name?.getText?.().replace(/^['"]|['"]$/g, "") === key,
  );
  if (!prop) return null;
  // Shorthand `{ schema }` resolves to the identifier itself so callers can
  // follow it to the enclosing const declaration.
  return ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
}

/**
 * Follows a schema reference (`schema` identifier or shorthand binding) to the
 * object literal it aliases within the same file. Fastify projects commonly
 * declare route schemas as top-level consts and reference them by name.
 */
function resolveSchemaLiteral(ts: any, model: FileModel, node: any): any | null {
  if (!node) return null;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return null;
  let found: any = null;
  const visit = (n: any) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === node.text &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  };
  model.source.forEachChild((child: any) => visit(child));
  return found;
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
  routeGenericNode: any | null = null,
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
  // The same RouteGeneric shape can also sit on the call site:
  // `app.get<{ Params: T; Body: T }>(url, handler)`.
  const applyGenericShape = (shape: any) => {
    if (!shape || !ts.isTypeLiteralNode(shape)) return;
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
  };

  const reqType = handler.parameters?.[0]?.type;
  if (reqType && ts.isTypeReferenceNode(reqType) && reqType.typeArguments?.length) {
    applyGenericShape(reqType.typeArguments[0]);
  }
  if (routeGenericNode && ts.isTypeLiteralNode(routeGenericNode)) {
    applyGenericShape(routeGenericNode);
  } else if (
    routeGenericNode &&
    ts.isTypeReferenceNode(routeGenericNode) &&
    routeGenericNode.typeArguments?.length
  ) {
    applyGenericShape(routeGenericNode.typeArguments[0]);
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

  const recordResponse = (
    status: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    mediaType = "application/json",
    noContent = false,
  ) => {
    const key = noContent ? `${status}:` : `${status}:${mediaType}`;
    const existing = responses.get(key);
    if (existing?.content?.[0]) {
      if (schema && (!existing.content[0].schema || confidence === "high")) {
        existing.content[0].schema = schema;
      }
      if (confidence === "high") existing.confidence = "high";
    } else if (existing && noContent) {
      existing.confidence = confidence;
    } else {
      responses.set(key, {
        statusCode: status,
        description: "",
        confidence,
        content: noContent ? [] : [{ mediaType, ...(schema ? { schema } : {}) }],
      });
    }
  };

  const body = handler.body;
  if (body) {
    const helperSeen = new Set<string>();

    // Lexical lookup of a function declared in an enclosing block/module,
    // mirroring JS scope resolution for sibling helpers inside a plugin.
    const resolveLexicalFunction = (
      name: string,
      startNode: any,
    ): { node: any; file: any } | null => {
      const matchIn = (container: any): { node: any; file: any } | null => {
        const statements = container?.statements;
        if (!Array.isArray(statements)) return null;
        for (const stmt of statements) {
          if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
            return { node: stmt, file };
          }
          if (
            ts.isVariableStatement(stmt) &&
            stmt.declarationList.declarations.some(
              (d: any) =>
                ts.isIdentifier(d.name) &&
                d.name.text === name &&
                d.initializer &&
                (ts.isArrowFunction(d.initializer) ||
                  ts.isFunctionExpression(d.initializer)),
            )
          ) {
            const decl = stmt.declarationList.declarations.find(
              (d: any) => ts.isIdentifier(d.name) && d.name.text === name,
            );
            return { node: decl.initializer, file };
          }
        }
        return null;
      };

      // Helpers declared inside the handler's own body block.
      if (startNode?.body && ts.isBlock(startNode.body)) {
        const own = matchIn(startNode.body);
        if (own) return own;
      }
      let scope: any = startNode;
      while (scope && scope !== file) {
        const container = scope.parent;
        const found = matchIn(container);
        if (found) return found;
        scope = container;
      }
      return null;
    };

    const visit = (node: any, roots: { req: string; reply: string }, helperDepth: number) => {
      // request.<member> access
      if (ts.isPropertyAccessExpression(node) && rootIdentifier(node) === roots.req) {
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
        } else if (full.startsWith(`${roots.req}.query.`) && member !== "query") {
          queryFields.set(member, schema);
        } else if (full.startsWith(`${roots.req}.params.`) && member !== "params") {
          addParam("path", member, schema, schema ? "high" : "low");
        } else if (full.startsWith(`${roots.req}.headers.`) && member !== "headers") {
          headerFields.set(member.toLowerCase(), schema);
        } else if (full === `${roots.req}.body`) {
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
        } else if (full.startsWith(`${roots.req}.body.`) && member !== "body") {
          factsBody.referenced = true;
          factsBody.fields.set(member, schema);
        }
      }

      // request.headers['x'] / request.get('x')
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.req &&
        ["get", "header"].includes(node.expression.name.text) &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        headerFields.set(node.arguments[0].text.toLowerCase(), undefined);
      }

      // reply.code(201).type(media).send(payload) / reply.send(payload)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.reply &&
        node.expression.name.text === "send"
      ) {
        let status = "200";
        let mediaType = "application/json";
        // Walk the chain: reply.code(N).type("...").send(x)
        let cur: any = node.expression.expression;
        while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (cur.expression.name.text === "code") {
            const raw = cur.arguments[0]?.getText(file);
            if (raw && /^\d{3}$/.test(raw)) status = raw;
          } else if (cur.expression.name.text === "type" && ts.isStringLiteralLike(cur.arguments[0])) {
            mediaType = cur.arguments[0].text;
          } else if (cur.expression.name.text === "header" && ts.isStringLiteralLike(cur.arguments[0])) {
            const headerName = cur.arguments[0].text.toLowerCase();
            if (headerName === "content-type" && ts.isStringLiteralLike(cur.arguments[1])) {
              mediaType = cur.arguments[1].text;
            }
          }
          cur = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
        }
        const payload = node.arguments[0];
        if (payload) {
          recordResponse(status, typeAt(payload), "high", mediaType);
        } else {
          recordResponse(status, undefined, "medium", mediaType);
        }
      }

      // reply.redirect([code,] url)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.reply &&
        node.expression.name.text === "redirect"
      ) {
        let status = "302";
        if (ts.isNumericLiteral(node.arguments[0])) status = node.arguments[0].text;
        let cur: any = node.expression.expression;
        while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (cur.expression.name.text === "code" && ts.isNumericLiteral(cur.arguments[0])) {
            status = cur.arguments[0].text;
          }
          cur = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
        }
        recordResponse(status, undefined, "high", "text/html", true);
      }

      // async return payload (handler body only; helper returns are not responses)
      if (
        helperDepth === 0 &&
        ts.isReturnStatement(node) &&
        node.expression &&
        handler.modifiers?.some?.((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        // `return reply.redirect()/send()/...` is a reply action, not a body.
        const rootedAtReply =
          ts.isCallExpression(node.expression) &&
          rootIdentifier(node.expression.expression) === roots.reply;
        // A closure helper declared inside the handler performs reply
        // actions on its own; an untyped call to it is not a body.
        const untypedClosureCall =
          ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          !typeAt(node.expression) &&
          (() => {
            const lexical = resolveLexicalFunction(
              node.expression!.expression.text,
              handler,
            );
            const b = handler.body;
            return (
              lexical &&
              b &&
              lexical.node.pos >= b.pos &&
              lexical.node.end <= b.end
            );
          })();
        if (!rootedAtReply && !untypedClosureCall) {
          const schema = typeAt(node.expression);
          recordResponse("200", schema, schema ? "high" : "medium");
        }
      }

      // Descend into local/imported helpers that receive request or reply,
      // e.g. `await serveOas(token, request, reply)` (bounded, cycle-guarded).
      if (
        helperDepth < 2 &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const calleeName = node.expression.text;
        const lexical = resolveLexicalFunction(calleeName, handler);
        const resolved = lexical ?? resolveHandler(analysis, file, node.expression);
        const fnNode = resolved?.node;
        const fnFile = resolved?.file ?? file;
        if (fnNode?.parameters && fnNode.body) {
          const nextRoots = { ...roots };
          let mapped = false;
          fnNode.parameters.forEach((param: any, i: number) => {
            const arg = node.arguments[i];
            const paramName = param.name?.getText?.(fnFile);
            if (!paramName || !arg || !ts.isIdentifier(arg)) return;
            if (arg.text === roots.req) {
              nextRoots.req = paramName;
              mapped = true;
            } else if (arg.text === roots.reply) {
              nextRoots.reply = paramName;
              mapped = true;
            }
          });
          // A helper declared inside the handler body closes over req/reply.
          const handlerBody = handler.body;
          const isClosure =
            !mapped &&
            lexical &&
            handlerBody &&
            fnNode.pos >= handlerBody.pos &&
            fnNode.end <= handlerBody.end;
          if (isClosure) mapped = true;
          const key = `${fnFile.fileName}:${fnNode.pos ?? 0}:${nextRoots.req}:${nextRoots.reply}`;
          if (mapped && !helperSeen.has(key)) {
            helperSeen.add(key);
            visit(fnNode.body, nextRoots, helperDepth + 1);
          }
        }
      }

      ts.forEachChild(node, (child: any) => visit(child, roots, helperDepth));
    };
    visit(body, { req: reqName, reply: replyName }, 0);

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

  // Concise arrow with an expression body: implicit return value.
  if (
    ts.isArrowFunction(handler) &&
    handler.body &&
    !ts.isBlock(handler.body)
  ) {
    const schema = typeAt(handler.body);
    recordResponse("200", schema, schema ? "high" : "medium");
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
  else if (
    [...responses.values()].some(
      (r) =>
        !/^(204|3\d\d)$/.test(r.statusCode) &&
        !r.content?.some((m) => m.schema || m.itemSchema),
    )
  ) {
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
    responses.some(
      (r) =>
        !/^(204|3\d\d)$/.test(r.statusCode) &&
        !r.content?.some((m) => m.schema || m.itemSchema),
    )
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
