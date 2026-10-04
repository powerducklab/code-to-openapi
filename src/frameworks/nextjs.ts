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
import { createBindingResolver } from "../lang/typescript/bindings.js";
import { convertZodNode } from "../lang/typescript/zod.js";
import { analyzeHandler } from "./express-handler.js";
import { httpMethodReachability } from '../lang/typescript/httpMethodFlow.js';
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

  const origin = locationAt(ts, source, handlerNode, rel);
  // Pages handlers receive every method. Analyze each reachable method branch;
  // scanning the whole file and keeping the last comparison loses operations.
  for (const method of VERBS) {
  const reachableNodes = httpMethodReachability(analysis, handlerNode, method);
  const facts = analyzeHandler(analysis, source, handlerNode, origin, {
    pathParams,
    validators: [],
    reachableNodes,
  });
  if (reachableNodes.uncertain && !facts.gaps.includes('response-unknown')) facts.gaps.push('response-unknown');
  if (facts.responses.length && facts.responses.every(response => response.statusCode === '405')) continue;

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
  let textBodyReferenced = false;
  const requestUrls = new Set<string>();
  let bodySchema: { schema: any; confidence: "high" | "medium" | "low" } | undefined;

  const reqName = handler.parameters?.[0]?.name?.getText?.(source) ?? "request";
  // Variables holding the parsed request payload: `const json = await req.json()`.
  const jsonVars = new Set<string>();
  // Variables bound from request headers/query, e.g. const sig = req.headers.get("stripe-signature").
  const paramBindings = new Map<string, { location: "header" | "query"; name: string }>();

  const bindingResolver = createBindingResolver({
    ts,
    program: analysis.program,
    isProjectFile: analysis.isProjectFile,
  });
  const resolveSchemaNode = (name: string, from: any): any =>
    bindingResolver.resolve(name, from)?.node ?? null;

  const visit = (node: any) => {
    if (node !== handler && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && node.initializer.expression.getText(source) === "URL" && node.initializer.arguments?.[0]?.getText(source) === `${reqName}.url`) {
      requestUrls.add(node.name.text);
    }
    // const body: T = await request.json()
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      node.initializer &&
      isJsonCall(ts, node.initializer, reqName)
    ) {
      bodyReferenced = true;
      if (ts.isIdentifier(node.name)) jsonVars.add(node.name.text);
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

    // Untyped `const json = await req.json()` (no type annotation).
    if (
      ts.isVariableDeclaration(node) &&
      !node.type &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      isJsonCall(ts, node.initializer, reqName)
    ) {
      bodyReferenced = true;
      jsonVars.add(node.name.text);
    }

    // schema.parse(jsonVar) / schema.safeParse(await req.json()) — the common
    // Next.js + Zod validation idiom; the schema is the request body contract.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "parse" ||
        node.expression.name.text === "safeParse")
    ) {
      const arg = node.arguments[0];
      const referencesJson =
        (arg && ts.isIdentifier(arg) && jsonVars.has(arg.text)) ||
        (arg && isJsonCall(ts, arg, reqName));
      const fromEntries = arg && ts.isCallExpression(arg) && arg.expression.getText(source) === "Object.fromEntries" ? arg.arguments[0] : undefined;
      const queryReceiver = fromEntries && ts.isPropertyAccessExpression(fromEntries) && fromEntries.name.text === "searchParams" ? fromEntries.expression : undefined;
      const referencesQuery = queryReceiver && ((ts.isIdentifier(queryReceiver) && requestUrls.has(queryReceiver.text)) || queryReceiver.getText(source) === `${reqName}.nextUrl`);
      if ((referencesJson || referencesQuery) && node.expression.name.text === "parse") {
        const receiver = node.expression.expression;
        let schemaNode: any = null;
        if (ts.isCallExpression(receiver)) {
          // z.object({...}).parse(...)
          schemaNode = receiver;
        } else if (ts.isIdentifier(receiver)) {
          schemaNode = resolveSchemaNode(receiver.text, source);
        }
        if (schemaNode) {
          const schema = convertZodNode(schemaNode, {
            ts,
            sourceFile: schemaNode.getSourceFile?.() ?? source,
            resolveSchemaBinding: (name: string, from?: any) =>
              resolveSchemaNode(name, from ?? source),
          });
          if (schema && Object.keys(schema).length) {
            if (referencesQuery) {
              for (const [name, property] of Object.entries(schema.properties ?? {})) {
                addParam(parameters, seen, "query", name, property as any, "high", Array.isArray(schema.required) && schema.required.includes(name));
              }
            } else {
              bodyReferenced = true;
              bodySchema = { schema, confidence: "high" };
            }
          }
        }
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
      // Track the variable a header/query value is bound to, so a later
      // `if (!sig) return 4xx` guard can prove it is required.
      const bindingVar = (() => {
        let ancestor: any = node.parent;
        while (ancestor && !ts.isVariableDeclaration(ancestor)) ancestor = ancestor.parent;
        return ancestor && ts.isIdentifier(ancestor.name) ? ancestor.name.text : null;
      })();
      if (/\bsearchParams$/.test(receiver)) {
        addParam(parameters, seen, "query", node.arguments[0].text, { type: "string" }, "low", false);
        if (bindingVar) paramBindings.set(bindingVar, { location: "query", name: node.arguments[0].text });
      } else if (receiver === `${reqName}.headers` || (ts.isCallExpression(node.expression.expression) && importedFrom(analysis, node.expression.expression.expression, "headers", ["next/headers"]))) {
        addParam(parameters, seen, "header", node.arguments[0].text.toLowerCase(), { type: "string" }, "low", false);
        if (bindingVar) paramBindings.set(bindingVar, { location: "header", name: node.arguments[0].text.toLowerCase() });
      }
    }

    // Response.json(arg, { status }) / NextResponse.json(arg, { status })
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      ts.isIdentifier(node.expression.expression) &&
      isFetchResponse(analysis, node.expression.expression)
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
      isFetchResponse(analysis, node.expression)
    ) {
      hasResponseSite = true;
      const status = statusFromOpts(ts, node.arguments?.[1]) ?? "200";
      const bodyArg = node.arguments?.[0];
      if (!bodyArg || bodyArg.kind === ts.SyntaxKind.NullKeyword) {
        responses.recordEmpty(status, "high");
      } else {
        const jsonPayload = ts.isCallExpression(bodyArg) && ts.isPropertyAccessExpression(bodyArg.expression) &&
          bodyArg.expression.name.text === "stringify" && bodyArg.expression.expression.getText(source) === "JSON"
          ? bodyArg.arguments[0] : undefined;
        const explicitMedia = contentTypeFromOpts(ts, node.arguments?.[1]);
        const body = schemaFromNode(analysis, bodyArg);
        const isText = Boolean(jsonPayload) || ts.isStringLiteralLike(bodyArg) || ts.isTemplateExpression(bodyArg) || body.schema?.type === "string";
        const media = explicitMedia ?? (isText ? "text/plain" : "application/octet-stream");
        if (/^(application\/json|[^;]+\+json)(?:;|$)/i.test(media)) {
          const inferred = jsonPayload ? schemaFromNode(analysis, jsonPayload) : undefined;
          responses.record(status, media, inferred?.schema, inferred?.typed ? "high" : "medium");
        } else if (isText) {
          responses.record(status, media, { type: "string" }, "high");
        } else {
          gaps.add("response-schema-unknown");
          responses.record(status, media, undefined, "low");
        }
      }
    }

    if (ts.isNewExpression(node) && importedFrom(analysis, node.expression, "ImageResponse", ["@vercel/og", "next/og", "next/server"])) {
      hasResponseSite = true;
      responses.record(statusFromOpts(ts, node.arguments?.[1]) ?? "200", "image/png", { type: "string", format: "binary" }, "high");
    }

    // NextResponse.redirect(url, status?) / Response.redirect(url, status?) —
    // an empty redirect; the Location target may be dynamic but the status and
    // empty body are deterministic (307 for NextResponse, 302 for native Response).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "redirect" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const ctor = node.expression.expression;
      const isNext = importedFrom(analysis, ctor, "NextResponse", ["next/server"]);
      const isNative = ctor.text === "Response";
      if (isNext || isNative) {
        hasResponseSite = true;
        const second = node.arguments?.[1];
        const status =
          (second && typeof second === "object" && ts.isObjectLiteralExpression(second)
            ? statusFromOpts(ts, second)
            : second && ts.isNumericLiteral(second)
              ? second.text
              : undefined) ?? (isNext ? "307" : "302");
        responses.recordEmpty(status, "high");
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === reqName && node.expression.name.text === "text") textBodyReferenced = true;

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

  // Prove a header/query param is required from an early-exit guard, e.g.
  // `if (!sig || !secret) return new Response(.., { status: 400 })`.
  if (handler.body && paramBindings.size) {
    const exitsEarly = (thenNode: any): boolean => {
      const stmts = ts.isBlock(thenNode) ? thenNode.statements : [thenNode];
      const first = stmts[0];
      return !!first && (ts.isReturnStatement(first) || ts.isThrowStatement(first));
    };
    const requiredKeys = new Set<string>();
    const visitGuard = (n: any) => {
      if (ts.isIfStatement(n) && exitsEarly(n.thenStatement)) {
        const condText = n.expression.getText(source);
        for (const [varName, binding] of paramBindings) {
          const negated =
            new RegExp(`(?:^|[^\\w.!])!\\s*${varName}\\b`).test(condText) ||
            new RegExp(`\\b${varName}\\s*[!=]==?\\s*(?:null|undefined)\\b`).test(condText) ||
            new RegExp(`\\b(?:null|undefined)\\s*[!=]==?\\s*${varName}\\b`).test(condText);
          if (negated) requiredKeys.add(`${binding.location}:${binding.name}`);
        }
      }
      ts.forEachChild(n, visitGuard);
    };
    visitGuard(handler.body);
    for (const p of parameters) {
      if (requiredKeys.has(`${p.in}:${p.name}`)) {
        p.required = true;
        p.confidence = "high";
      }
    }
  }

  let requestBody: AppFacts["requestBody"];
  if (bodySchema) {
    requestBody = { required: true, content: [{ mediaType: "application/json", schema: bodySchema.schema }], confidence: "high" };
  } else if (bodyReferenced) {
    gaps.add("body-schema-unknown");
  } else if (textBodyReferenced) {
    requestBody = { required: true, content: [{ mediaType: "*/*", schema: { type: "string" } }], confidence: "medium" };
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

/** Only literal headers establish a media type; the Fetch string-body default is text/plain. */
function contentTypeFromOpts(ts: any, opts: any): string | undefined {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
  for (const property of opts.properties) {
    if (!ts.isPropertyAssignment(property) || property.name?.getText().replace(/^["']|["']$/g, "") !== "headers") continue;
    if (!ts.isObjectLiteralExpression(property.initializer)) return undefined;
    for (const header of property.initializer.properties) {
      if (ts.isPropertyAssignment(header) && header.name?.getText().replace(/^["']|["']$/g, "").toLowerCase() === "content-type" && ts.isStringLiteralLike(header.initializer)) {
        return header.initializer.text.split(";")[0].trim().toLowerCase();
      }
    }
  }
  return undefined;
}

function importedFrom(analysis: TsAnalysis, identifier: any, name: string, modules: string[]): boolean {
  const { ts } = analysis;
  if (!identifier || !ts.isIdentifier(identifier)) return false;
  const declarations = analysis.checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.some((declaration: any) => {
    if (!ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== name) return false;
    let parent = declaration.parent;
    while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
    return parent && modules.includes(parent.moduleSpecifier.text);
  });
}

function isFetchResponse(analysis: TsAnalysis, identifier: any): boolean {
  if (importedFrom(analysis, identifier, "NextResponse", ["next/server"])) return true;
  if (identifier.text !== "Response") return false;
  const declarations = analysis.checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.every((declaration: any) => !analysis.isProjectFile(declaration.getSourceFile().fileName));
}
