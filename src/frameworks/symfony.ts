/**
 * Symfony framework pack (PHP, tree-sitter based).
 *
 * Recognizes PHP 8 attribute routing:
 *
 *   #[Route('/api', name: 'api_')]               // class-level prefix
 *   class BookController extends AbstractController {
 *       #[Route('/books/{id}', name: 'show', methods: ['GET'])]
 *       public function show(int $id): JsonResponse { ... }
 *   }
 *
 * It concatenates class- and method-level path/name prefixes, binds `{placeholder}`
 * path arguments to type-hinted method parameters, maps `#[MapQueryParameter]`
 * scalar arguments to query parameters and `#[MapRequestPayload]` DTO arguments to
 * a JSON request-body component, and infers JSON/HTML/binary responses from
 * `$this->json(...)`, `new JsonResponse(...)`, `new Response(...)`,
 * `$this->render(...)`, `$this->redirectToRoute(...)` and
 * `new StreamedResponse(...)`. Legacy doc-comment `@Route` annotations and
 * `config/routes.yaml` routing are extracted on a best-effort basis; anything not
 * statically provable becomes an honest gap rather than a fabricated field.
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
} from "../core/types.js";
import type { PhpAnalysis } from "../lang/php/index.js";
import { phpStringText } from "../lang/php/index.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import {
  buildPhpModelIndex,
  ensurePhpComponent,
  formalParameters,
  phpTypeToSchema,
  type PhpModelIndex,
} from "../lang/php/schema.js";
import {
  binaryResponse,
  inferArraySchema,
  inferValueSchema,
  inferVariableModel,
  integerText,
  staticString,
  unknownJsonResponse,
} from "../lang/php/response.js";

const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

function emptyResult() {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [] as DiscoveredSecurityScheme[],
    servers: [] as DiscoveredServer[],
  };
}

export const symfonyPack: FrameworkPack<PhpAnalysis> = {
  id: "symfony",
  language: "php",
  dependencyHints: ["symfony/framework-bundle"],

  applies(ctx) {
    // Route-feature signal: PHP 8 #[Route] attributes, legacy @Route doc
    // annotations, or a routes.yaml definition. Laravel registers routes via
    // the Route:: facade (not attributes) and Slim via $app-> verb calls, so
    // none of those cross-claim this pack.
    const hasRouteFeature = ctx.index.files.some(
      (f) =>
        f.language === "php" &&
        (/#\[\s*Route\s*\(/.test(f.content) || /\*\s*@Route\s*\(/.test(f.content)),
    );
    if (!hasRouteFeature && !hasRoutesYaml(ctx)) return false;

    // Dependency signal: composer requires symfony/framework-bundle, or source
    // references Symfony's routing attribute / AbstractController base class.
    if (ctx.manifest.packages.has("symfony/framework-bundle")) return true;
    const hasSymfonySource = ctx.index.files.some(
      (f) =>
        f.language === "php" &&
        (f.content.includes("Symfony\\Component\\Routing\\Attribute\\Route") ||
          f.content.includes("Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController") ||
          f.content.includes("Symfony\\Component\\Routing\\Annotation\\Route")),
    );
    return hasSymfonySource;
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildPhpModelIndex(analysis);

    for (const [rel, file] of analysis.files) {
      for (const classNode of findAll(file.root, (n) => n.type === "class_declaration")) {
        const className = classNode.namedChildren.find((c) => c.type === "name")?.text;
        if (!className) continue;
        const classRoute = routeAttribute(classNode);
        const body = classNode.namedChildren.find((c) => c.type === "declaration_list");
        if (!body) continue;

        const methodNodes = childrenOfType(body, "method_declaration");
        let emittedInvokable = false;

        for (const methodNode of methodNodes) {
          const methodName = methodNode.namedChildren.find((c) => c.type === "name")?.text;
          if (!methodName) continue;
          const methodRoute = routeAttribute(methodNode);
          if (!methodRoute) {
            // Pure invokable controller: the class-level #[Route] binds to
            // __invoke when the method itself carries no route attribute.
            if (methodName === "__invoke" && classRoute && !emittedInvokable) {
              emittedInvokable = true;
              for (const verb of classRoute.methods) {
                const candidate = buildCandidate({
                  analysis,
                  model,
                  rel,
                  methodNode,
                  className,
                  methodName,
                  path: joinPath(classRoute.path, ""),
                  name: combineNames(classRoute.name, ""),
                  verb,
                  originNode: classNode,
                });
                if (candidate) candidates.push(candidate);
              }
            }
            continue;
          }
          for (const verb of methodRoute.methods) {
            const candidate = buildCandidate({
              analysis,
              model,
              rel,
              methodNode,
              className,
              methodName,
              path: joinPath(classRoute?.path ?? "", methodRoute.path),
              name: combineNames(classRoute?.name ?? "", methodRoute.name),
              verb,
              originNode: methodNode,
            });
            if (candidate) candidates.push(candidate);
          }
        }
      }
    }

    // config/routes.yaml (best-effort): static path/method/controller tables.
    candidates.push(...yamlRoutes(ctx, analysis, model, unresolved));

    const routes = dedupe(candidates);
    disambiguateOperationIds(routes);
    const components = [...model.components.entries()].map(([cName, schema]) => ({
      name: cName,
      schema,
    }));
    return { routes, unresolved, components, securitySchemes: [], servers: [] };
  },
};

// ---------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------

interface RouteAttr {
  path: string;
  name: string;
  methods: string[];
}

/**
 * Extract the `#[Route(...)]` attribute from a class or method node, or null
 * when it carries no such attribute. Resolves both the short `#[Route(...)]`
 * and the fully-qualified `#[\\Symfony\\...\\Route(...)]` forms.
 */
