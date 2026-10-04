/**
 * Gin framework pack (Go).
 *
 * Deterministic gates:
 *  - receivers must trace through gin.New()/gin.Default() and .Group() chains;
 *  - route paths must be static string literals;
 *  - handler bodies are resolved to package-level functions;
 *  - request/response evidence comes from ShouldBind/Param/Query/JSON calls;
 *  - everything unproven is recorded as an explicit gap, never invented.
 */

import { namespaceComponents, remapSchemaReferences } from "../core/schema-references.js";
import {mergeResponseVariants} from "../core/response-variants.js";

import type {
  Confidence,
  ExtractionResult,
  FrameworkPack,
  GapCode,
  RouteCandidate,
  RouteParameter,
  SourceLocation,
} from "../core/types.js";
import type { JsonSchema, DiscoveredUnresolved } from "@powerduck/x-to-openapi";
import type { GoAnalysis, GoFunction } from "../lang/go/index.js";
import { formTag, receiverTypeName } from "../lang/go/index.js";
import {
  buildGoModelIndex,
  ensureGoComponent,
  followCallToSchema,
  goTypeToSchema,
  goConstructedTypeToSchema,
  resolveGoPayloadValue,
  resolveLocalType,
  type GoModelIndex,
} from "../lang/go/schema.js";
import { convertedParameterSchema } from "../lang/go/httphandler.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import {
  childrenOfType,
  findAll,
  findFirst,
  literalString,
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
]);

const STATUS_CONSTANTS: Record<string, string> = {
  StatusContinue: "100",
  StatusOK: "200",
  StatusCreated: "201",
  StatusAccepted: "202",
  StatusNoContent: "204",
  StatusMovedPermanently: "301",
  StatusFound: "302",
  StatusNotModified: "304",
  StatusBadRequest: "400",
  StatusUnauthorized: "401",
  StatusForbidden: "403",
  StatusNotFound: "404",
  StatusMethodNotAllowed: "405",
  StatusConflict: "409",
  StatusUnprocessableEntity: "422",
  StatusTooManyRequests: "429",
  StatusInternalServerError: "500",
  StatusNotImplemented: "501",
  StatusBadGateway: "502",
  StatusServiceUnavailable: "503",
};

interface Instance {
  id: string;
  file: string;
  name: string;
  prefix: string;
}

function selectorCall(node: TsNode): { receiver: TsNode; method: string; call: TsNode } | null {
  if (node.type !== "call_expression") return null;
  const selector = node.namedChildren[0];
  const args = node.namedChildren[1];
  if (!selector || selector.type !== "selector_expression" || !args || args.type !== "argument_list") {
    return null;
  }
  const receiver = selector.namedChildren[0];
  const field = selector.namedChildren[1];
  if (!receiver || !field || field.type !== "field_identifier") return null;
  return { receiver, method: field.text, call: node };
}

function callName(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field?.text ?? null;
  }
  return null;
}

/** Unqualified function name from a handler argument: `GetTags` or `v1.GetTags`. */
function handlerIdentifierName(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field?.type === "field_identifier" ? field.text : null;
  }
  return null;
}

/** True when the function signature declares a `*gin.Context` parameter. */
function isGinContextHandler(fn: GoFunction): boolean {
  const params = findFirst(fn.node, (n) => n.type === "parameter_list");
  if (!params) return false;
  return params.namedChildren.some((decl) => /\bgin\.Context\b/.test(decl.text));
}

function statusCode(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "int_literal") return node.text.trim();
  if (node.type === "selector_expression") {
    const field = node.namedChildren[1];
    return field ? STATUS_CONSTANTS[field.text] ?? null : null;
  }
  return null;
}

/** Literal composite values (gin.H maps, slices, struct literals). */
function literalSchema(node: TsNode | null, index: GoModelIndex, depth = 0): JsonSchema | null {
  if (!node || depth > 6) return null;

  if (node.type === "unary_expression") {
    return literalSchema(node.namedChildren[0], index, depth + 1);
  }

  if (node.type === "composite_literal") {
    const typeNode = node.namedChildren[0];
    const value = node.namedChildren[1];

    // Empty slice literal: []Type{} -> array of $ref.
    if (typeNode && (typeNode.type === "slice_type" || typeNode.type === "array_type")) {
      return goConstructedTypeToSchema(typeNode, index);
    }

    // Resolve the package qualifier before choosing a component; equal short
    // names in different packages must not share response fields.
    const typeText = typeNode?.text ?? "";
    const baseName = typeText.includes(".") ? typeText.split(".").pop() ?? typeText : typeText;
    if (typeNode && (typeNode.type === "type_identifier" || typeNode.type === "selector_expression" || typeNode.type === "qualified_type") && baseName) {
      if (index.byName.has(baseName)) {
        const schema = goTypeToSchema(typeNode, index, depth + 1);
        return Object.keys(schema).length ? schema : null;
      }
    }

    // gin.H{...} (selector type) or map literal.
    // For a typed map (`map[string]string{...}`), the declared value type is
    // the fallback for entries whose expressions cannot be evaluated.
    let mapValueFallback: JsonSchema | null = null;
    if (typeNode?.type === "map_type") {
      const valueTypeNode = typeNode.namedChildren[1];
      if (valueTypeNode) mapValueFallback = goConstructedTypeToSchema(valueTypeNode, index);
    }
    const properties: Record<string, JsonSchema> = {};
    const elements = value
      ? childrenOfType(value, "keyed_element")
      : [];
    for (const element of elements) {
      const keyNode = unwrapElement(element.namedChildren[0]);
      const valNode = unwrapElement(element.namedChildren[1]);
      if (!keyNode || !valNode) continue;
      const keyText = literalString(keyNode);
      if (!keyText) continue;
      properties[keyText] =
        scalarLiteral(valNode) ??
        literalSchema(valNode, index, depth + 1) ??
        mapValueFallback ??
        {};
    }
    if (value && Object.keys(properties).length > 0) return { type: "object", properties };
    if (typeNode && typeNode.type === "map_type" && mapValueFallback) {
      return { type: "object", additionalProperties: mapValueFallback };
    }
    if (typeNode && typeNode.type === "selector_expression") return { type: "object" };
    return null;
  }

  // error values always expose Error() string; common in gin.H{"error": err.Error()}.
  if (node.type === "call_expression") {
    const callee = node.namedChildren[0];
    if (callee?.type === "selector_expression" && /\.Error$/.test(callee.text)) {
      return { type: "string" };
    }
  }

  return null;
}

