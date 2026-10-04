/**
 * Hono framework pack (typescript/javascript).
 *
 * Hono is a minimalist web runtime that runs unmodified on Cloudflare Workers,
 * Bun, Deno and Node. Routing is `app.<verb>(path, handler)` with `.route()`
 * groups/mounts, and handlers receive a single context object `c`:
 *   c.req.param(name) / c.req.query(name) / c.req.header(name)
 *   c.req.json<T>() for the typed request body, c.json(value, status) for
 *   responses, and c.streamSSE(...) for server-sent events.
 *
 * TypeScript type information drives component $ref inference; everything not
 * statically provable is left as an honest gap and never fabricated.
 */

import type {
  ExtractionResult,
  FrameworkPack,
  GapCode,
  RouteCandidate,
  RouteParameter,
  ScanContext,
} from "../core/types.js";
import type { TsAnalysis } from "../lang/typescript/index.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";
import { convertZodNode } from "../lang/typescript/zod.js";
import { resolveStatusName } from "../lang/typescript/httpStatus.js";
import { resolveHandler } from "./express-handler.js";
import {
  addParam,
  collectComponents,
  joinPath,
  locationAt,
  makeOperationId,
  normalizeColonPath,
  ResponseCollector,
  schemaFromNode,
  tagForPath,
} from "../lang/typescript/httpRoute.js";

const VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
]);

interface HonoNode {
  id: string;
  file: string;
  varName: string;
}

interface MountEdge {
  parentId: string;
  prefix: string;
  childFile: string;
  childName: string;
}

interface RouteDef {
  method: string;
  path: string;
  /** The createRoute({...}) object literal node. */
  objectNode: any;
  /** Project-relative path of the file declaring the route. */
  ownerRel: string;
}

interface RouteReg {
  nodeId: string;
  file: string;
  method: string;
  rawPath: string;
  handlerNode: any;
  /** createRoute object literal and declaring file when via .openapi(). */
  routeObject?: any;
  routeObjectFile?: string;
  origin: { file: string; line?: number };
}