function routeAttribute(node: TsNode): RouteAttr | null {
  const list = node.namedChildren.find((c) => c.type === "attribute_list");
  if (!list) return null;
  for (const group of childrenOfType(list, "attribute_group")) {
    for (const attr of childrenOfType(group, "attribute")) {
      const short = attributeName(attr);
      if (short !== "Route") continue;
      const methods: string[] = [];
      let path = "";
      let name = "";
      const args = attr.namedChildren.find((c) => c.type === "arguments");
      const argNodes = args ? childrenOfType(args, "argument") : [];
      for (const arg of argNodes) {
        const keyword = arg.namedChildren.find((c) => c.type === "name")?.text;
        if (!keyword) {
          // Positional first argument is the path.
          const str = arg.type === "string" ? arg : arg.namedChildren.find((c) => c.type === "string");
          const text = str ? phpStringText(str) : null;
          if (text !== null && path === "") path = text;
          continue;
        }
        const valueNode = arg.namedChildren.find((c) => c.type !== "name");
        if (keyword === "name") {
          name = staticString(valueNode) ?? "";
        } else if (keyword === "path") {
          path = staticString(valueNode) ?? path;
        } else if (keyword === "methods") {
          const arr = valueNode?.type === "array_creation_expression"
            ? valueNode
            : findFirst(valueNode ?? arg, (n) => n.type === "array_creation_expression");
          if (arr) {
            for (const el of childrenOfType(arr, "array_element_initializer")) {
              const v = phpStringText(el.namedChildren.find((c) => c.type === "string"));
              if (v) methods.push(v.toLowerCase());
            }
          }
        }
      }
      // Symfony defaults to GET when no method constraint is declared.
      return { path, name, methods: methods.length ? methods : ["get"] };
    }
  }
  return null;
}

/** Short attribute class name (last segment), handling qualified FQCN forms. */
function attributeName(attr: TsNode): string {
  const qualified = attr.namedChildren.find((c) => c.type === "qualified_name");
  if (qualified) return qualified.text.split("\\").pop() ?? "";
  return attr.namedChildren.find((c) => c.type === "name")?.text ?? "";
}

/** Join a class prefix and a method path into a normalized URI. */
function joinPath(prefix: string, sub: string): string {
  const clean = (s: string) => s.replace(/^\/+|\/+$/g, "");
  const joined = [clean(prefix), clean(sub)].filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
}

