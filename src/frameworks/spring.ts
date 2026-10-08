/**
 * Spring Boot framework pack (Java, tree-sitter based).
 *
 * Recognizes @RestController classes with @RequestMapping / @GetMapping /
 * @PostMapping and friends, @PathVariable/@RequestParam/@RequestHeader/
 * @RequestBody parameters, @ResponseStatus and SSE via SseEmitter / Flux with
 * produces=text/event-stream.
 */

import {hasOnlyThrowingExit} from "../lang/java/http-shared.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import { extractValidation } from "../lang/java/index.js";
import type { JavaAnalysis } from "../lang/java/index.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  applyValidation,
  annotationElement,
  annotationStringArg,
  buildJavaModelIndex,
  findAnnotation,
  javaBeanProperties,
  javaTypeToSchema,
  listAnnotations,
  type JavaModelIndex,
} from "../lang/java/schema.js";

const MAPPING_ANNOTATIONS = new Set([
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "DeleteMapping",
  "PatchMapping",
  "RequestMapping",
]);

const HTTP_STATUS: Record<string, string> = {
  OK: "200",
  CREATED: "201",
  ACCEPTED: "202",
  NO_CONTENT: "204",
  MOVED_PERMANENTLY: "301",
  FOUND: "302",
  BAD_REQUEST: "400",
  UNAUTHORIZED: "401",
  FORBIDDEN: "403",
  NOT_FOUND: "404",
  CONFLICT: "409",
  UNPROCESSABLE_ENTITY: "422",
  INTERNAL_SERVER_ERROR: "500",
};

const PATH_ELEMENTS = new Set(["value", "path"]);

