import {collectRequestProvenance, requestPath, symbolDeclaration, externalReference} from "./requestProvenance.js";
import type { JsonSchema } from "../../core/types.js";
import type { TsAnalysis } from "./index.js";

/**
 * Static Mongoose ODM projection.
 *
 * Recovers the document shape a Mongoose model query actually serializes to a
 * response, without connecting to a database or executing the scanned code:
 *   - model registration (`mongoose.model`, `connection.model`) across files,
 *   - `new Schema({ ... })` path definitions (scalars, nested paths, document
 *     arrays, refs, maps, subdocuments),
 *   - query return shapes (`find` -> array, `findOne`/`findById` -> object|null,
 *     create/insertMany, update/delete result objects, counts),
 *   - `.select(...)` projections, `.populate(...)` relation expansion and
 *     `.lean()`, plus schema-level `select: false` field hiding.
 *
 * Only fields the schema (and projection) proves are returned are emitted, so a
 * full database entity is never expanded into the response. Anything that cannot
 * be proven statically (aggregations, dynamic `refPath`, opaque custom types)
 * returns undefined so the generic gap/AI-review flow can flag it instead of a
 * fabricated schema.
 */

interface MongooseField {
  name: string;
  schema: JsonSchema;
  /** Present on every persisted document (required path, default, _id, timestamps). */
  required: boolean;
  /** Referenced model name for ObjectId refs and arrays of refs. */
  ref?: string;
  /** Dynamic reference (`refPath`); the target cannot be resolved statically. */
  dynamicRef?: boolean;
  /** Hidden from normal query output by schema-level `select: false`. */
  hiddenByDefault?: boolean;
}

/**
 * Result of a custom `toJSON` transform: a rest-destructuring that removes
 * listed keys (`const { __v, _id, ...object } = ...`) plus assignments that
 * add derived keys (`object.id = _id`).
 */
interface ToJsonTransform {
  /** Keys removed by the rest destructuring. */
  omit: Set<string>;
  /** Added key -> source key whose schema/value it copies (e.g. id <- _id). */
  copyFrom: Map<string, string>;
}

interface MongooseModel {
  name: string;
  sourceSchema?: SchemaExpr;
  fields: Map<string, MongooseField>;
  /** Top-level schema options that change the serialized document. */
  idField: boolean;
  versionKey: string | false;
  timestamps: { createdAt: string | false; updatedAt: string | false };
  /** Custom schema `toJSON` transform applied when documents are serialized. */
  transform?: ToJsonTransform;
}

interface SchemaExpr {
  definition: any;
  options: any;
  file: string;
  /** Local variable name of the schema (`const <varName> = mongoose.Schema(...)`). */
  varName?: string;
}

interface MongooseIndex {
  byName: Map<string, MongooseModel>;
  /** `${file}::${localName}` -> model name. */
  varModel: Map<string, string>;
  /** file -> model name exported as default / module.exports. */
  defaultExport: Map<string, string>;
  /** `${file}::${exportName}` -> model name. */
  namedExport: Map<string, string>;
  /** `${file}::${schemaVarName}` -> parsed schema expression. */
  schemaVars: Map<string, SchemaExpr>;
  /** file -> model name returned by a default-exported model factory function. */
  factoryReturn: Map<string, string>;
  /** file -> local object name exported via `module.exports = db`. */
  defaultNamespace: Map<string, string>;
  /** `${file}::${objectText}::${prop}` -> model name assigned to a namespace object. */
  namespaceProp: Map<string, string>;
  /** Absolute source file name -> project-relative path. */
  fileToRel: Map<string, string>;
}

const cache = new WeakMap<TsAnalysis, MongooseIndex>();

// Mongoose query builders that return an array of documents.
const ARRAY_DOC_METHODS = new Set(["find"]);
// Query builders that return a single document or null.
const SINGLE_DOC_OR_NULL_METHODS = new Set([
  "findOne",
  "findById",
  "findByIdAndUpdate",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findByIdAndReplace",
  "findByIdAndDelete",
  "findOneAndDelete",
  "findByIdAndRemove",
  "findOneAndRemove",
]);
const UPDATE_RESULT_METHODS = new Set(["updateOne", "updateMany", "replaceOne", "bulkWrite"]);
const DELETE_RESULT_METHODS = new Set(["deleteOne", "deleteMany"]);
const COUNT_METHODS = new Set([
  "countDocuments",
  "estimatedDocumentCount",
  "count",
]);
// Query modifiers that do not change the document shape and are safe to ignore
// once the originating method and projection are known.
const NEUTRAL_CHAIN = new Set([
  "sort",
  "limit",
  "skip",
  "where",
  "equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "ne",
  "in",
  "nin",
  "exists",
  "regex",
  "lean",
  "session",
  "maxTimeMS",
  "hint",
  "collation",
  "setOptions",
  "set",
  "batchSize",
  "cursor",
  "map",
]);

function textOf(node: any): string {
  return node?.getText ? node.getText() : "";
}

function isNewSchema(ts: any, node: any): boolean {
  // Mongoose accepts both `new Schema(def, opts)` and the callable form
  // `mongoose.Schema(def, opts)` (without `new`).
  if (!node || !(ts.isNewExpression(node) || ts.isCallExpression(node)) || !node.expression) {
    return false;
  }
  const callee = textOf(node.expression);
  return (
    callee === "Schema" ||
    callee === "mongoose.Schema" ||
    callee === "connection.Schema" ||
    callee === "db.Schema" ||
    /(^|\.)Schema$/.test(callee)
  );
}

/** Resolve a `require('x')` / `import 'x'` specifier to a project SourceFile. */
function resolveModuleFile(analysis: TsAnalysis, specifier: string, containingFile: string): any | undefined {
  const { ts, program, sourceByPath } = analysis;
  const byResolvedName = (fileName: string): any | undefined =>
    program.getSourceFile(fileName) ??
    [...sourceByPath.values()].find((s) => s.fileName === fileName);
  const resolved = ts.resolveModuleName
    ? ts.resolveModuleName(specifier, containingFile, program.getCompilerOptions?.() ?? {}, ts.sys).resolvedModule
    : undefined;
  if (resolved?.resolvedFileName) {
    const hit = byResolvedName(resolved.resolvedFileName);
    if (hit) return hit;
  }
  // Fallback for CommonJS require() graphs the TS program never loaded: match
  // the specifier against scanned project files by relative path suffix.
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const baseDir = containingFile.slice(0, containingFile.lastIndexOf("/"));
    const target = normalizeRelative(`${baseDir}/${specifier}`);
    for (const source of sourceByPath.values()) {
      const rel = normalizeRelative(source.fileName);
      if (rel === target || rel === `${target}.ts` || rel === `${target}.tsx` ||
          rel === `${target}.js` || rel === `${target}.jsx` ||
          rel.endsWith(`/${target}`) || rel.endsWith(`/${target}.js`)) {
        return source;
      }
    }
  }
  return undefined;
}

