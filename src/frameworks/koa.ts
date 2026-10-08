import { staticString } from '../lang/typescript/staticString.js';
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
import { resolveStaticValue } from "../lang/typescript/staticValue.js";
import { koaSchemaRegistry, koaYupBody } from "../lang/typescript/koaYup.js";
import { localReturnSchema } from "../lang/typescript/localFlow.js";
import type {JsonSchema} from "../core/types.js";
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

const VERBS = new Set(["get", "post", "put", "patch", "delete", "del", "options", "head"]);

interface RouterModel {
  id: string;
  file: string;
  varName: string;
  prefix: string;
  dynamicPrefix?: boolean;
  initializer: any;
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

    const byInitializer = new Map([...routers.values()].map(router => [router.initializer, router]));
    const routerOf = (node: any): RouterModel | undefined => {
      const value = resolveStaticValue(analysis, node);
      if (!value) return;
      if (analysis.ts.isCallExpression(value) && analysis.ts.isPropertyAccessExpression(value.expression) && ["routes", "allowedMethods"].includes(value.expression.name.text)) {
        return byInitializer.get(resolveStaticValue(analysis, value.expression.expression));
      }
      return byInitializer.get(value);
    };
    const edges: Array<{parent:string; child:string; prefix:string}> = [];
    for (const model of models.values()) {
      const visit = (node: any) => {
        const {ts}=analysis;
        if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='use'){
          const parent=routerOf(node.expression.expression);
          if(parent){
            const prefix=ts.isStringLiteralLike(node.arguments[0])?node.arguments[0].text:'';
            for(const arg of node.arguments){const child=routerOf(arg);if(child)edges.push({parent:parent.id,child:child.id,prefix});}
          }
        }
        ts.forEachChild(node,visit);
      };model.source.forEachChild(visit);
    }
    const incoming=new Set(edges.filter(e=>e.child!==e.parent).map(e=>e.child));
    const outgoing=new Map<string,typeof edges>();
    for(const edge of edges)outgoing.set(edge.parent,[...(outgoing.get(edge.parent)??[]),edge]);
    const prefixes=new Map<string,string[]>(), visited=new Set<string>();
    const unresolved:ExtractionResult['unresolved']=[];
    const walk=(root:string)=>{
      const stack=[{id:root,prefix:routers.get(root)?.prefix??'',ancestors:new Set<string>()}];
      while(stack.length){
        const {id,prefix,ancestors}=stack.pop()!;
        if (routers.get(id)?.dynamicPrefix) {
          unresolved.push({reason:'path-dynamic',message:'Koa router prefix depends on runtime values',origin:{file:routers.get(id)!.file}});
          continue;
        }
        if(ancestors.has(id)){unresolved.push({reason:'path-dynamic',message:'Cyclic Koa router mount requires review',origin:{file:routers.get(id)?.file??''}});continue;}
        const key=id+'\0'+prefix;if(visited.has(key))continue;
        if(visited.size>=10000){unresolved.push({reason:'path-dynamic',message:'Koa mount expansion exceeded 10000 paths',origin:{file:routers.get(id)?.file??''}});return;}
        visited.add(key);prefixes.set(id,[...(prefixes.get(id)??[]),prefix]);
        const next=new Set(ancestors).add(id);
        for(const edge of outgoing.get(id)??[])stack.push({id:edge.child,prefix:joinPath(prefix,edge.prefix,routers.get(edge.child)?.prefix??''),ancestors:next});
      }
    };
    for(const id of routers.keys())if(!incoming.has(id))walk(id);
    for (const [id, router] of routers) if (!prefixes.has(id) && incoming.has(id)) {
      unresolved.push({reason:'path-dynamic',message:'Koa router has no statically resolved mount path',origin:{file:router.file}});
    }

    const yupRegistry = koaSchemaRegistry(analysis);
    const candidates: RouteCandidate[] = [];
    const seenOp = new Map<string, RouteCandidate>();

    for (const route of routes) {
     for (const prefix of prefixes.get(route.routerId) ?? []) {
      const normalized = normalizeColonPath(route.rawPath);
      const fullPath = joinPath(prefix, normalized.path);
      const facts = analyzeKoaHandler(analysis, route.file, route.handlerNode, {
        pathParams: new Set(normalized.params),
        yupRegistry,
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
      let dynamicPrefix = false;
      const arg = node.initializer.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            prop.name?.getText(source) === "prefix"
          ) {
            const value = staticString(analysis, prop.initializer);
            dynamicPrefix = value === undefined;
            prefix = value ?? "";
          }
        }
      }
      model.routers.set(node.name.text, {
        id: relId(rel, node.name.text),
        file: rel,
        varName: node.name.text,
        prefix,
        dynamicPrefix,
        initializer: node.initializer,
      });
    }

    // router.prefix("/api")
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "prefix" &&
      ts.isIdentifier(node.expression.expression) &&
      model.routers.has(node.expression.expression.text) &&
      node.arguments[0]
    ) {
      const r = model.routers.get(node.expression.expression.text)!;
      const value = staticString(analysis, node.arguments[0]);
      r.dynamicPrefix = r.dynamicPrefix || value === undefined;
      r.prefix = joinPath(r.prefix, value ?? "");
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
  const path = staticString(analysis, pathArg);
  if (path === undefined) return;
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
    method: method === "del" ? "delete" : method,
    rawPath: path,
    handlerNode,
    origin: locationAt(ts, model.source, node, model.rel),
  });
}

