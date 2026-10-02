import { jsonSchema } from "@powerduck/x-to-openapi";

import type {
  Confidence,
  DiscoveredMediaType,
  DiscoveredResponse,
  GapCode,
  JsonSchema,
  RouteParameter,
  SourceLocation,
} from "../core/types.js";
import type { TsAnalysis } from "../lang/typescript/index.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";
import { convertZodNode } from "../lang/typescript/zod.js";
import type { ValidatedField } from "../lang/typescript/validate.js";

export interface HandlerFacts {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
  responses: DiscoveredResponse[];
  gaps: GapCode[];
  sse: boolean;
}

interface CollectedField {
  name: string;
  schema?: JsonSchema;
  required?: boolean;
}

/**
 * A monkey-patched Express Response method, e.g.
 *   response.customSuccess = function (status, message, data = null) {
 *     return this.status(status).json({ message, data });
 *   };
 * `paramNames` binds the call arguments positionally; `statusArg`/`bodyArg` are
 * the inner nodes passed to `this.status(...)` / `.json(...)`.
 */
export interface CustomResponseMethod {
  paramNames: string[];
  statusArg?: any;
  bodyArg?: any;
}

/**
 * Scans every project file for monkey-patched Express Response methods of the
 * form
 *   response.<name> = function (<p0>, <p1>, ...) { return this.status(S).json(BODY); };
 * or the arrow equivalent. Returns them keyed by method name so handlers can
 * expand `res.<name>(args)` into a concrete response site.
 */
export function extractCustomResponseMethods(analysis: TsAnalysis): Map<string, CustomResponseMethod> {
  const { ts } = analysis;
  const map = new Map<string, CustomResponseMethod>();

  const inspectFunction = (fn: any): CustomResponseMethod | null => {
    let statusArg: any;
    let bodyArg: any;
    const examineReturn = (ret: any) => {
      if (!ret || !ts.isCallExpression(ret)) return;
      if (ret.expression?.name?.text !== "json") return;
      bodyArg = ret.arguments?.[0];
      const statusCall = ret.expression?.expression;
      if (ts.isCallExpression(statusCall) && statusCall.expression?.name?.text === "status") {
        statusArg = statusCall.arguments?.[0];
      }
    };
    if (ts.isBlock(fn.body)) {
      fn.body.forEachChild((child: any) => {
        if (ts.isReturnStatement(child)) examineReturn(child.expression);
      });
    } else {
      // Arrow function with an expression body.
      examineReturn(fn.body);
    }
    if (!bodyArg) return null;
    const paramNames = (fn.parameters ?? []).map((p: any) => p.name?.getText?.() ?? "");
    return { paramNames, statusArg, bodyArg };
  };

  for (const file of analysis.sourceByPath.values()) {
    file.forEachChild((node: any) => {
      // `response.x = function(){...}` lives inside an ExpressionStatement.
      const binary = ts.isExpressionStatement(node) ? node.expression : node;
      if (!ts.isBinaryExpression(binary)) return;
      node = binary;
      if (node.operatorToken?.kind !== ts.SyntaxKind.EqualsToken) return;
      if (!ts.isPropertyAccessExpression(node.left)) return;
      const methodName = node.left.name.text;
      const fn = node.right;
      if (!(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) return;
      const custom = inspectFunction(fn);
      if (custom && !map.has(methodName)) map.set(methodName, custom);
    });
  }
  return map;
}

const HTTP_VERB_LITERAL = /^\d{3}$/;

function rootIdentifier(ts: any, node: any): string | undefined {
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
}

/** A response site whose observed schema carries no usable shape. */
function isEmptyishSchema(schema: JsonSchema): boolean {
  if (!schema || Object.keys(schema).length === 0) return true;
  if (
    schema.type === "array" &&
    (!schema.items || Object.keys(schema.items as JsonSchema).length === 0)
  ) {
    return true;
  }
  return false;
}

function schemaHasRef(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.$ref) return true;
  const combiners = (schema.oneOf ?? schema.anyOf ?? schema.allOf) as
    | JsonSchema[]
    | undefined;
  if (Array.isArray(combiners)) {
    return combiners.some((s) => schemaHasRef(s));
  }
  if (schema.items) return schemaHasRef(schema.items as JsonSchema);
  return false;
}