function normalizeRelative(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function staticString(analysis: TsAnalysis, node: any): string | undefined {
  const { ts } = analysis;
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * Returns the specifier of `const name = require("<specifier>")` declared
 * anywhere in a file (including inside function bodies), or undefined.
 */
function findRequireSpecifier(ts: any, sourceFile: any, name: string): string | undefined {
  let spec: string | undefined;
  const walk = (node: any): void => {
    if (spec) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      ts.isStringLiteralLike(node.initializer.arguments?.[0])
    ) {
      spec = node.initializer.arguments[0].text;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return spec;
}

function literalValue(analysis: TsAnalysis, node: any): unknown {
  const { ts, checker } = analysis;
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  try {
    const v = checker.getConstantValue?.(node);
    if (v !== undefined) return v;
  } catch {
    /* ignore */
  }
  return undefined;
}

function buildIndex(analysis: TsAnalysis): MongooseIndex {
  const existing = cache.get(analysis);
  if (existing) return existing;
  const { ts, sourceByPath } = analysis;

  const index: MongooseIndex = {
    byName: new Map(),
    varModel: new Map(),
    defaultExport: new Map(),
    namedExport: new Map(),
    schemaVars: new Map(),
    factoryReturn: new Map(),
    defaultNamespace: new Map(),
    namespaceProp: new Map(),
    fileToRel: new Map(),
  };
  // Publish early so helpers that rely on `relativeFile` (via the cache) can
  // resolve project-relative paths while the index is still being built.
  cache.set(analysis, index);

  const isModelCall = (node: any): boolean =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "model" &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0]);

  // Pass A: collect `const x = new Schema(def, opts)` per file, and map absolute
  // file names to project-relative paths.
  for (const [rel, source] of sourceByPath) {
    index.fileToRel.set(source.fileName, rel);
    const visit = (n: any) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        isNewSchema(ts, n.initializer) &&
        ts.isIdentifier(n.name)
      ) {
        const init = n.initializer;
        index.schemaVars.set(`${rel}::${n.name.text}`, {
          definition: init.arguments[0],
          options: init.arguments[1],
          file: rel,
          varName: n.name.text,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  const resolveSchemaExpr = (file: string, expr: any): SchemaExpr | undefined => {
    if (isNewSchema(ts, expr)) {
      return { definition: expr.arguments[0], options: expr.arguments[1], file };
    }
    if (expr && ts.isIdentifier(expr)) {
      const direct = index.schemaVars.get(`${file}::${expr.text}`);
      if (direct) return direct;
    }
    return undefined;
  };

  const registerModel = (file: string, call: any) => {
    const name = staticString(analysis, call.arguments[0]);
    if (!name) return;
    const schemaExpr = resolveSchemaExpr(file, call.arguments[1]);
    if (!index.byName.has(name)) {
      index.byName.set(name, buildModel(analysis, index, name, schemaExpr));
    }
    // Variable assignment `const User = mongoose.model(...)`.
    let p: any = call.parent;
    while (p && !ts.isVariableDeclaration(p) && !ts.isSourceFile(p) && !(ts.isBinaryExpression(p) && p.operatorToken?.kind === ts.SyntaxKind.EqualsToken) && !ts.isExportAssignment(p)) {
      p = p.parent;
    }
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      index.varModel.set(`${file}::${p.name.text}`, name);
      const vs = p.parent?.parent;
      if (vs && ts.isVariableStatement(vs) && hasModifier(ts, vs, ts.SyntaxKind.ExportKeyword)) {
        index.namedExport.set(`${file}::${p.name.text}`, name);
      }
    } else if (p && ts.isExportAssignment(p) && !p.isExportEquals) {
      index.defaultExport.set(file, name);
    } else if (p && ts.isBinaryExpression(p) && isModuleExports(ts, p.left)) {
      index.defaultExport.set(file, name);
    }
  };

  // Returns the single model name a model factory function returns, or
  // undefined when the returns are missing, disagree, or do not denote a model.
  // Only return statements that belong directly to the factory body count;
  // nested callbacks are ignored.
  const collectFactoryReturnModel = (fileRel: string, fn: any): string | undefined => {
    const candidates = new Set<string>();
    const walk = (node: any, inFactory: boolean): void => {
      if (ts.isReturnStatement(node) && inFactory && node.expression) {
        const returned = node.expression;
        if (ts.isIdentifier(returned)) {
          const model = index.varModel.get(`${fileRel}::${returned.text}`);
          if (model) candidates.add(model);
        } else if (isModelCall(returned)) {
          // `return mongoose.model("item", schema)` without an intermediate const.
          const model = staticString(analysis, returned.arguments[0]);
          if (model) candidates.add(model);
        }
        return;
      }
      const nested =
        node !== fn &&
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));
      ts.forEachChild(node, (child: any) => walk(child, inFactory && !nested));
    };
    walk(fn, true);
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };

  // Pass B (round 1): collect model registrations, re-exports, and the model
  // returned by a default-exported model factory (`module.exports = mongoose =>
  // { const T = mongoose.model(name, schema); return T; }`).
  for (const [rel, source] of sourceByPath) {
    const visit = (n: any) => {
      if (isModelCall(n)) registerModel(rel, n);
      if (ts.isExportAssignment(n) && n.expression && ts.isIdentifier(n.expression) && !n.isExportEquals) {
        const target = index.varModel.get(`${rel}::${n.expression.text}`);
        if (target) index.defaultExport.set(rel, target);
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken?.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(ts, n.left) &&
        n.right && ts.isIdentifier(n.right)
      ) {
        const target = index.varModel.get(`${rel}::${n.right.text}`);
        if (target) index.defaultExport.set(rel, target);
      }
      // `const User = mongoose.model(...); export { User };`
      if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) {
        for (const el of n.exportClause.elements) {
          const local = el.propertyName?.text ?? el.name.text;
          const target = index.varModel.get(`${rel}::${local}`);
          if (target) index.namedExport.set(`${rel}::${el.name.text}`, target);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  // Resolve an expression that denotes a model, used for namespace object
  // property assignments (`db.user = require("./user.model")(mongoose)`).
  const exprToModel = (expr: any, ownerRel: string, ownerSource: any): string | undefined => {
    if (!expr) return undefined;
    if (ts.isIdentifier(expr)) return index.varModel.get(`${ownerRel}::${expr.text}`);
    if (isModelCall(expr)) return staticString(analysis, expr.arguments[0]);
    const callee = ts.isCallExpression(expr) ? expr.expression : undefined;
    // Immediate factory invocation: require("./x.model")(mongoose)
    if (callee && ts.isCallExpression(callee) &&
        ts.isIdentifier(callee.expression) && callee.expression.text === "require" &&
        ts.isStringLiteralLike(callee.arguments?.[0])) {
      const spec = callee.arguments[0].text;
      const mod = resolveModuleFile(analysis, spec, ownerSource.fileName);
      if (mod) return index.factoryReturn.get(relativeFile(analysis, mod.fileName));
      return undefined;
    }
    // Bound factory invocation: const factory = require("./x.model"); factory(mongoose)
    if (callee && ts.isIdentifier(callee)) {
      const spec = findRequireSpecifier(ts, ownerSource, callee.text);
      if (spec) {
        const mod = resolveModuleFile(analysis, spec, ownerSource.fileName);
        if (mod) return index.factoryReturn.get(relativeFile(analysis, mod.fileName));
      }
    }
    return undefined;
  };

  // Pass B (round 2a): factory returns (`module.exports = mongoose => { ...;
  // return Model; }`) and namespace object exports (`module.exports = db`) now
  // that every model variable is registered in round 1.
  for (const [rel, source] of sourceByPath) {
    const visit = (n: any) => {
      const isDefaultAssign =
        ts.isBinaryExpression(n) &&
        n.operatorToken?.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(ts, n.left);
      if (isDefaultAssign && n.right && ts.isIdentifier(n.right) && !index.defaultExport.has(rel)) {
        index.defaultNamespace.set(rel, n.right.text);
      }
      const factoryFn =
        isDefaultAssign && n.right && (ts.isArrowFunction(n.right) || ts.isFunctionExpression(n.right))
          ? n.right
          : ts.isExportAssignment(n) && !n.isExportEquals && n.expression &&
              (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))
            ? n.expression
            : undefined;
      if (factoryFn && !index.factoryReturn.has(rel)) {
        const returned = collectFactoryReturnModel(rel, factoryFn);
        if (returned) index.factoryReturn.set(rel, returned);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  // Pass B (round 2b): resolve namespace property assignments (`db.user =
  // require("./user.model")(mongoose)`) after factory returns are known.
  for (const [rel, source] of sourceByPath) {
    const visit = (n: any) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken?.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        !isModuleExports(ts, n.left)
      ) {
        const objText = n.left.expression.getText(source);
        const prop = n.left.name.text;
        const model = exprToModel(n.right, rel, source);
        if (model) index.namespaceProp.set(`${rel}::${objText}::${prop}`, model);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }

  cache.set(analysis, index);
  return index;
}

function hasModifier(ts: any, node: any, kind: number): boolean {
  return !!node?.modifiers?.some((m: any) => m.kind === kind);
}

function isModuleExports(ts: any, node: any): boolean {
  if (!node) return false;
  const t = textOf(node);
  return t === "module.exports" || t === "exports.default";
}

function buildModel(analysis: TsAnalysis, index: MongooseIndex, name: string, schemaExpr?: SchemaExpr): MongooseModel {
  const fields = new Map<string, MongooseField>();
  const model: MongooseModel = {
    name,
    sourceSchema: schemaExpr,
    fields,
    idField: true,
    versionKey: "__v",
    timestamps: { createdAt: false, updatedAt: false },
  };
  if (!schemaExpr?.definition) return model;

  // Schema options.
  if (schemaExpr.options && analysis.ts.isObjectLiteralExpression(schemaExpr.options)) {
    const opts = objectRecord(analysis, schemaExpr.options);
    if (opts._id === false) model.idField = false;
    if ("versionKey" in opts) {
      model.versionKey = opts.versionKey === false ? false : typeof opts.versionKey === "string" ? opts.versionKey : "__v";
    }
    const ts = opts.timestamps;
    if (ts === true) {
      model.timestamps = { createdAt: "createdAt", updatedAt: "updatedAt" };
    } else if (ts && typeof ts === "object") {
      model.timestamps = {
        createdAt: typeof ts.createdAt === "string" ? ts.createdAt : ts.createdAt === false ? false : "createdAt",
        updatedAt: typeof ts.updatedAt === "string" ? ts.updatedAt : ts.updatedAt === false ? false : "updatedAt",
      };
    }
  }

  if (analysis.ts.isObjectLiteralExpression(schemaExpr.definition)) {
    for (const prop of schemaExpr.definition.properties) {
      if (!analysis.ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(analysis.ts, prop);
      if (key === undefined || key === "_id" || key === "__v") continue;
      const field = parseField(analysis, index, key, prop.initializer, schemaExpr.file, new Set());
      if (field) fields.set(key, field);
    }
  }

  if (schemaExpr.varName) {
    const source = analysis.sourceByPath.get(schemaExpr.file);
    if (source) model.transform = parseToJsonTransform(analysis, source, schemaExpr.varName);
  }
  return model;
}

/**
 * Statically recover a custom schema `toJSON` transform. Handles the common
 * rest-destructuring form:
 *   schema.method("toJSON", function () {
 *     const { __v, _id, ...object } = this.toObject();
 *     object.id = _id;
 *     return object;
 *   });
 * as well as `schema.set("toJSON", { transform })`. Only structural removals
 * and same-document key copies are recovered; anything more dynamic is left
 * unknown rather than guessed.
 */
function parseToJsonTransform(analysis: TsAnalysis, source: any, varName: string): ToJsonTransform | undefined {
  const { ts } = analysis;
  let fn: any;
  const findFn = (n: any): void => {
    if (fn) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const pa = n.expression;
      const onSchema = ts.isIdentifier(pa.expression) && pa.expression.text === varName;
      const isFn = (x: any): boolean => ts.isFunctionExpression(x) || ts.isArrowFunction(x);
      if (
        onSchema &&
        pa.name.text === "method" &&
        ts.isStringLiteralLike(n.arguments?.[0]) &&
        n.arguments[0].text === "toJSON" &&
        isFn(n.arguments?.[1])
      ) {
        fn = n.arguments[1];
      }
      if (
        onSchema &&
        pa.name.text === "set" &&
        ts.isStringLiteralLike(n.arguments?.[0]) &&
        n.arguments[0].text === "toJSON" &&
        n.arguments?.[1] &&
        ts.isObjectLiteralExpression(n.arguments[1])
      ) {
        const trProp = n.arguments[1].properties.find(
          (p: any) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "transform" &&
            isFn(p.initializer),
        );
        if (trProp) fn = trProp.initializer;
      }
    }
    ts.forEachChild(n, findFn);
  };
  findFn(source);
  if (!fn || !fn.body) return undefined;

  const omit = new Set<string>();
  let restName: string | undefined;
  const findDestructure = (n: any): void => {
    if (ts.isVariableDeclaration(n) && n.name && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        if (el.dotDotDotToken) restName = el.name.text;
        else omit.add(el.name.text);
      }
    }
    ts.forEachChild(n, findDestructure);
  };
  findDestructure(fn.body);
  if (!restName) return undefined;

  const copyFrom = new Map<string, string>();
  const findAssign = (n: any): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === restName &&
      ts.isIdentifier(n.left.name) &&
      ts.isIdentifier(n.right)
    ) {
      copyFrom.set(n.left.name.text, n.right.text);
    }
    ts.forEachChild(n, findAssign);
  };
  findAssign(fn.body);

  if (omit.size === 0 && copyFrom.size === 0) return undefined;
  return { omit, copyFrom };
}

/** Apply a recovered `toJSON` transform to a serialized document schema. */
function applyToJsonTransform(doc: JsonSchema, transform?: ToJsonTransform): JsonSchema {
  if (!transform || doc.type !== "object" || !doc.properties) return doc;
  const out: JsonSchema = JSON.parse(JSON.stringify(doc));
  const props = out.properties as Record<string, JsonSchema>;
  const required = new Set<string>(Array.isArray(out.required) ? (out.required as string[]) : []);
  // Copy before omitting: a copied key may source from a key that is removed
  // afterwards (e.g. `id` copies from `_id`, then `_id` is stripped).
  for (const [added, src] of transform.copyFrom) {
    if (props[src] !== undefined) {
      props[added] = JSON.parse(JSON.stringify(props[src]));
      if (required.has(src)) required.add(added);
    }
  }
  for (const key of transform.omit) {
    delete props[key];
    required.delete(key);
  }
  if (required.size > 0) out.required = [...required];
  else delete out.required;
  return out;
}

function objectRecord(analysis: TsAnalysis, obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!analysis.ts.isObjectLiteralExpression(obj)) return out;
  for (const prop of obj.properties) {
    if (!analysis.ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(analysis.ts, prop);
    if (key === undefined) continue;
    out[key] = literalValue(analysis, prop.initializer);
  }
  return out;
}

function propertyName(ts: any, prop: any): string | undefined {
  if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name)) {
    return prop.name.text;
  }
  return undefined;
}

/** Map a Mongoose schema type constructor / type node to a JSON schema. */
function scalarFromType(analysis: TsAnalysis, index: MongooseIndex, typeNode: any, file: string, depth: Set<any>): JsonSchema | undefined {
  const { ts } = analysis;
  if (!typeNode) return undefined;

  if (ts.isIdentifier(typeNode)) {
    switch (typeNode.text) {
      case "String":
        return { type: "string" };
      case "Number":
        return { type: "number" };
      case "Boolean":
        return { type: "boolean" };
      case "Date":
        return { type: "string", format: "date-time" };
      case "Buffer":
        return { type: "string", format: "byte" };
      case "Object":
        return { type: "object" };
      case "Array":
        return { type: "array", items: {} };
      case "Decimal128":
        return { type: "string" };
      case "Double":
      case "Int32":
        return { type: "number" };
      case "Long":
        return { type: "integer" };
      case "BigInt":
        return { type: "integer" };
      case "UUID":
        return { type: "string", format: "uuid" };
      case "ObjectId":
        return { type: "string" };
      case "Map":
        return { type: "object", additionalProperties: {} };
      default:
        return undefined;
    }
  }

  if (ts.isPropertyAccessExpression(typeNode) || ts.isQualifiedName?.((typeNode as any))) {
    const chain = textOf(typeNode);
    if (/ObjectId$/.test(chain)) return { type: "string" };
    if (/Decimal128$/.test(chain)) return { type: "string" };
    if (/Double$/.test(chain)) return { type: "number" };
    if (/Int32$|Long$/.test(chain)) return { type: "integer" };
    if (/(^|\.)Mixed$/.test(chain)) return { type: "object" };
    if (/(^|\.)Map$/.test(chain)) return { type: "object", additionalProperties: {} };
    if (/Buffer$/.test(chain)) return { type: "string", format: "byte" };
    if (/Date$/.test(chain)) return { type: "string", format: "date-time" };
    if (/String$/.test(chain)) return { type: "string" };
    if (/Number$/.test(chain)) return { type: "number" };
    if (/Boolean$/.test(chain)) return { type: "boolean" };
    if (/UUID$/.test(chain)) return { type: "string", format: "uuid" };
    return undefined;
  }

  if (isNewSchema(ts, typeNode)) {
    return subdocumentSchema(analysis, index, typeNode.arguments[0], typeNode.arguments[1], file, depth);
  }

  return undefined;
}

/** Build the object schema for a nested path (no _id) or subdocument schema (_id). */
function subdocumentSchema(analysis: TsAnalysis, index: MongooseIndex, definition: any, options: any, file: string, depth: Set<any>): JsonSchema {
  const { ts } = analysis;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const hasId = options ? objectRecord(analysis, options)._id !== false : true;
  if (hasId) {
    properties._id = { type: "string" };
    required.push("_id");
  }
  if (definition && depth.has(definition)) {
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  const next = new Set(depth).add(definition);
  if (ts.isObjectLiteralExpression(definition)) {
    for (const prop of definition.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(ts, prop);
      if (key === undefined || key === "_id") continue;
      const field = parseField(analysis, index, key, prop.initializer, file, next);
      if (!field) continue;
      properties[key] = field.schema;
      if (field.required) required.push(key);
    }
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/**
 * Parse one schema path. Handles constructor shorthand, definition objects
 * (`{ type, required, enum, ref, default, select }`), arrays, nested paths and
 * inline subdocuments. `depth` is a set of visited definition nodes to guard
 * against recursive schema literals (never field names, which repeat in arrays).
 */
function parseField(analysis: TsAnalysis, index: MongooseIndex, name: string, node: any, file: string, depth: Set<any>): MongooseField | undefined {
  const { ts } = analysis;
  if (!node || depth.has(node)) return undefined;

  // Array shorthand: `[String]`, `[{ ... }]`, `[otherSchema]`.
  if (ts.isArrayLiteralExpression(node)) {
    const el = node.elements[0];
    if (!el) return { name, schema: { type: "array", items: {} }, required: false };
    if (isNewSchema(ts, el)) {
      return { name, schema: { type: "array", items: subdocumentSchema(analysis, index, el.arguments[0], el.arguments[1], file, depth) }, required: false };
    }
    if (ts.isObjectLiteralExpression(el) && !el.properties.some((p: any) => ts.isPropertyAssignment(p) && propertyName(ts, p) === "type")) {
      return { name, schema: { type: "array", items: nestedObject(analysis, index, el, file, depth) }, required: false };
    }
    const inner = parseField(analysis, index, name, el, file, depth);
    const itemSchema = inner?.ref ? refIdSchema(inner) : inner?.schema ?? {};
    return { name, schema: { type: "array", items: itemSchema }, required: false, ref: inner?.ref, dynamicRef: inner?.dynamicRef };
  }

  // Definition object: `{ type, required, enum, ref, default, select, ... }`.
  if (ts.isObjectLiteralExpression(node)) {
    const hasType = node.properties.some((p: any) => ts.isPropertyAssignment(p) && propertyName(ts, p) === "type");
    if (hasType) {
      const rec = objectRecordFull(analysis, node);
      const typeNode = getPropertyNode(ts, node, "type");
      const required = rec.required === true || rec.default !== undefined;
      const base: MongooseField = { name, schema: {}, required, hiddenByDefault: rec.select === false };
      if (rec.refPath) {
        base.dynamicRef = true;
        base.schema = resolveDefinitionType(analysis, index, typeNode, rec, file, depth);
        return base;
      }
      if (typeof rec.ref === "string") base.ref = rec.ref;
      let schema = resolveDefinitionType(analysis, index, typeNode, rec, file, depth);
      if (Array.isArray(rec.enum) && rec.enum.length && (schema.type === "string" || schema.type === "number" || schema.type === "integer")) {
        schema = { ...schema, enum: rec.enum };
      }
      base.schema = schema;
      return base;
    }
    // Plain nested path: `address: { street: String, city: String }`.
    return { name, schema: nestedObject(analysis, index, node, file, depth), required: false };
  }

  // Inline subdocument via `new Schema(...)`.
  if (isNewSchema(ts, node)) {
    return { name, schema: subdocumentSchema(analysis, index, node.arguments[0], node.arguments[1], file, depth), required: false };
  }

  // Constructor / property-access scalar shorthand.
  const scalar = scalarFromType(analysis, index, node, file, depth);
  if (scalar) {
    return { name, schema: scalar, required: false };
  }
  // Opaque function/class type: free-form, do not fabricate fields.
  return { name, schema: {}, required: false };
}

function nestedObject(analysis: TsAnalysis, index: MongooseIndex, node: any, file: string, depth: Set<any>): JsonSchema {
  const { ts } = analysis;
  if (depth.has(node)) return { type: "object" };
  const next = new Set(depth).add(node);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(ts, prop);
    if (key === undefined) continue;
    const field = parseField(analysis, index, key, prop.initializer, file, next);
    if (!field) continue;
    properties[key] = field.schema;
    if (field.required) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function resolveDefinitionType(analysis: TsAnalysis, index: MongooseIndex, typeNode: any, rec: Record<string, any>, file: string, depth: Set<any>): JsonSchema {
  const { ts } = analysis;
  if (!typeNode) return {};
  // `type: [String]` / `type: [{ ... }]`.
  if (ts.isArrayLiteralExpression(typeNode)) {
    const el = typeNode.elements[0];
    if (!el) return { type: "array", items: {} };
    if (isNewSchema(ts, el)) return { type: "array", items: subdocumentSchema(analysis, index, el.arguments[0], el.arguments[1], file, depth) };
    if (ts.isObjectLiteralExpression(el)) {
      const elRec = objectRecordFull(analysis, el);
      if ("type" in elRec) {
        const item = resolveDefinitionType(analysis, index, getPropertyNode(ts, el, "type"), elRec, file, depth);
        return { type: "array", items: attachRef(item, elRec) };
      }
      return { type: "array", items: nestedObject(analysis, index, el, file, depth) };
    }
    const scalar = scalarFromType(analysis, index, el, file, depth) ?? {};
    return { type: "array", items: attachRef(scalar, rec) };
  }
  if (isNewSchema(ts, typeNode)) return subdocumentSchema(analysis, index, typeNode.arguments[0], typeNode.arguments[1], file, depth);
  const scalar = scalarFromType(analysis, index, typeNode, file, depth);
  if (scalar) return attachRef(scalar, rec);
  if (ts.isObjectLiteralExpression(typeNode)) return nestedObject(analysis, index, typeNode, file, depth);
  return {};
}

function attachRef(schema: JsonSchema, rec: Record<string, any>): JsonSchema {
  // Refs are tracked on the field wrapper; the raw ObjectId still serializes
  // to a string until populate() expands it.
  return schema;
}

function refIdSchema(field: MongooseField): JsonSchema {
  return { type: "string" };
}

function objectRecordFull(analysis: TsAnalysis, node: any): Record<string, any> {
  const { ts } = analysis;
  const out: Record<string, any> = {};
  if (!ts.isObjectLiteralExpression(node)) return out;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(ts, prop);
    if (key === undefined) continue;
    const v = prop.initializer;
    if (ts.isArrayLiteralExpression(v)) {
      out[key] = v.elements.map((e: any) => literalValue(analysis, e)).filter((x: unknown) => x !== undefined);
    } else {
      const lv = literalValue(analysis, v);
      if (lv !== undefined) out[key] = lv;
      else if (ts.isStringLiteralLike(v)) out[key] = v.text;
    }
  }
  return out;
}

function getPropertyNode(ts: any, obj: any, key: string): any {
  const prop = obj.properties.find(
    (p: any) => ts.isPropertyAssignment(p) && propertyName(ts, p) === key,
  );
  return prop?.initializer;
}

// ---------------------------------------------------------------------------
// Model resolution across files (default import, named import, require).
// ---------------------------------------------------------------------------

function modelFromModule(
  analysis: TsAnalysis,
  index: MongooseIndex,
  specifier: string,
  containingFile: string,
  kind: "default" | "named",
  importedName: string | undefined,
  seen: Set<string>,
): string | undefined {
  const mod = resolveModuleFile(analysis, specifier, containingFile);
  if (!mod) return undefined;
  const modRel = relativeFile(analysis, mod.fileName);
  const guard = `${modRel}:${specifier}:${kind}:${importedName ?? ""}`;
  if (seen.has(guard)) return undefined;
  seen.add(guard);
  if (kind === "default") return index.defaultExport.get(modRel);
  const prop = importedName as string;
  const direct =
    index.namedExport.get(`${modRel}::${prop}`) ??
    index.varModel.get(`${modRel}::${prop}`);
  if (direct) return direct;
  // Namespace object export (`module.exports = db; db.user = ...`).
  const nsObj = index.defaultNamespace.get(modRel);
  const candidates = [nsObj, "exports", "module.exports"];
  for (const obj of candidates) {
    if (!obj) continue;
    const viaProp = index.namespaceProp.get(`${modRel}::${obj}::${prop}`);
    if (viaProp) return viaProp;
  }
  return undefined;
}

/** Type-independent resolution of an imported/required/aliased model binding. */
function resolveBindingSyntactically(
  analysis: TsAnalysis,
  index: MongooseIndex,
  source: any,
  localName: string,
  seen: Set<string>,
): string | undefined {
  const { ts } = analysis;
  const modelFromInit = (init: any): string | undefined => {
    if (
      ts.isCallExpression(init) &&
      textOf(init.expression) === "require" &&
      ts.isStringLiteralLike(init.arguments[0])
    ) {
      return modelFromModule(analysis, index, init.arguments[0].text, source.fileName, "default", undefined, seen);
    }
    if (ts.isIdentifier(init)) {
      const rel = relativeFile(analysis, source.fileName);
      return (
        index.varModel.get(`${rel}::${init.text}`) ??
        resolveBindingSyntactically(analysis, index, source, init.text, seen)
      );
    }
    // const Tutorial = db.tutorials  (db is a required module namespace)
    if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.name)) {
      const prop = init.name.text;
      let specifier: string | undefined;
      if (ts.isIdentifier(init.expression)) {
        specifier = findRequireSpecifier(ts, source, init.expression.text);
      } else if (
        ts.isCallExpression(init.expression) &&
        textOf(init.expression.expression) === "require" &&
        ts.isStringLiteralLike(init.expression.arguments?.[0])
      ) {
        specifier = init.expression.arguments[0].text;
      }
      if (specifier) {
        return modelFromModule(analysis, index, specifier, source.fileName, "named", prop, seen);
      }
    }
    // const doc = new Tutorial(...): the instance belongs to the Tutorial model.
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      const rel = relativeFile(analysis, source.fileName);
      return (
        index.varModel.get(`${rel}::${init.expression.text}`) ??
        resolveBindingSyntactically(analysis, index, source, init.expression.text, seen)
      );
    }
    return undefined;
  };

  for (const st of source.statements) {
    if (
      ts.isImportDeclaration(st) &&
      st.importClause &&
      ts.isStringLiteralLike(st.moduleSpecifier)
    ) {
      const specifier = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause.name && clause.name.text === localName) {
        const m = modelFromModule(analysis, index, specifier, source.fileName, "default", undefined, seen);
        if (m) return m;
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.name.text === localName) {
            const imported = el.propertyName?.text ?? el.name.text;
            const m = modelFromModule(analysis, index, specifier, source.fileName, "named", imported, seen);
            if (m) return m;
          }
        }
      }
    }
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== localName || !decl.initializer) continue;
        const m = modelFromInit(decl.initializer);
        if (m) return m;
      }
    }
  }

  // Fallback: the binding may be declared inside a function body, for example
  // `const doc = new Model()` inside an exported handler. Resolve the nearest
  // nested declaration with the same name.
  let nested: any;
  const findNested = (n: any): void => {
    if (nested) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === localName &&
      n.initializer
    ) {
      nested = n;
      return;
    }
    ts.forEachChild(n, findNested);
  };
  findNested(source);
  if (nested) {
    const m = modelFromInit(nested.initializer);
    if (m) return m;
  }
  return undefined;
}

