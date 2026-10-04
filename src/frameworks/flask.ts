/**
 * Flask framework pack (Python).
 *
 * Flask is weakly typed, so precision comes from literal evidence only:
 *  - receivers must trace to Flask()/Blueprint() assignments;
 *  - paths must be static strings; converters (`<int:id>`) become typed path
 *    parameters;
 *  - request.args/headers/form/files access proves parameters and bodies;
 *  - jsonify()/dict/tuple returns prove response status and literal shapes;
 *  - everything else is recorded as an explicit gap for the AI resolver.
 */

import type {
  Confidence,
  ExtractionResult,
  FrameworkPack,
  GapCode,
  RouteCandidate,
  RouteParameter,
  SourceLocation,
} from "../core/types.js";
import type { PythonAnalysis, PyClass, PyFunction } from "../lang/python/index.js";
import { annotationToSchema, buildModelIndex, genericParts, isLooseLiteralSchema, literalToSchema, type ModelIndex } from "../lang/python/schema.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  keywordArgument,
  listElements,
  literalInteger,
  literalString,
  methodCall,
  positionalArguments,
} from "../lang/treesitter/ast.js";

const SHORTCUT_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

const CONVERTER_SCHEMAS: Record<string, Record<string, unknown>> = {
  int: { type: "integer" },
  float: { type: "number" },
  path: { type: "string" },
  string: { type: "string" },
  uuid: { type: "string", format: "uuid" },
};

interface FlaskInstance {
  id: string;
  file: string;
  name: string;
  kind: "app" | "blueprint";
  prefix: string;
}

interface FlaskSite {
  instanceId: string;
  methods: string[];
  rawPath: string;
  decorator?: TsNode;
  call: TsNode;
  fn: PyFunction;
  file: string;
}

function joinPrefix(...parts: Array<string | undefined>): string {
  const joined = parts
    .map((part) => (part ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return joined ? `/${joined}` : "/";
}

function callName(node: TsNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.namedChildren[1]?.text ?? null;
  return null;
}

type JsonSchemaLocal = Record<string, unknown>;

interface MarshmallowIndex {
  /** Marshmallow Schema subclass name -> built component schema. */
  componentsByName: Map<string, JsonSchemaLocal>;
  /** Variable bound to a schema instance (`post_schema = PostSchema()`) -> class name. */
  instanceToClass: Map<string, string>;
  partialInstances: Set<string>;
  /** All known marshmallow Schema subclass names. */
  classNames: Set<string>;
  /** Full analysis, used to resolve parent classes. */
  analysis: PythonAnalysis;
  models: ModelIndex;
  /** flask-restx: `${file}:${var}` bound via `var = api.model("Name", {...})` -> component name. */
  restxVars: Map<string, string>;
}

// Base class tails that identify a marshmallow Schema (including the
// `ma.Schema` / `ma.SQLAlchemySchema` attribute forms and inherited subclasses).
const MARSH_BASE_RE = /(^|\.)(Schema|SQLAlchemySchema|SQLAlchemyAutoSchema|ModelSchema)$/;

function marshBaseName(base: TsNode): string | null {
  if (base.type === "identifier") return base.text;
  if (base.type === "attribute") return base.namedChildren[1]?.text ?? null;
  return null;
}

// Map a marshmallow field call (`ma.String(...)`, `ma.Nested(UserSchema)`, ...)
// to a JSON Schema. `ma.auto_field` and unknown field types yield an empty
// schema (an honest, shape-less gap) rather than invented types.
function marshFieldSchema(
  call: TsNode,
  index: MarshmallowIndex,
  seen: Set<string>,
): JsonSchemaLocal {
  const name = callName(call.namedChildren[0] ?? null);
  if (!name) return {};
  switch (name) {
    case "String":
      return { type: "string" };
    case "URLFor":
      return { type: "string", format: "url" };
    case "Url":
    case "URL":
      return { type: "string", format: "uri" };
    case "Email":
      return { type: "string", format: "email" };
    case "UUID":
      return { type: "string", format: "uuid" };
    case "Integer":
      return { type: "integer" };
    case "Boolean":
      return { type: "boolean" };
    case "Float":
    case "Number":
    case "Decimal":
      return { type: "number" };
    case "DateTime":
      return { type: "string", format: "date-time" };
    case "Date":
      return { type: "string", format: "date" };
    case "Time":
      return { type: "string", format: "time" };
    case "Nested": {
      const inner = positionalArguments(call)[0] ?? null;
      const innerName = callName(inner);
      if (innerName && index.classNames.has(innerName)) {
        const ref: JsonSchemaLocal = { $ref: `#/components/schemas/${innerName}` };
        const many = keywordArgument(call, "many");
        return many?.type === "true" ? { type: "array", items: ref } : ref;
      }
      return {};
    }
    case "List": {
      const inner = positionalArguments(call)[0] ?? null;
      const innerSchema = inner && inner.type === "call" ? marshFieldSchema(inner, index, seen) : {};
      return { type: "array", items: innerSchema };
    }
    default:
      // auto_field, Raw, unknown field types: leave shape unspecified.
      return {};
  }
}

// SQLAlchemy's Mapped annotation is evidence for auto_field, not arbitrary
// model property names. Ambiguous model bindings remain unknown.
function marshAutoField(cls: PyClass, name: string, index: MarshmallowIndex): JsonSchemaLocal {
  const meta = findAll(cls.node, n => n.type === "class_definition" && n.namedChildren[0]?.text === "Meta")[0];
  const model = meta && findAll(meta, n => n.type === "assignment" && n.namedChildren[0]?.text === "model")[0]?.namedChildren.at(-1);
  if (!model || model.type !== "identifier") return {};
  const imported = index.analysis.files.get(cls.file)?.imports.get(model.text);
  const candidates = index.analysis.classes.filter(c => c.name === (imported?.importedName ?? model.text));
  const target = candidates.find(c => c.file === cls.file) ?? (candidates.length === 1 ? candidates[0] : undefined);
  const field = target?.fields.find(f => f.name === name);
  if (!field?.annotation) return {};
  let annotation = field.annotation;
  if (annotation.type === "type") annotation = annotation.namedChildren[0] ?? annotation;
  const generic = genericParts(annotation);
  if (generic?.name.split('.').pop() !== "Mapped" || generic.args.length !== 1) return {};
  const schema = annotationToSchema(generic.args[0]!, index.models) ?? {};
  const column = field.default;
  if (column?.type === "call" && callName(column.namedChildren[0] ?? null) === "mapped_column") {
    const sqlType = positionalArguments(column)[0];
    if (sqlType?.type === "call" && callName(sqlType.namedChildren[0] ?? null) === "String") {
      const length = literalInteger(positionalArguments(sqlType)[0] ?? null);
      if (length !== null) schema.maxLength = length;
    }
    const nullable = keywordArgument(column, "nullable");
    if (nullable?.type === "true" && typeof schema.type === "string") schema.type = [schema.type, "null"];
    if (nullable?.type === "false" && Array.isArray(schema.type)) schema.type = schema.type.filter(t => t !== "null");
  }
  return schema;
}

function buildMarshClassSchema(
  cls: PyClass,
  index: MarshmallowIndex,
  seen: Set<string>,
): JsonSchemaLocal {
  const existing = index.componentsByName.get(cls.name);
  if (existing) return existing;
  if (seen.has(cls.name)) return { type: "object", properties: {} };
  seen.add(cls.name);

  const properties: Record<string, JsonSchemaLocal> = {};
  const required: string[] = [];

  // Inherit fields from marshmallow parent classes first (e.g. UpdateUserSchema
  // extends UserSchema).
  for (const base of cls.bases) {
    const baseName = marshBaseName(base);
    if (!baseName || !index.classNames.has(baseName) || baseName === cls.name) continue;
    const parent = index.analysis.classes.find((c) => c.name === baseName);
    if (!parent) continue;
    const parentSchema = buildMarshClassSchema(parent, index, seen);
    const parentProps = (parentSchema.properties ?? {}) as Record<string, JsonSchemaLocal>;
    for (const [key, value] of Object.entries(parentProps)) properties[key] = value;
    for (const key of ((parentSchema.required as string[]) ?? [])) required.push(key);
  }

  for (const field of cls.fields) {
    const call = field.default;
    if (!call || call.type !== "call") continue;
    const key = literalString(keywordArgument(call, "data_key")) ?? field.name;
    const fieldSchema = callName(call.namedChildren[0] ?? null) === "auto_field"
      ? marshAutoField(cls, literalString(positionalArguments(call)[0] ?? null) ?? field.name, index)
      : marshFieldSchema(call, index, seen);
    if (keywordArgument(call, "dump_only")?.type === "true") fieldSchema.readOnly = true;
    if (keywordArgument(call, "load_only")?.type === "true") fieldSchema.writeOnly = true;
    const validator = keywordArgument(call, "validate");
    for (const check of validator?.type === "list" ? validator.namedChildren : validator ? [validator] : []) {
      if (check.type !== "call") continue;
      const kind = callName(check.namedChildren[0] ?? null);
      const min = literalInteger(keywordArgument(check, "min"));
      const max = literalInteger(keywordArgument(check, "max"));
      if (kind === "Length") {
        const exact = literalInteger(keywordArgument(check, "equal"));
        const array = fieldSchema.type === "array";
        if (min !== null || exact !== null) fieldSchema[array ? "minItems" : "minLength"] = exact ?? min;
        if (max !== null || exact !== null) fieldSchema[array ? "maxItems" : "maxLength"] = exact ?? max;
      } else if (kind === "Range") {
        if (min !== null) fieldSchema.minimum = min;
        if (max !== null) fieldSchema.maximum = max;
      }
    }
    properties[key] = fieldSchema;
    if (keywordArgument(call, "allow_none")?.type === "true") {
      if (typeof fieldSchema.type === "string") fieldSchema.type = [fieldSchema.type, "null"];
      else if (fieldSchema.$ref) properties[key] = {anyOf: [fieldSchema, {type: "null"}]};
    }
    const inherited = required.indexOf(key);
    if (inherited >= 0) required.splice(inherited, 1);
    if (keywordArgument(call, "required")?.type === "true") required.push(key);
  }

  const schema: JsonSchemaLocal = {
    type: "object",
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
  };
  index.componentsByName.set(cls.name, schema);
  return schema;
}

// Discover marshmallow Schema subclasses (fixpoint through inheritance) and the
// schema instances bound to local variables, then build explicit components.
// Only fields declared as `ma.<Type>(...)` assignments are emitted; SQLAlchemy
// `ma.auto_field(...)` fields keep an empty, honest schema.
function buildMarshmallowIndex(analysis: PythonAnalysis): MarshmallowIndex {
  const index: MarshmallowIndex = {
    componentsByName: new Map(),
    instanceToClass: new Map(),
    partialInstances: new Set(),
    classNames: new Set(),
    analysis,
    models: buildModelIndex(analysis),
    restxVars: new Map(),
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of analysis.classes) {
      if (index.classNames.has(cls.name)) continue;
      const isMarshBase = cls.bases.some((base) => {
        const text = base.text.trim();
        return MARSH_BASE_RE.test(text) || index.classNames.has(marshBaseName(base) ?? "");
      });
      if (isMarshBase) {
        index.classNames.add(cls.name);
        changed = true;
      }
    }
  }

  // `x = PostSchema()` instance bindings.
  for (const file of analysis.files.values()) {
    for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
      const target = assignment.namedChildren[0];
      const value = assignment.namedChildren[assignment.namedChildren.length - 1];
      if (!target || target.type !== "identifier" || !value || value.type !== "call") continue;
      const ctor = callName(value.namedChildren[0] ?? null);
      if (ctor && index.classNames.has(ctor)) {
        index.instanceToClass.set(target.text, ctor);
        if (keywordArgument(value, "partial")?.type === "true") index.partialInstances.add(target.text);
      }
    }
  }

  for (const cls of analysis.classes) {
    if (index.classNames.has(cls.name)) buildMarshClassSchema(cls, index, new Set());
  }

  buildRestxModels(analysis, index);

  return index;
}