interface FileModel {
  rel: string;
  source: any;
  /** Local ctor binding imported from "hono" (usually `Hono`). */
  ctorNames: Set<string>;
  /** createRoute binding imported from "@hono/zod-openapi". */
  createRouteNames: Set<string>;
  /** Imported binding -> { specifier, exportName }. */
  imports: Map<string, { specifier: string; exportName: string }>;
  /** namespace imports: binding name -> specifier (import * as routes from "..."). */
  namespaceImports: Map<string, string>;
  nodes: Map<string, HonoNode>;
  /** Exported Hono var: export name -> local var name. */
  exported: Map<string, string>;
  /** createRoute definitions: local/exported name -> parsed route contract. */
  routeDefs: Map<string, RouteDef>;
  /** Top-level schema initializers by local binding name (Zod and friends). */
  schemaBindings: Map<string, any>;
  mounts: MountEdge[];
  routes: RouteReg[];
  /** `.openapi(routeDef, handler)` calls awaiting cross-file routeDef resolution. */
  pendingOpenapi: Array<{
    nodeId: string;
    arg: any;
    handlerNode: any;
    origin: { file: string; line?: number };
  }>;
}

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const honoPack: FrameworkPack<TsAnalysis> = {
  id: "hono",
  language: "typescript",
  dependencyHints: ["hono"],

  applies(ctx: ScanContext): boolean {
    const hasDep = ctx.manifest.packages.has("hono") || ctx.manifest.packages.has("@hono/zod-openapi");
    if (!hasDep) return false;
    // Route-feature dual signal: an actual Hono import / `new Hono()` call.
    return ctx.index.files.some((f) =>
      /from\s+["'](?:hono|@hono\/zod-openapi)["']|require\(["']hono["']\)|new\s+Hono\s*\(/.test(f.content),
    );
  },

  extract(analysis: TsAnalysis, ctx: ScanContext): ExtractionResult {
    const { ts } = analysis;
    const models = new Map<string, FileModel>();

    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const allNodes = new Map<string, HonoNode>();
    const routes: RouteReg[] = [];
    for (const model of models.values()) {
      for (const node of model.nodes.values()) allNodes.set(node.id, node);
      routes.push(...model.routes);
    }

    // Resolve `.openapi(routeDef, handler)` calls into concrete routes.
    for (const model of models.values()) {
      for (const pend of model.pendingOpenapi) {
        const def = resolveRouteDef(analysis, ts, models, model, pend.arg);
        if (!def) continue;
        routes.push({
          nodeId: pend.nodeId,
          file: model.rel,
          method: def.method,
          rawPath: def.path,
          handlerNode: pend.handlerNode,
          routeObject: def.objectNode,
          routeObjectFile: def.ownerRel,
          origin: pend.origin,
        });
      }
    }

    // Resolve mount child references (local vars and imported sub-apps) into
    // concrete node ids.
    const edges: Array<{ parentId: string; prefix: string; childId: string }> = [];
    const incoming = new Set<string>();
    for (const model of models.values()) {
      for (const mount of model.mounts) {
        const childId = resolveMountChild(analysis, models, model, mount);
        if (!childId) continue;
        edges.push({ parentId: mount.parentId, prefix: mount.prefix, childId });
        if (childId !== mount.parentId) incoming.add(childId);
      }
    }

    // Compute every prefix-chain reaching each node. Roots are nodes that are
    // never mounted under another app; unreachable nodes are treated as their
    // own root (standalone entry app) so no routes are dropped.
    const prefixes = new Map<string, string[]>();
    const unresolved: ExtractionResult["unresolved"] = [];
    const outgoing = new Map<string, typeof edges>();
    for (const edge of edges) outgoing.set(edge.parentId, [...(outgoing.get(edge.parentId) ?? []), edge]);
    const visited = new Set<string>();
    const reportedCycles = new Set<string>();
    const walk = (rootId: string) => {
      const pending = [{id: rootId, prefix: "", ancestors: new Set<string>()}];
      while (pending.length) {
        const {id, prefix, ancestors} = pending.pop()!;
        if (ancestors.has(id)) {
          if (!reportedCycles.has(id)) unresolved.push({reason: "path-dynamic", message: "Cyclic Hono application mount; recursive paths require review", origin: {file: allNodes.get(id)?.file ?? "", symbol: allNodes.get(id)?.varName}});
          reportedCycles.add(id);
          continue;
        }
        const key = `${id}\0${prefix}`;
        if (visited.has(key)) continue;
        if (visited.size >= 10000) {
          if (!unresolved.some(u => u.message.includes("10000"))) unresolved.push({reason: "path-dynamic", message: "Hono mount expansion exceeded 10000 distinct paths; remaining mounts require review", origin: {file: allNodes.get(id)?.file ?? ""}});
          return;
        }
        visited.add(key);
        prefixes.set(id, [...(prefixes.get(id) ?? []), prefix]);
        const next = new Set(ancestors).add(id);
        for (const edge of outgoing.get(id) ?? []) pending.push({id: edge.childId, prefix: joinPath(prefix, edge.prefix), ancestors: next});
      }
    };
    for (const root of [...allNodes.values()].filter(n => !incoming.has(n.id))) walk(root.id);
    for (const node of allNodes.values()) if (!prefixes.has(node.id)) walk(node.id);

    const candidates: RouteCandidate[] = [];
    const seenOp = new Map<string, RouteCandidate>();

    for (const route of routes) {
      const prefixList = prefixes.get(route.nodeId) ?? [""];
      const normalized = normalizeColonPath(route.rawPath);
      for (const prefix of prefixList) {
        const fullPath = joinPath(prefix, normalized.path);
        const facts = analyzeHonoHandler(analysis, route.file, route.handlerNode, route.origin, {
          pathParams: new Set(normalized.params),
        });

        // Declarative @hono/zod-openapi contract (createRoute) wins over
        // handler inference for body, responses and typed parameters. Schema
        // identifiers resolve in the file that declares the route, which may
        // differ from the file that registers it.
        const contractOwner = models.get(route.routeObjectFile ?? route.file);
        const contract =
          route.routeObject && contractOwner
            ? extractRouteContract(analysis, models, contractOwner, route.routeObject)
            : null;

        const parameters = [...facts.parameters];
        if (contract) {
          for (const p of contract.parameters) {
            if (!parameters.some((x) => x.name === p.name && x.in === p.in)) {
              parameters.push(p);
            }
          }
        }

        let requestBody = facts.requestBody;
        if (contract?.body) {
          requestBody = {
            required: contract.body.required,
            confidence: "high",
            content: contract.body.content.map((c) => ({
              mediaType: c.mediaType,
              schema: c.schema,
              confidence: "high" as const,
            })),
          };
        }

        let responses = facts.responses;
        if (contract && contract.responses.length > 0) {
          const byStatus = new Map(responses.map((r) => [r.statusCode, r]));
          for (const r of contract.responses) byStatus.set(r.statusCode, r);
          responses = [...byStatus.values()];
        }

        const gaps = facts.gaps.filter((g) => {
          if (contract?.body && (g === "body-unknown" || g === "body-schema-unknown")) return false;
          if (contract && contract.responses.length > 0 && g === "response-unknown") return false;
          return true;
        });

        const confidence = !gaps.length
          ? "high"
          : gaps.some((g) => g === "response-unknown" || g === "body-unknown")
            ? "low"
            : "medium";

        const candidate: RouteCandidate = {
          method: route.method,
          path: normalized.path,
          fullPath,
          operationId: makeOperationId(route.method, fullPath),
          origin: route.origin,
          parameters,
          ...(requestBody ? { requestBody } : {}),
          responses,
          tags: tagForPath(fullPath, route.file),
          ...(facts.sse ? { extensions: { "x-protocol": "sse" } } : {}),
          confidence,
          gaps,
          components: [],
          handlerSource: facts.handlerSource,
        };
        const key = `${candidate.method} ${candidate.fullPath}`;
        const existing = seenOp.get(key);
        if (!existing) seenOp.set(key, candidate);
      }
    }

    return {
      routes: [...seenOp.values()],
      unresolved,
      components: collectComponents(analysis),
      securitySchemes: [],
      servers: [],
    };
  },
};

function relId(file: string, varName: string): string {
  return `${file}::${varName}`;
}

/** Prove an app factory through its actual return values and imported constructor.
 * No reliance on a function's spelling (createApp may return anything). */
function isHonoInstance(analysis: TsAnalysis, expression: any, seen = new Set<any>(), depth = 0): boolean {
  const {ts, checker} = analysis;
  if (!expression || depth > 12 || seen.has(expression)) return false;
  const next = new Set(seen).add(expression);
  const symbolOf = (node: any) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  if (ts.isNewExpression(expression)) {
    const ctor = expression.expression;
    if (!ts.isIdentifier(ctor)) return false;
    const local = checker.getSymbolAtLocation(ctor);
    return (local?.declarations ?? []).some((decl: any) => {
      if (!ts.isImportSpecifier(decl)) return false;
      const name = decl.propertyName?.text ?? decl.name.text;
      const module = decl.parent?.parent?.parent?.moduleSpecifier?.text;
      return (module === 'hono' && name === 'Hono') || (module === '@hono/zod-openapi' && name === 'OpenAPIHono');
    });
  }
  if (ts.isIdentifier(expression)) {
    const declarations = symbolOf(expression)?.declarations ?? [];
    const variable = declarations.find((d: any) => ts.isVariableDeclaration(d) && d.initializer);
    return !!variable && isHonoInstance(analysis, variable.initializer, next, depth + 1);
  }
  if (ts.isCallExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'route') {
      return isHonoInstance(analysis, expression.expression.expression, next, depth + 1);
    }
    const declarations = symbolOf(expression.expression)?.declarations ?? [];
    const fn = declarations.find((d: any) => ts.isFunctionDeclaration(d) && d.body)
      ?? declarations.find((d: any) => ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))?.initializer;
    if (!fn?.body || !analysis.isProjectFile(fn.getSourceFile().fileName)) return false;
    if (!ts.isBlock(fn.body)) return isHonoInstance(analysis, fn.body, next, depth + 1);
    const returns: any[] = [];
    const visit = (node: any) => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return returns.length > 0 && returns.every(value => isHonoInstance(analysis, value, next, depth + 1));
  }
  return false;
}