function resolveModelName(analysis: TsAnalysis, index: MongooseIndex, ident: any, seen: Set<string> = new Set()): string | undefined {
  const { ts, checker } = analysis;
  if (!ident || !ts.isIdentifier(ident)) return undefined;
  const file = ident.getSourceFile().fileName;
  const rel = relativeFile(analysis, file);
  const localKey = `${rel}::${ident.text}`;
  if (index.varModel.has(localKey)) return index.varModel.get(localKey);

  // Syntactic, type-independent binding resolution first: this keeps working
  // even when `mongoose` is not installed and the checker reports the import as
  // unresolved (any). Covers default/named imports, require() and local aliases.
  const source = ident.getSourceFile();
  const lexical = symbolDeclaration(analysis, ident);
  if (lexical && ts.isBindingElement(lexical)) {
    const init = lexical.parent?.parent?.initializer;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' && init.arguments[0] && ts.isStringLiteralLike(init.arguments[0])) {
      const imported = (lexical.propertyName ?? lexical.name).text;
      const model = modelFromModule(analysis, index, init.arguments[0].text, file, 'named', imported, seen);
      if (model) return model;
    }
  }
  const syntactic = resolveBindingSyntactically(analysis, index, source, ident.text, seen);
  if (syntactic) return syntactic;

  const symbol = checker.getSymbolAtLocation(ident);
  const decls = symbol?.declarations ?? [];
  for (const decl of decls) {
    // import User from 'x'  /  import { User } from 'x'
    const importClause = findAncestor(decl, ts.isImportClause);
    const importSpec = ts.isImportSpecifier?.(decl) ? decl : undefined;
    const clause = importClause ?? importSpec?.parent?.parent;
    if (clause && clause.parent?.moduleSpecifier) {
      const specifier = clause.parent.moduleSpecifier.text;
      const mod = resolveModuleFile(analysis, specifier, file);
      if (!mod) continue;
      const modRel = relativeFile(analysis, mod.fileName);
      const guard = `${modRel}:${specifier}`;
      if (seen.has(guard)) continue;
      seen.add(guard);
      if (importSpec) {
        const importedName = importSpec.propertyName?.text ?? importSpec.name.text;
        const named = index.namedExport.get(`${modRel}::${importedName}`) ?? index.varModel.get(`${modRel}::${importedName}`);
        if (named) return named;
      } else {
        const def = index.defaultExport.get(modRel);
        if (def) return def;
      }
      continue;
    }
    // const User = require('x')  or  const Alias = UserModel
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = decl.initializer;
      if (
        ts.isCallExpression(init) &&
        textOf(init.expression) === "require" &&
        init.arguments[0] &&
        ts.isStringLiteralLike(init.arguments[0])
      ) {
        const mod = resolveModuleFile(analysis, init.arguments[0].text, file);
        if (mod) {
          const def = index.defaultExport.get(relativeFile(analysis, mod.fileName));
          if (def) return def;
        }
      }
      if (ts.isIdentifier(init)) {
        const target = resolveModelName(analysis, index, init, seen);
        if (target) return target;
      }
    }
  }
  return undefined;
}

