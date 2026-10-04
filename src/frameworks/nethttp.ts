import { namespaceComponents, remapSchemaReferences } from "../core/schema-references.js";
/**
 * Go standard library net/http (ServeMux) framework pack.
 *
 * Targets the stdlib router, NOT the frameworks built on top of it:
 *  - Go 1.22 method-pattern registration: mux.HandleFunc("GET /items/{id}", h)
 *    and mux.Handle("POST /items", http.Handler(...)).
 *  - Legacy unmethoded registration (mux.HandleFunc("/items", h), the package
 *    level http.HandleFunc / http.Handle, or a pattern without a leading
 *    method word) is served by the mux for EVERY verb, so it is honestly
 *    expanded to all standard methods.
 *  - {name} wildcard segments; r.PathValue("name") confirms the parameter.
 *
 * Detection is content-only (net/http needs no go.mod dependency). Because gin,
 * chi, gorilla/mux, echo and fiber are all built on net/http and all call
 * http.ListenAndServe, applies() explicitly refuses any project that imports one
 * of those frameworks so this pack never double-claims their routes.
 *
 * Handler evidence (r.PathValue / r.URL.Query / json.Decoder-Encoder /
 * w.WriteHeader / http.ServeFile) lives in the shared httphandler module.
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
import type { DiscoveredUnresolved } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import { buildGoModelIndex } from "../lang/go/schema.js";
import { analyzeStdHTTPHandler, selectorCall } from "../lang/go/httphandler.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  literalString,
  positionalArguments,
} from "../lang/treesitter/ast.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** Imports that mean another Go web framework owns the routing. */
const OTHER_GO_FRAMEWORKS = [
  "gin-gonic/gin",
  "go-chi/chi",
  "gorilla/mux",
  "labstack/echo",
  "gofiber/fiber",
];

/**
 * Split a ServeMux pattern into its optional method word and OpenAPI path.
 * Go 1.22 patterns look like "GET /items/{id}" or "/items/{id...}". A catch-all
 * "{name...}" is normalized to "{name}"; OpenAPI has no regex/catch-all syntax.
 */
function parsePattern(raw: string): { methods: string[]; path: string; params: string[] } {
  let rest = raw.trim();
  let methods: string[];
  const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/.exec(rest);
  if (methodMatch) {
    methods = [methodMatch[1].toLowerCase()!];
    rest = methodMatch[2]!;
  } else {
    // No leading method: the mux answers every verb for this pattern.
    methods = [...HTTP_METHODS];
  }
  const path = rest.replace(/\{([A-Za-z0-9_]+)\.\.\.\}/g, "{$1}");
  const params: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path))) params.push(match[1]!);
  return { methods, path, params };
}