function modelFile(analysis: TsAnalysis, rel: string, source: any): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    ctorNames: new Set(),
    createRouteNames: new Set(),
    imports: new Map(),
    namespaceImports: new Map(),
    nodes: new Map(),
    exported: new Map(),
    routeDefs: new Map(),
    schemaBindings: new Map(),
    mounts: [],
    routes: [],
    pendingOpenapi: [],
  };

  // Collect imports: `import { Hono } from "hono"`, createRoute, relative sub-apps.
  source.forEachChild((child: any) => {
    if (ts.isImportDeclaration(child) && ts.isStringLiteral(child.moduleSpecifier)) {
      const specifier = child.moduleSpecifier.text;
      if (specifier === "hono") {
        const named = child.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.name.text === "Hono" || el.propertyName?.text === "Hono") {
              model.ctorNames.add(el.name.text);
            }
          }
        }
      } else if (specifier === "@hono/zod-openapi") {
        const named = child.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.name.text === "createRoute" || el.propertyName?.text === "createRoute") {
              model.createRouteNames.add(el.name.text);
            }
            // OpenAPIHono subclasses Hono and supports the same routing API.
            if (el.name.text === "OpenAPIHono" || el.propertyName?.text === "OpenAPIHono") {
              model.ctorNames.add(el.name.text);
            }
          }
        }
      } else {
        // import * as routes from "./x"
        if (
          child.importClause?.namedBindings &&
          ts.isNamespaceImport(child.importClause.namedBindings)
        ) {
          model.namespaceImports.set(
            child.importClause.namedBindings.name.text,
            specifier,
          );
        }
        if (child.importClause?.name) {
          model.imports.set(child.importClause.name.text, {
            specifier,
            exportName: "default",
          });
        }
        const named = child.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            model.imports.set(el.name.text, {
              specifier,
              exportName: el.propertyName?.text ?? el.name.text,
            });
          }
        }
      }
    }
    // `export const userRoutes = users` / `export default app`.
    if (ts.isExportDeclaration(child) && child.exportClause && ts.isNamedExports(child.exportClause)) {
      // Named re-exports are handled at mount resolution time via imports.
    }
  });

  const visit = (node: any) => {
    // const X = createRoute({ method, path, ... })
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      model.createRouteNames.has(node.initializer.expression.text)
    ) {
      const arg = node.initializer.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        let method: string | undefined;
        let path: string | undefined;
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const k = prop.name?.getText(source);
          if (k === "method" && ts.isStringLiteralLike(prop.initializer)) {
            method = prop.initializer.text.toLowerCase();
          } else if (k === "path" && ts.isStringLiteralLike(prop.initializer)) {
            path = prop.initializer.text;
          }
        }
        if (method && path)
          model.routeDefs.set(node.name.text, {
            method,
            path,
            objectNode: arg,
            ownerRel: rel,
          });
      }
    }

    // Top-level schema bindings (Zod chains and plain object literals). Only
    // source-level declarations are indexed, so handler-local vars never leak.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent?.parent?.parent === source
    ) {
      if (!model.schemaBindings.has(node.name.text)) {
        model.schemaBindings.set(node.name.text, node.initializer);
      }
    }

    // const app = new Hono()
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      isHonoInstance(analysis, node.initializer)
    ) {
      model.nodes.set(node.name.text, {
        id: relId(rel, node.name.text),
        file: rel,
        varName: node.name.text,
      });
    }

    // export const <name> = <honoVar>
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.parent?.parent &&
      ts.isVariableStatement(node.parent.parent) &&
      node.parent.parent.modifiers?.some(
        (m: any) => m.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      if (node.initializer && ts.isIdentifier(node.initializer)) {
        if (model.nodes.has(node.initializer.text)) {
          model.exported.set(node.name.text, node.initializer.text);
        }
      } else if (
        node.initializer && model.nodes.has(node.name.text)
      ) {
        // export const users = new Hono()
        model.exported.set(node.name.text, node.name.text);
      }
    }

    if (ts.isCallExpression(node)) classifyCall(analysis, model, node);
    ts.forEachChild(node, visit);
  };
  source.forEachChild((child: any) => visit(child));

  // `export default app`
  source.forEachChild((child: any) => {
    if (ts.isExportAssignment(child) && ts.isIdentifier(child.expression)) {
      model.exported.set("default", child.expression.text);
    }
  });

  return model;
}

