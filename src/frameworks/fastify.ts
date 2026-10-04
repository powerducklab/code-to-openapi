import type {
  Confidence,
  DiscoveredMediaType,
  DiscoveredResponse,
  DiscoveredSecurityScheme,
  DiscoveredServer,
  DiscoveredUnresolved,
  FrameworkPack,
  GapCode,
  JsonSchema,
  RouteCandidate,
  RouteParameter,
  ScanContext,
  SourceLocation,
} from "../core/types.js";
import { dirname, isAbsolute, join, sep } from "node:path";

import type { TsAnalysis } from "../lang/typescript/index.js";
import { convertFluentNode } from "../lang/typescript/fluentSchema.js";
import { typeToSchema } from "../lang/typescript/typeSchema.js";
import {
  findExportedDeclaration,
  resolveHandler,
  resolveImportedFile,
} from "./express-handler.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);

interface RouteSite {
  instance: string;
  method: string;
  /** Raw URL argument node; resolved per scope to support prefix concatenation. */
  urlNode: any | null;
  /** Native JSON Schema node from route options (`schema`), when present. */
  schemaNode: any | null;
  /** Route generic `app.get<{ Params; Querystring; Body; Headers }>`, when present. */
  genericNode: any | null;
  /** Full route options text, used for auth hint matching. */
  optionsText: string;
  handler: any | null;
  /** Name of a local handler factory call, e.g. `callback("google")`. */
  handlerFactoryName: string | null;
  origin: SourceLocation;
}

interface RegisterEdge {
  parent: string;
  /** Local plugin identifier, when the plugin is imported/defined by name. */
  pluginName: string | null;
  /** Factory call whose callee name returns a plugin (e.g. `routes(deps)`). */
  pluginCallName: string | null;
  /** Direct `require("spec")` target, when the plugin is required inline. */
  pluginSpecifier: string | null;
  /** Inline require() of an external package (middleware): no project routes. */
  externalSpecifier?: string;
  /** Inline plugin function/arrow node, when registered directly. */
  inlineNode: any | null;
  prefix: string;
  /** @fastify/autoload registration, when the target resolves to that package. */
  autoload?: {
    dirNode: any;
    optionsNode: any;
    dirNameRoutePrefix: boolean;
    encapsulate: boolean;
    routeParams: boolean;
    unsupported: string[];
  };
}

interface FileModel {
  rel: string;
  source: any;
  /** Local binding name of the fastify default import/factory. */
  factoryBindings: Set<string>;
  /** Root instance variable names (Fastify() call). */
  roots: Set<string>;
  moduleBindings: Map<string, { specifier: string; exportName: string }>;
  /** Bindings imported from external packages (middleware plugins, etc.). */
  externalBindings: Set<string>;
  /** Local binding name -> module specifier (covers ESM imports and CJS requires). */
  bindingSpecifiers: Map<string, string>;
  routes: RouteSite[];
  edges: RegisterEdge[];
  listenPorts: number[];
}

function joinPrefix(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  // OAS paths are absolute: a route mounted at the application root must be
  // "/", never an empty string (which would be rejected by the OAS validator).
  return joined ? `/${joined}` : "/";
}

/**
 * Fastify path templates use `:param` and a trailing `*` wildcard. Named
 * wildcards (`*splat`) are not valid in v4; normalize both to OAS `{...}`.
 */
function normalizeFastifyPath(raw: string): { path: string; dynamic: boolean } {
  if (raw.includes("(.*)") || /[\^$]/.test(raw)) return { path: raw, dynamic: true };
  const path = raw
    .replace(/:([A-Za-z0-9_]+)\??/g, "{**$1}")
    .replace(/\{\*\*([A-Za-z0-9_]+)\}/g, "{$1}")
    .replace(/\*+[A-Za-z0-9_]*/g, "{wildcard}");
  return { path, dynamic: false };
}

