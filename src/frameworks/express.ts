import type {
  Confidence,
  DiscoveredSecurityScheme,
  DiscoveredServer,
  DiscoveredUnresolved,
  ExtractionResult,
  FileIndex,
  FrameworkPack,
  JsonSchema,
  RouteCandidate,
  RouteParameter,
  ScanContext,
  SourceLocation,
} from "../core/types.js";
import type { TsAnalysis } from "../lang/typescript/index.js";
import { analyzeHandler, resolveHandler, resolveImportedFile, extractCustomResponseMethods } from "./express-handler.js";
import { convertValidatorChain, type ValidatedField } from "../lang/typescript/validate.js";
import { resolveStaticValue } from "../lang/typescript/staticValue.js";
import { convertJoiNode, isJoiSchema } from "../lang/typescript/joi.js";

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

const AUTH_PATTERN =
  /(^auth$|^authenticate|authorization|^jwt|bearer|^protect|guard|requireauth|isauth|ensureauth|authmiddleware|withauth)/i;

interface RouterVar {
  id: string;
  file: string;
  name: string;
  kind: "app" | "router";
}

interface MountEdge {
  parent: string;
  child: string;
  prefix: string;
  /** Path-scoped middleware on this mount (X.use(prefix, mw)). */
  middleware: MiddlewareRef[];
  /** The argument originally believed to be a router; retained so a mount that
   * resolves to no router can reclaim it as plain middleware/error handler. */
  routerArgNode?: any;
}

interface MiddlewareRef {
  routerId?: string;
  node: any;
  file: string;
  scopePath?: string;
  /** Source position of the use() registration, for handler ordering. */
  pos?: number;
}

interface RouteCall {
  routerId: string;
  file: string;
  method: string;
  rawPath: string;
  optionalParams: Set<string>;
  handlers: Array<{ node: any; file: string }>;
  middleware: MiddlewareRef[];
  origin: SourceLocation;
  /** Source position of the route registration call, for handler ordering. */
  pos: number;
}

interface FileModel {
  rel: string;
  source: any;
  /** local binding name -> express kind marker */
  expressBindings: Map<string, "default" | "Router">;
  /** local binding -> required/imported module specifier */
  moduleBindings: Map<string, { specifier: string; exportName: string }>;
  routers: Map<string, RouterVar>;
  /** Anonymous routers for chained `Router().use(a).use(b)` calls, keyed by the
   *  base Router() call's start position. */
  anonymousRouters: Map<number, RouterVar>;
  mounts: MountEdge[];
  unscopedMiddleware: MiddlewareRef[];
  scopedMiddleware: Array<MiddlewareRef & { scopePath: string }>;
  /** Four-argument error handlers `(err, req, res, next)` registered via use(). */
  errorHandlers: Array<MiddlewareRef & { routerId: string; pos: number }>;
  routes: RouteCall[];
  unresolved: DiscoveredUnresolved[];
  listenPorts: number[];
  /**
   * A default-exported router factory `module.exports = (app) => {...}` whose
   * injected parameter is modelled as a synthetic router, so routes/mounts
   * declared on the parameter are collected and later grafted onto the real
   * app/router passed by the caller (`require(factory)(app)`).
   */
  factoryApp?: { paramName: string; id: string };
}

function normalizeExpressPath(
  raw: string,
): { path: string; optional: Set<string>; dynamic: boolean } {
  const optional = new Set<string>();
  let dynamic = false;
  // Express 4 wildcard and regex routes cannot be represented statically.
  if (raw.includes("(.*)") || /[\^$]|\\[dsw]|\\\./.test(raw)) dynamic = true;

  const converted = raw
    .replace(/:([A-Za-z0-9_]+)\(([^)]*)\)/g, (_m, name) => `{${name}}`)
    .replace(/:([A-Za-z0-9_]+)\?/g, (_m, name) => {
      optional.add(name);
      return `{${name}}`;
    })
    .replace(/:([A-Za-z0-9_]+)/g, "{**$1}")
    .replace(/\{\*\*([A-Za-z0-9_]+)\}/g, "{$1}")
    .replace(/\*([A-Za-z0-9_]*)/g, (_m, name) => `{${name || "wildcard"}}`);

  return { path: converted, optional, dynamic };
}