function literalToValue(ts: any, node: any, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el: any) => literalToValue(ts, el, depth + 1));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText ? prop.name.getText().replace(/['"]/g, "") : undefined;
        if (name) out[name] = literalToValue(ts, prop.initializer, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

function schemaFromNode(
  analysis: TsAnalysis,
  node: any,
  fallbackLiteral = true,
): { schema?: JsonSchema; typed: boolean } {
  const { ts, checker } = analysis;
  try {
    const type = checker.getTypeAtLocation(node);
    if (type && !(type.flags & ts.TypeFlags.Any) && !(type.flags & ts.TypeFlags.Unknown)) {
      const schema = typeToSchema(type, analysis.schemaContext);
      if (schema && Object.keys(schema).length) return { schema, typed: true };
    }
  } catch {
    // Fall through to literal inference.
  }
  if (fallbackLiteral) {
    const value = literalToValue(ts, node);
    if (value !== undefined) return { schema: jsonSchema(value), typed: false };
  }
  return { typed: false };
}

/** Resolves an identifier to a function-like node across local/imported files. */
/**
 * Resolves an exported symbol `name` to a function-like node declared in
 * `file`, following `export { a } from './x'` and `export * from './x'`
 * re-exports. Only project files are traversed. Returns null when the symbol
 * cannot be grounded in a real declaration.
 */
function findExportedDeclaration(
  analysis: TsAnalysis,
  file: any,
  name: string,
  seen: Set<string>,
): { node: any; file: any } | null {
  const { ts } = analysis;
  if (!file || seen.has(file.fileName)) return null;
  seen.add(file.fileName);

  const findDirect = (sf: any, identifier: string): any => {
    let target: any;
    sf.forEachChild((child: any) => {
      if (target) return;
      if (
        ts.isFunctionDeclaration(child) &&
        child.name?.text === identifier
      ) {
        target = child;
      }
      if (ts.isVariableStatement(child)) {
        for (const decl of child.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === identifier &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer))
          ) {
            target = decl.initializer;
          }
        }
      }
      if (
        ts.isExportAssignment(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === identifier
      ) {
        target = child.expression;
      }
    });
    return target;
  };

  const localDirect = findDirect(file, name);
  if (localDirect) return { node: localDirect, file };

  // Collect every re-export that could carry `name`:
  //  - `export { a as b } from './x'` (named, matching public name)
  //  - `export * from './x'` (wildcard re-exports the whole target module)
  // Wildcards must all be tried in order: a barrel such as
  //   export * from './changePassword'; export * from './login';
  // re-exports `login` from the second file, not the first.
  const candidates: { spec: string; orig: string }[] = [];
  file.forEachChild((child: any) => {
    if (!ts.isExportDeclaration(child)) return;
    const moduleSpec = child.moduleSpecifier;
    if (!moduleSpec || !ts.isStringLiteral(moduleSpec)) return;
    if (!child.exportClause) {
      candidates.push({ spec: moduleSpec.text, orig: name });
      return;
    }
    if (ts.isNamedExports(child.exportClause)) {
      for (const el of child.exportClause.elements) {
        const exported = el.propertyName?.text ?? el.name.text;
        if (exported === name) {
          candidates.push({ spec: moduleSpec.text, orig: el.name.text });
          return;
        }
      }
    }
  });

  for (const candidate of candidates) {
    const resolved = ts.resolveModuleName
      ? ts.resolveModuleName(
          candidate.spec,
          file.fileName,
          analysis.program.getCompilerOptions(),
          ts.sys,
        )?.resolvedModule?.resolvedFileName
      : undefined;
    if (!resolved || !analysis.isProjectFile(resolved)) continue;
    const target = analysis.program.getSourceFile(resolved);
    if (!target) continue;
    const nested = findExportedDeclaration(
      analysis,
      target,
      candidate.orig,
      seen,
    );
    if (nested) return nested;
  }
  return null;
}

export { findExportedDeclaration };

/**
 * Resolves a property name against CommonJS module exports that are an object
 * literal (`module.exports = { login(req,res){...} }`) or direct property
 * assignments (`exports.login = function...`). Returns the function-like node.
 */
function findExportedObjectMethod(
  analysis: TsAnalysis,
  file: any,
  name: string,
): { node: any; file: any } | null {
  const { ts } = analysis;
  let found: any;

  const lookInObject = (obj: any) => {
    if (!obj || !ts.isObjectLiteralExpression(obj)) return;
    for (const prop of obj.properties) {
      // Shorthand `{ login }`, method `login(req,res){}`, or `login: function(){}`.
      const propName =
        ts.isShorthandPropertyAssignment(prop)
          ? prop.name.text
          : ts.isMethodDeclaration(prop) || ts.isPropertyAssignment(prop)
            ? prop.name?.text
            : undefined;
      if (propName !== name) continue;
      if (ts.isMethodDeclaration(prop)) {
        found = prop;
      } else if (ts.isPropertyAssignment(prop)) {
        found = prop.initializer;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        found = prop.name;
      }
      return;
    }
  };

  file.forEachChild((child: any) => {
    if (found) return;
    if (!ts.isExpressionStatement(child)) return;
    const expr = child.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const lhs = expr.left;
    // module.exports = { ... }
    if (
      ts.isPropertyAccessExpression(lhs) &&
      lhs.expression.getText(file) === "module" &&
      lhs.name.text === "exports"
    ) {
      lookInObject(expr.right);
      return;
    }
    // exports.login = function... / module.exports.login = function...
    const lhsText = lhs.getText(file);
    if (
      ts.isPropertyAccessExpression(lhs) &&
      (lhsText === `exports.${name}` || lhsText === `module.exports.${name}`) &&
      (ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right) || ts.isFunctionDeclaration(expr.right))
    ) {
      found = expr.right;
    }
  });

  return found ? { node: found, file } : null;
}