export const springPack: FrameworkPack<JavaAnalysis> = {
  id: "spring",
  language: "java",
  dependencyHints: ["spring-boot-starter-web", "spring-web"],

  applies(ctx) {
    return (
      ctx.manifest.packages.has("spring-boot-starter-web") ||
      ctx.index.files.some(
        (f) =>
          /\.java$/.test(f.path) &&
          f.content.includes("org.springframework.web.bind.annotation"),
      )
    );
  },

  extract(analysis, ctx) {
    const unresolved: DiscoveredUnresolved[] = [];
    const candidates: RouteCandidate[] = [];
    const model = buildJavaModelIndex(analysis);

    const classAnnotation = (cls: TsNode, name: string): TsNode | null => {
      const mods = cls.namedChildren.find((c) => c.type === "modifiers");
      if (!mods) return null;
      for (const mod of mods.namedChildren) {
        if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
        const id = mod.namedChildren.find((c) => c.type === "identifier");
        if (id && id.text === name) return mod;
      }
      return null;
    };

    for (const [rel, file] of analysis.files) {
      const classes = findAll(file.root, (n) => n.type === "class_declaration");
      for (const cls of classes) {
        const isRest = Boolean(classAnnotation(cls, "RestController"));
        const isController = Boolean(classAnnotation(cls, "Controller"));
        if (!isRest && !isController) continue;

        const clsRequestMapping = classAnnotation(cls, "RequestMapping");
        const classPath = clsRequestMapping ? resolveMapping(clsRequestMapping, "RequestMapping", model, rel).subPath : "";
        if (classPath === null) {
          unresolved.push({ reason: "dynamic-path", message: `Cannot resolve Spring controller mapping ${clsRequestMapping!.text}`, origin: { file: rel, line: cls.startPosition.row + 1 } });
          continue;
        }
        const basePath = normalizePath(classPath);
        const tagName =
          cls.namedChildren.find((c) => c.type === "identifier")?.text
            .replace(/Controller$/, "")
            .replace(/^./, (c) => c.toLowerCase()) ?? "default";
        // Bare method names collide across controllers (50 duplicates on a real
        // app), so qualify the operationId with the controller class. Two Spring
        // methods never share a name inside one class, which keeps the id unique.
        const controllerShort =
          cls.namedChildren.find((c) => c.type === "identifier")?.text ?? "controller";

        const body = childrenOfType(cls, "class_body")[0];
        if (!body) continue;

        const inherited = new Map<string, { method: TsNode; file: string; base: string }>();
        const visited = new Set<string>();
        const visitInterfaces = (owner: TsNode, ownerFile: string): void => {
          const parents = owner.namedChildren.find(n => n.type === "super_interfaces" || n.type === "extends_interfaces");
          const list = parents?.namedChildren.find(n => n.type === "type_list");
          for (const parent of list?.namedChildren ?? parents?.namedChildren ?? []) {
            const name = parent.type === "generic_type" ? parent.namedChildren[0]?.text : parent.text;
            if (!name) continue;
            const def = model.resolveDef(name, ownerFile);
            if (!def) {
              unresolved.push({ reason: "handler-unresolved", message: `Controller ${controllerShort}: interface ${name} source is missing; generate/include its Java sources to resolve inherited mappings.`, origin: { file: ownerFile, line: parent.startPosition.row + 1 } });
              continue;
            }
            if (visited.has(def.fqn)) continue;
            visited.add(def.fqn);
            const interfaceBody = def.node.namedChildren.find(n => n.type === "interface_body");
            const typeMapping = classAnnotation(def.node, "RequestMapping");
            const interfacePath = typeMapping ? resolveMapping(typeMapping, "RequestMapping", model, def.file).subPath : "";
            if (interfacePath === null) {
              unresolved.push({ reason: "dynamic-path", message: `Cannot resolve Spring interface mapping ${typeMapping!.text}`, origin: { file: def.file, line: def.node.startPosition.row + 1 } });
              continue;
            }
            const inheritedBase = normalizePath(interfacePath);
            for (const method of interfaceBody ? childrenOfType(interfaceBody, "method_declaration") : []) {
              if (!inherited.has(methodSignature(method))) inherited.set(methodSignature(method), { method, file: def.file, base: inheritedBase });
            }
            visitInterfaces(def.node, def.file);
          }
        };
        visitInterfaces(cls, rel);

        // Injected bean fields (constructor / @Autowired / @Resource / Lombok
        // @AllArgsConstructor all materialise as ordinary private fields here).
        // Mapping field name -> declared type lets a raw-ResponseEntity handler
        // follow `return service.method(...)` to the service method's return type.
        const fieldTypes = fieldTypesOf(cls);

        const implementations = new Map(childrenOfType(body, "method_declaration").map(method => [methodSignature(method), method]));
        const signatures = new Set([...implementations.keys(), ...inherited.keys()]);
        for (const signature of signatures) {
          const implementation = implementations.get(signature);
          const contract = inherited.get(signature);
          const ownMapping = implementation && listAnnotations(implementation).some(a => MAPPING_ANNOTATIONS.has(a.name));
          const method = ownMapping ? implementation! : contract?.method ?? implementation!;
          const contractFile = method === implementation ? rel : contract!.file;
          const annotations = listAnnotations(method);
          const mapping = annotations.find((a) => MAPPING_ANNOTATIONS.has(a.name));
          if (!mapping) continue;
          // A method writes a response body only under @RestController, or a
          // class/method-level @ResponseBody. A traditional @Controller method
          // without it resolves a server-rendered view (HTML), not JSON.
          const responseBody =
            isRest ||
            Boolean(classAnnotation(cls, "ResponseBody")) ||
            Boolean(findAnnotation(method, new Set(["ResponseBody"])));

          const { verb, subPath } = resolveMapping(mapping.node, mapping.name, model, contractFile);
          if (subPath === null) {
            unresolved.push({ reason: "dynamic-path", message: `Cannot resolve Spring mapping ${mapping.node.text}`, origin: { file: contractFile, line: mapping.node.startPosition.row + 1 } });
            continue;
          }
          const fullPath = joinPath(basePath || contract?.base || "", normalizePath(subPath));
          const pathParams = new Set(
            [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => stripRegex(m[1]!)),
          );

          const origin: SourceLocation = {
            file: contractFile,
            line: method.startPosition.row + 1,
          };

          const { parameters, requestBody, gaps } = collectParameters(
            method,
            model,
            pathParams,
            contractFile,
          );

          const producesEventStream = annotationProducesEventStream(mapping.node);
          const returnType =
            method.namedChildren.find(
              (c) =>
                c.type === "type_identifier" ||
                c.type === "generic_type" ||
                c.type === "void_type" ||
                c.type === "array_type" ||
                c.type === "scoped_identifier" ||
                c.type === "scoped_type_identifier",
            ) ?? null;

          const isStreamingEmitter =
            returnType !== null &&
            /ResponseBodyEmitter|StreamingResponseBody/.test(returnType.text);
          const isSse =
            producesEventStream ||
            (returnType && /SseEmitter|ServerSentEvent/.test(returnType.text)) ||
            (isStreamingEmitter && /text\/event-stream/.test(method.text)) ||
            (returnType === null && /text\/event-stream/.test(method.text));

          const throwing = hasOnlyThrowingExit(implementation ?? method);
          let responses: DiscoveredResponse[];
          let extensions: Record<string, unknown> | undefined;
          if (!responseBody) {
            // Traditional Spring MVC: the method resolves a server-rendered
            // view (String view name, ModelAndView, or "redirect:/forward:").
            responses = collectMvcViewResponse(implementation ?? method, returnType, throwing, gaps);
          } else {
            if (throwing) gaps.push("response-unknown");
            responses = throwing
              ? [{ statusCode: "default", description: "Exception response requires advice resolution", confidence: "low" }]
              : isSse
                ? collectSseResponse(implementation ?? method, returnType, model, gaps, contractFile)
                : collectJsonResponse(implementation ?? method, mapping.node, verb, returnType, model, gaps, contractFile, fieldTypes);
            extensions = isSse ? { "x-protocol": "sse" } : undefined;
          }

          // Swagger/OpenAPI annotations on generated interfaces are explicit
          // response contracts, including error DTOs absent from the return type.
          if (responseBody && !isSse) {
            for (const declared of annotatedResponses(method, model, contractFile)) {
              if (throwing && /^2\d\d$/.test(declared.statusCode)) continue;
              const existing = responses.find(response => response.statusCode === declared.statusCode);
              if (existing) {
                if (declared.content?.length) existing.content = declared.content;
              } else responses.push(declared);
            }
          }

          candidates.push({
            method: verb,
            path: fullPath,
            fullPath,
            operationId: `${controllerShort}_${
              method.namedChildren.find((c) => c.type === "identifier")?.text ?? "op"
            }`,
            origin,
            parameters,
            ...(requestBody ? { requestBody } : {}),
            responses,
            tags: [tagName],
            ...(extensions ? { extensions } : {}),
            confidence: gaps.length ? "medium" : "high",
            gaps,
            components: [],
            handlerSource: sliceNode(implementation ?? method),
          });
        }
      }
    }

    const components = [...model.components.entries()].map(([name, schema]) => ({
      name,
      schema,
    }));
    const securitySchemes: DiscoveredSecurityScheme[] = [];
    const servers = detectServers(ctx);

    const routes = disambiguateOperationIds(dedupe(candidates));
    return { routes, unresolved, components, securitySchemes, servers };
  },
};

