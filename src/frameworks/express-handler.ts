import {mergeResponseVariants} from "../core/response-variants.js";
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
import { localReturnSchema, localObjectFields, localImplementation } from "../lang/typescript/localFlow.js";
import { inferMongooseRequestBody } from "../lang/typescript/mongoose.js";
import { resolveStaticValue } from "../lang/typescript/staticValue.js";
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
 * Detect numeric conversions applied to a forwarded query object's members.
 * When a service helper does `Number(query.offset)`, `parseInt(query.limit)`,
 * the corresponding wire contract is `number` even though the parameter symbol
 * is typed `any` or as the framework's string-typed query bag. `Number()` and
 * `parseInt` accept floats and fall back to NaN for empty/invalid input, so the
 * schema stays `number` (not `integer`), matching how upstream documents model it.
 * Returns the member names proven to be converted; anything unproven stays string.
 */
function numericForwardedQueryFields(
  analysis: TsAnalysis,
  method: any,
  parameter: any,
): Map<string, JsonSchema> {
  const { ts, checker } = analysis;
  const numeric = new Map<string, JsonSchema>();
  const visited = new Set<any>();
  const walk = (fn: any, param: any, depth: number): void => {
    if (!fn.body || depth > 12 || visited.has(param)) return;
    visited.add(param);
    const symbol = checker.getSymbolAtLocation(param.name);
    if (!symbol) return;
    const aliases = new Set([symbol]);
    const isQuery = (n: any): boolean =>
      ts.isIdentifier(n) && aliases.has(checker.getSymbolAtLocation(n));
    const visit = (n: any): void => {
      if (n !== fn.body && ts.isFunctionLike(n)) return;
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        isQuery(n.initializer) &&
        (n.parent.flags & ts.NodeFlags.Const) &&
        ts.isIdentifier(n.name)
      ) {
        aliases.add(checker.getSymbolAtLocation(n.name));
      }
      if (
        ts.isCallExpression(n) &&
        (ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression)) &&
        ["Number", "parseInt", "parseFloat"].includes(
          ts.isIdentifier(n.expression) ? n.expression.text : n.expression.name.text,
        ) &&
        n.arguments.length >= 1
      ) {
        const arg = n.arguments[0];
        const member =
          ts.isPropertyAccessExpression(arg) && isQuery(arg.expression)
            ? arg.name.text
            : ts.isElementAccessExpression(arg) &&
                isQuery(arg.expression) &&
                ts.isStringLiteralLike(arg.argumentExpression)
              ? arg.argumentExpression.text
              : undefined;
        if (member) numeric.set(member, { type: "number" });
      }
      if (ts.isCallExpression(n)) {
        const target = localImplementation(analysis, n);
        if (target) {
          n.arguments.forEach((arg: any, index: number) => {
            if (isQuery(arg) && target.parameters[index]) {
              walk(target, target.parameters[index], depth + 1);
            }
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  };
  walk(method, parameter, 0);
  return numeric;
}

const STRING_FIELD_METHODS = new Set([
  "trim", "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase",
  "split", "replace", "replaceAll", "startsWith", "endsWith", "substring",
  "substr", "charAt", "charCodeAt", "codePointAt", "padStart", "padEnd",
  "repeat", "normalize", "match", "matchAll", "search", "localeCompare", "includes",
]);
const ARRAY_FIELD_METHODS = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "push", "pop", "shift",
  "unshift", "slice", "splice", "concat", "find", "findIndex", "findLast",
  "findLastIndex", "flat", "flatMap", "keys", "values", "entries", "at",
  "indexOf", "lastIndexOf", "join", "sort", "reverse", "copyWithin", "fill",
  "some", "every",
]);
// Evidence rank: explicit conversions outrank a guessed scalar default.
const TYPE_RANK: Record<string, number> = { boolean: 3, number: 3, array: 3, string: 2 };

/**
 * Infer wire types for the fields of an untyped (`any`) request DTO parameter by
 * observing how the service body uses each field (string/array methods, numeric
 * wrappers, boolean comparisons, destructuring). A field whose existence is
 * proven but whose type cannot be observed defaults to string, which is the
 * dominant scalar for hand-validated JSON bodies; the request stays at medium
 * confidence. Existence without any usable type is never fabricated as a
 * precise high-confidence contract.
 */
function inferForwardedBodyFieldSchemas(
  analysis: TsAnalysis,
  method: any,
  parameter: any,
): Map<string, JsonSchema> {
  const { ts, checker } = analysis;
  const types = new Map<string, JsonSchema>();
  const visited = new Set<any>();

  const mark = (field: string, schema: JsonSchema): void => {
    const current = types.get(field);
    const currentType = current && !Array.isArray(current.type) ? (current.type as string) : undefined;
    const nextType = !Array.isArray(schema.type) ? (schema.type as string) : undefined;
    if (!current || (TYPE_RANK[nextType ?? ""] ?? 1) > (TYPE_RANK[currentType ?? ""] ?? 0)) {
      types.set(field, schema);
    }
  };

  const walk = (fn: any, param: any, depth: number): void => {
    if (!fn.body || depth > 12 || visited.has(param)) return;
    visited.add(param);
    const rootSymbol = checker.getSymbolAtLocation(param.name);
    if (!rootSymbol) return;
    const rootAliases = new Set<any>([rootSymbol]);
    // Binding/property alias symbol -> wire field name.
    const fieldOf = new Map<any, string>();

    const isRoot = (n: any): boolean =>
      ts.isIdentifier(n) && rootAliases.has(checker.getSymbolAtLocation(n));
    const fieldFromExpr = (n: any): string | undefined => {
      // input.field
      if (ts.isPropertyAccessExpression(n) && isRoot(n.expression)) return n.name.text;
      if (
        ts.isElementAccessExpression(n) &&
        isRoot(n.expression) &&
        ts.isStringLiteralLike(n.argumentExpression)
      ) {
        return n.argumentExpression.text;
      }
      // Destructured or aliased scalar binding.
      if (ts.isIdentifier(n)) return fieldOf.get(checker.getSymbolAtLocation(n));
      return undefined;
    };

    const visit = (n: any): void => {
      if (n !== fn.body && ts.isFunctionLike(n)) return;

      if (ts.isVariableDeclaration(n) && n.initializer) {
        // const { a, b: c } = input
        if (isRoot(n.initializer) && ts.isObjectBindingPattern(n.name)) {
          for (const element of n.name.elements) {
            if (ts.isBindingElement(element) && (ts.isIdentifier(element.name) || ts.isStringLiteralLike(element.name))) {
              const wireKey = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : ts.isIdentifier(element.name) ? element.name.text : (element.name as any).text;
              if (ts.isIdentifier(element.name)) fieldOf.set(checker.getSymbolAtLocation(element.name), wireKey);
            }
          }
        }
        // const alias = input
        if (isRoot(n.initializer) && ts.isIdentifier(n.name)) {
          rootAliases.add(checker.getSymbolAtLocation(n.name));
        }
        // const email = input.email
        const propField = fieldFromExpr(n.initializer);
        if (propField && ts.isIdentifier(n.name)) {
          fieldOf.set(checker.getSymbolAtLocation(n.name), propField);
        }
      }

      if (ts.isCallExpression(n)) {
        const calleeName = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : undefined;
        const firstArg = n.arguments[0];

        const isArrayCall =
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === "Array" &&
          n.expression.name.text === "isArray";

        if (isArrayCall) {
          const field = fieldFromExpr(n.arguments[0]);
          if (field) mark(field, { type: "array", items: { type: "string" } });
        } else if (calleeName === "Number" || calleeName === "parseInt" || calleeName === "parseFloat") {
          const field = fieldFromExpr(firstArg);
          if (field) mark(field, { type: "number" });
        } else if (calleeName === "String") {
          const field = fieldFromExpr(firstArg);
          if (field) mark(field, { type: "string" });
        } else if (calleeName === "Boolean") {
          const field = fieldFromExpr(firstArg);
          if (field) mark(field, { type: "boolean" });
        } else if (calleeName && ts.isPropertyAccessExpression(n.expression)) {
          const receiver = n.expression.expression;
          const field = fieldFromExpr(receiver);
          if (field) {
            if (ARRAY_FIELD_METHODS.has(calleeName)) {
              mark(field, { type: "array", items: { type: "string" } });
            } else if (STRING_FIELD_METHODS.has(calleeName)) {
              mark(field, { type: "string" });
            }
          }
        }

        // Follow forwarded fields into nested local service helpers.
        const target = localImplementation(analysis, n);
        if (target) {
          n.arguments.forEach((arg: any, index: number) => {
            if (!target.parameters[index]) return;
            if (isRoot(arg)) {
              walk(target, target.parameters[index], depth + 1);
            } else {
              const field = fieldFromExpr(arg);
              if (field) mark(field, { type: "string" });
            }
          });
        }
      }

      // field === true/false / numeric / string literal
      if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
        const sides: [any, any][] = [[n.left, n.right], [n.right, n.left]];
        for (const [expr, literal] of sides) {
          const field = fieldFromExpr(expr);
          if (field) {
            if (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) mark(field, { type: "boolean" });
            else if (ts.isNumericLiteral(literal)) mark(field, { type: "number" });
            else if (ts.isStringLiteralLike(literal)) mark(field, { type: "string" });
          }
        }
      }

      // Template string interpolation proves a string usage.
      if (ts.isTemplateExpression(n)) {
        const checkSpan = (expr: any): void => {
          const field = fieldFromExpr(expr);
          if (field) mark(field, { type: "string" });
        };
        checkSpan(n.head);
        for (const span of n.templateSpans) checkSpan(span.expression);
      }

      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  };

  walk(method, parameter, 0);

  // Ensure every observed field (including plain property access) has a type.
  for (const field of localObjectFields(analysis, method, parameter)) {
    if (!types.has(field)) types.set(field, { type: "string" });
  }
  return types;
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

/**
 * If an `if` condition proves the tested value is null/undefined/falsy in the
 * THEN branch (`!x`, `x == null`, `x === undefined`), return the root name.
 * The ELSE branch then proves the value is present.
 */
function nullGuardName(ts: any, cond: any): string | undefined {
  if (
    ts.isPrefixUnaryExpression(cond) &&
    cond.operator === ts.SyntaxKind.ExclamationToken &&
    !ts.isPrefixUnaryExpression(cond.operand) // `!x`, not `!!x`
  ) {
    return rootIdentifier(ts, cond.operand);
  }
  if (ts.isBinaryExpression(cond)) {
    const op = cond.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const nullish = (n: any): boolean =>
        n.kind === ts.SyntaxKind.NullKeyword ||
        n.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(n) && n.text === "undefined");
      if (nullish(cond.right)) return rootIdentifier(ts, cond.left);
      if (nullish(cond.left)) return rootIdentifier(ts, cond.right);
    }
  }
  return undefined;
}

