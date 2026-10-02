/**
 * Elysia (Bun) framework pack (typescript/javascript).
 *
 * Elysia builds an app fluently:
 *   new Elysia().get("/users/:id", ({ params, set }) => data)
 * with `.group("/api", (app) => app.get(...))` for prefixes. Handlers receive a
 * single typed context object; the returned value IS the response body, and
 * status codes are set via `set.status = N`. The context's static type
 * annotation drives typed `body` / `query` schemas into component $refs.
 *
 * Unprovable values stay honest gaps; nothing is fabricated.
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

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options"]);

interface FileModel {
  rel: string;
  source: any;
  ctorNames: Set<string>;
  instanceVars: Map<string, string>; // varName -> id
  /** group callback param name -> prefix applied inside the callback. */
  groupParams: Map<string, string>;
  routes: Array<{
    receiver: string;
    method: string;
    rawPath: string;
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

export const elysiaPack: FrameworkPack<TsAnalysis> = {
  id: "elysia",
  language: "typescript",
  dependencyHints: ["elysia"],

  applies(ctx: ScanContext): boolean {
    const hasDep = ctx.manifest.packages.has("elysia");
    if (!hasDep) return false;
    return ctx.index.files.some(
      (f) =>
        /from\s+["']elysia["']|require\(["']elysia["']\)|new\s+Elysia\s*[<(]/.test(
          f.content,
        ),
    );
  },

  extract(analysis: TsAnalysis, _ctx: ScanContext): ExtractionResult {
    const models = new Map<string, FileModel>();
    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const candidates: RouteCandidate[] = [];
    const seenOp = new Map<string, RouteCandidate>();

    for (const model of models.values()) {
      for (const route of model.routes) {
        // Prefix: direct instance call -> "", group callback param -> its prefix.
        let prefix = "";
        if (model.groupParams.has(route.receiver)) {
          prefix = model.groupParams.get(route.receiver)!;
        } else if (!model.instanceVars.has(route.receiver)) {
          continue;
        }
        const normalized = normalizeColonPath(route.rawPath);
        const fullPath = joinPath(prefix, normalized.path);
        const facts = analyzeElysiaHandler(analysis, model.rel, route.handlerNode, {
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
          tags: tagForPath(fullPath, model.rel),
          confidence,
          gaps: facts.gaps,
          components: [],
        };
        const key = `${candidate.method} ${candidate.fullPath}`;
        if (!seenOp.has(key)) seenOp.set(key, candidate);
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

function modelFile(analysis: TsAnalysis, rel: string, source: any): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    ctorNames: new Set(["Elysia"]),
    instanceVars: new Map(),
    groupParams: new Map(),
    routes: [],
  };

  // import { Elysia } from "elysia"
  source.forEachChild((child: any) => {
    if (
      ts.isImportDeclaration(child) &&
      ts.isStringLiteral(child.moduleSpecifier) &&
      child.moduleSpecifier.text === "elysia"
    ) {
      const named = child.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (el.name.text === "Elysia" || el.propertyName?.text === "Elysia") {
            model.ctorNames.add(el.name.text);
          }
        }
      }
    }
  });

  const visit = (node: any) => {
    // const app = new Elysia<...>()
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.name) &&
      ts.isIdentifier(node.initializer.expression) &&
      model.ctorNames.has(node.initializer.expression.text)
    ) {
      model.instanceVars.set(node.name.text, `${rel}::${node.name.text}`);
    }

    // app.group("/api", (api) => { ... })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "group" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const cb = node.arguments[1];
      if (
        cb &&
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        cb.parameters[0] &&
        ts.isIdentifier(cb.parameters[0].name)
      ) {
        model.groupParams.set(cb.parameters[0].name.text, node.arguments[0].text);
      }
    }

    // <receiver>.<verb>(path, handler)
    if (ts.isCallExpression(node)) classifyCall(analysis, model, node);
    ts.forEachChild(node, visit);
  };
  source.forEachChild((child: any) => visit(child));

  return model;
}

function classifyCall(analysis: TsAnalysis, model: FileModel, node: any): void {
  const { ts } = analysis;
  if (!ts.isPropertyAccessExpression(node.expression)) return;
  const access = node.expression;
  if (!ts.isIdentifier(access.expression)) return;
  const receiver = access.expression.text;
  const method = access.name.text;
  if (!VERBS.has(method)) return;
  // Must be on an instance var or a group callback param.
  if (!model.instanceVars.has(receiver) && !model.groupParams.has(receiver)) return;
  const pathArg = node.arguments[0];
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return;
  const handlerNode = node.arguments[1];
  if (!handlerNode) return;
  model.routes.push({
    receiver,
    method,
    rawPath: pathArg.text,
    handlerNode,
    origin: locationAt(ts, model.source, node, model.rel),
  });
}