function classifyCall(analysis: TsAnalysis, model: FileModel, node: any): void {
  const { ts } = analysis;
  if (!ts.isPropertyAccessExpression(node.expression)) return;
  const access = node.expression;
  let rootName = access.expression.getText(model.source);
  if (!model.nodes.has(rootName) && ts.isCallExpression(access.expression)) {
    let chain = node;
    while (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent)) chain = chain.parent;
    if (ts.isVariableDeclaration(chain.parent) && ts.isIdentifier(chain.parent.name) && model.nodes.has(chain.parent.name.text)) rootName = chain.parent.name.text;
  }
  const method = access.name.text;
  const origin = locationAt(ts, model.source, node, model.rel);

  // Only proven Hono instances may register declarative routes. An unrelated
  // object's openapi() method must not produce a root-level API.
  if (method === "openapi" && model.nodes.has(rootName)) {
    const arg = node.arguments[0];
    const handlerNode = [...node.arguments]
      .slice(1)
      .reverse()
      .find((a: any) => a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a)));
    if (arg && handlerNode) {
      model.pendingOpenapi.push({
        nodeId: model.nodes.get(rootName)?.id ?? "",
        arg,
        handlerNode,
        origin,
      });
    }
    return;
  }

  const nodeVar = model.nodes.get(rootName);
  if (!nodeVar) return;

  // app.route('/prefix', subApp)
  if (method === "route") {
    const prefixArg = node.arguments[0];
    const childArg = node.arguments[1];
    if (
      prefixArg &&
      ts.isStringLiteralLike(prefixArg) &&
      childArg &&
      ts.isIdentifier(childArg)
    ) {
      model.mounts.push({
        parentId: nodeVar.id,
        prefix: prefixArg.text,
        childFile: model.rel,
        childName: childArg.text,
      });
    }
    return;
  }

  if (!VERBS.has(method)) return;
  const pathArg = node.arguments[0];
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return;
  // Last function-ish argument is the handler.
  const handlerNode = [...node.arguments]
    .slice(1)
    .reverse()
    .find((a: any) => a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a)));
  if (!handlerNode) return;

  model.routes.push({
    nodeId: nodeVar.id,
    file: model.rel,
    method,
    rawPath: pathArg.text,
    handlerNode,
    origin,
  });
}

