/**
 * FastAPI framework pack (Python).
 *
 * Deterministic gates:
 *  - receivers must trace to FastAPI()/APIRouter() assignments in the project;
 *  - route paths must be plain string literals (f-strings are unresolved);
 *  - only routers transitively included into a FastAPI app are reachable;
 *  - schemas come from annotations / Pydantic models / literal returns only.
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
import type { PythonAnalysis, PyFunction, PyParam } from "../lang/python/index.js";
import {
  annotationToSchema,
  buildModelIndex,
  ensureComponent,
  isLooseLiteralSchema,
  literalToSchema,
  type ModelIndex,
} from "../lang/python/schema.js";
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

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

const INJECTION_CALLS = new Set([
  "Query",
  "Path",
  "Header",
  "Cookie",
  "Body",
  "File",
  "Form",
  "Depends",
]);

const PATH_CONVERTERS: Record<string, JsonSchemaLocal> = {
  int: { type: "integer" },
  float: { type: "number" },
  path: { type: "string" },
  str: { type: "string" },
  uuid: { type: "string", format: "uuid" },
};

type JsonSchemaLocal = Record<string, unknown>;

interface RouterInstance {
  id: string;
  file: string;
  name: string;
  kind: "app" | "router";
  prefix: string;
  tags: string[];
}

interface MountEdge {
  parent: string;
  child: string;
  prefix: string;
  tags: string[];
}

interface SecurityBinding {
  id: string;
  file: string;
  name: string;
  schemeName: string;
  scheme: Record<string, unknown>;
}

interface RouteSite {
  routerId: string;
  method: string;
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

// FastAPI path converters look like {product_id:int}; OAS path templates only
// carry the parameter name ({product_id}), so strip the converter segment.
function normalizePath(raw: string): string {
  return raw.replace(/\{([^{}:]+):[^{}]+\}/g, "{$1}");
}

function operationId(method: string, fullPath: string): string {
  const segments = fullPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}:]/g, ""))
    .map((segment) => segment.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const tail = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  return `${method.toLowerCase()}${tail}` || `${method.toLowerCase()}Root`;
}

function callName(node: TsNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.namedChildren[1]?.text ?? null;
  return null;
}

function annotatedMetadata(param: PyParam): TsNode[] {
  if (!param.annotation) return [];
  const generic =
    param.annotation.type === "generic_type" || param.annotation.type === "subscript"
      ? param.annotation
      : null;
  if (!generic) return [];
  // generic_type: identifier Annotated + type_parameter(type, metadata...)
  const name = generic.namedChildren[0]?.text.split(".").pop();
  if (name !== "Annotated") return [];
  const params = childrenOfType(generic, "type_parameter");
  const args = params.flatMap((p) =>
    p.namedChildren.map((child) =>
      child.type === "type" ? child.namedChildren[0] ?? child : child,
    ),
  );
  return args.slice(1);
}

function annotatedInnerType(param: PyParam): TsNode | null {
  if (!param.annotation) return null;
  const generic =
    param.annotation.type === "generic_type" || param.annotation.type === "subscript"
      ? param.annotation
      : null;
  if (!generic) return null;
  const name = generic.namedChildren[0]?.text.split(".").pop();
  if (name !== "Annotated") return null;
  const params = childrenOfType(generic, "type_parameter");
  const args = params.flatMap((p) =>
    p.namedChildren.map((child) =>
      child.type === "type" ? child.namedChildren[0] ?? child : child,
    ),
  );
  return args[0] ?? null;
}

function injectionKind(param: PyParam): { kind: string; call: TsNode } | null {
  for (const meta of annotatedMetadata(param)) {
    if (meta.type === "call") {
      const name = callName(meta.namedChildren[0] ?? null);
      if (name && INJECTION_CALLS.has(name)) return { kind: name, call: meta };
    }
  }
  if (param.default?.type === "call") {
    const name = callName(param.default.namedChildren[0] ?? null);
    if (name && INJECTION_CALLS.has(name)) return { kind: name, call: param.default };
  }
  return null;
}

function injectionRequired(call: TsNode): boolean {
  const positional = positionalArguments(call);
  if (positional.some((arg) => arg.type === "ellipsis")) return true;
  const required = keywordArgument(call, "required");
  if (required?.type === "true") return true;
  if (required?.type === "false") return false;
  const defaultArg = keywordArgument(call, "default");
  if (defaultArg) return defaultArg.type === "ellipsis";
  return positional.length === 0;
}

function injectionAlias(call: TsNode): string | null {
  const alias = keywordArgument(call, "alias");
  return alias ? literalString(alias) : null;
}

// A Python-level default value (including "" or None) makes the binding
// optional. The `= Query(...)` injection form keeps its own required logic.
function bindingRequired(param: PyParam, call: TsNode): boolean {
  if (param.default && param.default.type !== "call") return false;
  return injectionRequired(call);
}

function headerName(paramName: string, call: TsNode): string {
  return injectionAlias(call) ?? paramName.replace(/_/g, "-");
}

// Scalar value of a Python literal default. `None` leaves an optional binding
// with no serializable default, and containers / calls are not parameter
// defaults we can express.
function parameterDefault(param: PyParam, call: TsNode | null): { found: boolean; value: unknown } {
  let node: TsNode | null = null;
  if (param.default && param.default.type !== "call") {
    node = param.default;
  } else if (call) {
    const explicit = keywordArgument(call, "default");
    node = explicit ?? positionalArguments(call)[0] ?? null;
  }
  if (!node || node.type === "ellipsis" || node.type === "none") {
    return { found: false, value: undefined };
  }
  if (node.type === "integer") return { found: true, value: literalInteger(node) };
  if (node.type === "float") {
    const value = Number.parseFloat(node.text);
    return { found: Number.isFinite(value), value };
  }
  const str = literalString(node);
  if (str !== null) return { found: true, value: str };
  if (node.type === "true") return { found: true, value: true };
  if (node.type === "false") return { found: true, value: false };
  return { found: false, value: undefined };
}

function numericLiteral(node: TsNode | null): number | null {
  if (!node) return null;
  const integer = literalInteger(node);
  if (integer !== null) return integer;
  if (node.type === "float") {
    const value = Number.parseFloat(node.text);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

// Fold a Query/Path/Header/Cookie validator's constraints and the binding's
// scalar default into the schema derived from the annotation.
function parameterSchema(
  base: JsonSchemaLocal,
  param: PyParam,
  call: TsNode | null,
): JsonSchemaLocal {
  const schema: JsonSchemaLocal = { ...base };
  if (call) {
    const ge = numericLiteral(keywordArgument(call, "ge"));
    const le = numericLiteral(keywordArgument(call, "le"));
    const gt = numericLiteral(keywordArgument(call, "gt"));
    const lt = numericLiteral(keywordArgument(call, "lt"));
    if (ge !== null) schema.minimum = ge;
    if (le !== null) schema.maximum = le;
    if (gt !== null) schema.exclusiveMinimum = gt;
    if (lt !== null) schema.exclusiveMaximum = lt;
    const minLength = literalInteger(keywordArgument(call, "min_length"));
    if (minLength !== null) schema.minLength = minLength;
    const maxLength = literalInteger(keywordArgument(call, "max_length"));
    if (maxLength !== null) schema.maxLength = maxLength;
    const patternNode = keywordArgument(call, "pattern") ?? keywordArgument(call, "regex");
    const pattern = patternNode ? literalString(patternNode) : null;
    if (pattern !== null) schema.pattern = pattern;
  }
  const def = parameterDefault(param, call);
  if (def.found) schema.default = def.value;
  return schema;
}

function pathPlaceholders(rawPath: string): Array<{ name: string; converter: string }> {
  const result: Array<{ name: string; converter: string }> = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawPath))) {
    const [name, converter] = match[1]!.split(":");
    result.push({ name: name!, converter: converter ?? "str" });
  }
  return result;
}

function isRequestParam(param: PyParam): boolean {
  const text = param.annotation?.text ?? "";
  return (
    /\b(Request|HTTPRequest|WebSocket|BackgroundTasks|Response)\b/.test(text) &&
    !/\bUploadFile\b/.test(text)
  );
}

export const fastapiPack: FrameworkPack<PythonAnalysis> = {
  id: "fastapi",
  language: "python",
  dependencyHints: ["fastapi"],

  applies(ctx) {
    if (ctx.manifest.packages.has("fastapi")) return true;
    return ctx.index.files
      .filter((file) => file.language === "python")
      .some((file) => /(^|\n)\s*(from fastapi|import fastapi)\b/.test(file.content));
  },

  extract(analysis, ctx) {
    const modelIndex = buildModelIndex(analysis);
    const routers = new Map<string, RouterInstance>();
    const edges: MountEdge[] = [];
    const sites: RouteSite[] = [];
    const dynamicPaths: SourceLocation[] = [];
    const securityBindings: SecurityBinding[] = [];
    const unresolved: ExtractionResult["unresolved"] = [];

    const routerById = (file: string, name: string): RouterInstance | undefined =>
      routers.get(`${file}::${name}`);

    // Map importable module paths ("app.routers.items") to indexed files.
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

    // Resolve a dotted module path against indexed files, trying both the
    // full path and every suffix (packages share a common root directory).
    const resolveModuleFile = (modulePath: string): string | undefined => {
      const normalized = modulePath.replace(/^\.+/, "");
      if (!normalized) return undefined;
      return moduleToFile.get(normalized);
    };

    // Expand a possibly relative module descriptor (from .routers import x)
    // into an absolute dotted module path, anchored at the importing file's
    // package. __init__.py files anchor at their own package.
    const resolveRelativeModule = (file: string, moduleText: string): string => {
      const leadingDots = /^(\.*)/.exec(moduleText)?.[1]?.length ?? 0;
      if (!leadingDots) return moduleText;
      const noExt = file.replace(/\.pyi?$/, "").replace(/\\/g, "/");
      const segments = noExt.split("/");
      const isInit = segments[segments.length - 1] === "__init__";
      // Regular module a/b/c.py: one dot anchors at package a/b (strip the
      // module name plus one level per extra dot). __init__.py anchors at its
      // own package (strip dots minus one).
      const strip = isInit ? Math.max(0, leadingDots - 1) : leadingDots;
      const base = segments.slice(0, segments.length - strip);
      const suffix = moduleText.replace(/^\.+/, "");
      return [...base, ...(suffix ? [suffix] : [])].join(".");
    };

    const resolveRouterRef = (file: string, node: TsNode): RouterInstance | null => {
      if (node.type !== "identifier" && node.type !== "attribute") return null;
      if (node.type === "identifier") {
        const local = routerById(file, node.text);
        if (local) return local;
        const pyFile = analysis.files.get(file);
        const imported = pyFile?.imports.get(node.text);
        if (imported?.importedName) {
          // from pkg.mod import router
          const absolute = resolveRelativeModule(file, imported.module);
          const targetFile =
            resolveModuleFile(absolute) ??
            moduleToFile.get(imported.importedName) ??
            null;
          if (targetFile) {
            return routerById(targetFile, imported.importedName) ?? null;
          }
        }
        return null;
      }
      // module.router style: import app.routers.items as items_module, or
      // from .routers import items followed by items.router.
      const receiver = node.namedChildren[0];
      const attr = node.namedChildren[1];
      const pyFile = analysis.files.get(file);
      if (!receiver || !attr || !pyFile) return null;
      const imported = pyFile.imports.get(receiver.text);
      if (!imported) return null;
      let targetFile: string | undefined;
      if (imported.importedName && imported.importedName !== receiver.text) {
        // from <package> import <submodule> aliased at import site
        const absolute = resolveRelativeModule(file, imported.module);
        targetFile =
          resolveModuleFile(`${absolute}.${imported.importedName}`) ??
          resolveModuleFile(absolute);
      } else {
        // The binding may be a name re-exported by the package or a submodule
        // of the same name (from .routers import products -> products.py);
        // prefer the submodule match, then the package __init__.
        const absolute = resolveRelativeModule(file, imported.module);
        const importedName = imported.importedName ?? receiver.text;
        targetFile =
          resolveModuleFile(`${absolute}.${importedName}`) ??
          resolveModuleFile(absolute);
      }
      return targetFile ? routerById(targetFile, attr.text) ?? null : null;
    };

    // Pass 1a: register every app/router/security binding across all files.
    for (const file of analysis.files.values()) {
      for (const assignment of findAll(file.root, (n) => n.type === "assignment")) {
        const target = assignment.namedChildren[0];
        const value = assignment.namedChildren[assignment.namedChildren.length - 1];
        if (!target || target.type !== "identifier" || !value || value.type !== "call") continue;
        const constructorName = callName(value.namedChildren[0] ?? null);
        if (constructorName === "FastAPI") {
          routers.set(`${file.path}::${target.text}`, {
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            kind: "app",
            prefix: "",
            tags: [],
          });
        } else if (constructorName === "APIRouter") {
          const prefixNode = keywordArgument(value, "prefix");
          const tagsNode = keywordArgument(value, "tags");
          routers.set(`${file.path}::${target.text}`, {
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            kind: "router",
            prefix: prefixNode ? literalString(prefixNode) ?? "" : "",
            tags: tagsNode ? listElements(tagsNode).map((t) => literalString(t) ?? "").filter(Boolean) : [],
          });
        } else if (constructorName === "OAuth2PasswordBearer") {
          const tokenUrlNode = positionalArguments(value)[0] ?? keywordArgument(value, "tokenUrl");
          const tokenUrl = tokenUrlNode ? literalString(tokenUrlNode) ?? "" : "";
          securityBindings.push({
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            schemeName: target.text,
            scheme: {
              type: "oauth2",
              flows: { password: { tokenUrl, scopes: {} } },
            },
          });
        } else if (
          constructorName === "APIKeyHeader" ||
          constructorName === "APIKeyQuery" ||
          constructorName === "APIKeyCookie" ||
          constructorName === "HTTPBearer" ||
          constructorName === "HTTPBasic" ||
          constructorName === "HTTPDigest"
        ) {
          securityBindings.push({
            id: `${file.path}::${target.text}`,
            file: file.path,
            name: target.text,
            schemeName: target.text,
            scheme: buildSecurityScheme(constructorName, value),
          });
        }
      }
    }

    // Pass 1b: mount edges (imports may point to routers in other files).
    for (const file of analysis.files.values()) {
      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc) continue;
        if (mc.method !== "include_router") continue;
        if (mc.receiver.type !== "identifier") continue;
        const parent = routerById(file.path, mc.receiver.text);
        const childArg = positionalArguments(call)[0];
        if (!parent || !childArg) continue;
        const child = resolveRouterRef(file.path, childArg);
        if (!child) continue;
        const prefixNode = keywordArgument(call, "prefix");
        const tagsNode = keywordArgument(call, "tags");
        edges.push({
          parent: parent.id,
          child: child.id,
          prefix: prefixNode ? literalString(prefixNode) ?? "" : "",
          tags: tagsNode
            ? listElements(tagsNode).map((t) => literalString(t) ?? "").filter(Boolean)
            : [],
        });
      }
    }

    // Pass 2: route decorators.
    for (const fn of analysis.functions) {
      if (!fn.decorated) continue;
      for (const decorator of fn.decorators) {
        const callNode = decorator.namedChildren[0];
        if (!callNode || callNode.type !== "call") continue;
        const mc = methodCall(callNode);
        if (!mc || mc.receiver.type !== "identifier") continue;
        const router = routerById(fn.file, mc.receiver.text);
        if (!router) continue;

        const methods =
          mc.method === "api_route"
            ? listElements(keywordArgument(callNode, "methods"))
                .map((node) => literalString(node)?.toLowerCase())
                .filter((m): m is string => !!m && HTTP_METHODS.has(m))
            : HTTP_METHODS.has(mc.method)
              ? [mc.method]
              : null;
        if (!methods) continue;

        const pathNode = positionalArguments(callNode)[0];
        const rawPath = pathNode ? literalString(pathNode) : null;
        if (rawPath === null) {
          if (pathNode) {
            dynamicPaths.push({
              file: fn.file,
              line: callNode.startPosition.row + 1,
              symbol: fn.name,
            });
          }
          continue;
        }

        for (const method of methods) {
          sites.push({
            routerId: router.id,
            method,
            rawPath,
            decorator: decorator,
            call: callNode,
            fn,
            file: fn.file,
          });
        }
      }
    }

    for (const dynamic of dynamicPaths) {
      unresolved.push({
        reason: "dynamic-path",
        message: "Route path is not a static string literal",
        origin: dynamic,
      });
    }

    // Reachability: DFS prefix/tag chains from every FastAPI app.
    const reachable = new Map<string, { prefix: string; tags: string[] }>();
    const appIds = [...routers.values()].filter((r) => r.kind === "app").map((r) => r.id);
    for (const appId of appIds) {
      reachable.set(appId, { prefix: "", tags: [] });
      const stack = [appId];
      while (stack.length) {
        const current = stack.pop()!;
        const currentMeta = reachable.get(current)!;
        for (const edge of edges.filter((e) => e.parent === current)) {
          const child = routers.get(edge.child);
          if (!child) continue;
          const next = {
            prefix: joinPrefix(currentMeta.prefix, edge.prefix, child.prefix),
            tags: [...new Set([...currentMeta.tags, ...edge.tags, ...child.tags])],
          };
          // Keep the shortest prefix chain if a router is mounted twice.
          const existing = reachable.get(edge.child);
          if (!existing || next.prefix.length < existing.prefix.length) {
            reachable.set(edge.child, next);
            stack.push(edge.child);
          }
        }
      }
    }

    // Orphan routers with routes are reported once.
    const orphanRouters = new Set<string>();
    const routes: RouteCandidate[] = [];

    for (const site of sites) {
      const router = routers.get(site.routerId)!;
      const chain = reachable.get(site.routerId);
      if (router.kind === "router" && !chain) {
        orphanRouters.add(site.routerId);
        continue;
      }
      const mount = chain ?? { prefix: "", tags: [] };
      const candidate = buildRoute(site, normalizePath(joinPrefix(mount.prefix, site.rawPath)), mount.tags, analysis, modelIndex, securityBindings);
      routes.push(candidate);
    }

    for (const id of orphanRouters) {
      const router = routers.get(id)!;
      unresolved.push({
        reason: "unreachable-router",
        message: `Router "${router.name}" is not included into a FastAPI app`,
        origin: { file: router.file, symbol: router.name },
      });
    }

    // Components accumulated during schema conversion.
    const components = [...modelIndex.componentsByName.values()];

    const securitySchemes = securityBindings
      .filter((binding) =>
        routes.some((route) => route.security?.some((requirement) => binding.schemeName in requirement)),
      )
      .map((binding) => ({ name: binding.schemeName, scheme: binding.scheme }));

    const servers = detectServers(analysis);

    return { routes, unresolved, components, securitySchemes, servers };
  },
};

function buildSecurityScheme(constructorName: string, call: TsNode): Record<string, unknown> {
  if (constructorName === "APIKeyHeader") {
    const name = keywordArgument(call, "name");
    return { type: "apiKey", in: "header", name: name ? literalString(name) ?? "X-API-Key" : "X-API-Key" };
  }
  if (constructorName === "APIKeyQuery") {
    const name = keywordArgument(call, "name");
    return { type: "apiKey", in: "query", name: name ? literalString(name) ?? "api_key" : "api_key" };
  }
  if (constructorName === "APIKeyCookie") {
    const name = keywordArgument(call, "name");
    return { type: "apiKey", in: "cookie", name: name ? literalString(name) ?? "session" : "session" };
  }
  if (constructorName === "HTTPBasic") return { type: "http", scheme: "basic" };
  if (constructorName === "HTTPDigest") return { type: "http", scheme: "digest" };
  return { type: "http", scheme: "bearer" };
}

function detectServers(analysis: PythonAnalysis): ExtractionResult["servers"] {
  const servers: ExtractionResult["servers"] = [];
  for (const file of analysis.files.values()) {
    for (const call of findAll(file.root, (n) => n.type === "call")) {
      const mc = methodCall(call);
      if (mc?.method !== "run") continue;
      if (mc.receiver.type !== "identifier" || mc.receiver.text !== "uvicorn") continue;
      const portNode = keywordArgument(call, "port");
      const port = portNode ? literalInteger(portNode) : null;
      const hostNode = keywordArgument(call, "host");
      const host = hostNode ? literalString(hostNode) ?? "127.0.0.1" : "127.0.0.1";
      if (port) servers.push({ url: `http://${host}:${port}` });
    }
  }
  return servers;
}

function detectSse(fn: PyFunction): boolean {
  if (!fn.body) return false;
  return findFirst(fn.body, (node) => {
    if (node.type !== "call") return false;
    const name = callName(node.namedChildren[0] ?? null);
    if (name === "EventSourceResponse") return true;
    if (name === "StreamingResponse") {
      const mediaType =
        keywordArgument(node, "media_type") ?? keywordArgument(node, "content_type");
      return mediaType?.text.includes("text/event-stream") ?? false;
    }
    return false;
  }) !== null;
}

function buildRoute(
  site: RouteSite,
  fullPath: string,
  inheritedTags: string[],
  analysis: PythonAnalysis,
  modelIndex: ModelIndex,
  securityBindings: SecurityBinding[],
): RouteCandidate {
  const { call: decoratorCall, fn, file } = site;
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const tags = new Set(inheritedTags);
  const decoratorTags = listElements(keywordArgument(decoratorCall, "tags"))
    .map((node) => literalString(node))
    .filter((value): value is string => !!value);
  for (const tag of decoratorTags) tags.add(tag);

  const origin: SourceLocation = {
    file,
    line: site.decorator.startPosition.row + 1,
    symbol: fn.name,
  };

  const placeholders = pathPlaceholders(site.rawPath);
  const placeholderNames = new Set(placeholders.map((p) => p.name));

  // Body accumulators.
  let bodyModelName: string | null = null;
  let bodyModelNode: TsNode | null = null;
  const bodyScalarFields = new Map<string, TsNode | null>();
  const formFields = new Map<string, { node: TsNode | null; kind: "form" | "file"; required: boolean }>();
  const security: Array<Record<string, string[]>> = [];

  // Expand dependency callables (Depends(CommonParams) / Depends(get_pagination)):
  // FastAPI treats each parameter of the dependency as a parameter of the route,
  // so query/header/path annotations on the dependency must surface here too.
  const expandedParams: Array<{ param: PyParam; ownerFile: string }> = [];
  const expandDependency = (
    depName: string,
    ownerFile: string,
    seen: Set<string>,
    depth: number,
  ): void => {
    if (depth > 4 || seen.has(depName)) return;
    seen.add(depName);
    const cls = analysis.classes.find(
      (candidate) => candidate.name === depName && candidate.file === ownerFile,
    ) ?? analysis.classes.find((candidate) => candidate.name === depName);
    if (cls) {
      const init = analysis.functions.find(
        (candidate) => candidate.name === "__init__" && candidate.file === cls.file,
      );
      const owner = cls.file;
      for (const depParam of init?.params ?? []) {
        if (["self", "cls"].includes(depParam.name) || depParam.kind !== "plain") continue;
        const nested = injectionKind(depParam);
        if (nested?.kind === "Depends") {
          const nestedArg = positionalArguments(nested.call)[0];
          if (nestedArg?.type === "identifier") {
            expandDependency(nestedArg.text, owner, seen, depth + 1);
          }
          continue;
        }
        expandedParams.push({ param: depParam, ownerFile: owner });
      }
      return;
    }
    const depFn =
      analysis.functions.find(
        (candidate) => candidate.name === depName && candidate.file === ownerFile,
      ) ?? analysis.functions.find((candidate) => candidate.name === depName);
    if (depFn) {
      for (const depParam of depFn.params) {
        if (["self", "cls"].includes(depParam.name) || depParam.kind !== "plain") continue;
        const nested = injectionKind(depParam);
        if (nested?.kind === "Depends") {
          const nestedArg = positionalArguments(nested.call)[0];
          if (nestedArg?.type === "identifier") {
            expandDependency(nestedArg.text, depFn.file, seen, depth + 1);
          }
          continue;
        }
        expandedParams.push({ param: depParam, ownerFile: depFn.file });
      }
    }
  };

  for (const param of fn.params) {
    if (["self", "cls"].includes(param.name) || param.kind !== "plain") continue;
    if (isRequestParam(param)) continue;

    const injection = injectionKind(param);
    const kind = injection?.kind;

    if (kind === "Depends") {
      if (!injection) continue;
      let depArg = positionalArguments(injection.call)[0];
      // Annotated[Pagination, Depends()]: the dependency is the annotated type.
      if (!depArg) {
        const inner = annotatedInnerType(param);
        if (inner?.type === "identifier") depArg = inner;
      }
      if (depArg?.type === "identifier") {
        const binding = securityBindings.find(
          (candidate) => candidate.file === file && candidate.name === depArg.text,
        );
        if (binding) security.push({ [binding.schemeName]: [] });
        expandDependency(depArg.text, file, new Set(), 0);
      }
      continue;
    }
    expandedParams.push({ param, ownerFile: file });
  }

  for (const { param, ownerFile } of expandedParams) {
    const injection = injectionKind(param);
    const kind = injection?.kind;

    if (placeholderNames.has(param.name) || kind === "Path") {
      const placeholder = placeholders.find((p) => p.name === param.name);
      const base = param.annotation
        ? annotationToSchema(param.annotation, modelIndex)
        : null;
      const schema = parameterSchema(
        base ?? PATH_CONVERTERS[placeholder?.converter ?? "str"] ?? { type: "string" },
        param,
        kind === "Path" ? injection!.call : null,
      );
      parameters.push({
        name: param.name,
        in: "path",
        required: true,
        schema,
        confidence: base ? "high" : "medium",
      });
      if (!base) gaps.add("path-param-untyped");
      continue;
    }

    if (kind === "Header") {
      const base = param.annotation ? annotationToSchema(param.annotation, modelIndex) : null;
      const schema = parameterSchema(base ?? { type: "string" }, param, injection!.call);
      parameters.push({
        name: headerName(param.name, injection!.call),
        in: "header",
        required: bindingRequired(param, injection!.call),
        schema,
        confidence: base ? "high" : "medium",
      });
      if (!base) gaps.add("header-unknown");
      continue;
    }

    if (kind === "Cookie") {
      const base = param.annotation ? annotationToSchema(param.annotation, modelIndex) : null;
      const schema = parameterSchema(base ?? { type: "string" }, param, injection!.call);
      parameters.push({
        name: injectionAlias(injection!.call) ?? param.name,
        in: "cookie",
        required: bindingRequired(param, injection!.call),
        schema,
        confidence: base ? "high" : "medium",
      });
      continue;
    }

    if (kind === "File") {
      formFields.set(param.name, {
        node: param.annotation,
        kind: "file",
        required: bindingRequired(param, injection!.call),
      });
      continue;
    }

    if (kind === "Form") {
      formFields.set(param.name, {
        node: param.annotation,
        kind: "form",
        required: bindingRequired(param, injection!.call),
      });
      continue;
    }

    // Pydantic model parameter is the JSON body.
    const innerType = (kind === "Body" ? annotatedInnerType(param) : null) ?? param.annotation;
    const annotationName =
      innerType?.type === "identifier" ? innerType.text : null;
    if (!kind && /\bUploadFile\b/.test(param.annotation?.text ?? "")) {
      formFields.set(param.name, {
        node: null,
        kind: "file",
        required: param.default === null,
      });
      continue;
    }
    if (
      !kind &&
      annotationName &&
      modelIndex.pydanticNames.has(annotationName)
    ) {
      bodyModelName = annotationName;
      bodyModelNode = innerType;
      continue;
    }

    if (kind === "Body") {
      if (
        innerType?.type === "identifier" &&
        (modelIndex.pydanticNames.has(innerType.text) ||
          modelIndex.enumNames.has(innerType.text))
      ) {
        bodyModelName = innerType.text;
        bodyModelNode = innerType;
      } else {
        bodyScalarFields.set(param.name, innerType);
      }
      continue;
    }

    if (kind === "Query" || (!kind && param.annotation)) {
      const base = param.annotation ? annotationToSchema(param.annotation, modelIndex) : null;
      const required =
        kind === "Query"
          ? bindingRequired(param, injection!.call)
          : !kind && param.default === null && !isOptional(param.annotation);
      const schema = parameterSchema(base ?? { type: "string" }, param, kind === "Query" ? injection!.call : null);
      parameters.push({
        name: injection && kind === "Query" ? injectionAlias(injection.call) ?? param.name : param.name,
        in: "query",
        required,
        schema,
        confidence: base ? "high" : "medium",
      });
      if (!base) gaps.add("query-unknown");
    }
  }

  // Deduplicate parameters (dependency expansion can restate the same query
  // or path binding); the first, usually most specific, declaration wins.
  const parameterKeys = new Set<string>();
  for (let i = parameters.length - 1; i >= 0; i--) {
    const key = `${parameters[i]!.in}:${parameters[i]!.name}`;
    if (parameterKeys.has(key)) parameters.splice(i, 1);
    else parameterKeys.add(key);
  }

  // Request body.
  let requestBody: RouteCandidate["requestBody"];
  if (formFields.size) {
    const properties: Record<string, JsonSchemaLocal> = {};
    const required: string[] = [];
    for (const [name, field] of formFields) {
      if (field.kind === "file") {
        properties[name] = { type: "string", format: "binary" };
      } else {
        properties[name] =
          (field.node && annotationToSchema(field.node, modelIndex)) ?? { type: "string" };
      }
      if (field.required) required.push(name);
    }
    requestBody = {
      required: required.length > 0,
      confidence: "high",
      content: [
        {
          mediaType: "multipart/form-data",
          schema: { type: "object", properties, ...(required.length ? { required } : {}) },
        },
      ],
    };
  } else if (bodyModelName && bodyModelNode) {
    ensureComponent(bodyModelName, modelIndex);
    const requiredBody = fn.params.some(
      (param) =>
        param.annotation?.type === "identifier" &&
        param.annotation.text === bodyModelName &&
        param.default === null,
    );
    requestBody = {
      required: requiredBody,
      confidence: "high",
      content: [
        { mediaType: "application/json", schema: { $ref: `#/components/schemas/${bodyModelName}` } },
      ],
    };
  } else if (bodyScalarFields.size) {
    const properties: Record<string, JsonSchemaLocal> = {};
    for (const [name, annotation] of bodyScalarFields) {
      const schema = annotation ? annotationToSchema(annotation, modelIndex) : null;
      properties[name] = schema ?? {};
      if (!schema) gaps.add("body-schema-unknown");
    }
    requestBody = {
      required: true,
      confidence: bodyScalarFields.size && !gaps.has("body-schema-unknown") ? "high" : "medium",
      content: [{ mediaType: "application/json", schema: { type: "object", properties } }],
    };
  }

  // Responses.
  const responses = buildResponses(site, modelIndex, gaps, analysis);

  const confidence: Confidence = gaps.size ? "medium" : "high";

  return {
    method: site.method,
    path: normalizePath(site.rawPath),
    fullPath,
    operationId: operationId(site.method, fullPath),
    origin,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [...tags],
    ...(security.length ? { security } : {}),
    confidence,
    gaps: [...gaps],
    components: [],
    handlerSource: boundedSource(fn.decorated ?? fn.node),
    ...(responses.some((r) => r.content?.some((m) => m.mediaType === "text/event-stream"))
      ? { extensions: { "x-protocol": "sse" } }
      : {}),
  };
}

function isOptional(annotation: TsNode | null): boolean {
  if (!annotation) return false;
  if (annotation.type === "binary_operator") return annotation.text.includes("None");
  if (annotation.type === "generic_type") {
    return annotation.namedChildren[0]?.text.split(".").pop() === "Optional";
  }
  return false;
}

function boundedSource(node: TsNode): string {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n# ... truncated` : text;
}

const STRING_SUFFIX_PROPERTIES = new Set([
  "filename", "name", "url", "uri", "path", "key", "token", "content_type",
  "contentType", "caption", "title", "idempotency_key",
]);
const INTEGER_SUFFIX_PROPERTIES = new Set(["size", "count", "total", "length"]);

/** Infer the schema of a dict/list value expression returned by a handler. */
function responseValueSchema(
  node: TsNode,
  fn: PyFunction,
  modelIndex: ModelIndex,
  depth = 0,
): JsonSchemaLocal | null {
  if (!node || depth > 6) return {};
  const literal = literalToSchema(node, depth + 1);
  // An empty {} carries no evidence; fall through to identifier/attribute
  // inference instead of accepting it as a concrete schema.
  if (literal && Object.keys(literal).length > 0 && !isLooseLiteralSchema(literal)) {
    return literal;
  }

  if (node.type === "identifier") {
    const param = fn.params.find((candidate) => candidate.name === node.text);
    if (param?.annotation) {
      return annotationToSchema(param.annotation, modelIndex) ?? {};
    }
    return {};
  }

  if (node.type === "attribute") {
    const prop = node.namedChildren[1]?.text ?? "";
    if (STRING_SUFFIX_PROPERTIES.has(prop)) return { type: "string" };
    if (INTEGER_SUFFIX_PROPERTIES.has(prop)) return { type: "integer" };
    return {};
  }

  if (node.type === "call") {
    const name = callName(node.namedChildren[0] ?? null);
    const short = name?.split(".").pop();
    if (short && (modelIndex.pydanticNames.has(short) || modelIndex.enumNames.has(short))) {
      ensureComponent(short, modelIndex);
      return { $ref: `#/components/schemas/${short}` };
    }
    return {};
  }

  if (node.type === "dictionary") {
    const properties: Record<string, JsonSchemaLocal> = {};
    for (const pair of childrenOfType(node, "pair")) {
      const [key, value] = pair.namedChildren;
      const keyText = key ? literalString(key) : null;
      if (!keyText || !value) continue;
      properties[keyText] = responseValueSchema(value, fn, modelIndex, depth + 1) ?? {};
    }
    return { type: "object", properties };
  }

  if (node.type === "list") {
    const first = node.namedChildren[0];
    return {
      type: "array",
      items: first ? responseValueSchema(first, fn, modelIndex, depth + 1) ?? {} : {},
    };
  }

  return literal ?? {};
}