// Map a flask-restx `fields.X(...)` constructor call to a JSON schema.
// Returns null when the field type is not recognized so the caller can leave
// an unconstrained schema rather than inventing a type.
function restxFieldSchema(node: TsNode, index: MarshmallowIndex, file: string): JsonSchemaLocal | null {
  if (node.type === "identifier") {
    const ref = index.restxVars.get(`${file}:${node.text}`);
    return ref ? { $ref: `#/components/schemas/${ref}` } : null;
  }
  if (node.type !== "call") return null;
  const func = node.namedChildren[0];
  const field = func?.type === "attribute" ? func.namedChildren[1]?.text : null;
  const receiver = func?.type === "attribute" ? func.namedChildren[0]?.text : null;
  // Only treat constructors from the flask-restx `fields` module as restx fields.
  if (!field || (receiver && receiver !== "fields" && !/\.fields$/.test(receiver))) return null;
  const positional = positionalArguments(node);
  switch (field) {
    case "String":
    case "FormattedString":
    case "Raw":
    case "Fixed":
      return { type: "string" };
    case "Url":
      return { type: "string", format: "uri" };
    case "Integer":
    case "Arbitrary":
      return { type: "integer" };
    case "Float":
    case "Decimal":
    case "Number":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "DateTime":
      return { type: "string", format: "date-time" };
    case "Date":
      return { type: "string", format: "date" };
    case "Time":
      return { type: "string", format: "time" };
    case "Nested": {
      const inner = restxFieldSchema(positional[0] ?? null, index, file);
      const many = keywordArgument(node, "many")?.type === "true";
      if (!inner) return many ? { type: "array", items: {} } : {};
      return many ? { type: "array", items: inner } : inner;
    }
    case "List": {
      const inner = restxFieldSchema(positional[0] ?? null, index, file);
      return { type: "array", items: inner ?? {} };
    }
    default:
      return null;
  }
}

