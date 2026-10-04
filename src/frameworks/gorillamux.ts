import { namespaceComponents, remapSchemaReferences } from "../core/schema-references.js";
import { resolveGoCall } from "../lang/go/symbols.js";
/**
 * gorilla/mux framework pack (Go).
 *
 * Routing idioms covered:
 *  - r := mux.NewRouter() and sub-routers: sr := r.PathPrefix("/api").Subrouter().
 *  - r.HandleFunc("/items/{id:[0-9]+}", h) with {name} and {name:regex} vars;
 *    the regex constraint is stripped for OpenAPI, keeping the param name.
 *  - Chained constraints: .Methods("GET", "POST"), .Queries("tag", "{tag}") and
 *    .Headers("X-Trace", ".*") declare verb / query / header parameters.
 *  - A route with no .Methods(...) matches every verb, so it is honestly
 *    expanded to all standard methods.
 *  - mux.Vars(r)["name"] reads a path variable inside the handler.
 *
 * Handlers are plain http.HandlerFunc, so request/response evidence reuses the
 * shared std-handler analyzer (query/header/cookie, json.Decoder/Encoder,
 * w.WriteHeader, w.Write, http.ServeFile, SSE).
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
import { analyzeStdHTTPHandler, selectorCall, convertedParameterSchema } from "../lang/go/httphandler.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  findAll,
  findFirst,
  literalString,
  positionalArguments,
} from "../lang/treesitter/ast.js";

const ALL_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

interface RouteSite {
  methods: string[];
  path: string;
  params: string[];
  queryKeys: string[];
  headerKeys: string[];
  handler: TsNode | null;
  origin: SourceLocation;
}

interface ChainConstraints {
  methods: Set<string>;
  queryKeys: string[];
  headerKeys: string[];
}

/** Normalize a gorilla path to OpenAPI: strip {name:regex} down to {name}. */
function normalizePath(raw: string): { path: string; params: string[] } {
  const path = raw.replace(/\{([^}:]+):[^}]*\}/g, "{$1}");
  const params: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path))) params.push(match[1]!);
  return { path, params };
}

function joinRouterPath(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/\/$/, "");
  if (!path || path === "/") return cleanPrefix || "/";
  const cleanPath = path.replace(/^\//, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanPath}` : `/${cleanPath}`;
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

/**
 * Read mux.Vars(r)["name"] style path variables from a handler body. Returns the
 * distinct path-param names referenced, so they can be marked high confidence.
 */
function readMuxVars(body: TsNode): {name:string; node:TsNode}[] {
  const names: {name:string; node:TsNode}[] = [];
  // Variables aliasing mux.Vars(r): vars := mux.Vars(r).
  const varAlias = new Set<string>();
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
    const left = decl.namedChildren.find((c) => c.type === "expression_list");
    const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
    const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
    if (findAll(right ?? decl, (c) => c.type === "call_expression").some((call) => call.text.includes("mux.Vars("))) {
      for (const id of left?.namedChildren ?? []) {
        if (id.type === "identifier") varAlias.add(id.text);
      }
    }
  }
  for (const idx of findAll(body, (n) => n.type === "index_expression")) {
    const object = idx.namedChildren[0];
    if (!object) continue;
    const isVarsCall = object.type === "call_expression" && object.text.includes("mux.Vars(");
    const isAlias = object.type === "identifier" && varAlias.has(object.text);
    if (!isVarsCall && !isAlias) continue;
    const index = idx.namedChildren[1];
    const name = index ? literalString(index) : null;
    if (name && !names.some(item => item.name === name)) names.push({name,node:idx});
  }
  return names;
}