function joinPrefix(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

function operationId(method: string, fullPath: string): string {
  const segments = fullPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ""))
    .map((segment) => segment.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const head = method.toLowerCase();
  const tail = segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${head}${tail}` || `${head}Root`;
}

function tagForPath(fullPath: string, file: string): string[] {
  const segment = fullPath.split("/").filter(Boolean)[0];
  if (segment && !segment.startsWith("{")) return [segment];
  const base = file.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "default";
  return [base === "index" ? "default" : base];
}

export const expressPack: FrameworkPack<TsAnalysis> = {
  id: "express",
  language: "typescript",
  dependencyHints: ["express", "@types/express"],

  applies(ctx) {
    // NestJS uses Express (or Fastify) only as its transport; the Nest pack is
    // authoritative, so do not treat raw Express usage as a standalone app.
    if (
      ctx.manifest.packages.has("@nestjs/common") ||
      ctx.manifest.packages.has("@nestjs/core")
    ) {
      return false;
    }
    return (
      ctx.manifest.packages.has("express") ||
      ctx.index.files.some((f) =>
        /require\(["']express["']\)|from ["']express["']/.test(f.content),
      )
    );
  },

  extract(analysis, ctx) {
    const { ts } = analysis;
    const models = new Map<string, FileModel>();

    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, ctx.index, rel, source));
    }

    // Project-wide map of monkey-patched Express Response methods (e.g.
    // response.customSuccess = ...) so handlers can expand them.
    const customResponseMethods = extractCustomResponseMethods(analysis);

    // Resolve cross-file mounts and build the router graph.
    const allRouters = new Map<string, RouterVar>();
    const edges: MountEdge[] = [];
    const routes: RouteCall[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const listenPorts: number[] = [];

    for (const model of models.values()) {
      for (const router of model.routers.values()) allRouters.set(router.id, router);
      for (const router of model.anonymousRouters.values()) allRouters.set(router.id, router);
      routes.push(...model.routes);
      unresolved.push(...model.unresolved);
      listenPorts.push(...model.listenPorts);
    }

    for (const model of models.values()) {
      for (const mount of model.mounts) {
        const resolved = resolveMountTarget(analysis, model, mount, models);
        if (resolved) {
          edges.push({ ...mount, child: resolved });
          continue;
        }
        // The optimistic "router" argument resolves to no router. It is a plain
        // function (middleware or four-arg error handler) obtained via import
        // or require; reclaim it and sibling args as ordinary use() middleware
        // so it is analyzed instead of being silently dropped.
        const reclaimed: any[] = [];
        if (mount.routerArgNode) reclaimed.push(mount.routerArgNode);
        for (const sibling of mount.middleware) reclaimed.push(sibling.node);
        for (const node of reclaimed) {
          const ref: MiddlewareRef = {
            routerId: mount.parent,
            node,
            file: model.rel,
            scopePath: mount.prefix || undefined,
            pos: node.pos,
          };
          if (mount.prefix) model.scopedMiddleware.push({ ...ref, scopePath: mount.prefix });
          else model.unscopedMiddleware.push(ref);
        }
      }
    }

    // Identify four-argument error handlers after every model (and its import
    // bindings) is built, so handlers required/imported from other files resolve.
    for (const model of models.values()) {
      const seen = new Set<string>();
      for (const ref of [...model.unscopedMiddleware, ...model.scopedMiddleware]) {
        if (!ref.routerId || !isFourArgHandler(analysis, model, ref.node)) continue;
        const key = `${ref.routerId}:${ref.pos ?? 0}:${ref.scopePath ?? ""}:${ref.node.pos ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        model.errorHandlers.push({
          node: ref.node,
          file: ref.file,
          routerId: ref.routerId,
          ...(ref.scopePath ? { scopePath: ref.scopePath } : {}),
          pos: ref.pos ?? 0,
        });
      }
    }

    // Graft default-exported router factories (module.exports = app => ...) onto
    // the concrete router passed at `require(factory)(app)` call sites.
    linkFactoryApps(analysis, models, edges);

    // DFS from app roots, carrying mount prefixes and middleware.
    const roots = [...allRouters.values()].filter((r) => r.kind === "app");
    const prefixes = new Map<string, Array<{ prefix: string; middleware: MiddlewareRef[] }>>();
    const unscopedOf = (id: string): MiddlewareRef[] => {
      const router = allRouters.get(id);
      if (!router) return [];
      return models.get(router.file)?.unscopedMiddleware.filter(mw => mw.routerId === id) ?? [];
    };
    for (const root of roots) {
      walkMounts(root.id, "", unscopedOf(root.id), edges, prefixes, new Set(), unscopedOf);
    }

    const candidates: RouteCandidate[] = [];
    let bearerAuth = false;
    const appIds = new Set<string>();
    for (const m of models.values()) {
      for (const rv of m.routers.values()) {
        if (rv.kind === "app") appIds.add(rv.id);
      }
    }

    for (const route of routes) {
      const mounts = prefixes.get(route.routerId) ??
        (allRouters.get(route.routerId)?.kind === "app"
          ? [{ prefix: "", middleware: [] }]
          : []);

      if (mounts.length === 0) {
        // Reported once per unmounted router below; individual routes are
        // skipped silently to avoid duplicate noise.
        continue;
      }

      const model = models.get(route.file)!;
      const finalHandler = route.handlers[route.handlers.length - 1];

      for (const mount of mounts) {
        const fullPath = joinPrefix(mount.prefix, route.rawPath);
        const pathParams = new Set(
          [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
        );

        // Validator chains and auth middleware from the route call and mounts.
        const validators: ValidatedField[] = [];
        const schemaOverrides: { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema } = {};
        let authed = false;
        const scoped = model.scopedMiddleware.filter(
          (mw) =>
            mw.routerId === route.routerId && (mw.scopePath === "/" || route.rawPath === mw.scopePath ||
            route.rawPath.startsWith(`${mw.scopePath}/`) ||
            route.rawPath.startsWith(`${mw.scopePath}?`)),
        );
        const allMiddleware = [
          ...mount.middleware,
          ...scoped,
          ...route.middleware,
          ...route.handlers.slice(0, -1).map((h) => ({ node: h.node, file: h.file })),
        ].filter((mw: MiddlewareRef) => !mw.routerId || mw.routerId !== route.routerId ||
          mw.file !== route.file || !finalHandler || mw.node.pos < finalHandler.node.pos);
        for (const mw of allMiddleware) {
          if (isAuthMiddleware(ts, mw.node, mw.file)) authed = true;
          const chains = collectValidatorChains(ts, mw.node, mw.file);
          validators.push(...chains);
          mergeSchemaOverrides(schemaOverrides, collectSchemaOverrides(analysis, mw.node));
        }
        if (authed) bearerAuth = true;

        const analysisResult = resolveAndAnalyze(
          analysis,
          model,
          finalHandler,
          route.origin,
          pathParams,
          validators,
          unresolved,
          customResponseMethods,
          schemaOverrides,
        );
        const facts = analysisResult.facts;
        // Inspect proven ordinary middleware bodies for explicit responses. Do not
        // treat four-argument error handlers as (req,res,next) middleware.
        for (const middleware of allMiddleware) {
          const file = analysis.sourceByPath.get(middleware.file) ?? model.source;
          const resolved = resolveHandler(analysis, file, middleware.node);
          if (!resolved || resolved.node.parameters?.length !== 3) continue;
          const middlewareFacts = analyzeHandler(analysis, resolved.file, resolved.node, route.origin, {
            pathParams, validators: [], customResponseMethods,
          });
          for (const response of middlewareFacts.responses) {
            // Unknown/default fallback inference is not evidence of a middleware response.
            if (!response.content?.length || response.confidence === "low") continue;
            const previous = facts.responses.find(r => r.statusCode === response.statusCode);
            if (!previous) { facts.responses.push(response); continue; }
            for (const media of response.content) {
              const existing = previous.content?.find(c => c.mediaType === media.mediaType);
              if (!existing) { (previous.content ??= []).push(media); continue; }
              if (existing.schema && media.schema && JSON.stringify(existing.schema) !== JSON.stringify(media.schema)) {
                existing.schema = {anyOf: [existing.schema, media.schema]};
              }
            }
          }
        }

        // Four-argument error handlers registered after the route (same
        // router) or as global app-level fallbacks. Their written responses are
        // real error contracts (throw / next(err) reaches them at runtime).
        for (const resolved of collectErrorHandlers(analysis, models, route, fullPath, appIds)) {
          const ehFacts = analyzeHandler(analysis, resolved.file, resolved.node, route.origin, {
            pathParams, validators: [], customResponseMethods, errorHandler: true,
          });
          for (const response of ehFacts.responses) {
            if (!response.content?.length || response.confidence === "low") continue;
            if (!/^([45]\d\d|default)$/.test(response.statusCode)) continue;
            const previous = facts.responses.find((r) => r.statusCode === response.statusCode);
            if (!previous) { facts.responses.push(response); continue; }
            for (const media of response.content) {
              const existing = previous.content?.find((c) => c.mediaType === media.mediaType);
              if (!existing) { (previous.content ??= []).push(media); continue; }
              if (existing.schema && media.schema && JSON.stringify(existing.schema) !== JSON.stringify(media.schema)) {
                existing.schema = { anyOf: [existing.schema, media.schema] };
              }
            }
          }
        }

        const method = route.method === "all" ? "get" : route.method;
        const parameters: RouteParameter[] = facts.parameters.map((p) =>
          route.optionalParams.has(p.name) && p.in === "path"
            ? { ...p, required: false }
            : p,
        );

        const confidence: Confidence = facts.gaps.length
          ? facts.gaps.some((g) =>
              ["response-unknown", "body-unknown", "body-schema-unknown"].includes(g),
            )
            ? "low"
            : "medium"
          : "high";

        const candidate: RouteCandidate = {
          method,
          path: route.rawPath,
          fullPath,
          origin: route.origin,
          parameters,
          ...(facts.requestBody
            ? { requestBody: facts.requestBody }
            : {}),
          responses: facts.responses,
          tags: tagForPath(fullPath, route.file),
          ...(authed ? { security: [{ bearerAuth: [] }] } : {}),
          ...(facts.sse
            ? { extensions: { "x-protocol": "sse" } }
            : {}),
          confidence: facts.sse && facts.gaps.includes("sse-events-unknown")
            ? "medium"
            : confidence,
          gaps: facts.gaps,
          components: [],
          handlerSource: analysisResult.handlerSource,
        };
        candidates.push(candidate);
      }
    }

    // Routers that never attach to an app.
    for (const router of allRouters.values()) {
      if (router.kind === "router" && !prefixes.has(router.id)) {
        unresolved.push({
          reason: "unreachable-router",
          message: `Exported router "${router.name}" in ${router.file} is not mounted on a listening app`,
          origin: { file: router.file },
        });
      }
    }

    const components = [...analysis.schemaContext.components.entries()].map(
      ([name, schema]) => ({ name, schema }),
    );

    const securitySchemes: DiscoveredSecurityScheme[] = bearerAuth
      ? [{ name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } }]
      : [];

    const servers: DiscoveredServer[] = [];
    const port = [...new Set(listenPorts)][0];
    if (port) servers.push({ url: `http://localhost:${port}` });

    return {
      routes: dedupeRoutes(candidates, unresolved),
      unresolved,
      components,
      securitySchemes,
      servers,
    };
  },
};