function normalizeRealPath(p: string): string {
  // macOS resolves /tmp through /private/tmp; canonicalize that symlink prefix
  // so program-supplied and scanner-supplied file names compare equal.
  return p.replace(/^\/private(?=\/(?:tmp|var|Users)\/)/, "");
}

function relativeFile(analysis: TsAnalysis, fileName: string): string {
  const index = cache.get(analysis);
  if (!index) return fileName;
  const direct = index.fileToRel.get(fileName);
  if (direct) return direct;
  const target = normalizeRealPath(fileName);
  for (const [absolute, rel] of index.fileToRel) {
    if (normalizeRealPath(absolute) === target) return rel;
  }
  return fileName;
}

function findAncestor(node: any, pred: (n: any) => boolean): any | undefined {
  let cur = node;
  while (cur) {
    if (pred(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Document shape + projection + populate.
// ---------------------------------------------------------------------------

function baseDocument(model: MongooseModel): { properties: Record<string, JsonSchema>; required: string[]; hidden: Set<string> } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const hidden = new Set<string>();
  for (const [key, field] of model.fields) {
    if (field.hiddenByDefault) hidden.add(key);
    properties[key] = field.schema;
    if (field.required) required.push(key);
  }
  if (model.idField) {
    properties._id = { type: "string" };
    required.unshift("_id");
  }
  if (model.versionKey) {
    properties[model.versionKey] = { type: "integer" };
  }
  const c = model.timestamps.createdAt;
  const u = model.timestamps.updatedAt;
  if (c) {
    properties[c] = { type: "string", format: "date-time" };
    required.push(c);
  }
  if (u) {
    properties[u] = { type: "string", format: "date-time" };
    required.push(u);
  }
  return { properties, required, hidden };
}

interface Projection {
  include?: Set<string>;
  exclude?: Set<string>;
  excludeId?: boolean;
}

function parseProjection(analysis: TsAnalysis, node: any): Projection | undefined {
  const { ts } = analysis;
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) {
    const tokens: string[] = node.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return undefined;
    const inclusion = tokens.some((t) => !t.startsWith("-"));
    if (inclusion) {
      const include = new Set(tokens.filter((t) => !t.startsWith("-")));
      return { include, excludeId: tokens.includes("-_id") };
    }
    return { exclude: new Set(tokens.map((t) => t.slice(1))) };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const include = new Set<string>();
    const exclude = new Set<string>();
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(ts, prop);
      if (key === undefined) continue;
      const v = literalValue(analysis, prop.initializer);
      if (v === 1 || v === true) include.add(key);
      else if (v === 0 || v === false) exclude.add(key);
    }
    if (include.size) return { include, excludeId: exclude.has("_id") };
    if (exclude.size) return { exclude };
  }
  return undefined;
}

function mergeProjection(a: Projection | undefined, b: Projection | undefined): Projection | undefined {
  // An explicit chain `.select(...)` wins over the find() projection argument.
  return b ?? a;
}

function applyProjection(base: ReturnType<typeof baseDocument>, proj: Projection | undefined): JsonSchema {
  const hidden = base.hidden;
  let properties: Record<string, JsonSchema> = { ...base.properties };
  if (proj?.include) {
    const keep = proj.include;
    properties = Object.fromEntries(
      Object.entries(properties).filter(
        ([k]) => keep.has(k) || (k === "_id" && !proj.excludeId),
      ),
    );
  } else {
    const drop = new Set<string>([...hidden, ...(proj?.exclude ?? [])]);
    properties = Object.fromEntries(
      Object.entries(properties).filter(([k]) => !drop.has(k)),
    );
  }
  const required = (base.required as string[]).filter((k) => k in properties);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

interface PopulateStep {
  path: string;
  select?: Projection;
  model?: string;
}

function parsePopulate(analysis: TsAnalysis, arg: any): PopulateStep[] {
  const { ts } = analysis;
  if (!arg) return [];
  if (ts.isStringLiteralLike(arg)) {
    return arg.text.split(/\s+/).filter(Boolean).map((path: string) => ({ path }));
  }
  if (ts.isObjectLiteralExpression(arg)) {
    const rec = objectRecordFull(analysis, arg);
    const path = typeof rec.path === "string" ? rec.path : undefined;
    if (!path) return [];
    const step: PopulateStep = { path };
    if (typeof rec.model === "string") step.model = rec.model;
    const selectNode = getPropertyNode(ts, arg, "select");
    if (selectNode) step.select = parseProjection(analysis, selectNode);
    return [step];
  }
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.flatMap((e: any) => parsePopulate(analysis, e));
  return [];
}

/** Handle both populate(path) and populate(path, select, model, match, options). */
function collectPopulate(analysis: TsAnalysis, args: any[]): PopulateStep[] {
  const { ts } = analysis;
  const first = args[0];
  if (first && ts.isStringLiteralLike(first)) {
    const step: PopulateStep = { path: first.text };
    if (args[1]) step.select = parseProjection(analysis, args[1]);
    if (args[2] && ts.isStringLiteralLike(args[2])) step.model = args[2].text;
    return [step];
  }
  return args.flatMap((a) => parsePopulate(analysis, a));
}

function applyPopulates(analysis: TsAnalysis, index: MongooseIndex, model: MongooseModel, doc: JsonSchema, steps: PopulateStep[], depth: number): JsonSchema {
  if (!steps.length || depth > 6 || doc.type !== "object" || !doc.properties) return doc;
  let properties = { ...(doc.properties as Record<string, JsonSchema>) };
  const required = new Set(doc.required as string[] ?? []);
  for (const step of steps) {
    const segments = step.path.split(".");
    properties = populatePath(analysis, index, model, properties, segments, step, depth, required);
  }
  return { ...doc, properties, required: [...required].filter((k) => k in properties) };
}

function populatePath(analysis: TsAnalysis, index: MongooseIndex, model: MongooseModel, properties: Record<string, JsonSchema>, segments: string[], step: PopulateStep, depth: number, required: Set<string>): Record<string, JsonSchema> {
  const key = segments[0]!;
  const field = model.fields.get(key);
  if (!field) return properties;
  if (segments.length > 1) {
    // Nested populate inside a subdocument / nested object.
    const nested = properties[key];
    if (nested?.type === "object" && nested.properties) {
      const nestedModel: MongooseModel = { ...model, fields: new Map() };
      // Rebuild a lightweight field map for the nested shape.
      for (const [k, v] of Object.entries(nested.properties as Record<string, JsonSchema>)) {
        nestedModel.fields.set(k, { name: k, schema: v, required: (nested.required as string[] ?? []).includes(k) });
      }
      properties[key] = applyPopulates(analysis, index, nestedModel, nested, [ { path: segments.slice(1).join("."), select: step.select, model: step.model } ], depth + 1);
    }
    return properties;
  }

  const refName = step.model ?? field.ref;
  if (field.dynamicRef || !refName) {
    // Dynamic or unknown ref: populated value is an untyped document.
    const placeholder = field.schema.type === "array" ? { type: "array", items: {} } : {};
    properties[key] = placeholder;
    return properties;
  }
  const refModel = index.byName.get(refName);
  if (!refModel) return properties;
  let refDoc = applyProjection(baseDocument(refModel), step.select);
  refDoc = applyPopulates(analysis, index, refModel, refDoc, [], depth + 1);
  if (field.schema.type === "array") {
    properties[key] = { type: "array", items: refDoc };
  } else {
    properties[key] = required.has(key) ? refDoc : { anyOf: [refDoc, { type: "null" }] };
  }
  return properties;
}

// ---------------------------------------------------------------------------
// Chain collection and public entry point.
// ---------------------------------------------------------------------------

interface Chain {
  root: any;
  /** Steps from outermost to innermost; the originating query is last. */
  steps: { method: string; args: any[]; node: any }[];
}

function collectChain(ts: any, node: any): Chain | undefined {
  const steps: Chain["steps"] = [];
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 40) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      steps.push({ method: cur.expression.name.text, args: cur.arguments, node: cur });
      cur = cur.expression.expression;
      continue;
    }
    break;
  }
  if (!steps.length) return undefined;
  return { root: cur, steps };
}

function updateResultSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      acknowledged: { type: "boolean" },
      matchedCount: { type: "integer" },
      modifiedCount: { type: "integer" },
      upsertedCount: { type: "integer" },
      upsertedId: { anyOf: [{ type: "object", properties: { _id: { type: "string" } }, required: ["_id"] }, { type: "null" }] },
    },
    required: ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount"],
  };
}

function deleteResultSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      acknowledged: { type: "boolean" },
      deletedCount: { type: "integer" },
    },
    required: ["acknowledged", "deletedCount"],
  };
}

function enclosingFunction(ts: any, node: any): any {
  let p = node;
  while (
    p &&
    !ts.isArrowFunction(p) &&
    !ts.isFunctionExpression(p) &&
    !ts.isFunctionDeclaration(p) &&
    !ts.isSourceFile(p)
  ) {
    p = p.parent;
  }
  return p;
}

/** Match `req.body.field` / `req.body?.field` / `req?.body?.field`. */
function requestBodyField(ts: any, node: any): string | undefined {
  if (!node || !ts.isPropertyAccessExpression(node)) return undefined;
  const text = node.getText().replace(/\s/g, "");
  const match = /^req\??\.body\??\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Collect request body fields whose absence triggers an early exit in the
 * enclosing handler, e.g. `if (!req.body.title) return res.status(400)...`.
 * Only guards whose branch returns or throws are accepted, so a mere presence
 * check cannot over-constrain the contract.
 */
function guardedBodyFields(ts: any, scope: any): Set<string> {
  const fields = new Set<string>();
  if (!scope) return fields;

  // Collect every request field whose absence the condition tests, including
  // compound guards such as `!req.body || !req.body.name`.
  const missingFields = (expr: any): string[] => {
    const out: string[] = [];
    const visit = (e: any): void => {
      if (!e) return;
      if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
        const field = requestBodyField(ts, e.operand);
        if (field) out.push(field);
        return;
      }
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken?.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
          visit(e.left);
          visit(e.right);
          return;
        }
        const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken;
        if (loose) {
          const leftField = requestBodyField(ts, e.left);
          const field = leftField ?? requestBodyField(ts, e.right);
          const other = leftField ? e.right : e.left;
          const nullish =
            other &&
            (other.kind === ts.SyntaxKind.NullKeyword ||
              other.kind === ts.SyntaxKind.UndefinedKeyword ||
              (ts.isStringLiteral(other) && other.text === ""));
          if (field && nullish) out.push(field);
        }
      }
    };
    visit(expr);
    return out;
  };

  const branchExits = (stmt: any): boolean => {
    let exits = false;
    const walk = (n: any): void => {
      if (exits) return;
      if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
        exits = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(stmt);
    return exits;
  };

  const visit = (n: any): void => {
    if (ts.isIfStatement(n)) {
      const exits = branchExits(n.thenStatement) || (n.elseStatement && branchExits(n.elseStatement));
      if (exits) for (const field of missingFields(n.expression)) fields.add(field);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return fields;
}

/**
 * Fields a `new Model({ ... })` document is guaranteed to contain on the
 * success path: values with a default (`a || false`, `a ?? x`), non-null
 * literals, or guarded request fields proven present by an early-return check.
 */
function guaranteedInstanceFields(ts: any, obj: any, guarded: Set<string>): Set<string> {
  const fields = new Set<string>();
  if (!obj || !ts.isObjectLiteralExpression(obj)) return fields;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(ts, prop);
    if (key === undefined) continue;
    const value = prop.initializer;
    const nonNullLiteral = (v: any): boolean =>
      !!v &&
      (ts.isStringLiteralLike(v) ||
        ts.isNumericLiteral(v) ||
        v.kind === ts.SyntaxKind.TrueKeyword ||
        v.kind === ts.SyntaxKind.FalseKeyword ||
        ts.isObjectLiteralExpression(v) ||
        ts.isArrayLiteralExpression(v) ||
        ts.isNewExpression(v));
    const hasDefault =
      ts.isBinaryExpression(value) &&
      (value.operatorToken?.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken?.kind === ts.SyntaxKind.QuestionQuestionToken);
    // Ternary default: `req.body.published ? req.body.published : false` always
    // yields a value when the else branch is a non-null literal/default.
    const hasTernaryDefault =
      ts.isConditionalExpression(value) && nonNullLiteral(value.whenFalse);
    const guardedField = requestBodyField(ts, value);
    if (
      hasDefault ||
      hasTernaryDefault ||
      nonNullLiteral(value) ||
      (guardedField && guarded.has(guardedField))
    ) {
      fields.add(key);
    }
  }
  return fields;
}

/** Locate `const name = new Model(...)` in the same source file. */
function findNewInitForIdent(ts: any, ident: any): any | undefined {
  const name = ident.text;
  const sourceFile = ident.getSourceFile();
  let found: any;
  const walk = (n: any): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isNewExpression(n.initializer)
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(sourceFile);
  return found;
}

/** Full persisted document for a `new Model(obj)` / instance `.save()` result. */
function projectInstanceDoc(
  analysis: TsAnalysis,
  model: MongooseModel,
  objLiteral: any,
  scope: any,
): JsonSchema {
  const { ts } = analysis;
  let doc = applyToJsonTransform(applyProjection(baseDocument(model), undefined), model.transform);
  if (objLiteral && ts.isObjectLiteralExpression(objLiteral) && doc.type === "object" && doc.properties) {
    const guarded = guardedBodyFields(ts, scope);
    const guaranteed = guaranteedInstanceFields(ts, objLiteral, guarded);
    const props = doc.properties as Record<string, JsonSchema>;
    const required = new Set<string>(Array.isArray(doc.required) ? (doc.required as string[]) : []);
    for (const field of guaranteed) {
      if (props[field] !== undefined) required.add(field);
    }
    if (required.size > 0) doc.required = [...required];
    else delete doc.required;
  }
  return doc;
}

/** Custom instance methods/plugins may replace save; don't assume its native
 * return contract when the schema is extended by code we haven't interpreted. */
function hasInstanceExtensions(analysis: TsAnalysis, model: MongooseModel): boolean {
  const {ts} = analysis;
  const schema = model.sourceSchema;
  const source = schema && analysis.sourceByPath.get(schema.file);
  if (!source || !schema) return true;
  if (schema.options && ts.isObjectLiteralExpression(schema.options) &&
      schema.options.properties.some((p: any) => propertyName(ts, p) === 'methods')) return true;
  let extended = false;
  const visit = (node: any): void => {
    if (extended) return;
    if (ts.isPropertyAccessExpression(node) && ['methods', 'method', 'plugin', 'loadClass'].includes(node.name.text)) {
      const decl = symbolDeclaration(analysis, node.expression);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer?.arguments?.[0] === schema.definition) extended = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return extended;
}

/**
 * Project a Mongoose model call to its serialized response schema. Returns
 * undefined when the receiver is not a registered model or the result cannot
 * be proven statically.
 */
export function mongooseProjection(analysis: TsAnalysis, node: any): JsonSchema | undefined {
  const { ts } = analysis;
  const index = buildIndex(analysis);

  // `new Model(doc)` builds a full persisted document (schema paths plus _id,
  // defaults and timestamps once saved); no query projection applies.
  if (ts.isNewExpression(node)) {
    const rootIdent = unwrapRoot(ts, node.expression);
    if (!rootIdent) return undefined;
    const modelName = resolveModelName(analysis, index, rootIdent);
    const model = modelName ? index.byName.get(modelName) : undefined;
    if (!model) return undefined;
    return projectInstanceDoc(analysis, model, node.arguments?.[0], enclosingFunction(ts, node));
  }

  if (!ts.isCallExpression(node)) return undefined;
  // Inline construction has no identifier for collectChain to resolve:
  // `await new ImportedModel(input).save()` returns the persisted document.
  // Accept only the native zero-argument form and a registered model receiver.
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "save" && node.arguments.length === 0) {
    let receiver = node.expression.expression;
    while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    if (ts.isNewExpression(receiver) && (receiver.arguments?.length ?? 0) <= 1) {
      const ident = unwrapRoot(ts, receiver.expression);
      const name = ident && resolveModelName(analysis, index, ident);
      const model = name && index.byName.get(name);
      if (model && !hasInstanceExtensions(analysis, model)) return projectInstanceDoc(analysis, model, receiver.arguments?.[0], enclosingFunction(ts, node));
    }
  }
  const chain = collectChain(ts, node);
  if (!chain) return undefined;
  const rootIdent = unwrapRoot(ts, chain.root);
  if (!rootIdent) return undefined;
  const modelName = resolveModelName(analysis, index, rootIdent);
  if (!modelName) return undefined;
  const model = index.byName.get(modelName);
  if (!model) return undefined;

  // Innermost step whose receiver is the model itself = originating query.
  const ordered = [...chain.steps].reverse();
  const origin = ordered[0];
  if (!origin) return undefined;
  const method = origin.method;

  // Gather projection/populate from the chain and the query options argument.
  let proj: Projection | undefined;
  const populates: PopulateStep[] = [];
  for (const step of ordered) {
    if (step.method === "select") proj = mergeProjection(proj, parseProjection(analysis, step.args[0]));
    if (step.method === "populate") populates.push(...collectPopulate(analysis, step.args));
  }

  const buildDoc = (): JsonSchema => {
    // Locate the projection/options arguments per Mongoose method signature:
    //   find(filter, projection, options)
    //   findOne(filter, projection, options)
    //   findById(id, projection, options)
    //   findOneAnd*(filter, update, options) / findByIdAnd*(id, update, options)
    //   *AndDelete/*AndReplace(filter, options)
    const readWithProjection = method === "find" || method === "findOne" || method === "findById";
    const andUpdate = /And(Update|Replace)$/.test(method);
    const andDelete = /And(Delete|Remove)$/.test(method);
    const optionsArg = readWithProjection
      ? origin.args[2]
      : andUpdate
        ? origin.args[2]
        : andDelete
          ? origin.args[1]
          : undefined;

    let docProj = proj;
    if (!docProj && readWithProjection && origin.args[1]) {
      docProj = parseProjection(analysis, origin.args[1]);
    }
    if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
      const selectNode = getPropertyNode(ts, optionsArg, "select") ?? getPropertyNode(ts, optionsArg, "projection");
      if (selectNode) docProj = mergeProjection(docProj, parseProjection(analysis, selectNode));
      const popNode = getPropertyNode(ts, optionsArg, "populate");
      if (popNode) for (const p of [].concat(popNode as any)) populates.push(...parsePopulate(analysis, p));
    }
    let doc = applyProjection(baseDocument(model), docProj);
    doc = applyPopulates(analysis, index, model, doc, populates, 0);
    doc = applyToJsonTransform(doc, model.transform);
    return doc;
  };

  if (ARRAY_DOC_METHODS.has(method)) {
    return { type: "array", items: buildDoc() };
  }
  if (SINGLE_DOC_OR_NULL_METHODS.has(method)) {
    return { anyOf: [buildDoc(), { type: "null" }] };
  }
  // Instance `doc.save()` resolves to the saved document itself (never null).
  // Recover the original `new Model(obj)` initializer to prove fields the
  // success path is guaranteed to populate.
  if (method === "save") {
    const newInit = findNewInitForIdent(ts, rootIdent);
    return projectInstanceDoc(
      analysis,
      model,
      newInit?.arguments?.[0],
      enclosingFunction(ts, rootIdent) ?? rootIdent.getSourceFile(),
    );
  }
  if (method === "create") {
    const arrayForm =
      origin.args.length > 1 ||
      (origin.args[0] && ts.isArrayLiteralExpression(origin.args[0]));
    const scope = enclosingFunction(ts, chain.root) ?? rootIdent.getSourceFile();
    if (arrayForm) {
      return { type: "array", items: buildDoc() };
    }
    const first = origin.args[0];
    if (first && ts.isObjectLiteralExpression(first)) {
      return projectInstanceDoc(analysis, model, first, scope);
    }
    return buildDoc();
  }
  if (method === "insertMany") {
    return { type: "array", items: buildDoc() };
  }
  if (UPDATE_RESULT_METHODS.has(method)) return updateResultSchema();
  if (DELETE_RESULT_METHODS.has(method)) return deleteResultSchema();
  if (COUNT_METHODS.has(method)) return { type: "integer" };
  if (method === "exists") {
    return {
      anyOf: [
        { type: "object", properties: { _id: { type: "string" } }, required: ["_id"] },
        { type: "null" },
      ],
    };
  }
  if (method === "distinct") {
    // Distinct values are scalars of the named path; nested/dynamic paths are
    // an untyped scalar array rather than a fabricated enum.
    const fieldArg = origin.args[0];
    const path = fieldArg && ts.isStringLiteralLike(fieldArg) ? fieldArg.text : undefined;
    const field = path ? model.fields.get(path.split(".")[0]!) : undefined;
    const items = field && field.schema.type !== "object" && field.schema.type !== "array" ? field.schema : {};
    return { type: "array", items };
  }
  // aggregate(), watch(), collection helpers, etc. cannot be proven from the
  // schema: leave them to the generic gap/AI-review flow.
  return undefined;
}