/**
 * Two controllers in different packages can share a simple name, which makes
 * `<Class>_<method>` collide. As a last resort, suffix the 2nd and later
 * collisions with an occurrence number; the first occurrence keeps its name.
 */
function disambiguateOperationIds(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, number>();
  for (const route of routes) {
    const base = route.operationId;
    if (!base) continue;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if (count > 1) route.operationId = `${base}_${count}`;
  }
  return routes;
}

function resolveMapping(
  node: TsNode,
  annotationName: string,
  model: JavaModelIndex,
  file: string,
): { verb: string; subPath: string | null } {
  let verb = annotationName
    .replace("Mapping", "")
    .toLowerCase()
    .replace("request", "get");
  if (annotationName === "RequestMapping") {
    const methodElement = annotationElement(node, "method");
    if (methodElement) {
      // `method = RequestMethod.POST` (fully qualified field access) or the
      // static-imported bare `method = POST` both declare the verb. Match the
      // qualified constant first, then fall back to a bare HTTP verb token so
      // a static import does not silently default to GET.
      const qualified = /RequestMethod\.([A-Z]+)/.exec(methodElement.text);
      if (qualified) {
        verb = qualified[1]!.toLowerCase();
      } else {
        const bare = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\b/.exec(
          methodElement.text,
        );
        if (bare) verb = bare[1]!.toLowerCase();
      }
    }
  }
  const expression = annotationElement(node, "value") ?? annotationElement(node, "path");
  const subPath = expression ? mappingString(expression, model, file) : annotationStringArg(node, PATH_ELEMENTS) ?? "";
  return { verb, subPath };
}

function annotationProducesEventStream(node: TsNode): boolean {
  const produces = annotationElement(node, "produces");
  return Boolean(
    produces && /text\/event-stream|TEXT_EVENT_STREAM/i.test(produces.text),
  );
}

/**
 * Spring binding annotations: each pins a parameter to a specific source.
 * Validation annotations (@Valid, @Validated) do not, so a POJO carrying only
 * those is still an implicit command object bound from query parameters.
 *
 * Framework-injected arguments that are resolved outside the HTTP request
 * (the security principal via @AuthenticationPrincipal, SpEL bean values via
 * @Value, request/session attributes) are also "bound": they must never be
 * treated as implicit @RequestParam values or expanded as query command beans.
 */
const BINDING_ANNOTATIONS = new Set([
  "PathVariable",
  "RequestParam",
  "RequestHeader",
  "CookieValue",
  "RequestBody",
  "RequestPart",
  "ModelAttribute",
  "RequestAttribute",
  "SessionAttribute",
  "AuthenticationPrincipal",
  "Value",
]);

const SIMPLE_BIND_TYPES = new Set([
  "String",
  "CharSequence",
  "Integer",
  "int",
  "Long",
  "long",
  "Short",
  "short",
  "Byte",
  "byte",
  "Boolean",
  "boolean",
  "Double",
  "double",
  "Float",
  "float",
  "BigDecimal",
  "BigInteger",
  "Number",
  "UUID",
  "LocalDate",
  "LocalDateTime",
  "OffsetDateTime",
  "ZonedDateTime",
  "Instant",
  "Date",
]);

