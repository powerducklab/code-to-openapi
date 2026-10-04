/**
 * Elysia (Bun) framework pack (typescript/javascript).
 *
 * Elysia builds an app fluently:
 *   new Elysia().get("/users/:id", ({ params, set }) => data)
 * with `.group("/api", (app) => app.get(...))` for prefixes. Handlers receive a
 * single typed context object; the returned value IS the response body, and
 * status codes are set via `set.status = N`.
 *
 * Contracts declared in the third argument win over handler inference:
 *   .post("/users", handler, {
 *     body: CreateUserDto,
 *     query: t.Object({ ... }),
 *     params: t.Object({ id: t.String() }),
 *     response: { [StatusCodes.CREATED]: UserDto },
 *   })
 * DTOs may be ArkType (`type(...)`), TypeBox (`t.Object(...)`, Elysia's
 * native schema system) or Zod; each is converted syntactically. Unprovable
 * values stay honest gaps; nothing is fabricated.
 */

import type {
  ExtractionResult,
  FrameworkPack,
  GapCode,
  JsonSchema,
  RouteCandidate,
  RouteParameter,
  ScanContext,
} from "../core/types.js";
import type { TsAnalysis } from "../lang/typescript/index.js";
import { elysiaMounts } from "../lang/typescript/elysiaMounts.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";
import { createBindingResolver } from "../lang/typescript/bindings.js";
import { convertArkNode } from "../lang/typescript/arktype.js";
import { convertTypeBoxNode } from "../lang/typescript/typebox.js";
import { convertZodNode } from "../lang/typescript/zod.js";
import { resolveStatusName, STATUS_NAME_MAP } from "../lang/typescript/httpStatus.js";
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

type SchemaKind = "arktype" | "typebox" | "zod" | "unknown";

interface FileModel {
  rel: string;
  source: any;
  ctorNames: Set<string>;
  instanceVars: Map<string, string>; // varName -> id
  /** group callback param names; prefix is resolved by AST ancestry. */
  groupParams: Set<string>;
  /** imported local name -> module specifier. */
  importSpecifiers: Map<string, string>;
  routes: Array<{
    registration: any;
    receiver: string;
    method: string;
    rawPath: string;
    prefix: string;
    handlerNode: any;
    optionsNode: any | null;
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
    const { ts } = analysis;
    const models = new Map<string, FileModel>();
    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const resolver = createBindingResolver({
      ts,
      program: analysis.program,
      isProjectFile: analysis.isProjectFile,
    });
    const modelByFile = new Map<string, FileModel>();
    for (const model of models.values()) {
      modelByFile.set(model.source.fileName, model);
    }

    const resolveBinding = (name: string, from: any) =>
      resolver.resolve(name, from);

    const detectKind = (node: any, file: any, depth = 0): SchemaKind => {
      if (depth > 8 || !node) return "unknown";
      const model = modelByFile.get(file.fileName);
      const specOf = (n: string) => model?.importSpecifiers.get(n) ?? "";

      if (ts.isCallExpression(node)) {
        // type(...) from arktype
        if (ts.isIdentifier(node.expression) && node.expression.text === "type") {
          return specOf("type") === "arktype" ? "arktype" : "unknown";
        }
        // regex(...) from arkregex only appears inside type(...) chains.
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "regex" &&
          specOf("regex") === "arkregex"
        ) {
          return "arktype";
        }
        if (ts.isPropertyAccessExpression(node.expression)) {
          let base = node.expression.expression;
          // Walk member chain to its base identifier.
          while (base && ts.isPropertyAccessExpression(base)) base = base.expression;
          if (base && ts.isIdentifier(base)) {
            const spec = specOf(base.text);
            if (spec === "arktype" || spec === "arkregex") return "arktype";
            if (spec === "elysia" || spec === "@sinclair/typebox") return "typebox";
            if (spec === "zod" || spec === "@hono/zod-openapi") return "zod";
          }
          return detectKind(node.expression.expression, file, depth + 1);
        }
      }

      if (ts.isIdentifier(node)) {
        const target = resolveBinding(node.text, file);
        if (target) return detectKind(target.node, target.file, depth + 1);
        return "unknown";
      }

      if (ts.isObjectLiteralExpression(node)) {
        // Inline contract object: ArkType uses string shorthands for values,
        // TypeBox/Zod always wrap values in calls.
        let sawShorthand = false;
        let sawCall = false;
        const scan = (n: any, d: number) => {
          if (d > 3) return;
          if (ts.isPropertyAssignment(n)) {
            const v = n.initializer;
            if (ts.isStringLiteralLike(v) && /^(string|number|boolean|object|null|unknown|any)/.test(v.text)) {
              sawShorthand = true;
            } else if (ts.isCallExpression(v)) {
              sawCall = true;
            } else if (ts.isObjectLiteralExpression(v)) {
              v.properties.forEach((p: any) => scan(p, d + 1));
            }
          }
        };
        node.properties.forEach((p: any) => scan(p, 0));
        if (sawShorthand && !sawCall) return "arktype";
        if (sawCall) {
          for (const p of node.properties) {
            if (ts.isPropertyAssignment(p) && ts.isCallExpression(p.initializer)) {
              return detectKind(p.initializer, file, depth + 1);
            }
          }
        }
      }

      return "unknown";
    };