/** Combine class- and method-level route names (class name is a prefix). */
function combineNames(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

// ---------------------------------------------------------------------------
// Route candidate construction
// ---------------------------------------------------------------------------

interface BuildArgs {
  analysis: PhpAnalysis;
  model: PhpModelIndex;
  rel: string;
  methodNode: TsNode;
  className: string;
  methodName: string;
  path: string;
  name: string;
  verb: string;
  originNode: TsNode;
}

function buildCandidate(args: BuildArgs): RouteCandidate | null {
  const { analysis, model, rel, methodNode, className, methodName, path, name, verb, originNode } = args;
  const declaredPathParams = new Set([...path.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!));

  const { parameters, requestBody, gaps } = collectParameters(methodNode, analysis, model, path, declaredPathParams);

  for (const p of declaredPathParams) {
    if (!parameters.some((prm) => prm.in === "path" && prm.name === p)) {
      parameters.push({ name: p, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
    }
  }

  const responses = collectResponses(methodNode, model, gaps);
  const tag = className.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase());
  const operationId = name || `${className}.${methodName}`;

  return {
    method: verb,
    path,
    fullPath: path,
    operationId,
    origin: { file: rel, line: originNode.startPosition.row + 1 },
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    tags: [tag],
    confidence: gaps.length ? "medium" : "high",
    gaps,
    components: [],
    handlerSource: methodNode.text.slice(0, 8192),
  };
}

// ---------------------------------------------------------------------------
// Parameter / request-body collection
// ---------------------------------------------------------------------------

function collectParameters(
  handler: TsNode,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  path: string,
  pathParams: Set<string>,
): {
  parameters: RouteParameter[];
  requestBody: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence } | undefined;
  gaps: GapCode[];
} {
  const parameters: RouteParameter[] = [];
  const gaps: GapCode[] = [];
  let requestBody: { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence } | undefined;

  const push = (location: RouteParameter["in"], pName: string, schema: JsonSchema | undefined, confidence: Confidence, required: boolean) => {
    if (parameters.some((p) => p.in === location && p.name === pName)) return;
    parameters.push({
      name: pName,
      in: location,
      required: location === "path" ? true : required,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    });
  };

  for (const param of formalParameters(handler)) {
    const variable = param.namedChildren.find((c) => c.type === "variable_name");
    const pName = variable?.text.replace(/^\$/, "") ?? "";
    if (!pName) continue;

    const attrs = paramAttributes(param);
    const typeNode = param.namedChildren.find(
      (c) => c.type === "named_type" || c.type === "primitive_type" || c.type === "optional_type",
    );
    const schema = typeNode ? phpTypeToSchema(typeNode, model) : undefined;

    // #[MapRequestPayload] DTO: the request body is validated against the DTO.
    if (attrs.has("MapRequestPayload")) {
      const dtoName = typeNode?.namedChildren.find((c) => c.type === "name")?.text
        ?? (typeNode?.text.split("\\").pop() || "");
      const ref = dtoName && analysis.classes.has(dtoName) ? ensurePhpComponent(dtoName, model) : undefined;
      if (ref) {
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema: ref }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
        requestBody = {
          required: true,
          content: [{ mediaType: "application/json", schema: {} }],
          confidence: "low",
        };
      }
      continue;
    }

    // #[MapQueryParameter] scalar argument -> query parameter.
    if (attrs.has("MapQueryParameter")) {
      push("query", pName, schema, "high", false);
      continue;
    }

    // #[MapRequestAttribute] / #[MapRequestHeader] etc. are container-provided;
    // only map a plain scalar/typed argument when it names a path segment.
    if (pathParams.has(pName)) {
      push("path", pName, schema, schema && Object.keys(schema).length ? "high" : "medium", true);
      continue;
    }
  }

  return { parameters, requestBody, gaps };
}