// Register flask-restx `var = api.model("Name", {field: fields.X(...)})`
// declarations as components and remember the variable binding so decorators
// such as `@ns.marshal_with(var)` can reference the schema.
function buildRestxModels(analysis: PythonAnalysis, index: MarshmallowIndex): void {
  for (const file of analysis.files.values()) {
    for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
      const target = assignment.namedChildren[0];
      const value = assignment.namedChildren[assignment.namedChildren.length - 1];
      if (!target || target.type !== "identifier" || !value || value.type !== "call") continue;
      const mc = methodCall(value);
      if (!mc || mc.method !== "model") continue;
      const args = positionalArguments(value);
      const nameNode = args.find((a) => a.type === "string");
      const dict = args.find((a) => a.type === "dictionary");
      const modelName = nameNode ? literalString(nameNode) : target.text;
      if (!dict || !modelName) continue;
      const properties: Record<string, JsonSchemaLocal> = {};
      const required: string[] = [];
      for (const pair of childrenOfType(dict, "pair")) {
        const [key, val] = pair.namedChildren;
        const fieldName = key ? literalString(key) : null;
        if (!fieldName || !val) continue;
        const schema = restxFieldSchema(val, index, file.path) ?? {};
        properties[fieldName] = schema;
        const isRequired = val.type === "call" && keywordArgument(val, "required")?.type === "true";
        if (isRequired) required.push(fieldName);
      }
      const schema: JsonSchemaLocal = { type: "object", properties };
      if (required.length) schema.required = required;
      index.componentsByName.set(modelName, schema);
      index.restxVars.set(`${file.path}:${target.text}`, modelName);
    }
  }
}

// Resolve a decorator argument (`post_schema`, `PostSchema()`, `ma.Schema()`)
// to a known marshmallow component class name.
function resolveMarshRef(node: TsNode | null, index: MarshmallowIndex): string | null {
  if (!node) return null;
  if (node.type === "identifier") {
    const viaInstance = index.instanceToClass.get(node.text);
    return viaInstance ?? (index.classNames.has(node.text) ? node.text : null);
  }
  if (node.type === "call" || node.type === "attribute") {
    const ctor = callName(node.namedChildren[0] ?? node);
    return ctor && index.classNames.has(ctor) ? ctor : null;
  }
  return null;
}


function flaskPathParams(rawPath: string): RouteParameter[] {
  const parameters: RouteParameter[] = [];
  const regex = /<(?:([A-Za-z]+):)?([A-Za-z_][A-Za-z0-9_]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawPath))) {
    const converter = match[1] ?? "string";
    parameters.push({
      name: match[2]!,
      in: "path",
      required: true,
      schema: CONVERTER_SCHEMAS[converter] ?? { type: "string" },
      confidence: "high",
    });
  }
  return parameters;
}

function convertFlaskPath(rawPath: string): string {
  return rawPath.replace(
    /<(?:[A-Za-z]+:)?([A-Za-z_][A-Za-z0-9_]*)>/g,
    "{$1}",
  );
}