    const schemaWarnings = new Set<string>();
    const convertSchema = (node: any, file: any, depth = 0, mode: "input" | "output" = "input"): JsonSchema | null => {
      if (depth > 8 || !node) return null;
      const kind = detectKind(node, file);
      const rc = {
        ts,
        sourceFile: file,
        resolveBinding: (name: string, from?: any) =>
          resolveBinding(name, from ?? file),
        depth: 0,
      };
      if (kind === "arktype") {
        return convertArkNode(node, { ...rc, mode, onUnresolved: message => schemaWarnings.add(`${file.fileName}: ${message}`) });
      }
      if (kind === "typebox") {
        return convertTypeBoxNode(node, rc);
      }
      if (kind === "zod") {
        return convertZodNode(node, {
          ts,
          sourceFile: file,
          resolveSchemaBinding: (name: string, from?: any) =>
            resolveBinding(name, from ?? file)?.node ?? null,
          depth: 0,
          mode,
        });
      }
      return null;
    };

    const mounts = elysiaMounts(analysis);
    const candidates: RouteCandidate[] = [];
    const seenOp = new Map<string, RouteCandidate>();

    for (const model of models.values()) {
      for (const route of model.routes) {
       for (const mountedPrefix of mounts.prefixesFor(route.registration)) {
        // Normalize prefix and route together so `:slug` inside a group
        // prefix becomes `{slug}` as well.
        const prefixNorm = normalizeColonPath(joinPath(mountedPrefix, route.prefix));
        const normalized = normalizeColonPath(route.rawPath);
        const pathParams = new Set<string>([
          ...prefixNorm.params,
          ...normalized.params,
        ]);
        const fullPath = joinPath(prefixNorm.path, normalized.path);
        const facts = analyzeElysiaHandler(analysis, model.rel, route.handlerNode, {
          pathParams,
        });

        const contract = route.optionsNode
          ? parseOptionsContract(
              ts,
              route.optionsNode,
              model.source,
              [...pathParams],
              convertSchema,
            )
          : null;

        // Merge contract (high confidence) over handler inference.
        const parameters = facts.parameters;
        if (contract) {
          for (const p of contract.parameters) {
            const idx = parameters.findIndex(
              (x) => x.in === p.in && x.name === p.name,
            );
            if (idx >= 0) parameters[idx] = p;
            else parameters.push(p);
          }
        }

        let requestBody = facts.requestBody;
        const responseCollector = new ResponseCollector();
        for (const r of facts.responses) {
          for (const media of r.content ?? []) {
            responseCollector.record(
              r.statusCode,
              media.mediaType,
              media.schema,
              r.confidence,
            );
          }
        }
        if (contract) {
          if (contract.requestBody) requestBody = contract.requestBody;
          for (const r of contract.responses) {
            for (const media of r.content ?? []) {
              // Declared response DTOs are authoritative: replace partial
              // handler-inferred schemas instead of keeping the weaker shape.
              responseCollector.replace(
                r.status,
                media.mediaType,
                media.schema,
                "high",
              );
            }
          }
        }

        const gaps = new Set<GapCode>(facts.gaps);
        if (contract) {
          if (contract.requestBody) {
            gaps.delete("body-unknown");
            gaps.delete("body-schema-unknown");
          }
          if (contract.responses.length) {
            gaps.delete("response-unknown");
            gaps.delete("response-schema-unknown");
          }
        }

        const confidence = !gaps.size
          ? "high"
          : [...gaps].some((g) => g === "response-unknown" || g === "body-unknown")
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
          responses: responseCollector.all(),
          tags: tagForPath(fullPath, model.rel),
          confidence,
          gaps: [...gaps],
          components: [],
        };
        const key = `${candidate.method} ${candidate.fullPath}`;
        if (!seenOp.has(key)) seenOp.set(key, candidate);
       }
      }
    }

    return {
      routes: [...seenOp.values()],
      unresolved: [...mounts.unresolved, ...[...schemaWarnings].map(message => ({reason: "body-schema-unknown" as GapCode, message, origin: {file: message.split(": ")[0]!}}))],
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
    groupParams: new Set(),
    importSpecifiers: new Map(),
    routes: [],
  };

  // Track every imported local name and its module specifier so schema
  // libraries can be identified at the declaring file.
  source.forEachChild((child: any) => {
    if (
      ts.isImportDeclaration(child) &&
      ts.isStringLiteral(child.moduleSpecifier)
    ) {
      const specifier = child.moduleSpecifier.text;
      if (child.importClause?.name) {
        model.importSpecifiers.set(child.importClause.name.text, specifier);
      }
      const named = child.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          model.importSpecifiers.set(el.name.text, specifier);
        }
      }
      if (named && ts.isNamespaceImport(named)) {
        model.importSpecifiers.set(named.name.text, specifier);
      }
    }
  });

  // Also recognise `import { Elysia } from "elysia"` for constructor names.
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

    // app.group("/api", (api) => { ... }) — or with an options object
    // between prefix and callback: .group("/api", { detail }, (api) => ...).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "group" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const cb = [...node.arguments].find(
        (a: any) =>
          a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)),
      );
      if (
        cb &&
        cb.parameters[0] &&
        ts.isIdentifier(cb.parameters[0].name)
      ) {
        model.groupParams.add(cb.parameters[0].name.text);
      }
    }

    // <receiver>.<verb>(path, handler, options?)
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
  const method = access.name.text;
  if (!VERBS.has(method)) return;
  // Walk chained verb calls: app.post(...).get(...) -> receiver "app".
  let receiverNode: any = access.expression;
  while (
    receiverNode &&
    ts.isCallExpression(receiverNode) &&
    ts.isPropertyAccessExpression(receiverNode.expression)
  ) {
    receiverNode = receiverNode.expression.expression;
  }
  if (!receiverNode) return;
  let receiver = "";
  let validReceiver = false;
  if (ts.isIdentifier(receiverNode)) {
    receiver = receiverNode.text;
    validReceiver =
      model.instanceVars.has(receiver) || model.groupParams.has(receiver);
  } else if (
    ts.isNewExpression(receiverNode) &&
    ts.isIdentifier(receiverNode.expression) &&
    model.ctorNames.has(receiverNode.expression.text)
  ) {
    // new Elysia().get(...) chained straight off the constructor.
    validReceiver = true;
  }
  if (!validReceiver) return;
  const pathArg = node.arguments[0];
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return;
  const handlerNode = [...node.arguments].find(
    (a: any) => a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)),
  );
  if (!handlerNode) return;
  const optionsNode =
    [...node.arguments].find(
      (a: any) => a && a !== handlerNode && ts.isObjectLiteralExpression(a),
    ) ?? null;
  model.routes.push({
    registration: node,
    receiver,
    method,
    rawPath: pathArg.text,
    prefix: enclosingGroupPrefix(ts, node, model.source),
    handlerNode,
    optionsNode,
    origin: locationAt(ts, model.source, node, model.rel),
  });
}