function resolveRouteDef(
  analysis: TsAnalysis,
  ts: any,
  models: Map<string, FileModel>,
  model: FileModel,
  arg: any,
): RouteDef | undefined {
  // Local routeDef: openapi(loginRoute, ...)
  if (ts.isIdentifier(arg)) {
    const def = model.routeDefs.get(arg.text);
    return def ? { ...def, ownerRel: model.rel } : undefined;
  }
  // Namespace member: openapi(routes.getCurrentUser, ...)
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
    const ns = arg.expression.text;
    const member = arg.name.text;
    const specifier = model.namespaceImports.get(ns);
    if (!specifier) return undefined;
    const { program } = analysis;
    const resolved = ts.resolveModuleName
      ? ts.resolveModuleName(
          specifier,
          model.source.fileName,
          program.getCompilerOptions(),
          ts.sys,
        )?.resolvedModule?.resolvedFileName
      : undefined;
    if (!resolved || !analysis.isProjectFile(resolved)) return undefined;
    const target = program.getSourceFile(resolved);
    const targetModel = [...models.values()].find((m) => m.source === target);
    const def = targetModel?.routeDefs.get(member);
    return def ?? undefined;
  }
  return undefined;
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
function objectProperty(ts: any, obj: any, name: string): any | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
    if (key === name) return prop.initializer;
  }
  return null;
}

/**
 * Resolves a schema binding name to its initializer node, following local
 * declarations and relative imports across project files.
 */
