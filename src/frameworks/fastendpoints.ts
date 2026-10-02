/**
 * FastEndpoints framework pack (C#, tree-sitter based).
 *
 * FastEndpoints maps one endpoint to one class deriving from
 * `Endpoint<TRequest, TResponse>` or `EndpointWithoutRequest<TResponse>`. The
 * HTTP verb(s) and route(s) are declared in an overridden `Configure()` method
 * via `Verbs(Http.POST)`/`Routes("/x")` or the convenience `Get(x)`/`Post(x)`
 * helpers, and the response is produced in `HandleAsync` via SendAsync helpers.
 * The generic request/response arguments become the request body and response
 * components respectively.
 */

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
import type { CSharpAnalysis } from "../lang/csharp/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  buildCsModelIndex,
  csTypeToSchema,
  type CsModelIndex,
} from "../lang/csharp/schema.js";

const HTTP_VERB_NAMES = new Set(["get", "post", "put", "delete", "patch", "head"]);

const SEND_STATUS: Record<string, string> = {
  SendOkAsync: "200",
  SendCreatedAsync: "201",
  SendNoContentAsync: "204",
  SendNotFoundAsync: "404",
  SendUnauthorizedAsync: "401",
  SendForbiddenAsync: "403",
  SendNoContent: "204",
};