function unwrapElement(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  return node.type === "literal_element" ? node.namedChildren[0] ?? node : node;
}

function scalarLiteral(node: TsNode): JsonSchema | null {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    return { type: "string" };
  }
  if (node.type === "int_literal") return { type: "integer" };
  if (node.type === "float_literal") return { type: "number" };
  if (node.type === "true" || node.type === "false") return { type: "boolean" };
  if (node.type === "nil") return { type: "null" };
  return null;
}

function ginPathToOas(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
      params.push(name);
      return `{${name}}`;
    })
    .replace(/\*([A-Za-z0-9_]+)/g, (_match, name) => {
      params.push(name);
      return `{${name}}`;
    });
  return { path: converted, params };
}

function analyzeHandler(
  fn: GoFunction,
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  inputModel: GoModelIndex,
  routeParams: string[],
): {
  parameters: RouteParameter[];
  requestBody: RouteCandidate["requestBody"];
  responses: RouteCandidate["responses"];
  security: RouteCandidate["security"];
  gaps: Set<GapCode>;
  extensions: RouteCandidate["extensions"];
  components: RouteCandidate["components"];
} {
  const parameters: RouteParameter[] = [];
  const gaps = new Set<GapCode>();
  const body = fn.body;
  let requestBody: RouteCandidate["requestBody"];
  const responseStatus = new Map<string, RouteCandidate["responses"][number]>();
  let multipartField: string | null = null;
  const formFields: Record<string, JsonSchema> = {};

  // Adapter wrappers around *gin.Context, e.g. `appG := app.Gin{C: c}`. Their
  // methods are resolved below when they delegate to c.JSON.
  const wrapperVars = new Map<string, string>();
  const noteWrapperLiteral = (idNode: TsNode | undefined, expr: TsNode | undefined) => {
    if (idNode?.type !== "identifier" || !expr) return;
    const composite = findFirst(expr, (n) => n.type === "composite_literal");
    const typeNode = composite?.namedChildren[0];
    const recvName =
      typeNode?.type === "selector_expression" || typeNode?.type === "qualified_type"
        ? typeNode.namedChildren[typeNode.namedChildren.length - 1]?.text
        : undefined;
    if (recvName) wrapperVars.set(idNode.text, recvName);
  };
  if (body) {
    // `appG := app.Gin{C: c}` short variable declarations.
    for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
      const left = decl.namedChildren.find((c) => c.type === "expression_list");
      const right = decl.namedChildren.filter((c) => c.type === "expression_list")[1];
      if (!left || !right) continue;
      for (let i = 0; i < left.namedChildren.length; i++) {
        noteWrapperLiteral(left.namedChildren[i], right.namedChildren[i]);
      }
    }
    // Parenthesized `var ( appG = app.Gin{C: c} )` declarations. A var_spec
    // holds its names as identifiers and its initializers directly (not
    // wrapped in an expression_list); a type-only spec (`form AddTagForm`)
    // has no initializer.
    for (const decl of findAll(body, (n) => n.type === "var_declaration")) {
      for (const spec of childrenOfType(decl, "var_spec")) {
        const names = spec.namedChildren.filter((c) => c.type === "identifier");
        const values = spec.namedChildren.filter(
          (c) => c.type !== "identifier" && c.type !== "type_identifier",
        );
        names.forEach((name, i) => noteWrapperLiteral(name, values[i]));
      }
    }
    // Also cover single `var appG = app.Gin{C: c}` specs at function scope.
    for (const spec of findAll(body, (n) => n.type === "var_spec")) {
      const name = spec.namedChildren.find((c) => c.type === "identifier");
      const value = spec.namedChildren.find((c) => c.type !== "identifier" && c.type !== "type_identifier");
      if (name && value) noteWrapperLiteral(name, value);
    }
  }

  const addResponse = (status: string, response: RouteCandidate["responses"][number]) => {
    const previous = responseStatus.get(status);
    responseStatus.set(status, previous ? mergeResponseVariants(previous, response) : response);
  };

  const referencedVarType = (arg: TsNode | undefined): TsNode | null => {
    if (!arg) return null;
    const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
    if (!target || target.type !== "identifier") return null;
    return resolveLocalType(body, target.text);
  };

  if (body) {
    const calls = findAll(body, (n) => n.type === "call_expression");
    let isSse = false;

    for (const call of calls) {
      let owner = call.parent;
      while (owner && owner.id !== body.id && owner.type !== "func_literal") owner = owner.parent;
      if (owner?.type === "func_literal") continue;
      const sel = selectorCall(call);
      if (!sel) continue;
      // Allow chained context calls such as c.Request.FormFile("image").
      const isChainedFormFile =
        sel.receiver.type === "selector_expression" && sel.method === "FormFile";
      if (sel.receiver.type !== "identifier" && !isChainedFormFile) continue;
      const args = positionalArguments(sel.call);
      const method = sel.method;

      // Adapter wrapper method, e.g. appG.Response(http.StatusOK, code, data).
      if (
        sel.receiver.type === "identifier" &&
        wrapperVars.has(sel.receiver.text) &&
        method !== "JSON"
      ) {
        resolveWrapperResponse(analysis, modelIndex, fn, method, args, wrapperVars.get(sel.receiver.text)!, addResponse);
        continue;
      }

      if (method === "Param" && args[0]) {
        const name = literalString(args[0]);
        if (name && routeParams.includes(name) && !parameters.some((p) => p.name === name)) {
          parameters.push({
            name,
            in: "path",
            required: true,
            schema: convertedParameterSchema(call, analysis),
            confidence: "high",
          });
        }
        continue;
      }

      if (method === "Query" || method === "DefaultQuery") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name)) {
          parameters.push({
            name,
            in: "query",
            required: false,
            schema: convertedParameterSchema(call, analysis),
            confidence: "high",
          });
        }
        continue;
      }

      // PostForm reads the entity body, never the URL query string.
      if (method === "PostForm" || method === "DefaultPostForm") {
        const name = literalString(args[0]);
        if (name) formFields[name] = {type: "string"};
        else gaps.add("body-schema-unknown");
        continue;
      }

      // c.FormFile / c.Request.FormFile / c.SaveUploadedFile: multipart upload.
      if (method === "FormFile" || method === "SaveUploadedFile") {
        multipartField = literalString(args[0]) ?? multipartField;
        continue;
      }

      if (method === "GetHeader" || method === "Header") {
        // c.Header is used both for reading and writing; GetHeader is the read.
        if (method === "GetHeader") {
          const name = literalString(args[0]);
          if (name && !parameters.some((p) => p.name === name)) {
            parameters.push({
              name,
              in: "header",
              required: false,
              schema: { type: "string" },
              confidence: "high",
            });
          }
        }
        continue;
      }

      if (method === "Cookie") {
        const name = literalString(args[0]);
        if (name && !parameters.some((p) => p.name === name && p.in === "cookie")) {
          parameters.push({
            name,
            in: "cookie",
            required: false,
            schema: { type: "string" },
            confidence: "high",
          });
        }
        continue;
      }

      if (method === "Redirect") {
        const status = statusCode(args[0]) ?? "default";
        addResponse(status, { statusCode: status, description: "", confidence: "high" });
        continue;
      }

      if (method === "Data") {
        const status = statusCode(args[0]) ?? "default";
        const mediaType = literalString(args[1]);
        if (mediaType) {
          const binary = mediaType !== "application/json";
          addResponse(status, {
            statusCode: status,
            description: "",
            confidence: "high",
            content: [
              {
                mediaType,
                ...(binary
                  ? { schema: { type: "string", format: "binary" } }
                  : { schema: {} }),
                confidence: "high",
              },
            ],
          });
          if (!binary) gaps.add("response-schema-unknown");
        }
        continue;
      }

      if (method === "AbortWithStatus") {
        const status = statusCode(args[0]) ?? "default";
        addResponse(status, {statusCode: status, description: "", confidence: "high"});
        continue;
      }

      if ((method === "ShouldBindJSON" || method === "BindJSON" || method === "ShouldBind") && args[0]) {
        const typeNode = referencedVarType(args[0]);
        if (typeNode) {
          const schema =
            typeNode.type === "type_identifier"
              ? goTypeToSchema(typeNode, inputModel)
              : goTypeToSchema(typeNode, inputModel);
          if (typeNode.type === "struct_type") {
            // Anonymous struct: inline.
          }
          addBody(schema);
        } else {
          gaps.add("body-schema-unknown");
        }
        continue;
      }

      if ((method === "ShouldBindQuery" || method === "BindQuery") && args[0]) {
        const typeNode = referencedVarType(args[0]);
        if (typeNode?.type === "type_identifier") {
          const struct = modelIndex.byName.get(typeNode.text);
          if (struct) {
            for (const field of struct.fields) {
              const name = formTag(field) ??
                field.goName.charAt(0).toLowerCase() + field.goName.slice(1);
              const required = /binding:"[^"]*required/.test(field.tag ?? "");
              parameters.push({
                name,
                in: "query",
                required,
                schema: goTypeToSchema(field.typeNode, modelIndex),
                confidence: "high",
              });
            }
          }
        }
        continue;
      }

      if (method === "SSEvent") {
        isSse = true;
        continue;
      }

      if (method === "Stream") {
        const hasEventStream = calls.some((other) => {
          const otherSel = selectorCall(other);
          if (!otherSel || otherSel.method !== "Header") return false;
          const headerArgs = positionalArguments(other);
          return (
            literalString(headerArgs[0]) === "Content-Type" &&
            (literalString(headerArgs[1]) ?? "").includes("text/event-stream")
          );
        });
        if (hasEventStream) isSse = true;
        continue;
      }

      if (
        method === "JSON" ||
        method === "IndentedJSON" ||
        method === "PureJSON" ||
        method === "AbortWithStatusJSON"
      ) {
        const statusArg = method === "AbortWithStatusJSON" ? args[0] : args[0];
        const payloadArg = method === "AbortWithStatusJSON" ? args[1] : args[1];
        const status = statusCode(statusArg) ?? "default";
        let schema: JsonSchema | null = null;
        const payload = payloadArg;
        if (payload) {
          if (payload.type === "call_expression") {
            // c.JSON(200, NewUserResponse(u)) / c.JSON(200, svc.GetOrders(ctx)):
            // follow the constructor/service function's return type.
            schema = resolveGoPayloadValue(payload, body, analysis, modelIndex, analysis.vars).schema;
          } else if (payload.type === "identifier") {
            const typeNode = resolveLocalType(body, payload.text);
            if (typeNode) schema = goTypeToSchema(typeNode, modelIndex);
          } else {
            schema = literalSchema(payload, modelIndex);
          }
        }
        addResponse(status, {
          statusCode: status,
          description: "",
          confidence: schema ? "high" : "medium",
          ...(schema
            ? { content: [{ mediaType: "application/json", schema, confidence: schema ? "high" : "medium" }] }
            : {}),
        });
        if (!schema || hasEmptyProperties(schema)) gaps.add("response-schema-unknown");
        continue;
      }

      if (method === "Status") {
        const status = statusCode(args[0]) ?? "default";
        addResponse(status, {statusCode: status, description: "", confidence: "high"});
        continue;
      }
    }

    // Binding helpers that wrap the context, e.g. app.BindAndValid(c, &form),
    // bind a form-tagged struct without a direct c.ShouldBind call.
    if (!requestBody) {
      const bound = detectBoundForm(body, modelIndex);
      if (bound) requestBody = bound;
    }

    // Declared path params never read via c.Param are still valid (middleware).
    for (const name of routeParams) {
      if (!parameters.some((p) => p.name === name && p.in === "path")) {
        parameters.push({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
          confidence: "medium",
        });
      }
    }

    if (isSse) {
      addResponse("200", {
        statusCode: "200",
        description: "Server-Sent Events stream",
        confidence: "medium",
        content: [{ mediaType: "text/event-stream", itemSchema: {}, confidence: "medium" }],
      });
      gaps.add("sse-events-unknown");
    }
  }

  function addBody(schema: JsonSchema) {
    requestBody = {
      required: true,
      confidence: "high",
      content: [{ mediaType: "application/json", schema, confidence: "high" }],
    };
  }

  if (Object.keys(formFields).length && !requestBody && !multipartField) {
    requestBody = {
      required: false, confidence: "medium",
      content: ["application/x-www-form-urlencoded", "multipart/form-data"].map(mediaType => ({
        mediaType, schema: {type: "object", properties: formFields}, confidence: "medium" as const,
      })),
    };
  } else if (Object.keys(formFields).length && requestBody) {
    // Additional form reads may coexist with bound bodies; never discard them.
    const content = requestBody.content.find(media => media.mediaType === "application/x-www-form-urlencoded");
    if (content?.schema?.properties) content.schema = {...content.schema, properties: {...formFields, ...content.schema.properties}};
    else gaps.add("body-schema-unknown");
  }

  // Multipart upload detected via c.FormFile / c.Request.FormFile.
  if (multipartField && !requestBody) {
    requestBody = {
      required: true,
      confidence: "high",
      content: [
        {
          mediaType: "multipart/form-data",
          schema: {
            type: "object",
            properties: { ...formFields, [multipartField]: { type: "string", format: "binary" } },
            required: [multipartField],
          },
          confidence: "high",
        },
      ],
    };
  }

  if (responsesEmpty(responseStatus)) {
    gaps.add("response-unknown");
  } else if (responseStatus.has("default")) {
    // A dynamic-status branch (e.g. a wrapper fed a runtime httpCode) becomes
    // an OAS `default` catch-all. When sibling branches prove concrete codes,
    // the contract is known; only an operation whose every branch is dynamic
    // stays response-unknown.
    const concrete = [...responseStatus.keys()].some((code) => code !== "default");
    if (!concrete) gaps.add("response-unknown");
  }

  return {
    parameters,
    requestBody,
    responses: [...responseStatus.values()],
    security: undefined,
    gaps,
    extensions: isSseExtension(responseStatus),
    components: [],
  };
}

