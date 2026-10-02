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

interface RouteReg {
  nodeId: string;
  file: string;
  method: string;
  rawPath: string;
  handlerNode: any;
  origin: { file: string; line?: number };
}

interface FileModel {
  rel: string;
  source: any;
  /** Local ctor binding imported from "hono" (usually `Hono`). */
  ctorNames: Set<string>;
  /** Imported binding -> { specifier, exportName }. */
  imports: Map<string, { specifier: string; exportName: string }>;
  nodes: Map<string, HonoNode>;
  /** Exported Hono var: export name -> local var name. */
  exported: Map<string, string>;
  mounts: MountEdge[];
  routes: RouteReg[];
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
    const hasDep = ctx.manifest.packages.has("hono");
    if (!hasDep) return false;
    // Route-feature dual signal: an actual Hono import / `new Hono()` call.
    return ctx.index.files.some((f) =>
      /from\s+["']hono["']|require\(["']hono["']\)|new\s+Hono\s*\(/.test(f.content),
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

    // Resolve mount child references (local vars and imported sub-apps) into
    // concrete node ids.
    const edges: Array<{ parentId: string; prefix: string; childId: string }> = [];
    const incoming = new Set<string>();
    for (const model of models.values()) {
      for (const mount of model.mounts) {
        const childId = resolveMountChild(analysis, models, model, mount);
        if (!childId) continue;
        edges.push({ parentId: mount.parentId, prefix: mount.prefix, childId });
        incoming.add(childId);
      }
    }

    // Compute every prefix-chain reaching each node. Roots are nodes that are
    // never mounted under another app; unreachable nodes are treated as their
    // own root (standalone entry app) so no routes are dropped.
    const prefixes = new Map<string, string[]>();
    const roots = [...allNodes.values()].filter((n) => !incoming.has(n.id));
    const walk = (id: string, prefix: string, seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      const list = prefixes.get(id) ?? [];
      if (!list.includes(prefix)) list.push(prefix);
      prefixes.set(id, list);
      for (const edge of edges.filter((e) => e.parentId === id)) {
        walk(edge.childId, joinPath(prefix, edge.prefix), seen);
      }
    };
    for (const root of roots) walk(root.id, "", new Set());
    for (const node of allNodes.values()) {
      if (!prefixes.has(node.id)) walk(node.id, "", new Set());
    }

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

        const confidence = !facts.gaps.length
          ? "high"
          : facts.gaps.some((g) => g === "response-unknown" || g === "body-unknown")
            ? "low"
            : "medium";

        const candidate: RouteCandidate = {
          method: route.method,
          path: normalized.path,
          fullPath,
          operationId: makeOperationId(route.method, fullPath),
          origin: route.origin,
          parameters: facts.parameters,
          ...(facts.requestBody ? { requestBody: facts.requestBody } : {}),
          responses: facts.responses,
          tags: tagForPath(fullPath, route.file),
          ...(facts.sse ? { extensions: { "x-protocol": "sse" } } : {}),
          confidence,
          gaps: facts.gaps,
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
      unresolved: [],
      components: collectComponents(analysis),
      securitySchemes: [],
      servers: [],
    };
  },
};

function relId(file: string, varName: string): string {
  return `${file}::${varName}`;
}

function modelFile(analysis: TsAnalysis, rel: string, source: any): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    ctorNames: new Set(),
    imports: new Map(),
    nodes: new Map(),
    exported: new Map(),
    mounts: [],
    routes: [],
  };

  // Collect imports: `import { Hono } from "hono"` and relative sub-apps.
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
      } else if (specifier.startsWith(".")) {
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
    // const app = new Hono()
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.name) &&
      ts.isIdentifier(node.initializer.expression) &&
      model.ctorNames.has(node.initializer.expression.text)
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
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        model.ctorNames.has(node.initializer.expression.text)
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
  const rootName = access.expression.getText(model.source);
  const nodeVar = model.nodes.get(rootName);
  if (!nodeVar) return;
  const method = access.name.text;
  const origin = locationAt(ts, model.source, node, model.rel);

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