function collectParameters(
  method: TsNode,
  model: JavaModelIndex,
  pathParams: Set<string>,
  rel: string,
): {
  parameters: RouteParameter[];
  requestBody?: {
    required: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
  gaps: GapCode[];
} {
  const parameters: RouteParameter[] = [];
  const gaps: GapCode[] = [];
  let requestBody:
    | { required: boolean; content: DiscoveredMediaType[]; confidence: Confidence }
    | undefined;

  const paramsNode = childrenOfType(method, "formal_parameters")[0];
  if (!paramsNode) return { parameters, gaps: [] };

  const addParam = (
    location: RouteParameter["in"],
    name: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    required: boolean,
  ) => {
    if (parameters.some((p) => p.in === location && p.name === name)) return;
    parameters.push({
      name,
      in: location,
      required: location === "path" ? true : required,
      ...(schema && Object.keys(schema).length ? { schema } : {}),
      confidence,
    });
  };

  const isRequiredFalse = (annotation: TsNode): boolean => {
    const required = annotationElement(annotation, "required");
    return Boolean(required && required.text.trim() === "false");
  };

  const expandModel = (typeNode: TsNode, location: RouteParameter["in"]) => {
    const typeName = typeNameOf(typeNode);
    if (!typeName) return;
    const def = model.resolveDef(typeName, rel);
    if (!def) return;
    for (const property of javaBeanProperties(def, model)) {
      addParam(
        location,
        property.name,
        Object.keys(property.schema).length ? property.schema : undefined,
        "high",
        property.required,
      );
    }
  };

  for (const param of childrenOfType(paramsNode, "formal_parameter")) {
    const annotations = listAnnotations(param);
    const nameNode = childrenOfType(param, "identifier").pop();
    const typeNode = param.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "array_type" ||
        c.type === "integral_type" ||
        c.type === "floating_point_type" ||
        c.type === "boolean_type" ||
        c.type === "scoped_type_identifier",
    );

    const pathVar = annotations.find((a) => a.name === "PathVariable");
    const requestParam = annotations.find((a) => a.name === "RequestParam");
    const requestHeader = annotations.find((a) => a.name === "RequestHeader");
    const cookieValue = annotations.find((a) => a.name === "CookieValue");
    const requestPart = annotations.find((a) => a.name === "RequestPart");
    const modelAttr = annotations.find((a) => a.name === "ModelAttribute");
    const body = annotations.find((a) => a.name === "RequestBody");

    if (pathVar) {
      const name =
        annotationStringArg(pathVar.node, new Set(["value", "name"])) ??
        nameNode?.text;
      if (name) {
        addParam(
          "path",
          name,
          typeNode ? applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param)) : { type: "string" },
          "high",
          !isRequiredFalse(pathVar.node),
        );
      }
      continue;
    }

    if (requestParam) {
      const name =
        annotationStringArg(requestParam.node, new Set(["value", "name"])) ??
        nameNode?.text;
      const hasDefault = Boolean(annotationElement(requestParam.node, "defaultValue"));
      const required = !isRequiredFalse(requestParam.node) && !hasDefault;
      if (name) {
        addParam(
          "query",
          name,
          typeNode ? applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param)) : undefined,
          "high",
          required,
        );
      }
      continue;
    }

    if (requestHeader) {
      const explicitName =
        annotationStringArg(requestHeader.node, new Set(["value", "name"]));
      const name = explicitName ?? nameNode?.text;
      if (name) {
        addParam(
          "header",
          explicitName ? name : name.toLowerCase(),
          typeNode ? applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param)) : { type: "string" },
          "high",
          !isRequiredFalse(requestHeader.node),
        );
      }
      continue;
    }

    if (cookieValue) {
      const name =
        annotationStringArg(cookieValue.node, new Set(["value", "name"])) ??
        nameNode?.text;
      if (name) {
        addParam(
          "cookie",
          name,
          typeNode ? applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param)) : { type: "string" },
          "high",
          !isRequiredFalse(cookieValue.node),
        );
      }
      continue;
    }

    if (requestPart) {
      const partName =
        annotationStringArg(requestPart.node, new Set(["value", "name"])) ??
        nameNode?.text ??
        "file";
      const isFile = typeNode && /MultipartFile|Resource/.test(typeNode.text);
      requestBody = {
        required: !isRequiredFalse(requestPart.node),
        content: [
          {
            mediaType: "multipart/form-data",
            schema: {
              type: "object",
              properties: {
                [partName]: isFile
                  ? { type: "string", format: "binary" }
                  : typeNode
                    ? applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param))
                    : { type: "string" },
              },
              required: [partName],
            },
          },
        ],
        confidence: "high",
      };
      continue;
    }

    if (body && typeNode) {
      const schema = applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param));
      if (schema && Object.keys(schema).length) {
        requestBody = {
          required: !isRequiredFalse(body.node),
          content: [{ mediaType: "application/json", schema }],
          confidence: "high",
        };
      } else {
        gaps.push("body-schema-unknown");
      }
      continue;
    }

    if (modelAttr && typeNode) {
      expandModel(typeNode, "query");
      continue;
    }

    // Parameters without any binding annotation: Spring MVC treats simple
    // types as implicit @RequestParam and POJOs as implicit command objects
    // (query binding). Validation-only annotations such as @Validated do not
    // change this rule.
    if (typeNode && !annotations.some((a) => BINDING_ANNOTATIONS.has(a.name))) {
      const simple = typeNameOf(typeNode);
      const def = model.resolveDef(simple, rel);
      if (def) {
        expandModel(typeNode, "query");
      } else if (simple && SIMPLE_BIND_TYPES.has(simple) && nameNode) {
        addParam(
          "query",
          nameNode.text,
          applyValidation(javaTypeToSchema(typeNode, model, 0, undefined, rel), extractValidation(param)),
          "high",
          false,
        );
      }
    }
  }

  for (const name of pathParams) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      addParam("path", name, { type: "string" }, "low", true);
    }
  }

  return {
    parameters,
    ...(requestBody ? { requestBody } : {}),
    gaps,
  };
}

function typeNameOf(node: TsNode): string {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "scoped_type_identifier") {
    return node.text.slice(node.text.lastIndexOf(".") + 1);
  }
  if (node.type === "generic_type") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? "";
  }
  if (node.type === "integral_type") return node.text;
  if (node.type === "floating_point_type") return node.text;
  if (node.type === "boolean_type") return "boolean";
  return "";
}

function isBinaryReturn(node: TsNode | null): boolean {
  if (!node) return false;
  const text = node.text;
  // org.springframework.core.io.Resource, byte[] and their ResponseEntity
  // wrappers all stream binary payloads.
  return (
    /(^|[.\s<])Resource(\s*[>,)]|$)/.test(text) ||
    /byte\s*\[\s*]/.test(text)
  );
}

/**
 * Resolve the response of a traditional Spring MVC controller method that
 * resolves a server-rendered view (no @ResponseBody). A String return is a
 * view name ("redirect:.." issues a 302; forwarding requires target resolution), ModelAndView/View render
 * HTML 200, and a method that always throws surfaces the container error page.
 */