interface HandlerOpts {
  pathParams: Set<string>;
  yupRegistry?: Map<string, any>;
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
  const yup = koaYupBody(analysis, handler, opts.yupRegistry ?? new Map());
  bodyReferenced ||= yup.bodyReferenced;
  if(yup.schema)bodySchema={schema:yup.schema,confidence:'medium'};
  if(yup.warnings.size)gaps.add('body-schema-unknown');
  const ctxName = handler.parameters?.[0]?.name?.getText?.(handlerFile) ?? "ctx";
  let pendingStatus = "200";
  const values=new Map<any,JsonSchema>();
  const inferValue=(node:any):JsonSchema|undefined=>{
    if(ts.isAwaitExpression(node))return inferValue(node.expression);
    return yup.validatedValues.get(node)??localReturnSchema(analysis,node,value=>schemaFromNode(analysis,value).schema,true,undefined,values);
  };

  const visit = (node: any) => {
    if(node!==handler.body&&ts.isFunctionLike(node))return;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(node.left)){
      const symbol=analysis.checker.getSymbolAtLocation(node.left);
      if(node.parent?.parent===handler.body){const value=inferValue(node.right);if(value)values.set(symbol,value);else values.delete(symbol);}
      else values.delete(symbol);
    }
    // Track writes to validated values; never retain a stale schema after mutation.
    const writeTarget=ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment?node.left:ts.isDeleteExpression(node)?node.expression:undefined;
    if(writeTarget&&(ts.isPropertyAccessExpression(writeTarget)||ts.isElementAccessExpression(writeTarget))){
      let root=writeTarget.expression;while(ts.isPropertyAccessExpression(root)||ts.isElementAccessExpression(root))root=root.expression;
      const symbol=ts.isIdentifier(root)?analysis.checker.getSymbolAtLocation(root):undefined;
      const previous=values.get(symbol);
      if(previous){
        const direct=writeTarget.expression===root&&node.parent?.parent===handler.body;
        const key=ts.isPropertyAccessExpression(writeTarget)?writeTarget.name.text:writeTarget.argumentExpression&&ts.isStringLiteralLike(writeTarget.argumentExpression)?writeTarget.argumentExpression.text:undefined;
        if(direct&&key&&previous.type==='object'&&previous.properties){
          const properties={...(previous.properties as Record<string,JsonSchema>)};
          const required=new Set(previous.required as string[]??[]);
          if(ts.isDeleteExpression(node)){delete properties[key];required.delete(key);}
          else {properties[key]=node.operatorToken.kind===ts.SyntaxKind.EqualsToken?inferValue(node.right)??{}:{};required.add(key);}
          values.set(symbol,{...previous,properties,required:[...required]});
        }else {values.set(symbol,{description:'Conditional or nested mutation requires response review'});gaps.add('response-unknown');}
      }
    }
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
          const { schema: declared, typed } = schemaFromNode(analysis, node.right);
          const declaration = ts.isIdentifier(node.right) ? analysis.checker.getSymbolAtLocation(node.right)?.valueDeclaration : undefined;
          const explicitlyTyped = declaration?.type || ts.isAsExpression(node.right) ||
            (ts.isCallExpression(node.right) && analysis.checker.getResolvedSignature(node.right)?.declaration?.type);
          const inferred = typed && explicitlyTyped && !values.size ? undefined : inferValue(node.right);
          const schema = inferred ?? declared;
          responses.record(pendingStatus, "application/json", schema, inferred ? "medium" : typed ? "high" : "medium");
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
      node.arguments[0]
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