/** Dict/list literal response, enriched with handler parameter evidence. */
function responseLiteralSchema(
  node: TsNode,
  fn: PyFunction,
  modelIndex: ModelIndex,
): JsonSchemaLocal {
  return responseValueSchema(node, fn, modelIndex) ?? {};
}

function buildResponses(
  site: RouteSite,
  modelIndex: ModelIndex,
  gaps: Set<string>,
  _analysis: PythonAnalysis,
): RouteCandidate["responses"] {
  const responses: RouteCandidate["responses"] = [];
  const { call: decoratorCall, fn } = site;
  const statusNode = keywordArgument(decoratorCall, "status_code");
  const successStatus = statusNode ? String(literalInteger(statusNode) ?? 200) : "200";

  // 204 No Content: explicitly empty success response.
  if (successStatus === "204") {
    responses.push({
      statusCode: "204",
      description: "No Content",
      confidence: "high",
      content: [],
    });
  }

  // SSE first: streaming responses never carry a JSON body schema.
  if (detectSse(fn)) {
    if (!responses.some((r) => r.statusCode === successStatus)) {
      responses.push({
        statusCode: successStatus,
        description: "Server-Sent Events stream",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: {}, confidence: "medium" }],
      });
    }
    gaps.add("sse-events-unknown");
    return responses;
  }

  const responseModelNode = keywordArgument(decoratorCall, "response_model");
  let successSchema = successStatus === "204"
    ? null
    : responseModelNode
      ? annotationToSchema(responseModelNode, modelIndex)
      : fn.returnType
        ? annotationToSchema(fn.returnType, modelIndex)
        : null;

  if (!successSchema && fn.body && successStatus !== "204") {
    const returned = findFirst(fn.body, (node) => node.type === "return_statement");
    const value = returned?.namedChildren[0];
    if (value) {
      if (value.type === "call") {
        const name = callName(value.namedChildren[0] ?? null);
        if (name && /Response$/.test(name) && name !== "Response") {
          // Typed response wrappers carry no inspectable body here.
          successSchema = null;
        }
      }
      if (!successSchema && (value.type === "dictionary" || value.type === "list")) {
        const literal = responseLiteralSchema(value, fn, modelIndex);
        if (literal) {
          successSchema = literal;
          if (isLooseLiteralSchema(literal)) gaps.add("response-schema-unknown");
        }
      }
    }
  }

  if (successSchema) {
    responses.push({
      statusCode: successStatus,
      description: "",
      confidence: "high",
      content: [{ mediaType: "application/json", schema: successSchema }],
    });
  } else if (successStatus !== "204") {
    gaps.add("response-unknown");
  }

  // raise HTTPException(status_code=404, detail="...") proves error responses.
  for (const raiseNode of findAll(fn.node, (n) => n.type === "raise_statement")) {
    const excCall = findFirst(raiseNode, (n) => n.type === "call");
    if (!excCall) continue;
    const excName = callName(excCall.namedChildren[0] ?? null);
    if (excName !== "HTTPException") continue;
    const statusKw = keywordArgument(excCall, "status_code");
    const statusNode = statusKw ?? positionalArguments(excCall)[0] ?? null;
    const status = statusNode ? literalInteger(statusNode) : null;
    if (!status || status < 400) continue;
    const statusKey = String(status);
    if (responses.some((r) => r.statusCode === statusKey)) continue;
    const detailNode = keywordArgument(excCall, "detail");
    const detailSchema = detailNode ? literalErrorSchema(detailNode) : null;
    responses.push({
      statusCode: statusKey,
      description: "",
      confidence: "high",
      content: [
        {
          mediaType: "application/json",
          schema: detailSchema ?? {
            type: "object",
            properties: { detail: {} },
            required: ["detail"],
          },
        },
      ],
    });
  }

  // Explicit responses={404: {"model": Error}} mapping.
  const responsesKw = keywordArgument(decoratorCall, "responses");
  if (responsesKw?.type === "dictionary") {
    for (const pair of childrenOfType(responsesKw, "pair")) {
      const [statusKey, statusValue] = pair.namedChildren;
      const status = statusKey ? String(literalInteger(statusKey) ?? literalString(statusKey) ?? "") : "";
      if (!status || status === successStatus) continue;
      const modelPair = statusValue
        ? childrenOfType(statusValue, "pair").find((candidate) => {
            const key = candidate.namedChildren[0];
            return key && literalString(key) === "model";
          })
        : null;
      const modelNode = modelPair?.namedChildren[1] ?? null;
      const schema = modelNode ? annotationToSchema(modelNode, modelIndex) : null;
      if (schema && !responses.some((r) => r.statusCode === status)) {
        responses.push({
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema }],
        });
      }
    }
  }

  return responses;
}

function literalErrorSchema(detailNode: TsNode): Record<string, unknown> | null {
  if (detailNode.type === "string" || detailNode.type === "string_start") {
    return {
      type: "object",
      properties: { detail: { type: "string" } },
      required: ["detail"],
    };
  }
  if (detailNode.type === "integer") {
    return {
      type: "object",
      properties: { detail: { type: "integer" } },
      required: ["detail"],
    };
  }
  return null;
}
