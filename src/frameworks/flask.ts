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
import type { PythonAnalysis, PyFunction } from "../lang/python/index.js";
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

    const byVar = (file: string, name: string) =>
      instances.get(`${file}::${name}`);

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

      for (const call of findAll(file.root, (n) => n.type === "call")) {
        const mc = methodCall(call);
        if (!mc || mc.receiver.type !== "identifier") continue;
        if (mc.method === "register_blueprint") {
          const app = byVar(file.path, mc.receiver.text);
          const childArg = positionalArguments(call)[0];
          const blueprint = childArg?.type === "identifier" ? byVar(file.path, childArg.text) : null;
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
      reachablePrefix.set(
        registration.blueprint,
        registration.prefix
          ? joinPrefix(registration.prefix, blueprint.prefix)
          : blueprint.prefix,
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
        routes.push(buildFlaskRoute(site, joinPrefix(prefix, site.rawPath), method));
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

    return { routes: [...deduped.values()], unresolved, components: [], securitySchemes, servers };
  },
};

function chainText(node: TsNode | null): string {
  return node ? node.text : "";
}

function buildFlaskRoute(site: FlaskSite, fullPath: string, method: string): RouteCandidate {
  const { fn, file } = site;
  const parameters = flaskPathParams(site.rawPath);
  const gaps = new Set<GapCode>();
  const body = fn.body;

  // Proven query/header/cookie parameters.
  if (body) {
    for (const call of findAll(body, (n) => n.type === "call")) {
      const mc = methodCall(call);
      if (!mc) continue;
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

  // Request body evidence.
  let requestBody: RouteCandidate["requestBody"];
  const bodyText = body?.text ?? "";
  if (/request\.get_json\s*\(/.test(bodyText) || /request\.json\b/.test(bodyText)) {
    requestBody = {
      required: true,
      confidence: "medium",
      content: [{ mediaType: "application/json", schema: {} }],
    };
    gaps.add("body-schema-unknown");
  } else if (/request\.files\b/.test(bodyText)) {
    requestBody = {
      required: true,
      confidence: "medium",
      content: [{ mediaType: "multipart/form-data", schema: { type: "object" } }],
    };
    gaps.add("body-schema-unknown");
  } else if (/request\.form\b/.test(bodyText)) {
    requestBody = {
      required: true,
      confidence: "medium",
      content: [{ mediaType: "application/x-www-form-urlencoded", schema: { type: "object" } }],
    };
    gaps.add("body-schema-unknown");
  } else if (/request\.data\b/.test(bodyText)) {
    gaps.add("body-unknown");
  }

  // Responses.
  const responses = buildFlaskResponses(fn, gaps);
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

function buildFlaskResponses(
  fn: PyFunction,
  gaps: Set<string>,
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
        responses.push({
          statusCode: String(status),
          description: "",
          confidence: "medium",
          ...(mediaType
            ? { content: [{ mediaType, schema: {} }] }
            : {}),
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