/**
 * Collects `.group("/x", ..., cb)` prefixes enclosing this call, outermost
 * first. Chained sibling groups each open their own callback, so climbing the
 * parent chain resolves the correct prefix even when every callback reuses the
 * same parameter name (`app`).
 */
function enclosingGroupPrefix(ts: any, node: any, source: any): string {
  const prefixes: string[] = [];
  let cur: any = node;
  while (cur && cur !== source) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const call = cur.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "group"
      ) {
        const p = call.arguments[0];
        if (p && ts.isStringLiteralLike(p)) prefixes.unshift(p.text);
      }
    }
    cur = cur.parent;
  }
  return prefixes.join("");
}

interface Contract {
  requestBody?: { required: boolean; content: any[]; confidence: "high" | "medium" | "low" };
  parameters: RouteParameter[];
  responses: any[];
}

function parseOptionsContract(
  ts: any,
  options: any,
  sourceFile: any,
  pathParamNames: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  convertSchema: (node: any, file: any, depth?: number, mode?: "input" | "output") => JsonSchema | null,
): Contract {
  const out: Contract = { parameters: [], responses: [] };
  const seen = new Set<string>();
  const findProp = (name: string) => {
    for (const prop of options.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
          (ts.isStringLiteralLike(prop.name) && prop.name.text === name))
      ) {
        return prop.initializer;
      }
    }
    return null;
  };

  const bodyNode = findProp("body");
  if (bodyNode) {
    const schema = convertSchema(bodyNode, sourceFile);
    if (schema && Object.keys(schema).length) {
      out.requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema }],
        confidence: "high",
      };
    }
  }

  const addSchemaParams = (
    node: any,
    where: "query" | "path" | "header",
    requiredDefault: boolean,
  ) => {
    const schema = node ? convertSchema(node, sourceFile) : null;
    const properties = (schema as any)?.properties;
    if (!properties) return;
    const requiredList = new Set<string>(
      ((schema as any).required as string[]) ??
        (requiredDefault ? Object.keys(properties) : []),
    );
    for (const [name, propSchema] of Object.entries(properties)) {
      const required = where === "path" ? true : requiredList.has(name);
      addParam(
        out.parameters,
        seen,
        where,
        where === "header" ? name.toLowerCase() : name,
        propSchema as JsonSchema,
        "high",
        required,
      );
    }
  };

  addSchemaParams(findProp("query"), "query", false);
  addSchemaParams(findProp("params"), "path", true);
  addSchemaParams(findProp("headers"), "header", false);

  // Elysia path params are always present even without a params schema.
  for (const name of pathParamNames) {
    addParam(out.parameters, seen, "path", name, { type: "string" }, "high", true);
  }

  const responseNode = findProp("response");
  if (responseNode) {
    if (ts.isObjectLiteralExpression(responseNode)) {
      // { [StatusCodes.CREATED]: Dto, 200: Dto, "200": Dto }
      for (const prop of responseNode.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const status = resolveStatusName(ts, prop.name);
        if (!status) continue;
        const schema = convertSchema(prop.initializer, sourceFile, 0, "output");
        if (!schema) continue;
        out.responses.push({
          status,
          content: [{ mediaType: "application/json", schema, confidence: "high" }],
        });
      }
    } else {
      // Bare schema -> 200.
      const schema = convertSchema(responseNode, sourceFile, 0, "output");
      if (schema) {
        out.responses.push({
          status: "200",
          content: [{ mediaType: "application/json", schema, confidence: "high" }],
        });
      }
    }
  }

  return out;
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
      let bodyExpr = expr;
      let status = (stmt ? statusForReturn(ts, stmt) : undefined);
      // Elysia context helper: return status(201, body).
      if (
        !status &&
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "status"
      ) {
        const codeArg = expr.arguments[0];
        if (codeArg && ts.isNumericLiteral(codeArg)) status = codeArg.text;
        else if (
          codeArg &&
          ts.isPropertyAccessExpression(codeArg) &&
          STATUS_NAME_MAP[codeArg.name.text]
        ) {
          status = STATUS_NAME_MAP[codeArg.name.text];
        }
        if (expr.arguments[1]) bodyExpr = expr.arguments[1];
      }
      status = status ?? "200";
      const { schema, typed } = schemaFromNode(analysis, bodyExpr);
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

  void handlerFile;
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
