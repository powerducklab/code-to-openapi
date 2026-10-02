/**
 * Next.js file-based routes pack (typescript/javascript).
 *
 * Detection is path-convention based (Next.js IS the platform):
 *   - App Router:  app/**\/route.{ts,js,mjs,tsx,jsx} exporting named
 *     HTTP-verbs (GET/POST/PUT/PATCH/DELETE) handlers that receive a
 *     Request/NextRequest and (optionally) a `{ params }` context.
 *   - Pages Router: pages/api/**\/*.{ts,js} default-exporting an
 *     (req, res) handler (Express-style; analyzed by the shared handler pass).
 *
 * Dynamic segments `[id]`, catch-alls `[...slug]` and route groups `(g)` are
 * derived from the file path. Response/body shapes flow from TypeScript types;
 * unprovable values stay honest gaps.
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
import { analyzeHandler } from "./express-handler.js";
import {
  addParam,
  collectComponents,
  locationAt,
  makeOperationId,
  normalizeNextSegment,
  ResponseCollector,
  schemaFromNode,
  tagForPath,
} from "../lang/typescript/httpRoute.js";

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

const APP_ROUTE = /(^|\/)app\/.*\/route\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PAGES_API = /(^|\/)pages\/api\/.+\.(ts|tsx|js|jsx|cjs)$/;

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const nextjsPack: FrameworkPack<TsAnalysis> = {
  id: "nextjs",
  language: "typescript",
  dependencyHints: ["next"],

  applies(ctx: ScanContext): boolean {
    // Next.js is the platform: file-path conventions are the signal. This is
    // distinctive enough that Express/Fastify/Nest projects never match.
    return ctx.index.files.some(
      (f) => APP_ROUTE.test(f.path) || PAGES_API.test(f.path),
    );
  },

  extract(analysis: TsAnalysis, ctx: ScanContext): ExtractionResult {
    const candidates: RouteCandidate[] = [];

    for (const file of ctx.index.files) {
      const source = analysis.sourceByPath.get(file.path);
      if (!source) continue;

      if (APP_ROUTE.test(file.path)) {
        collectAppRouter(analysis, file.path, source, candidates);
      } else if (PAGES_API.test(file.path)) {
        collectPagesRouter(analysis, file.path, source, candidates);
      }
    }

    const seen = new Map<string, RouteCandidate>();
    for (const c of candidates) {
      const key = `${c.method} ${c.fullPath}`;
      if (!seen.has(key)) seen.set(key, c);
    }

    return {
      routes: [...seen.values()],
      unresolved: [],
      components: collectComponents(analysis),
      securitySchemes: [],
      servers: [],
    };
  },
};

/** Converts an App Router file path into an OpenAPI path template. */
function appPathFromFile(rel: string): string {
  let p = rel.replace(/(^|\/)app\//, "/");
  p = p.replace(/\/route\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  return segmentsToPath(p);
}

/** Converts a Pages Router file path into an OpenAPI path template. */
function pagesPathFromFile(rel: string): string {
  let p = rel.replace(/(^|\/)pages\//, "/");
  p = p.replace(/\.(ts|tsx|js|jsx|cjs)$/, "");
  p = p.replace(/\/index$/, "") || "/";
  return segmentsToPath(p);
}

function segmentsToPath(p: string): string {
  const out = p
    .split("/")
    .filter(Boolean)
    .filter((s) => !/^\([^)]*\)$/.test(s)) // route groups: (dashboard)
    .map(normalizeNextSegment);
  return `/${out.join("/")}`;
}

function pathParamsFromPath(fullPath: string): Set<string> {
  const set = new Set<string>();
  for (const m of fullPath.matchAll(/\{([^}]+)\}/g)) set.add(m[1]!);
  return set;
}

function collectAppRouter(
  analysis: TsAnalysis,
  rel: string,
  source: any,
  into: RouteCandidate[],
): void {
  const { ts } = analysis;
  const fullPath = appPathFromFile(rel);
  const pathParams = pathParamsFromPath(fullPath);

  const exportedFns: Array<{ name: string; node: any }> = [];
  source.forEachChild((child: any) => {
    // export async function GET(...) {}
    if (
      ts.isFunctionDeclaration(child) &&
      child.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      child.name
    ) {
      exportedFns.push({ name: child.name.text, node: child });
    }
    // export const GET = async (...) => {}
    if (
      ts.isVariableStatement(child) &&
      child.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of child.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          exportedFns.push({ name: decl.name.text, node: decl.initializer });
        }
      }
    }
  });

  for (const fn of exportedFns) {
    const method = fn.name.toLowerCase();
    if (!VERBS.has(method)) continue;
    const origin = locationAt(ts, source, fn.node, rel);
    const facts = analyzeAppHandler(analysis, source, fn.node, { pathParams });

    const confidence = !facts.gaps.length
      ? "high"
      : facts.gaps.some((g) => g === "response-unknown" || g === "body-unknown")
        ? "low"
        : "medium";

    into.push({
      method,
      path: fullPath,
      fullPath,
      operationId: makeOperationId(method, fullPath),
      origin,
      parameters: facts.parameters,
      ...(facts.requestBody ? { requestBody: facts.requestBody } : {}),
      responses: facts.responses,
      tags: tagForPath(fullPath, rel),
      confidence,
      gaps: facts.gaps,
      components: [],
    });
  }
}