function collectMvcViewResponse(
  method: TsNode,
  returnType: TsNode | null,
  throwing: boolean,
  gaps: GapCode[],
): DiscoveredResponse[] {
  const html = (statusCode: string, confidence: Confidence): DiscoveredResponse => ({
    statusCode,
    description: "",
    confidence,
    content: [{ mediaType: "text/html", schema: { type: "string" } }],
  });

  if (throwing) {
    return [{ ...html("500", "low"), description: "Exception renders the container error page" }];
  }

  const typeText = returnType?.text ?? "";
  const constructsView =
    /ModelAndView|View\b/.test(typeText) ||
    Boolean(findFirst(method, (n) =>
      n.type === "object_creation_expression" && /ModelAndView|\bView$/.test(n.text)));

  const returns = findAll(method, (n) => n.type === "return_statement");
  let sawForward = false;
  let sawRedirect = false;
  let sawViewName = false;
  for (const ret of returns) {
    const lit = findFirst(ret, (n) => n.type === "string_literal");
    const text = lit?.text.replace(/^["']|["']$/g, "") ?? "";
    if (/^redirect:/.test(text)) sawRedirect = true;
    else if (/^forward:/.test(text)) sawForward = true;
    else if (text) sawViewName = true;
  }

  if (sawForward) {
    gaps.push("response-unknown");
    return [
      { statusCode: "default", description: "Response depends on the forwarded resource", confidence: "low" },
      ...(sawRedirect ? [{ statusCode: "302", description: "Redirect", confidence: "medium" as const }] : []),
      ...(sawViewName ? [html("200", "medium")] : []),
    ];
  }
  if (constructsView) return [html("200", "high")];

  // String view names: a redirect-only handler returns 302; a handler that may
  // also render a view documents both outcomes.
  if (returns.length > 0 && (sawRedirect || sawViewName || /String/.test(typeText))) {
    const out: DiscoveredResponse[] = [];
    if (!sawRedirect || sawViewName) out.push(html("200", "medium"));
    if (sawRedirect) out.push({ statusCode: "302", description: "Redirect", confidence: "medium" });
    return out.length ? out : [html("200", "low")];
  }

  // void / implicit view-name resolution still renders HTML.
  return [html("200", "low")];
}

function collectJsonResponse(
  method: TsNode,
  mapping: TsNode,
  verb: string,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
  fieldTypes: Map<string, TsNode>,
): DiscoveredResponse[] {
  const status = resolveStatus(method) ?? "200";
  void mapping;
  void verb;
  if (!returnType || returnType.type === "void_type") {
    return [{ statusCode: status, description: "", confidence: "high" }];
  }
  if (isBinaryReturn(returnType)) {
    return [
      {
        statusCode: status,
        description: "",
        confidence: "high",
        content: [
          {
            mediaType: "application/octet-stream",
            schema: { type: "string", format: "binary" },
          },
        ],
      },
    ];
  }
  const schema = javaTypeToSchema(returnType, model, 0, undefined, rel);
  if (!schema || !Object.keys(schema).length) {
    // Raw envelopes (e.g. `ResponseEntity` with no type argument) unwrap to an
    // empty schema. When the handler body ends in `return service.method(...)`,
    // follow the call to the bean method's DECLARED return type rather than
    // fabricating an empty response.
    const followed = followServiceReturnType(method, fieldTypes, model, rel);
    if (followed && Object.keys(followed).length) {
      return [
        {
          statusCode: status,
          description: "",
          confidence: "high",
          content: [{ mediaType: "application/json", schema: followed }],
        },
      ];
    }
    gaps.push("response-unknown");
    return [
      {
        statusCode: status,
        description: "",
        confidence: "low",
        content: [{ mediaType: "application/json" }],
      },
    ];
  }
  return [
    {
      statusCode: status,
      description: "",
      confidence: "high",
      content: [{ mediaType: "application/json", schema }],
    },
  ];
}

/**
 * Injected bean fields declared on the controller, keyed by field name. Both
 * concrete `@Service` classes and interface-typed collaborators are recorded;
 * the interface's own method signatures already carry the return types we need,
 * so a separate impl lookup is unnecessary.
 */
function fieldTypesOf(cls: TsNode): Map<string, TsNode> {
  const map = new Map<string, TsNode>();
  const body = childrenOfType(cls, "class_body")[0];
  if (!body) return map;
  for (const field of childrenOfType(body, "field_declaration")) {
    const mods = field.namedChildren.find((c) => c.type === "modifiers");
    if (mods && /\bstatic\b/.test(mods.text)) continue;
    const typeNode = field.namedChildren.find((c) =>
      [
        "type_identifier",
        "generic_type",
        "scoped_identifier",
        "scoped_type_identifier",
      ].includes(c.type),
    );
    if (!typeNode) continue;
    for (const declarator of findAll(field, (n) => n.type === "variable_declarator")) {
      const name = declarator.namedChildren.find((c) => c.type === "identifier");
      if (name) map.set(name.text, typeNode);
    }
  }
  return map;
}

/** Resolve a method-invocation receiver to an injected field name. */
function receiverFieldName(receiver: TsNode): string | null {
  if (receiver.type === "identifier") return receiver.text;
  // `this.service.method(...)`.
  if (receiver.type === "field_access") {
    const usesThis = receiver.namedChildren.some((c) => c.type === "this");
    const tail = receiver.namedChildren.find((c) => c.type === "identifier");
    if (usesThis && tail) return tail.text;
  }
  return null;
}

/** Find a method declaration by name within a class/interface body. */
function findMethodNode(container: TsNode, name: string): TsNode | null {
  const body = container.namedChildren.find(
    (c) => c.type === "class_body" || c.type === "interface_body",
  );
  if (!body) return null;
  for (const method of childrenOfType(body, "method_declaration")) {
    const id = method.namedChildren.find((c) => c.type === "identifier");
    if (id && id.text === name) return method;
  }
  return null;
}

/** Extract the declared return-type node of a method/abstract-method declaration. */
function declaredReturnTypeOf(method: TsNode): TsNode | null {
  return (
    method.namedChildren.find(
      (c) =>
        c.type === "type_identifier" ||
        c.type === "generic_type" ||
        c.type === "void_type" ||
        c.type === "array_type" ||
        c.type === "scoped_identifier" ||
        c.type === "scoped_type_identifier",
    ) ?? null
  );
}

/**
 * A followed schema is only committed when it names a concrete shape: a $ref to
 * a project component, an array of such, or a scalar / populated object. Free
 * forms (`Object`, `Map<,>`, `JsonNode` -> bare object) are deliberately
 * rejected so dynamic responses keep their honest gap instead of being laundered
 * into a fabricated schema.
 */
function isConcreteFollowedSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if ((schema as { $ref?: string }).$ref) return true;
  const asObject = schema as {
    type?: string;
    items?: JsonSchema;
    properties?: Record<string, unknown>;
  };
  if (asObject.type === "array") {
    return Boolean(asObject.items) && isConcreteFollowedSchema(asObject.items);
  }
  if (
    asObject.type === "string" ||
    asObject.type === "integer" ||
    asObject.type === "number" ||
    asObject.type === "boolean"
  ) {
    return true;
  }
  if (asObject.type === "object" && asObject.properties) {
    return Object.keys(asObject.properties).length > 0;
  }
  return false;
}

/**
 * Follow the service call(s) inside the handler's return statements to the bean
 * method's declared return type. Bounded to the handler's own block and the
 * direct injected fields; recursion depth and O(n^2) scans are avoided because
 * this path only runs when the declared return type did not already resolve.
 */
function followServiceReturnType(
  method: TsNode,
  fieldTypes: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  if (fieldTypes.size === 0) return undefined;
  const block = childrenOfType(method, "block")[0];
  if (!block) return undefined;
  const returns = findAll(block, (n) => n.type === "return_statement");
  for (const ret of returns) {
    for (const call of findAll(ret, (n) => n.type === "method_invocation")) {
      const schema = schemaFromServiceCall(call, fieldTypes, model, rel);
      if (schema) return schema;
    }
  }
  return undefined;
}

function schemaFromServiceCall(
  call: TsNode,
  fieldTypes: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): JsonSchema | undefined {
  const receiver = call.namedChildren[0];
  const methodName = call.namedChildren[1];
  if (!receiver || !methodName || methodName.type !== "identifier") return undefined;
  const fieldName = receiverFieldName(receiver);
  if (!fieldName) return undefined;
  const fieldTypeNode = fieldTypes.get(fieldName);
  if (!fieldTypeNode) return undefined;
  const serviceTypeName = typeNameOf(fieldTypeNode);
  if (!serviceTypeName) return undefined;
  const serviceDef = model.resolveDef(serviceTypeName, rel);
  if (!serviceDef) return undefined;
  const target = findMethodNode(serviceDef.node, methodName.text);
  if (!target) return undefined;
  const returnType = declaredReturnTypeOf(target);
  if (!returnType || returnType.type === "void_type") return undefined;
  const schema = javaTypeToSchema(returnType, model, 0, undefined, serviceDef.file);
  return isConcreteFollowedSchema(schema) ? schema : undefined;
}

function collectSseResponse(
  method: TsNode,
  returnType: TsNode | null,
  model: JavaModelIndex,
  gaps: GapCode[],
  rel: string,
): DiscoveredResponse[] {
  let itemSchema: JsonSchema | undefined;
  // Prefer events statically extractable from `emitter.send(...)` chains inside
  // the handler body; fall back to the declared generic (Flux<ServerSentEvent<X>>).
  const bodyEvents = extractSseEvents(method, model, rel);
  if (bodyEvents.length) {
    itemSchema = describeSseEvents(bodyEvents);
  }
  if ((!itemSchema || !Object.keys(itemSchema).length) && returnType) {
    // Flux<Foo> or Flux<ServerSentEvent<Foo>>.
    const genericArgs = findFirst(returnType, (n) => n.type === "type_arguments");
    const firstArg = genericArgs?.namedChildren[0];
    if (firstArg) {
      if (firstArg.type === "generic_type" && /ServerSentEvent/.test(firstArg.text)) {
        const inner = findFirst(firstArg, (n) => n.type === "type_arguments")?.namedChildren[0];
        if (inner) itemSchema = javaTypeToSchema(inner, model, 0, undefined, rel);
      } else {
        itemSchema = javaTypeToSchema(firstArg, model, 0, undefined, rel);
      }
    }
  }
  if (!itemSchema || !Object.keys(itemSchema).length) {
    // Keep an explicit empty item schema so the SSE media type is structurally
    // complete; the sse-events-unknown gap is the single honest signal here.
    itemSchema = {};
    gaps.push("sse-events-unknown");
  }
  return [
    {
      statusCode: "200",
      description: "Server-sent events",
      confidence: Object.keys(itemSchema).length ? "high" : "medium",
      content: [
        {
          mediaType: "text/event-stream",
          itemSchema,
        },
      ],
    },
  ];
}

interface SseEvent {
  name?: string;
  data?: JsonSchema;
}

/** Build local-variable declared types from the handler body. */
function localVarTypes(method: TsNode): Map<string, TsNode> {
  const map = new Map<string, TsNode>();
  for (const decl of findAll(method, (n) => n.type === "local_variable_declaration")) {
    const typeNode = decl.namedChildren.find((c) =>
      [
        "type_identifier",
        "generic_type",
        "scoped_identifier",
        "scoped_type_identifier",
      ].includes(c.type),
    );
    if (!typeNode) continue;
    for (const declarator of childrenOfType(decl, "variable_declarator")) {
      const name = declarator.namedChildren.find((c) => c.type === "identifier");
      if (name) map.set(name.text, typeNode);
    }
  }
  return map;
}

/** Extract `SseEmitter.event().name("x").data(...)` chains from the handler. */
function extractSseEvents(
  method: TsNode,
  model: JavaModelIndex,
  rel: string,
): SseEvent[] {
  const localVars = localVarTypes(method);
  const events: SseEvent[] = [];
  const dataCalls = findAll(method, (n) => {
    if (n.type !== "method_invocation") return false;
    return n.namedChildren[1]?.type === "identifier" && n.namedChildren[1].text === "data";
  });
  for (const call of dataCalls) {
    const event = sseEventFromDataCall(call, localVars, model, rel);
    if (event) events.push(event);
  }
  return events;
}

function sseEventFromDataCall(
  dataCall: TsNode,
  localVars: Map<string, TsNode>,
  model: JavaModelIndex,
  rel: string,
): SseEvent | null {
  // Walk the receiver chain: .data(...) <- .name("x")? <- .event() <- SseEmitter.
  let name: string | undefined;
  let isSse = false;
  let node: TsNode | undefined = dataCall;
  let guard = 0;
  while (node && guard++ < 8) {
    const receiver: TsNode | undefined = node.namedChildren[0];
    if (!receiver || receiver.type !== "method_invocation") break;
    const methodName = receiver.namedChildren[1]?.text;
    if (methodName === "name") {
      const literal = findFirst(receiver, (n) => n.type === "string_literal");
      const fragment = literal?.namedChildren.find((c) => c.type === "string_fragment");
      if (fragment) name = fragment.text;
    }
    if (methodName === "event") {
      const base = receiver.namedChildren[0];
      if (base?.type === "identifier" && base.text === "SseEmitter") isSse = true;
    }
    node = receiver;
  }
  if (!isSse) return null;

  const argList = childrenOfType(dataCall, "argument_list")[0];
  const dataArg = argList?.namedChildren.find((c) =>
    ["class_literal", "object_creation_expression", "identifier", "string_literal"].includes(
      c.type,
    ),
  );
  let data: JsonSchema | undefined;
  if (dataArg?.type === "class_literal") {
    const typeId = findFirst(dataArg, (n) => n.type === "type_identifier");
    if (typeId) data = javaTypeToSchema(typeId, model, 0, undefined, rel);
  } else if (dataArg?.type === "object_creation_expression") {
    const typeId = dataArg.namedChildren.find((c) =>
      ["type_identifier", "generic_type", "scoped_type_identifier"].includes(c.type),
    );
    if (typeId) data = javaTypeToSchema(typeId, model, 0, undefined, rel);
  } else if (dataArg?.type === "identifier") {
    const typeNode = localVars.get(dataArg.text);
    if (typeNode) data = javaTypeToSchema(typeNode, model, 0, undefined, rel);
  } else if (dataArg?.type === "string_literal") {
    data = { type: "string" };
  }
  if (!data || !Object.keys(data).length) return null;
  return name ? { name, data } : { data };
}

/**
 * Render extracted SSE events as an item schema. When every event names itself,
 * emit an envelope with an `event` enum and the `data` payload; otherwise the
 * payload schema stands on its own (data type known, names are not).
 */
function describeSseEvents(events: SseEvent[]): JsonSchema {
  const names = events.map((e) => e.name).filter((x): x is string => Boolean(x));
  const dataSchemas = events.map((e) => e.data).filter((x): x is JsonSchema => Boolean(x));
  if (!dataSchemas.length) return {};
  const mergedData = mergeSchemas(dataSchemas);
  if (names.length === events.length) {
    return {
      type: "object",
      properties: {
        event: { type: "string", enum: [...new Set(names)].sort() },
        data: mergedData,
      },
      required: ["event", "data"],
    };
  }
  return mergedData;
}

function mergeSchemas(schemas: JsonSchema[]): JsonSchema {
  const first = schemas[0]!;
  if (schemas.every((s) => JSON.stringify(s) === JSON.stringify(first))) return first;
  return { oneOf: schemas };
}

function resolveStatus(method: TsNode): string | null {
  const responseStatus = findAnnotation(method, new Set(["ResponseStatus"]));
  if (!responseStatus) return null;
  const code =
    annotationElement(responseStatus, "code") ??
    annotationElement(responseStatus, "value");
  if (code) {
    const field = code.namedChildren[code.namedChildren.length - 1];
    if (field?.type === "field_access") {
      const constant = field.namedChildren[field.namedChildren.length - 1];
      if (constant && HTTP_STATUS[constant.text]) return HTTP_STATUS[constant.text];
    }
    if (field && HTTP_STATUS[field.text]) return HTTP_STATUS[field.text];
    const numeric = /\d{3}/.exec(code.text);
    if (numeric) return numeric[0];
  }
  // Positional argument: @ResponseStatus(HttpStatus.CREATED).
  const args = childrenOfType(responseStatus, "annotation_argument_list")[0];
  if (args) {
    const positional = args.namedChildren.find(
      (c) => c.type !== "element_value_pair",
    );
    if (positional) {
      const constant =
        positional.type === "field_access"
          ? positional.namedChildren[positional.namedChildren.length - 1]
          : positional;
      if (constant && HTTP_STATUS[constant.text]) return HTTP_STATUS[constant.text];
      const numeric = /\d{3}/.exec(positional.text);
      if (numeric) return numeric[0];
    }
  }
  return null;
}

function normalizePath(raw: string): string {
  if (!raw) return "";
  let path = raw.trim();
  if (path && !path.startsWith("/")) path = `/${path}`;
  // Spring path variables may carry regex: {id:[0-9]+} or {*path}.
  path = path.replace(/\{(\*?)([A-Za-z0-9_]+)(?::[^}]*)?\}/g, "{$2}");
  return path;
}