interface HandlerOpts {
  pathParams: Set<string>;
}

interface HandlerResult {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: any[]; confidence: "high" | "medium" | "low" };
  responses: any[];
  gaps: GapCode[];
}

function analyzeElysiaHandler(
  analysis: TsAnalysis,
  file: string,
  handlerNode: any,
  opts: HandlerOpts,
): HandlerResult {
  const { ts, checker } = analysis;
  const resolved = resolveHandler(analysis, analysis.sourceByPath.get(file)!, handlerNode);
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const seen = new Set<string>();
  const responses = new ResponseCollector();
  let hasResponseSite = false;

  if (!resolved) {
    gaps.add("response-unknown");
    for (const name of opts.pathParams) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
    return { parameters, responses: [], gaps: [...gaps] };
  }

  const { node: handler, file: handlerFile } = resolved;
  const ctxParam = handler.parameters?.[0];

  // ---- Static context type annotation -> body + query ----
  let bodySchema: { schema: any } | undefined;
  if (ctxParam?.type) {
    try {
      const ctxType = checker.getTypeFromTypeNode(ctxParam.type);
      const bodyProp = ctxType.getProperty?.("body");
      if (bodyProp) {
        const bt = checker.getTypeOfSymbolAtLocation(bodyProp, ctxParam.type);
        const s = typeToSchema(bt, analysis.schemaContext);
        if (s && Object.keys(s).length) bodySchema = { schema: s };
      }
      const queryProp = ctxType.getProperty?.("query");
      if (queryProp) {
        const qt = checker.getTypeOfSymbolAtLocation(queryProp, ctxParam.type);
        for (const prop of qt.getProperties?.() ?? []) {
          const pt = checker.getTypeOfSymbolAtLocation(prop, ctxParam.type);
          const s = typeToSchema(pt, analysis.schemaContext);
          addParam(parameters, seen, "query", prop.name, s, s && Object.keys(s).length ? "high" : "low", false);
        }
      }
    } catch {
      // untyped context
    }
  }

  const visit = (node: any) => {
    // request.headers.get("x-token")
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "headers" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addParam(parameters, seen, "header", node.arguments[0].text.toLowerCase(), { type: "string" }, "low", false);
    }

    ts.forEachChild(node, visit);
  };

  // Collect return statements and (for arrow expression bodies) the body itself.
  const collectReturns = (fn: any): Array<{ expr: any; stmt: any }> => {
    const out: Array<{ expr: any; stmt: any }> = [];
    if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) {
      out.push({ expr: fn.body, stmt: null });
      return out;
    }
    const walk = (n: any) => {
      if (ts.isReturnStatement(n) && n.expression) out.push({ expr: n.expression, stmt: n });
      ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
    return out;
  };

  if (handler.body) {
    visit(handler.body);
    for (const { expr, stmt } of collectReturns(handler)) {
      hasResponseSite = true;
      const status = (stmt ? statusForReturn(ts, stmt) : undefined) ?? "200";
      const { schema, typed } = schemaFromNode(analysis, expr);
      responses.record(status, "application/json", schema, typed ? "high" : "medium");
    }
  }

  for (const name of opts.pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
  }

  let requestBody: HandlerResult["requestBody"];
  if (bodySchema) {
    requestBody = { required: true, content: [{ mediaType: "application/json", schema: bodySchema.schema }], confidence: "high" };
  }

  if (!hasResponseSite) gaps.add("response-unknown");

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: responses.all(),
    gaps: [...gaps],
  };
}

/**
 * Finds the `X.status = <num>` assignment that directly dominates a return:
 * only a status assignment in the same immediately-containing block that
 * precedes the return counts (so a status set inside an `if` block applies
 * only to the return inside that block, not to later returns).
 */
function statusForReturn(ts: any, ret: any): string | undefined {
  const block = ret.parent;
  if (!block || !ts.isBlock(block)) return undefined;
  let status: string | undefined;
  for (const stmt of block.statements) {
    if (stmt === ret) break;
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(stmt.expression.left) &&
      stmt.expression.left.name.text === "status" &&
      ts.isNumericLiteral(stmt.expression.right)
    ) {
      status = stmt.expression.right.text;
    }
  }
  return status;
}