function collectPagesRouter(
  analysis: TsAnalysis,
  rel: string,
  source: any,
  into: RouteCandidate[],
): void {
  const { ts } = analysis;
  const fullPath = pagesPathFromFile(rel);
  const pathParams = pathParamsFromPath(fullPath);

  // Default export handler.
  let handlerNode: any;
  source.forEachChild((child: any) => {
    if (
      ts.isExportAssignment(child) &&
      (ts.isArrowFunction(child.expression) ||
        ts.isFunctionExpression(child.expression) ||
        ts.isIdentifier(child.expression))
    ) {
      handlerNode = child.expression;
    }
  });
  // `export default function handler(...) {}` — a default-exported function
  // declaration (TS keeps the name; the DefaultKeyword is not a modifier).
  if (!handlerNode) {
    source.forEachChild((child: any) => {
      if (
        handlerNode
      ) return;
      if (
        ts.isFunctionDeclaration(child) &&
        child.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        handlerNode = child;
      }
    });
  }
  // export default handlerName -> find the local declaration.
  if (handlerNode && ts.isIdentifier(handlerNode)) {
    const name = handlerNode.text;
    source.forEachChild((child: any) => {
      if (ts.isFunctionDeclaration(child) && child.name?.text === name) {
        handlerNode = child;
      } else if (ts.isVariableStatement(child)) {
        for (const decl of child.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === name &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            handlerNode = decl.initializer;
          }
        }
      }
    });
  }
  if (!handlerNode) return;

  // Method detection: `req.method === "POST"`.
  let method = "get";
  source.forEachChild((child: any) => walkMethod(ts, child, (m) => (method = m)));

  const origin = locationAt(ts, source, handlerNode, rel);
  const facts = analyzeHandler(analysis, source, handlerNode, origin, {
    pathParams,
    validators: [],
  });

  into.push({
    method,
    path: fullPath,
    fullPath,
    operationId: makeOperationId(method, fullPath),
    origin,
    parameters: facts.parameters,
    ...(facts.requestBody ? { requestBody: facts.requestBody } : {}),
    responses: facts.responses,
    tags: tagForPath(fullPath, rel),
    confidence: facts.gaps.length ? "medium" : "high",
    gaps: facts.gaps,
    components: [],
  });
}

function walkMethod(ts: any, node: any, set: (m: string) => void): void {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    const text = node.left.getText?.() ?? "";
    if (/\.method$/.test(text) && ts.isStringLiteralLike(node.right)) {
      const m = node.right.text.toLowerCase();
      if (VERBS.has(m)) set(m);
    }
  }
  ts.forEachChild(node, (c: any) => walkMethod(ts, c, set));
}

interface AppFacts {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: any[]; confidence: "high" | "medium" | "low" };
  responses: any[];
  gaps: GapCode[];
}

