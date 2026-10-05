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

interface MongooseModel {
  name: string;
  fields: Map<string, MongooseField>;
  /** Top-level schema options that change the serialized document. */
  idField: boolean;
  versionKey: string | false;
  timestamps: { createdAt: string | false; updatedAt: string | false };
}

interface SchemaExpr {
  definition: any;
  options: any;
  file: string;
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
  if (!node || !ts.isNewExpression(node) || !node.expression) return false;
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
  const { ts, program } = analysis;
  const resolved = ts.resolveModuleName
    ? ts.resolveModuleName(specifier, containingFile, program.getCompilerOptions?.() ?? {}, ts.sys).resolvedModule
    : undefined;
  const fileName = resolved?.resolvedFileName;
  if (fileName) return program.getSourceFile(fileName);
  return undefined;
}

function staticString(analysis: TsAnalysis, node: any): string | undefined {
  const { ts } = analysis;
  return ts.isStringLiteralLike(node) ? node.text : undefined;
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
    fileToRel: new Map(),
  };

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

  // Pass B: collect model registrations and re-exports.
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
        n.right &&
        ts.isIdentifier(n.right)
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
  return model;
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
  return (
    index.namedExport.get(`${modRel}::${importedName}`) ??
    index.varModel.get(`${modRel}::${importedName}`)
  );
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
        const init = decl.initializer;
        if (
          ts.isCallExpression(init) &&
          textOf(init.expression) === "require" &&
          ts.isStringLiteralLike(init.arguments[0])
        ) {
          const m = modelFromModule(analysis, index, init.arguments[0].text, source.fileName, "default", undefined, seen);
          if (m) return m;
        }
        if (ts.isIdentifier(init)) {
          const rel = relativeFile(analysis, source.fileName);
          const direct = index.varModel.get(`${rel}::${init.text}`);
          if (direct) return direct;
          const rec = resolveBindingSyntactically(analysis, index, source, init.text, seen);
          if (rec) return rec;
        }
      }
    }
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

function relativeFile(analysis: TsAnalysis, fileName: string): string {
  return cache.get(analysis)?.fileToRel.get(fileName) ?? fileName;
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

/**
 * Project a Mongoose model call to its serialized response schema. Returns
 * undefined when the receiver is not a registered model or the result cannot
 * be proven statically.
 */
export function mongooseProjection(analysis: TsAnalysis, node: any): JsonSchema | undefined {
  const { ts } = analysis;
  if (!ts.isCallExpression(node)) return undefined;
  const chain = collectChain(ts, node);
  if (!chain) return undefined;
  const index = buildIndex(analysis);
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
    return doc;
  };

  if (ARRAY_DOC_METHODS.has(method)) {
    return { type: "array", items: buildDoc() };
  }
  if (SINGLE_DOC_OR_NULL_METHODS.has(method)) {
    return { anyOf: [buildDoc(), { type: "null" }] };
  }
  if (method === "create") {
    const arrayForm =
      origin.args.length > 1 ||
      (origin.args[0] && ts.isArrayLiteralExpression(origin.args[0]));
    return arrayForm ? { type: "array", items: buildDoc() } : buildDoc();
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