function operationId(method: string, fullPath: string): string {
  const segments = fullPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/[{}]/g, ""))
    .map((segment) => segment.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()));
  const tail = segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${method.toLowerCase()}${tail}` || `${method.toLowerCase()}Root`;
}

function tagForPath(fullPath: string, file: string): string[] {
  const segment = fullPath.split("/").filter(Boolean)[0];
  if (segment && !segment.startsWith("{")) return [segment];
  const base = file.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "default";
  return [base === "index" ? "default" : base];
}

/**
 * Route URLs in real Fastify apps are frequently built from a runtime mount
 * prefix, e.g. `options.prefix + "users/login"` or
 * `` `${options.prefix}users` ``. The prefix operand is recognized
 * structurally (any `<obj>.prefix` access) so the static suffix can still be
 * extracted; the caller reports an honest gap when the prefix value is unknown.
 */
interface RouteUrlResolution {
  /** Concatenated static text, with the runtime prefix operand removed. */
  url: string;
  /** True when a runtime `<obj>.prefix` operand was present. */
  runtimePrefix: boolean;
  /** True when the URL cannot be reduced to static text at all. */
  fullyDynamic: boolean;
}

/** Sentinel alias value for a destructured runtime `prefix` binding. */
const RUNTIME_PREFIX_MARKER = { __runtimePrefix: true } as const;

function resolveRouteUrl(
  ts: any,
  node: any,
  resolveAlias?: (id: any) => any,
): RouteUrlResolution | null {
  if (!node) return null;
  // Follow local const aliases such as `const prefix = options.prefix || ""`.
  const deref = (n: any, guard = 0): any => {
    let cur = n;
    while (ts.isIdentifier(cur) && resolveAlias && guard < 8) {
      const aliased = resolveAlias(cur);
      if (!aliased || aliased === cur) break;
      cur = aliased;
      guard += 1;
    }
    return cur;
  };
  node = deref(node);
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { url: node.text, runtimePrefix: false, fullyDynamic: false };
  }

  const isPrefixAccess = (n: any): boolean => {
    if (n === RUNTIME_PREFIX_MARKER) return true;
    const d = deref(n);
    if (d === RUNTIME_PREFIX_MARKER) return true;
    return ts.isPropertyAccessExpression(d) && d.name.text === "prefix";
  };

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts: string[] = [];
    let runtimePrefix = false;
    const gather = (raw: any): boolean => {
      const n = deref(raw);
      if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        parts.push(n.text);
        return true;
      }
      if (isPrefixAccess(n)) {
        runtimePrefix = true;
        return true;
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        return gather(n.left) && gather(n.right);
      }
      if (ts.isTemplateExpression(n)) return fromTemplate(n);
      return false;
    };
    const fromTemplate = (tpl: any): boolean => {
      parts.push(tpl.head.text);
      for (const span of tpl.templateSpans) {
        const expr = deref(span.expression);
        if (!isPrefixAccess(expr)) return false;
        runtimePrefix = true;
        parts.push(span.literal.text);
      }
      return true;
    };
    if (!gather(node)) return { url: "", runtimePrefix: false, fullyDynamic: true };
    return { url: parts.join(""), runtimePrefix, fullyDynamic: false };
  }

  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text];
    let runtimePrefix = false;
    for (const span of node.templateSpans) {
      const expr = deref(span.expression);
      if (!isPrefixAccess(expr)) {
        return { url: "", runtimePrefix: false, fullyDynamic: true };
      }
      runtimePrefix = true;
      parts.push(span.literal.text);
    }
    return { url: parts.join(""), runtimePrefix, fullyDynamic: false };
  }

  return null;
}

/**
 * Collects local const aliases for route URL construction inside a plugin
 * scope, e.g. `const prefix = options.prefix || ""` or
 * `const { prefix } = options`. Nested function bodies are skipped.
 */
function collectPrefixAliases(ts: any, scopeNode: any): Map<string, any> {
  const aliases = new Map<string, any>();
  if (!scopeNode) return aliases;
  const consider = (decl: any) => {
    if (
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      decl.initializer
    ) {
      const init = decl.initializer;
      if (ts.isStringLiteralLike(init)) {
        aliases.set(decl.name.text, init);
      } else if (ts.isPropertyAccessExpression(init) && init.name.text === "prefix") {
        aliases.set(decl.name.text, init);
      } else if (
        ts.isBinaryExpression(init) &&
        (init.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
        ts.isPropertyAccessExpression(init.left) &&
        init.left.name.text === "prefix"
      ) {
        aliases.set(decl.name.text, init.left);
      }
    }
    // Destructuring: `const { prefix } = options`.
    if (
      ts.isVariableDeclaration(decl) &&
      ts.isObjectBindingPattern(decl.name) &&
      ts.isIdentifier(decl.initializer)
    ) {
      for (const element of decl.name.elements) {
        if (
          ts.isBindingElement(element) &&
          !element.propertyName &&
          ts.isIdentifier(element.name) &&
          element.name.text === "prefix"
        ) {
          aliases.set("prefix", RUNTIME_PREFIX_MARKER);
        }
      }
    }
  };
  const walk = (n: any, isRoot: boolean) => {
    if (
      !isRoot &&
      (ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return;
    }
    consider(n);
    ts.forEachChild(n, (child: any) => walk(child, false));
  };
  walk(scopeNode, true);
  return aliases;
}

/**
 * Detects a fluent-json-schema builder chain (S.object()..., S.oneOf([...]),
 * S.ref("..."), S.raw({...})). The base identifier name is irrelevant; plain
 * JavaScript projects import it under any name.
 */
function isFluentSchemaNode(ts: any, node: any): boolean {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  let cur: any = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    cur = cur.expression.expression;
  }
  if (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    ["oneOf", "anyOf", "allOf", "ref", "raw", "not"].includes(cur.expression.name.text)
  ) {
    return true;
  }
  // The innermost call must be a known type constructor.
  let inner: any = node;
  while (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    ts.isCallExpression(inner.expression.expression)
  ) {
    inner = inner.expression.expression;
  }
  if (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    [
      "object",
      "string",
      "number",
      "integer",
      "boolean",
      "array",
      "null",
    ].includes(inner.expression.name.text)
  ) {
    return true;
  }
  return false;
}

/**
 * Converts a schema-valued AST node (fluent builder, plain JSON literal, or a
 * mix of both) into a JSON Schema object. Returns undefined when the node does
 * not describe a schema.
 */
function schemaValueToJson(ts: any, node: any, depth = 0): JsonSchema | undefined {
  if (!node || depth > 12) return undefined;
  if (isFluentSchemaNode(ts, node)) {
    const schema = convertFluentNode(node, { ts, depth });
    if (schema) delete (schema as Record<string, unknown>).$schema;
    return schema ?? undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name?.getText?.().replace(/^['"]|['"]$/g, "");
      if (!name) continue;
      const value = schemaValueToJson(ts, prop.initializer, depth + 1);
      if (value !== undefined) out[name] = value;
    }
    return out as JsonSchema;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const members = node.elements
      .map((el: any) => schemaValueToJson(ts, el, depth + 1))
      .filter((s: JsonSchema | undefined): s is JsonSchema => s !== undefined);
    return members as unknown as JsonSchema;
  }
  const value = literalValue(ts, node);
  // Primitive leaves (type names, enum values, required arrays' strings) are
  // valid schema fragments; only unresolvable identifiers and calls drop out.
  if (value !== undefined) return value as unknown as JsonSchema;
  return undefined;
}

/**
 * Mirrors @fastify/autoload's underscore route parameter conversion:
 * directory segment `_id` becomes `:id`, `__id` becomes `:id`.
 */
function autoloadSegmentToPath(segment: string): string {
  if (segment.includes("__")) return segment.replace(/__/g, ":");
  if (segment.startsWith("_")) return `:${segment.slice(1)}`;
  return segment;
}

const AUTOLOAD_INDEX_PATTERN = /^index(?:\.ts|\.js|\.cjs|\.mjs|\.cts|\.mts)$/;
const AUTOLOAD_SCRIPT_PATTERN = /\.(?:ts|js|cjs|mjs|cts|mts)$/;

/**
 * Returns the module specifier of a register() target, resolving local
 * bindings and direct `require("...")` calls.
 */
function targetSpecifierOf(ts: any, model: FileModel, target: any): string | null {
  if (!target) return null;
  if (
    ts.isCallExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "require" &&
    ts.isStringLiteralLike(target.arguments[0])
  ) {
    return target.arguments[0].text;
  }
  if (ts.isIdentifier(target)) return model.bindingSpecifiers.get(target.text) ?? null;
  return null;
}

/** Resolves an autoload `dir` option to an absolute filesystem path. */
function resolveAutoloadDir(ts: any, sourceFile: any, dirNode: any): string | null {
  if (!dirNode) return null;
  const sourceDir = dirname(sourceFile.fileName);
  if (ts.isStringLiteralLike(dirNode)) {
    return isAbsolute(dirNode.text) ? dirNode.text : join(sourceDir, dirNode.text);
  }
  // path.join(__dirname, "routes", ...) / path.resolve(__dirname, ...),
  // including `require("path").join(...)`.
  const segments: string[] = [];
  const collect = (n: any): boolean => {
    if (n && ts.isIdentifier(n) && n.text === "__dirname") return true;
    if (n && (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n))) {
      segments.push(n.text);
      return true;
    }
    return false;
  };
  const isJoinResolveCall = (node: any): boolean => {
    if (!ts.isCallExpression(node)) return false;
    if (ts.isPropertyAccessExpression(node.expression)) {
      return ["join", "resolve"].includes(node.expression.name.text);
    }
    // A bare `join(...)` / `resolve(...)` imported from "node:path" / "path".
    return (
      ts.isIdentifier(node.expression) &&
      ["join", "resolve"].includes(node.expression.text)
    );
  };
  if (isJoinResolveCall(dirNode)) {
    for (const arg of dirNode.arguments) {
      if (!collect(arg)) return null;
    }
    return join(sourceDir, ...segments);
  }
  // fileURLToPath(new URL("./routes", import.meta.url))
  if (
    ts.isCallExpression(dirNode) &&
    ts.isIdentifier(dirNode.expression) &&
    dirNode.expression.text === "fileURLToPath"
  ) {
    const urlArg = dirNode.arguments[0];
    if (
      urlArg &&
      ts.isNewExpression(urlArg) &&
      ts.isIdentifier(urlArg.expression) &&
      urlArg.expression.text === "URL"
    ) {
      const rel = urlArg.arguments?.[0];
      if (rel && ts.isStringLiteralLike(rel)) {
        return join(sourceDir, rel.text);
      }
    }
  }
  // __dirname + "/routes"
  if (
    ts.isBinaryExpression(dirNode) &&
    dirNode.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const literals: string[] = [];
    let ok = true;
    const walk = (n: any) => {
      if (ts.isIdentifier(n) && n.text === "__dirname") return;
      if (ts.isStringLiteralLike(n)) {
        literals.push(n.text);
        return;
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        walk(n.left);
        walk(n.right);
        return;
      }
      ok = false;
    };
    walk(dirNode);
    return ok ? join(sourceDir, ...literals) : null;
  }
  return null;
}

function literalValue(ts: any, node: any, depth = 0): unknown {
  if (!node || depth > 14) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el: any) => literalValue(ts, el, depth + 1));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText ? prop.name.getText().replace(/^['"]|['"]$/g, "") : undefined;
        if (name) out[name] = literalValue(ts, prop.initializer, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

export const fastifyPack: FrameworkPack<TsAnalysis> = {
  id: "fastify",
  language: "typescript",
  dependencyHints: ["fastify"],

  applies(ctx) {
    // NestJS may use Fastify only as its transport (@nestjs/platform-fastify);
    // the Nest pack is authoritative in that case.
    if (
      ctx.manifest.packages.has("@nestjs/common") ||
      ctx.manifest.packages.has("@nestjs/core")
    ) {
      return false;
    }
    return (
      ctx.manifest.packages.has("fastify") ||
      ctx.index.files.some((f) =>
        /require\(["']fastify["']\)|from ["']fastify["']/.test(f.content),
      )
    );
  },

  extract(analysis, ctx) {
    const { ts } = analysis;
    const models = new Map<string, FileModel>();
    for (const [rel, source] of analysis.sourceByPath) {
      models.set(rel, modelFile(analysis, rel, source));
    }

    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const servers: DiscoveredServer[] = [];
    let bearerAuth = false;
    // De-duplicates runtime-prefix gaps (one per autoloaded scope, not per route).
    const reportedPrefixGaps = new Set<string>();

    // Resolve a plugin identifier (imported or local function) to the function
    // node and the file it lives in.
    const resolvePlugin = (
      model: FileModel,
      name: string,
    ): { file: any; node: any; instanceParam: string } | null => {
      // Local function/arrow in the same file.
      let local: any = null;
      model.source.forEachChild((child: any) => {
        if (local) return;
        if (ts.isFunctionDeclaration(child) && child.name?.text === name) local = child;
        if (ts.isVariableStatement(child)) {
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === name &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              local = decl.initializer;
            }
          }
        }
      });
      if (local) {
        const param = local.parameters?.[0]?.name?.getText?.(model.source);
        return param ? { file: model.source, node: local, instanceParam: param } : null;
      }

      const binding = model.moduleBindings.get(name);
      if (!binding) return null;
      const imported = resolveImportedFile(analysis, model.source, name);
      if (!imported) return null;

      // Resolve a plugin export to its function node, following `export *`
      // barrels and `fastifyPlugin(fn)` wrapper calls.
      const resolveExport = (
        sf: any,
        exportName: string,
        seen: Set<string>,
      ): { file: any; node: any } | null => {
        const direct0 = findExportedDeclaration(analysis, sf, exportName, new Set());
        let direct = direct0;
        // `export default usersPlugin` resolves to the local binding name.
        if (direct && ts.isIdentifier(direct.node)) {
          const local = findExportedDeclaration(analysis, sf, direct.node.text, new Set());
          if (local) direct = local;
        }
        if (direct) return direct;
        if (seen.has(sf.fileName)) return null;
        seen.add(sf.fileName);

        // Unwrap a function node or a `fastifyPlugin(fn)` wrapper call.
        const unwrap = (node: any, ownerFile: any): { file: any; node: any } | null => {
          if (
            ts.isArrowFunction(node) ||
            ts.isFunctionExpression(node) ||
            ts.isFunctionDeclaration(node)
          ) {
            return { file: ownerFile, node };
          }
          if (ts.isCallExpression(node)) {
            const arg = node.arguments[0];
            if (
              arg &&
              (ts.isArrowFunction(arg) ||
                ts.isFunctionExpression(arg) ||
                ts.isFunctionDeclaration(arg))
            ) {
              return { file: ownerFile, node: arg };
            }
            if (arg && ts.isIdentifier(arg)) {
              // Fresh seen set: the owner file itself must remain searchable.
              const inner = findExportedDeclaration(analysis, ownerFile, arg.text, new Set());
              if (inner) return inner;
            }
          }
          return null;
        };

        // Raw binding with any initializer (e.g. wrapper calls).
        let raw: any = null;
        sf.forEachChild((child: any) => {
          if (raw) return;
          if (ts.isExportAssignment(child)) {
            if (
              ts.isArrowFunction(child.expression) ||
              ts.isFunctionExpression(child.expression)
            ) {
              raw = child.expression;
              return;
            }
            if (ts.isIdentifier(child.expression) && exportName === "default") {
              const local = findExportedDeclaration(analysis, sf, child.expression.text, new Set());
              if (local) raw = local.node;
            }
          }
          // CommonJS: `module.exports = fn | fp(fn) | ident`.
          if (
            (exportName === "module" || exportName === "default") &&
            ts.isExpressionStatement(child) &&
            ts.isBinaryExpression(child.expression) &&
            child.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(child.expression.left) &&
            child.expression.left.expression.getText(sf) === "module" &&
            child.expression.left.name.text === "exports"
          ) {
            raw = child.expression.right;
          }
          if (!ts.isVariableStatement(child)) return;
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === exportName &&
              decl.initializer
            ) {
              raw = decl.initializer;
            }
          }
        });
        if (raw) {
          const unwrapped = unwrap(raw, sf);
          if (unwrapped) return unwrapped;
          // `module.exports = fp(plugin)` with a local function identifier.
          if (ts.isIdentifier(raw)) {
            let localFn: any = null;
            const walk = (n: any) => {
              if (localFn) return;
              if (ts.isFunctionDeclaration(n) && n.name?.text === raw.text) {
                localFn = n;
                return;
              }
              if (
                ts.isVariableDeclaration(n) &&
                ts.isIdentifier(n.name) &&
                n.name.text === raw.text &&
                n.initializer &&
                (ts.isArrowFunction(n.initializer) ||
                  ts.isFunctionExpression(n.initializer))
              ) {
                localFn = n.initializer;
                return;
              }
              ts.forEachChild(n, walk);
            };
            sf.forEachChild((c: any) => walk(c));
            if (localFn) return { file: sf, node: localFn };
          }
        }

        // Follow named and wildcard re-exports.
        const candidates: { spec: string; orig: string }[] = [];
        sf.forEachChild((child: any) => {
          if (!ts.isExportDeclaration(child) || !child.moduleSpecifier) return;
          if (!ts.isStringLiteral(child.moduleSpecifier)) return;
          if (!child.exportClause) {
            candidates.push({ spec: child.moduleSpecifier.text, orig: exportName });
            return;
          }
          if (ts.isNamedExports(child.exportClause)) {
            for (const el of child.exportClause.elements) {
              const publicName = el.propertyName?.text ?? el.name.text;
              if (publicName === exportName) {
                candidates.push({ spec: child.moduleSpecifier.text, orig: el.name.text });
              }
            }
          }
        });
        for (const candidate of candidates) {
          const resolvedName = ts.resolveModuleName
            ? ts.resolveModuleName(
                candidate.spec,
                sf.fileName,
                analysis.program.getCompilerOptions(),
                ts.sys,
              )?.resolvedModule?.resolvedFileName
            : undefined;
          if (!resolvedName || !analysis.isProjectFile(resolvedName)) continue;
          const target = analysis.program.getSourceFile(resolvedName);
          if (!target) continue;
          const nested = resolveExport(target, candidate.orig, seen);
          if (nested) return nested;
        }
        return null;
      };

      const resolvedExport = resolveExport(imported.file, imported.exportName, new Set());
      const target = resolvedExport?.node;
      if (
        !target ||
        !(
          ts.isFunctionDeclaration(target) ||
          ts.isArrowFunction(target) ||
          ts.isFunctionExpression(target)
        )
      ) {
        return null;
      }
      const param = target.parameters?.[0]?.name?.getText?.(resolvedExport.file);
      return param
        ? { file: resolvedExport.file, node: target, instanceParam: param }
        : null;
    };

    // Resolves a relative module specifier (inline `require("./routes")`) to a
    // project source file. External packages never resolve here.
    const resolveSpecifierFile = (model: FileModel, specifier: string): any | null => {
      if (!specifier.startsWith(".")) return null;
      const resolved = ts.resolveModuleName
        ? ts.resolveModuleName(
            specifier,
            model.source.fileName,
            analysis.program.getCompilerOptions(),
            ts.sys,
          )?.resolvedModule?.resolvedFileName
        : undefined;
      if (!resolved || !analysis.isProjectFile(resolved)) return null;
      return analysis.program.getSourceFile(resolved);
    };

    // Locate a function-like binding by name in a model's file or an imported
    // module. Returns the raw function node (factory or plugin alike).
    const locateFunction = (
      model: FileModel,
      name: string,
    ): { file: any; node: any } | null => {
      let local: any = null;
      model.source.forEachChild((child: any) => {
        if (local) return;
        if (ts.isFunctionDeclaration(child) && child.name?.text === name) local = child;
        if (ts.isVariableStatement(child)) {
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === name &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              local = decl.initializer;
            }
          }
        }
      });
      if (local) return { file: model.source, node: local };

      if (!model.moduleBindings.has(name)) return null;
      const imported = resolveImportedFile(analysis, model.source, name);
      if (!imported) return null;
      const { file, exportName } = imported;
      let target: any = null;
      file.forEachChild((child: any) => {
        if (target) return;
        if (
          (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) &&
          (exportName === "default" || child.name?.text === exportName)
        ) {
          target = child;
        }
        if (ts.isVariableStatement(child)) {
          for (const decl of child.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.name.text === exportName &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              target = decl.initializer;
            }
          }
        }
        if (ts.isExportAssignment(child)) {
          if (
            ts.isArrowFunction(child.expression) ||
            ts.isFunctionExpression(child.expression)
          ) {
            target = child.expression;
          } else if (ts.isIdentifier(child.expression)) {
            const ownerRel = relOfSource(file, models);
            const owner = ownerRel ? models.get(ownerRel) : undefined;
            const nested = owner ? locateFunction(owner, child.expression.text) : null;
            if (nested) target = nested.node;
          }
        }
      });
      return target ? { file, node: target } : null;
    };

    /**
     * Resolve a plugin factory call (`app.register(buildRoutes(deps))`): the
     * named function returns the plugin function/arrow; the plugin's first
     * parameter is the Fastify instance.
     */
    const resolveReturnedPlugin = (
      model: FileModel,
      name: string,
    ): { file: any; node: any; instanceParam: string } | null => {
      const factory = locateFunction(model, name);
      if (!factory) return null;
      const { file, node: factoryNode } = factory;
      let plugin: any = null;

      // Concise arrow whose body is the plugin itself: `(deps) => async (app) => {}`
      if (
        ts.isArrowFunction(factoryNode) &&
        factoryNode.body &&
        !ts.isBlock(factoryNode.body) &&
        (ts.isArrowFunction(factoryNode.body) || ts.isFunctionExpression(factoryNode.body))
      ) {
        plugin = factoryNode.body;
      } else if (factoryNode.body) {
        const visit = (n: any) => {
          if (plugin) return;
          if (
            ts.isReturnStatement(n) &&
            n.expression &&
            (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))
          ) {
            plugin = n.expression;
            return;
          }
          ts.forEachChild(n, visit);
        };
        visit(factoryNode.body);
      }
      if (!plugin) return null;
      const param = plugin.parameters?.[0]?.name?.getText?.(file);
      return param ? { file, node: plugin, instanceParam: param } : null;
    };

    const visitedScopes = new Set<string>();

    /**
     * Statically resolves an autoload `options` object's `prefix` field.
     * Returns "" when no options/prefix exist, a literal prefix when known,
     * and null when it is computed at runtime (config objects, parameters).
     */
    const resolveOptionsPrefix = (
      model: FileModel,
      optionsNode: any,
    ): string | null => {
      if (!optionsNode) return "";
      const { ts } = analysis;
      const prefixOf = (obj: any): string | null => {
        if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
        const prop = obj.properties.find(
          (p: any) =>
            ts.isPropertyAssignment(p) &&
            p.name?.getText?.(model.source).replace(/['"]/g, "") === "prefix",
        );
        if (!prop) return "";
        const value = literalValue(ts, prop.initializer);
        return typeof value === "string" ? value : null;
      };
      if (ts.isObjectLiteralExpression(optionsNode)) return prefixOf(optionsNode);
      if (!ts.isIdentifier(optionsNode)) return null;

      // Same-file const object literal.
      let found: any = null;
      const findLocal = (n: any) => {
        if (found) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === optionsNode.text &&
          n.initializer
        ) {
          found = n.initializer;
        }
        ts.forEachChild(n, findLocal);
      };
      model.source.forEachChild((c: any) => findLocal(c));
      if (found) {
        if (ts.isObjectLiteralExpression(found)) return prefixOf(found);
        return null; // function call / parameter: runtime
      }

      // Imported or required config module.
      const imported = resolveImportedFile(analysis, model.source, optionsNode.text);
      if (imported) {
        const { file } = imported;
        let obj: any = null;
        file.forEachChild((child: any) => {
          if (obj) return;
          if (
            ts.isExpressionStatement(child) &&
            ts.isBinaryExpression(child.expression) &&
            ts.isPropertyAccessExpression(child.expression.left) &&
            child.expression.left.expression.getText(file) === "module" &&
            child.expression.left.name.text === "exports"
          ) {
            if (ts.isObjectLiteralExpression(child.expression.right)) obj = child.expression.right;
          }
          if (ts.isVariableStatement(child)) {
            for (const decl of child.declarationList.declarations) {
              if (
                ts.isIdentifier(decl.name) &&
                decl.name.text === optionsNode.text &&
                ts.isObjectLiteralExpression(decl.initializer)
              ) {
                obj = decl.initializer;
              }
            }
          }
        });
        if (obj) return prefixOf(obj);
        // The options come from another module whose shape we cannot prove;
        // a prefix could be set there, so stay unresolved.
        return null;
      }
      // The identifier is neither a local object nor an import: it is the
      // enclosing plugin's forwarded options parameter (the fastify-generator
      // `options: opts` pattern). With no provable `prefix`, Fastify applies
      // no extra options prefix, so treat it as the empty default rather than
      // flagging a runtime prefix we have no evidence for.
      return "";
    };

    /**
     * Expands an @fastify/autoload registration: enumerates indexed plugin
     * files exactly as autoload would (index.js wins over sibling files,
     * directory name prefixing honors dirNameRoutePrefix) and processes each
     * resolved plugin scope. Non-plugin modules (e.g. schema.js) are skipped,
     * mirroring autoload's own behavior.
     */
    const expandAutoload = (
      model: FileModel,
      edge: RegisterEdge,
      parentPrefix: string,
      depth: number,
    ) => {
      const { ts } = analysis;
      const spec = edge.autoload!;
      if (spec.unsupported.length) unresolved.push({ reason: "dynamic-path",
        message: `Autoload options require additional analysis: ${spec.unsupported.join(", ")}; route coverage/prefixes are not verified.`, origin: { file: model.rel } });
      const dirAbs = resolveAutoloadDir(ts, model.source, spec.dirNode);
      if (!dirAbs) {
        unresolved.push({
          reason: "dynamic-path",
          message: "@fastify/autoload dir option could not be statically resolved",
          origin: { file: model.rel },
        });
        return;
      }

      const optionsPrefix = resolveOptionsPrefix(model, spec.optionsNode);
      const rootPrefix = joinPrefix(parentPrefix, edge.prefix);

      // Virtual directory tree from the indexed files under dirAbs.
      const dirs = new Map<string, { files: string[]; subdirs: Set<string> }>();
      const ensureDir = (dir: string) => {
        let entry = dirs.get(dir);
        if (!entry) {
          entry = { files: [], subdirs: new Set() };
          dirs.set(dir, entry);
        }
        return entry;
      };
      ensureDir(dirAbs);
      const rootWithSep = dirAbs.endsWith(sep) ? dirAbs : `${dirAbs}${sep}`;
      for (const file of ctx.index.files) {
        if (!file.absolutePath.startsWith(rootWithSep)) continue;
        if (!AUTOLOAD_SCRIPT_PATTERN.test(file.path) || /\.d\.ts$/.test(file.path)) continue;
        const fileDir = dirname(file.absolutePath);
        ensureDir(fileDir).files.push(file.path);
        let cursor = fileDir;
        while (cursor.length > dirAbs.length) {
          const parent = dirname(cursor);
          ensureDir(parent).subdirs.add(cursor);
          cursor = parent;
          if (!cursor.startsWith(dirAbs)) break;
        }
      }

      const walk = (dir: string, segments: string[]) => {
        const entry = dirs.get(dir);
        if (!entry) return;
        const sortedFiles = [...entry.files].sort();
        const indexRel = sortedFiles.find((relPath) =>
          AUTOLOAD_INDEX_PATTERN.test(relPath.split("/").pop()!),
        );
        const processPlugin = (relPath: string, folderSegments: string[]) => {
          const childModel = models.get(relPath.split(sep).join("/"));
          if (!childModel) return;
          const plugin = resolvePluginExport(ts, childModel);
          if (!plugin) return; // Non-plugin module (schema tables, config): autoload skips.
          const param =
            plugin.node.parameters?.[0]?.name?.getText?.(childModel.source) ?? "fastify";
          if (plugin.fpWrapped || !spec.encapsulate) {
            // fastify-plugin opts out of encapsulation: autoload prefixes and
            // options.prefix are not applied by Fastify; routes carry their
            // own absolute or manually concatenated paths.
            processScope(
              childModel,
              plugin.node.body ?? plugin.node,
              param,
              "",
              depth + 1,
              { value: optionsPrefix === "" ? null : optionsPrefix },
            );
          } else {
            if (optionsPrefix === null) {
              const gapKey = `dynamic-prefix:${relPath}`;
              if (!reportedPrefixGaps.has(gapKey)) {
                reportedPrefixGaps.add(gapKey);
                unresolved.push({
                  reason: "dynamic-path",
                  message:
                    "@fastify/autoload options.prefix is computed at runtime; routes are listed without that prefix",
                  origin: { file: relPath },
                });
              }
            }
            const staticPrefix = joinPrefix(
              rootPrefix,
              optionsPrefix ?? "",
              ...folderSegments,
            );
            processScope(
              childModel,
              plugin.node.body ?? plugin.node,
              param,
              staticPrefix,
              depth + 1,
              optionsPrefix === null ? { value: null } : null,
            );
          }
        };

        if (indexRel) {
          processPlugin(indexRel, segments);
        } else {
          for (const relPath of sortedFiles) processPlugin(relPath, segments);
        }

        for (const subdir of [...entry.subdirs].sort()) {
          const name = subdir.split(sep).pop()!;
          const nextSegments = spec.dirNameRoutePrefix
            ? [...segments, spec.routeParams ? autoloadSegmentToPath(name) : name]
            : segments;
          walk(subdir, nextSegments);
        }
      };

      walk(dirAbs, []);
    };

    const processScope = (
      model: FileModel,
      scopeNode: any,
      instanceName: string,
      prefix: string,
      depth: number,
      runtimePrefix: { value: string | null } | null = null,
    ) => {
      if (depth > 12) return;
      const scopeKey = `${model.rel}:${instanceName}:${prefix}:${scopeNode?.pos ?? 0}`;
      if (visitedScopes.has(scopeKey)) return;
      visitedScopes.add(scopeKey);

      // Resolve a handler factory declared inside this scope, e.g.
      // `const callback = (provider) => async (request, reply) => {...}`.
      const resolveLocalHandlerFactory = (name: string): any | null => {
        let factory: any = null;
        const findDecl = (n: any) => {
          if (factory) return;
          if (
            ts.isVariableDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === name &&
            n.initializer &&
            (ts.isArrowFunction(n.initializer) ||
              ts.isFunctionExpression(n.initializer) ||
              ts.isFunctionDeclaration(n.initializer))
          ) {
            factory = n.initializer;
          }
          if (ts.isFunctionDeclaration(n) && n.name?.text === name) factory = n;
          ts.forEachChild(n, findDecl);
        };
        findDecl(scopeNode);
        if (!factory) return null;
        if (
          ts.isArrowFunction(factory) &&
          factory.body &&
          !ts.isBlock(factory.body) &&
          (ts.isArrowFunction(factory.body) || ts.isFunctionExpression(factory.body))
        ) {
          return factory.body;
        }
        let inner: any = null;
        const findReturn = (n: any) => {
          if (inner) return;
          if (
            ts.isReturnStatement(n) &&
            n.expression &&
            (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))
          ) {
            inner = n.expression;
            return;
          }
          ts.forEachChild(n, findReturn);
        };
        if (factory.body) findReturn(factory.body);
        return inner;
      };

      const sites = collectSites(
        ts,
        model,
        scopeNode ?? model.source,
        instanceName,
        prefix,
      );

      const prefixAliases = collectPrefixAliases(ts, scopeNode ?? model.source);
      const resolveUrlAlias = (id: any) =>
        ts.isIdentifier(id) ? (prefixAliases.get(id.text) ?? null) : null;

      for (const site of sites.routes) {
        const urlResolution = resolveRouteUrl(ts, site.urlNode, resolveUrlAlias);
        if (!urlResolution || urlResolution.fullyDynamic) {
          unresolved.push({
            reason: "dynamic-path",
            message: "Fastify route path is not a static string literal",
            origin: site.origin,
          });
          continue;
        }
        let staticUrl = urlResolution.url;
        if (urlResolution.runtimePrefix) {
          if (runtimePrefix && typeof runtimePrefix.value === "string") {
            staticUrl = `${runtimePrefix.value}${staticUrl}`;
          } else {
            const gapKey = `dynamic-prefix:${model.rel}:${prefix}`;
            if (!reportedPrefixGaps.has(gapKey)) {
              reportedPrefixGaps.add(gapKey);
              unresolved.push({
                reason: "dynamic-path",
                message:
                  "Fastify mount prefix is computed at runtime (options.prefix); routes are listed without that prefix",
                origin: site.origin,
              });
            }
          }
        }
        const normalized = normalizeFastifyPath(joinPrefix(prefix, staticUrl));
        if (normalized.dynamic) {
          unresolved.push({
            reason: "dynamic-path",
            message: "Fastify route path is not a static string literal",
            origin: site.origin,
          });
          continue;
        }
        const fullPath = normalized.path;
        const pathParams = new Set(
          [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
        );

        const schemaResolved = resolveSchemaValueNode(
          ts,
          analysis,
          models,
          model,
          site.schemaNode,
          new Set(),
        );
        const schemaFacts = extractRouteSchema(
          ts,
          analysis,
          models,
          model,
          schemaResolved?.node ?? null,
        );
        let resolvedHandler: any = site.handler;
        let handlerFile: any = model.source;
        // Handlers hoisted inside the plugin scope (e.g. `async function onLogin`
        // declared below the server.route call) resolve lexically first.
        if (
          resolvedHandler &&
          ts.isIdentifier(resolvedHandler) &&
          scopeNode &&
          scopeNode !== model.source
        ) {
          const lexical = findLexicalDeclaration(ts, scopeNode, resolvedHandler.text);
          if (lexical) {
            resolvedHandler = lexical;
          }
        }
        // Resolve imported handlers (`listProjects`) and namespaced handlers
        // (`controllers.login`) to their declared function before analysis.
        if (
          resolvedHandler &&
          (ts.isIdentifier(resolvedHandler) ||
            ts.isPropertyAccessExpression(resolvedHandler))
        ) {
          const resolved = resolveHandler(analysis, model.source, resolvedHandler, new Set());
          if (resolved) {
            resolvedHandler = resolved.node;
            handlerFile = resolved.file;
          }
        }
        if (!resolvedHandler && site.handlerFactoryName) {
          resolvedHandler = resolveLocalHandlerFactory(site.handlerFactoryName);
        }
        const handlerFacts = resolvedHandler
          ? analyzeFastifyHandler(analysis, handlerFile, resolvedHandler, site.origin, pathParams, site.genericNode)
          : { parameters: [], responses: [], gaps: ["response-unknown" as GapCode], sse: false, bodyKnown: false };

        // Merge: explicit JSON Schema (high confidence) wins over inferred.
        const merged = mergeFacts(schemaFacts, handlerFacts, pathParams);
        if (/(^|[^a-z])(auth|authenticate|jwt|bearer|guard|preHandler)/i.test(site.optionsText)) {
          bearerAuth = true;
        }

        const method = site.method === "all" ? "get" : site.method;
        const candidate: RouteCandidate = {
          method,
          path: normalized.path,
          fullPath,
          operationId: operationId(method, fullPath),
          origin: site.origin,
          parameters: merged.parameters,
          ...(merged.requestBody ? { requestBody: merged.requestBody } : {}),
          responses: merged.responses,
          tags: tagForPath(fullPath, model.rel),
          ...(bearerAuth ? { security: [{ bearerAuth: [] }] } : {}),
          confidence: rankConfidence(merged.gaps),
          gaps: merged.gaps,
          components: [],
          handlerSource: sliceNode(ts, handlerFile, resolvedHandler),
        };
        if (site.method === "all") {
          for (const verb of HTTP_METHODS) {
            if (verb === "all") continue;
            candidates.push({ ...structuredClone(candidate), method: verb, operationId: operationId(verb, fullPath) });
          }
        } else candidates.push(candidate);
      }

      for (const edge of sites.edges) {
        if (edge.autoload) {
          expandAutoload(model, edge, prefix, depth + 1);
          continue;
        }
        // Inline require() of an external package (e.g. @fastify/jwt): it
        // contributes middleware only, no project routes.
        if (edge.externalSpecifier) continue;
        const childPrefix = joinPrefix(prefix, edge.prefix);
        if (edge.pluginSpecifier) {
          const targetFile = resolveSpecifierFile(model, edge.pluginSpecifier);
          const childRel = targetFile ? relOfSource(targetFile, models) : null;
          const childModel = childRel ? models.get(childRel) : undefined;
          if (targetFile && childModel) {
            const plugin = resolvePluginExport(ts, childModel);
            if (plugin) {
              const param =
                plugin.node.parameters?.[0]?.name?.getText?.(childModel.source) ??
                "fastify";
              // fastify-plugin opts out of encapsulation, so the register
              // prefix does not apply to its routes.
              const effectivePrefix = plugin.fpWrapped ? "" : childPrefix;
              processScope(
                childModel,
                plugin.node.body ?? plugin.node,
                param,
                effectivePrefix,
                depth + 1,
                runtimePrefix,
              );
            } else {
              unresolved.push({
                reason: "handler-unresolved",
                message: `Fastify plugin module "${edge.pluginSpecifier}" did not export a plugin function`,
                origin: { file: model.rel },
              });
            }
          } else {
            unresolved.push({
              reason: "handler-unresolved",
              message: `Fastify plugin module "${edge.pluginSpecifier}" could not be resolved`,
              origin: { file: model.rel },
            });
          }
          continue;
        }
        if (edge.inlineNode) {
          const param =
            edge.inlineNode.parameters?.[0]?.name?.getText?.(model.source) ??
            instanceName;
          processScope(
            model,
            edge.inlineNode.body ?? edge.inlineNode,
            param,
            childPrefix,
            depth + 1,
            runtimePrefix,
          );
        } else if (edge.pluginName) {
          if (model.externalBindings.has(edge.pluginName)) {
            // Third-party middleware plugin (helmet, cors, ...): no routes.
            continue;
          }
          const resolved = resolvePlugin(model, edge.pluginName);
          if (resolved) {
            const childRel = relOfSource(resolved.file, models);
            const childModel = childRel ? models.get(childRel) : undefined;
            if (childModel) {
              processScope(
                childModel,
                resolved.node.body ?? resolved.node,
                resolved.instanceParam,
                childPrefix,
                depth + 1,
                runtimePrefix,
              );
            }
          } else {
            unresolved.push({
              reason: "handler-unresolved",
              message: `Fastify plugin "${edge.pluginName}" could not be resolved`,
              origin: { file: model.rel },
            });
          }
        } else if (edge.pluginCallName) {
          if (model.externalBindings.has(edge.pluginCallName)) continue;
          const returned = resolveReturnedPlugin(model, edge.pluginCallName);
          if (returned) {
            const childRel = relOfSource(returned.file, models);
            const childModel = childRel ? models.get(childRel) : undefined;
            if (childModel) {
              processScope(
                childModel,
                returned.node.body ?? returned.node,
                returned.instanceParam,
                childPrefix,
                depth + 1,
                runtimePrefix,
              );
            }
          } else {
            unresolved.push({
              reason: "handler-unresolved",
              message: `Fastify plugin factory "${edge.pluginCallName}()" could not be resolved`,
              origin: { file: model.rel },
            });
          }
        }
      }
    };

    for (const model of models.values()) {
      for (const root of model.roots) {
        processScope(model, model.source, root, "", 0);
      }
    }

    for (const model of models.values()) {
      const port = model.listenPorts[0];
      if (port) servers.push({ url: `http://localhost:${port}` });
    }

    // Files that only export a plugin (no root instance) are reached via edges;
    // nothing to do for them here.
    const deduped = dedupe(candidates);

    const components = [...analysis.schemaContext.components.entries()].map(
      ([name, schema]) => ({ name, schema }),
    );
    const securitySchemes: DiscoveredSecurityScheme[] = bearerAuth
      ? [{ name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } }]
      : [];

    return {
      routes: deduped,
      unresolved,
      components,
      securitySchemes,
      servers: dedupeServers(servers),
    };
  },
};

