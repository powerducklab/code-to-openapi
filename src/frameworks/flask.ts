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
import { isLooseLiteralSchema, literalToSchema } from "../lang/python/schema.js";
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
  decorator: TsNode;
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
  /** All known marshmallow Schema subclass names. */
  classNames: Set<string>;
  /** Full analysis, used to resolve parent classes. */
  analysis: PythonAnalysis;
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
    case "Url":
    case "URL":
    case "Email":
    case "UUID":
      return { type: "string" };
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
        return many ? { type: "array", items: ref } : ref;
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
    properties[field.name] = marshFieldSchema(call, index, seen);
    if (keywordArgument(call, "required")?.type === "true") required.push(field.name);
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
    classNames: new Set(),
    analysis,
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
      }
    }
  }

  for (const cls of analysis.classes) {
    if (index.classNames.has(cls.name)) buildMarshClassSchema(cls, index, new Set());
  }

  return index;
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
      if (!imported) return null;
      const targetFile = moduleToFile.get(imported.module);
      return targetFile ? byVar(targetFile, attr.text) ?? null : null;
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
      requestBody = {
        required: true,
        confidence: "medium",
        content: [{ mediaType: "application/x-www-form-urlencoded", schema: { type: "object" } }],
      };
      gaps.add("body-schema-unknown");
    } else if (evidenceForMethod("data")) {
      gaps.add("body-unknown");
    }
  }

  // Responses.
  const responses = buildFlaskResponses(fn, gaps, method);

  // APIFairy decorators carry explicit marshmallow models that the return-value
  // scan cannot infer; apply them on top of, and reconcile against, the
  // return-statement evidence.
  const apifairy = scanApifairyDecorators(fn, marsh);
  if (apifairy.requestClass) {
    requestBody = {
      required: true,
      confidence: "high",
      content: [
        { mediaType: "application/json", schema: { $ref: `#/components/schemas/${apifairy.requestClass}` } },
      ],
    };
    gaps.delete("body-schema-unknown");
    gaps.delete("body-unknown");
  }
  if (apifairy.success) {
    const { className, statusCode, paginated } = apifairy.success;
    const schema: JsonSchemaLocal = paginated
      ? {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: `#/components/schemas/${className}` } },
          },
        }
      : { $ref: `#/components/schemas/${className}` };
    const upsert = {
      statusCode,
      description: "",
      confidence: "high" as Confidence,
      content: [{ mediaType: "application/json", schema }],
    };
    const idx = responses.findIndex((r) => r.statusCode === statusCode);
    if (idx >= 0) responses[idx] = upsert;
    else responses.push(upsert);
    gaps.delete("response-unknown");
    gaps.delete("response-schema-unknown");
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

  const isSse = responses.some((r) =>
    r.content?.some((m) => m.mediaType === "text/event-stream"),
  );

  const confidence: Confidence = gaps.size ? "medium" : "high";
  const origin: SourceLocation = {
    file,
    line: site.decorator.startPosition.row + 1,
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
  success: { className: string; statusCode: string; paginated: boolean } | null;
  requestClass: string | null;
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
      const statusNode = args[1] ?? null;
      const statusCode = statusNode ? String(literalInteger(statusNode) ?? 200) : "200";
      evidence.success = { className, statusCode, paginated: name === "paginated_response" };
    } else if (name === "body") {
      evidence.requestClass = resolveMarshRef(args[0] ?? null, marsh);
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
    let status = 200;
    // Tuple return: (payload, status) — parenthesized tuples use "tuple",
    // bare comma returns use "expression_list".
    if (value?.type === "tuple" || value?.type === "expression_list") {
      const elements = value.namedChildren;
      value = elements[0] ?? null;
      const statusNode = elements[1];
      status = statusNode ? literalInteger(statusNode) ?? 200 : 200;
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