function stripRegex(varName: string): string {
  return varName.replace(/^\*/, "");
}

function joinPath(base: string, sub: string): string {
  const joined = `${base}${sub}`.replace(/\/+/g, "/");
  return joined || "/";
}

function sliceNode(node: TsNode): string | undefined {
  const text = node.text;
  return text.length > 8192 ? `${text.slice(0, 8192)}\n// ... truncated` : text;
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

function detectServers(ctx: ScanContext): DiscoveredServer[] {
  // Resource files are not indexed as source; read the standard Spring
  // configuration locations directly.
  const candidates = [
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
    "src/main/resources/application.yaml",
    "config/application.properties",
    "application.properties",
  ];
  for (const rel of candidates) {
    try {
      const content = readFileSync(join(ctx.root, rel), "utf8");
      const match = /(?:^|\n)\s*server\.port\s*[=:]\s*(\d+)/.exec(content);
      if (match) return [{ url: `http://localhost:${match[1]}` }];
    } catch {
      // Try the next conventional location.
    }
  }
  return [];
}

/** Match overloads by signature rather than method name or parameter names. */
function methodSignature(method: TsNode): string {
  const name = method.namedChildren.find(n => n.type === "identifier")?.text ?? "";
  const parameters = method.namedChildren.find(n => n.type === "formal_parameters");
  const types = parameters?.namedChildren.map(parameter => {
    const type = parameter.namedChildren.find(n => n.type !== "modifiers" && n.type !== "identifier" && n.type !== "dimensions");
    return (type?.text ?? "?").replace(/\s+/g, "") + (parameter.namedChildren.some(n => n.type === "dimensions") ? "[]" : "");
  }) ?? [];
  return `${name}(${types.join(",")})`;
}

function mappingString(node: TsNode, model: JavaModelIndex, file: string, seen = new Set<string>()): string | null {
  if (node.type === "string_literal") {
    try { return JSON.parse(node.text); } catch { return null; }
  }
  if (node.type === "element_value_array_initializer" || node.type === "array_initializer") {
    return node.namedChildren.length === 1 ? mappingString(node.namedChildren[0]!, model, file, seen) : null;
  }
  const access = /^([\w.]+)\.([\w]+)$/.exec(node.text);
  if (!access) return null;
  const def = model.resolveDef(access[1]!, file);
  if (!def) return null;
  const key = `${def.fqn}.${access[2]}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const declaration = findAll(def.node, n => n.type === "variable_declarator")
    .find(n => n.namedChildren[0]?.text === access[2]);
  const value = declaration?.namedChildren[1];
  return value ? mappingString(value, model, def.file, seen) : null;
}

function annotatedResponses(method: TsNode, model: JavaModelIndex, file: string): DiscoveredResponse[] {
  const result: DiscoveredResponse[] = [];
  const name = (node: TsNode) => node.namedChildren.find(c => c.type === "identifier")?.text;
  const modifiers = method.namedChildren.find(n => n.type === "modifiers");
  if (!modifiers) return result;
  for (const response of findAll(modifiers, n => n.type === "annotation" && name(n) === "ApiResponse")) {
    const status = annotationStringArg(response, new Set(["responseCode"]));
    if (!status || !/^(?:[1-5]\d\d|[1-5]XX|default)$/.test(status)) continue;
    const content: DiscoveredMediaType[] = [];
    for (const entry of findAll(response, n => n.type === "annotation" && name(n) === "Content")) {
      const mediaType = annotationStringArg(entry, new Set(["mediaType"]));
      if (!mediaType) continue;
      const schemaAnnotation = findAll(entry, n => n.type === "annotation" && name(n) === "Schema")[0];
      const implementation = schemaAnnotation ? annotationElement(schemaAnnotation, "implementation") : null;
      const type = implementation?.namedChildren[0];
      if (!type) continue;
      let schema = javaTypeToSchema(type, model, 0, undefined, file);
      if (findAll(entry, n => n.type === "annotation" && name(n) === "ArraySchema").length) schema = { type: "array", items: schema };
      content.push({ mediaType, schema });
    }
    result.push({ statusCode: status, description: annotationStringArg(response, new Set(["description"])) ?? "", confidence: "high", ...(content.length ? { content } : {}) });
  }
  return result;
}