interface Facts {
  parameters: RouteParameter[];
  requestBody?: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence };
  responses: DiscoveredResponse[];
  gaps: GapCode[];
  sse: boolean;
  bodyKnown: boolean;
}

function emptyFacts(): Facts {
  return { parameters: [], responses: [], gaps: [], sse: false, bodyKnown: false };
}

function rankConfidence(gaps: GapCode[]): Confidence {
  if (!gaps.length) return "high";
  if (gaps.some((g) => ["response-unknown", "body-unknown"].includes(g))) return "low";
  return "medium";
}

function relOfSource(source: any, models: Map<string, FileModel>): string | null {
  for (const [rel, model] of models) {
    if (model.source === source) return rel;
  }
  return null;
}

function sliceNode(ts: any, file: any, node: any): string | undefined {
  if (!node) return undefined;
  try {
    const text = node.getText(file) as string;
    return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
  } catch {
    return undefined;
  }
}

function modelFile(analysis: TsAnalysis, rel: string, source: any): FileModel {
  const { ts } = analysis;
  const model: FileModel = {
    rel,
    source,
    factoryBindings: new Set(),
    roots: new Set(),
    moduleBindings: new Map(),
    externalBindings: new Set(),
    bindingSpecifiers: new Map(),
    routes: [],
    edges: [],
    listenPorts: [],
  };

  source.forEachChild((child: any) => {
    if (ts.isImportDeclaration(child) && ts.isStringLiteral(child.moduleSpecifier)) {
      const specifier = child.moduleSpecifier.text;
      if (specifier === "fastify" && child.importClause?.name) {
        model.factoryBindings.add(child.importClause.name.text);
        model.bindingSpecifiers.set(child.importClause.name.text, specifier);
      } else if (specifier.startsWith(".") && child.importClause) {
        if (child.importClause.name) {
          model.moduleBindings.set(child.importClause.name.text, {
            specifier,
            exportName: "default",
          });
          model.bindingSpecifiers.set(child.importClause.name.text, specifier);
        }
        const named = child.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            model.moduleBindings.set(element.name.text, {
              specifier,
              exportName: element.propertyName?.text ?? element.name.text,
            });
            model.bindingSpecifiers.set(element.name.text, specifier);
          }
        }
        if (named && ts.isNamespaceImport(named)) {
          model.moduleBindings.set(named.name.text, {
            specifier,
            exportName: "*",
          });
          model.bindingSpecifiers.set(named.name.text, specifier);
        }
      } else if (!specifier.startsWith(".") && child.importClause) {
        // External package (e.g. @fastify/helmet): middleware plugins carry
        // no project routes, so they are never reported as unresolved.
        if (child.importClause.name) {
          model.externalBindings.add(child.importClause.name.text);
          model.bindingSpecifiers.set(child.importClause.name.text, specifier);
        }
        const named = child.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            model.externalBindings.add(element.name.text);
            model.bindingSpecifiers.set(element.name.text, specifier);
          }
        }
      }
    }
  });

  // CommonJS bindings: `const x = require("spec")` and
  // `const { a } = require("spec")`. Requires inside plugin functions are
  // collected too (route files commonly require schemas at module scope).
  const classifyRequire = (name: string, specifier: string, exportName: string) => {
    model.bindingSpecifiers.set(name, specifier);
    if (specifier === "fastify") {
      model.factoryBindings.add(name);
    } else if (specifier.startsWith(".")) {
      model.moduleBindings.set(name, { specifier, exportName });
    } else {
      model.externalBindings.add(name);
    }
  };
  const requireVisit = (node: any) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      ts.isStringLiteralLike(node.initializer.arguments[0])
    ) {
      const specifier = node.initializer.arguments[0].text;
      if (ts.isIdentifier(node.name)) {
        classifyRequire(node.name.text, specifier, "module");
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            classifyRequire(
              element.name.text,
              specifier,
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text,
            );
          }
        }
      }
    }
    ts.forEachChild(node, requireVisit);
  };
  source.forEachChild((child: any) => requireVisit(child));

  // Root instances: const app = fastify(...), plus class services that own the
  // server through a property assignment (`this.server = fastify(...)` inside a
  // constructor or field initializer).
  const visit = (node: any) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && model.factoryBindings.has(callee.text)) {
        model.roots.add(node.name.text);
      } else if (
        // `const server = require("fastify")(options)`
        ts.isCallExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "require" &&
        ts.isStringLiteralLike(callee.arguments[0]) &&
        callee.arguments[0].text === "fastify"
      ) {
        model.roots.add(node.name.text);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isCallExpression(node.right)
    ) {
      const callee = node.right.expression;
      const isFactory =
        (ts.isIdentifier(callee) && model.factoryBindings.has(callee.text)) ||
        (ts.isCallExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "require" &&
          ts.isStringLiteralLike(callee.arguments[0]) &&
          callee.arguments[0].text === "fastify");
      if (isFactory) model.roots.add(node.left.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  source.forEachChild((child: any) => visit(child));

  return model;
}

function originOf(ts: any, file: string, source: any, node: any): SourceLocation {
  return {
    file,
    line: ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1,
  };
}

/**
 * Collects route and register calls made on `instanceName` within a scope.
 * Inline registered plugins are returned as edges with their AST node so the
 * caller can descend; identifier plugins are returned by name for cross-file
 * resolution.
 */
function collectSites(
  ts: any,
  model: FileModel,
  scope: any,
  instanceName: string,
  _prefix: string,
): { routes: RouteSite[]; edges: RegisterEdge[] } {
  const routes: RouteSite[] = [];
  const edges: RegisterEdge[] = [];

  const visit = (node: any) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      const receiver = access.expression;
      const method = access.name.text;

      let matchReceiver = false;
      if (ts.isIdentifier(receiver) && receiver.text === instanceName) {
        matchReceiver = true;
      } else if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.getText(model.source) === instanceName
      ) {
        // Class-owned root instance, e.g. `this.server.register(...)`.
        matchReceiver = true;
      } else if (ts.isCallExpression(receiver)) {
        // Chained registration:
        // `server.register(cors, {}).register(autoLoad, {...}).register(...)`.
        let chain: any = receiver;
        let guard = 0;
        while (ts.isCallExpression(chain) && guard < 24) {
          if (ts.isPropertyAccessExpression(chain.expression)) {
            const chainReceiver = chain.expression.expression;
            if (
              (ts.isIdentifier(chainReceiver) &&
                chainReceiver.text === instanceName) ||
              (ts.isPropertyAccessExpression(chainReceiver) &&
                chainReceiver.getText(model.source) === instanceName)
            ) {
              matchReceiver = true;
              break;
            }
            chain = chainReceiver;
          } else {
            break;
          }
          guard += 1;
        }
      }
      if (matchReceiver) {
        const origin = originOf(ts, model.rel, model.source, node);

        if (method === "listen") {
          const first = node.arguments[0];
          if (first && ts.isObjectLiteralExpression(first)) {
            const portProp = first.properties.find(
              (p: any) =>
                ts.isPropertyAssignment(p) &&
                p.name.getText(model.source).replace(/['"]/g, "") === "port",
            );
            if (portProp && ts.isNumericLiteral(portProp.initializer)) {
              model.listenPorts.push(Number(portProp.initializer.text));
            }
          } else if (first && ts.isNumericLiteral(first)) {
            model.listenPorts.push(Number(first.text));
          }
        }

        if (method === "register") {
          const target = node.arguments[0];
          const opts = node.arguments[1];
          let pluginPrefix = "";
          let autoloadSpec: RegisterEdge["autoload"];
          if (opts && ts.isObjectLiteralExpression(opts)) {
            const option = (key: string): any => {
              const prop = opts.properties.find(
                (p: any) =>
                  ts.isPropertyAssignment(p) &&
                  p.name?.getText?.(model.source).replace(/['"]/g, "") === key,
              );
              return prop?.initializer ?? null;
            };
            const prefixRaw = option("prefix");
            if (typeof literalValue(ts, prefixRaw) === "string") {
              pluginPrefix = String(literalValue(ts, prefixRaw));
            }
            const dirNode = option("dir");
            if (dirNode) {
              const targetSpecifier = targetSpecifierOf(ts, model, target);
              if (
                targetSpecifier === "@fastify/autoload" ||
                targetSpecifier === "fastify-autoload"
              ) {
                const boolValue = (n: any, fallback: boolean): boolean => {
                  const v = literalValue(ts, n);
                  return typeof v === "boolean" ? v : fallback;
                };
                autoloadSpec = {
                  dirNode,
                  optionsNode: option("options"),
                  dirNameRoutePrefix: boolValue(option("dirNameRoutePrefix"), true),
                  encapsulate: boolValue(option("encapsulate"), true),
                  routeParams: boolValue(option("routeParams"), false),
                  unsupported: ["matchFilter", "ignoreFilter", "ignorePattern", "indexPattern", "scriptPattern", "maxDepth", "appendAutoPrefix"]
                    .filter(key => option(key) !== null)
                    .concat(option("dirNameRoutePrefix") && typeof literalValue(ts, option("dirNameRoutePrefix")) !== "boolean" ? ["dirNameRoutePrefix callback"] : []),
                };
              }
            }
          }
          if (autoloadSpec) {
            edges.push({
              parent: instanceName,
              pluginName: null,
              pluginCallName: null,
              pluginSpecifier: null,
              inlineNode: null,
              prefix: pluginPrefix,
              autoload: autoloadSpec,
            });
          } else if (target && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) {
            edges.push({ parent: instanceName, pluginName: null, pluginCallName: null, pluginSpecifier: null, inlineNode: target, prefix: pluginPrefix });
          } else if (
            target &&
            ts.isCallExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === "require" &&
            ts.isStringLiteralLike(target.arguments[0])
          ) {
            // Inline `server.register(require("@fastify/jwt"), ...)`: external
            // packages carry no project routes; relative specs are followed.
            const spec = target.arguments[0].text as string;
            edges.push({
              parent: instanceName,
              pluginName: null,
              pluginCallName: null,
              pluginSpecifier: spec.startsWith(".") ? spec : null,
              inlineNode: null,
              prefix: pluginPrefix,
              ...(spec.startsWith(".")
                ? {}
                : { externalSpecifier: spec }),
            });
          } else if (target && ts.isIdentifier(target)) {
            edges.push({ parent: instanceName, pluginName: target.text, pluginCallName: null, pluginSpecifier: null, inlineNode: null, prefix: pluginPrefix });
          } else if (
            target &&
            ts.isCallExpression(target) &&
            ts.isIdentifier(target.expression)
          ) {
            // Factory call: `app.register(buildRoutes({ pool }))` — the callee
            // is a local/imported function that returns the plugin function.
            edges.push({ parent: instanceName, pluginName: null, pluginCallName: target.expression.text, pluginSpecifier: null, inlineNode: null, prefix: pluginPrefix });
          }
        }

        if (HTTP_METHODS.has(method)) {
          const urlArg = node.arguments[0];
          const fnArgs = [...node.arguments].slice(1);
          const options = fnArgs.find((a: any) => ts.isObjectLiteralExpression(a)) ?? null;
          // The handler is the last function-like argument after dropping
          // the optional options object: an inline function, an identifier
          // (imported handler), or a factory call such as `callback("google")`.
          const handlerArgs = fnArgs.filter((a: any) => a !== options);
          const lastArg = handlerArgs[handlerArgs.length - 1] ?? null;
          let handler: any = null;
          let handlerFactoryName: string | null = null;
          if (
            lastArg &&
            (ts.isArrowFunction(lastArg) ||
              ts.isFunctionExpression(lastArg) ||
              ts.isIdentifier(lastArg) ||
              ts.isPropertyAccessExpression(lastArg))
          ) {
            handler = lastArg;
          } else if (
            lastArg &&
            ts.isCallExpression(lastArg) &&
            ts.isIdentifier(lastArg.expression)
          ) {
            handlerFactoryName = lastArg.expression.text;
          }
          routes.push({
            instance: instanceName,
            method,
            urlNode: urlArg ?? null,
            schemaNode: options ? getObjectProperty(ts, options, "schema") : null,
            genericNode: node.typeArguments?.[0] ?? null,
            optionsText: options ? options.getText(model.source) : "",
            handler,
            handlerFactoryName,
            origin,
          });
        }

        if (method === "route" && ts.isObjectLiteralExpression(node.arguments[0])) {
          const obj = node.arguments[0];
          const get = (key: string) =>
            obj.properties.find(
              (p: any) => {
                const name = p.name?.getText?.(model.source)?.replace(/['"]/g, "");
                if (name !== key) return false;
                return ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p);
              },
            ) ?? null;
          const propOf = (p: any) =>
            !p
              ? null
              : ts.isPropertyAssignment(p)
                ? p.initializer
                : ts.isShorthandPropertyAssignment(p)
                  ? p.name
                  : null;
          const methodNode = propOf(get("method"));
          const urlNode = propOf(get("url")) ?? propOf(get("path"));
          const schemaNode = propOf(get("schema"));
          const handlerNode = propOf(get("handler"));
          const methodValue = methodNode
            ? literalValue(ts, methodNode) ?? methodNode.getText(model.source)
            : null;
          const methodTexts = Array.isArray(methodValue)
            ? methodValue.map((m) => String(m).toLowerCase())
            : [String(methodValue ?? "").toLowerCase()];
          for (const methodText of methodTexts) {
            if (!methodText || !HTTP_METHODS.has(methodText) || !urlNode) continue;
            routes.push({
              instance: instanceName,
              method: methodText,
              urlNode,
              schemaNode,
              genericNode: null,
              optionsText: obj.getText(model.source),
              handler: handlerNode,
              handlerFactoryName: null,
              origin,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(scope);
  return { routes, edges };
}

function getObjectProperty(ts: any, obj: any, key: string): any | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const prop = obj.properties.find(
    (p: any) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name?.getText?.().replace(/^['"]|['"]$/g, "") === key,
  );
  if (!prop) return null;
  // Shorthand `{ schema }` resolves to the identifier itself so callers can
  // follow it to the enclosing const declaration.
  return ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
}

/**
 * Finds a function-like declaration lexically visible inside a plugin scope.
 * Route files commonly declare handlers as hoisted sibling functions
 * (`async function onLogin(...)` below the `server.route(...)` call). Nested
 * function bodies are not traversed so inner closures cannot shadow matches.
 */
function findLexicalDeclaration(ts: any, scopeNode: any, name: string): any | null {
  let found: any = null;
  const consider = (decl: any) => {
    if (found) return;
    if (ts.isFunctionDeclaration(decl) && decl.name?.text === name) {
      found = decl;
      return;
    }
    if (
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      decl.name.text === name &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    ) {
      found = decl.initializer;
    }
  };
  const walk = (n: any, isRoot: boolean) => {
    if (found) return;
    if (
      !isRoot &&
      (ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return;
    }
    consider(n);
    ts.forEachChild(n, (child: any) => walk(child, false));
  };
  walk(scopeNode, true);
  return found;
}

/**
 * Resolves a CommonJS/ESM plugin module export to its plugin function,
 * reporting whether it is wrapped in fastify-plugin (which opts out of
 * encapsulation and autoload prefixing). Returns null for non-plugin modules
 * such as schema tables, mirroring @fastify/autoload's own skip behavior.
 */
function resolvePluginExport(
  ts: any,
  model: FileModel,
): { node: any; fpWrapped: boolean } | null {
  const sf = model.source;

  const findLocalFunction = (name: string): any | null => {
    let target: any | null = null;
    const walk = (n: any) => {
      if (target) return;
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
        target = n;
        return;
      }
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        target = n.initializer;
        return;
      }
      ts.forEachChild(n, walk);
    };
    sf.forEachChild((child: any) => walk(child));
    return target;
  };

  const isFastifyPluginCall = (call: any): boolean => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      return model.bindingSpecifiers.get(callee.text) === "fastify-plugin";
    }
    return (
      ts.isCallExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "require" &&
      ts.isStringLiteralLike(callee.arguments[0]) &&
      callee.arguments[0].text === "fastify-plugin"
    );
  };

  const unwrap = (
    expr: any,
  ): { node: any; fpWrapped: boolean } | null => {
    if (
      ts.isArrowFunction(expr) ||
      ts.isFunctionExpression(expr) ||
      ts.isFunctionDeclaration(expr)
    ) {
      return { node: expr, fpWrapped: false };
    }
    if (ts.isIdentifier(expr)) {
      const local = findLocalFunction(expr.text);
      return local ? { node: local, fpWrapped: false } : null;
    }
    if (ts.isCallExpression(expr)) {
      const fpWrapped = isFastifyPluginCall(expr);
      if (!fpWrapped) return null;
      const arg = expr.arguments[0];
      if (
        arg &&
        (ts.isArrowFunction(arg) ||
          ts.isFunctionExpression(arg) ||
          ts.isFunctionDeclaration(arg))
      ) {
        return { node: arg, fpWrapped: true };
      }
      if (arg && ts.isIdentifier(arg)) {
        const local = findLocalFunction(arg.text);
        if (local) return { node: local, fpWrapped: true };
      }
    }
    return null;
  };

  let result: { node: any; fpWrapped: boolean } | null = null;
  sf.forEachChild((child: any) => {
    if (result) return;
    if (ts.isExportAssignment(child) && !child.isExportFactory) {
      const r = unwrap(child.expression);
      if (r) result = r;
    }
    if (
      ts.isExpressionStatement(child) &&
      ts.isBinaryExpression(child.expression) &&
      child.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const lhs = child.expression.left;
      if (
        ts.isPropertyAccessExpression(lhs) &&
        lhs.expression.getText(sf) === "module" &&
        lhs.name.text === "exports"
      ) {
        const r = unwrap(child.expression.right);
        if (r) result = r;
      }
    }
  });
  return result;
}

/**
 * Finds a top-level (or nested) const whose initializer is an object literal
 * or a fluent-json-schema builder chain.
 */
function findLocalSchemaValue(ts: any, sf: any, name: string): any | null {
  let found: any = null;
  const acceptable = (init: any) =>
    ts.isObjectLiteralExpression(init) || isFluentSchemaNode(ts, init);
  const walk = (n: any) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      acceptable(n.initializer)
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, walk);
  };
  sf.forEachChild((child: any) => walk(child));
  return found;
}

/**
 * Follows a route `schema` value to its defining node (object literal or
 * fluent-json-schema chain) across files. Supports:
 *   - same-file consts (including nested inside plugin functions),
 *   - property access (`schema.login`),
 *   - ESM imports/exports,
 *   - CommonJS `const schema = require("./schema")` with
 *     `module.exports = { login, ... }` shorthand tables.
 */
function resolveSchemaValueNode(
  ts: any,
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  model: FileModel,
  node: any,
  seen: Set<string>,
): { node: any; file: any } | null {
  const modelForFile = (file: any): FileModel => {
    for (const candidate of models.values()) {
      if (candidate.source === file) return candidate;
    }
    return model;
  };
  if (!node) return null;
  if (ts.isObjectLiteralExpression(node) || isFluentSchemaNode(ts, node)) {
    return { node, file: model.source };
  }

  if (ts.isIdentifier(node)) {
    const cycleKey = `${model.source.fileName}:ident:${node.text}`;
    if (seen.has(cycleKey)) return null;
    seen.add(cycleKey);
    const local = findLocalSchemaValue(ts, model.source, node.text);
    if (local) return resolveSchemaValueNode(ts, analysis, models, model, local, seen);

    const imported = resolveImportedFile(analysis, model.source, node.text);
    if (!imported) return null;
    const { file, exportName } = imported;
    const ownerModel = modelForFile(file);
    const exported = exportedSchemaValue(ts, file, exportName);
    if (exported) {
      return resolveSchemaValueNode(ts, analysis, models, ownerModel, exported, seen);
    }
    return null;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const chain: string[] = [];
    let cur: any = node;
    while (ts.isPropertyAccessExpression(cur)) {
      chain.unshift(cur.name.text);
      cur = cur.expression;
    }
    if (!ts.isIdentifier(cur)) return null;
    const cycleKey = `${model.source.fileName}:member:${cur.text}.${chain.join(".")}`;
    if (seen.has(cycleKey)) return null;
    seen.add(cycleKey);

    let root: { node: any; file: any } | null = null;
    const local = findLocalSchemaValue(ts, model.source, cur.text);
    if (local) root = { node: local, file: model.source };
    if (!root) {
      const imported = resolveImportedFile(analysis, model.source, cur.text);
      if (imported) {
        const exported = exportedSchemaValue(ts, imported.file, imported.exportName);
        if (exported) root = { node: exported, file: imported.file };
      }
    }
    if (!root) return null;

    let target = root.node;
    let ownerFile = root.file;
    for (const member of chain) {
      if (ts.isIdentifier(target)) {
        const localValue = findLocalSchemaValue(ts, ownerFile, target.text);
        if (localValue) target = localValue;
      }
      if (!ts.isObjectLiteralExpression(target)) return null;
      const prop = target.properties.find((p: any) => {
        const propName = p.name?.getText?.(ownerFile)?.replace(/^['"]|['"]$/g, "");
        return (
          propName === member &&
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
        );
      });
      if (!prop) return null;
      if (ts.isPropertyAssignment(prop)) {
        target = prop.initializer;
      } else {
        const localValue = findLocalSchemaValue(ts, ownerFile, prop.name.text);
        if (!localValue) return null;
        target = localValue;
      }
    }
    const ownerModel = modelForFile(ownerFile);
    return resolveSchemaValueNode(ts, analysis, models, ownerModel, target, seen);
  }

  return null;
}

/**
 * Resolves a module's exported schema value: ESM `export const x` /
 * `module.exports = {...}` / `module.exports = ident`.
 */
function exportedSchemaValue(
  ts: any,
  file: any,
  exportName: string,
): any | null {
  if (exportName === "default" || exportName === "module" || exportName === "*") {
    let rhs: any = null;
    file.forEachChild((child: any) => {
      if (rhs) return;
      if (
        ts.isExpressionStatement(child) &&
        ts.isBinaryExpression(child.expression) &&
        child.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(child.expression.left) &&
        child.expression.left.expression.getText(file) === "module" &&
        child.expression.left.name.text === "exports"
      ) {
        rhs = child.expression.right;
      }
    });
    if (rhs) {
      if (ts.isObjectLiteralExpression(rhs) || isFluentSchemaNode(ts, rhs)) return rhs;
      if (ts.isIdentifier(rhs)) return findLocalSchemaValue(ts, file, rhs.text);
    }
  }
  // ESM named export, or const declaration followed by `export { x }`.
  const local = findLocalSchemaValue(ts, file, exportName);
  if (local) return local;
  let exported: any = null;
  file.forEachChild((child: any) => {
    if (exported) return;
    if (
      ts.isVariableStatement(child) &&
      child.modifiers?.some?.((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of child.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === exportName &&
          decl.initializer &&
          (ts.isObjectLiteralExpression(decl.initializer) ||
            isFluentSchemaNode(ts, decl.initializer))
        ) {
          exported = decl.initializer;
        }
      }
    }
  });
  return exported;
}

/**
 * Reads Fastify's route `schema` option (native JSON Schema literals or
 * fluent-json-schema builder chains, possibly declared in another file):
 * params / querystring / body / headers / response. These are authoritative
 * and emitted at high confidence.
 */
function extractRouteSchema(
  ts: any,
  analysis: TsAnalysis,
  models: Map<string, FileModel>,
  ownerModel: FileModel,
  schemaNode: any,
): Facts {
  const facts = emptyFacts();
  if (!schemaNode || !ts.isObjectLiteralExpression(schemaNode)) return facts;

  // Sections may be identifiers or property access pointing at declarations
  // in another file (CJS schema tables); resolve before converting.
  const resolveSection = (node: any): any => {
    if (!node) return null;
    if (ts.isObjectLiteralExpression(node) || isFluentSchemaNode(ts, node)) return node;
    const resolved = resolveSchemaValueNode(
      ts,
      analysis,
      models,
      ownerModel,
      node,
      new Set(),
    );
    return resolved?.node ?? null;
  };

  const sourceOwners = new Map([...models.values()].map(model => [model.source, model]));
  // Expand schema references before syntactic fluent conversion. This keeps
  // nested items(User) and imported profile schemas in the owning file's scope.
  const convertSection = (node: any): JsonSchema | undefined => {
    if (!node) return undefined;
    let budget = 10000;
    const transformed = ts.transform(node, [(context: any) => {
      const visit = (current: any, seen: Set<any>, depth: number): any => {
        if (--budget < 0 || depth > 40 || seen.has(current)) return current;
        const next = new Set(seen).add(current);
        if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
          const source = current.getSourceFile?.();
          const owner = sourceOwners.get(source) ?? ownerModel;
          const resolved = resolveSchemaValueNode(ts, analysis, models, owner, current, new Set());
          if (resolved && resolved.node !== current) return visit(resolved.node, next, depth + 1);
        }
        return ts.visitEachChild(current, (child: any) => {
          if ((ts.isPropertyAssignment(current) || ts.isPropertyAccessExpression(current)) && child === current.name) return child;
          return visit(child, next, depth + 1);
        }, context);
      };
      return (root: any) => visit(root, new Set(), 0);
    }]);
    try { return schemaValueToJson(ts, transformed.transformed[0]); }
    finally { transformed.dispose(); }
  };

  const addParams = (
    node: any,
    location: RouteParameter["in"],
    requiredDefault: boolean,
  ) => {
    const resolved = resolveSection(node);
    const schema = resolved
      ? (convertSection(resolved) as JsonSchema | undefined)
      : undefined;
    if (!schema || typeof schema !== "object" || schema.type !== "object") return;
    const required = new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    for (const [name, propSchema] of Object.entries(
      (schema.properties ?? {}) as Record<string, JsonSchema>,
    )) {
      facts.parameters.push({
        name,
        in: location,
        required: required.has(name) || requiredDefault,
        schema: (propSchema as JsonSchema) ?? {},
        confidence: "high",
      });
    }
  };

  const paramsNode = getObjectProperty(ts, schemaNode, "params");
  const queryNode =
    getObjectProperty(ts, schemaNode, "querystring") ??
    getObjectProperty(ts, schemaNode, "query");
  const headersNode = getObjectProperty(ts, schemaNode, "headers");
  const bodyNode = getObjectProperty(ts, schemaNode, "body");
  const responseNode = resolveSection(getObjectProperty(ts, schemaNode, "response"));

  if (paramsNode) addParams(paramsNode, "path", true);
  if (queryNode) addParams(queryNode, "query", false);
  if (headersNode) addParams(headersNode, "header", false);

  if (bodyNode) {
    const resolved = resolveSection(bodyNode);
    const bodySchema = resolved
      ? (convertSection(resolved) as JsonSchema | undefined)
      : undefined;
    if (bodySchema && typeof bodySchema === "object") {
      facts.requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema: bodySchema }],
        confidence: "high",
      };
      facts.bodyKnown = true;
    }
  }

  if (responseNode && ts.isObjectLiteralExpression(responseNode)) {
    for (const prop of responseNode.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const status = prop.name?.getText?.().replace(/^['"]|['"]$/g, "");
      if (!status || !/^\d{3}$|^2XX$|^default$/i.test(status)) continue;
      const valueNode = ts.isPropertyAssignment(prop)
        ? resolveSection(prop.initializer)
        : resolveSection(prop.name);
      const schema = valueNode
        ? (convertSection(valueNode) as JsonSchema | undefined)
        : undefined;
      if (schema && typeof schema === "object") {
        facts.responses.push({
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema }],
        });
      }
    }
  }

  return facts;
}

/**
 * Infers contract facts from the handler function: request generics,
 * request.params/query/body/headers access, reply.code().send(), and async
 * return values. Type information wins; bare property accesses become gaps.
 */
function analyzeFastifyHandler(
  analysis: TsAnalysis,
  sourceFile: any,
  handlerNode: any,
  origin: SourceLocation,
  pathParams: Set<string>,
  routeGenericNode: any | null = null,
): Facts {
  const { ts, checker } = analysis;
  const gaps = new Set<GapCode>();
  const parameters: RouteParameter[] = [];
  const paramIndex = new Map<string, RouteParameter>();
  const responses = new Map<string, DiscoveredResponse>();

  const resolved = resolveHandler(analysis, sourceFile, handlerNode);
  const handler = resolved?.node ?? handlerNode;
  const file = resolved?.file ?? sourceFile;

  const reqName = handler.parameters?.[0]?.name?.getText?.(file) ?? "request";
  const replyName = handler.parameters?.[1]?.name?.getText?.(file) ?? "reply";

  const factsBody: {
    schema?: JsonSchema;
    referenced: boolean;
    fields: Map<string, JsonSchema | undefined>;
  } = { referenced: false, fields: new Map() };

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema?: JsonSchema,
    confidence: Confidence = "medium",
    required = location === "path",
  ) => {
    const key = `${location}:${name}`;
    if (paramIndex.has(key)) {
      const existing = paramIndex.get(key)!;
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
    paramIndex.set(key, param);
    parameters.push(param);
  };

  const schemaOfTypeNode = (node: any): JsonSchema | undefined => {
    try {
      const type = checker.getTypeFromTypeNode(node);
      const schema = typeToSchema(type, analysis.schemaContext);
      return schema && Object.keys(schema).length ? schema : undefined;
    } catch {
      return undefined;
    }
  };

  // FastifyRequest<{ Params: T; Querystring: T; Body: T; Headers: T }>
  // The same RouteGeneric shape can also sit on the call site:
  // `app.get<{ Params: T; Body: T }>(url, handler)`.
  const applyGenericShape = (shape: any) => {
    if (!shape || !ts.isTypeLiteralNode(shape)) return;
    for (const member of shape.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
      const key = member.name.getText(file);
      const schema = schemaOfTypeNode(member.type);
      if (key === "Params" && schema?.properties) {
        for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
          addParam("path", name, s, "high", true);
        }
      } else if ((key === "Querystring" || key === "Query") && schema?.properties) {
        for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
          addParam("query", name, s, "high", (schema.required as string[] | undefined)?.includes(name) ?? false);
        }
      } else if (key === "Headers" && schema?.properties) {
        for (const [name, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
          addParam("header", name.toLowerCase(), s, "high", false);
        }
      } else if (key === "Body" && schema) {
        factsBody.schema = schema;
      }
    }
  };

  const reqType = handler.parameters?.[0]?.type;
  if (reqType && ts.isTypeReferenceNode(reqType) && reqType.typeArguments?.length) {
    applyGenericShape(reqType.typeArguments[0]);
  }
  if (routeGenericNode && ts.isTypeLiteralNode(routeGenericNode)) {
    applyGenericShape(routeGenericNode);
  } else if (
    routeGenericNode &&
    ts.isTypeReferenceNode(routeGenericNode) &&
    routeGenericNode.typeArguments?.length
  ) {
    applyGenericShape(routeGenericNode.typeArguments[0]);
  }

  const queryFields = new Map<string, JsonSchema | undefined>();
  const headerFields = new Map<string, JsonSchema | undefined>();

  // Local aliases of request.body / request.query / request.params, e.g.
  // `const payload = request.body; payload.slug`. Property accesses on these
  // aliases are attributed to the same source as the original request member.
  const bodyAliases = new Set<string>();
  const queryAliases = new Set<string>();
  const paramAliases = new Set<string>();

  const rootIdentifier = (node: any): string | undefined => {
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
  };

  const typeAt = (node: any): JsonSchema | undefined => {
    try {
      const type = checker.getTypeAtLocation(node);
      if (type && !(type.flags & ts.TypeFlags.Any) && !(type.flags & ts.TypeFlags.Unknown)) {
        const schema = typeToSchema(type, analysis.schemaContext);
        if (schema && Object.keys(schema).length) return schema;
      }
    } catch {
      // ignore
    }
    return undefined;
  };

  const recordResponse = (
    status: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    mediaType = "application/json",
    noContent = false,
  ) => {
    const key = noContent ? `${status}:` : `${status}:${mediaType}`;
    const existing = responses.get(key);
    if (existing?.content?.[0]) {
      const previous = existing.content[0].schema;
      if (schema && previous && JSON.stringify(previous) !== JSON.stringify(schema)) {
        // Branches sharing a status/media type are alternatives; never discard
        // an earlier response or require mutually exclusive shapes (oneOf).
        const alternatives = Object.keys(previous).length === 1 && Array.isArray(previous.anyOf) ? previous.anyOf : [previous];
        existing.content[0].schema = { anyOf: [...alternatives, schema] };
      } else if (schema && !previous) {
        existing.content[0].schema = schema;
      }
      if (confidence === "high") existing.confidence = "high";
    } else if (existing && noContent) {
      existing.confidence = confidence;
    } else {
      responses.set(key, {
        statusCode: status,
        description: "",
        confidence,
        content: noContent ? [] : [{ mediaType, ...(schema ? { schema } : {}) }],
      });
    }
  };

  const body = handler.body;
  if (body) {
    const helperSeen = new Set<string>();

    // Lexical lookup of a function declared in an enclosing block/module,
    // mirroring JS scope resolution for sibling helpers inside a plugin.
    const resolveLexicalFunction = (
      name: string,
      startNode: any,
    ): { node: any; file: any } | null => {
      const matchIn = (container: any): { node: any; file: any } | null => {
        const statements = container?.statements;
        if (!Array.isArray(statements)) return null;
        for (const stmt of statements) {
          if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
            return { node: stmt, file };
          }
          if (
            ts.isVariableStatement(stmt) &&
            stmt.declarationList.declarations.some(
              (d: any) =>
                ts.isIdentifier(d.name) &&
                d.name.text === name &&
                d.initializer &&
                (ts.isArrowFunction(d.initializer) ||
                  ts.isFunctionExpression(d.initializer)),
            )
          ) {
            const decl = stmt.declarationList.declarations.find(
              (d: any) => ts.isIdentifier(d.name) && d.name.text === name,
            );
            return { node: decl.initializer, file };
          }
        }
        return null;
      };

      // Helpers declared inside the handler's own body block.
      if (startNode?.body && ts.isBlock(startNode.body)) {
        const own = matchIn(startNode.body);
        if (own) return own;
      }
      let scope: any = startNode;
      while (scope && scope !== file) {
        const container = scope.parent;
        const found = matchIn(container);
        if (found) return found;
        scope = container;
      }
      return null;
    };

    const visit = (node: any, roots: { req: string; reply: string }, helperDepth: number) => {
      // `const alias = request.body | .query | .params` records a local alias so
      // later `alias.field` accesses are attributed to the right request member.
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        rootIdentifier(node.initializer) === roots.req &&
        ts.isIdentifier(node.name)
      ) {
        const aliasMember = node.initializer.name.text;
        const aliasName = node.name.text;
        if (aliasMember === "body") {
          bodyAliases.add(aliasName);
          factsBody.referenced = true;
          const bodyType = typeAt(node.initializer);
          if (bodyType && !factsBody.schema) factsBody.schema = bodyType;
        } else if (aliasMember === "query") {
          queryAliases.add(aliasName);
        } else if (aliasMember === "params") {
          paramAliases.add(aliasName);
        }
      }

      // request.<member> access
      if (ts.isPropertyAccessExpression(node) && rootIdentifier(node) === roots.req) {
        const full = node.getText(file);
        const member = node.name.text;
        const schema = typeAt(node);
        if (member === "query" && ts.isVariableDeclaration(node.parent) &&
            ts.isObjectBindingPattern(node.parent.name)) {
          for (const el of node.parent.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              queryFields.set(el.name.text, typeAt(el.name));
            }
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(file) === `${roots.req}.query`) {
          queryFields.set(member, schema);
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(file) === `${roots.req}.params`) {
          addParam("path", member, schema, schema ? "high" : "low");
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(file) === `${roots.req}.headers`) {
          headerFields.set(member.toLowerCase(), schema);
        } else if (full === `${roots.req}.body`) {
          factsBody.referenced = true;
          const bodyType = typeAt(node);
          if (bodyType && !factsBody.schema) factsBody.schema = bodyType;
          if (ts.isVariableDeclaration(node.parent) && ts.isObjectBindingPattern(node.parent.name)) {
            for (const el of node.parent.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                factsBody.fields.set(el.name.text, typeAt(el.name));
              }
            }
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(file) === `${roots.req}.body`) {
          factsBody.referenced = true;
          factsBody.fields.set(member, schema);
        }
      }

      // Alias.<field> access: `const payload = request.body; payload.slug`.
      // Only a single hop directly on the alias identifier counts as a field;
      // chained calls like `payload.heading.toLowerCase()` must not leak method
      // names into the body schema.
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const root = node.expression.text;
        const member = node.name.text;
        const schema = typeAt(node);
        if (bodyAliases.has(root)) {
          factsBody.referenced = true;
          factsBody.fields.set(member, schema);
        } else if (queryAliases.has(root)) {
          queryFields.set(member, schema);
        } else if (paramAliases.has(root)) {
          addParam("path", member, schema, schema ? "high" : "low");
        }
      }

      // Literal bracket keys are common for hyphenated HTTP header names.
      if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === roots.req
          && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
        const key = node.argumentExpression.text;
        const schema = typeAt(node);
        switch (node.expression.name.text) {
          case "headers": headerFields.set(key.toLowerCase(), schema); break;
          case "query": queryFields.set(key, schema); break;
          case "params": addParam("path", key, schema, schema ? "high" : "low"); break;
          case "body": factsBody.referenced = true; factsBody.fields.set(key, schema); break;
        }
      }

      // request.headers['x'] / request.get('x')
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.req &&
        ["get", "header"].includes(node.expression.name.text) &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        headerFields.set(node.arguments[0].text.toLowerCase(), undefined);
      }

      // reply.code(201).type(media).send(payload) / reply.send(payload)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.reply &&
        node.expression.name.text === "send"
      ) {
        let status = "200";
        let mediaType = "application/json";
        // Walk the chain: reply.code(N).type("...").send(x)
        let cur: any = node.expression.expression;
        while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (["code", "status"].includes(cur.expression.name.text)) {
            const raw = cur.arguments[0]?.getText(file);
            if (raw && /^\d{3}$/.test(raw)) status = raw;
          } else if (cur.expression.name.text === "type" && ts.isStringLiteralLike(cur.arguments[0])) {
            mediaType = cur.arguments[0].text;
          } else if (cur.expression.name.text === "header" && ts.isStringLiteralLike(cur.arguments[0])) {
            const headerName = cur.arguments[0].text.toLowerCase();
            if (headerName === "content-type" && ts.isStringLiteralLike(cur.arguments[1])) {
              mediaType = cur.arguments[1].text;
            }
          }
          cur = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
        }
        const payload = node.arguments[0];
        if (payload) {
          recordResponse(status, typeAt(payload), "high", mediaType);
        } else {
          recordResponse(status, undefined, "medium", mediaType);
        }
      }

      // reply.redirect([code,] url)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootIdentifier(node.expression.expression) === roots.reply &&
        node.expression.name.text === "redirect"
      ) {
        let status = "302";
        if (ts.isNumericLiteral(node.arguments[0])) status = node.arguments[0].text;
        let cur: any = node.expression.expression;
        while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
          if (["code", "status"].includes(cur.expression.name.text) && ts.isNumericLiteral(cur.arguments[0])) {
            status = cur.arguments[0].text;
          }
          cur = ts.isPropertyAccessExpression(cur.expression) ? cur.expression.expression : null;
        }
        recordResponse(status, undefined, "high", "text/html", true);
      }

      // async return payload (handler body only; helper returns are not responses)
      if (
        helperDepth === 0 &&
        ts.isReturnStatement(node) &&
        node.expression &&
        handler.modifiers?.some?.((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        // `return reply.redirect()/send()/...` is a reply action, not a body.
        const rootedAtReply =
          ts.isCallExpression(node.expression) &&
          rootIdentifier(node.expression.expression) === roots.reply;
        // A closure helper declared inside the handler performs reply
        // actions on its own; an untyped call to it is not a body.
        const untypedClosureCall =
          ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          !typeAt(node.expression) &&
          (() => {
            const lexical = resolveLexicalFunction(
              node.expression!.expression.text,
              handler,
            );
            const b = handler.body;
            return (
              lexical &&
              b &&
              lexical.node.pos >= b.pos &&
              lexical.node.end <= b.end
            );
          })();
        if (!rootedAtReply && !untypedClosureCall) {
          const schema = typeAt(node.expression);
          recordResponse("200", schema, schema ? "high" : "medium");
        }
      }

      // Descend into local/imported helpers that receive request or reply,
      // e.g. `await serveOas(token, request, reply)` (bounded, cycle-guarded).
      if (
        helperDepth < 2 &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const calleeName = node.expression.text;
        const lexical = resolveLexicalFunction(calleeName, handler);
        const resolved = lexical ?? resolveHandler(analysis, file, node.expression);
        const fnNode = resolved?.node;
        const fnFile = resolved?.file ?? file;
        if (fnNode?.parameters && fnNode.body) {
          const nextRoots = { ...roots };
          let mapped = false;
          fnNode.parameters.forEach((param: any, i: number) => {
            const arg = node.arguments[i];
            const paramName = param.name?.getText?.(fnFile);
            if (!paramName || !arg || !ts.isIdentifier(arg)) return;
            if (arg.text === roots.req) {
              nextRoots.req = paramName;
              mapped = true;
            } else if (arg.text === roots.reply) {
              nextRoots.reply = paramName;
              mapped = true;
            }
          });
          // A helper declared inside the handler body closes over req/reply.
          const handlerBody = handler.body;
          const isClosure =
            !mapped &&
            lexical &&
            handlerBody &&
            fnNode.pos >= handlerBody.pos &&
            fnNode.end <= handlerBody.end;
          if (isClosure) mapped = true;
          const key = `${fnFile.fileName}:${fnNode.pos ?? 0}:${nextRoots.req}:${nextRoots.reply}`;
          if (mapped && !helperSeen.has(key)) {
            helperSeen.add(key);
            visit(fnNode.body, nextRoots, helperDepth + 1);
          }
        }
      }

      ts.forEachChild(node, (child: any) => visit(child, roots, helperDepth));
    };
    visit(body, { req: reqName, reply: replyName }, 0);

    // Explicit async return type annotation.
    if (handler.type && ts.isTypeReferenceNode(handler.type)) {
      const typeNode = handler.type.typeName?.text === "Promise" && handler.type.typeArguments?.[0]
        ? handler.type.typeArguments[0]
        : handler.type;
      const schema = schemaOfTypeNode(typeNode);
      if (schema && responses.size === 0) {
        recordResponse("200", schema, "high");
      }
    }
  }

  // Concise arrow with an expression body: implicit return value.
  if (
    ts.isArrowFunction(handler) &&
    handler.body &&
    !ts.isBlock(handler.body)
  ) {
    const schema = typeAt(handler.body);
    recordResponse("200", schema, schema ? "high" : "medium");
  }

  for (const [name, schema] of queryFields) {
    addParam("query", name, schema, schema ? "high" : "low", false);
  }
  for (const [name, schema] of headerFields) {
    addParam("header", name, schema, schema ? "high" : "low", false);
  }
  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low");
    }
  }

  let requestBody: Facts["requestBody"];
  if (factsBody.schema) {
    requestBody = {
      required: true,
      content: [{ mediaType: "application/json", schema: factsBody.schema }],
      confidence: "high",
    };
  } else if (factsBody.referenced) {
    if (factsBody.fields.size) {
      const properties: Record<string, JsonSchema> = {};
      let incomplete = false;
      for (const [name, schema] of factsBody.fields) {
        if (!schema) incomplete = true;
        properties[name] = schema ?? {};
      }
      requestBody = {
        required: true,
        content: [{ mediaType: "application/json", schema: { type: "object", properties } }],
        confidence: "medium",
      };
      if (incomplete) gaps.add("body-schema-unknown");
    } else {
      gaps.add("body-schema-unknown");
    }
  }

  if (queryFields.size && [...queryFields.values()].some((s) => !s)) {
    gaps.add("query-unknown");
  }
  if (responses.size === 0) gaps.add("response-unknown");
  else if (
    [...responses.values()].some(
      (r) =>
        !/^(204|3\d\d)$/.test(r.statusCode) &&
        !r.content?.some((m) => m.schema || m.itemSchema),
    )
  ) {
    gaps.add("response-schema-unknown");
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: [...responses.values()],
    gaps: [...gaps],
    sse: false,
    bodyKnown: Boolean(requestBody),
  };
}