/**
 * If an `if` condition proves the tested value is present in the THEN branch
 * (`x`, `x != null`, `x !== undefined`), return the root name.
 */
function nonNullGuardName(ts: any, cond: any): string | undefined {
  if (ts.isIdentifier(cond) || ts.isPropertyAccessExpression(cond)) {
    return rootIdentifier(ts, cond);
  }
  if (ts.isBinaryExpression(cond)) {
    const op = cond.operatorToken.kind;
    if (
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const nullish = (n: any): boolean =>
        n.kind === ts.SyntaxKind.NullKeyword ||
        n.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(n) && n.text === "undefined");
      if (nullish(cond.right)) return rootIdentifier(ts, cond.left);
      if (nullish(cond.left)) return rootIdentifier(ts, cond.right);
    }
  }
  return undefined;
}

/**
 * Remove a pure `null`/`undefined` union branch from a schema proven non-null
 * on the current response path. Non-null data branches are preserved exactly.
 */
function stripNullishBranch(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return schema;
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (!Array.isArray(branches)) return schema;
  const kept = branches.filter((b) => {
    const isNullish =
      b.type === "null" ||
      b.type === "undefined" ||
      (Object.keys(b).length === 1 && (b.type === "null" || b.type === "undefined"));
    return !isNullish;
  });
  if (kept.length === branches.length) return schema;
  if (kept.length === 1) return kept[0];
  return schema.anyOf ? { anyOf: kept } : { oneOf: kept };
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

function schemaFromNodeBase(
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

/** Enrich incomplete checker types with actual local serializer shapes. */
function schemaFromNode(analysis: TsAnalysis, node: any, fallbackLiteral = true): {schema?: JsonSchema; typed:boolean} {
  const base = schemaFromNodeBase(analysis, node, fallbackLiteral);
  const unknown = (schema: any, depth = 0): boolean => !schema || !Object.keys(schema).length || depth < 16 && (
    Object.values(schema.properties ?? {}).some(child => unknown(child, depth + 1)) ||
    schema.items && unknown(schema.items, depth + 1)
  );
  let evidence = false;
  const observed = localReturnSchema(analysis, node, value => schemaFromNodeBase(analysis, value, fallbackLiteral).schema, true, () => { evidence = true; });
  return observed && (evidence || unknown(base.schema)) ? {schema: observed, typed: !unknown(observed)} : base;
}

/** Resolves an identifier to a function-like node across local/imported files. */
/**
 * Resolves an exported symbol `name` to a function-like node declared in
 * `file`, following `export { a } from './x'` and `export * from './x'`
 * re-exports. Only project files are traversed. Returns null when the symbol
 * cannot be grounded in a real declaration.
 */
/**
 * Follows a handler expression down to a function-like node. Express handlers
 * are very commonly wrapped or aliased:
 *   const register = catchAsync(async (req, res) => { ... });
 *   module.exports = { register };
 * so an exported value may be (a) a call expression whose first function-like
 * argument is the real handler (catchAsync / asyncHandler / express-async-
 * handler style wrappers), or (b) an identifier aliasing a top-level const that
 * holds one. Returns undefined when no function-like node is provable.
 */
function unwrapToFunction(
  analysis: TsAnalysis,
  file: any,
  node: any,
  seen: Set<string> = new Set(),
  depth = 0,
): any | undefined {
  const { ts } = analysis;
  if (!node || depth > 8) return undefined;
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return node;
  }
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) {
      if (
        ts.isArrowFunction(arg) ||
        ts.isFunctionExpression(arg) ||
        ts.isFunctionDeclaration(arg) ||
        ts.isMethodDeclaration(arg)
      ) {
        return arg;
      }
    }
    // Wrappers may nest or receive an identifier handler.
    for (const arg of node.arguments) {
      const nested = unwrapToFunction(analysis, file, arg, seen, depth + 1);
      if (nested) return nested;
    }
  }
  if (ts.isIdentifier(node)) {
    const key = `${file.fileName}:${node.text}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    let initializer: any;
    file.forEachChild((child: any) => {
      if (initializer || !ts.isVariableStatement(child)) return;
      for (const decl of child.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === node.text &&
          decl.initializer
        ) {
          initializer = decl.initializer;
        }
      }
    });
    if (initializer) return unwrapToFunction(analysis, file, initializer, seen, depth + 1);
  }
  return undefined;
}

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
            decl.initializer
          ) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
              target = decl.initializer;
            } else {
              // const handler = catchAsync(async (req, res) => ...)
              const unwrapped = unwrapToFunction(analysis, sf, decl.initializer);
              if (unwrapped) target = unwrapped;
            }
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

  const unwrapped = found ? unwrapToFunction(analysis, file, found) : undefined;
  return unwrapped ? { node: unwrapped, file } : null;
}

export function resolveHandler(
  analysis: TsAnalysis,
  sourceFile: any,
  node: any,
  seen: Set<string> = new Set(),
): { node: any; file: any } | null {
  const { ts } = analysis;
  if (!node) return null;
  const staticHandler = resolveStaticValue(analysis, node);
  if (staticHandler?.body && analysis.isProjectFile(staticHandler.getSourceFile().fileName) && (ts.isMethodDeclaration(staticHandler) || ts.isFunctionDeclaration(staticHandler) || ts.isArrowFunction(staticHandler) || ts.isFunctionExpression(staticHandler))) {
    return {node: staticHandler, file: staticHandler.getSourceFile()};
  }

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
    // Recurse because the require binding may live inside a function body,
    // e.g. a default-exported router factory `module.exports = app => { const
    // controllers = require("./controllers"); ... }`.
    const walk = (node: any): void => {
      if (specifier) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === localName
      ) {
        const init = node.initializer;
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          ts.isStringLiteral(init.arguments[0])
        ) {
          specifier = init.arguments[0].text;
          exportName = "module";
          return;
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
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
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = field.schema ?? {};
    if (field.required) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
  };
}

/**
 * Add a collected request field, or merge with the existing entry so a later
 * untyped property access cannot overwrite a schema already proven by a
 * conversion or a typed service-parameter forward with an opaque empty value.
 */
function upsertField(fields: CollectedField[], name: string, schema: JsonSchema | undefined): void {
  const existing = fields.find((f) => f.name === name);
  if (existing) {
    if (schema) existing.schema = schema;
  } else {
    fields.push({ name, schema });
  }
}

/**
 * Deep-merge two object schemas that describe the same wire wrapper (for
 * example when one handler passes `req.body.comment.body` and another reads the
 * wrapper directly). Existing proven properties win; new properties are added.
 */
function mergeObjectSchemas(base: JsonSchema | undefined, extra: JsonSchema): JsonSchema {
  if (!base || Object.keys(base).length === 0) return extra;
  if (base.type !== "object" || extra.type !== "object") return base;
  const properties: Record<string, JsonSchema> = { ...(base.properties as Record<string, JsonSchema>) };
  const extraProperties = (extra.properties ?? {}) as Record<string, JsonSchema>;
  for (const [key, value] of Object.entries(extraProperties)) {
    properties[key] = key in properties ? mergeObjectSchemas(properties[key], value) : value;
  }
  return { ...base, properties };
}

function responseKey(status: string, mediaType: string): string {
  return `${status}:${mediaType}`;
}

/** Find the initializer of a local `const code = ...` binding in scope. */
function findConstInitializer(analysis: TsAnalysis, ident: any): any | undefined {
  const { ts, checker } = analysis;
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
  return undefined;
}

/**
 * Resolve a dynamic `res.status(x)` argument to a concrete HTTP code or to
 * "default". Express error handlers commonly write `err.status || 500`,
 * `err.statusCode ?? 500`, a ternary, or a local constant. The numeric fallback
 * is the proven default; a bare `err.status` with no fallback maps to "default"
 * rather than a fabricated code.
 */
function resolveStatusCode(analysis: TsAnalysis, node: any, depth = 0): string | undefined {
  if (!node || depth > 6) return undefined;
  const { ts } = analysis;
  if (ts.isNumericLiteral(node)) {
    return /^\d{3}$/.test(node.text) ? node.text : undefined;
  }
  if (ts.isParenthesizedExpression(node)) {
    return resolveStatusCode(analysis, node.expression, depth + 1);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      resolveStatusCode(analysis, node.right, depth + 1) ??
      resolveStatusCode(analysis, node.left, depth + 1)
    );
  }
  if (ts.isConditionalExpression(node)) {
    return (
      resolveStatusCode(analysis, node.whenFalse, depth + 1) ??
      resolveStatusCode(analysis, node.whenTrue, depth + 1)
    );
  }
  if (ts.isIdentifier(node)) {
    const init = findConstInitializer(analysis, node);
    if (init) return resolveStatusCode(analysis, init, depth + 1);
    return "default";
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  ) {
    return "default";
  }
  return undefined;
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
    reachableNodes?: Set<any>;
    /** Schema middleware (Joi/celebrate `validate({ body, query, params })`). */
    validatedRequest?: {
      body?: JsonSchema;
      query?: JsonSchema;
      params?: JsonSchema;
    };
    /** Four-argument Express error handler `(err, req, res, next)`. The error
     * argument shifts req/res by one; request contracts are not produced. */
    errorHandler?: boolean;
  },
): HandlerFacts {
  const { ts, checker } = analysis;
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const paramNames = new Map<string, RouteParameter>();

  const reqIndex = context.errorHandler ? 1 : 0;
  const resIndex = context.errorHandler ? 2 : 1;
  const reqName = handler.parameters?.[reqIndex]?.name?.getText?.(file) ?? "req";
  const resName = handler.parameters?.[resIndex]?.name?.getText?.(file) ?? "res";

  // In plain JavaScript the checker only knows Express's library-wide
  // generics (query: string | Query | Array, etc.). Those are not user
  // contracts and must not be reported as typed fields; rely on syntax.
  const reqParam = handler.parameters?.[reqIndex];
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
  const reqType = handler.parameters?.[reqIndex]?.type;
  const resType = handler.parameters?.[resIndex]?.type;
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

  // ---- Joi / celebrate schema middleware: { query: {...}, params: {...} } ----
  const validatedQuery = context.validatedRequest?.query;
  if (validatedQuery?.properties) {
    const requiredSet = new Set<string>(Array.isArray(validatedQuery.required) ? validatedQuery.required : []);
    for (const [name, schema] of Object.entries(validatedQuery.properties)) {
      addParam("query", name, schema as JsonSchema, "high", requiredSet.has(name));
    }
  }
  const validatedParams = context.validatedRequest?.params;
  if (validatedParams?.properties) {
    const requiredSet = new Set<string>(Array.isArray(validatedParams.required) ? validatedParams.required : []);
    for (const [name, schema] of Object.entries(validatedParams.properties)) {
      addParam("path", name, schema as JsonSchema, "high", requiredSet.has(name) || true);
    }
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
      responses.set(key, mergeResponseVariants(existing, {statusCode:status, description:"", confidence, content:[media]}));
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
    if (context.reachableNodes && !context.reachableNodes.has(node)) return;
    if (ts.isFunctionLike(node)) return;
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
    fallbackSchema?: JsonSchema,
  ) {
    const declaration = accessNode.parent;
    const pattern = declaration?.name;
    if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(pattern)) return;
    const bindingDefault = (init: any): JsonSchema | undefined => {
      if (!init) return undefined;
      if (ts.isNumericLiteral(init)) return { type: "number" };
      if (ts.isStringLiteralLike(init)) return { type: "string" };
      if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) return { type: "boolean" };
      if (ts.isArrayLiteralExpression(init)) return { type: "array", items: {} };
      if (ts.isObjectLiteralExpression(init)) return { type: "object" };
      return undefined;
    };
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
      // Without trusted types, honor a binding default then the location
      // fallback (path/query values are always strings on the wire). JSON
      // request bodies pass no fallback, so an untyped body field stays unknown.
      if (!schema) schema = bindingDefault(element.initializer) ?? fallbackSchema;
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

  // Root names proven non-null on the currently visited response path by an
  // enclosing `if (!x) ... else ...` / `if (x) ...` guard. Restored on exit so
  // the narrowing only applies inside the proving branch subtree.
  const nonNullNames = new Set<string>();
  const scopedNonNull = (names: string[], fn: () => void): void => {
    if (names.length === 0) {
      fn();
      return;
    }
    const snapshot = new Set(nonNullNames);
    names.forEach((n) => nonNullNames.add(n));
    try {
      fn();
    } finally {
      nonNullNames.clear();
      snapshot.forEach((n) => nonNullNames.add(n));
    }
  };

  const visit = (node: any) => {
    if (context.reachableNodes && !context.reachableNodes.has(node)) return;
    // Branch-sensitive null narrowing: visit each arm of an `if` with the
    // appropriate non-null set so a success response in the proving arm drops
    // the `null` union branch that only belongs to the error/404 arm.
    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const negated = nullGuardName(ts, node.expression);
      const positive = negated ? undefined : nonNullGuardName(ts, node.expression);
      if (negated) {
        scopedNonNull([], () => visit(node.thenStatement));
        if (node.elseStatement) scopedNonNull([negated], () => visit(node.elseStatement));
      } else if (positive) {
        scopedNonNull([positive], () => visit(node.thenStatement));
        if (node.elseStatement) scopedNonNull([], () => visit(node.elseStatement));
      } else {
        visit(node.thenStatement);
        if (node.elseStatement) visit(node.elseStatement);
      }
      return;
    }
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
              collectDestructure(node, pathFields, false, { type: "string" });
              for (const field of pathFields) {
                addParam("path", field.name, field.schema, field.schema ? "high" : "low");
              }
            } else if (member && member !== "params") {
              addParam("path", member, schema, schema ? "high" : "low");
            }
          } else if (/^req\.query(\.|\[|$)/.test(fullText)) {
            if (fullText === "req.query" && destructured) {
              collectDestructure(node, queryFields, false, { type: "string" });
            } else if (member && member !== "query") {
              upsertField(queryFields, member, schema);
            }
          } else if (/^req\.headers(\.|\[|$)/.test(fullText)) {
            if (member && member !== "headers") {
              upsertField(headerFields, member, schema);
            }
          } else if (/^req\.cookies(\.|\[|$)/.test(fullText)) {
            if (member && member !== "cookies") {
              upsertField(cookieFields, member, schema);
            }
          } else if (/^req\.body(\.|\[|$)/.test(fullText)) {
            bodyReferenced = true;
            if (fullText === "req.body" && destructured) {
              collectDestructure(node, bodyFields, true);
            } else if (member && member !== "body") {
              // Merge with a schema already proven by a typed service-parameter
              // forward instead of appending a duplicate untyped field.
              upsertField(bodyFields, member, schema);
            }
          }
        }
      }
    }

    // Numeric conversion wrappers: `Number(req.query.x)`, `parseInt(req.query.x)`.
    // The wrapped property access is a query/path parameter; the value is produced
    // through an explicit numeric conversion, so the wire contract is number, not
    // the framework's default string-typed ParsedQs. `Number()` accepts floats and
    // falls back to NaN/0 for empty or invalid input; upstream documents model this
    // as `number` (not integer), so the schema stays number.
    if (
      ts.isCallExpression(node) &&
      (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) &&
      ["Number", "parseInt", "parseFloat"].includes(
        ts.isIdentifier(node.expression) ? node.expression.text : node.expression.name.text,
      ) &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0];
      const member =
        ts.isPropertyAccessExpression(arg) && rootIdentifier(ts, arg) === reqName
          ? arg.name.text
          : ts.isElementAccessExpression(arg) &&
              rootIdentifier(ts, arg.expression) === reqName &&
              ts.isStringLiteralLike(arg.argumentExpression)
            ? arg.argumentExpression.text
            : undefined;
      if (member) {
        const numericSchema: JsonSchema = { type: "number" };
        if (/^req\.query(\.|\[|$)/.test(arg.getText(file))) {
          const existing = queryFields.find((f) => f.name === member);
          if (existing) existing.schema = numericSchema;
          else queryFields.push({ name: member, schema: numericSchema });
        } else if (/^req\.params(\.|\[|$)/.test(arg.getText(file))) {
          const existing = parameters.find((p) => p.in === "path" && p.name === member);
          if (existing) existing.schema = numericSchema;
          else addParam("path", member, numericSchema, "high");
        }
      }
    }

    // Follow forwarded query objects by resolved parameter symbols, including service helpers.
    if (ts.isCallExpression(node)) {
      // Locate `req.body.<wrapper>` (optionally followed by nested property
      // access such as `req.body.comment.body`) inside a call argument,
      // including spread-wrapped object literals. Returns the wire wrapper name
      // and the property path nested beneath it.
      const forwardedBodyTarget = (
        arg: any,
      ): { wrapper: string; path: string[] } | undefined => {
        const direct = (n: any): { wrapper: string; path: string[] } | undefined => {
          if (ts.isPropertyAccessExpression(n)) {
            const match = n
              .getText(file)
              .match(new RegExp(`^${reqName}\\.body\\.([A-Za-z0-9_$]+)((?:\\.[A-Za-z0-9_$]+)*)$`));
            if (match) {
              return {
                wrapper: match[1]!,
                path: match[2] ? match[2].split(".").filter(Boolean) : [],
              };
            }
          }
          return undefined;
        };
        const directTarget = direct(arg);
        if (directTarget) return directTarget;
        if (ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (ts.isSpreadAssignment(prop)) {
              const spreadTarget = direct(prop.expression);
              if (spreadTarget) return spreadTarget;
            }
          }
        }
        return undefined;
      };

      const target = localImplementation(analysis, node);
      if (target) node.arguments.forEach((arg: any, index: number) => {
        if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === reqName && arg.name.text === "query" && target.parameters[index]) {
          const forwarded = localObjectFields(analysis, target, target.parameters[index]);
          if (forwarded.length) {
            const numeric = numericForwardedQueryFields(analysis, target, target.parameters[index]);
            for (const name of forwarded) {
              queryFields.push({ name, schema: numeric.get(name) ?? { type: "string" } });
            }
            if (!numeric.size) gaps.add("query-unknown");
          }
        }

        // Typed body forwarding: a wrapped `req.body.<name>` is passed to a
        // service parameter with a declared DTO type (e.g. createUser(input:
        // RegisterInput)). The parameter type fixes the request fields without
        // expanding an entire database entity.
        const bodyTarget = forwardedBodyTarget(arg);
        if (bodyTarget && target.parameters[index]) {
          const { wrapper, path } = bodyTarget;
          const parameter = target.parameters[index];
          let paramSchema: JsonSchema | undefined;
          try {
            const paramType = checker.getTypeAtLocation(parameter.name ?? parameter);
            if (
              paramType &&
              !(paramType.flags & ts.TypeFlags.Any) &&
              !(paramType.flags & ts.TypeFlags.Unknown)
            ) {
              const resolved = typeToSchema(paramType, analysis.schemaContext);
              if (resolved && Object.keys(resolved).length) paramSchema = resolved;
            }
          } catch {
            // No usable parameter type; fall back to observed fields below.
          }
          // Untyped DTO parameter (e.g. `article: any`): recover the field set
          // and infer wire types from destructuring, property access and
          // runtime conversions in the service body, so the request contract
          // stays complete without fabricating high-confidence field types.
          if (!paramSchema && path.length === 0) {
            const fieldSchemas = inferForwardedBodyFieldSchemas(analysis, target, parameter);
            if (fieldSchemas.size) {
              const properties: Record<string, JsonSchema> = {};
              for (const [fieldName, fieldSchema] of fieldSchemas) properties[fieldName] = fieldSchema;
              paramSchema = { type: "object", properties };
            }
          }
          if (paramSchema) {
            // Nest the proven schema under `wrapper` and any deeper path
            // (`req.body.comment.body` -> { comment: { body: <schema> } }).
            let wireSchema = paramSchema;
            for (let p = path.length - 1; p >= 0; p--) {
              wireSchema = { type: "object", properties: { [path[p]!]: wireSchema } };
            }
            bodyReferenced = true;
            const existing = bodyFields.find((f) => f.name === wrapper);
            if (existing) {
              existing.schema = mergeObjectSchemas(existing.schema, wireSchema);
            } else {
              bodyFields.push({ name: wrapper, schema: wireSchema });
            }
          }
        }
      });
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
        const arg = step.args[0];
        const raw = arg?.getText(file);
        if (raw && HTTP_VERB_LITERAL.test(raw.trim())) {
          status = raw.trim();
        } else {
          const resolved = resolveStatusCode(analysis, arg);
          if (resolved) status = resolved;
        }
      }
      if (step.name === "sendStatus") {
        const raw = step.args[0]?.getText(file);
        if (raw && HTTP_VERB_LITERAL.test(raw)) {
          status = raw;
          recordResponse(status, "text/plain", {type:'string'}, "high");
        }
        return;
      }
      if (step.name === "redirect") {
        recordResponse("302", "text/html", undefined, "medium");
        return;
      }
      if (step.name === "render") {
        // res.render('view', locals) renders an HTML view; the response is a
        // complete 200 text/html described entirely by its media type.
        recordResponse(status, "text/html", undefined, "medium");
        return;
      }
      if (step.name === "end") {
        hasResponseSite = true;
        const payload = step.args[0];
        if (payload && !ts.isFunctionLike(payload) && payload.getText(file) !== 'undefined') {
          const inferred = schemaFromNode(analysis, payload);
          recordResponse(status, explicitType ?? '*/*', inferred.schema, 'medium');
        } else {
          responses.set(responseKey(status, ''), {statusCode:status,description:'',confidence:'high'});
        }
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
          // A success (2xx) response for a value proven present by an enclosing
          // `if (!x) 404 else res.send(x)` guard cannot carry the null branch.
          let effectiveSchema = schema;
          if (/^2/.test(status) && effectiveSchema) {
            const rootName = rootIdentifier(ts, arg);
            if (rootName && nonNullNames.has(rootName)) {
              effectiveSchema = stripNullishBranch(effectiveSchema);
            }
          }
          recordResponse(status, mediaType, effectiveSchema, typed ? "high" : "medium");
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

  // ---- backfill request body from Mongoose write calls + required guards ----
  if (handler.body) {
    // A guard `if (!req.body.title) { ...; return; }` proves `title` is
    // required on the paths that follow, independent of the ORM schema.
    const requiredBodyGuards = new Set<string>();
    const branchTerminates = (root: any): boolean => {
      let terminates = false;
      const w = (n: any): void => {
        if (terminates) return;
        if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) terminates = true;
        if (n !== root && (ts.isFunctionLike(n) || ts.isArrowFunction?.(n))) return;
        ts.forEachChild(n, w);
      };
      w(root);
      return terminates;
    };
    const collectGuards = (n: any): void => {
      if (ts.isIfStatement(n) && branchTerminates(n.thenStatement)) {
        const cw = (c: any): void => {
          if (
            ts.isPrefixUnaryExpression(c) &&
            c.operator === ts.SyntaxKind.ExclamationToken &&
            !ts.isPrefixUnaryExpression(c.operand) &&
            ts.isPropertyAccessExpression(c.operand) &&
            ts.isPropertyAccessExpression(c.operand.expression) &&
            c.operand.expression.name?.text === "body" &&
            rootIdentifier(ts, c.operand.expression.expression) === reqName
          ) {
            requiredBodyGuards.add(c.operand.name.text);
          }
          ts.forEachChild(c, cw);
        };
        cw(n.expression);
      }
      ts.forEachChild(n, collectGuards);
    };
    collectGuards(handler.body);

    const mongooseBody = inferMongooseRequestBody(analysis, handler.body);
    if (mongooseBody) {
      const known = new Set(bodyFields.map((f) => f.name));
      // Whole-body update forwarding accepts every model path, all optional.
      if (mongooseBody.wholeBodyUpdate) {
        for (const name of mongooseBody.fieldTypes.keys()) {
          if (!known.has(name)) {
            bodyFields.push({ name, schema: mongooseBody.fieldTypes.get(name) });
            known.add(name);
          }
        }
      }
      for (const field of bodyFields) {
        const proven = mongooseBody.fieldTypes.get(field.name);
        if (proven && (!field.schema || isEmptyishSchema(field.schema))) {
          field.schema = proven;
        }
        if (mongooseBody.modelRequired.has(field.name)) field.required = true;
        if (requiredBodyGuards.has(field.name)) field.required = true;
      }
    } else {
      for (const field of bodyFields) {
        if (requiredBodyGuards.has(field.name)) field.required = true;
      }
    }
  }

  // ---- assemble parameters ----
  for (const field of queryFields) {
    // A query string's atomic value is text unless a conversion (Number/
    // parseInt) or a validated schema already proved another type. Array/object
    // query values require explicit evidence and are not assumed.
    const schema = field.schema ?? { type: "string" };
    addParam("query", field.name, schema, field.schema ? "high" : "low", field.required ?? false);
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
  const validatedBody = context.validatedRequest?.body;
  if (validatedBody && Object.keys(validatedBody).length) {
    const requiredNames = Array.isArray(validatedBody.required) ? validatedBody.required : [];
    requestBody = {
      required: requiredNames.length > 0,
      content: [{ mediaType: "application/json", schema: validatedBody }],
      confidence: "high",
    };
  } else if (zodBody) {
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

  // Unproven query fields fall back to the query-string atomic type `string`
  // during parameter assembly, so plain text query params are a proven
  // contract and need no unknown gap. Array/object query values still surface
  // elsewhere when they cannot be typed.

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
            success && !genericResponse.anyOf && !genericResponse.oneOf && response.confidence !== "high" && !schemaHasRef(media.schema);
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
        (r) =>
          !r.content ||
          r.content.some(
            (m) =>
              !m.schema &&
              !m.itemSchema &&
              m.mediaType !== "text/html" &&
              m.mediaType !== "text/plain" &&
              m.mediaType !== "text/css" &&
              m.mediaType !== "text/event-stream",
          ),
      )
    ) {
      gaps.add("response-schema-unknown");
    }
  }

  if (context.errorHandler) {
    // Error handlers define no request contract; surface only the error
    // responses they actually write.
    return {
      parameters: [],
      responses: [...responses.values()],
      gaps: [...gaps].filter(
        (g) => g === "response-unknown" || g === "response-schema-unknown",
      ),
      sse: false,
    };
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: [...responses.values()],
    gaps: [...gaps],
    sse: sseSignaled,
  };
}