function unwrapRoot(ts: any, node: any): any {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node;
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return unwrapRoot(ts, node.expression);
  }
  // `await mongoose.connection.model(...)` style direct use is handled by the
  // model-call variable form; bare connection roots are not supported.
  return undefined;
}

export interface MongooseRequestBodyInference {
  /** Writable schema path name -> JSON schema (model paths, excluding _id/version/timestamps). */
  fieldTypes: Map<string, JsonSchema>;
  /** Model paths declared `required: true`, relevant for create payloads. */
  modelRequired: Set<string>;
  /**
   * True when a handler forwards the whole `req.body` to an update call
   * (e.g. `findByIdAndUpdate(id, req.body)`): every model path is accepted and
   * all are optional (PATCH semantics).
   */
  wholeBodyUpdate: boolean;
}

const UPDATE_PAYLOAD_METHODS = new Set([
  "findByIdAndUpdate",
  "findOneAndUpdate",
  "updateOne",
  "updateMany",
  "replaceOne",
]);

/** True when an expression reads the request body (`req.body` or a value derived from it). */
function referencesRequestBody(ts: any, node: any): boolean {
  if (!node) return false;
  let hit = false;
  const walk = (n: any): void => {
    if (hit) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "body" &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "req"
    ) {
      hit = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

/**
 * Recover the writable request-body shape a handler feeds to Mongoose write
 * calls (`new Model({ ...req.body })`, `Model.create(...)`,
 * `findByIdAndUpdate(id, req.body)`). Types come from the model schema so the
 * contract does not depend on untyped JS `req.body` access. Only proven model
 * paths are returned; dynamic/unknown keys stay unreported.
 */
export function inferMongooseRequestBody(
  analysis: TsAnalysis,
  handlerNode: any,
): MongooseRequestBodyInference | undefined {
  const { ts } = analysis;
  if (!handlerNode) return undefined;
  const index = buildIndex(analysis);
  const fieldTypes = new Map<string, JsonSchema>();
  const modelRequired = new Set<string>();
  let wholeBodyUpdate = false;
  let sawWrite = false;

  const addModelPaths = (model: MongooseModel | undefined, only?: Set<string>): void => {
    if (!model) return;
    for (const [name, field] of model.fields) {
      if (only && !only.has(name)) continue;
      if (!fieldTypes.has(name)) fieldTypes.set(name, field.schema);
      if (field.required) modelRequired.add(name);
    }
  };

  const modelOfReceiver = (receiver: any): MongooseModel | undefined => {
    const rootIdent = unwrapRoot(ts, receiver);
    if (!rootIdent) return undefined;
    const name = resolveModelName(analysis, index, rootIdent);
    return name ? index.byName.get(name) : undefined;
  };

  const collectObjectLiteral = (model: MongooseModel | undefined, obj: any): void => {
    if (!model || !ts.isObjectLiteralExpression(obj)) return;
    const named = new Set<string>();
    let spreadWhole = false;
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        if (referencesRequestBody(ts, prop.expression)) spreadWhole = true;
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(ts, prop);
      if (key === undefined) continue;
      if (referencesRequestBody(ts, prop.initializer)) named.add(key);
    }
    if (spreadWhole) addModelPaths(model);
    else if (named.size) addModelPaths(model, named);
  };

  const visit = (n: any): void => {
    // `new Model(payload)`
    if (ts.isNewExpression(n)) {
      const rootIdent = unwrapRoot(ts, n.expression);
      const modelName = rootIdent ? resolveModelName(analysis, index, rootIdent) : undefined;
      const model = modelName ? index.byName.get(modelName) : undefined;
      if (model) {
        sawWrite = true;
        const payload = n.arguments?.[0];
        if (payload) {
          if (ts.isObjectLiteralExpression(payload)) collectObjectLiteral(model, payload);
          else if (referencesRequestBody(ts, payload)) addModelPaths(model);
        }
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const model = modelOfReceiver(n.expression.expression);
      if (model) {
        if (method === "create") {
          sawWrite = true;
          for (const arg of n.arguments) {
            if (ts.isObjectLiteralExpression(arg)) collectObjectLiteral(model, arg);
            else if (referencesRequestBody(ts, arg)) addModelPaths(model);
            else if (ts.isArrayLiteralExpression(arg)) {
              for (const el of arg.elements) {
                if (ts.isObjectLiteralExpression(el)) collectObjectLiteral(model, el);
              }
            }
          }
        } else if (UPDATE_PAYLOAD_METHODS.has(method)) {
          sawWrite = true;
          // All supported updaters take the update document as the second
          // argument (the first is the id or filter).
          const payload = n.arguments[1];
          if (payload) {
            if (ts.isObjectLiteralExpression(payload)) collectObjectLiteral(model, payload);
            else if (referencesRequestBody(ts, payload)) {
              // Whole-body forwarding (typically an update/PATCH path).
              wholeBodyUpdate = true;
              addModelPaths(model);
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(handlerNode);

  if (!sawWrite || fieldTypes.size === 0) return undefined;
  return { fieldTypes, modelRequired, wholeBodyUpdate };
}

/** Follow route-local request loaders and a proven model instance method. This
 * intentionally does not search for a same-named method on unrelated models. */
export function mongooseInstanceMethodProjection(
  analysis: TsAnalysis, expression: any, handler: any, loaders: any[], middleware: any[] = [], onUnresolvedFailure?: () => void,
): JsonSchema | undefined {
  const {ts, checker} = analysis;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) || expression.arguments.length) return;
  const index = buildIndex(analysis);
  const flow = collectRequestProvenance(analysis, handler, loaders, middleware);
  if (flow.unresolvedFailures) onUnresolvedFailure?.();
  const declaration = (node: any): any => symbolDeclaration(analysis, node);
  const method = (model: MongooseModel, name: string, statics: boolean): any => {
    const schema = model.sourceSchema;
    const source = schema && analysis.sourceByPath.get(schema.file);
    if (!source || !schema?.varName) return;
    const matches: any[] = [];
    const isSchema = (node: any): boolean => {
      const decl = declaration(node);
      return decl && ts.isVariableDeclaration(decl) && decl.initializer?.arguments?.[0] === schema.definition;
    };
    const pick = (obj: any): void => {
      if (!obj || !ts.isObjectLiteralExpression(obj)) return;
      for (const prop of obj.properties) if (propertyName(ts, prop) === name) {
        const fn = ts.isMethodDeclaration(prop) ? prop : ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
        if (fn && ts.isFunctionLike(fn) && fn.body) matches.push(fn);
      }
    };
    for (const stmt of source.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(expr.left) && isSchema(expr.left.expression) && expr.left.name.text === (statics ? 'statics' : 'methods')) pick(expr.right);
      if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && isSchema(expr.expression.expression) && expr.expression.name.text === (statics ? 'static' : 'method')) {
        if (expr.arguments.length === 1) pick(expr.arguments[0]);
        else if (ts.isStringLiteralLike(expr.arguments[0]) && expr.arguments[0].text === name && expr.arguments[1]?.body) matches.push(expr.arguments[1]);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const ownNodes = (fn: any, predicate: (node: any) => boolean): any[] => {
    const result: any[] = [];
    const walk = (node: any): void => {
      if (node !== fn && ts.isFunctionLike(node)) return;
      if (predicate(node)) result.push(node);
      ts.forEachChild(node, walk);
    };
    walk(fn); return result;
  };
  const modelOf = (node: any, self?: MongooseModel, seen = new Set<any>()): MongooseModel | undefined => {
    if (!node || seen.has(node) || seen.size > 48) return;
    const next = new Set([...seen, node]);
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return modelOf(node.expression, self, next);
    const sameModel = (values: any[]): MongooseModel | undefined => {
      const models = values.map(value => modelOf(value, self, next));
      return models.length && models[0] && models.every(m => m === models[0]) ? models[0] : undefined;
    };
    const key = requestPath(analysis, flow, node);
    if (key && flow.writes.has(key)) {
      if ([...flow.writes].some(([parent, values]) => key.startsWith(`${parent}.`) && values.length > 1)) return;
      return sameModel(flow.writes.get(key)!);
    }
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isParameter(decl) && ownNodes(decl.parent, n => ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && declaration(n.left) === decl && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment).length) return;
      if (flow.values.has(decl)) return sameModel(flow.values.get(decl)!);
      if (decl && ts.isParameter(decl)) {
        const callback = decl.parent;
        const call = callback.parent;
        if (ts.isCallExpression(call) && call.arguments[0] === callback && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'then' && callback.parameters[0] === decl) return modelOf(call.expression.expression, self, next);
      }
      if (!decl || !ts.isVariableDeclaration(decl)) return;
      let fn = decl.parent;
      while (fn && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
      const values = decl.initializer ? [decl.initializer] : [];
      if (fn) for (const assignment of ownNodes(fn, n => ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && declaration(n.left) === decl)) {
        if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        values.push(assignment.right);
      }
      const models = values.map(value => modelOf(value, self, next));
      return models.length && models[0] && models.every(m => m === models[0]) ? models[0] : undefined;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const name = node.expression.name.text;
      if (name === 'exec' && node.arguments.length === 0) return modelOf(receiver, self, next);
      if (name === 'save' && node.arguments.length === 0) {
        const instance = modelOf(receiver, self, next);
        if (instance && !method(instance, 'save', false)) return instance;
      }
      if (name === 'assign' && ts.isIdentifier(receiver) && receiver.text === 'Object' && node.arguments.length >= 2 && !(checker.getSymbolAtLocation(receiver)?.declarations ?? []).some((decl: any) => analysis.isProjectFile(decl.getSourceFile().fileName))) {
        const dataOnly = (value: any, seenValues = new Set<any>()): boolean => {
          if (!value || seenValues.has(value) || seenValues.size > 24) return false;
          const more = new Set([...seenValues, value]);
          if (requestPath(analysis, flow, value) === '.body') return true;
          if (ts.isIdentifier(value)) return dataOnly(declaration(value)?.initializer, more);
          if (ts.isCallExpression(value)) {
            const ref = externalReference(analysis, value.expression);
            return ref?.module === 'lodash' && ['omit', 'pick'].includes(ref.members.join('.')) && dataOnly(value.arguments[0], more);
          }
          if (ts.isObjectLiteralExpression(value)) return value.properties.every((p: any) => ts.isPropertyAssignment(p) && (ts.isStringLiteralLike(p.initializer) || ts.isNumericLiteral(p.initializer) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(p.initializer.kind)));
          return false;
        };
        if (node.arguments.slice(1).every((value: any) => dataOnly(value))) return modelOf(node.arguments[0], self, next);
        return;
      }
      const modelName = ts.isIdentifier(receiver) ? resolveModelName(analysis, index, receiver) : undefined;
      const model = receiver.kind === ts.SyntaxKind.ThisKeyword ? self : modelName ? index.byName.get(modelName) : undefined;
      if (!model) return;
      // Projection/populate/lean chains require their own document semantics.
      if ((name === 'findById' || name === 'findOne') && node.arguments.length === 1) return model;
      const fn = method(model, name, true);
      if (!fn) return;
      const returns = ownNodes(fn, n => ts.isReturnStatement(n));
      const models = returns.map(ret => modelOf(ret.expression, model, next));
      return models.length && models[0] && models.every(m => m === models[0]) ? models[0] : undefined;
    }
    return;
  };
  const model = modelOf(expression.expression.expression);
  if (!model) return;
  const fn = method(model, expression.expression.name.text, false);
  if (!fn || !ts.isBlock(fn.body)) return;
  // Interpret a pure field-copy projection, including a literal-key forEach.
  // Every statement must be accounted for; mutations/calls we do not understand
  // reject the projection rather than exposing the entire database entity.
  const arrays = new Map<any, string[]>();
  const objects = new Map<any, {properties: Record<string, JsonSchema>; required: string[]}>();
  const base = baseDocument(model);
  const schemaOptions = model.sourceSchema?.options ? objectRecord(analysis, model.sourceSchema.options) : {};
  const field = (key: string): {schema: JsonSchema; required: boolean} | undefined => {
    if (key === 'id' && model.idField && schemaOptions.id !== false) return {schema: {type:'string'}, required:true};
    const schema = base.properties[key];
    if (!schema) return;
    return {schema, required:base.required.includes(key)};
  };
  const objectProjection = (value: any): {properties: Record<string, JsonSchema>; required: string[]} | undefined => {
    if (!value || !ts.isObjectLiteralExpression(value)) return;
    const result: {properties: Record<string, JsonSchema>; required: string[]} = {properties: {}, required: []};
    for (const prop of value.properties) {
      if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) return;
      const name = propertyName(ts, prop);
      if (name === undefined) return;
      const input = prop.initializer;
      const key = ts.isPropertyAccessExpression(input) && input.expression.kind === ts.SyntaxKind.ThisKeyword ? input.name.text : undefined;
      if (key === undefined) return;
      const copied = field(key); if (!copied) return;
      result.properties[name] = copied.schema;
      if (copied.required) result.required.push(name);
    }
    return result;
  };
  for (const stmt of fn.body.statements) {
    if (ts.isVariableStatement(stmt)) {
      if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) return;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) return;
        const value = decl.initializer;
        if (ts.isArrayLiteralExpression(value) && value.elements.every((e:any)=>ts.isStringLiteralLike(e))) arrays.set(decl, value.elements.map((e:any)=>e.text));
        else if (ts.isObjectLiteralExpression(value)) {
          const projected = objectProjection(value); if (!projected) return;
          objects.set(decl, projected);
        }
        else return;
      }
    } else if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'forEach' || call.arguments.length !== 1) return;
      const keys = arrays.get(declaration(call.expression.expression));
      const callback = call.arguments[0];
      if (!keys || !ts.isArrowFunction(callback) || callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0].name)) return;
      const body = ts.isBlock(callback.body) && callback.body.statements.length === 1 && ts.isExpressionStatement(callback.body.statements[0]) ? callback.body.statements[0].expression : callback.body;
      if (!ts.isBinaryExpression(body) || body.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isElementAccessExpression(body.left) || !ts.isElementAccessExpression(body.right) || body.right.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
      const param = callback.parameters[0];
      if (declaration(body.left.argumentExpression) !== param || declaration(body.right.argumentExpression) !== param) return;
      const target = objects.get(declaration(body.left.expression));
      if (!target) return;
      for (const key of keys) {
        const value = field(key); if (!value) return;
        target.properties[key] = value.schema;
        if (value.required && !target.required.includes(key)) target.required.push(key);
      }
    } else if (ts.isReturnStatement(stmt) && stmt === fn.body.statements.at(-1)) {
      const result = objects.get(declaration(stmt.expression)) ?? objectProjection(stmt.expression);
      if (!result || !Object.keys(result.properties).length) return;
      return {type:'object',properties:result.properties,...(result.required.length ? {required:result.required} : {})};
    } else return;
  }
  return;
}