function makeBindingResolver(
  analysis: TsAnalysis,
  ts: any,
  models: Map<string, FileModel>,
  owner: FileModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (name: string, from?: any) => any | null {
  const resolveImported = (model: FileModel, name: string): any | null => {
    const binding = model.imports.get(name);
    if (!binding) return null;
    const { program } = analysis;
    const resolved = ts.resolveModuleName
      ? ts.resolveModuleName(
          binding.specifier,
          model.source.fileName,
          program.getCompilerOptions(),
          ts.sys,
        )?.resolvedModule?.resolvedFileName
      : undefined;
    if (!resolved || !analysis.isProjectFile(resolved)) return null;
    const target = program.getSourceFile(resolved);
    const targetModel = [...models.values()].find((m) => m.source === target);
    if (!targetModel) return null;
    const localName = targetModel.exported.get(binding.exportName) ?? binding.exportName;
    return targetModel.schemaBindings.get(localName) ?? null;
  };

  return (name: string, from?: any) => {
    let model: FileModel = owner;
    if (from) {
      const fromModel = [...models.values()].find((m) => m.source === from);
      if (fromModel) model = fromModel;
    }
    return model.schemaBindings.get(name) ?? resolveImported(model, name);
  };
}

interface RouteContract {
  body?: {
    required: boolean;
    content: { mediaType: string; schema: import("../core/types.js").JsonSchema }[];
  };
  parameters: RouteParameter[];
  responses: RouteCandidate["responses"];
}

/**
 * Extracts the declarative contract from a @hono/zod-openapi createRoute({...})
 * object literal. Unresolvable schema nodes are skipped honestly rather than
 * fabricated; handler-derived evidence fills the remaining gaps.
 */
function extractRouteContract(
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  owner: FileModel,
  routeObject: any,
): RouteContract {
  const { ts } = analysis;
  const resolveBinding = makeBindingResolver(analysis, ts, models, owner);
  const toSchema = (node: any, mode: "input" | "output" = "input"): import("../core/types.js").JsonSchema | null =>
    convertZodNode(node, {
      ts,
      sourceFile: owner.source,
      resolveSchemaBinding: resolveBinding,
      mode,
    });

  const result: RouteContract = { parameters: [], responses: [] };

  const request = objectProperty(ts, routeObject, "request");
  if (request && ts.isObjectLiteralExpression(request)) {
    // Body: request.body.content["application/json"].schema
    const bodyNode = objectProperty(ts, request, "body");
    if (bodyNode && ts.isObjectLiteralExpression(bodyNode)) {
      const content = objectProperty(ts, bodyNode, "content");
      const requiredProp = objectProperty(ts, bodyNode, "required");
      const required = requiredProp?.kind === ts.SyntaxKind.TrueKeyword;
      const mediaContent: { mediaType: string; schema: import("../core/types.js").JsonSchema }[] = [];
      if (content && ts.isObjectLiteralExpression(content)) {
        for (const prop of content.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.name)) continue;
          const schemaNode = objectProperty(ts, prop.initializer, "schema");
          if (!schemaNode) continue;
          const schema = toSchema(schemaNode);
          if (schema) mediaContent.push({ mediaType: prop.name.text, schema });
        }
      }
      if (mediaContent.length > 0) result.body = { required, content: mediaContent };
    }

    // Typed parameter groups: params / query / headers, each { schema: ZodObject }.
    const groups: Array<{ key: string; in: "path" | "query" | "header"; required: boolean }> = [
      { key: "params", in: "path", required: true },
      { key: "query", in: "query", required: false },
      { key: "headers", in: "header", required: false },
    ];
    for (const group of groups) {
      const groupNode = objectProperty(ts, request, group.key);
      if (!groupNode || !ts.isObjectLiteralExpression(groupNode)) continue;
      const schemaNode = objectProperty(ts, groupNode, "schema");
      if (!schemaNode) continue;
      const schema = toSchema(schemaNode);
      const props = schema?.properties ?? {};
      const requiredSet = new Set(Array.isArray(schema?.required) ? schema!.required : []);
      for (const [name, propSchema] of Object.entries(props)) {
        result.parameters.push({
          name,
          in: group.in,
          required: group.required || requiredSet.has(name),
          schema: propSchema as import("../core/types.js").JsonSchema,
          confidence: "high",
        });
      }
    }
  }

  // Responses: { 200: { description, content: { "application/json": { schema } } } }
  const responsesNode = objectProperty(ts, routeObject, "responses");
  if (responsesNode && ts.isObjectLiteralExpression(responsesNode)) {
    for (const prop of responsesNode.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const status = resolveStatusName(ts, prop.name);
      if (!status || !ts.isObjectLiteralExpression(prop.initializer)) continue;
      const descriptionNode = objectProperty(ts, prop.initializer, "description");
      const description =
        descriptionNode && ts.isStringLiteralLike(descriptionNode) ? descriptionNode.text : "";
      const content = objectProperty(ts, prop.initializer, "content");
      const mediaContent: RouteCandidate["responses"][number]["content"] = [];
      if (content && ts.isObjectLiteralExpression(content)) {
        for (const mediaProp of content.properties) {
          if (
            !ts.isPropertyAssignment(mediaProp) ||
            !ts.isStringLiteralLike(mediaProp.name)
          ) {
            continue;
          }
          const schemaNode = objectProperty(ts, mediaProp.initializer, "schema");
          if (!schemaNode) continue;
          const schema = toSchema(schemaNode, "output");
          if (schema) {
            mediaContent.push({
              mediaType: mediaProp.name.text,
              schema,
              confidence: "high",
            });
          }
        }
      }
      result.responses.push({
        statusCode: status,
        description,
        confidence: "high",
        ...(mediaContent.length > 0 ? { content: mediaContent } : {}),
      });
    }
  }

  return result;
}