export const flaskPack: FrameworkPack<PythonAnalysis> = {
  id: "flask",
  language: "python",
  dependencyHints: ["flask"],

  applies(ctx) {
    if (ctx.manifest.packages.has("flask")) return true;
    return ctx.index.files
      .filter((file) => file.language === "python")
      .some((file) => /(^|\n)\s*(from flask|import flask)\b/.test(file.content));
  },

  extract(analysis, ctx) {
    const instances = new Map<string, FlaskInstance>();
    const registrations: Array<{ app: string; blueprint: string; prefix: string }> = [];
    const sites: FlaskSite[] = [];
    const unresolved: ExtractionResult["unresolved"] = [];
    const securitySchemes: ExtractionResult["securitySchemes"] = [];
    const servers: ExtractionResult["servers"] = [];
    const marsh = buildMarshmallowIndex(analysis);

    const byVar = (file: string, name: string) =>
      instances.get(`${file}::${name}`);

    // Map importable module paths ("api" / "app.routes") to indexed files so
    // blueprints registered from another module resolve cross-file.
    const moduleToFile = new Map<string, string>();
    for (const pyFile of analysis.files.values()) {
      const noExt = pyFile.path.replace(/\.pyi?$/, "").replace(/\\/g, "/");
      const segments = noExt.split("/");
      for (let i = 0; i < segments.length; i += 1) {
        moduleToFile.set(segments.slice(i).join("."), pyFile.path);
      }
      if (segments[segments.length - 1] === "__init__") {
        moduleToFile.set(segments.slice(0, -1).join("."), pyFile.path);
      }
    }
    const resolveInstanceRef = (file: string, node: TsNode): FlaskInstance | null => {
      if (node.type !== "identifier" && node.type !== "attribute") return null;
      if (node.type === "identifier") {
        const local = byVar(file, node.text);
        if (local) return local;
        const pyFile = analysis.files.get(file);
        const imported = pyFile?.imports.get(node.text);
        if (imported?.importedName) {
          const targetFile = moduleToFile.get(imported.module);
          if (targetFile) return byVar(targetFile, imported.importedName) ?? null;
        }
        return null;
      }
      const receiver = node.namedChildren[0];
      const attr = node.namedChildren[1];
      const pyFile = analysis.files.get(file);
      if (!receiver || !attr || !pyFile) return null;
      const imported = pyFile.imports.get(receiver.text);
      if (imported) {
        const targetFile = moduleToFile.get(imported.module);
        const resolved = targetFile ? byVar(targetFile, attr.text) : null;
        if (resolved) return resolved;
      }
      // Fallback for imports local to a factory function (which the import
      // index does not record), e.g. `from . import auth` inside create_app()
      // followed by `app.register_blueprint(auth.bp)`.
      const moduleFile = resolveSiblingModule(file, receiver.text);
      return moduleFile ? byVar(moduleFile, attr.text) ?? null : null;
    };

    // Resolve a bare module name referenced from `file` to an indexed source
    // file, checking explicit imports first and then same-package siblings
    // (both `mod.py` and the `mod/__init__.py` package form).
    const resolveSiblingModule = (fromFile: string, mod: string): string | undefined => {
      const norm = fromFile.replace(/\\/g, "/");
      const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
      const direct = [`${dir}/${mod}.py`, `${dir}/${mod}/__init__.py`];
      for (const candidate of direct) {
        if (analysis.files.has(candidate)) return candidate;
      }
      const suffix = `.${mod}`;
      const hits = [...moduleToFile.entries()]
        .filter(([key]) => key === mod || key.endsWith(suffix))
        .map(([, path]) => path);
      return hits.find((path) => path.replace(/\\/g, "/").startsWith(dir)) ?? hits[0];
    };

    // Pass 1: register every Flask app and Blueprint across all files first.
    // Cross-file registration edges (app.py registering a blueprint defined in
    // another module) must resolve against a fully populated instance table, so
    // instance discovery and edge resolution run as separate passes.
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!target || target.type !== "identifier" || value?.type !== "call") continue;
        const constructorName = callName(value.namedChildren[0] ?? null);
        if (constructorName === "Flask") {
          instances.set(`${file.path}::${target.text}`, {
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            kind: "app",
            prefix: "",
          });
        } else if (constructorName === "Blueprint") {
          const prefixNode = keywordArgument(value, "url_prefix");
          instances.set(`${file.path}::${target.text}`, {
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            kind: "blueprint",
            prefix: prefixNode ? literalString(prefixNode) ?? "" : "",
          });
        }
      }
    }

    // Flask-RESTful: track Api instances (including Api subclasses and the
    // no-arg `Api()` form wired later via `api.init_app(app)`). `apis` maps
    // <file>::<api-var> -> wrapped app/blueprint instance id (null until wired).
    const apiClassNames = new Set<string>(["Api"]);
    for (const cls of analysis.classes) {
      if (cls.bases.some((b) => marshBaseName(b) === "Api")) apiClassNames.add(cls.name);
    }
    const apis = new Map<string, string | null>();
    const apiVars = new Map<string, { file: string; name: string }>();
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!target || target.type !== "identifier" || value?.type !== "call") continue;
        const ctor = callName(value.namedChildren[0] ?? null);
        if (!ctor || !apiClassNames.has(ctor)) continue;
        const wrappedArg = positionalArguments(value)[0];
        const wrapped = wrappedArg ? resolveInstanceRef(file.path, wrappedArg) : null;
        const key = `${file.path}::${target.text}`;
        apis.set(key, wrapped?.id ?? null);
        apiVars.set(key, { file: file.path, name: target.text });
      }
    }

    // Resolve an api variable reference (possibly imported) to its local key.
    const resolveApiKey = (file: string, node: TsNode): string | null => {
      if (node.type !== "identifier") return null;
      const local = `${file}::${node.text}`;
      if (apis.has(local)) return local;
      const pyFile = analysis.files.get(file);
      const imported = pyFile?.imports.get(node.text);
      if (imported?.importedName) {
        const targetFile = moduleToFile.get(imported.module);
        const target = targetFile ? `${targetFile}::${imported.importedName}` : null;
        if (target && apis.has(target)) return target;
      }
      return null;
    };

    // `api.init_app(app | blueprint)` wires a no-arg Api to its instance.
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.receiver.type !== "identifier" || mc.method !== "init_app") continue;
        const key = resolveApiKey(file.path, mc.receiver);
        if (!key || apis.get(key)) continue;
        const target = positionalArguments(call)[0];
        const wrapped = target ? resolveInstanceRef(file.path, target) : null;
        if (wrapped) apis.set(key, wrapped.id);
      }
    }

    // Pass 2: resolve registration edges and server hints now that every
    // app/blueprint instance is visible.
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.receiver.type !== "identifier") continue;
        if (mc.method === "register_blueprint") {
          const app = byVar(file.path, mc.receiver.text);
          const childArg = positionalArguments(call)[0];
          const blueprint = childArg ? resolveInstanceRef(file.path, childArg) : null;
          if (app?.kind === "app" && blueprint?.kind === "blueprint") {
            const prefixNode = keywordArgument(call, "url_prefix");
            registrations.push({
              app: app.id,
              blueprint: blueprint.id,
              prefix: prefixNode ? literalString(prefixNode) ?? "" : "",
            });
          }
        }
        if (mc.method === "run" && byVar(file.path, mc.receiver.text)?.kind === "app") {
          const portNode = keywordArgument(call, "port");
          const hostNode = keywordArgument(call, "host");
          const port = portNode ? literalInteger(portNode) : 5000;
          const host = hostNode ? literalString(hostNode) ?? "127.0.0.1" : "127.0.0.1";
          if (port) servers.push({ url: `http://${host}:${port}` });
        }
      }
    }

    // Reachability map for blueprints. Flask concatenates registration
    // prefix first, then the blueprint's own url_prefix.
    const reachablePrefix = new Map<string, string>();
    for (const registration of registrations) {
      const blueprint = instances.get(registration.blueprint);
      if (!blueprint) continue;
      // A url_prefix passed at registration overrides the blueprint's own
      // url_prefix; otherwise the blueprint prefix applies.
      reachablePrefix.set(
        registration.blueprint,
        registration.prefix || blueprint.prefix,
      );
    }

    for (const fn of analysis.functions) {
      if (!fn.decorated) continue;
      for (const decorator of fn.decorators) {
        const callNode = decorator.namedChildren[0];
        if (!callNode || callNode.type !== "call") continue;
        const mc = methodCall(callNode);
        if (!mc || mc.receiver.type !== "identifier") continue;
        const instance = byVar(fn.file, mc.receiver.text);
        if (!instance) continue;

        let methods: string[] | null = null;
        let pathNode: TsNode | undefined;
        if (mc.method === "route") {
          pathNode = positionalArguments(callNode)[0];
          const methodsNode = keywordArgument(callNode, "methods");
          methods = methodsNode
            ? listElements(methodsNode)
                .map((node) => literalString(node)?.toLowerCase())
                .filter((m): m is string => !!m && SHORTCUT_METHODS.has(m))
            : ["get"];
        } else if (SHORTCUT_METHODS.has(mc.method)) {
          pathNode = positionalArguments(callNode)[0];
          methods = [mc.method];
        }
        if (!methods || !pathNode) continue;
        const rawPath = literalString(pathNode);
        if (rawPath === null) {
          unresolved.push({
            reason: "dynamic-path",
            message: "Route path is not a static string literal",
            origin: { file: fn.file, line: callNode.startPosition.row + 1, symbol: fn.name },
          });
          continue;
        }
        sites.push({
          instanceId: instance.id,
          methods,
          rawPath,
          decorator,
          call: callNode,
          fn,
          file: fn.file,
        });
      }
    }

    // Flask-RESTful: `api.add_resource(ResourceClass, "/path", ...)` and any
    // Api subclass add_* helper (e.g. redash's add_org_resource). Each HTTP
    // method on the Resource subclass becomes an operation on the api's wrapped
    // app/blueprint (an unwired/no-arg Api defaults to the app root).
    const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
    const fnByNode = new Map(analysis.functions.map((f) => [f.node, f]));
    const resolveClassNode = (file: string, node: TsNode | undefined): TsNode | null => {
      if (!node || node.type !== "identifier") return null;
      const pyFile = analysis.files.get(file);
      if (!pyFile) return null;
      const local = findAll(pyFile.root, (n) => n.type === "class_definition").find(
        (cn) => cn.namedChildren[0]?.text === node.text,
      );
      if (local) return local;
      const imported = pyFile.imports.get(node.text);
      if (imported?.importedName) {
        const targetFile = moduleToFile.get(imported.module);
        const tf = targetFile ? analysis.files.get(targetFile) : null;
        if (tf) {
          return (
            findAll(tf.root, (n) => n.type === "class_definition").find(
              (cn) => cn.namedChildren[0]?.text === node.text,
            ) ?? null
          );
        }
      }
      return null;
    };
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.receiver.type !== "identifier") continue;
        const apiKey = resolveApiKey(file.path, mc.receiver);
        if (!apiKey || !/^add/.test(mc.method)) continue;
        const args = positionalArguments(call);
        const clsNode = resolveClassNode(file.path, args[0]);
        if (!clsNode) continue;
        // Which HTTP methods does the Resource class implement?
        const present = new Map<string, TsNode>();
        for (const def of findAll(clsNode, (n) => n.type === "function_definition")) {
          const name = def.namedChildren[0]?.text;
          if (name && HTTP_METHODS.has(name) && !present.has(name)) present.set(name, def);
        }
        if (present.size === 0) continue;
        const wrappedId = apis.get(apiKey) ?? null;
        for (const pathNode of args.slice(1)) {
          const rawPath = literalString(pathNode);
          if (rawPath === null) continue;
          for (const [method, methodNode] of present) {
            const fn = fnByNode.get(methodNode);
            if (!fn) continue;
            sites.push({
              instanceId: wrappedId ?? "flask-restful-root",
              methods: [method],
              rawPath,
              call,
              fn,
              file: file.path,
            });
          }
        }
      }
    }
    // An unwired/no-arg Api serves routes at the app root (prefix "").
    if (
      sites.some((s) => s.instanceId === "flask-restful-root") &&
      !instances.has("flask-restful-root")
    ) {
      instances.set("flask-restful-root", {
        id: "flask-restful-root",
        file: "",
        name: "flask-restful-root",
        kind: "app",
        prefix: "",
      });
    }

    // Flask-RESTX: `ns = api.namespace("todos")` (or `Namespace("todos")`)
    // followed by class-based resources decorated with `@ns.route("/<id>")`.
    // The namespace name is the path prefix; `api.add_namespace(ns, path=...)`
    // may override it. Each HTTP verb method on the Resource subclass becomes
    // an operation, mirroring add_resource handling above.
    const namespacePrefix = new Map<string, string>();
    const namespaceOverride = new Map<string, string>();
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren.at(-1);
        if (!target || target.type !== "identifier" || !value || value.type !== "call") continue;
        const mc = methodCall(value);
        const positional = positionalArguments(value);
        let namePath: string | null = null;
        if (mc?.method === "namespace") {
          namePath = literalString(keywordArgument(value, "path") ?? positional[0]);
        } else if (value.namedChildren[0]?.type === "identifier" && value.namedChildren[0].text === "Namespace") {
          namePath = literalString(keywordArgument(value, "path") ?? positional[0]);
        }
        if (namePath !== null) namespacePrefix.set(`${file.path}:${target.text}`, namePath);
      }
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.method !== "add_namespace") continue;
        const nsRef = positionalArguments(call)[0];
        const override = literalString(positionalArguments(call)[1] ?? keywordArgument(call, "path"));
        if (nsRef?.type === "identifier" && override !== null) {
          namespaceOverride.set(`${file.path}:${nsRef.text}`, override);
        }
      }
    }

    for (const file of analysis.files.values()) {
      for (const decorated of findAll(file.root, (n) => n.type === "decorated_definition")) {
        const cls = decorated.namedChildren[decorated.namedChildren.length - 1];
        if (!cls || cls.type !== "class_definition") continue;
        // HTTP verbs implemented directly on the Resource subclass.
        const present = new Map<string, TsNode>();
        for (const def of findAll(cls, (n) => n.type === "function_definition")) {
          const name = def.namedChildren[0]?.text;
          if (name && HTTP_METHODS.has(name) && !present.has(name)) present.set(name, def);
        }
        if (present.size === 0) continue;
        const decorators = decorated.namedChildren.filter((n: TsNode) => n.type === "decorator");
        for (const decorator of decorators) {
          const callNode = decorator.namedChildren?.[0];
          if (!callNode || callNode.type !== "call") continue;
          const mc = methodCall(callNode);
          if (!mc || mc.method !== "route" || mc.receiver.type !== "identifier") continue;
          const nsKey = `${file.path}:${mc.receiver.text}`;
          const nsPrefix =
            namespaceOverride.get(nsKey) ?? namespacePrefix.get(nsKey) ?? "";
          for (const pathNode of positionalArguments(callNode)) {
            const routePath = literalString(pathNode);
            if (routePath === null) continue;
            const rawPath = joinPrefix(nsPrefix, routePath);
            for (const [method, methodNode] of present) {
              const fn = fnByNode.get(methodNode);
              if (!fn) continue;
              sites.push({
                instanceId: "flask-restful-root",
                methods: [method],
                rawPath,
                call: callNode,
                fn,
                file: file.path,
              });
            }
          }
        }
      }
    }

    // Ensure the synthetic root exists when only flask-restx namespace routes
    // were found (no add_resource call triggered the earlier guarantee).
    if (
      sites.some((s) => s.instanceId === "flask-restful-root") &&
      !instances.has("flask-restful-root")
    ) {
      instances.set("flask-restful-root", {
        id: "flask-restful-root",
        file: "",
        name: "flask-restful-root",
        kind: "app",
        prefix: "",
      });
    }

    const orphanBlueprints = new Set<string>();
    const routes: RouteCandidate[] = [];
    for (const site of sites) {
      const instance = instances.get(site.instanceId)!;
      let prefix = "";
      if (instance.kind === "blueprint") {
        const resolved = reachablePrefix.get(instance.id);
        if (resolved === undefined) {
          orphanBlueprints.add(instance.id);
          continue;
        }
        prefix = resolved;
      }
      for (const method of site.methods) {
        routes.push(buildFlaskRoute(site, joinPrefix(prefix, site.rawPath), method, marsh));
      }
    }

    // Same method+path declared twice (e.g. route() plus a shortcut) keeps
    // the first evidence; duplicates are reported as unresolved diagnostics.
    const deduped = new Map<string, RouteCandidate>();
    for (const route of routes) {
      const key = `${route.method} ${route.fullPath}`;
      if (!deduped.has(key)) deduped.set(key, route);
      else {
        unresolved.push({
          reason: "duplicate-route",
          message: `Duplicate declaration for ${key}`,
          origin: route.origin,
        });
      }
    }

    for (const id of orphanBlueprints) {
      const blueprint = instances.get(id)!;
      unresolved.push({
        reason: "unreachable-blueprint",
        message: `Blueprint "${blueprint.name}" is not registered on a Flask app`,
        origin: { file: blueprint.file, symbol: blueprint.name },
      });
    }

    const components: ExtractionResult["components"] = [...marsh.componentsByName.entries()].map(
      ([name, schema]) => ({ name, schema }),
    );

    return { routes: [...deduped.values()], unresolved, components, securitySchemes, servers };
  },
};