/**
 * Resolve an adapter wrapper method call such as `appG.Response(status, code, data)`
 * by following the receiver method `(g *Gin) Response(...)` to its internal
 * `g.C.JSON(...)` call. Only methods that demonstrably delegate to c.JSON emit a
 * response; otherwise the gap stays honest.
 */
function resolveWrapperResponse(
  analysis: GoAnalysis,
  modelIndex: GoModelIndex,
  _handlerFn: GoFunction,
  method: string,
  callArgs: TsNode[],
  recvTypeName: string,
  addResponse: (status: string, response: RouteCandidate["responses"][number]) => void,
): void {
  const methodFn = analysis.methods.find(
    (m) => receiverTypeName(m) === recvTypeName && m.name === method,
  );
  if (!methodFn?.body) return;

  // Locate the JSON-producing call inside the wrapper method body.
  const jsonCall = findAll(methodFn.body, (n) => n.type === "call_expression").find((call) => {
    const sel = selectorCall(call);
    return sel?.method === "JSON" || sel?.method === "IndentedJSON" || sel?.method === "PureJSON";
  });
  if (!jsonCall) return;

  const jsonArgs = positionalArguments(jsonCall);
  const statusExpr = jsonArgs[0];
  const payloadExpr = jsonArgs[1];

  // Ordered parameter names of the wrapper method, e.g. [httpCode, errCode, data].
  const paramLists = findAll(methodFn.node, (n) => n.type === "parameter_list");
  const paramsList = paramLists[paramLists.length - 1];
  const paramNames: string[] = [];
  if (paramsList) {
    for (const decl of childrenOfType(paramsList, "parameter_declaration")) {
      for (const id of childrenOfType(decl, "identifier")) paramNames.push(id.text);
    }
  }

  // The JSON status argument may reference a method parameter; map it back to
  // the corresponding call-site argument.
  let resolvedStatus: string | null = null;
  if (statusExpr?.type === "identifier") {
    const idx = paramNames.indexOf(statusExpr.text);
    if (idx >= 0) resolvedStatus = statusCode(callArgs[idx]) ?? null;
  }
  if (!resolvedStatus) resolvedStatus = statusCode(statusExpr) ?? "default";

  let schema: JsonSchema | null = null;
  if (payloadExpr) {
    const composite =
      payloadExpr.type === "composite_literal" ? payloadExpr : findFirst(payloadExpr, (n) => n.type === "composite_literal");
    const typeNode = composite?.namedChildren[0];
    if (composite && typeNode?.type === "type_identifier" && modelIndex.byName.has(typeNode.text)) {
      schema = goTypeToSchema(typeNode, modelIndex);
    } else {
      schema = literalSchema(payloadExpr, modelIndex);
    }
    // The envelope is a shared component whose generic payload (Response.Data
    // interface{}) differs per call site (nil on errors, a map/model on success).
    // When the concrete argument is provable, emit an inline envelope so each
    // response carries its real data shape; otherwise keep the shared $ref and
    // honestly leave data unresolved.
    if (composite) {
      const dataSchema = resolveEnvelopePayload(composite, paramNames, callArgs, modelIndex, _handlerFn, analysis);
      if (dataSchema) {
        schema = {
          type: "object",
          properties: {
            code: { type: "integer" },
            msg: { type: "string" },
            data: dataSchema,
          },
          // Response has no omitempty tags, so all three keys are always present;
          // the data value itself may be null on error branches.
          required: ["code", "msg", "data"],
        };
      }
    }
  }

  addResponse(resolvedStatus, {
    statusCode: resolvedStatus,
    description: "",
    confidence: schema ? "high" : "medium",
    ...(schema
      ? { content: [{ mediaType: "application/json", schema, confidence: "high" }] }
      : {}),
  });
}

