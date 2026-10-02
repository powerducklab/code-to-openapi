/**
 * Django REST Framework framework pack (Python).
 *
 * DRF has two route wiring idioms, both recovered from static evidence:
 *  - Routers: `router.register(prefix, ViewSet, basename=...)` on a
 *    SimpleRouter/DefaultRouter emits the standard list/create/retrieve/update/
 *    partial_update/destroy routes (plus `@action` extras). Routers are mounted
 *    onto the URLconf via `path("api/", include(router.urls))`.
 *  - URLconf: `path("pattern", View.as_view())` for APIView/GenericAPIView and
 *    `path("pattern", function_view)` for `@api_view` decorated functions.
 *
 * Serializers drive component schemas: IntegerField/CharField/BooleanField/
 * ListField map to JSON Schema, nested Serializer references become $refs, and
 * SerializerMethodField() carries no inspectable shape -> an honest `{}` gap.
 * Dynamic selection (get_serializer_class()) is never fabricated.
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
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  firstChildOfType,
  keywordArgument,
  listElements,
  literalInteger,
  literalString,
  methodCall,
  positionalArguments,
} from "../lang/treesitter/ast.js";

type JsonSchemaLocal = Record<string, unknown>;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

// Action -> (HTTP method, path suffix, success status) for router-generated routes.
const VIEWSET_ACTIONS: Record<
  string,
  { method: string; suffix: string; status: string }
> = {
  list: { method: "get", suffix: "", status: "200" },
  create: { method: "post", suffix: "", status: "201" },
  retrieve: { method: "get", suffix: "{pk}/", status: "200" },
  update: { method: "put", suffix: "{pk}/", status: "200" },
  partial_update: { method: "patch", suffix: "{pk}/", status: "200" },
  destroy: { method: "delete", suffix: "{pk}/", status: "204" },
};

const MIXIN_ACTIONS: Record<string, string[]> = {
  ListModelMixin: ["list"],
  CreateModelMixin: ["create"],
  RetrieveModelMixin: ["retrieve"],
  UpdateModelMixin: ["update", "partial_update"],
  DestroyModelMixin: ["destroy"],
};

// Scalar DRF field -> JSON Schema.
const FIELD_SCHEMAS: Record<string, JsonSchemaLocal> = {
  IntegerField: { type: "integer" },
  FloatField: { type: "number" },
  DecimalField: { type: "number" },
  CharField: { type: "string" },
  EmailField: { type: "string" },
  SlugField: { type: "string" },
  RegexField: { type: "string" },
  URLField: { type: "string", format: "uri" },
  UURLField: { type: "string", format: "uri" },
  UUIDField: { type: "string", format: "uuid" },
  BooleanField: { type: "boolean" },
  NullBooleanField: { type: "boolean" },
  DateField: { type: "string", format: "date" },
  DateTimeField: { type: "string", format: "date-time" },
  TimeField: { type: "string", format: "time" },
  DurationField: { type: "string", format: "duration" },
  FileField: { type: "string", format: "binary" },
  ImageField: { type: "string", format: "binary" },
};

interface SerializerIndex {
  classNames: Set<string>;
  componentsByName: Map<string, JsonSchemaLocal>;
  analysis: PythonAnalysis;
}

function callName(node: TsNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.namedChildren[1]?.text ?? null;
  return null;
}

function baseTail(base: TsNode): string {
  const text = base.text.trim();
  const tail = text.split(".").pop() ?? text;
  return tail;
}

// Convert a Django route fragment (path() converter or re_path named group) into
// an OAS {placeholder}. `<int:pk>` -> {pk}, `(?P<article_slug>[\w-]+)` -> {article_slug}.
function djangoToOasPath(raw: string): string {
  let out = raw.replace(/\(\?P<([^>]+)>[^)]*\)/g, "{$1}");
  out = out.replace(/<(?:[A-Za-z]+:)?([A-Za-z_][A-Za-z0-9_]*)>/g, "{$1}");
  // Strip regex anchors and optional-slash artifacts from re_path/url patterns.
  out = out.replace(/\^/g, "").replace(/\$$/, "");
  out = out.replace(/\/\?/g, "/").replace(/\?/g, "");
  return out;
}

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .map((part) => (part ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return joined ? `/${joined}/` : "/";
}

function operationId(parts: string[]): string {
  const cleaned = parts
    .filter(Boolean)
    .map((p) => p.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `op${cleaned || "Root"}`;
}

// ---------------------------------------------------------------------------
// Serializer index
// ---------------------------------------------------------------------------

function isSerializerBase(base: TsNode, index: SerializerIndex): boolean {
  const tail = baseTail(base);
  if (["Serializer", "ModelSerializer", "HyperlinkedModelSerializer", "ListSerializer"].includes(tail)) {
    return true;
  }
  return index.classNames.has(tail);
}

// Map one DRF field call (`serializers.CharField(...)`, `AuthorSerializer(many=True)`,
// `serializers.ListField(child=...)`, `SerializerMethodField()`) to a JSON Schema.
function drfFieldSchema(call: TsNode, index: SerializerIndex, seen: Set<string>): JsonSchemaLocal {
  const name = callName(call.namedChildren[0] ?? null);
  if (!name) return {};

  if (name === "SerializerMethodField") return {};

  if (name === "ListField" || name === "ListSerializer") {
    const child = keywordArgument(call, "child") ?? positionalArguments(call)[0] ?? null;
    const childSchema = child && child.type === "call" ? drfFieldSchema(child, index, seen) : {};
    return { type: "array", items: childSchema ?? {} };
  }

  const mapped = FIELD_SCHEMAS[name];
  if (mapped) return { ...mapped };

  // Nested serializer: `AuthorSerializer(read_only=True)` / `AuthorSerializer(many=True)`.
  if (index.classNames.has(name)) {
    const ref: JsonSchemaLocal = { $ref: `#/components/schemas/${name}` };
    const many = keywordArgument(call, "many");
    return many?.type === "true" ? { type: "array", items: ref } : ref;
  }

  return {};
}

function buildSerializerSchema(cls: PyClass, index: SerializerIndex, seen: Set<string>): JsonSchemaLocal {
  const existing = index.componentsByName.get(cls.name);
  if (existing) return existing;
  if (seen.has(cls.name)) return { type: "object", properties: {} };
  seen.add(cls.name);

  const properties: Record<string, JsonSchemaLocal> = {};
  const required: string[] = [];

  for (const base of cls.bases) {
    const tail = baseTail(base);
    if (!index.classNames.has(tail) || tail === cls.name) continue;
    const parent = index.analysis.classes.find((c) => c.name === tail);
    if (!parent) continue;
    const parentSchema = buildSerializerSchema(parent, index, seen);
    const parentProps = (parentSchema.properties ?? {}) as Record<string, JsonSchemaLocal>;
    for (const [key, value] of Object.entries(parentProps)) properties[key] = value;
    for (const key of ((parentSchema.required as string[]) ?? [])) required.push(key);
  }

  for (const field of cls.fields) {
    const call = field.default;
    if (!call || call.type !== "call") continue;
    const schema = drfFieldSchema(call, index, seen);
    properties[field.name] = schema;
    // `required=False` / a default value make the field optional.
    if (keywordArgument(call, "required")?.type === "false") continue;
    if (field.default && field.default.type === "call" && keywordArgument(call, "required")?.type !== "true") {
      const hasDefault = positionalArguments(call).length > 0 || keywordArgument(call, "default");
      if (hasDefault) continue;
    }
    if (keywordArgument(call, "required")?.type === "true") required.push(field.name);
    else if (!keywordArgument(call, "required") && !keywordArgument(call, "default") && positionalArguments(call).length === 0) {
      required.push(field.name);
    }
  }

  const schema: JsonSchemaLocal = {
    type: "object",
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
  };
  index.componentsByName.set(cls.name, schema);
  return schema;
}

function buildSerializerIndex(analysis: PythonAnalysis): SerializerIndex {
  const index: SerializerIndex = {
    classNames: new Set(),
    componentsByName: new Map(),
    analysis,
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of analysis.classes) {
      if (index.classNames.has(cls.name)) continue;
      if (cls.bases.some((base) => isSerializerBase(base, index))) {
        index.classNames.add(cls.name);
        changed = true;
      }
    }
  }
  for (const cls of analysis.classes) {
    if (index.classNames.has(cls.name)) buildSerializerSchema(cls, index, new Set());
  }
  return index;
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

interface RouterInstance {
  id: string;
  file: string;
  name: string;
}

export const drfPack: FrameworkPack<PythonAnalysis> = {
  id: "drf",
  language: "python",
  dependencyHints: ["djangorestframework"],

  applies(ctx) {
    const hasDep = ctx.manifest.packages.has("djangorestframework");
    const hasFeature = ctx.index.files
      .filter((f) => f.language === "python")
      .some((f) =>
        /(from rest_framework|import rest_framework|SimpleRouter|DefaultRouter|@api_view|APIView|ModelViewSet|GenericViewSet|viewsets\.)/.test(
          f.content,
        ),
      );
    return hasDep && hasFeature;
  },

  extract(analysis, ctx) {
    const serializers = buildSerializerIndex(analysis);
    const routers = new Map<string, RouterInstance>();
    const unresolved: ExtractionResult["unresolved"] = [];

    // Map module paths to files for cross-file class resolution.
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

    const resolveClassNode = (file: string, node: TsNode | null): PyClass | null => {
      if (!node) return null;
      const name = callName(node);
      if (!name) return null;
      const local = analysis.classes.find((c) => c.name === name && c.file === file);
      if (local) return local;
      const pyFile = analysis.files.get(file);
      const imported = pyFile?.imports.get(name);
      if (imported) {
        const targetFile =
          moduleToFile.get(imported.module) ?? moduleToFile.get(imported.importedName ?? name);
        if (targetFile) {
          return analysis.classes.find((c) => c.name === name && c.file === targetFile) ?? null;
        }
      }
      return analysis.classes.find((c) => c.name === name) ?? null;
    };

    // Pass 1: router instances.
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!target || target.type !== "identifier" || !value || value.type !== "call") continue;
        const ctor = callName(value.namedChildren[0] ?? null);
        if (ctor === "SimpleRouter" || ctor === "DefaultRouter") {
          routers.set(`${file.path}::${target.text}`, {
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
          });
        }
      }
    }

    // Resolve a router reference (identifier or module.router) to a router id.
    const resolveRouterId = (file: string, node: TsNode | null): string | null => {
      if (!node) return null;
      if (node.type === "identifier") {
        const key = `${file}::${node.text}`;
        if (routers.has(key)) return key;
        const pyFile = analysis.files.get(file);
        const imported = pyFile?.imports.get(node.text);
        if (imported?.importedName) {
          const targetFile = moduleToFile.get(imported.module);
          if (targetFile) {
            const t = `${targetFile}::${imported.importedName}`;
            if (routers.has(t)) return t;
          }
        }
        return null;
      }
      if (node.type === "attribute") {
        const receiver = node.namedChildren[0];
        const attr = node.namedChildren[1];
        if (!receiver || !attr) return null;
        const pyFile = analysis.files.get(file);
        const imported = pyFile?.imports.get(receiver.text ?? "");
        const targetFile = imported ? moduleToFile.get(imported.module) : undefined;
        const key = targetFile ? `${targetFile}::${attr.text}` : `${file}::${attr.text}`;
        if (routers.has(key)) return key;
      }
      return null;
    };

    // Mount edges: path("api/", include(router.urls)) -> router gets prefix.
    const routerMount = new Map<string, string>();
    // String includes: path("api/", include("conduit.apps.articles.urls")) folds
    // the prefix onto every route declared in that module's urlpatterns.
    const fileMount = new Map<string, string>();
    // Registrations: router.register(prefix, viewset, basename=...).
    interface Registration {
      routerId: string;
      prefix: string;
      viewset: PyClass;
      basename: string;
      file: string;
    }
    const registrations: Registration[] = [];

    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.receiver.type !== "identifier") continue;

        if (mc.method === "register") {
          const routerId = resolveRouterId(file.path, mc.receiver);
          if (!routerId) continue;
          const args = positionalArguments(call);
          const prefixNode = args[0];
          const viewsetNode = args[1] ?? null;
          const prefix = prefixNode ? literalString(prefixNode) ?? "" : "";
          const viewset = resolveClassNode(file.path, viewsetNode);
          if (!viewset) continue;
          const basenameKw = keywordArgument(call, "basename");
          const basename =
            (basenameKw ? literalString(basenameKw) : null) ?? viewset.name.replace(/ViewSet$/, "").toLowerCase();
          registrations.push({ routerId, prefix, viewset, basename, file: file.path });
        }
      }

      // include(router.urls) mount prefix.
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const fnName = callName(call.namedChildren[0] ?? null);
        if (fnName !== "path" && fnName !== "re_path" && fnName !== "url") continue;
        const args = positionalArguments(call);
        const prefixNode = args[0];
        const viewArg = args[1];
        if (!viewArg) continue;
        // include(x.urls) -> second arg is include(...) call whose arg is an attribute `x.urls`.
        if (viewArg.type === "call" && callName(viewArg.namedChildren[0] ?? null) === "include") {
          const inner = positionalArguments(viewArg)[0];
          const prefix = prefixNode ? literalString(prefixNode) ?? "" : "";
          const innerAttr = inner && inner.type === "attribute" ? inner : null;
          if (innerAttr?.namedChildren[1]?.text === "urls") {
            const routerId = resolveRouterId(file.path, innerAttr.namedChildren[0]);
            if (routerId) routerMount.set(routerId, djangoToOasPath(prefix));
          } else if (inner) {
            // include("dotted.module.urls"): resolve the module to a file.
            const mod = literalString(inner);
            if (mod) {
              const targetFile = moduleToFile.get(mod);
              if (targetFile) fileMount.set(targetFile, djangoToOasPath(prefix));
            }
          }
        }
      }
    }

    const routes: RouteCandidate[] = [];

    // --- Router-generated viewset routes ---
    for (const reg of registrations) {
      const mountPrefix = routerMount.get(reg.routerId) ?? "";
      const modulePrefix = fileMount.get(reg.file) ?? "";
      const basePath = joinPath(modulePrefix, mountPrefix, djangoToOasPath(reg.prefix));
      const serializerName = viewSerializerClass(reg.viewset, resolveClassNode, reg.file);
      const dynamicSerializer = viewsetOverridesGetSerializer(reg.viewset) && !serializerName;

      const actions = viewsetActions(reg.viewset, analysis);
      for (const action of actions) {
        const meta = VIEWSET_ACTIONS[action];
        if (!meta) continue;
        const path = joinPath(basePath, meta.suffix);
        routes.push(
          buildViewsetRoute({
            method: meta.method,
            path,
            status: meta.status,
            action,
            basename: reg.basename,
            viewset: reg.viewset,
            serializerName: dynamicSerializer ? null : serializerName,
            dynamicSerializer,
            serializers,
            file: reg.file,
            paginated: viewsetHasPagination(reg.viewset),
          }),
        );
      }

      // @action(detail=...) extra routes.
      for (const fn of analysis.functions) {
        if (!methodBelongsToClass(reg.viewset, fn)) continue;
        if (!fn.decorated) continue;
        for (const decorator of fn.decorators) {
          const callNode = decorator.namedChildren[0];
          if (!callNode || callNode.type !== "call") continue;
          if (callName(callNode.namedChildren[0] ?? null) !== "action") continue;
          const methodsList = listElements(keywordArgument(callNode, "methods"));
          const methods = methodsList.length
            ? methodsList.map((m) => literalString(m)?.toLowerCase()).filter((m): m is string => !!m)
            : ["get"];
          const detailNode = keywordArgument(callNode, "detail");
          const detail = detailNode?.type !== "false";
          const urlPathKw = keywordArgument(callNode, "url_path");
          const seg = urlPathKw ? literalString(urlPathKw) ?? fn.name : fn.name;
          const path = detail
            ? joinPath(basePath, `{pk}/${seg}/`)
            : joinPath(basePath, `${seg}/`);
          for (const method of methods) {
            routes.push(
              buildActionRoute({
                method,
                path,
                basename: reg.basename,
                action: seg,
                fn,
                serializers,
                file: fn.file,
                serializerName: dynamicSerializer ? null : serializerName,
              }),
            );
          }
        }
      }
    }

    // --- URLconf routes: path("x", View.as_view()) / path("x", func_view) ---
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const fnName = callName(call.namedChildren[0] ?? null);
        if (fnName !== "path" && fnName !== "re_path" && fnName !== "url") continue;
        const args = positionalArguments(call);
        const prefixNode = args[0];
        const viewArg = args[1];
        if (!prefixNode || !viewArg) continue;
        const rawPath = literalString(prefixNode);
        if (rawPath === null) continue;
        // Skip include(...) mounts (already handled).
        if (viewArg.type === "call" && callName(viewArg.namedChildren[0] ?? null) === "include") continue;
        const modulePrefix = fileMount.get(file.path) ?? "";
        const oasPath = joinPath(modulePrefix, djangoToOasPath(rawPath));

        // Class-based: View.as_view()
        if (viewArg.type === "call" && callName(viewArg.namedChildren[0] ?? null) === "as_view") {
          const clsNode = viewArg.namedChildren[0]?.namedChildren[0] ?? null;
          const cls = resolveClassNode(file.path, clsNode);
          if (!cls) continue;
          const serializerName = viewSerializerClass(cls, resolveClassNode, file.path);
          const genericMethods = genericViewMethods(cls);
          for (const methodName of ["get", "post", "put", "patch", "delete"]) {
            const methodNode = findMethod(cls, methodName);
            if (!methodNode && !genericMethods.includes(methodName)) continue;
            const fn = methodNode ? analysis.functions.find((f) => f.node === methodNode) : undefined;
            routes.push(
              buildClassMethodRoute({
                method: methodName,
                path: oasPath,
                cls,
                fn,
                serializerName,
                serializers,
                file: file.path,
              }),
            );
          }
          continue;
        }

        // Function-based: @api_view decorated function (`views.ping` or `ping`).
        if (viewArg.type === "identifier" || viewArg.type === "attribute") {
          const viewName = callName(viewArg);
          const fn = viewName
            ? analysis.functions.find((f) => f.name === viewName)
            : undefined;
          if (!fn || !fn.decorated) continue;
          const methods = apiViewMethods(fn);
          if (!methods) continue;
          for (const method of methods) {
            routes.push(
              buildFunctionViewRoute({
                method,
                path: oasPath,
                fn,
                serializers,
                file: fn.file,
              }),
            );
          }
        }
      }
    }

    // Dedupe (first evidence wins).
    const deduped = new Map<string, RouteCandidate>();
    for (const route of routes) {
      const key = `${route.method} ${route.fullPath}`;
      if (!deduped.has(key)) deduped.set(key, route);
    }

    const components: ExtractionResult["components"] = [
      ...serializers.componentsByName.entries(),
    ].map(([name, schema]) => ({ name, schema }));

    return {
      routes: [...deduped.values()],
      unresolved,
      components,
      securitySchemes: [],
      servers: [],
    };
  },
};

// --- helpers ---------------------------------------------------------------

// Map a generic view base (generics.ListAPIView, etc.) to its HTTP methods.
const GENERIC_VIEW_METHODS: Record<string, string[]> = {
  ListAPIView: ["get"],
  ListCreateAPIView: ["get", "post"],
  RetrieveAPIView: ["get"],
  CreateAPIView: ["post"],
  DestroyAPIView: ["delete"],
  UpdateAPIView: ["put", "patch"],
  RetrieveUpdateAPIView: ["get", "put", "patch"],
  RetrieveUpdateDestroyAPIView: ["get", "put", "patch", "delete"],
};

function genericViewMethods(cls: PyClass): string[] {
  for (const base of cls.bases) {
    const tail = baseTail(base);
    if (GENERIC_VIEW_METHODS[tail]) return GENERIC_VIEW_METHODS[tail];
  }
  return [];
}

function findMethod(cls: PyClass, name: string): TsNode | null {
  return findFirst(cls.node, (n) => {
    if (n.type !== "function_definition") return false;
    return n.namedChildren[0]?.text === name;
  });
}

function methodBelongsToClass(cls: PyClass, fn: PyFunction): boolean {
  return !!findFirst(cls.node, (n) => n === fn.node);
}

// Resolve `serializer_class = X` on the viewset (or inherited bases).
function viewSerializerClass(
  cls: PyClass,
  resolveClassNode: (file: string, node: TsNode | null) => PyClass | null,
  file: string,
): string | null {
  const direct = cls.fields.find((f) => f.name === "serializer_class");
  if (direct?.default) return callName(direct.default);
  for (const base of cls.bases) {
    const tail = baseTail(base);
    if (["GenericViewSet", "ModelViewSet", "ViewSet", "GenericAPIView", "APIView"].includes(tail)) continue;
    const parent = resolveClassNode(file, base);
    if (parent) {
      const inherited = viewSerializerClass(parent, resolveClassNode, parent.file);
      if (inherited) return inherited;
    }
  }
  return null;
}

function viewsetOverridesGetSerializer(cls: PyClass): boolean {
  return !!findMethod(cls, "get_serializer_class");
}

function viewsetHasPagination(cls: PyClass): boolean {
  const f = cls.fields.find((x) => x.name === "pagination_class");
  // `pagination_class = None` disables pagination; anything else (a class) opts in.
  if (!f) return false;
  return f.default?.type !== "none";
}

// Compute the set of router actions a viewset exposes.
function viewsetActions(cls: PyClass, analysis: PythonAnalysis): string[] {
  const actions = new Set<string>();
  const collect = (c: PyClass, seen: Set<string>): void => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    for (const base of c.bases) {
      const tail = baseTail(base);
      if (MIXIN_ACTIONS[tail]) for (const a of MIXIN_ACTIONS[tail]) actions.add(a);
      if (tail === "ModelViewSet") {
        for (const a of Object.keys(VIEWSET_ACTIONS)) actions.add(a);
      }
      // Walk into user mixins/viewsets defined in-project.
      const parent = analysis.classes.find((x) => x.name === tail);
      if (parent) collect(parent, seen);
    }
    // Explicitly defined action methods.
    for (const name of Object.keys(VIEWSET_ACTIONS)) {
      if (findMethod(c, name)) actions.add(name);
    }
  };
  collect(cls, new Set());
  return [...actions];
}

function apiViewMethods(fn: PyFunction): string[] | null {
  for (const decorator of fn.decorators) {
    const callNode = decorator.namedChildren[0];
    if (!callNode || callNode.type !== "call") continue;
    if (callName(callNode.namedChildren[0] ?? null) !== "api_view") continue;
    const listNode = positionalArguments(callNode)[0];
    const methods = listNode
      ? listElements(listNode)
          .map((n) => literalString(n)?.toLowerCase())
          .filter((m): m is string => !!m && HTTP_METHODS.has(m))
      : ["get"];
    return methods;
  }
  return null;
}

interface CommonRouteInput {
  file: string;
  serializers: SerializerIndex;
}

function pathParams(path: string): RouteParameter[] {
  const params: RouteParameter[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    params.push({
      name: match[1]!,
      in: "path",
      required: true,
      schema: { type: "string" },
      confidence: "high",
    });
  }
  return params;
}

function buildViewsetRoute(
  input: {
    method: string;
    path: string;
    status: string;
    action: string;
    basename: string;
    viewset: PyClass;
    serializerName: string | null;
    dynamicSerializer: boolean;
    paginated: boolean;
  } & CommonRouteInput,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  const origin: SourceLocation = {
    file: input.file,
    line: input.viewset.node.startPosition.row + 1,
    symbol: `${input.viewset.name}.${input.action}`,
  };

  let requestBody: RouteCandidate["requestBody"] | undefined;
  let responses: RouteCandidate["responses"] = [];

  const ref = input.serializerName
    ? { $ref: `#/components/schemas/${input.serializerName}` }
    : null;

  if (input.action === "create" || input.action === "update" || input.action === "partial_update") {
    if (ref) {
      requestBody = {
        required: true,
        confidence: "high",
        content: [{ mediaType: "application/json", schema: ref }],
      };
    } else {
      requestBody = {
        required: true,
        confidence: "medium",
        content: [{ mediaType: "application/json", schema: {} }],
      };
      gaps.add("body-schema-unknown");
    }
  }

  if (input.status === "204") {
    responses = [{ statusCode: "204", description: "No Content", confidence: "high", content: [] }];
  } else if (input.action === "list") {
    const items: JsonSchemaLocal = ref ? { $ref: `#/components/schemas/${input.serializerName}` } : {};
    let schema: JsonSchemaLocal;
    if (input.paginated) {
      schema = {
        type: "object",
        properties: {
          count: { type: "integer" },
          next: { type: "string", nullable: true },
          previous: { type: "string", nullable: true },
          results: { type: "array", items },
        },
      };
    } else {
      schema = { type: "array", items };
    }
    if (!ref) gaps.add("response-schema-unknown");
    responses = [
      {
        statusCode: input.status,
        description: "",
        confidence: ref ? "high" : "medium",
        content: [{ mediaType: "application/json", schema }],
      },
    ];
  } else {
    if (ref) {
      responses = [
        {
          statusCode: input.status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: ref }],
        },
      ];
    } else {
      gaps.add("response-schema-unknown");
      responses = [
        {
          statusCode: input.status,
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema: {} }],
        },
      ];
    }
  }

  const confidence: Confidence = gaps.size ? "medium" : "high";
  return {
    method: input.method,
    path: input.path,
    fullPath: input.path,
    operationId: operationId([input.basename, input.action]),
    origin,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    confidence,
    gaps: [...gaps],
    components: [],
  };
}

function buildActionRoute(
  input: {
    method: string;
    path: string;
    basename: string;
    action: string;
    fn: PyFunction;
    serializerName: string | null;
  } & CommonRouteInput,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  const origin: SourceLocation = {
    file: input.file,
    line: input.fn.node.startPosition.row + 1,
    symbol: `${input.fn.name}`,
  };

  // @action bodies/responses: no static serializer shape proven from the method.
  gaps.add("response-schema-unknown");
  if (input.method === "post" || input.method === "put" || input.method === "patch") {
    gaps.add("body-schema-unknown");
  }
  const responses: RouteCandidate["responses"] = [
    {
      statusCode: "200",
      description: "",
      confidence: "medium",
      content: [{ mediaType: "application/json", schema: {} }],
    },
  ];

  return {
    method: input.method,
    path: input.path,
    fullPath: input.path,
    operationId: operationId([input.basename, input.action, input.method]),
    origin,
    parameters,
    ...((input.method === "post" || input.method === "put" || input.method === "patch")
      ? {
          requestBody: {
            required: true,
            confidence: "medium",
            content: [{ mediaType: "application/json", schema: {} }],
          },
        }
      : {}),
    responses,
    tags: [],
    confidence: "medium",
    gaps: [...gaps],
    components: [],
  };
}

function buildClassMethodRoute(
  input: {
    method: string;
    path: string;
    cls: PyClass;
    fn: PyFunction | undefined;
    serializerName: string | null;
  } & CommonRouteInput,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  const origin: SourceLocation = {
    file: input.file,
    line: (input.fn?.node ?? input.cls.node).startPosition.row + 1,
    symbol: `${input.cls.name}.${input.method}`,
  };

  let requestBody: RouteCandidate["requestBody"] | undefined;
  const ref = input.serializerName
    ? { $ref: `#/components/schemas/${input.serializerName}` }
    : null;

  if ((input.method === "post" || input.method === "put" || input.method === "patch") && ref) {
    requestBody = {
      required: true,
      confidence: "high",
      content: [{ mediaType: "application/json", schema: ref }],
    };
  }

  let responses: RouteCandidate["responses"];
  if (input.method === "delete") {
    responses = [{ statusCode: "204", description: "No Content", confidence: "high", content: [] }];
  } else {
    responses = [
      {
        statusCode: "200",
        description: "",
        confidence: ref ? "high" : "medium",
        content: [{ mediaType: "application/json", schema: ref ?? {} }],
      },
    ];
    if (!ref) gaps.add("response-schema-unknown");
  }

  return {
    method: input.method,
    path: input.path,
    fullPath: input.path,
    operationId: operationId([input.cls.name, input.method]),
    origin,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [],
    confidence: gaps.size ? "medium" : "high",
    gaps: [...gaps],
    components: [],
  };
}

function buildFunctionViewRoute(
  input: {
    method: string;
    path: string;
    fn: PyFunction;
  } & CommonRouteInput,
): RouteCandidate {
  const gaps = new Set<GapCode>();
  const parameters = pathParams(input.path);
  // Named parameters on the function beyond `request` are path params.
  for (const p of input.fn.params) {
    if (["request", "self", "cls"].includes(p.name) || p.kind !== "plain") continue;
    if (!parameters.some((x) => x.name === p.name)) {
      parameters.push({
        name: p.name,
        in: "path",
        required: true,
        schema: p.annotation ? {} : { type: "string" },
        confidence: "medium",
      });
    }
  }
  gaps.add("response-schema-unknown");
  if (input.method === "post" || input.method === "put" || input.method === "patch") {
    gaps.add("body-schema-unknown");
  }
  const responses: RouteCandidate["responses"] = [
    {
      statusCode: "200",
      description: "",
      confidence: "medium",
      content: [{ mediaType: "application/json", schema: {} }],
    },
  ];
  return {
    method: input.method,
    path: input.path,
    fullPath: input.path,
    operationId: operationId([input.fn.name, input.method]),
    origin: { file: input.file, line: input.fn.node.startPosition.row + 1, symbol: input.fn.name },
    parameters,
    ...((input.method === "post" || input.method === "put" || input.method === "patch")
      ? {
          requestBody: {
            required: true,
            confidence: "medium",
            content: [{ mediaType: "application/json", schema: {} }],
          },
        }
      : {}),
    responses,
    tags: [],
    confidence: "medium",
    gaps: [...gaps],
    components: [],
  };
}