function operationId(method: string, path: string): string {
  const parts = path
    .replace(/[{}]/g, "")
    .split(/[/\-:]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return method.toLowerCase() + parts.join("");
}

function addrToUrl(addr: string): string {
  const port = addr.match(/:(\d+)/)?.[1];
  return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
}

interface RouteSite {
  methods: string[];
  path: string;
  params: string[];
  handler: TsNode | null;
  origin: SourceLocation;
}

export const nethttpPack: FrameworkPack<GoAnalysis> = {
  id: "nethttp",
  language: "go",
  dependencyHints: [],

  applies(ctx) {
    let goSeen = false;
    let stdlibSignal = false;
    for (const file of ctx.index.files) {
      if (!/\.go$/.test(file.path)) continue;
      goSeen = true;
      const content = file.content;
      // Another framework owns routing here — never double-claim.
      if (OTHER_GO_FRAMEWORKS.some((f) => content.includes(f))) return false;
      if (
        /\bhttp\.NewServeMux\s*\(/.test(content) ||
        /\bhttp\.HandleFunc\s*\(/.test(content) ||
        /\bhttp\.Handle\s*\(/.test(content) ||
        /\.Handle(Func)?\s*\(\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(content)
      ) {
        stdlibSignal = true;
      }
    }
    // go.mod dependency signal for a competing framework.
    for (const dep of OTHER_GO_FRAMEWORKS) {
      for (const key of ctx.manifest.packages.keys()) {
        if (key.includes(dep)) return false;
      }
    }
    return goSeen && stdlibSignal;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const inputModel = { ...modelIndex, input: true, components: new Map() };
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    // Collect ServeMux variables and direct registrations across every file.
    // Go's ServeMux does NOT strip a mount prefix before matching a sub-mux, so
    // a mounted mux's own patterns are already absolute paths; mounted sub-muxes
    // are reachable simply because their registrations are collected too.
    const muxVars = new Set<string>();
    const registrations: Array<{
      recv: string;
      pattern: string;
      handler: TsNode | null;
      origin: SourceLocation;
    }> = [];

    for (const file of analysis.files.values()) {
      // Note `mux := http.NewServeMux()` / `var mux = http.NewServeMux()`.
      for (const decl of findAll(
        file.root,
        (n) => n.type === "short_var_declaration" || n.type === "var_declaration",
      )) {
        const specs = decl.type === "var_declaration" ? childrenOfType(decl, "var_spec") : [decl];
        for (const spec of specs) {
          for (const call of findAll(spec, (n) => n.type === "call_expression")) {
            const sel = selectorCall(call);
            if (
              sel &&
              sel.receiver.type === "identifier" &&
              sel.receiver.text === "http" &&
              sel.method === "NewServeMux"
            ) {
              const left = findFirst(spec, (n) => n.type === "expression_list");
              const name = left?.namedChildren.find((c) => c.type === "identifier");
              if (name) muxVars.add(name.text);
            }
          }
        }
      }

      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        const args = positionalArguments(call);

        const onDefaultMux =
          sel.receiver.type === "identifier" &&
          sel.receiver.text === "http" &&
          (sel.method === "Handle" || sel.method === "HandleFunc");
        const onKnownMux =
          sel.receiver.type === "identifier" && muxVars.has(sel.receiver.text) &&
          (sel.method === "Handle" || sel.method === "HandleFunc");
        if (!onDefaultMux && !onKnownMux) continue;

        const recv = onDefaultMux ? "http" : sel.receiver.text!;
        const patternNode = args[0];
        const rawPattern = patternNode ? literalString(patternNode) : null;
        if (rawPattern === null) {
          if (patternNode) {
            unresolved.push({
              reason: "dynamic-path",
              message: "net/http ServeMux pattern is not a static string literal",
              origin: { file: file.path, line: call.startPosition.row + 1 },
            });
          }
          continue;
        }

        const handlerArg = args[1];
        // A mount of another mux variable: its registrations are collected too.
        if (handlerArg && handlerArg.type === "identifier" && muxVars.has(handlerArg.text)) {
          continue;
        }

        registrations.push({
          recv,
          pattern: rawPattern,
          handler: handlerArg ?? null,
          origin: { file: file.path, line: call.startPosition.row + 1 },
        });
      }

      // Server address: http.ListenAndServe(addr, ...).
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (
          sel &&
          sel.receiver.type === "identifier" &&
          sel.receiver.text === "http" &&
          sel.method === "ListenAndServe"
        ) {
          const addr = literalString(positionalArguments(call)[0]);
          if (addr) servers.add(addrToUrl(addr));
        }
      }
    }

    for (const reg of registrations) {
      const parsed = parsePattern(reg.pattern);
      sites.push({
        methods: parsed.methods,
        path: parsed.path,
        params: parsed.params,
        handler: reg.handler,
        origin: reg.origin,
      });
    }

    // Resolve each route site to a handler function and its evidence.
    for (const site of sites) {
      const handlerNode = site.handler;
      let fn: GoFunction | null = null;
      if (handlerNode?.type === "func_literal") {
        const block = findFirst(handlerNode, (c) => c.type === "block");
        if (block) {
          fn = { name: "<anonymous>", file: site.origin.file, node: handlerNode, body: block, receiver: null };
        }
      } else if (handlerNode) {
        const name =
          handlerNode.type === "identifier"
            ? handlerNode.text
            : handlerNode.type === "selector_expression"
              ? (handlerNode.namedChildren[1]?.type === "field_identifier"
                  ? handlerNode.namedChildren[1].text
                  : null)
              : null;
        if (name) {
          fn =
            (analysis.functions.get(name) ?? [])[0] ??
            analysis.methods.find((m) => m.name === name) ??
            null;
        }
      }

      const evidence = fn
        ? analyzeStdHTTPHandler({
            body: fn.body,
            declaredPathParams: site.params,
            modelIndex,
            inputModel,
            analysis,
          })
        : {
            parameters: site.params.map((name) => ({
              name,
              in: "path" as const,
              required: true,
              schema: { type: "string" },
              confidence: "medium" as Confidence,
            })),
            requestBody: undefined,
            responses: [] as RouteCandidate["responses"],
            gaps: new Set<GapCode>(["response-unknown"]),
            extensions: undefined as RouteCandidate["extensions"],
          };

      const confidence: Confidence = evidence.gaps.size > 0 ? "medium" : "high";
      for (const method of site.methods) {
        routes.push({
          method,
          path: site.path,
          fullPath: site.path,
          origin: site.origin,
          operationId: operationId(method, site.path),
          tags: [],
          parameters: evidence.parameters,
          ...(evidence.requestBody ? { requestBody: evidence.requestBody } : {}),
          responses: evidence.responses,
          ...(evidence.extensions ? { extensions: evidence.extensions } : {}),
          confidence,
          gaps: [...evidence.gaps],
          components: [],
          handlerSource: fn?.node.text.slice(0, 8192),
        });
      }
    }

    const inputComponents = namespaceComponents(inputModel.components, new Set([...modelIndex.byName.keys(), ...modelIndex.components.keys()]), "input");
    for (const route of routes) if (route.requestBody) route.requestBody = remapSchemaReferences(route.requestBody, inputComponents.names);
    return {
      routes: dedupeRoutes(routes),
      unresolved,
      components: [...[...modelIndex.components.entries()].map(([name, schema]) => ({ name, schema })), ...inputComponents.components],
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

/** Drop exact duplicate method+path routes, keeping the richer one. */
function dedupeRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (c: RouteCandidate) =>
      c.parameters.length * 2 + c.responses.length * 3 + (c.requestBody ? 4 : 0) - c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}