/** Collect the short names of attributes decorating a parameter. */
function paramAttributes(param: TsNode): Set<string> {
  const set = new Set<string>();
  const list = param.namedChildren.find((c) => c.type === "attribute_list");
  if (!list) return set;
  for (const group of childrenOfType(list, "attribute_group")) {
    for (const attr of childrenOfType(group, "attribute")) {
      set.add(attributeName(attr));
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Response collection
// ---------------------------------------------------------------------------

function collectResponses(handler: TsNode, model: PhpModelIndex, gaps: GapCode[]): DiscoveredResponse[] {
  const responses: DiscoveredResponse[] = [];

  for (const ret of findAll(handler, (n) => n.type === "return_statement")) {
    const nullRet = ret.namedChildren.find((c) => c.type === "null");
    const expression = ret.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "scoped_call_expression" ||
        c.type === "array_creation_expression" ||
        c.type === "variable_name",
    );
    if (!expression && nullRet) {
      responses.push({ statusCode: "204", description: "", confidence: "medium" });
      continue;
    }
    if (!expression) continue;

    let response: DiscoveredResponse | null = null;
    if (expression.type === "variable_name") {
      const assigned = interpretAssignedResponse(handler, expression, model, gaps);
      if (assigned) response = assigned;
      else {
        const schema = inferVariableModel(handler, expression, model);
        if (schema) {
          response = {
            statusCode: "200",
            description: "",
            confidence: "medium",
            content: [{ mediaType: "application/json", schema }],
          };
        }
      }
    } else {
      response = interpretResponse(expression, model, gaps, handler);
    }
    if (response) responses.push(response);
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }

  const merged = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = merged.get(response.statusCode);
    if (!existing || confidenceRank(response.confidence) > confidenceRank(existing.confidence)) {
      merged.set(response.statusCode, response);
    }
  }
  return [...merged.values()];
}

function confidenceRank(confidence: Confidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function interpretResponse(
  expression: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
  handler: TsNode,
): DiscoveredResponse | null {
  // return new JsonResponse([...], $status) / new Response(...) / new StreamedResponse.
  if (expression.type === "object_creation_expression") {
    const name = expression.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text
      .split("\\").pop();
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];
    if (name === "JsonResponse") {
      const status = integerText(argNodes[1]) ?? "200";
      const payload = argNodes[0];
      if (!payload) {
        return {
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: {} }],
        };
      }
      const schema = inferValueSchema(payload, model, handler);
      if (!schema || !Object.keys(schema).length) return unknownJsonResponse(status, gaps);
      return {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema }],
      };
    }
    if (name === "Response") {
      // Symfony's base Response renders an HTML (or streamed) payload.
      const status = integerText(argNodes[1]) ?? "200";
      return {
        statusCode: status,
        description: "",
        confidence: "medium",
        content: [{ mediaType: "text/html", schema: { type: "string" } }],
      };
    }
    if (name === "StreamedResponse" || name === "BinaryFileResponse") {
      return binaryResponse(integerText(argNodes[1]) ?? "200");
    }
    if (name && model.analysis.classes.has(name)) {
      const ref = ensurePhpComponent(name, model);
      if (ref) {
        return {
          statusCode: "200",
          description: "",
          confidence: "medium",
          content: [{ mediaType: "application/json", schema: ref }],
        };
      }
    }
    return null;
  }

  // return $this->json([...], $status) / $this->render(...) / $this->redirectToRoute(...).
  if (expression.type === "member_call_expression") {
    const receiver = expression.namedChildren.find((c) => c.type === "variable_name");
    const method = expression.namedChildren.find((c) => c.type === "name")?.text ?? "";
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];
    const isThis = receiver?.text === "$this";

    if (isThis && method === "json") {
      const status = integerText(argNodes[1]) ?? "200";
      const payload = argNodes[0];
      if (!payload) {
        return {
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: {} }],
        };
      }
      const schema = inferValueSchema(payload, model, handler);
      if (!schema || !Object.keys(schema).length) return unknownJsonResponse(status, gaps);
      return {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema }],
      };
    }
    if (isThis && (method === "render" || method === "renderView")) {
      return {
        statusCode: "200",
        description: "",
        confidence: "medium",
        content: [{ mediaType: "text/html", schema: { type: "string" } }],
      };
    }
    if (isThis && (method === "redirectToRoute" || method === "redirect")) {
      // third positional arg is the status code in redirectToRoute($route, $params, $status).
      const status = integerText(argNodes[2]) ?? "302";
      return { statusCode: status, description: "", confidence: "high" };
    }
    if (isThis && (method === "file" || method === "download")) {
      return binaryResponse("200");
    }
    // Bare $model->toArray() / ->json() member call returned directly.
    if (method.toLowerCase() === "toarray") {
      return {
        statusCode: "200",
        description: "",
        confidence: "medium",
        content: [{ mediaType: "application/json", schema: { type: "object" } }],
      };
    }
    return null;
  }

  // return [...];
  if (expression.type === "array_creation_expression") {
    const schema = inferArraySchema(expression, model, handler);
    if (schema && Object.keys(schema).length) {
      return {
        statusCode: "200",
        description: "",
        confidence: "high",
        content: [{ mediaType: "application/json", schema }],
      };
    }
  }

  // return Model::all() / Model::find($id);
  if (expression.type === "scoped_call_expression") {
    const schema = inferValueSchema(expression, model, handler);
    if (schema && Object.keys(schema).length) {
      return {
        statusCode: "200",
        description: "",
        confidence: "medium",
        content: [{ mediaType: "application/json", schema }],
      };
    }
  }

  return null;
}

/** Follow `$x = new JsonResponse(...)` / `$x = $this->json(...)` then return $x. */
function interpretAssignedResponse(
  handler: TsNode,
  variable: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
): DiscoveredResponse | null {
  const varText = variable.text;
  for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
    if (lhs?.text !== varText) continue;
    const rhs = assignment.namedChildren.find(
      (c) =>
        c.type === "member_call_expression" ||
        c.type === "object_creation_expression" ||
        c.type === "scoped_call_expression",
    );
    if (rhs) return interpretResponse(rhs, model, gaps, handler);
  }
  return null;
}