function analyzeAppHandler(
  analysis: TsAnalysis,
  source: any,
  handler: any,
  opts: { pathParams: Set<string> },
): AppFacts {
  const { ts } = analysis;
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const seen = new Set<string>();
  const responses = new ResponseCollector();
  let hasResponseSite = false;
  let bodyReferenced = false;
  let bodySchema: { schema: any; confidence: "high" | "medium" | "low" } | undefined;

  const reqName = handler.parameters?.[0]?.name?.getText?.(source) ?? "request";

  const visit = (node: any) => {
    // const body: T = await request.json()
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      isJsonCall(ts, node.initializer, reqName)
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

    // request.nextUrl.searchParams.get("q") / request.headers.get("x-token")
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const receiver = node.expression.expression.getText(source);
      if (/\bsearchParams$/.test(receiver)) {
        addParam(parameters, seen, "query", node.arguments[0].text, { type: "string" }, "low", false);
      } else if (/request\.headers$/.test(receiver) || /\bheaders$/.test(receiver)) {
        addParam(parameters, seen, "header", node.arguments[0].text.toLowerCase(), { type: "string" }, "low", false);
      }
    }

    // Response.json(arg, { status }) / NextResponse.json(arg, { status })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Response" ||
        node.expression.expression.text === "NextResponse")
    ) {
      hasResponseSite = true;
      const arg = node.arguments[0];
      const opts = node.arguments[1];
      const status = statusFromOpts(ts, opts) ?? "200";
      if (arg) {
        const { schema, typed } = schemaFromNode(analysis, arg);
        responses.record(status, "application/json", schema, typed ? "high" : "medium");
      } else {
        responses.record(status, "application/json", undefined, "medium");
      }
    }

    // new Response(null, { status: 204 }) / new NextResponse(...)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "Response" || node.expression.text === "NextResponse")
    ) {
      hasResponseSite = true;
      const status = statusFromOpts(ts, node.arguments?.[1]) ?? "200";
      // new Response(body, opts): a string/body argument is a text payload.
      const bodyArg = node.arguments?.[0];
      if (bodyArg && bodyArg.kind !== ts.SyntaxKind.NullKeyword) {
        const { schema, typed } = schemaFromNode(analysis, bodyArg);
        responses.record(status, "application/json", schema, typed ? "high" : "medium");
      } else {
        responses.record(status, "application/json", undefined, "medium");
      }
    }

    // Bare request.json() reference (untyped body).
    if (isJsonCall(ts, node, reqName)) bodyReferenced = true;

    ts.forEachChild(node, visit);
  };

  if (handler.body) visit(handler.body);

  for (const name of opts.pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam(parameters, seen, "path", name, { type: "string" }, "low");
    }
  }

  let requestBody: AppFacts["requestBody"];
  if (bodySchema) {
    requestBody = { required: true, content: [{ mediaType: "application/json", schema: bodySchema.schema }], confidence: "high" };
  } else if (bodyReferenced) {
    gaps.add("body-schema-unknown");
  }

  if (!hasResponseSite) gaps.add("response-unknown");

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: responses.all(),
    gaps: [...gaps],
  };
}

/** True when node is (await) request.json() — optionally awaited / asserted. */
function isJsonCall(ts: any, node: any, reqName: string): boolean {
  let cur = node;
  // Strip parenthesized type assertions: `(await request.json()) as T`.
  const isUnwrappable = (n: any): boolean =>
    Boolean(
      n &&
        (ts.isAsExpression(n) ||
          ts.isParenthesizedExpression(n) ||
          (typeof ts.isTypeAssertionExpression === "function" && ts.isTypeAssertionExpression(n))),
    );
  while (cur && isUnwrappable(cur)) {
    cur = cur.expression;
  }
  if (ts.isAwaitExpression(cur)) cur = cur.expression;
  if (!ts.isCallExpression(cur)) return false;
  if (!ts.isPropertyAccessExpression(cur.expression)) return false;
  if (cur.expression.name.text !== "json") return false;
  const root = cur.expression.expression;
  return ts.isIdentifier(root) && root.text === reqName;
}

function statusFromOpts(ts: any, opts: any): string | undefined {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
  for (const prop of opts.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name?.getText?.() === "status" &&
      ts.isNumericLiteral(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return undefined;
}