/**
 * Map a wrapper envelope field whose value is a wrapper parameter (e.g.
 * `Data: data`) back to the concrete argument passed at the call site and
 * derive its schema. Returns null when the payload cannot be statically proven.
 */
function resolveEnvelopePayload(
  envelopeComposite: TsNode,
  paramNames: string[],
  callArgs: TsNode[],
  modelIndex: GoModelIndex,
  handlerFn: GoFunction,
  analysis: GoAnalysis,
): JsonSchema | null {
  const body = envelopeComposite.namedChildren[1];
  if (!body) return null;
  for (const element of childrenOfType(body, "keyed_element")) {
    const keyNode = unwrapElement(element.namedChildren[0]);
    const valNode = unwrapElement(element.namedChildren[1]);
    if (!keyNode || !valNode) continue;
    const keyText = keyNode.type === "identifier" ? keyNode.text : literalString(keyNode);
    if (keyText !== "Data" && keyText !== "data") continue;
    if (valNode.type !== "identifier") return null;
    const idx = paramNames.indexOf(valNode.text);
    if (idx < 0) return null;
    const arg = callArgs[idx];
    if (!arg) return null;
    return callSiteValueSchema(arg, modelIndex, handlerFn, analysis);
  }
  return null;
}

/** Schema for a concrete value supplied at a wrapper call site. */
function callSiteValueSchema(
  node: TsNode,
  modelIndex: GoModelIndex,
  handlerFn: GoFunction,
  analysis: GoAnalysis,
  depth = 0,
): JsonSchema | null {
  if (depth > 6) return null;
  if (node.type === "nil") return { type: "null" };
  if (node.type === "unary_expression") return callSiteValueSchema(node.namedChildren[0], modelIndex, handlerFn, analysis, depth + 1);
  if (node.type === "composite_literal") {
    // A map literal whose values are local values (tags, count): resolve each.
    const schema = literalSchema(node, modelIndex, depth + 1);
    const value = node.namedChildren[1];
    if (schema && (schema as any).properties && value) {
      for (const element of childrenOfType(value, "keyed_element")) {
        const keyNode = unwrapElement(element.namedChildren[0]);
        const valNode = unwrapElement(element.namedChildren[1]);
        const keyText = keyNode && (keyNode.type === "identifier" ? keyNode.text : literalString(keyNode));
        if (!keyText || !valNode) continue;
        if (valNode.type === "identifier" && handlerFn.body) {
          const local = localIdentifierSchema(valNode.text, handlerFn, modelIndex, analysis);
          if (local) (schema as any).properties[keyText] = local;
        }
      }
    }
    return schema;
  }
  if (node.type === "identifier" && handlerFn.body) {
    return localIdentifierSchema(node.text, handlerFn, modelIndex, analysis);
  }
  return literalSchema(node, modelIndex, depth + 1);
}