export const fastendpointsPack: FrameworkPack<CSharpAnalysis> = {
  id: "fastendpoints",
  language: "csharp",
  dependencyHints: ["FastEndpoints"],

  applies(ctx) {
    return ctx.index.files.some(
      (f) =>
        f.language === "csharp" &&
        (/:\s*Endpoint(WithoutRequest)?(\s*[<:{]|\s*$)/m.test(f.content) ||
          /\b(UseFastEndpoints|MapFastEndpoints)\s*\(/.test(f.content)),
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildCsModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      extractEndpoints(file.root, rel, model, candidates);
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers: DiscoveredServer[] = [];

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

function extractEndpoints(
  root: TsNode,
  rel: string,
  model: CsModelIndex,
  out: RouteCandidate[],
): void {
  for (const cls of findAll(root, (n) => n.type === "class_declaration")) {
    const base = endpointBase(cls);
    if (!base) continue;
    const className = cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "";

    const cfg = findMethod(cls, "Configure");
    const handler = findMethod(cls, "HandleAsync");
    const verbsRoutes = parseConfigure(cfg);

    const requestType = base.requestType;
    const responseType = base.responseType;

    for (const { verb, route } of verbsRoutes) {
      const fullPath = normalizeRoute(route || "/");
      const pathParams = new Set(
        [...fullPath.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!),
      );
      const parameters: RouteParameter[] = [...pathParams].map((name) => ({
        name,
        in: "path" as const,
        required: true,
        schema: { type: "string" },
        confidence: "high" as Confidence,
      }));

      let requestBody:
        | { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence }
        | undefined;
      if (requestType) {
        const schema = csTypeToSchema(requestType, model);
        if (Object.keys(schema).length) {
          requestBody = {
            required: true,
            content: [{ mediaType: "application/json", schema }],
            confidence: "high",
          };
        }
      }

      const gaps: GapCode[] = [];
      const responses = collectResponses(handler, responseType, model, gaps);

      out.push({
        method: verb,
        path: fullPath,
        fullPath,
        operationId: className,
        origin: { file: rel, line: cls.startPosition.row + 1 },
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses,
        tags: [className],
        confidence: gaps.length ? "medium" : "high",
        gaps,
        components: [],
        handlerSource: sliceNode(handler ?? cls),
      });
    }
  }
}

interface EndpointBase {
  requestType: TsNode | null;
  responseType: TsNode | null;
}

/** Returns the generic base info when the class derives from Endpoint<..>. */
function endpointBase(cls: TsNode): EndpointBase | null {
  const baseList = cls.namedChildren.find((c) => c.type === "base_list");
  if (!baseList) return null;
  for (const candidate of baseList.namedChildren) {
    if (candidate.type === "generic_name") {
      const name = candidate.namedChildren.find((c) => c.type === "identifier")?.text;
      const args = candidate.namedChildren.find((c) => c.type === "type_argument_list");
      const argTypes = args ? args.namedChildren : [];
      if (name === "Endpoint" && argTypes.length >= 1) {
        return { requestType: argTypes[0] ?? null, responseType: argTypes[1] ?? null };
      }
      if (name === "EndpointWithoutRequest") {
        return { requestType: null, responseType: argTypes[0] ?? null };
      }
      continue;
    }
    // Non-generic `EndpointWithoutRequest` (no response DTO).
    if (candidate.type === "identifier" && candidate.text === "EndpointWithoutRequest") {
      return { requestType: null, responseType: null };
    }
  }
  return null;
}

function findMethod(cls: TsNode, name: string): TsNode | null {
  const body = childrenOfType(cls, "declaration_list")[0];
  if (!body) return null;
  return (
    childrenOfType(body, "method_declaration").find(
      (m) => m.childForFieldName("name")?.text === name,
    ) ?? null
  );
}

interface VerbRoute {
  verb: string;
  route: string;
}

/** Parses Configure() for Verbs/Routes and the Get(x)/Post(x) helpers. */
function parseConfigure(cfg: TsNode | null): VerbRoute[] {
  if (!cfg) return [];
  let verbs: string[] = [];
  let routes: string[] = [];

  for (const call of findAll(cfg, (n) => n.type === "invocation_expression")) {
    const name = invocationName(call);
    const args = call.namedChildren.find((c) => c.type === "argument_list");
    const argNodes = args ? childrenOfType(args, "argument") : [];

    if (name === "Verbs") {
      for (const arg of argNodes) {
        // Http.POST / Http.GET
        const access = findFirst(arg, (n) => n.type === "member_access_expression");
        const verb = access?.namedChildren[access.namedChildren.length - 1]?.text.toLowerCase();
        if (verb && HTTP_VERB_NAMES.has(verb)) verbs.push(verb);
      }
    } else if (name === "Routes") {
      for (const lit of findAll(call, (n) => n.type === "string_literal")) {
        routes.push(unquote(lit.text));
      }
    } else if (name && HTTP_VERB_NAMES.has(name.toLowerCase())) {
      // Get("/path") / Post("/path") convenience helper.
      const lit = argNodes[0] ? findFirst(argNodes[0], (n) => n.type === "string_literal") : null;
      if (lit) {
        verbs.push(name.toLowerCase());
        routes.push(unquote(lit.text));
      }
    }
  }

  if (!routes.length) routes.push("/");
  if (!verbs.length) verbs = ["get"];
  const out: VerbRoute[] = [];
  for (const verb of verbs) {
    for (const route of routes) out.push({ verb, route });
  }
  return out;
}

function invocationName(call: TsNode): string | null {
  // Bare Verbs(...) or member access Http.POST / this.Verbs(...).
  const direct = call.namedChildren.find((c) => c.type === "identifier");
  if (direct) return direct.text;
  const access = call.namedChildren.find((c) => c.type === "member_access_expression");
  return access?.namedChildren[access.namedChildren.length - 1]?.text ?? null;
}

function collectResponses(
  handler: TsNode | null,
  responseType: TsNode | null,
  model: CsModelIndex,
  gaps: GapCode[],
): DiscoveredResponse[] {
  let status: string | null = null;
  let explicitPayload = false;

  if (handler) {
    for (const call of findAll(handler, (n) => n.type === "invocation_expression")) {
      const name = invocationName(call);
      if (!name) continue;
      if (name === "SendAsync") {
        // SendAsync(payload, [statusCode])
        const args = call.namedChildren.find((c) => c.type === "argument_list");
        const argNodes = args ? childrenOfType(args, "argument") : [];
        if (argNodes[1]) {
          const lit = findFirst(argNodes[1], (n) => n.type === "integer_literal");
          if (lit) status = lit.text;
        }
        if (!status) status = "200";
        explicitPayload = true;
      } else if (SEND_STATUS[name]) {
        status = SEND_STATUS[name]!;
      }
    }
  }

  const code = status ?? "200";
  const schema = responseType ? csTypeToSchema(responseType, model) : {};

  if (code === "204") {
    return [{ statusCode: "204", description: "", confidence: "high" }];
  }
  if (!responseType) {
    gaps.push("response-unknown");
    return [{ statusCode: code, description: "", confidence: "low" }];
  }
  if (!Object.keys(schema).length) {
    gaps.push("response-unknown");
    return [
      {
        statusCode: code,
        description: "",
        confidence: "low",
        content: [{ mediaType: "application/json" }],
      },
    ];
  }
  return [
    {
      statusCode: code,
      description: "",
      confidence: explicitPayload ? "high" : "medium",
      content: [{ mediaType: "application/json", schema }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRoute(raw: string): string {
  if (!raw) return "/";
  let route = raw.trim();
  if (!route.startsWith("/")) route = `/${route}`;
  route = route.replace(/\{(\*+)?([A-Za-z0-9_]+)(?::[^}?]+)?(\?)?\}/g, "{$2}");
  return route;
}

function unquote(raw: string): string {
  return raw.replace(/^[@$]?"/, "").replace(/"$/, "");
}

function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
}

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    if (!seen.has(key)) seen.set(key, route);
  }
  return [...seen.values()];
}

// Several test endpoints share the same simple class name (e.g. multiple
// `Endpoint` classes). Append a numeric suffix to keep operationIds unique.
function disambiguateOperationIds(routes: RouteCandidate[]): void {
  const counts = new Map<string, number>();
  for (const r of routes) {
    if (!r.operationId) continue;
    counts.set(r.operationId, (counts.get(r.operationId) ?? 0) + 1);
  }
  const firstSeen = new Set<string>();
  const used = new Set(routes.map((r) => r.operationId).filter((x): x is string => !!x));
  for (const r of routes) {
    if (!r.operationId || (counts.get(r.operationId) ?? 1) === 1) continue;
    if (!firstSeen.has(r.operationId)) {
      firstSeen.add(r.operationId);
      continue;
    }
    let n = 2;
    let candidate = `${r.operationId}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${r.operationId}_${n}`;
    }
    used.delete(r.operationId);
    r.operationId = candidate;
    used.add(candidate);
  }
}