function chainText(node: TsNode | null): string {
  return node ? node.text : "";
}

// When code is guarded by `if request.method == "POST":`, evidence inside the
// branch belongs only to that HTTP method. Returns the guarded lowercase
// method, or null when the node is shared by every method of the view.
function guardedMethod(node: TsNode): string | null {
  let cur: TsNode | null = node.parent ?? null;
  while (cur) {
    if (cur.type === "if_statement" || cur.type === "elif_clause") {
      const test = cur.type === "if_statement" ? cur.namedChildren[0] : cur.namedChildren[0];
      const match = test?.text.match(/request\.method\s*==\s*["']([A-Z]+)["']/);
      if (match) return match[1]!.toLowerCase();
    }
    cur = cur.parent ?? null;
  }
  return null;
}

function buildFlaskRoute(
  site: FlaskSite,
  fullPath: string,
  method: string,
  marsh: MarshmallowIndex,
): RouteCandidate {
  const { fn, file } = site;
  const parameters = flaskPathParams(site.rawPath);
  const gaps = new Set<GapCode>();
  const body = fn.body;

  // Proven query/header/cookie parameters.
  if (body) {
    for (const call of findAll(body, (n) => n.type === "call")) {
      const mc = methodCall(call);
      if (!mc) continue;
      // Evidence inside `if request.method == "POST"` only applies to POST.
      if (guardedMethod(call) && guardedMethod(call) !== method) continue;
      const chain = chainText(mc.receiver);
      const arg = positionalArguments(call)[0];
      const name = arg ? literalString(arg) : null;
      if (/request\.args$/.test(chain) || /request\.args\.get(list)?$/.test(chain)) {
        if (name && !parameters.some((p) => p.in === "query" && p.name === name)) {
          parameters.push({
            name,
            in: "query",
            required: false,
            schema: { type: "string" },
            confidence: "medium",
          });
        }
      } else if (/request\.headers(\.get)?$/.test(chain)) {
        if (name && !parameters.some((p) => p.in === "header" && p.name === name)) {
          parameters.push({
            name,
            in: "header",
            required: false,
            schema: { type: "string" },
            confidence: "medium",
          });
        }
      } else if (/request\.cookies(\.get)?$/.test(chain)) {
        if (name && !parameters.some((p) => p.in === "cookie" && p.name === name)) {
          parameters.push({
            name,
            in: "cookie",
            required: false,
            schema: { type: "string" },
            confidence: "medium",
          });
        }
      }
    }

    // Bracket access: request.args["name"].
    for (const subscript of findAll(body, (n) => n.type === "subscript")) {
      if (guardedMethod(subscript) && guardedMethod(subscript) !== method) continue;
      const value = subscript.namedChildren[0];
      const key = subscript.namedChildren[1];
      const name = key ? literalString(key) : null;
      if (!name) continue;
      const chain = value?.text ?? "";
      if (/request\.args$/.test(chain)) {
        parameters.push({ name, in: "query", required: true, schema: { type: "string" }, confidence: "medium" });
      } else if (/request\.headers$/.test(chain)) {
        parameters.push({ name, in: "header", required: true, schema: { type: "string" }, confidence: "medium" });
      } else if (/request\.cookies$/.test(chain)) {
        parameters.push({ name, in: "cookie", required: true, schema: { type: "string" }, confidence: "medium" });
      }
    }
  }

  // Request body evidence, attributed per HTTP method via request.method guards.
  let requestBody: RouteCandidate["requestBody"];
  if (body) {
    const evidenceForMethod = (chain: string): boolean => {
      const pattern = new RegExp(`request\\.${chain.replace(".", "\\.")}`);
      for (const node of findAll(body, (n) => n.type === "call" || n.type === "subscript" || n.type === "attribute")) {
        if (!pattern.test(node.text)) continue;
        const guard = guardedMethod(node);
        if (!guard || guard === method) return true;
      }
      return false;
    };
    if (evidenceForMethod("get_json") || evidenceForMethod("json")) {
      requestBody = {
        required: true,
        confidence: "medium",
        content: [{ mediaType: "application/json", schema: {} }],
      };
      gaps.add("body-schema-unknown");
    } else if (evidenceForMethod("files")) {
      requestBody = {
        required: true,
        confidence: "medium",
        content: [{ mediaType: "multipart/form-data", schema: { type: "object" } }],
      };
      gaps.add("body-schema-unknown");
    } else if (evidenceForMethod("form")) {
      // Recover proven field names from request.form["x"] (required) and
      // request.form.get("x") (optional) accesses in the handler body.
      const sourceText = body.text ?? "";
      const required = new Set<string>();
      const optional = new Set<string>();
      for (const m of sourceText.matchAll(/\.form\s*\[\s*["']([A-Za-z0-9_.\-\[\]]+)["']\s*\]/g)) {
        required.add(m[1]!);
      }
      for (const m of sourceText.matchAll(/\.form\s*\.\s*get\(\s*["']([A-Za-z0-9_.\-\[\]]+)["']/g)) {
        optional.add(m[1]!);
      }
      const hasFiles = evidenceForMethod("files");
      const fieldNames = [...new Set([...required, ...optional])];
      const properties: Record<string, JsonSchemaLocal> = Object.fromEntries(
        fieldNames.map((n) => [n, { type: "string" }]),
      );
      if (fieldNames.length) {
        requestBody = {
          required: required.size > 0,
          confidence: "medium",
          content: [
            {
              mediaType: hasFiles ? "multipart/form-data" : "application/x-www-form-urlencoded",
              schema: {
                type: "object",
                properties,
                ...(required.size ? { required: [...required] } : {}),
              },
            },
          ],
        };
      } else {
        requestBody = {
          required: true,
          confidence: "medium",
          content: [
            {
              mediaType: hasFiles ? "multipart/form-data" : "application/x-www-form-urlencoded",
              schema: { type: "object" },
            },
          ],
        };
        gaps.add("body-schema-unknown");
      }
    } else if (evidenceForMethod("data")) {
      gaps.add("body-unknown");
    }
  }

  // Responses.
  const apifairy = scanApifairyDecorators(fn, marsh);
  const responses = buildFlaskResponses(fn, gaps, method, Number(apifairy.success?.statusCode ?? 200));

  // APIFairy decorators carry explicit marshmallow models that the return-value
  // scan cannot infer; apply them on top of, and reconcile against, the
  // return-statement evidence.
  if (apifairy.requestClass) {
    let requestClass = apifairy.requestClass;
    if (apifairy.requestPartial) {
      const original = marsh.componentsByName.get(requestClass);
      if (original) {
        requestClass = `partial_${requestClass}`;
        const partial = {...original};
        delete partial.required;
        marsh.componentsByName.set(requestClass, partial);
      }
    }
    requestBody = {
      required: true,
      confidence: "high",
      content: [
        { mediaType: "application/json", schema: { $ref: `#/components/schemas/${requestClass}` } },
      ],
    };
    gaps.delete("body-schema-unknown");
    gaps.delete("body-unknown");
  }
  if (apifairy.success) {
    const { className, statusCode, paginated, wrapper } = apifairy.success;
    const schema: JsonSchemaLocal = wrapper ?? (paginated
      ? {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: `#/components/schemas/${className}` } },
          },
        }
      : { $ref: `#/components/schemas/${className}` });
    const upsert = {
      statusCode,
      description: "",
      confidence: "high" as Confidence,
      content: ["204", "304"].includes(statusCode) ? [] : [{ mediaType: "application/json", schema }],
    };
    const idx = responses.findIndex((r) => r.statusCode === statusCode);
    if (idx >= 0) responses[idx] = upsert;
    else responses.push(upsert);
    gaps.delete("response-unknown");
    gaps.delete("response-schema-unknown");
  }
  if (apifairy.queryClass) {
    const query = marsh.componentsByName.get(apifairy.queryClass);
    for (const [name, schema] of Object.entries((query?.properties ?? {}) as Record<string, JsonSchemaLocal>)) {
      if (schema.readOnly || parameters.some(p => p.name === name && p.in === "query")) continue;
      parameters.push({name, in: "query", required: Array.isArray(query?.required) && query.required.includes(name), schema: { ...schema }, confidence: "high"});
    }
  }
  for (const error of apifairy.errors) {
    if (!responses.some((r) => r.statusCode === error.statusCode)) {
      responses.push({
        statusCode: error.statusCode,
        description: error.description,
        confidence: "high",
        content: [],
      });
    }
  }

  // flask-restx decorators: @ns.marshal_with(model), @ns.marshal_list_with,
  // @ns.expect(model), @ns.response(code, "message").
  const restxRef = (node: TsNode | undefined): string | null => {
    if (node?.type === "identifier") return marsh.restxVars.get(`${file}:${node.text}`) ?? null;
    return null;
  };
  for (const decorator of fn.decorators ?? []) {
    const callNode = decorator.namedChildren?.[0];
    if (!callNode || callNode.type !== "call") continue;
    const mc = methodCall(callNode);
    if (!mc) continue;
    const args = positionalArguments(callNode);
    if (mc.method === "marshal_with" || mc.method === "marshal_list_with") {
      const ref = restxRef(args[0]);
      const codeNode = keywordArgument(callNode, "code");
      const statusCode = codeNode ? String(literalInteger(codeNode) ?? 200) : "200";
      const schema = ref
        ? mc.method === "marshal_list_with"
          ? { type: "array", items: { $ref: `#/components/schemas/${ref}` } }
          : { $ref: `#/components/schemas/${ref}` }
        : mc.method === "marshal_list_with"
          ? { type: "array", items: {} }
          : {};
      const upsert = {
        statusCode,
        description: "",
        confidence: "high" as Confidence,
        content: ref ? [{ mediaType: "application/json", schema }] : [{ mediaType: "application/json", schema }],
      };
      const idx = responses.findIndex((r) => r.statusCode === statusCode);
      if (idx >= 0) responses[idx] = upsert;
      else responses.push(upsert);
      gaps.delete("response-unknown");
      if (ref) gaps.delete("response-schema-unknown");
    } else if (mc.method === "expect") {
      const ref = restxRef(args[0]);
      if (ref) {
        requestBody = {
          required: true,
          confidence: "high",
          content: [{ mediaType: "application/json", schema: { $ref: `#/components/schemas/${ref}` } }],
        };
        gaps.delete("body-schema-unknown");
        gaps.delete("body-unknown");
      }
    } else if (mc.method === "response") {
      const codeNode = args[0];
      const descNode = args[1];
      const code = codeNode ? literalInteger(codeNode) : null;
      if (code && !responses.some((r) => r.statusCode === String(code))) {
        responses.push({
          statusCode: String(code),
          description: descNode ? literalString(descNode) ?? "" : "",
          confidence: "high",
          content: [],
        });
      }
    }
  }

  const isSse = responses.some((r) =>
    r.content?.some((m) => m.mediaType === "text/event-stream"),
  );

  const confidence: Confidence = gaps.size ? "medium" : "high";
  const origin: SourceLocation = {
    file,
    line: (site.decorator ?? fn.node).startPosition.row + 1,
    symbol: fn.name,
  };

  return {
    method,
    path: site.rawPath,
    fullPath: convertFlaskPath(fullPath),
    origin,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    confidence,
    gaps: [...gaps],
    components: [],
    handlerSource: boundedSource(fn.decorated ?? fn.node),
    ...(isSse ? { extensions: { "x-protocol": "sse" } } : {}),
  };
}

interface ApifairyEvidence {
  success: { className: string; statusCode: string; paginated: boolean; wrapper?: JsonSchemaLocal } | null;
  queryClass?: string;
  requestClass: string | null;
  requestPartial?: boolean;
  errors: Array<{ statusCode: string; description: string }>;
}

// Inspect APIFairy / marshmallow decorators stacked on a handler:
//   @response(schema[, status])        -> success response body model
//   @paginated_response(schema, ...)  -> paginated envelope response model
//   @body(schema)                     -> request body model
//   @other_responses({404: "..."})      -> named error responses
// These carry explicit marshmallow models the return-statement scan cannot see.
function scanApifairyDecorators(fn: PyFunction, marsh: MarshmallowIndex): ApifairyEvidence {
  const evidence: ApifairyEvidence = { success: null, requestClass: null, errors: [] };
  for (const decorator of fn.decorators) {
    const callNode = decorator.namedChildren[0];
    if (!callNode || callNode.type !== "call") continue;
    const name = callName(callNode.namedChildren[0] ?? null);
    if (!name) continue;
    const args = positionalArguments(callNode);
    if (name === "response" || name === "paginated_response") {
      const className = resolveMarshRef(args[0] ?? null, marsh);
      if (!className) continue;
      const statusNode = keywordArgument(callNode, "status_code") ?? args[1] ?? null;
      const statusCode = statusNode ? String(literalInteger(statusNode) ?? 200) : "200";
      evidence.success = { className, statusCode, paginated: name === "paginated_response" };
      if (name === "paginated_response") {
        const definitions = marsh.analysis.functions.filter(f => f.name === name);
        const implementation = definitions.length === 1 ? definitions[0] : undefined;
        const paginationArg = keywordArgument(callNode, "pagination_schema") ?? implementation?.params.find(p => p.name === "pagination_schema")?.default;
        const paginationClass = resolveMarshRef(paginationArg ?? null, marsh);
        if (implementation?.body && paginationClass) {
          // Verify the wrapper's source: a query-arguments decorator and a
          // response schema factory must both bind the pagination parameter.
          const queries = findAll(implementation.body, n => n.type === "call" && callName(n.namedChildren[0] ?? null) === "arguments" && positionalArguments(n)[0]?.text === "pagination_schema");
          const responses = findAll(implementation.body, n => n.type === "call" && callName(n.namedChildren[0] ?? null) === "response");
          const factoryCall = responses.map(n => positionalArguments(n)[0]).find(n => n?.type === "call" && keywordArgument(n, "pagination_schema")?.text === "pagination_schema");
          const factories = factoryCall ? marsh.analysis.functions.filter(f => f.name === callName(factoryCall.namedChildren[0] ?? null)) : [];
          const factory = factories.length === 1 ? factories[0] : undefined;
          if (queries.length && factory?.body) {
            const nestedIds = new Set(findAll(factory.body, n => n.type === "class_definition").map(n => n.id));
            const nestedClasses = marsh.analysis.classes.filter(c => c.file === factory.file && nestedIds.has(c.node.id) && c.bases.some(b => MARSH_BASE_RE.test(b.text)));
            const wrapped = nestedClasses.length === 1 ? nestedClasses[0] : undefined;
            const props: Record<string, JsonSchemaLocal> = {};
            for (const field of wrapped?.fields ?? []) {
              const value = field.default;
              if (value?.type !== "call" || callName(value.namedChildren[0] ?? null) !== "Nested") continue;
              const binding = positionalArguments(value)[0]?.text;
              const target = binding === factory.params[0]?.name ? className : binding === "pagination_schema" ? paginationClass : null;
              if (!target) continue;
              const ref = {$ref: `#/components/schemas/${target}`};
              props[field.name] = keywordArgument(value, "many")?.type === "true" ? {type: "array", items: ref} : ref;
            }
            if (wrapped && Object.keys(props).length === wrapped.fields.length && Object.keys(props).length > 0) {
              evidence.success.wrapper = {type: "object", properties: props};
              evidence.queryClass = paginationClass;
            }
          }
        }
      }
    } else if (name === "body") {
      evidence.requestClass = resolveMarshRef(args[0] ?? null, marsh);
      const arg = args[0];
      evidence.requestPartial = arg?.type === "identifier" ? marsh.partialInstances.has(arg.text) : arg?.type === "call" && keywordArgument(arg, "partial")?.type === "true";
    } else if (name === "other_responses") {
      const mapping = args[0] ?? null;
      if (!mapping || mapping.type !== "dictionary") continue;
      for (const pair of childrenOfType(mapping, "pair")) {
        const [key, value] = pair.namedChildren;
        const status = key ? literalInteger(key) : null;
        const description = value ? literalString(value) ?? "" : "";
        if (status) evidence.errors.push({ statusCode: String(status), description });
      }
    }
  }
  return evidence;
}

function buildFlaskResponses(
  fn: PyFunction,
  gaps: Set<string>,
  method: string,
  defaultStatus = 200,
): RouteCandidate["responses"] {
  const responses: RouteCandidate["responses"] = [];
  if (!fn.body) {
    gaps.add("response-unknown");
    return responses;
  }

  // SSE: Response(..., mimetype/content_type="text/event-stream").
  const sseCall = findFirst(fn.body, (node) => {
    if (node.type !== "call") return false;
    const name = callName(node.namedChildren[0] ?? null);
    if (name !== "Response" && name !== "stream_with_context") return false;
    const mime = keywordArgument(node, "mimetype") ?? keywordArgument(node, "content_type");
    return mime?.text.includes("text/event-stream") ?? false;
  });
  if (sseCall) {
    responses.push({
      statusCode: "200",
      description: "Server-Sent Events stream",
      confidence: "medium",
      content: [{ mediaType: "text/event-stream", itemSchema: {}, confidence: "medium" }],
    });
    gaps.add("sse-events-unknown");
    return responses;
  }

  const returns = findAll(fn.body, (node) => node.type === "return_statement");
  let proven = false;
  for (const returned of returns) {
    if (guardedMethod(returned) && guardedMethod(returned) !== method) continue;
    let value = returned.namedChildren[0] ?? null;
    let status = defaultStatus;
    // Tuple return: (payload, status) — parenthesized tuples use "tuple",
    // bare comma returns use "expression_list".
    if (value?.type === "tuple" || value?.type === "expression_list") {
      const elements = value.namedChildren;
      value = elements[0] ?? null;
      const statusNode = elements[1];
      status = statusNode ? literalInteger(statusNode) ?? defaultStatus : defaultStatus;
    }
    if (!value) continue;

    if (value.type === "call") {
      const name = callName(value.namedChildren[0] ?? null);
      if (name === "jsonify") {
        const arg = positionalArguments(value)[0];
        const schema = arg && (arg.type === "dictionary" || arg.type === "list")
          ? literalToSchema(arg)
          : {};
        responses.push({
          statusCode: String(status),
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema: schema ?? {} }],
        });
        if (!arg || (arg.type !== "dictionary" && arg.type !== "list")) {
          gaps.add("response-schema-unknown");
        } else if (schema === null || isLooseLiteralSchema(schema)) {
          gaps.add("response-schema-unknown");
        }
        proven = true;
        continue;
      }
      if (name === "Response") {
        const mime = keywordArgument(value, "mimetype") ?? keywordArgument(value, "content_type");
        const mediaType = mime ? literalString(mime) : null;
        const binary = mediaType === "application/octet-stream";
        responses.push({
          statusCode: String(status),
          description: "",
          confidence: "medium",
          ...(mediaType
            ? {
                content: [
                  {
                    mediaType,
                    ...(binary
                      ? { schema: { type: "string", format: "binary" } }
                      : { schema: {} }),
                  },
                ],
              }
            : {}),
        });
        if (mediaType && !binary) gaps.add("response-schema-unknown");
        proven = true;
        continue;
      }
      if (name === "redirect") {
        const codeNode = keywordArgument(value, "code");
        const redirectStatus = codeNode ? literalInteger(codeNode) : null;
        responses.push({
          statusCode: String(redirectStatus ?? 302),
          description: "",
          confidence: "high",
        });
        proven = true;
        continue;
      }
      if (name === "render_template" || name === "render_template_string") {
        // Server-rendered HTML views carry no JSON schema.
        responses.push({
          statusCode: String(status),
          description: "",
          confidence: "high",
          content: [{ mediaType: "text/html", schema: { type: "string" } }],
        });
        proven = true;
        continue;
      }
      if (name === "send_file" || name === "send_from_directory") {
        responses.push({
          statusCode: String(status),
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/octet-stream", schema: { type: "string", format: "binary" } }],
        });
        proven = true;
        continue;
      }
    }
    if (value.type === "dictionary" || value.type === "list") {
      const schema = literalToSchema(value) ?? {};
      responses.push({
        statusCode: String(status),
        description: "",
        confidence: "medium",
        content: [{ mediaType: "application/json", schema }],
      });
      if (isLooseLiteralSchema(schema)) gaps.add("response-schema-unknown");
      proven = true;
      continue;
    }
    if (value.type === "string" || value.type === "none") {
      responses.push({ statusCode: String(status), description: "", confidence: "medium" });
      proven = true;
    }
  }

  // abort(404) proves error statuses without bodies.
  for (const call of findAll(fn.body, (node) => node.type === "call")) {
    if (guardedMethod(call) && guardedMethod(call) !== method) continue;
    const name = callName(call.namedChildren[0] ?? null);
    if (name !== "abort") continue;
    const statusNode = positionalArguments(call)[0];
    const status = statusNode ? literalInteger(statusNode) : null;
    if (status && status >= 400 && !responses.some((r) => r.statusCode === String(status))) {
      responses.push({ statusCode: String(status), description: "", confidence: "high" });
    }
  }

  if (!proven) gaps.add("response-unknown");
  return responses;
}

function boundedSource(node: TsNode): string {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n# ... truncated` : text;
}