function relId(file: string, name: string): string {
  return `${file}::${name}`;
}

function modelFile(
  analysis: TsAnalysis,
  index: FileIndex,
  rel: string,
  source: any,
): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    expressBindings: new Map(),
    moduleBindings: new Map(),
    routers: new Map(),
    anonymousRouters: new Map(),
    mounts: [],
    unscopedMiddleware: [],
    scopedMiddleware: [],
    errorHandlers: [],
    routes: [],
    unresolved: [],
    listenPorts: [],
  };

  // Imports / requires.
  source.forEachChild((child: any) => {
    if (ts.isImportDeclaration(child) && ts.isStringLiteral(child.moduleSpecifier)) {
      const specifier = child.moduleSpecifier.text;
      if (specifier === "express") {
        if (child.importClause?.name) {
          model.expressBindings.set(child.importClause.name.text, "default");
        }
        const named = child.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.propertyName?.text === "Router" || element.name.text === "Router") {
              model.expressBindings.set(element.name.text, "Router");
            }
          }
        }
      } else if (specifier.startsWith(".")) {
        if (child.importClause?.name) {
          model.moduleBindings.set(child.importClause.name.text, {
            specifier,
            exportName: "default",
          });
        }
        const named = child.importClause?.namedBindings;
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

  const visit = (node: any) => {
    // Default-exported router factory: `module.exports = (app) => {...}` or
    // `export default function (app) {...}`. The injected parameter is an
    // externally supplied app/router; model it as a synthetic router so the
    // .use()/.get() calls inside the body are collected and can later be
    // grafted onto the concrete argument at the call site.
    const factoryParam = injectedAppParam(ts, node, source);
    if (factoryParam && !model.routers.has(factoryParam)) {
      const id = relId(rel, "__factoryApp__");
      model.routers.set(factoryParam, { id, file: rel, name: factoryParam, kind: "router" });
      model.factoryApp = { paramName: factoryParam, id };
    }

    // const express = require('express') (CommonJS): bind the local name to the
    // express default export so `express()` below registers the app.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      ts.isStringLiteral(node.initializer.arguments?.[0])
    ) {
      const specifier = node.initializer.arguments[0].text;
      if (specifier === "express" && ts.isIdentifier(node.name)) {
        model.expressBindings.set(node.name.text, "default");
      } else if (
        (specifier === "express/router" || specifier.endsWith("/router")) &&
        ts.isIdentifier(node.name)
      ) {
        model.expressBindings.set(node.name.text, "Router");
      } else if (specifier.startsWith(".") && ts.isIdentifier(node.name)) {
        model.moduleBindings.set(node.name.text, { specifier, exportName: "module" });
      }
      // const { Router } = require('express')
      if (specifier === "express" && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (ts.isBindingElement(el) && el.name?.getText?.(source) === "Router") {
            model.expressBindings.set(el.name.text, "Router");
          }
        }
      }
    }

    // const app = express() / const r = express.Router() / Router()
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      const callee = node.initializer.expression;
      const name = node.name.text;
      if (
        ts.isIdentifier(callee) &&
        model.expressBindings.get(callee.text) === "default"
      ) {
        model.routers.set(name, {
          id: relId(rel, name),
          file: rel,
          name,
          kind: "app",
        });
      } else if (isRouterFactory(ts, callee, model)) {
        model.routers.set(name, {
          id: relId(rel, name),
          file: rel,
          name,
          kind: "router",
        });
      } else if (isRequireExpressRouterCall(ts, callee)) {
        // const r = require('express').Router()
        model.routers.set(name, {
          id: relId(rel, name),
          file: rel,
          name,
          kind: "router",
        });
      }
      // const api = Router().use(a).use(b) — a chained router held in a
      // variable; point the name at the anonymous router for the chain.
      if (!model.routers.has(name)) {
        const chained = resolveChainRouter(ts, model, node.initializer);
        if (chained) model.routers.set(name, chained);
      }
      // const r = require('./routes/x')
      if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        ts.isStringLiteral(node.initializer.arguments[0])
      ) {
        const specifier = node.initializer.arguments[0].text;
        if (specifier.startsWith(".")) {
          model.moduleBindings.set(name, { specifier, exportName: "module" });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      classifyCall(analysis, model, node);
    }
    ts.forEachChild(node, visit);
  };
  source.forEachChild((child: any) => visit(child));
  expandDataDrivenMounts(ts, model);

  return model;
}