function resolveMountChild(
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  model: FileModel,
  mount: MountEdge,
): string | null {
  // Local Hono var.
  const local = model.nodes.get(mount.childName);
  if (local) return local.id;

  // Imported sub-app.
  const binding = model.imports.get(mount.childName);
  if (!binding) return null;
  const { ts, program } = analysis;
  const resolved = ts.resolveModuleName
    ? ts.resolveModuleName(
        binding.specifier,
        model.source.fileName,
        program.getCompilerOptions(),
        ts.sys,
      )?.resolvedModule?.resolvedFileName
    : undefined;
  if (!resolved || !analysis.isProjectFile(resolved)) return null;
  const target = program.getSourceFile(resolved);
  if (!target) return null;
  const targetModel = [...models.values()].find((m) => m.source === target);
  if (!targetModel) return null;
  const varName = targetModel.exported.get(binding.exportName);
  if (varName && targetModel.nodes.has(varName)) {
    return targetModel.nodes.get(varName)!.id;
  }
  return null;
}

interface HandlerOpts {
  pathParams: Set<string>;
}

interface HandlerResult {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: any[]; confidence: "high" | "medium" | "low" };
  responses: any[];
  gaps: GapCode[];
  sse: boolean;
  handlerSource?: string;
}

function analyzeHonoHandler(
  analysis: TsAnalysis,
  file: string,
  handlerNode: any,
  origin: { file: string; line?: number },
  opts: HandlerOpts,
): HandlerResult {
  const { ts } = analysis;
  const resolved = resolveHandler(analysis, analysis.sourceByPath.get(file)!, handlerNode);
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const seen = new Set<string>();
  const responses = new ResponseCollector();
  let sse = false;
  let bodyReferenced = false;
  let bodySchema: { schema: any; confidence: "high" | "medium" | "low" } | undefined;
  let jsonVarName: string | undefined;
  let hasResponseSite = false;

  if (!resolved) {
    gaps.add("response-unknown");
    for (const name of opts.pathParams) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
    return { parameters, responses: [], gaps: [...gaps], sse: false };
  }

  const { node: handler, file: handlerFile } = resolved;
  const cName = handler.parameters?.[0]?.name?.getText?.(handlerFile) ?? "c";

  // Collect the chain `c.req.query` -> {root: c, names: [req, query]}.
  const chain = (call: any): { root?: string; names: string[] } => {
    let cur = call.expression;
    const names: string[] = [];
    let guard = 0;
    while (cur && ts.isPropertyAccessExpression(cur) && guard++ < 8) {
      names.unshift(cur.name.text);
      cur = cur.expression;
    }
    return { root: ts.isIdentifier(cur) ? cur.text : undefined, names };
  };

  const visit = (node: any) => {
    if (ts.isCallExpression(node)) {
      const { root, names } = chain(node);
      if (root === cName) {
        const method = names[names.length - 1];
        if (names.length === 2 && names[0] === "req") {
          if (method === "query" && ts.isStringLiteralLike(node.arguments[0])) {
            addParam(parameters, seen, "query", node.arguments[0].text, { type: "string" }, "low", false);
          } else if (method === "header" && ts.isStringLiteralLike(node.arguments[0])) {
            addParam(parameters, seen, "header", node.arguments[0].text.toLowerCase(), { type: "string" }, "low", false);
          } else if (method === "json") {
            bodyReferenced = true;
            const typeArg = node.typeArguments?.[0];
            if (typeArg) {
              try {
                const type = analysis.checker.getTypeFromTypeNode(typeArg);
                const fromType = typeToSchema(type, analysis.schemaContext);
                if (fromType && Object.keys(fromType).length) {
                  bodySchema = { schema: fromType, confidence: "high" };
                }
              } catch {
                // untyped body
              }
            }
            if (!bodySchema) {
              // `const param = await c.req.json()` — remember the variable so a
              // later `param as T` assertion can supply the body contract.
              let ancestor: any = node.parent;
              while (ancestor && !ts.isVariableDeclaration(ancestor)) ancestor = ancestor.parent;
              if (ancestor && ts.isIdentifier(ancestor.name)) jsonVarName = ancestor.name.text;
            }
          }
        } else if (names.length === 1) {
          if (method === "json") {
            hasResponseSite = true;
            const arg = node.arguments[0];
            const statusArg = node.arguments[1];
            const status = statusCodeFrom(ts, statusArg) ?? "200";
            if (arg) {
              const { schema, typed } = schemaFromNode(analysis, arg);
              responses.record(status, "application/json", schema, typed ? "high" : "medium");
            } else {
              responses.record(status, "application/json", undefined, "medium");
            }
          } else if (method === "text") {
            hasResponseSite = true;
            responses.record(
              statusCodeFrom(ts, node.arguments[1]) ?? "200",
              "text/plain",
              { type: "string" },
              "high",
            );
          } else if (method === "streamSSE") {
            sse = true;
            // Inspect the SSE callback for stream.writeData(payload).
            const cb = node.arguments[0];
            let itemSchema: any;
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
              const walkWrite = (n: any) => {
                if (
                  ts.isCallExpression(n) &&
                  ts.isPropertyAccessExpression(n.expression) &&
                  n.expression.name.text === "writeData" &&
                  n.arguments[0]
                ) {
                  const { schema } = schemaFromNode(analysis, n.arguments[0]);
                  if (schema) itemSchema = schema;
                }
                ts.forEachChild(n, walkWrite);
              };
              walkWrite(cb.body);
            }
            responses.record("200", "text/event-stream", undefined, "medium", {
              description: "Server-sent events",
              ...(itemSchema ? { itemSchema } : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  if (handler.body) visit(handler.body);

  // Path params declared by the route template always exist.
  for (const name of opts.pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
  }

  // Resolve a body type supplied by a later assertion, e.g.
  // `const param = await c.req.json(); ... param as model.Param`.
  if (!bodySchema && jsonVarName && handler.body) {
    const visitAssertion = (n: any) => {
      if (
        bodySchema === undefined &&
        (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === jsonVarName &&
        n.type
      ) {
        try {
          const type = analysis.checker.getTypeFromTypeNode(n.type);
          const fromType = typeToSchema(type, analysis.schemaContext);
          if (fromType && Object.keys(fromType).length) {
            bodySchema = { schema: fromType, confidence: "high" };
          }
        } catch {
          // unresolvable assertion type
        }
      }
      if (!bodySchema) ts.forEachChild(n, visitAssertion);
    };
    visitAssertion(handler.body);
  }

  let requestBody: HandlerResult["requestBody"];
  if (bodySchema) {
    requestBody = { required: true, content: [{ mediaType: "application/json", schema: bodySchema.schema }], confidence: "high" };
  } else if (bodyReferenced) {
    gaps.add("body-schema-unknown");
  }

  if (!hasResponseSite && !sse) gaps.add("response-unknown");

  let handlerSource: string | undefined;
  try {
    const text = handler.getText(handlerFile) as string;
    handlerSource = text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
  } catch {
    // ignore
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: responses.all(),
    gaps: [...gaps],
    sse,
    handlerSource,
  };
}

function statusCodeFrom(ts: any, node: any | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return node.text;
  return undefined;
}