// ---------------------------------------------------------------------------
// config/routes.yaml (best-effort)
// ---------------------------------------------------------------------------

function hasRoutesYaml(ctx: ScanContext): boolean {
  return ctx.index.files.some((f) => /config\/routes.*\.ya?ml$/.test(f.path));
}

function yamlRoutes(
  ctx: ScanContext,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  unresolved: DiscoveredUnresolved[],
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const f of ctx.index.files) {
    if (!/config\/routes.*\.ya?ml$/.test(f.path)) continue;
    const text = f.content;
    // Minimal YAML route table reader: each top-level key is a route name, with
    // `path:` and optionally `methods:` and `controller:` lines beneath it.
    const routeBlocks = text.split(/^(?=\S)/m);
    for (const block of routeBlocks) {
      const pathMatch = /^\s+path:\s*["']?([^\s"']+)["']?\s*$/m.exec(block);
      if (!pathMatch) continue;
      const path = pathMatch[1]!.startsWith("/") ? pathMatch[1]! : `/${pathMatch[1]!}`;
      const methodsMatch = /^\s+methods:\s*\[?([^\]\n]*)\]?\s*$/m.exec(block);
      const verbs = methodsMatch
        ? methodsMatch[1]!.split(",").map((v) => v.trim().toLowerCase()).filter((v) => ROUTE_VERBS.has(v))
        : ["get"];
      const controllerMatch = /^\s+controller:\s*["']?([^"'\s]+)["']?\s*$/m.exec(block);
      let methodNode: TsNode | null = null;
      let className: string | null = null;
      let methodName: string | null = null;
      if (controllerMatch) {
        const [cls, mth] = controllerMatch[1]!.split("::");
        if (cls && mth) {
          const short = cls.split("\\").pop()!;
          className = short;
          methodName = mth;
          methodNode = analysis.classes.get(short)?.methods.get(mth) ?? null;
        }
      }
      const gaps: GapCode[] = [];
      const declaredPathParams = new Set([...path.matchAll(/\{([^}?]+)\??\}/g)].map((m) => m[1]!));
      let parameters: RouteParameter[] = [];
      let requestBody;
      if (methodNode) {
        const collected = collectParameters(methodNode, analysis, model, path, declaredPathParams);
        parameters = collected.parameters;
        requestBody = collected.requestBody;
      }
      for (const p of declaredPathParams) {
        if (!parameters.some((prm) => prm.in === "path" && prm.name === p)) {
          parameters.push({ name: p, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
        }
      }
      const responses: DiscoveredResponse[] = methodNode ? collectResponses(methodNode, model, gaps) : (() => {
        unresolved.push({
          reason: "unresolved-controller",
          message: `routes.yaml references ${controllerMatch?.[1] ?? "?"} which is not in the scanned tree`,
          origin: { file: f.path, line: 0 },
        });
        gaps.push("response-unknown");
        return [{ statusCode: "200", description: "", confidence: "low" as Confidence }];
      })();

      for (const verb of verbs) {
        out.push({
          method: verb,
          path,
          fullPath: path,
          ...(className && methodName ? { operationId: `${className}.${methodName}` } : {}),
          origin: { file: f.path, line: 0 },
          parameters,
          ...(requestBody ? { requestBody } : {}),
          responses,
          tags: className ? [className.replace(/Controller$/, "").replace(/^./, (c) => c.toLowerCase())] : [],
          confidence: methodNode ? "medium" : "low",
          gaps,
          components: [],
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// dedupe / operationId disambiguation
// ---------------------------------------------------------------------------

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
      c.responses.length * 2 + c.parameters.length + (c.requestBody ? 2 : 0) - c.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

function disambiguateOperationIds(routes: RouteCandidate[]): void {
  const used = new Set<string>();
  for (const route of routes) {
    if (!route.operationId) continue;
    if (!used.has(route.operationId)) {
      used.add(route.operationId);
      continue;
    }
    const slug = (route.fullPath ?? route.path)
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    let candidate = `${route.operationId}_${slug}`;
    let n = 2;
    while (used.has(candidate)) candidate = `${route.operationId}_${slug}_${n++}`;
    route.operationId = candidate;
    used.add(candidate);
  }
}