export const gorillamuxPack: FrameworkPack<GoAnalysis> = {
  id: "gorillamux",
  language: "go",
  dependencyHints: ["github.com/gorilla/mux"],

  applies(ctx) {
    if (ctx.manifest.packages.has("github.com/gorilla/mux")) return true;
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /gorilla\/mux/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const inputModel = { ...modelIndex, input: true, components: new Map() };
    const servers = new Set<string>();
    const sites: RouteSite[] = [];

    // Router receivers: r := mux.NewRouter(), a.Router = mux.NewRouter(), and
    // sr := r.PathPrefix("/api").Subrouter(). Stored as the exact receiver text
    // used at the call site (so both `r.HandleFunc(...)` and
    // `a.Router.HandleFunc(...)` match).
    const routerReceivers = new Set<string>();
    const prefixOfRouter = new Map<string, string>();
    const considerNewRouter = (call: TsNode, left: TsNode | undefined): void => {
      const sel = selectorCall(call);
      if (!sel || sel.receiver.type !== "identifier" || sel.receiver.text !== "mux" || sel.method !== "NewRouter") return;
      // Left-hand side may hold a bare identifier (`r := ...`) or a selector
      // target (`a.Router = ...`); register the full receiver text either way.
      for (const target of left?.namedChildren ?? []) {
        if (target.type === "identifier" || target.type === "selector_expression") {
          routerReceivers.add(target.text);
        }
      }
    };
    for (const file of analysis.files.values()) {
      // short_var_declaration: r := mux.NewRouter()
      for (const decl of findAll(file.root, (n) => n.type === "short_var_declaration")) {
        const left = decl.namedChildren.find((c) => c.type === "expression_list");
        const lists = decl.namedChildren.filter((c) => c.type === "expression_list");
        const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
        if (!right) continue;
        for (const call of findAll(right, (c) => c.type === "call_expression")) {
          const sel = selectorCall(call);
          considerNewRouter(call, left);
          // sr := r.PathPrefix("/api").Subrouter() — gorilla concatenates the
          // PathPrefix with the child route path.
          if (sel && sel.method === "Subrouter") {
            const name = left?.namedChildren.find((c) => c.type === "identifier" || c.type === "field_identifier");
            if (!name) continue;
            routerReceivers.add(name.text);
            let prefix = "";
            const recv = sel.receiver;
            if (recv.type === "call_expression") {
              const rsel = selectorCall(recv);
              if (rsel && (rsel.method === "PathPrefix" || rsel.method === "Path")) {
                prefix = literalString(positionalArguments(recv)[0]) ?? "";
              }
            }
            prefixOfRouter.set(name.text, prefix);
          }
        }
      }
      // assignment_statement: a.Router = mux.NewRouter() (struct-field router).
      for (const assign of findAll(file.root, (n) => n.type === "assignment_statement")) {
        const lists = assign.namedChildren.filter((c) => c.type === "expression_list");
        const right = lists.length > 1 ? lists[lists.length - 1] : undefined;
        const left = lists[0];
        if (!right || !left) continue;
        for (const call of findAll(right, (c) => c.type === "call_expression")) {
          considerNewRouter(call, left);
        }
      }
    }

    for (const file of analysis.files.values()) {
      // Map each base HandleFunc/Handle call to its chained constraints.
      const constraintsByBase = new Map<TsNode, ChainConstraints>();

      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        // Walk up the receiver chain until we hit the base registration call.
        let cur: TsNode = call;
        const collected: ChainConstraints = { methods: new Set(), queryKeys: [], headerKeys: [] };
        let base: TsNode | null = null;
        for (let i = 0; i < 6; i++) {
          const s = selectorCall(cur);
          if (!s) break;
          const curArgs = positionalArguments(cur);
          if (
            (s.method === "HandleFunc" || s.method === "Handle") &&
            routerReceivers.has(s.receiver.text)
          ) {
            base = cur;
            break;
          }
          if (s.method === "Methods") {
            for (const a of curArgs) {
              const verb = literalString(a);
              if (verb) collected.methods.add(verb.toLowerCase());
            }
          } else if (s.method === "Queries") {
            // Queries("key", "{key}", "other", "..."): keys at even positions.
            for (let k = 0; k < curArgs.length; k += 2) {
              const key = literalString(curArgs[k]);
              if (key && !collected.queryKeys.includes(key)) collected.queryKeys.push(key);
            }
          } else if (s.method === "Headers") {
            const header = literalString(curArgs[0]);
            if (header && !collected.headerKeys.includes(header)) collected.headerKeys.push(header);
          }
          if (s.receiver.type === "call_expression") {
            cur = s.receiver;
          } else {
            break;
          }
        }
        if (base) {
          const existing = constraintsByBase.get(base) ?? { methods: new Set(), queryKeys: [], headerKeys: [] };
          for (const m of collected.methods) existing.methods.add(m);
          for (const q of collected.queryKeys) if (!existing.queryKeys.includes(q)) existing.queryKeys.push(q);
          for (const h of collected.headerKeys) if (!existing.headerKeys.includes(h)) existing.headerKeys.push(h);
          constraintsByBase.set(base, existing);
        }
      }

      // Base registrations.
      for (const call of findAll(file.root, (n) => n.type === "call_expression")) {
        const sel = selectorCall(call);
        if (!sel) continue;
        if (
          (sel.method !== "HandleFunc" && sel.method !== "Handle") ||
          !routerReceivers.has(sel.receiver.text)
        ) {
          continue;
        }
        const args = positionalArguments(call);
        const rawPath = args[0] ? literalString(args[0]) : null;
        if (rawPath === null) {
          unresolved.push({
            reason: "dynamic-path",
            message: "gorilla/mux route path is not a static string literal",
            origin: { file: file.path, line: call.startPosition.row + 1 },
          });
          continue;
        }
        const { path, params } = normalizePath(rawPath);
        const routerPrefix = prefixOfRouter.get(sel.receiver.text) ?? "";
        const fullPath = joinRouterPath(routerPrefix, path);
        const constraints = constraintsByBase.get(call);
        const methods = constraints && constraints.methods.size > 0
          ? [...constraints.methods]
          : [...ALL_METHODS];
        sites.push({
          methods,
          path: fullPath,
          params,
          queryKeys: constraints?.queryKeys ?? [],
          headerKeys: constraints?.headerKeys ?? [],
          handler: args[1] ?? null,
          origin: { file: file.path, line: call.startPosition.row + 1 },
        });
      }

      // Server address.
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

    for (const site of sites) {
      const handlerNode = site.handler;
      let fn: GoFunction | null = null;
      if (handlerNode?.type === "func_literal") {
        const block = findFirst(handlerNode, (c) => c.type === "block");
        if (block) {
          fn = { name: "<anonymous>", file: site.origin.file, node: handlerNode, body: block, receiver: null };
        }
      } else if (handlerNode) {
        fn = resolveGoCall(handlerNode, analysis) ?? null;
      }

      const evidence: {
        parameters: RouteParameter[];
        requestBody: RouteCandidate["requestBody"];
        responses: RouteCandidate["responses"];
        gaps: Set<GapCode>;
        extensions: RouteCandidate["extensions"];
      } = fn
        ? analyzeStdHTTPHandler({
            body: fn.body,
            declaredPathParams: site.params,
            modelIndex,
            inputModel,
            analysis,
          })
        : {
            parameters: site.params.map((name): RouteParameter => ({
              name,
              in: "path",
              required: true,
              schema: { type: "string" },
              confidence: "medium" as Confidence,
            })),
            requestBody: undefined,
            responses: [] as RouteCandidate["responses"],
            gaps: new Set<GapCode>(["response-unknown"]),
            extensions: undefined as RouteCandidate["extensions"],
          };

      // mux.Vars(r)["name"] references confirm path params at high confidence.
      const varNames = fn?.body ? readMuxVars(fn.body) : [];
      for (const {name, node} of varNames) {
        if (!site.params.includes(name)) continue;
        const schema = convertedParameterSchema(node, analysis);
        const existing = evidence.parameters.find(p => p.name === name && p.in === "path");
        if (existing) { existing.schema = schema; existing.confidence = "high"; }
        else evidence.parameters.unshift({name, in:"path",required:true,schema,confidence:"high"});
      }

      // Declared query/header constraints from .Queries()/.Headers().
      for (const key of site.queryKeys) {
        if (!evidence.parameters.some((p) => p.name === key && p.in === "query")) {
          evidence.parameters.push({ name: key, in: "query", required: false, schema: { type: "string" }, confidence: "high" });
        }
      }
      for (const header of site.headerKeys) {
        if (!evidence.parameters.some((p) => p.name === header && p.in === "header")) {
          evidence.parameters.push({ name: header, in: "header", required: false, schema: { type: "string" }, confidence: "high" });
        }
      }

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