export function resolveHandler(
  analysis: TsAnalysis,
  sourceFile: any,
  node: any,
  seen: Set<string> = new Set(),
): { node: any; file: any } | null {
  const { ts } = analysis;
  if (!node) return null;

  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    return { node, file: sourceFile };
  }

  // Namespaced handler: `controllers.login` where `controllers` is an imported
  // namespace (`import * as controllers from './controllers'`).
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const imported = resolveImportedFile(
      analysis,
      sourceFile,
      node.expression.text,
    );
    if (!imported) return null;
    const decl = findExportedDeclaration(
      analysis,
      imported.file,
      node.name.text,
      new Set(),
    );
    if (decl) return decl;
    // CommonJS controller object: `module.exports = { login(req,res){} }`.
    return findExportedObjectMethod(analysis, imported.file, node.name.text);
  }

  if (!ts.isIdentifier(node)) return null;
  const key = `${sourceFile.fileName}:${node.text}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const local = findExportedDeclaration(
    analysis,
    sourceFile,
    node.text,
    new Set(),
  );
  if (local) return local;

  // Follow imports / requires into other project files.
  const imported = resolveImportedFile(analysis, sourceFile, node.text);
  if (imported) {
    const { file, exportName } = imported;
    if (exportName !== "*") {
      const target = findExportedDeclaration(
        analysis,
        file,
        exportName,
        new Set(),
      );
      if (target) return target;
    }
    // module.exports = function ...
    let exported: any;
    file.forEachChild((child: any) => {
      if (exported) return;
      if (
        ts.isExpressionStatement(child) &&
        ts.isBinaryExpression(child.expression) &&
        child.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const lhs = child.expression.left;
        if (
          ts.isPropertyAccessExpression(lhs) &&
          ((lhs.expression.getText(file) === "module" && lhs.name.text === "exports") ||
            lhs.expression.getText(file) === "exports")
        ) {
          const rhs = child.expression.right;
          if (ts.isArrowFunction(rhs) || ts.isFunctionExpression(rhs) ||
              ts.isFunctionDeclaration(rhs)) {
            exported = rhs;
          } else if (ts.isIdentifier(rhs)) {
            const nested = resolveHandler(analysis, file, rhs, seen);
            if (nested) exported = nested.node;
          }
        }
      }
    });
    if (exported) return { node: exported, file };
  }

  return null;
}

export function resolveImportedFile(
  analysis: TsAnalysis,
  sourceFile: any,
  localName: string,
): { file: any; exportName: string } | null {
  const { ts, program } = analysis;
  let specifier: string | undefined;
  let exportName = "default";

  sourceFile.forEachChild((child: any) => {
    if (specifier || !ts.isImportDeclaration(child) || !child.importClause) return;
    const moduleSpec = child.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpec)) return;
    const bindings = child.importClause.namedBindings;
    if (child.importClause.name?.text === localName) {
      specifier = moduleSpec.text;
      exportName = "default";
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.text === localName) {
          specifier = moduleSpec.text;
          exportName =
            element.propertyName?.text ?? element.name.text;
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      // `import * as controllers from './controllers'`
      if (bindings.name.text === localName) {
        specifier = moduleSpec.text;
        exportName = "*";
      }
    }
  });

  if (!specifier) {
    // const x = require('./m') — only accept the require that initializes a
    // variable whose name matches localName (not the first require in file).
    sourceFile.forEachChild((child: any) => {
      if (specifier) return;
      if (!ts.isVariableStatement(child)) return;
      for (const decl of child.declarationList.declarations) {
        if (specifier) return;
        if (!ts.isIdentifier(decl.name) || decl.name.text !== localName) continue;
        const init = decl.initializer;
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          ts.isStringLiteral(init.arguments[0])
        ) {
          specifier = init.arguments[0].text;
          exportName = "module";
        }
      }
    });
  }

  if (!specifier) return null;
  // Do NOT require a relative specifier: tsconfig `baseUrl` / `paths` aliases
  // (e.g. `controllers/auth`) resolve to project files. External packages are
  // still filtered out by the `isProjectFile` check below.
  const resolved = ts.resolveModuleName
    ? ts.resolveModuleName(specifier, sourceFile.fileName, program.getCompilerOptions(), ts.sys)
        ?.resolvedModule?.resolvedFileName
    : undefined;
  if (!resolved) return null;
  const target = program.getSourceFile(resolved);
  if (!target || !analysis.isProjectFile(resolved)) return null;

  if (exportName === "module") {
    // module.exports = <ident>
    let routerName: string | undefined;
    target.forEachChild((child: any) => {
      if (
        ts.isExpressionStatement(child) &&
        ts.isBinaryExpression(child.expression) &&
        ts.isPropertyAccessExpression(child.expression.left) &&
        child.expression.left.expression.getText(target) === "module" &&
        child.expression.left.name.text === "exports" &&
        ts.isIdentifier(child.expression.right)
      ) {
        routerName = child.expression.right.text;
      }
    });
    if (routerName) exportName = routerName;
  }

  return { file: target, exportName };
}

function mergeFields(fields: CollectedField[]): JsonSchema | undefined {
  if (!fields.length) return undefined;
  const properties: Record<string, JsonSchema> = {};
  for (const field of fields) {
    properties[field.name] = field.schema ?? {};
  }
  return { type: "object", properties };
}

function responseKey(status: string, mediaType: string): string {
  return `${status}:${mediaType}`;
}

/**
 * Analyzes a resolved request handler for parameters, request body, responses
 * and SSE event streams. Type information wins; syntactic signals fill gaps
 * and never fabricate shapes.
 */
export function analyzeHandler(
  analysis: TsAnalysis,
  file: any,
  handler: any,
  origin: SourceLocation,
  context: {
    pathParams: Set<string>;
    validators: ValidatedField[];
    bodyReferencedHint?: boolean;
    customResponseMethods?: Map<string, CustomResponseMethod>;
  },
): HandlerFacts {
  const { ts, checker } = analysis;
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const paramNames = new Map<string, RouteParameter>();

  const reqName = handler.parameters?.[0]?.name?.getText?.(file) ?? "req";
  const resName = handler.parameters?.[1]?.name?.getText?.(file) ?? "res";

  // In plain JavaScript the checker only knows Express's library-wide
  // generics (query: string | Query | Array, etc.). Those are not user
  // contracts and must not be reported as typed fields; rely on syntax.
  const reqParam = handler.parameters?.[0];
  const hasJsDocType = Boolean(
    reqParam?.jsDoc?.some?.((d: any) =>
      d.tags?.some?.((tag: any) => tag.tagName?.text === "param" || tag.typeExpression),
    ),
  );
  const trustInferredReqTypes = !(
    (file.scriptKind === ts.ScriptKind.JS ||
      file.scriptKind === ts.ScriptKind.JSX) &&
    !reqParam?.type &&
    !hasJsDocType
  );

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema?: JsonSchema,
    confidence: Confidence = "medium",
    required = location === "path",
  ) => {
    const key = `${location}:${name}`;
    if (paramNames.has(key)) {
      const existing = paramNames.get(key)!;
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
    paramNames.set(key, param);
    parameters.push(param);
  };

  // ---- Express generics: Request<P, ResBody, ReqBody, ReqQuery> ----
  let genericBody: JsonSchema | undefined;
  let genericQuery: JsonSchema | undefined;
  let genericResponse: JsonSchema | undefined;
  const reqType = handler.parameters?.[0]?.type;
  const resType = handler.parameters?.[1]?.type;
  if (reqType && ts.isTypeReferenceNode(reqType) && reqType.typeArguments?.length) {
    const [p, resBody, reqBody, reqQuery] = reqType.typeArguments;
    if (p) applyGenericParams(p, "path");
    if (reqBody) genericBody = genericSchema(reqBody);
    if (reqQuery) genericQuery = genericSchema(reqQuery);
    if (resBody) genericResponse = genericSchema(resBody);
  }
  if (
    resType &&
    ts.isTypeReferenceNode(resType) &&
    resType.typeArguments?.[0]
  ) {
    genericResponse ??= genericSchema(resType.typeArguments[0]);
  }

  function genericSchema(node: any): JsonSchema | undefined {
    try {
      const type = checker.getTypeFromTypeNode(node);
      const schema = typeToSchema(type, analysis.schemaContext);
      return schema && Object.keys(schema).length ? schema : undefined;
    } catch {
      return undefined;
    }
  }

  function applyGenericParams(node: any, location: RouteParameter["in"]) {
    try {
      const type = checker.getTypeFromTypeNode(node);
      for (const prop of type.getProperties()) {
        const propType = checker.getTypeOfSymbolAtLocation(prop, node);
        const schema = typeToSchema(propType, analysis.schemaContext);
        addParam(location, prop.name, schema, "high");
      }
    } catch {
      // Generic unresolvable; syntactic pass below still finds accesses.
    }
  }

  const queryFields: CollectedField[] = [];
  const headerFields: CollectedField[] = [];
  const cookieFields: CollectedField[] = [];
  const bodyFields: CollectedField[] = [];
  let bodyReferenced = Boolean(context.bodyReferencedHint);
  let zodBody: { schema: JsonSchema; confidence: Confidence } | undefined;

  // ---- express-validator middleware chains ----
  for (const validator of context.validators) {
    const location =
      validator.location === "params"
        ? "path"
        : validator.location === "cookies"
          ? "cookie"
          : validator.location;
    addParam(
      location as RouteParameter["in"],
      validator.name,
      validator.schema,
      "high",
      validator.required || location === "path",
    );
  }

  if (genericQuery) {
    // Query interfaces are hoisted as $ref components; dereference them so
    // every declared field (including optional ones) becomes a parameter.
    const querySchema = genericQuery as JsonSchema;
    const refName = typeof querySchema.$ref === "string" ? querySchema.$ref.match(/[^/]+$/)?.[0] : null;
    const dereferenced = refName
      ? analysis.schemaContext.components.get(refName)
      : querySchema;
    const requiredSet = new Set<string>(
      Array.isArray(dereferenced?.required) ? (dereferenced!.required as string[]) : [],
    );
    for (const [name, schema] of Object.entries(dereferenced?.properties ?? {})) {
      queryFields.push({ name, schema: schema as JsonSchema, required: requiredSet.has(name) });
    }
  }

  // ---- response collection ----
  const responses = new Map<string, DiscoveredResponse>();
  let sseSignaled = false;
  const sseEvents = new Map<string, JsonSchema | undefined>();
  let ssePayload: { schema?: JsonSchema; typed: boolean } | undefined;
  let hasResponseSite = false;

  function recordResponse(
    status: string,
    mediaType: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
  ) {
    hasResponseSite = true;
    const key = responseKey(status, mediaType);
    const existing = responses.get(key);
    const media: DiscoveredMediaType = { mediaType };
    if (schema && Object.keys(schema).length) media.schema = schema;
    if (existing) {
      const existingMedia = existing.content?.find((m) => m.mediaType === mediaType);
      if (existingMedia && !existingMedia.schema && media.schema) {
        existingMedia.schema = media.schema;
      }
      if (confidence === "high") existing.confidence = "high";
    } else {
      responses.set(key, {
        statusCode: status,
        description: "",
        confidence,
        content: [media],
      });
    }
  }

  // ---- Local-variable tracking (pure-JS friendly) ----
  // Collect `const x = <expr>` declarations lexically inside the handler body so
  // `res.json(localVar)` can be grounded to a concrete shape. Nested-block
  // assignments are kept first-wins; this is a within-function heuristic.
  const localAssignments = new Map<string, any>();
  (function collectLocals(node: any): void {
    if (!node) return;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          if (!localAssignments.has(decl.name.text)) {
            localAssignments.set(decl.name.text, decl.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, collectLocals);
  })(handler.body);

  type Bindings = Map<string, any>;

  /**
 * Resolves a value node to a JSON schema using only local information:
 * literals, object/array literals, local variable assignments, req.body/query/
 * params references, ternaries and literal merges. Truly dynamic values
 * (calls, awaited repos, external clients) yield an empty schema honestly.
 */
  function resolveLocalValue(
    node: any,
    bindings: Bindings = new Map(),
    depth = 0,
  ): JsonSchema | undefined {
    if (!node || depth > 12) return undefined;

    // Template string → string.
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { type: "string" };
    }
    // Identifier: follow bindings, then local assignments.
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (bindings.has(name)) return resolveLocalValue(bindings.get(name), bindings, depth + 1);
      if (localAssignments.has(name)) {
        return resolveLocalValue(localAssignments.get(name), bindings, depth + 1);
      }
      return undefined;
    }
    // Literal (string/number/bool/null/array/object handled below).
    if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) {
      const value = literalToValue(ts, node);
      if (value !== undefined) return jsonSchema(value);
    }
    // Object literal, including spread merges.
    if (ts.isObjectLiteralExpression(node)) {
      const props: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const spread = resolveLocalValue(prop.expression, bindings, depth + 1);
          if (spread?.properties) Object.assign(props, spread.properties as Record<string, JsonSchema>);
          continue;
        }
        let key: string | undefined;
        let init: any;
        if (ts.isPropertyAssignment(prop)) {
          key = prop.name?.getText(file)?.replace(/['"]/g, "");
          init = prop.initializer;
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          key = prop.name.text;
          init = prop.name;
        }
        if (!key) continue;
        const val = resolveLocalValue(init, bindings, depth + 1);
        props[key] = val ?? {};
        if (val) required.push(key);
      }
      if (!Object.keys(props).length) return undefined;
      return { type: "object", properties: props, ...(required.length ? { required } : {}) };
    }
    // Array literal.
    if (ts.isArrayLiteralExpression(node)) {
      const itemSchemas = node.elements
        .map((el: any) => resolveLocalValue(el, bindings, depth + 1))
        .filter((s: JsonSchema | undefined): s is JsonSchema => Boolean(s));
      return { type: "array", items: itemSchemas[0] ?? {} };
    }
    // Property access: req.body.x, localVar.x, localVar.nested.prop.
    if (ts.isPropertyAccessExpression(node)) {
      const base = node.expression;
      const propName = node.name.text;
      if (ts.isPropertyAccessExpression(base)) {
        const root = rootIdentifier(ts, base);
        const container = base.name?.text;
        if (root === reqName && container === "body") {
          return { type: "object", properties: { [propName]: {} } };
        }
        if (root === reqName && (container === "query" || container === "params")) {
          return { type: "string" };
        }
      }
      const baseSchema = resolveLocalValue(base, bindings, depth + 1);
      if (baseSchema?.type === "object" && baseSchema.properties) {
        const picked = (baseSchema.properties as Record<string, JsonSchema>)[propName];
        if (picked) return picked;
      }
      return undefined;
    }
    // Ternary: union of both branches.
    if (ts.isConditionalExpression(node)) {
      const whenTrue = resolveLocalValue(node.whenTrue, bindings, depth + 1);
      const whenFalse = resolveLocalValue(node.whenFalse, bindings, depth + 1);
      if (whenTrue && whenFalse) return { anyOf: [whenTrue, whenFalse] };
      return whenTrue ?? whenFalse;
    }
    // Call expression / awaited value / external: honest opaque.
    return undefined;
  }


  function collectDestructure(
    accessNode: any,
    target: CollectedField[],
    marksBody = false,
  ) {
    const declaration = accessNode.parent;
    const pattern = declaration?.name;
    if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      let schema: JsonSchema | undefined;
      try {
        if (trustInferredReqTypes) {
          const type = checker.getTypeAtLocation(element.name);
          if (type && !(type.flags & ts.TypeFlags.Any)) {
            schema = typeToSchema(type, analysis.schemaContext);
          }
        }
      } catch {
        // no type info
      }
      target.push({ name: element.name.text, schema });
      if (marksBody) bodyReferenced = true;
    }
  }

  // Content type set on `res` persists until the response is sent, so a
  // standalone res.type()/res.setHeader() applies to every later res.send().
  let handlerContentType: string | undefined;
  let handlerSse = false;
  const captureContentTypeValue = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const value = raw.replace(/['"]/g, "").trim().toLowerCase();
    if (!value || value.includes("${")) return undefined;
    // Keep only the media type, dropping charset/boundary parameters.
    return value.split(";")[0]!.trim();
  };

  const visit = (node: any) => {
    // Property access on req / res.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = rootIdentifier(ts, node);
      if (root === reqName) {
        const fullText = node.getText(file);
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined;

        if (member || /^req\.(params|query|body)$/.test(fullText)) {
          let schema: JsonSchema | undefined;
          try {
            if (trustInferredReqTypes) {
              const type = checker.getTypeAtLocation(node);
              if (type && !(type.flags & ts.TypeFlags.Any)) {
                schema = typeToSchema(type, analysis.schemaContext);
              }
            }
          } catch {
            // no type info
          }
          const destructured =
            ts.isVariableDeclaration(node.parent) &&
            ts.isObjectBindingPattern(node.parent.name);
          if (/^req\.params(\.|\[|$)/.test(fullText)) {
            if (fullText === "req.params" && destructured) {
              const pathFields: CollectedField[] = [];
              collectDestructure(node, pathFields);
              for (const field of pathFields) {
                addParam("path", field.name, field.schema, field.schema ? "high" : "low");
              }
            } else if (member && member !== "params") {
              addParam("path", member, schema, schema ? "high" : "low");
            }
          } else if (/^req\.query(\.|\[|$)/.test(fullText)) {
            if (fullText === "req.query" && destructured) {
              collectDestructure(node, queryFields);
            } else if (member && member !== "query") {
              queryFields.push({ name: member, schema });
            }
          } else if (/^req\.headers(\.|\[|$)/.test(fullText)) {
            if (member && member !== "headers") {
              headerFields.push({ name: member, schema });
            }
          } else if (/^req\.cookies(\.|\[|$)/.test(fullText)) {
            if (member && member !== "cookies") {
              cookieFields.push({ name: member, schema });
            }
          } else if (/^req\.body(\.|\[|$)/.test(fullText)) {
            bodyReferenced = true;
            if (fullText === "req.body" && destructured) {
              collectDestructure(node, bodyFields, true);
            } else if (member && member !== "body") {
              bodyFields.push({ name: member, schema });
            }
          }
        }
      }
    }

    // req.get('X') / req.header('X')
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      rootIdentifier(ts, node.expression.expression) === reqName &&
      ["get", "header"].includes(node.expression.name.text) &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      headerFields.push({ name: node.arguments[0].text.toLowerCase() });
    }

    // zod: schema.parse(req.body) / schema.safeParse(req.body)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["parse", "safeParse"].includes(node.expression.name.text) &&
      node.arguments.some(
        (arg: any) => arg.getText(file).replace(/\s+$/, "") === `${reqName}.body`,
      )
    ) {
      const schemaNode = node.expression.expression;
      const resolveBinding = (name: string, fromFile: any): any => {
        const imported = resolveImportedFile(analysis, fromFile, name);
        const searchFile = imported?.file ?? fromFile;
        let initializer: any;
        searchFile.forEachChild((child: any) => {
          if (initializer || !ts.isVariableStatement(child)) return;
          for (const decl of child.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === (imported?.exportName ?? name)) {
              initializer = decl.initializer;
            }
          }
        });
        return initializer ?? null;
      };
      const schema = convertZodNode(schemaNode, {
        ts,
        sourceFile: file,
        resolveSchemaBinding: (name, from) => resolveBinding(name, from ?? file),
      });
      if (schema) zodBody = { schema, confidence: "high" };
    }

    // res.* chains
    if (ts.isCallExpression(node)) {
      // Standalone content-type setters: res.type("text/csv"),
      // res.setHeader("Content-Type", ...), res.header("Content-Type", ...).
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(ts, node.expression.expression) === resName
      ) {
        const setter = node.expression.name.text;
        if (setter === "type") {
          const captured = captureContentTypeValue(node.arguments[0]?.getText(file));
          if (captured) {
            handlerContentType = captured;
            if (captured.includes("text/event-stream")) handlerSse = true;
          }
        } else if (
          (setter === "setHeader" || setter === "header") &&
          node.arguments[0]?.getText(file)?.replace(/['"]/g, "").toLowerCase() ===
            "content-type"
        ) {
          const captured = captureContentTypeValue(node.arguments[1]?.getText(file));
          if (captured) {
            handlerContentType = captured;
            if (captured.includes("text/event-stream")) handlerSse = true;
          }
        }
      }

      const chain: Array<{ name: string; args: any[] }> = [];
      let cur: any = node;
      let chainRoot: string | undefined;
      while (
        cur &&
        ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression)
      ) {
        chain.unshift({ name: cur.expression.name.text, args: [...cur.arguments] });
        chainRoot = rootIdentifier(ts, cur.expression.expression);
        cur = cur.expression.expression;
      }
      if (chainRoot === resName) handleResChain(chain);
    }

    ts.forEachChild(node, visit);
  };

  function handleResChain(chain: Array<{ name: string; args: any[] }>) {
    let status = "200";
    let sse = handlerSse;
    let explicitType: string | undefined = handlerContentType;
    const captureContentType = (raw: string | undefined) => {
      const captured = captureContentTypeValue(raw);
      if (!captured) return;
      explicitType = captured;
      if (captured.includes("text/event-stream")) sse = true;
    };
    for (const step of chain) {
      if (step.name === "status") {
        const raw = step.args[0]?.getText(file);
        if (raw && HTTP_VERB_LITERAL.test(raw)) status = raw;
      }
      if (step.name === "sendStatus") {
        const raw = step.args[0]?.getText(file);
        if (raw && HTTP_VERB_LITERAL.test(raw)) {
          status = raw;
          recordResponse(status, "application/json", undefined, "medium");
        }
        return;
      }
      if (step.name === "redirect") {
        recordResponse("302", "text/html", undefined, "medium");
        return;
      }
      if (step.name === "end") {
        recordResponse("204", "application/json", undefined, "medium");
        return;
      }
      if (
        (step.name === "setHeader" || step.name === "header") &&
        step.args[0]?.getText(file)?.replace(/['"]/g, "").toLowerCase() === "content-type"
      ) {
        captureContentType(step.args[1]?.getText(file));
      }
      if (step.name === "type") {
        captureContentType(step.args[0]?.getText(file));
      }
      if (step.name === "writeHead") {
        const headersArg = step.args.find((arg) => ts.isObjectLiteralExpression(arg));
        if (headersArg) {
          for (const prop of headersArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(file).replace(/['"]/g, "").toLowerCase() === "content-type"
            ) {
              captureContentType(prop.initializer.getText(file));
            }
          }
        }
        const code = step.args[0]?.getText(file);
        if (code && HTTP_VERB_LITERAL.test(code)) status = code;
      }
      if (step.name === "write" && (sseSignaled || sse)) {
        collectSseWrite(step.args[0]);
      }
      if (step.name === "json" || step.name === "send") {
        const arg = step.args[0];
        if (sse) {
          sseSignaled = true;
          return;
        }
        if (arg) {
          let { schema, typed } = schemaFromNode(analysis, arg);
          // Pure-JS fall-through: the checker hands back `any` for locals, so
          // ground `res.json(localVar)` by resolving the local value.
          if (!schema) {
            const local = resolveLocalValue(arg);
            if (local && Object.keys(local).length) {
              schema = local;
              typed = false;
            }
          }
          const isString =
            ts.isStringLiteralLike(arg) ||
            (() => {
              try {
                const t = checker.getTypeAtLocation(arg);
                return t.flags & ts.TypeFlags.StringLike;
              } catch {
                return false;
              }
            })();
          const mediaType = explicitType
            ? explicitType
            : step.name === "send" && isString
              ? "text/html"
              : "application/json";
          recordResponse(status, mediaType, schema, typed ? "high" : "medium");
        } else {
          recordResponse(status, explicitType ?? "application/json", undefined, "medium");
        }
      }
    }
    // Monkey-patched response method (e.g. res.customSuccess(200, msg, data)):
    // only expand when no standard Express response site was already recorded.
    if (!hasResponseSite) {
      const custom = context.customResponseMethods;
      if (custom?.size) {
        for (const step of chain) {
          const def = custom.get(step.name);
          if (!def) continue;
          const bindings: Bindings = new Map();
          def.paramNames.forEach((p, i) => {
            if (p && step.args[i]) bindings.set(p, step.args[i]);
          });
          let resolvedStatus = "200";
          if (def.statusArg) {
            let statusNode: any = def.statusArg;
            if (ts.isIdentifier(statusNode)) statusNode = bindings.get(statusNode.text) ?? statusNode;
            const raw = literalToValue(ts, statusNode);
            if (typeof raw === "number" && HTTP_VERB_LITERAL.test(String(raw))) {
              resolvedStatus = String(raw);
            }
          }
          let bodySchema: JsonSchema | undefined;
          if (def.bodyArg) bodySchema = resolveLocalValue(def.bodyArg, bindings);
          recordResponse(resolvedStatus, "application/json", bodySchema, "medium");
          break;
        }
      }
    }
    if (sse) sseSignaled = true;
  }

  function collectSseWrite(arg: any) {
    if (!arg) return;
    // res.write(JSON.stringify(payload))
    if (
      ts.isCallExpression(arg) &&
      ts.isPropertyAccessExpression(arg.expression) &&
      arg.expression.name.text === "stringify" &&
      arg.expression.expression.getText(file) === "JSON"
    ) {
      ssePayload = schemaFromNode(analysis, arg.arguments[0]);
      return;
    }
    // Template/string with "event: name"
    const asText = (n: any): string | null => {
      if (ts.isStringLiteralLike(n)) return n.text;
      if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
      if (ts.isTemplateExpression(n)) return n.head.text;
      return null;
    };
    const text = asText(arg);
    if (text) {
      const match = text.match(/event:\s*([A-Za-z0-9_.-]+)/);
      if (match) sseEvents.set(match[1], undefined);
    }
  }

  if (handler.body) visit(handler.body);

  // ---- assemble parameters ----
  for (const field of queryFields) {
    addParam("query", field.name, field.schema, field.schema ? "high" : "low", field.required ?? false);
  }
  for (const field of headerFields) {
    addParam("header", field.name, field.schema, field.schema ? "high" : "low", false);
  }
  for (const field of cookieFields) {
    addParam("cookie", field.name, field.schema, field.schema ? "high" : "low", false);
  }
  // Path params declared by the route must always exist.
  for (const name of context.pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low");
    }
  }

  // ---- request body ----
  let requestBody: HandlerFacts["requestBody"];
  if (zodBody) {
    const schema = zodBody.schema;
    requestBody = {
      required: true,
      content: [{ mediaType: "application/json", schema }],
      confidence: "high",
    };
  } else if (genericBody) {
    requestBody = {
      required: true,
      content: [{ mediaType: "application/json", schema: genericBody }],
      confidence: "high",
    };
  } else if (bodyReferenced) {
    const schema = mergeFields(bodyFields);
    if (schema && Object.keys(schema.properties ?? {}).length) {
      requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema }],
        confidence: "medium",
      };
      if (bodyFields.some((f) => !f.schema)) gaps.add("body-schema-unknown");
    } else {
      gaps.add("body-schema-unknown");
    }
  }

  if (
    queryFields.some((f) => !f.schema) &&
    !genericQuery
  ) {
    gaps.add("query-unknown");
  }

  // ---- SSE response ----
  if (sseSignaled) {
    let itemSchema: JsonSchema = {};
    if (ssePayload?.schema) {
      itemSchema = ssePayload.schema;
    } else if (sseEvents.size) {
      itemSchema = {
        oneOf: [...sseEvents.keys()].map((name) => ({
          type: "object",
          properties: { event: { type: "string", const: name }, data: {} },
          required: ["event"],
        })),
      };
    } else {
      gaps.add("sse-events-unknown");
    }
    responses.clear();
    responses.set("200:text/event-stream", {
      statusCode: "200",
      description: "Server-sent events",
      confidence: ssePayload?.typed ? "high" : "medium",
      content: [{ mediaType: "text/event-stream", itemSchema }],
    });
  } else {
    if (genericResponse) {
      // The declared Response<T> generic is authoritative for success
      // responses; complete empty observed shapes (e.g. res.json([])) or
      // replace lossy medium-confidence literals on 2xx. Error branches keep
      // their observed status-specific literals.
      let filled = false;
      const simpleNamed =
        genericResponse.$ref ||
        (genericResponse.type === "array" &&
          (genericResponse.items as JsonSchema | undefined)?.$ref);
      for (const [key, response] of responses) {
        if (!response.content) continue;
        const status = key.split(":")[0] ?? response.statusCode;
        const success = /^(2\d\d|2XX|default)$/.test(status);
        for (const media of response.content) {
          if (media.mediaType !== "application/json") continue;
          const empty = !media.schema || isEmptyishSchema(media.schema);
          // A single declared named type is authoritative for success
          // responses; unions (e.g. UserDetail | ErrorBody) keep the
          // status-specific observed literal.
          const namedWins = success && Boolean(simpleNamed);
          const lossyLiteral =
            success && response.confidence !== "high" && !schemaHasRef(media.schema);
          if (empty || namedWins || lossyLiteral) {
            media.schema = genericResponse;
            media.confidence = "high";
            response.confidence = "high";
            filled = true;
          }
        }
      }
      if (!filled && responses.size === 0) {
        recordResponse("200", "application/json", genericResponse, "high");
      }
    }
    if (!hasResponseSite) {
      gaps.add("response-unknown");
    } else if (
      [...responses.values()].some(
        (r) => !r.content || r.content.some((m) => !m.schema && !m.itemSchema),
      )
    ) {
      gaps.add("response-schema-unknown");
    }
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: [...responses.values()],
    gaps: [...gaps],
    sse: sseSignaled,
  };
}