/** Collect every call expression `<receiver>.<method>(...)` under a root. */
function collectMethodCalls(ts: any, root: any, method: string): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method
    ) {
      out.push(node);
    }
    ts.forEachChild(node, walk);
  };
  if (root) walk(root);
  return out;
}

/**
 * Expand data-driven router tables, a common Express/Koa layout:
 *
 *   const routes = [{ path: '/auth', route: authRoute }, ...];
 *   routes.forEach((item) => router.use(item.path, item.route));
 *   // or: for (const item of routes) router.use(item.path, item.route);
 *
 * The prefix and child router come from per-element properties. Resolve the
 * iterable to an array literal and emit one concrete mount edge per element.
 * This stays purely static: a non-literal iterable or a dynamic element is
 * ignored (and surfaces through the normal unresolved-router path).
 */
function expandDataDrivenMounts(ts: any, model: FileModel): void {
  const { source } = model;

  const resolveArray = (expr: any): any[] | null => {
    if (!expr) return null;
    if (ts.isArrayLiteralExpression(expr)) return [...expr.elements];
    if (ts.isIdentifier(expr)) {
      let found: any[] | null = null;
      const findVar = (node: any) => {
        if (found) return;
        if (
          ts.isVariableDeclaration(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === expr.text &&
          node.initializer &&
          ts.isArrayLiteralExpression(node.initializer)
        ) {
          found = [...node.initializer.elements];
        }
        ts.forEachChild(node, findVar);
      };
      findVar(source);
      return found;
    }
    return null;
  };

  const elementProperty = (element: any, key: string): any => {
    if (!element || !ts.isObjectLiteralExpression(element)) return undefined;
    for (const prop of element.properties) {
      const propName = prop.name?.getText?.(source)?.replace(/^['"]|['"]$/g, "");
      if (ts.isPropertyAssignment(prop) && propName === key) return prop.initializer;
    }
    return undefined;
  };

  const emitForUse = (useCall: any, paramName: string, elements: any[]): void => {
    if (!ts.isPropertyAccessExpression(useCall.expression)) return;
    const parentName = useCall.expression.expression.getText(source);
    const parentRouter = model.routers.get(parentName);
    if (!parentRouter) return;
    const pathArg = useCall.arguments[0];
    const routerArg = useCall.arguments[1];
    if (
      !pathArg ||
      !routerArg ||
      !ts.isPropertyAccessExpression(pathArg) ||
      !ts.isPropertyAccessExpression(routerArg)
    ) {
      return;
    }
    const paramProp = (node: any): string | null =>
      ts.isIdentifier(node.expression) && node.expression.text === paramName
        ? node.name.text
        : null;
    const pathKey = paramProp(pathArg);
    const routerKey = paramProp(routerArg);
    if (!pathKey || !routerKey) return;

    for (const element of elements) {
      const pathNode = elementProperty(element, pathKey);
      const routerNode = elementProperty(element, routerKey);
      if (!pathNode || !ts.isStringLiteralLike(pathNode)) continue;
      if (!routerNode || !ts.isIdentifier(routerNode)) continue;
      const childName = routerNode.text;
      if (!model.routers.has(childName) && !model.moduleBindings.has(childName)) continue;
      const prefix = pathNode.text;
      const duplicate = model.mounts.some(
        (edge) =>
          edge.parent === parentRouter.id && edge.prefix === prefix && edge.child === childName,
      );
      if (duplicate) continue;
      model.mounts.push({ parent: parentRouter.id, child: childName, prefix, middleware: [] });
    }
  };

  const visit = (node: any) => {
    // ARR.forEach((item) => { ... router.use(item.path, item.route) ... })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "forEach" &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const callback = node.arguments[0];
      const param = callback.parameters?.[0]?.name;
      const elements = resolveArray(node.expression.expression);
      if (param && ts.isIdentifier(param) && elements) {
        for (const useCall of collectMethodCalls(ts, callback.body, "use")) {
          emitForUse(useCall, param.text, elements);
        }
      }
    }

    // for (const item of ARR) { ... router.use(item.path, item.route) ... }
    if (ts.isForOfStatement(node)) {
      const binding = node.initializer?.declarationList?.declarations?.[0]?.name;
      const elements = resolveArray(node.expression);
      if (binding && ts.isIdentifier(binding) && elements) {
        for (const useCall of collectMethodCalls(ts, node.statement, "use")) {
          emitForUse(useCall, binding.text, elements);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

/**
 * Returns the first parameter name when `node` is a default-exported router
 * factory (`module.exports = (app) => {...}`, `module.exports = function (app)
 * {...}`, or `export default (app) => {...}`), otherwise null.
 */
const ROUTER_FACTORY_METHODS = new Set([
  "use", "get", "post", "put", "patch", "delete", "all", "head", "options",
]);

function injectedAppParam(ts: any, node: any, source: any): string | null {
  let fn: any = null;
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken?.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.expression.left;
    // Only the default CommonJS export `module.exports = fn`; a named
    // `exports.x = (req, res) => ...` is a handler, not a router factory.
    if (
      ts.isPropertyAccessExpression(left) &&
      left.expression.getText(source) === "module" &&
      left.name.text === "exports"
    ) {
      fn = node.expression.right;
    }
  }
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    fn = node.expression;
  }
  if (!(fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))) return null;
  const param = fn.parameters?.[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  // Distinguish a router/app factory from an unrelated factory such as
  // `module.exports = mongoose => mongoose.model(...)`: the injected parameter
  // must actually receive Express router method calls in the body.
  const paramName = param.text;
  let usedAsRouter = false;
  const inspect = (child: any): void => {
    if (usedAsRouter) return;
    if (
      ts.isPropertyAccessExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === paramName &&
      ROUTER_FACTORY_METHODS.has(child.name.text)
    ) {
      usedAsRouter = true;
      return;
    }
    ts.forEachChild(child, inspect);
  };
  inspect(fn.body ?? fn);
  return usedAsRouter ? paramName : null;
}

function isRouterFactory(ts: any, callee: any, model: FileModel): boolean {
  if (ts.isIdentifier(callee) && model.expressBindings.get(callee.text) === "Router") {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "Router" &&
    ts.isIdentifier(callee.expression) &&
    model.expressBindings.get(callee.expression.text) === "default"
  ) {
    return true;
  }
  return false;
}

// require('express').Router() — CommonJS inline router factory.
function isRequireExpressRouterCall(ts: any, callee: any): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "Router" &&
    ts.isCallExpression(callee.expression) &&
    ts.isIdentifier(callee.expression.expression) &&
    callee.expression.expression.text === "require" &&
    ts.isStringLiteral(callee.expression.arguments?.[0]) &&
    callee.expression.arguments[0].text === "express"
  );
}

/**
 * Resolves the router that owns a chained call. `expr` is the receiver of a
 * `.use()/.get()/...` call. When it chains on `express.Router()` (or
 * `Router()`), an anonymous router is created once per base factory call and
 * reused for the whole chain. Returns null for non-router roots.
 */
function resolveChainRouter(ts: any, model: FileModel, expr: any): RouterVar | null {
  // Climb: expr may be a `.use(...)` call chained on a Router() call.
  let base = expr;
  let guard = 0;
  while (
    base &&
    ts.isCallExpression(base) &&
    ts.isPropertyAccessExpression(base.expression) &&
    guard++ < 20
  ) {
    base = base.expression.expression;
  }
  // base should now be the Router() factory call (or a named variable).
  // Only synthesize anonymous routers when the base IS the Router() factory;
  // named-variable bases (e.g. `api.route("/x").get()`) are left to the
  // dedicated route() handling and must not be re-interpreted here.
  if (!base || !ts.isCallExpression(base)) return null;
  const callee = base.expression;
  const isFactory =
    (ts.isIdentifier(callee) && model.expressBindings.get(callee.text) === "Router") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "Router" &&
      ((ts.isIdentifier(callee.expression) &&
        model.expressBindings.get(callee.expression.text) === "default") ||
        isRequireExpressRouterCall(ts, callee)));
  if (!isFactory) return null;
  const key = base.getStart(model.source);
  let r = model.anonymousRouters.get(key);
  if (!r) {
    r = {
      id: relId(model.rel, `anon${key}`),
      file: model.rel,
      name: `<router@${key}>`,
      kind: "router" as const,
    };
    model.anonymousRouters.set(key, r);
  }
  return r;
}

function classifyCall(analysis: TsAnalysis, model: FileModel, node: any) {
  const { ts } = analysis;
  if (!ts.isPropertyAccessExpression(node.expression)) return;
  const access = node.expression;
  const rootName = access.expression.getText(model.source);
  let router: RouterVar | undefined = model.routers.get(rootName);
  // Chained `Router().use(a).use(b)`: the root is the Router() factory call,
  // not a variable. Resolve (or create) an anonymous router for the chain.
  if (!router) {
    router = resolveChainRouter(ts, model, access.expression) ?? undefined;
  }
  const method = access.name.text;
  const origin: SourceLocation = {
    file: model.rel,
    line: ts.getLineAndCharacterOfPosition(model.source, node.getStart(model.source)).line + 1,
  };

  // app.listen(PORT) — the app var is also registered as a router, so check
  // before routing the call through router/middleware classification. A bare
  // `app.listen()` (no argument) must not crash: arguments[0] is undefined.
  if (method === "listen" && node.arguments[0] && ts.isNumericLiteral(node.arguments[0])) {
    model.listenPorts.push(Number(node.arguments[0].text));
    return;
  }

  if (!router) {
    return;
  }

  if (method === "use") {
    const [first, ...rest] = node.arguments;
    const hasStringPrefix = first && ts.isStringLiteralLike(first);
    const prefix = hasStringPrefix ? first.text : "";
    const handlerArgs = hasStringPrefix ? rest : node.arguments;

    // Mounting another router?
    const routerArg = handlerArgs.find((arg: any) => routerArgument(ts, arg, model));
    if (routerArg) {
      model.mounts.push({
        parent: router.id,
        child: routerArg.getText(model.source),
        prefix,
        routerArgNode: routerArg,
        middleware: handlerArgs
          .filter((arg: any) => arg !== routerArg)
          .map((arg: any) => ({ node: arg, file: model.rel, scopePath: prefix || undefined })),
      });
    } else {
      const middleware = handlerArgs.map((arg: any): MiddlewareRef => ({
        routerId: router.id,
        node: arg,
        file: model.rel,
        scopePath: prefix || undefined,
        pos: node.pos,
      }));
      if (prefix) {
        for (const mw of middleware) {
          model.scopedMiddleware.push({ ...mw, scopePath: prefix });
        }
      } else {
        model.unscopedMiddleware.push(...middleware);
      }
    }
    return;
  }

  // X.route(path).get(...)...
  if (method === "route") {
    const pathEntries = pathArguments(ts, node.arguments[0]);
    for (const entry of pathEntries) {
      if (!entry) {
        model.unresolved.push({
          reason: "dynamic-path",
          message: "Route path passed to .route() is not a static string literal",
          origin,
        });
        continue;
      }
      // Climb: route() call -> PropertyAccess -> verb call (possibly chained).
      let parent = node.parent;
      while (parent) {
        const call = ts.isCallExpression(parent)
          ? parent
          : ts.isCallExpression(parent.parent)
            ? parent.parent
            : undefined;
        if (
          call &&
          ts.isPropertyAccessExpression(call.expression) &&
          HTTP_METHODS.has(call.expression.name.text)
        ) {
          model.routes.push(
            // Verb calls on app.route(path) carry no path argument: every
            // argument is a handler.
            buildRoute(ts, model, router, call, call.expression.name.text, entry, origin, true),
          );
          parent = call.parent;
          continue;
        }
        break;
      }
    }
    return;
  }

  if (HTTP_METHODS.has(method)) {
    const pathEntries = pathArguments(ts, node.arguments[0]);
    // `app.options('*', cors())` is a CORS preflight catch-all, not a business
    // operation; do not emit it as an API route.
    const rawPath = node.arguments[0]?.text?.trim();
    const normalizedPath = rawPath ? rawPath.replace(/^(['"])(.*)\1$/, "$2") : rawPath;
    if (method === "options" && normalizedPath === "*") return;
    for (const entry of pathEntries) {
      if (!entry) {
        model.unresolved.push({
          reason: "dynamic-path",
          message: `Route path for .${method}() is not a static string literal`,
          origin,
        });
        continue;
      }
      model.routes.push(buildRoute(ts, model, router, node, method, entry, origin));
    }
  }
}

function isFourArgHandler(analysis: TsAnalysis, model: FileModel, arg: any): boolean {
  const { ts } = analysis;
  const arityFour = (fn: any): boolean => fn?.parameters?.length === 4;
  if (
    ts.isArrowFunction(arg) ||
    ts.isFunctionExpression(arg) ||
    ts.isFunctionDeclaration(arg)
  ) {
    return arityFour(arg);
  }
  if (ts.isIdentifier(arg)) {
    const resolved = resolveHandler(analysis, model.source, arg);
    return arityFour(resolved?.node);
  }
  return false;
}

/** Resolve the error handlers that can receive a route's thrown/next(err) error:
 * same-router handlers registered after the route, plus global app fallbacks. */
function collectErrorHandlers(
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  route: RouteCall,
  fullPath: string,
  appIds: Set<string>,
): Array<{ file: any; node: any }> {
  const seen = new Set<any>();
  const out: Array<{ file: any; node: any }> = [];
  const resolve = (ref: MiddlewareRef): void => {
    const source = analysis.sourceByPath.get(ref.file) ?? models.get(ref.file)?.source;
    const resolved = resolveHandler(analysis, source, ref.node);
    if (resolved?.node && !seen.has(resolved.node)) {
      seen.add(resolved.node);
      out.push(resolved);
    }
  };

  const ownModel = models.get(route.file);
  for (const eh of ownModel?.errorHandlers ?? []) {
    if (eh.routerId !== route.routerId) continue;
    if (eh.pos <= route.pos) continue;
    if (eh.scopePath && !route.rawPath.startsWith(eh.scopePath)) continue;
    resolve(eh);
  }

  for (const m of models.values()) {
    for (const eh of m.errorHandlers) {
      if (!appIds.has(eh.routerId)) continue;
      if (eh.scopePath && !fullPath.startsWith(eh.scopePath)) continue;
      resolve(eh);
    }
  }
  return out;
}

function routerArgument(ts: any, arg: any, model: FileModel): boolean {
  if (ts.isIdentifier(arg)) {
    if (model.routers.has(arg.text)) return true;
    if (model.moduleBindings.has(arg.text)) return true;
  }
  // express.Router() inline
  if (
    ts.isCallExpression(arg) &&
    ((ts.isPropertyAccessExpression(arg.expression) && arg.expression.name.text === "Router") ||
      isRouterFactory(ts, arg.expression, model))
  ) {
    return true;
  }
  return false;
}

function pathArguments(
  ts: any,
  arg: any,
): Array<{ raw: string; optional: Set<string> } | null> {
  if (!arg) return [null];
  if (ts.isStringLiteralLike(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return [{ raw: arg.text, optional: new Set() }];
  }
  if (ts.isArrayLiteralExpression(arg)) {
    return arg.elements.map((el: any) =>
      ts.isStringLiteralLike(el)
        ? { raw: el.text, optional: new Set() }
        : null,
    );
  }
  if (ts.isTemplateExpression(arg)) {
    // Template with substitutions is dynamic; flag as unresolved.
    return [null];
  }
  return [null];
}

function buildRoute(
  ts: any,
  model: FileModel,
  router: RouterVar,
  call: any,
  method: string,
  pathEntry: { raw: string; optional: Set<string> } | null,
  origin: SourceLocation,
  pathAlreadyConsumed = false,
): RouteCall {
  const normalized = pathEntry
    ? normalizeExpressPath(pathEntry.raw)
    : { path: "", optional: new Set<string>(), dynamic: true };

  // app.route(path).get(handler): the verb call has no path argument, so all
  // arguments are handlers/middleware. Regular router.get(path, ...handlers)
  // skips the leading path argument.
  const handlerArgs = pathAlreadyConsumed ? call.arguments : call.arguments.slice(1);
  return {
    routerId: router.id,
    file: model.rel,
    method,
    rawPath: normalized.path,
    optionalParams: normalized.optional,
    // Every argument is either middleware (validators, auth) or, for the
    // last one, the request handler; keep call expressions so validator
    // chains can be inspected.
    handlers: handlerArgs.map((node: any) => ({ node, file: model.rel })),
    middleware: [],
    origin,
    pos: call.pos,
  };
}

function resolveMountTarget(
  analysis: TsAnalysis,
  model: FileModel,
  mount: MountEdge,
  models: Map<string, FileModel>,
): string | null {
  if (mount.child) {
    // Identifier referring to a local router or imported module.
    const local = model.routers.get(mount.child);
    if (local) return local.id;
    const binding = model.moduleBindings.get(mount.child);
    if (binding) {
      const imported = resolveImportedFile(analysis, model.source, mount.child);
      if (imported) {
        const targetModel = [...models.values()].find((m) => m.source === imported.file);
        if (targetModel) {
          // module.exports = r / export default r / named router export.
          const exported = findExportedRouterName(analysis, targetModel, imported.exportName);
          if (exported && targetModel.routers.has(exported)) {
            return targetModel.routers.get(exported)!.id;
          }
          // export default Router().use('/api', api) — the default export is a
          // router chain expression; resolve to its anonymous router.
          const anonId = findAnonymousExportedRouter(analysis, targetModel);
          if (anonId) return anonId;
        }
      }
    }
  }
  // Inline express.Router() mounts carry no resolvable id; create an anonymous
  // router node by reusing the parent with the prefix (routes declared on the
  // inline router are rare and surface as unresolved).
  return null;
}

/**
 * Grafts default-exported router factories onto the concrete app/router passed
 * at their call site. Handles both the immediate CommonJS form
 * `require("./routes")(app)` and the bound form `const routes = require("./routes");
 * routes(app)` (or the ESM default-import equivalent). The factory's injected
 * parameter was modelled as a synthetic router; this adds a prefix-less edge
 * from the caller's real router to it, so its inner mounts become reachable.
 */
function linkFactoryApps(
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  edges: MountEdge[],
): void {
  const { ts, program } = analysis;
  const modelBySource = new Map<any, FileModel>(
    [...models.values()].map((m) => [m.source, m]),
  );

  for (const model of models.values()) {
    const sourceFile = model.source;

    const link = (specifier: string, argNode: any): void => {
      if (!argNode || !ts.isIdentifier(argNode)) return;
      const parent = model.routers.get(argNode.text);
      if (!parent) return;
      const resolvedFileName = ts.resolveModuleName
        ? ts.resolveModuleName(
            specifier,
            sourceFile.fileName,
            program.getCompilerOptions(),
            ts.sys,
          )?.resolvedModule?.resolvedFileName
        : undefined;
      if (!resolvedFileName) return;
      const targetSource = program.getSourceFile(resolvedFileName);
      if (!targetSource || !analysis.isProjectFile(resolvedFileName)) return;
      const targetModel = modelBySource.get(targetSource);
      if (!targetModel?.factoryApp) return;
      const exists = edges.some(
        (edge) => edge.parent === parent.id && edge.child === targetModel.factoryApp!.id,
      );
      if (!exists) {
        edges.push({ parent: parent.id, child: targetModel.factoryApp.id, prefix: "", middleware: [] });
      }
    };

    const visit = (node: any): void => {
      // Immediate form: require("./routes")(app)
      if (
        ts.isCallExpression(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        ts.isStringLiteral(node.expression.arguments?.[0])
      ) {
        link(node.expression.arguments[0].text, node.arguments?.[0]);
      }
      // Bound form: routes(app) where routes was required/imported locally.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        model.moduleBindings.has(node.expression.text)
      ) {
        link(model.moduleBindings.get(node.expression.text)!.specifier, node.arguments?.[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function findAnonymousExportedRouter(analysis: TsAnalysis, model: FileModel): string | null {
  const { ts } = analysis;
  let id: string | null = null;
  model.source.forEachChild((child: any) => {
    if (id) return;
    if (!ts.isExportAssignment(child)) return;
    const router = resolveChainRouter(ts, model, child.expression);
    if (router) id = router.id;
  });
  return id;
}

function findExportedRouterName(
  analysis: TsAnalysis,
  model: FileModel,
  exportName: string,
): string | null {
  const { ts } = analysis;
  let name: string | null = null;
  model.source.forEachChild((child: any) => {
    if (name) return;
    if (ts.isExportAssignment(child) && ts.isIdentifier(child.expression)) {
      name = child.expression.text;
    }
    if (
      ts.isExpressionStatement(child) &&
      ts.isBinaryExpression(child.expression) &&
      ts.isPropertyAccessExpression(child.expression.left)
    ) {
      const lhs = child.expression.left;
      if (
        (lhs.expression.getText(model.source) === "module" && lhs.name.text === "exports") ||
        lhs.expression.getText(model.source) === "exports"
      ) {
        if (ts.isIdentifier(child.expression.right)) name = child.expression.right.text;
      }
    }
    if (exportName !== "default" && exportName !== "module") {
      if (
        ts.isVariableStatement(child) &&
        child.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of child.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === exportName) name = exportName;
        }
      }
    }
  });
  return name;
}

function walkMounts(
  routerId: string,
  prefix: string,
  middleware: MiddlewareRef[],
  edges: MountEdge[],
  into: Map<string, Array<{ prefix: string; middleware: MiddlewareRef[] }>>,
  seen: Set<string>,
  unscopedOf: (id: string) => MiddlewareRef[],
): void {
  const key = `${routerId}@${prefix}`;
  if (seen.has(key)) return;
  seen.add(key);

  const list = into.get(routerId) ?? [];
  list.push({ prefix, middleware });
  into.set(routerId, list);

  for (const edge of edges.filter((e) => e.parent === routerId)) {
    if (!edge.child) continue;
    walkMounts(
      edge.child,
      joinPrefix(prefix, edge.prefix),
      [...middleware, ...edge.middleware, ...unscopedOf(edge.child)],
      edges,
      into,
      seen,
      unscopedOf,
    );
  }
}

function isAuthMiddleware(ts: any, node: any, file: any): boolean {
  // passport.authenticate('jwt', ...)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "authenticate"
  ) {
    const strategy = node.arguments[0];
    if (strategy && ts.isStringLiteralLike(strategy) && /jwt|bearer/i.test(strategy.text)) {
      return true;
    }
  }
  let name: string | undefined;
  try {
    name = ts.isIdentifier(node)
      ? node.text
      : ts.isCallExpression(node)
        ? node.expression.getText()
        : node.getText?.();
  } catch {
    name = undefined;
  }
  return Boolean(name && AUTH_PATTERN.test(name.replace(/[^A-Za-z]/g, "").toLowerCase()));
}

/**
 * Extracts Joi/celebrate schema middleware of the shape
 * `validate({ body: Joi.object()..., query: Joi.object()..., params: ... })`.
 * The schema object frequently lives in another CommonJS module
 * (`validate(authValidation.register)`), so each middleware argument is
 * resolved statically across requires. Returns the converted JSON Schemas.
 */
function collectSchemaOverrides(
  analysis: TsAnalysis,
  node: any,
): { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema } {
  const { ts } = analysis;
  const overrides: { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema } = {};
  if (!ts.isCallExpression(node)) return overrides;

  const readContainer = (container: any) => {
    if (!container || !ts.isObjectLiteralExpression(container)) return;
    for (const prop of container.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name?.getText?.()?.replace(/['"]/g, "");
      if (key !== "body" && key !== "query" && key !== "params") continue;
      const schemaNode = prop.initializer;
      if (isJoiSchema(ts, schemaNode)) {
        const schema = convertJoiNode(ts, schemaNode);
        if (schema && Object.keys(schema).length) overrides[key as "body" | "query" | "params"] = schema;
      }
    }
  };

  for (const arg of node.arguments) {
    const resolved = resolveStaticValue(analysis, arg);
    if (resolved && resolved !== arg) readContainer(resolved);
    readContainer(arg);
  }
  return overrides;
}

function mergeSchemaOverrides(
  base: { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema },
  extra: { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema },
): void {
  for (const key of ["body", "query", "params"] as const) {
    if (extra[key] && !base[key]) base[key] = extra[key];
  }
}

function collectValidatorChains(ts: any, node: any, file: any): ValidatedField[] {
  const fields: ValidatedField[] = [];
  const visit = (n: any) => {
    if (ts.isCallExpression(n)) {
      const field = convertValidatorChain(ts, n);
      if (field) fields.push(field);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return fields;
}

function resolveAndAnalyze(
  analysis: TsAnalysis,
  model: FileModel,
  finalHandler: { node: any; file: string } | undefined,
  origin: SourceLocation,
  pathParams: Set<string>,
  validators: ValidatedField[],
  unresolved: DiscoveredUnresolved[],
  customResponseMethods: Map<string, import("./express-handler.js").CustomResponseMethod>,
  schemaOverrides: { body?: JsonSchema; query?: JsonSchema; params?: JsonSchema } = {},
): { facts: import("./express-handler.js").HandlerFacts; handlerSource?: string } {
  const noFacts: import("./express-handler.js").HandlerFacts = {
    parameters: [],
    responses: [],
    gaps: ["response-unknown"],
    sse: false,
  };
  if (!finalHandler) return { facts: noFacts };

  const handlerFile =
    [...analysis.sourceByPath.entries()].find(([rel]) => rel === finalHandler.file)?.[1] ??
    model.source;
  const resolved = resolveHandler(analysis, handlerFile, finalHandler.node);
  if (!resolved) {
    unresolved.push({
      reason: "handler-unresolved",
      message: "Handler could not be resolved to a function declaration",
      origin,
    });
    return { facts: noFacts };
  }

  const facts = analyzeHandler(analysis, resolved.file, resolved.node, origin, {
    pathParams,
    validators,
    customResponseMethods,
    validatedRequest: schemaOverrides,
  });
  return {
    facts,
    handlerSource: sliceHandler(analysis.ts, resolved.file, resolved.node),
  };
}

/** Extracts a bounded handler source slice for the optional AI gap resolver. */
function sliceHandler(ts: any, file: any, node: any): string | undefined {
  try {
    const text = node.getText(file) as string;
    return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
  } catch {
    return undefined;
  }
}

function dedupeRoutes(
  candidates: RouteCandidate[],
  unresolved: DiscoveredUnresolved[],
): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.method} ${candidate.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      continue;
    }
    // Same route mounted twice: keep the richer evidence.
    const score = (c: RouteCandidate) =>
      c.responses.length * 2 +
      c.parameters.length +
      (c.requestBody ? 2 : 0) -
      c.gaps.length;
    if (score(candidate) > score(existing)) seen.set(key, candidate);
    unresolved.push({
      reason: "duplicate-route",
      message: `Duplicate declaration for ${key}`,
      origin: candidate.origin,
    });
  }
  return [...seen.values()];
}