/** Resolve a handler-local identifier (var/short decl) to a concrete schema. */
function localIdentifierSchema(
  name: string,
  handlerFn: GoFunction,
  modelIndex: GoModelIndex,
  analysis: GoAnalysis,
): JsonSchema | null {
  const body = handlerFn.body;
  if (!body) return null;
  const typeNode = resolveLocalType(body, name);
  if (typeNode) {
    const schema = goTypeToSchema(typeNode, modelIndex);
    return schema && Object.keys(schema).length ? schema : null;
  }
  // x, err := svc.Method(): follow the cross-function/method return type.
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration")) {
    const lists = decl.namedChildren.filter((n) => n.type === "expression_list");
    const left = lists[0];
    const right = lists[1];
    if (!left || !right) continue;
    const index = left.namedChildren.findIndex((c) => c.text === name);
    if (index < 0) continue;
    const call = right.namedChildren.find((c) => c.type === "call_expression");
    if (!call) continue;
    const resolved = followCallToSchema(call, analysis, modelIndex, new Map());
    if (resolved.schema) return resolved.schema;
  }
  // m := make(map[K]V) followed by m["key"] = value assignments: reconstruct the
  // object shape from the indexed stores into the local map.
  const mapProps = mapAssignmentProperties(name, body, modelIndex, handlerFn, analysis);
  if (mapProps) return mapProps;
  return null;
}