function mergeFacts(schema: Facts, inferred: Facts, pathParams: Set<string>): Facts {
  const parameters = [...schema.parameters];
  const byKey = new Map(parameters.map((p) => [`${p.in}:${p.name}`, p]));
  for (const p of inferred.parameters) {
    const key = `${p.in}:${p.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      parameters.push(p);
      byKey.set(key, p);
    } else if ((!existing.schema || !Object.keys(existing.schema).length) && p.schema) {
      existing.schema = p.schema;
    }
  }
  for (const name of pathParams) {
    const key = `path:${name}`;
    if (!byKey.has(key)) {
      const p: RouteParameter = {
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "low",
      };
      parameters.push(p);
      byKey.set(key, p);
    }
  }

  const requestBody = schema.requestBody ?? inferred.requestBody;
  // Handler inference proved a JSON body is read but its shape could not be
  // recovered. Keep a schema-less application/json media placeholder so the
  // gap stays attached to a real request body and the AI resolver (or the
  // user) has a concrete slot to fill, matching the other framework packs.
  const mergedRequestBody =
    requestBody ??
    (inferred.gaps.includes("body-unknown") ||
    inferred.gaps.includes("body-schema-unknown")
      ? {
          required: true,
          content: [{ mediaType: "application/json" }],
          confidence: "low" as Confidence,
        }
      : undefined);
  // Explicit JSON Schema responses win; otherwise use handler inference.
  const responses = schema.responses.length ? schema.responses : inferred.responses;

  // Recompute gaps against the merged evidence instead of trusting either side.
  const gaps = new Set<GapCode>();
  if (!mergedRequestBody) {
    if (inferred.gaps.includes("body-unknown")) gaps.add("body-unknown");
  }
  if (
    mergedRequestBody &&
    mergedRequestBody.content.some((media) => !media.schema && !media.itemSchema)
  ) {
    gaps.add("body-schema-unknown");
  }
  if (responses.length === 0) {
    gaps.add("response-unknown");
  } else if (
    responses.some(
      (r) =>
        !/^(204|3\d\d)$/.test(r.statusCode) &&
        !r.content?.some((m) => m.schema || m.itemSchema),
    )
  ) {
    gaps.add("response-schema-unknown");
  }
  if (
    parameters.some((p) => p.in === "query" && (!p.schema || !Object.keys(p.schema).length))
  ) {
    gaps.add("query-unknown");
  }
  for (const gap of inferred.gaps) {
    if (
      ["path-param-untyped", "header-unknown", "auth-unknown", "sse-events-unknown"].includes(gap)
    ) {
      gaps.add(gap);
    }
  }

  return {
    parameters,
    ...(mergedRequestBody ? { requestBody: mergedRequestBody } : {}),
    responses,
    gaps: [...gaps],
    sse: false,
    bodyKnown: Boolean(mergedRequestBody),
  };
}

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (c: RouteCandidate) =>
      c.responses.length * 2 +
      c.parameters.length +
      (c.requestBody ? 2 : 0) -
      c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

function dedupeServers(servers: DiscoveredServer[]): DiscoveredServer[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
