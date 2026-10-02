/**
 * Koa framework pack (typescript/javascript).
 *
 * Koa routers come from either `koa-router` or `@koa/router`:
 *   const router = new Router({ prefix: "/api" });
 *   router.get("/users/:id", (ctx) => { ... });
 *   router.prefix("/orders");
 * and are mounted with `app.use(router.routes())`.
 *
 * Handlers receive a single context `ctx`: route params live on `ctx.params`,
 * the query string on `ctx.query`, headers via `ctx.get(...)`, the parsed body
 * on `ctx.request.body`, and the response is assigned to `ctx.body` with an
 * optional `ctx.status = N`. TypeScript types drive component $ref inference;
 * everything unprovable is an honest gap.
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

interface RouterModel {
  id: string;
  file: string;
  varName: string;
  prefix: string;
}

interface RouteReg {
  routerId: string;
  file: string;
  method: string;
  rawPath: string;
  handlerNode: any;
  origin: { file: string; line?: number };
}

interface FileModel {
  rel: string;
  source: any;
  /** Local default-import binding of the Router constructor. */
  ctorNames: Set<string>;
  routers: Map<string, RouterModel>;
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

export const koaPack: FrameworkPack<TsAnalysis> = {
  id: "koa",
  language: "typescript",
  dependencyHints: ["koa", "@koa/router", "koa-router"],

  applies(ctx: ScanContext): boolean {
    const hasDep =
      ctx.manifest.packages.has("koa") ||
      ctx.manifest.packages.has("@koa/router") ||
      ctx.manifest.packages.has("koa-router");
    if (!hasDep) return false;
    // Route-feature dual signal: a Router import and `new Router(...)`.
    return ctx.index.files.some(
      (f) =>
        /from\s+["'](koa-router|@koa\/router)["']|require\(["'](koa-router|@koa\/router)["']\)/.test(
          f.content,
        ) && /new\s+Router\s*\(/.test(f.content),
    );
  },

  extract(analysis: TsAnalysis, _ctx: ScanContext): ExtractionResult {
    const models = new Map<string, FileModel>();
    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const routers = new Map<string, RouterModel>();
    const routes: RouteReg[] = [];
    for (const model of models.values()) {
      for (const r of model.routers.values()) routers.set(r.id, r);
      routes.push(...model.routes);
    }

    const candidates: RouteCandidate[] = [];
    const seenOp = new Map<string, RouteCandidate>();

    for (const route of routes) {
      const router = routers.get(route.routerId);
      const prefix = router?.prefix ?? "";
      const normalized = normalizeColonPath(route.rawPath);
      const fullPath = joinPath(prefix, normalized.path);
      const facts = analyzeKoaHandler(analysis, route.file, route.handlerNode, {
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
        confidence,
        gaps: facts.gaps,
        components: [],
        handlerSource: facts.handlerSource,
      };
      const key = `${candidate.method} ${candidate.fullPath}`;
      if (!seenOp.has(key)) seenOp.set(key, candidate);
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
    routers: new Map(),
    routes: [],
  };

  // import Router from "koa-router" / "@koa/router"
  source.forEachChild((child: any) => {
    if (
      ts.isImportDeclaration(child) &&
      ts.isStringLiteral(child.moduleSpecifier) &&
      (child.moduleSpecifier.text === "koa-router" ||
        child.moduleSpecifier.text === "@koa/router") &&
      child.importClause?.name
    ) {
      model.ctorNames.add(child.importClause.name.text);
    }
  });

  // const Router = require("koa-router") / require("@koa/router")
  source.forEachChild((child: any) => {
    if (!ts.isVariableStatement(child)) return;
    for (const decl of child.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression) &&
        decl.initializer.expression.text === "require" &&
        decl.initializer.arguments[0] &&
        ts.isStringLiteralLike(decl.initializer.arguments[0]) &&
        (decl.initializer.arguments[0].text === "koa-router" ||
          decl.initializer.arguments[0].text === "@koa/router")
      ) {
        model.ctorNames.add(decl.name.text);
      }
    }
  });

  const visit = (node: any) => {
    // const router = new Router({ prefix: "/api" })
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.name) &&
      ts.isIdentifier(node.initializer.expression) &&
      model.ctorNames.has(node.initializer.expression.text)
    ) {
      let prefix = "";
      const arg = node.initializer.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            prop.name?.getText(source) === "prefix" &&
            ts.isStringLiteralLike(prop.initializer)
          ) {
            prefix = prop.initializer.text;
          }
        }
      }
      model.routers.set(node.name.text, {
        id: relId(rel, node.name.text),
        file: rel,
        varName: node.name.text,
        prefix,
      });
    }

    // router.prefix("/api")
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "prefix" &&
      ts.isIdentifier(node.expression.expression) &&
      model.routers.has(node.expression.expression.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const r = model.routers.get(node.expression.expression.text)!;
      r.prefix = joinPath(r.prefix, node.arguments[0].text);
    }

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
  const rootName = access.expression.getText(model.source);
  const router = model.routers.get(rootName);
  if (!router) return;
  const method = access.name.text;
  if (!VERBS.has(method)) return;
  const pathArg = node.arguments[0];
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return;
  const isHandlerLike = (a: any): boolean =>
    Boolean(
      a &&
        (ts.isArrowFunction(a) ||
          ts.isFunctionExpression(a) ||
          ts.isIdentifier(a) ||
          ts.isPropertyAccessExpression(a)),
    );
  // The handler is the LAST handler-like argument (middlewares precede it).
  const handlerNode = [...node.arguments].slice(1).filter(isHandlerLike).pop();
  if (!handlerNode) return;
  model.routes.push({
    routerId: router.id,
    file: model.rel,
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
  handlerSource?: string;
}

function analyzeKoaHandler(
  analysis: TsAnalysis,
  file: string,
  handlerNode: any,
  opts: HandlerOpts,
): HandlerResult {
  const { ts } = analysis;
  const resolved = resolveHandler(analysis, analysis.sourceByPath.get(file)!, handlerNode);
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const seen = new Set<string>();
  const responses = new ResponseCollector();
  let hasResponseSite = false;
  let bodyReferenced = false;
  let bodySchema: { schema: any; confidence: "high" | "medium" | "low" } | undefined;

  if (!resolved) {
    gaps.add("response-unknown");
    for (const name of opts.pathParams) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
    return { parameters, responses: [], gaps: [...gaps] };
  }

  const { node: handler, file: handlerFile } = resolved;
  const ctxName = handler.parameters?.[0]?.name?.getText?.(handlerFile) ?? "ctx";
  let pendingStatus = "200";

  const visit = (node: any) => {
    // const body: UserInput = ctx.request.body
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      isChainRoot(ts, node.initializer, ctxName, ["request", "body"])
    ) {
      bodyReferenced = true;
      try {
        const type = analysis.checker.getTypeFromTypeNode(node.type);
        const schema = typeToSchema(type, analysis.schemaContext);
        if (schema && Object.keys(schema).length) {
          bodySchema = { schema, confidence: "high" };
        }
      } catch {
        // untyped
      }
    }

    // ctx.status = N  /  ctx.body = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const chain = propChain(ts, node.left);
      if (chain.root === ctxName && chain.names.length === 1) {
        if (chain.names[0] === "status" && ts.isNumericLiteral(node.right)) {
          pendingStatus = node.right.text;
        } else if (chain.names[0] === "body") {
          hasResponseSite = true;
          const { schema, typed } = schemaFromNode(analysis, node.right);
          responses.record(pendingStatus, "application/json", schema, typed ? "high" : "medium");
          pendingStatus = "200";
        }
      }
    }

    // ctx.get("X-Token")
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === ctxName &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addParam(
        parameters,
        seen,
        "header",
        node.arguments[0].text.toLowerCase(),
        { type: "string" },
        "low",
        false,
      );
    }

    // ctx.query.q / ctx.request.body (bare reference)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const chain = propChain(ts, node);
      if (chain.root === ctxName) {
        if (chain.names[0] === "query" && chain.names.length === 2) {
          addParam(parameters, seen, "query", chain.names[1]!, { type: "string" }, "low", false);
        } else if (isChainNames(chain.names, ["request", "body"])) {
          bodyReferenced = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  if (handler.body) visit(handler.body);

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

  if (!hasResponseSite) gaps.add("response-unknown");

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
    handlerSource,
  };
}

function propChain(ts: any, node: any): { root?: string; names: string[] } {
  const names: string[] = [];
  let cur: any = node;
  let guard = 0;
  while (cur && ts.isPropertyAccessExpression(cur) && guard++ < 8) {
    names.unshift(cur.name.text);
    cur = cur.expression;
  }
  return { root: ts.isIdentifier(cur) ? cur.text : undefined, names };
}

function isChainNames(names: string[], expected: string[]): boolean {
  return names.length === expected.length && names.every((n, i) => n === expected[i]);
}

function isChainRoot(
  ts: any,
  node: any,
  root: string,
  expected: string[],
): boolean {
  const chain = propChain(ts, node);
  return chain.root === root && isChainNames(chain.names, expected);
}