/** Resolve a map built via `make(map...)` plus subsequent `m["k"] = v` stores. */
function mapAssignmentProperties(
  name: string,
  body: TsNode,
  modelIndex: GoModelIndex,
  handlerFn: GoFunction,
  analysis: GoAnalysis,
): JsonSchema | null {
  let declaredMap = false;
  for (const decl of findAll(body, (n) => n.type === "short_var_declaration" || n.type === "var_spec")) {
    const lists = decl.namedChildren.filter((n) => n.type === "expression_list");
    const left = decl.type === "short_var_declaration" ? lists[0] : decl;
    const right = lists[1];
    if (!left) continue;
    if (!left.namedChildren.some((c) => c.type === "identifier" && c.text === name)) continue;
    const hasMapType = /map\[/i.test(decl.text) ||
      right?.namedChildren.some((c) => c.type === "map_type" || (c.type === "call_expression" && /make\s*\(\s*map/i.test(c.text)));
    if (hasMapType) declaredMap = true;
  }
  if (!declaredMap) return null;
  const properties: Record<string, JsonSchema> = {};
  for (const assignment of findAll(body, (n) => n.type === "assignment_statement")) {
    const indexExpr = assignment.namedChildren.find((c) => c.type === "index_expression");
    if (!indexExpr) continue;
    const operand = indexExpr.namedChildren[0];
    const keyNode = indexExpr.namedChildren[1];
    if (operand?.type !== "identifier" || operand.text !== name) continue;
    const key = keyNode ? literalString(keyNode) : null;
    if (!key) continue;
    const value = assignment.namedChildren.find((c) => c.type !== "index_expression");
    if (!value) continue;
    const schema = callSiteValueSchema(value, modelIndex, handlerFn, analysis);
    if (schema) properties[key] = schema;
  }
  return Object.keys(properties).length ? { type: "object", properties } : { type: "object" };
}

/**
 * Detect a form-tagged struct bound through a context wrapper helper such as
 * `app.BindAndValid(c, &form)` or `c.Bind(&form)`. Builds a urlencoded request
 * body from the struct's `form:` fields. Returns null when the resolved type is
 * not a known struct with form tags.
 */
function detectBoundForm(
  body: TsNode,
  modelIndex: GoModelIndex,
): RouteCandidate["requestBody"] | null {
  for (const call of findAll(body, (n) => n.type === "call_expression")) {
    const callee = call.namedChildren[0];
    const calleeName =
      callee?.type === "identifier" ? callee.text : callName(callee);
    if (!calleeName || !/bind/i.test(calleeName)) continue;

    const args = positionalArguments(call);
    for (const arg of args) {
      // `&form` address-of local variable.
      const target = arg.type === "unary_expression" ? arg.namedChildren[0] : arg;
      if (!target || target.type !== "identifier") continue;
      const typeNode = resolveLocalType(body, target.text);
      if (!typeNode || typeNode.type !== "type_identifier") continue;
      const struct = modelIndex.byName.get(typeNode.text);
      if (!struct) continue;

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      let hasFormTag = false;
      for (const field of struct.fields) {
        const name = formTag(field);
        if (!name) continue;
        hasFormTag = true;
        properties[name] = goTypeToSchema(field.typeNode, modelIndex);
        if (/binding:"[^"]*required/.test(field.tag ?? "")) required.push(name);
      }
      if (!hasFormTag) continue;

      const schema: JsonSchema = { type: "object", properties };
      if (required.length) schema.required = required;
      return {
        required: true,
        confidence: "high",
        content: [{ mediaType: "application/x-www-form-urlencoded", schema, confidence: "high" }],
      };
    }
  }
  return null;
}

function isSseExtension(
  responses: Map<string, RouteCandidate["responses"][number]>,
): RouteCandidate["extensions"] {

  for (const response of responses.values()) {
    if (response.content?.some((media) => media.mediaType === "text/event-stream")) {
      return { "x-protocol": "sse" };
    }
  }
  return undefined;
}

function responsesEmpty(responses: Map<string, unknown>): boolean {
  return responses.size === 0;
}

/**
 * Literal gin.H maps built from local variables yield empty property schemas.
 * Such a response is only partially proven, so it keeps an honest gap.
 */
function hasEmptyProperties(schema: JsonSchema | null | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (schema.$ref) return false;
  if (schema.type === "object" && schema.properties) {
    const values = Object.values(schema.properties as Record<string, JsonSchema>);
    if (values.some((value) => value && Object.keys(value).length === 0)) return true;
  }
  if (schema.type === "array") {
    return hasEmptyProperties(schema.items as JsonSchema);
  }
  return false;
}

function operationId(method: string, path: string): string {
  const parts = path
    .replace(/[{}*:]/g, "")
    .split(/[/\-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return method.toLowerCase() + parts.join("");
}

export const ginPack: FrameworkPack<GoAnalysis> = {
  id: "gin",
  language: "go",
  dependencyHints: ["github.com/gin-gonic/gin"],

  applies(ctx) {
    if (ctx.manifest.packages.has("github.com/gin-gonic/gin")) return true;
    for (const file of ctx.index.files) {
      if (/\.go$/.test(file.path) && /gin-gonic\/gin/.test(file.content)) return true;
    }
    return false;
  },

  extract(analysis, ctx): ExtractionResult {
    const routes: RouteCandidate[] = [];
    const unresolved: DiscoveredUnresolved[] = [];
    const modelIndex = buildGoModelIndex(analysis);
    const inputModel: GoModelIndex = {...modelIndex, input: true, validated: true, validationTag: "binding", components: new Map()};
    const servers = new Set<string>();

    for (const file of analysis.files.values()) {
      // Registration helpers accept the engine or a router group as a parameter
      // (e.g. `func registerRoutes(api *gin.RouterGroup)`). Their parameter name
      // is bound to the caller instance when the helper is invoked.
      const groupParameterName = (fn: GoFunction): string | null => {
        const params = findFirst(fn.node, (n) => n.type === "parameter_list");
        if (!params) return null;
        for (const parameter of childrenOfType(params, "parameter_declaration")) {
          if (!/\bgin\.(RouterGroup|Engine)\b/.test(parameter.text)) continue;
          const nameNode = childrenOfType(parameter, "identifier")[0];
          if (nameNode) return nameNode.text;
        }
        return null;
      };

      interface RegistrationCall {
        fn: GoFunction;
        paramName: string;
        caller: Instance;
      }
      const registrationCalls: RegistrationCall[] = [];

      const scanScope = (
        scopeRoot: TsNode,
        scopeFile: { path: string; root: TsNode },
        seed: Map<string, Instance>,
      ) => {
        const instances = new Map(seed);

        const registerInstance = (name: string, prefix: string) => {
          instances.set(name, { id: `${scopeFile.path}::${name}`, file: scopeFile.path, name, prefix });
        };

        // Pass 1: engines and groups.
        for (const declaration of findAll(scopeRoot, (n) =>
          n.type === "short_var_declaration" || n.type === "var_declaration" || n.type === "assignment_statement",
        )) {
          const assignments = declaration.type === "var_declaration"
            ? childrenOfType(declaration, "var_spec")
            : [declaration];

          for (const spec of assignments) {
            const names = findAll(spec, (n) => n.type === "identifier");
            const calls = findAll(spec, (n) => n.type === "call_expression");
            for (const call of calls) {
              const sel = selectorCall(call);
              if (!sel || sel.receiver.type !== "identifier") continue;
              const args = positionalArguments(call);

              if (sel.receiver.text === "gin" && (sel.method === "New" || sel.method === "Default")) {
                const name = names[0]?.text;
                if (name) registerInstance(name, "");
              } else if (sel.method === "Group") {
                const parent = instances.get(sel.receiver.text);
                const name = names[0]?.text;
                if (parent && name) {
                  const groupPath = literalString(args[0]) ?? "";
                  registerInstance(name, joinPath(parent.prefix, groupPath));
                }
              }
            }
          }
        }

        // Pass 2: routes.
        for (const call of findAll(scopeRoot, (n) => n.type === "call_expression")) {
          const sel = selectorCall(call);

          // Registration helper call: registerProductRoutes(api) or the
          // qualified form route.Setup(env, ..., gin). The guard below only
          // accepts functions that actually take a *gin.Engine/*RouterGroup,
          // so ordinary selector calls are not mistaken for route helpers.
          const callee = call.namedChildren[0];
          const helperName =
            callee?.type === "identifier"
              ? callee.text
              : callee?.type === "selector_expression"
                ? callee.namedChildren[1]?.text ?? null
                : null;
          if (helperName) {
            const helperArgs = positionalArguments(call);
            const instanceArg = helperArgs.find(
              (a) => a.type === "identifier" && instances.has(a.text),
            );
            const caller = instanceArg ? instances.get(instanceArg.text) : undefined;
            const candidates = analysis.functions.get(helperName) ?? [];
            const helperFn = candidates.find(
              (candidate) => groupParameterName(candidate) !== null,
            );
            const paramName = helperFn ? groupParameterName(helperFn) : null;
            if (caller && helperFn && paramName) {
              registrationCalls.push({ fn: helperFn, paramName, caller });
            }
          }

          if (sel) {
            if (!sel.receiver.type || sel.receiver.type !== "identifier") continue;
            const instance = instances.get(sel.receiver.text);
            if (!instance) continue;
            const args = positionalArguments(call);

            const methods: string[] = [];
            let pathNode: TsNode | undefined;
            if (HTTP_METHODS.has(sel.method.toLowerCase())) {
              methods.push(sel.method.toLowerCase());
              pathNode = args[0];
            } else if (sel.method === "Any") {
              methods.push(...HTTP_METHODS);
              pathNode = args[0];
            } else if (sel.method === "Handle") {
              const verb = literalString(args[0])?.toLowerCase();
              if (verb && HTTP_METHODS.has(verb)) methods.push(verb);
              pathNode = args[1];
            } else {
              continue;
            }

            const rawPath = pathNode ? literalString(pathNode) : null;
            if (rawPath === null) {
              if (pathNode) {
                unresolved.push({
                  reason: "dynamic-path",
                  message: "Gin route path is not a static string literal",
                  origin: { file: scopeFile.path, line: call.startPosition.row + 1 },
                });
              }
              continue;
            }

            const converted = ginPathToOas(rawPath);
            const fullPath = joinPath(instance.prefix, converted.path);
            // Gin accepts a handler chain; the final handler owns the response
            // contract. Named functions (including package-qualified selectors
            // such as v1.GetTags) and inline closures are supported.
            const handlerArgs = args.slice(pathNode === args[0] ? 1 : 2);

            // Skip auto-generated interactive documentation handlers such as
            // `ginSwagger.WrapHandler(swaggerFiles.Handler)`; they serve the
            // Swagger UI rather than a documented API operation.
            const isDocsWrapper = handlerArgs.some((arg) => {
              const callee =
                arg.type === "call_expression"
                  ? arg.namedChildren[0]
                  : undefined;
              return callee?.type === "selector_expression" && /WrapHandler$/.test(callee.text);
            });
            if (isDocsWrapper) continue;

            const terminal = [...handlerArgs]
              .reverse()
              .find((a) => a.type === "identifier" || a.type === "selector_expression" || a.type === "func_literal");

            // Unqualified function name used to look up the package-level handler.
            // A selector handler `v1.GetTags` resolves to the registered `GetTags`.
            const handlerSymbol = handlerIdentifierName(terminal);
            let handlerFn: GoFunction | null = null;
            let handlerNode: TsNode | null = null;
            if (terminal?.type === "func_literal") {
              const block = findFirst(terminal, (c) => c.type === "block") ?? null;
              if (block) {
                handlerFn = {
                  name: "<anonymous>",
                  file: scopeFile.path,
                  node: terminal,
                  body: block,
                  receiver: null,
                };
                handlerNode = terminal;
              }
            } else if (handlerSymbol) {
              const candidates = analysis.functions.get(handlerSymbol) ?? [];
              // A package may declare same-named helpers (e.g. a data-layer
              // `GetTags(page, size, maps)` alongside the HTTP handler
              // `GetTags(c *gin.Context)`). Prefer the function whose
              // signature actually accepts *gin.Context. Method-value handlers
              // such as `tc.Fetch` resolve against receiver methods.
              handlerFn =
                candidates.find(isGinContextHandler) ??
                candidates[0] ??
                analysis.methods.find((m) => m.name === handlerSymbol && isGinContextHandler(m)) ??
                analysis.methods.find((m) => m.name === handlerSymbol) ??
                null;
              handlerNode = handlerFn?.node ?? null;
            }
            const primaryHandler = terminal ? terminal.text : undefined;

            const origin: SourceLocation = {
              file: handlerFn?.file ?? scopeFile.path,
              line: call.startPosition.row + 1,
              symbol: primaryHandler,
            };

            for (const method of methods) {
              const analyzed = handlerFn
                ? analyzeHandler(handlerFn, analysis, modelIndex, inputModel, converted.params)
                : {
                    parameters: converted.params.map((name) => ({
                      name,
                      in: "path" as const,
                      required: true,
                      schema: { type: "string" },
                      confidence: "medium" as Confidence,
                    })),
                    requestBody: undefined,
                    responses: [] as RouteCandidate["responses"],
                    security: undefined,
                    gaps: new Set<GapCode>(["response-unknown"]),
                    extensions: undefined,
                    components: [] as RouteCandidate["components"],
                  };

              const confidence: Confidence = analyzed.gaps.size > 0 ? "medium" : "high";
              routes.push({
                method,
                path: fullPath,
                fullPath,
                origin,
                operationId: operationId(method, fullPath),
                tags: [],
                parameters: analyzed.parameters,
                ...(analyzed.requestBody ? { requestBody: analyzed.requestBody } : {}),
                responses: analyzed.responses,
                ...(analyzed.security?.length ? { security: analyzed.security } : {}),
                ...(analyzed.extensions ? { extensions: analyzed.extensions } : {}),
                confidence,
                gaps: [...analyzed.gaps],
                components: analyzed.components,
                handlerSource: handlerNode?.text.slice(0, 8192),
              });
            }
          }
        }

        // Server detection: r.Run(":8080") or http.ListenAndServe(addr, engine).
        for (const call of findAll(scopeRoot, (n) => n.type === "call_expression")) {
          const sel = selectorCall(call);
          if (!sel) continue;
          const args = positionalArguments(call);
          if (sel.method === "Run" && instances.has(sel.receiver.text)) {
            const addr = literalString(args[0]);
            if (addr) servers.add(addrToUrl(addr));
          }
          if (
            sel.receiver.type === "identifier" &&
            sel.receiver.text === "http" &&
            sel.method === "ListenAndServe"
          ) {
            const addr = literalString(args[0]);
            if (addr) servers.add(addrToUrl(addr));
          }
        }
      };

      scanScope(file.root, file, new Map());

      // Expand registration helpers breadth-first, binding their group
      // parameter to the caller instance (prefix included).
      const visited = new Set<string>();
      let queue = registrationCalls.splice(0, registrationCalls.length);
      while (queue.length) {
        const next: RegistrationCall[] = [];
        for (const item of queue) {
          const visitKey = `${item.fn.file}::${item.fn.name}::${item.caller.prefix}`;
          if (visited.has(visitKey)) continue;
          visited.add(visitKey);
          const before = registrationCalls.length;
          const seed = new Map<string, Instance>();
          seed.set(item.paramName, item.caller);
          const scopeFile = analysis.files.get(item.fn.file) ?? file;
          scanScope(item.fn.node, scopeFile, seed);
          const discovered = registrationCalls.splice(before, registrationCalls.length - before);
          next.push(...discovered);
        }
        queue = next;
      }
    }

    const inputs = namespaceComponents(inputModel.components, new Set([...modelIndex.byName.keys(), ...modelIndex.components.keys()]), "input");
    for (const route of routes) if (route.requestBody) route.requestBody = remapSchemaReferences(route.requestBody, inputs.names);
    return {
      routes: dedupe(routes),
      unresolved,
      components: [...[...modelIndex.components.entries()].map(([name, schema]) => ({name, schema})), ...inputs.components],
      securitySchemes: [],
      servers: [...servers].map((url) => ({ url })),
    };
  },
};

function dedupe(routes: RouteCandidate[]): RouteCandidate[] {
  const seen = new Map<string, RouteCandidate>();
  for (const route of routes) {
    const key = `${route.method} ${route.fullPath}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, route);
      continue;
    }
    const score = (candidate: RouteCandidate) =>
      candidate.parameters.length * 2 +
      candidate.responses.length * 3 +
      (candidate.requestBody ? 4 : 0) -
      candidate.gaps.length;
    if (score(route) > score(existing)) seen.set(key, route);
  }
  return [...seen.values()];
}

function joinPath(prefix: string, path: string): string {
  const combined = !prefix
    ? path || "/"
    : !path
      ? prefix
      : `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  // Go/Gin accept relative route patterns such as `router.GET("favicon.ico", ...)`,
  // but OpenAPI path keys must always begin with "/".
  return combined.startsWith("/") ? combined : `/${combined}`;
}

function addrToUrl(addr: string): string {
  const match = addr.match(/(?::(\d+))?/);
  const port = match?.[1];
  return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
}
