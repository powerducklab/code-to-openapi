import { belongsToPhpFunction } from "../lang/php/scope.js";
import {mergeResponseVariants} from "../core/response-variants.js";
import {parseDocument} from "yaml";
import {posix} from "node:path";
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
import type { PhpAnalysis, PhpClass } from "../lang/php/index.js";
import { phpStringText, resolvePhpClass, resolvePhpFqcn, findPhpMethod } from "../lang/php/index.js";
import { inferEnvelopeSchema } from "../lang/php/envelope.js";
import type { TsNode } from "../lang/treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../lang/treesitter/ast.js";
import {
  buildPhpModelIndex,
  ensurePhpComponent,
  ensurePhpSerializedComponent,
  formalParameters,
  ORM_COLUMN_SCALARS,
  ormColumnMeta,
  phpTypeToSchema,
  type PhpModelIndex,
} from "../lang/php/schema.js";
import {
  binaryResponse,
  inferArraySchema,
  inferDoctrineRepositoryCall,
  inferValueSchema,
  inferVariableModel,
  integerText,
  phpHttpConstantByName,
  staticString,
  unknownJsonResponse,
} from "../lang/php/response.js";

const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

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
    const fos = resolveFosEnvelope(ctx, analysis);
    const exception = resolveExceptionContract(ctx, analysis);

    const imports=yamlImports(ctx);
    for(const [rel,file] of analysis.files)for(const classNode of findAll(file.root,n=>n.type==='class_declaration')){
      const className=classNode.namedChildren.find(n=>n.type==='name')?.text;if(!className)continue;
      const body=classNode.namedChildren.find(n=>n.type==='declaration_list');if(!body)continue;
      const declared=routeAttributes(classNode);const parents:RouteAttr[] = declared.length?declared:[{path:'',name:'',methods:[],explicitMethods:false}];
      for(const methodNode of childrenOfType(body,'method_declaration')){
        const methodName=methodNode.namedChildren.find(n=>n.type==='name')?.text;if(!methodName)continue;
        const children=routeAttributes(methodNode);
        for(const parent of parents){
          const routes=children.length?children:methodName==='__invoke'&&declared.length?[{path:'',name:'',methods:[],explicitMethods:false}]:[];
          for(const route of routes){
            // A route without explicit `methods` technically matches every
            // verb, but emitting one operation per verb creates false routes.
            // Represent it once as GET, consistent with the YAML loader.
            const methods=route.explicitMethods?route.methods:parent.explicitMethods?parent.methods:['get'];
            const matches=imports.filter(entry=>entry.all||rel.startsWith(entry.directory!));
            for(const imported of matches.length?matches:[{prefix:''}])for(const verb of methods){
              const path=joinPath(imported.prefix,joinPath(parent.path,route.path));
              const candidate=buildCandidate({analysis,model,rel,methodNode,className,methodName,path,name:combineNames(parent.name,route.name),verb,originNode:methodNode,fos,exception});
              if(candidate)candidates.push(candidate);
            }
          }
        }
      }
    }

    // config/routes.yaml (best-effort): static path/method/controller tables.
    candidates.push(...yamlRoutes(ctx, analysis, model, unresolved, fos, exception));

    // FOSRestBundle / RestRoutingBundle `type: rest` imports derive routes from
    // controller action method names (cget/get/post/put/patch/delete + Action).
    candidates.push(...fosRestRoutes(ctx, analysis, model, unresolved, fos, exception));

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
  explicitMethods:boolean;
}

/**
 * Extract the `#[Route(...)]` attribute from a class or method node, or null
 * when it carries no such attribute. Resolves both the short `#[Route(...)]`
 * and the fully-qualified `#[\\Symfony\\...\\Route(...)]` forms.
 */
function routeAttributes(node: TsNode): RouteAttr[] {
  const result:RouteAttr[]=[];
  const list = node.namedChildren.find((c) => c.type === "attribute_list");
  if (!list) return result;
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
      result.push({path,name,methods:methods.filter(m=>ROUTE_VERBS.has(m)),explicitMethods:methods.length>0});
    }
  }
  return result;
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
  return joined ? `/${joined}${sub.endsWith("/")?"/":""}` : "/";
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
  fos?: FosConfig;
  exception?: ExceptionContract | null;
}

/**
 * Normalize a Symfony path template to OpenAPI form: strip requirement
 * syntax (`{id:post}` -> `{id}`) and optional markers (`{id?}` -> `{id}`).
 */
function normalizeSymfonyPath(path: string): string {
  return path.replace(/\{([^{}:?]+)[^}]*\}/g, "{$1}");
}

/**
 * Extract `{placeholder}` names from a path, stripping Symfony requirement
 * syntax (`{id:post}` -> `id`) and optional markers (`{id?}` -> `id`).
 */
function pathParamNames(path: string): Set<string> {
  const names = new Set<string>();
  for (const m of normalizeSymfonyPath(path).matchAll(/\{([^{}]+)\}/g)) {
    names.add(m[1]!);
  }
  return names;
}

function buildCandidate(args: BuildArgs): RouteCandidate | null {
  const { analysis, model, rel, methodNode, className, methodName, name, verb, originNode, fos, exception } = args;
  const path = normalizeSymfonyPath(args.path);
  const declaredPathParams = pathParamNames(path);

  const { parameters, requestBody, gaps } = collectParameters(methodNode, analysis, model, path, declaredPathParams);

  for (const p of declaredPathParams) {
    if (!parameters.some((prm) => prm.in === "path" && prm.name === p)) {
      parameters.push({ name: p, in: "path", required: true, schema: { type: "string" }, confidence: "medium" });
    }
  }

  const responses = collectResponses(methodNode, model, gaps, new Set(), fos, exception);
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
      const ref = schema && Object.keys(schema).length ? schema : undefined;
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

  // Symfony Form component: $this->createForm(FormType::class, ...)->submit($data)
  // (possibly inside a same-class helper such as a private save() method).
  if (!requestBody) {
    try {
      const formBody = inferFormRequestBody(handler, analysis, model);
      if (formBody) {
        requestBody = {
          required: formBody.required,
          content: [{ mediaType: formBody.mediaType, schema: formBody.schema }],
          confidence: formBody.confidence,
        };
        if (formBody.gap) gaps.push("body-schema-unknown");
      }
    } catch {
      // An unparseable form layout must not abort route/response extraction.
    }
  }

  return { parameters, requestBody, gaps };
}

// ---------------------------------------------------------------------------
// Symfony Form component request bodies
//
//   $form = $this->createForm(BookType::class, $book);
//   $form->submit($data);
//
// The FormType's buildForm() declares each field via ->add('name', Type::class,
// options). Field types fall back to the bound data_class entity (Doctrine column
// or getter) when no explicit type is supplied. The submitted data may be nested
// under a wrapper key (e.g. JSON body `{ "data": { ... } }`).
// ---------------------------------------------------------------------------

const FORM_TYPE_SCALARS: Record<string, JsonSchema> = {
  TextType: { type: "string" },
  TextareaType: { type: "string" },
  EmailType: { type: "string", format: "email" },
  UrlType: { type: "string", format: "uri" },
  TelType: { type: "string" },
  PasswordType: { type: "string" },
  SearchType: { type: "string" },
  ColorType: { type: "string" },
  HiddenType: { type: "string" },
  IntegerType: { type: "integer" },
  NumberType: { type: "number" },
  MoneyType: { type: "number" },
  PercentType: { type: "number" },
  CheckboxType: { type: "boolean" },
  DateType: { type: "string", format: "date" },
  BirthdayType: { type: "string", format: "date" },
  DateTimeType: { type: "string", format: "date-time" },
  TimeType: { type: "string" },
  CountryType: { type: "string" },
  LanguageType: { type: "string" },
  LocaleType: { type: "string" },
  CurrencyType: { type: "string" },
  TimezoneType: { type: "string" },
};

// Constraints that reject an absent/empty value, making the field required.
const NON_EMPTY_CONSTRAINT = /NotBlank|NotNull|Positive|PositiveOrZero|Length|Range|NotEqualTo|Regex|Email|Url|Choice/;

/** Read the value node of `'key' => value` inside an array creation node. */
function arrayEntryValue(arrayNode: TsNode | undefined, key: string): TsNode | undefined {
  if (!arrayNode || arrayNode.type !== "array_creation_expression") return undefined;
  // tree-sitter-php labels array entries as array_element (older grammars) or
  // array_element_initializer (newer grammars).
  for (const element of arrayNode.namedChildren) {
    if (element.type !== "array_element" && element.type !== "array_element_initializer") continue;
    const keyNode = element.namedChildren.find((c) => c.type === "string" && phpStringText(c) === key);
    if (!keyNode) continue;
    const values = element.namedChildren.filter((c) => c !== keyNode);
    return values[values.length - 1];
  }
  return undefined;
}

/** Resolve the `data_class` bound to a FormType from configureOptions(). */
function formDataClass(formClass: PhpClass, analysis: PhpAnalysis): PhpClass | undefined {
  const configure = formClass.methods.get("configureOptions") ?? formClass.methods.get("setDefaultOptions");
  if (!configure) return undefined;
  for (const arrayNode of findAll(configure, (n) => n.type === "array_creation_expression")) {
    const dataClassNode = arrayEntryValue(arrayNode, "data_class");
    if (dataClassNode?.type !== "class_constant_access_expression") continue;
    const short = dataClassNode.namedChildren.find((c) => c.type === "name")?.text;
    const target = short ? resolvePhpClass(short, analysis, dataClassNode) : undefined;
    if (target) return target;
  }
  return undefined;
}

/** Infer a bound entity property schema from its Doctrine column or getter. */
function entityFormPropertySchema(entity: PhpClass, fieldName: string, model: PhpModelIndex): JsonSchema | undefined {
  const body = entity.node?.namedChildren.find((c) => c.type === "declaration_list");
  if (body) {
    const properties = childrenOfType(body, "property_declaration");
    for (const property of properties) {
      const variableName = property.namedChildren.find((c) => c.type === "variable_name")?.text.replace(/^\$/, "");
      if (variableName !== fieldName) continue;
      const index = body.children.indexOf(property);
      let doc = "";
      for (let i = index - 1; i >= 0; i -= 1) {
        const sibling = body.children[i]!;
        if (sibling.type !== "comment") break;
        doc = `${sibling.text}\n${doc}`;
      }
      const orm = ormColumnMeta(`${doc}\n${property.text}`);
      if (orm) {
        const base: JsonSchema = { ...(ORM_COLUMN_SCALARS[orm.type] ?? { type: "string" }) };
        if (orm.nullable) base.nullable = true;
        return base;
      }
      const typeNode = property.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type" || c.type === "optional_type");
      if (typeNode) {
        const schema = phpTypeToSchema(typeNode, model);
        if (Object.keys(schema).length) return schema;
      }
      break;
    }
  }
  const capitalized = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
  const getter = entity.methods.get(`get${capitalized}`) ?? entity.methods.get(fieldName);
  if (getter) {
    const returnType = getter.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type" || c.type === "optional_type");
    const schema = phpTypeToSchema(returnType, model);
    if (Object.keys(schema).length) return schema;
  }
  return undefined;
}

interface FormFieldSchema {
  schema: JsonSchema;
  required: boolean;
  isFile: boolean;
}

/** Build the field schema map declared by a FormType's buildForm(). */
function buildFormFields(formClass: PhpClass, analysis: PhpAnalysis, model: PhpModelIndex): Map<string, FormFieldSchema> {
  const fields = new Map<string, FormFieldSchema>();
  const buildForm = formClass.methods.get("buildForm");
  if (!buildForm) return fields;
  const dataClass = formDataClass(formClass, analysis);

  for (const call of findAll(buildForm, (n) => n.type === "member_call_expression")) {
    const method = call.namedChildren.find((c) => c.type === "name")?.text;
    if (!method || method.toLowerCase() !== "add") continue;
    const args = callArguments(call);
    const nameNode = args[0];
    const fieldName = nameNode?.type === "string" ? phpStringText(nameNode) : undefined;
    if (!fieldName || fields.has(fieldName)) continue;

    const typeArg = args[1];
    const optionsArg = args[2];
    let typeShort: string | undefined;
    if (typeArg?.type === "class_constant_access_expression") {
      typeShort = typeArg.namedChildren.find((c) => c.type === "name")?.text;
    } else if (typeArg?.type === "string") {
      const alias = phpStringText(typeArg);
      typeShort = alias ? alias.charAt(0).toUpperCase() + alias.slice(1) + "Type" : undefined;
    }

    const isFile = typeShort === "FileType";
    let schema: JsonSchema | undefined;
    if (isFile) schema = { type: "string", format: "binary" };
    else if (typeShort && FORM_TYPE_SCALARS[typeShort]) schema = { ...FORM_TYPE_SCALARS[typeShort]! };
    else if (typeShort === "ChoiceType") {
      const choices = optionsArg ? arrayEntryValue(optionsArg, "choices") : undefined;
      const literals = choices
        ? findAll(choices, (n) => n.type === "string").map((s) => phpStringText(s)).filter((s): s is string => Boolean(s))
        : [];
      schema = literals.length ? { type: "string", enum: literals } : { type: "string" };
    } else if (dataClass) {
      schema = entityFormPropertySchema(dataClass, fieldName, model);
    }

    let required = false;
    if (optionsArg?.type === "array_creation_expression") {
      const requiredValue = arrayEntryValue(optionsArg, "required");
      if (requiredValue?.type === "boolean" && requiredValue.text === "true") required = true;
      const constraints = arrayEntryValue(optionsArg, "constraints");
      if (constraints && NON_EMPTY_CONSTRAINT.test(constraints.text)) required = true;
    }

    fields.set(fieldName, { schema: schema ?? {}, required, isFile });
  }
  return fields;
}

/** Find the right-hand side of `$var = ...` within a method, if any. */
function localAssignment(method: TsNode, variableText: string): TsNode | undefined {
  for (const assignment of findAll(method, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren[0];
    if (lhs?.type === "variable_name" && lhs.text === variableText) {
      return assignment.namedChildren[1];
    }
  }
  return undefined;
}

/** Whether a variable is populated from the raw request body in the action. */
function isRequestBodyVariable(method: TsNode, variableText: string): boolean {
  const escaped = variableText.replace(/\$/g, "\\$");
  const source = method.text;
  return (
    new RegExp(`${escaped}\\s*=\\s*json_decode\\s*\\(`).test(source) ||
    new RegExp(`${escaped}\\s*=[^;]*->request->(?:all|get|getIterator|getAlpha|getString)`).test(source) ||
    new RegExp(`${escaped}\\s*=[^;]*->files`).test(source)
  );
}

interface FormBodyResult {
  schema: JsonSchema;
  mediaType: string;
  required: boolean;
  confidence: Confidence;
  gap: boolean;
}

/** Locate createForm()/submit() in a method, resolving the FormType and submit data. */
function findFormInMethod(method: TsNode, analysis: PhpAnalysis): { formClass: PhpClass; submitArg?: TsNode } | null {
  let formClass: PhpClass | undefined;
  let submitArg: TsNode | undefined;
  for (const call of findAll(method, (n) => n.type === "member_call_expression")) {
    const name = call.namedChildren.find((c) => c.type === "name")?.text;
    if (!name) continue;
    const lowered = name.toLowerCase();
    if (!formClass && (lowered === "createform" || lowered === "createformbuilder")) {
      const typeArg = callArguments(call)[0];
      if (typeArg?.type === "class_constant_access_expression") {
        const short = typeArg.namedChildren.find((c) => c.type === "name")?.text;
        const resolved = short ? resolvePhpClass(short, analysis, call) : undefined;
        if (resolved) formClass = resolved;
      }
    }
    if (lowered === "submit") {
      const arg = callArguments(call)[0];
      if (arg) submitArg = arg;
    }
  }
  return formClass ? { formClass, submitArg } : null;
}

/** Infer a request body validated/bound through the Symfony Form component. */
function inferFormRequestBody(handler: TsNode, analysis: PhpAnalysis, model: PhpModelIndex): FormBodyResult | null {
  const classNode = enclosingClassNode(handler);
  const ownerName = classNode?.namedChildren.find((c) => c.type === "name")?.text;
  const ownerClass = ownerName ? analysis.classes.get(ownerName) : undefined;

  let formMethod = handler;
  let context = findFormInMethod(handler, analysis);
  let helperCall: TsNode | undefined;

  // The form may be created inside a same-class private helper (e.g. save()).
  if (!context && ownerClass) {
    for (const call of findAll(handler, (n) => n.type === "member_call_expression" && belongsToPhpFunction(n, handler))) {
      const isThis = call.namedChildren.some((c) => c.type === "variable_name" && c.text === "$this");
      const helperName = call.namedChildren.find((c) => c.type === "name")?.text;
      if (!isThis || !helperName) continue;
      const helper = ownerClass.methods.get(helperName);
      if (!helper || !/createForm|createFormBuilder|->submit\s*\(/.test(helper.text)) continue;
      const helperContext = findFormInMethod(helper, analysis);
      if (!helperContext) continue;
      context = helperContext;
      formMethod = helper;
      helperCall = call;
      break;
    }
  }

  if (!context) return null;
  const fields = buildFormFields(context.formClass, analysis, model);

  // Resolve the submitted data expression: unwind local variable aliases within
  // the form method, then map a helper parameter back to the action argument.
  let dataExpr: TsNode | undefined = context.submitArg;
  let guard = 0;
  while (dataExpr?.type === "variable_name" && guard < 5) {
    const rhs = localAssignment(formMethod, dataExpr.text);
    if (!rhs) break;
    dataExpr = rhs;
    guard += 1;
  }
  if (dataExpr?.type === "variable_name" && helperCall) {
    const params = formalParameters(formMethod);
    const index = params.findIndex((p) => p.namedChildren.find((c) => c.type === "variable_name")?.text === dataExpr!.text);
    if (index >= 0) {
      const actionArg = callArguments(helperCall)[index];
      if (actionArg) dataExpr = actionArg;
    }
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  let hasFile = false;
  let gap = false;
  for (const [fieldName, field] of fields) {
    properties[fieldName] = field.schema;
    if (Object.keys(field.schema).length === 0) gap = true;
    if (field.required) required.push(fieldName);
    if (field.isFile) hasFile = true;
  }

  let inner: JsonSchema = {
    type: "object",
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
  };

  // Detect a wrapper key such as `$body['data']` where `$body` is the decoded
  // request body; the documented payload is `{ "<wrapper>": { ...fields } }`.
  let wrapper: string | undefined;
  if (dataExpr?.type === "subscript_expression") {
    const keyNode = dataExpr.namedChildren.find((c) => c.type === "string");
    const receiver = dataExpr.namedChildren.find((c) => c.type === "variable_name");
    if (keyNode && receiver && isRequestBodyVariable(handler, receiver.text)) {
      wrapper = phpStringText(keyNode) ?? undefined;
    }
  }

  const schema: JsonSchema = wrapper
    ? { type: "object", properties: { [wrapper]: inner }, required: [wrapper] }
    : inner;

  return {
    schema,
    mediaType: hasFile ? "multipart/form-data" : "application/json",
    required: required.length > 0,
    confidence: fields.size && !gap ? "high" : "low",
    gap: fields.size === 0 || gap,
  };
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

function enclosingClassNode(node: TsNode): TsNode | undefined {
  let scope: TsNode | undefined = node;
  while (scope && scope.type !== "class_declaration") scope = scope.parent ?? undefined;
  return scope;
}

/** Methods that produce responses directly and must not be traversed as helpers. */
const RESPONSE_BUILTIN_METHODS = new Set([
  "json", "render", "renderview", "redirect", "redirecttoroute", "file", "download",
  "view", "handleview", "createform", "getdoctrine", "forward",
]);

function collectResponses(
  handler: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
  visited: Set<TsNode> = new Set(),
  fos: FosConfig | undefined = undefined,
  exception: ExceptionContract | null = null,
): DiscoveredResponse[] {
  const responses: DiscoveredResponse[] = [];
  visited.add(handler);

  for (const ret of findAll(handler, (n) => n.type === "return_statement" && belongsToPhpFunction(n, handler))) {
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
      response = interpretResponse(expression, model, gaps, handler, fos);
    }
    if (response) responses.push(response);
  }

  // Thrown HttpKernel exceptions are converted to error responses by the
  // kernel.exception listener rather than returning from the controller.
  responses.push(...collectExceptionResponses(handler, gaps, model.analysis, model, exception));

  // Inline same-class private response helpers reached through `$this->save(...)`
  // (e.g. FOSRest controllers that build the view and throw form exceptions in a
  // shared helper). Only helpers that themselves produce responses are traversed.
  const classNode = enclosingClassNode(handler);
  const ownerClass = classNode?.namedChildren.find((c) => c.type === "name")?.text;
  const owner = ownerClass ? model.analysis.classes.get(ownerClass) : undefined;
  if (owner) {
    for (const call of findAll(handler, (n) => n.type === "member_call_expression" && belongsToPhpFunction(n, handler))) {
      const receiver = call.namedChildren.find((c) => c.type === "variable_name");
      const helperName = call.namedChildren.find((c) => c.type === "name")?.text;
      if (receiver?.text !== "$this" || !helperName) continue;
      if (RESPONSE_BUILTIN_METHODS.has(helperName.toLowerCase())) continue;
      const helper = owner.methods.get(helperName);
      if (!helper || helper === handler || visited.has(helper)) continue;
      if (!/handleView|->\s*view\s*\(|throw\s+new|new\s+(?:JsonResponse|Response)|->json\s*\(/.test(helper.text)) continue;
      responses.push(...collectResponses(helper, model, gaps, visited, fos, exception));
    }
  }

  if (!responses.length) {
    gaps.push("response-unknown");
    return [{ statusCode: "200", description: "", confidence: "low" }];
  }

  const merged = new Map<string, DiscoveredResponse>();
  for (const response of responses) {
    const existing = merged.get(response.statusCode);
    merged.set(response.statusCode, existing ? mergeResponseVariants(existing, response) : response);
  }
  return [...merged.values()];
}

/**
 * Resolve error responses from thrown Symfony HttpKernel exceptions. The
 * exception subclass fixes the status code; the exact error body depends on the
 * registered error renderer and content negotiation, so it is kept generic and
 * custom kernel.exception listeners are not statically resolved here.
 */
function collectExceptionResponses(
  handler: TsNode,
  gaps: GapCode[],
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  exception: ExceptionContract | null,
): DiscoveredResponse[] {
  const exceptionStatus: Record<string, string> = {
    BadRequestHttpException: "400",
    UnauthorizedHttpException: "401",
    AccessDeniedHttpException: "403",
    NotFoundHttpException: "404",
    MethodNotAllowedHttpException: "405",
    NotAcceptableHttpException: "406",
    ConflictHttpException: "409",
    GoneHttpException: "410",
    LengthRequiredHttpException: "411",
    PreconditionFailedHttpException: "412",
    UnprocessableEntityHttpException: "422",
    TooManyRequestsHttpException: "429",
    ServiceUnavailableHttpException: "503",
    GatewayTimeoutHttpException: "504",
  };

  /** Wrap an error body in the listener's error envelope when one is proven. */
  const wrapError = (body: JsonSchema, status: string): JsonSchema => {
    const binding = exception?.errorEnvelope;
    if (!binding) return body;
    const envelopeClass = analysis.classes.get(binding.envelopeFqcn);
    if (!envelopeClass) return body;
    const wrapped = inferEnvelopeSchema({
      analysis,
      envelopeClass,
      factoryMethod: binding.factoryMethod,
      payload: body,
      fixedProperties: { code: { type: "integer", const: Number(status) } },
    });
    return wrapped ?? body;
  };

  const out: DiscoveredResponse[] = [];
  for (const throwNode of findAll(handler, (n) => n.type === "throw_expression" || n.type === "throw_statement")) {
    if (!belongsToPhpFunction(throwNode, handler)) continue;
    const creation = findAll(throwNode, (n) => n.type === "object_creation_expression")[0];
    if (!creation) continue;
    const typeNode = creation.namedChildren.find(
      (c) => c.type === "name" || c.type === "qualified_name" || c.type === "dynamic_type_name",
    );
    const simpleName = (typeNode?.text ?? "").replace(/^\\/, "").split("\\").pop() ?? "";
    const argumentList = creation.namedChildren.find((c) => c.type === "arguments");
    const ctorArgs = argumentList ? childrenOfType(argumentList, "argument") : [];
    const thrownClass = typeNode ? resolvePhpClass(typeNode.text.replace(/^\\/, "").split("\\").pop() ?? typeNode.text, analysis, creation) : undefined;
    const fqcn = thrownClass?.fqcn ?? (typeNode ? normalizeFqcn(resolvePhpFqcn(typeNode.text, analysis, creation)) : undefined);

    if (exception) {
      let status: string | undefined;
      if (fqcn) status = exception.statusByClass.get(fqcn);
      if (!status && exception.statusCodeFromMethod && thrownClass && exceptionExposesStatusCode(thrownClass)) {
        status = exceptionConstructorStatus(thrownClass);
      }
      if (!status) status = exception.defaultStatus;
      let body = (fqcn ? exception.bodyByClass.get(fqcn) : undefined) ?? exception.defaultBody;
      let schema = body.schema;
      let confidence: Confidence = "medium";
      if (!schema || !Object.keys(schema).length) {
        // The listener maps this class but the body shape is not statically proven.
        gaps.push("response-unknown");
        schema = {};
        confidence = "low";
      }
      schema = wrapError(schema, status);
      out.push({
        statusCode: status,
        description: "",
        confidence,
        content: [{ mediaType: "application/json", schema }],
      });
      continue;
    }

    let status: string | null = exceptionStatus[simpleName] ?? null;
    if (!status && simpleName === "HttpException") {
      const raw = ctorArgs[0]?.text.trim() ?? "";
      if (/^[45]\d\d$/.test(raw)) status = raw;
    }

    if (status) {
      out.push({
        statusCode: status,
        description: "",
        confidence: "medium",
        content: [
          {
            mediaType: "application/json",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, status: { type: "integer" } },
            },
          },
        ],
      });
    } else if (/Exception$|Error$/.test(simpleName)) {
      // An unhandled non-HTTP exception becomes a 500 outside debug mode; the
      // body changes with kernel.debug and the error renderer.
      gaps.push("response-unknown");
      out.push({
        statusCode: "500",
        description: "Unhandled exception; error body depends on kernel debug and error renderer",
        confidence: "low",
        content: [
          {
            mediaType: "application/json",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, status: { type: "integer" } },
            },
          },
        ],
      });
    }
  }

  const merged = new Map<string, DiscoveredResponse>();
  for (const response of out) {
    const existing = merged.get(response.statusCode);
    merged.set(response.statusCode, existing ? mergeResponseVariants(existing, response) : response);
  }
  return [...merged.values()];
}

function interpretResponse(
  expression: TsNode,
  model: PhpModelIndex,
  gaps: GapCode[],
  handler: TsNode,
  fos: FosConfig | undefined = undefined,
): DiscoveredResponse | null {
  // return new JsonResponse([...], $status) / new Response(...) / new StreamedResponse.
  if (expression.type === "object_creation_expression") {
    const name = expression.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text
      .split("\\").pop();
    const args = expression.namedChildren.find((c) => c.type === "arguments");
    const argNodes = args ? childrenOfType(args, "argument") : [];
    if (name === "JsonResponse") {
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
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
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
      return {
        statusCode: status,
        description: "",
        confidence: "medium",
        content: [{ mediaType: "text/html", schema: { type: "string" } }],
      };
    }
    if (name === "StreamedResponse" || name === "BinaryFileResponse") {
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
      return binaryResponse(status);
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

    // FOSRest: return $this->handleView($this->view($data, $code)); the view
    // carries the serialized payload and status; the configured view handler
    // (JMS/Symfony serializer) renders it.
    if (isThis && (method.toLowerCase() === "handleview" || method.toLowerCase() === "view")) {
      const fosView = inferFosView(expression, model, handler, gaps, fos);
      if (fosView) return fosView;
    }
    if (isThis && method === "json") {
      const status = integerText(argNodes[1]) ?? (argNodes[1] ? "default" : "200");
      if (status === "default") gaps.push("response-unknown");
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

// ---------------------------------------------------------------------------
// FOSRest view / handleView response inference
// ---------------------------------------------------------------------------

function callArguments(call: TsNode): TsNode[] {
  const args = call.namedChildren.find((c) => c.type === "arguments");
  if (!args) return [];
  // Unwrap each `argument` node to its inner expression.
  return childrenOfType(args, "argument")
    .map((arg) => arg.namedChildren[0])
    .filter((arg): arg is TsNode => Boolean(arg));
}

/**
 * Resolve a FOSRest `View` to its data argument and status argument. The view
 * may be passed inline (`$this->handleView($this->view($data, 200))`) or via a
 * variable assigned from `$this->view(...)`, `new View(...)` or `View::create(...)`.
 */
function resolveViewNode(node: TsNode | undefined, handler: TsNode): { data?: TsNode; status?: TsNode } | null {
  if (!node) return null;
  if (node.type === "member_call_expression") {
    const method = node.namedChildren.find((c) => c.type === "name")?.text;
    if (method === "view") {
      const args = callArguments(node);
      return { data: args[0], status: args[1] };
    }
  }
  if (node.type === "object_creation_expression") {
    const name = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name")?.text.split("\\").pop();
    if (name === "View") {
      const args = callArguments(node);
      return { data: args[0], status: args[1] };
    }
  }
  if (node.type === "scoped_call_expression") {
    const method = node.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name").pop()?.text;
    if (method === "create") {
      const args = callArguments(node);
      return { data: args[0], status: args[1] };
    }
  }
  if (node.type === "variable_name" && handler) {
    for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
      const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
      if (lhs?.text !== node.text) continue;
      const rhs = assignment.namedChildren.find((c) => c !== lhs);
      if (rhs) return resolveViewNode(rhs, handler);
    }
  }
  return null;
}

/** Infer a FOSRest view payload, routing entities through serializer components. */
function inferFosPayload(node: TsNode | undefined, model: PhpModelIndex, handler: TsNode): JsonSchema | undefined {
  if (!node) return undefined;
  if (node.type === "member_call_expression") {
    return (
      inferDoctrineRepositoryCall(node, model, handler) ??
      inferValueSchema(node, model, handler)
    );
  }
  if (node.type === "object_creation_expression") {
    const nameNode = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    const cls = nameNode ? resolvePhpClass(nameNode.text, model.analysis, nameNode) : undefined;
    if (cls) return ensurePhpSerializedComponent(cls.fqcn, model) ?? {};
  }
  if (node.type === "variable_name") return inferFosVariable(handler, node, model);
  if (node.type === "scoped_call_expression") return inferValueSchema(node, model, handler);
  if (node.type === "array_creation_expression") return inferArraySchema(node, model, handler);
  return inferValueSchema(node, model, handler);
}

/** Resolve a view data variable back to a repository result, new entity or typed parameter. */
function inferFosVariable(handler: TsNode, variable: TsNode, model: PhpModelIndex): JsonSchema | undefined {
  for (const assignment of findAll(handler, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren.find((c) => c.type === "variable_name");
    if (lhs?.text !== variable.text) continue;
    const rhs = assignment.namedChildren.find((c) => c !== lhs);
    if (!rhs) continue;
    if (rhs.type === "member_call_expression") {
      return inferDoctrineRepositoryCall(rhs, model, handler) ?? inferValueSchema(rhs, model, handler);
    }
    if (rhs.type === "object_creation_expression") {
      const nameNode = rhs.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
      const cls = nameNode ? resolvePhpClass(nameNode.text, model.analysis, nameNode) : undefined;
      if (cls) return ensurePhpSerializedComponent(cls.fqcn, model) ?? {};
    }
    return inferValueSchema(rhs, model, handler);
  }
  // A typed entity parameter, e.g. private function save(Book $book, array $data).
  for (const param of formalParameters(handler)) {
    const paramVar = param.namedChildren.find((c) => c.type === "variable_name");
    if (paramVar?.text !== variable.text) continue;
    const typeNode = param.namedChildren.find((c) => c.type === "named_type");
    const cls = typeNode ? resolvePhpClass(typeNode.text, model.analysis, typeNode) : undefined;
    if (cls) return ensurePhpSerializedComponent(cls.fqcn, model) ?? undefined;
  }
  return inferVariableModel(handler, variable, model);
}

/** Interpret `$this->handleView(...)` / `$this->view(...)` as a JSON response. */
function inferFosView(call: TsNode, model: PhpModelIndex, handler: TsNode, gaps: GapCode[], fos?: FosConfig): DiscoveredResponse | null {
  const method = call.namedChildren.find((c) => c.type === "name")?.text?.toLowerCase();
  let resolved: { data?: TsNode; status?: TsNode } | null;
  if (method === "handleview") {
    resolved = resolveViewNode(callArguments(call)[0], handler);
  } else {
    const args = callArguments(call);
    resolved = { data: args[0], status: args[1] };
  }
  if (!resolved) return null;
  // A FOSRest View defaults to HTTP 200 when no status is supplied.
  const status = integerText(resolved.status) ?? "200";
  if (!resolved.data) {
    return { statusCode: status, description: "", confidence: "medium", content: [{ mediaType: "application/json", schema: {} }] };
  }
  const payload = inferFosPayload(resolved.data, model, handler);
  if (!payload || !Object.keys(payload).length) return unknownJsonResponse(status, gaps);
  const schema = applySuccessEnvelope(payload, fos, model.analysis);
  return { statusCode: status, description: "", confidence: "medium", content: [{ mediaType: "application/json", schema }] };
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

function routingDocuments(ctx:ScanContext):Array<{path:string;entries:Record<string,any>}>{
 const documents=[];
 for(const file of ctx.index.files){
  if(!/(?:^|\/)config\/routes(?:\/[^]+)?\.ya?ml$/.test(file.path))continue;
  try{const doc=parseDocument(file.content);if(doc.errors.length)continue;const value=doc.toJS({maxAliasCount:100});if(value&&typeof value==='object'&&!Array.isArray(value))documents.push({path:file.path,entries:value});}catch{/* Unknown YAML is not guessed. */}
 }
 return documents;
}
function yamlImports(ctx:ScanContext):Array<{prefix:string;all?:boolean;directory?:string}>{
 const imports=[];
 for(const doc of routingDocuments(ctx))for(const entry of Object.values(doc.entries)){
  if(!entry||typeof entry!=='object'||typeof entry.resource!=='string')continue;
  const prefix=typeof entry.prefix==='string'?entry.prefix:'';
  if(entry.resource==='routing.controllers')imports.push({prefix,all:true});
  else if((entry.type==='attribute'||entry.type==='annotation')&&!entry.resource.includes('*'))imports.push({prefix,directory:posix.normalize(posix.join(posix.dirname(doc.path),entry.resource)).replace(/\/?$/,'/')});
 }
 return imports;
}

function yamlRoutes(
  ctx: ScanContext,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  unresolved: DiscoveredUnresolved[],
  fos: FosConfig | undefined = undefined,
  exception: ExceptionContract | null = null,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for(const f of routingDocuments(ctx)){
    for(const entry of Object.values(f.entries)){
      if(!entry||typeof entry!=='object'||typeof entry.path!=='string')continue;
      const path=normalizeSymfonyPath(entry.path.startsWith('/')?entry.path:'/'+entry.path);
      // A YAML route without explicit `methods` technically matches every verb,
      // but documenting all eight fabricates write operations. Pages and
      // generic handlers are documented as GET (Symfony implicitly serves
      // HEAD on GET routes).
      const verbs=entry.methods?(Array.isArray(entry.methods)?entry.methods:[entry.methods]).map((v:any)=>String(v).toLowerCase()).filter((v:string)=>ROUTE_VERBS.has(v)):['get'];
      const controllerMatch=typeof entry.controller==='string'?['',entry.controller]:null;
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
      const declaredPathParams = pathParamNames(path);
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
      // FrameworkBundle's TemplateController renders a Twig template referenced
      // by defaults.template; that is a deterministic HTML 200 response.
      const templateName =
        entry.defaults && typeof entry.defaults === "object"
          ? (entry.defaults as Record<string, unknown>).template
          : undefined;
      const isTemplateController =
        className === "TemplateController" || (typeof templateName === "string" && /\.twig$/.test(templateName));
      let responses: DiscoveredResponse[];
      if (methodNode) {
        responses = collectResponses(methodNode, model, gaps, new Set(), fos, exception);
      } else if (isTemplateController) {
        responses = [{
          statusCode: "200",
          description: "",
          confidence: "high" as Confidence,
          content: [{ mediaType: "text/html", schema: { type: "string" } }],
        }];
      } else {
        unresolved.push({
          reason: "unresolved-controller",
          message: `routes.yaml references ${controllerMatch?.[1] ?? "?"} which is not in the scanned tree`,
          origin: { file: f.path, line: 0 },
        });
        gaps.push("response-unknown");
        responses = [{ statusCode: "200", description: "", confidence: "low" as Confidence }];
      }

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
// FOSRest custom view handler / response envelope resolution
// ---------------------------------------------------------------------------

interface FosEnvelopeBinding {
  envelopeFqcn: string;
  factoryMethod: string;
}

interface FosConfig {
  success?: FosEnvelopeBinding;
  error?: FosEnvelopeBinding;
}

/** Parse every YAML file under config/ (packages, services, routing). */
function configYamlDocuments(ctx: ScanContext): Array<{ path: string; entries: Record<string, any> }> {
  const documents: Array<{ path: string; entries: Record<string, any> }> = [];
  for (const file of ctx.index.files) {
    if (!/(?:^|\/)config\/.+\.ya?ml$/.test(file.path)) continue;
    try {
      const doc = parseDocument(file.content);
      if (doc.errors.length) continue;
      const value = doc.toJS({ maxAliasCount: 100 });
      if (value && typeof value === "object" && !Array.isArray(value)) {
        documents.push({ path: file.path, entries: value as Record<string, any> });
      }
    } catch {
      // Unparseable config is ignored rather than guessed.
    }
  }
  return documents;
}

/**
 * Resolve the FOSRest view handler wiring:
 *   fos_rest.service.view_handler -> a service whose registerHandler('json',
 *   ['@handlerService', 'method']) points at a handler class whose method calls
 *   a static envelope factory such as `Envelope::success(...)` / `::error(...)`.
 */
function resolveFosEnvelope(ctx: ScanContext, analysis: PhpAnalysis): FosConfig {
  const documents = configYamlDocuments(ctx);
  const servicesById = new Map<string, any>();
  let viewHandlerId: string | undefined;

  for (const document of documents) {
    const entries = document.entries;
    const fosRest = (entries as any).fos_rest;
    if (fosRest?.service?.view_handler && typeof fosRest.service.view_handler === "string") {
      viewHandlerId = fosRest.service.view_handler;
    }
    const services = entries.services;
    if (services && typeof services === "object") {
      for (const [id, definition] of Object.entries(services)) {
        if (id.startsWith("_") || !definition || typeof definition !== "object") continue;
        servicesById.set(id, definition);
      }
    }
  }

  if (!viewHandlerId) return {};
  const viewHandler = servicesById.get(viewHandlerId);
  let handlerServiceId: string | undefined;
  let handlerMethodName: string | undefined;
  for (const call of (viewHandler?.calls ?? []) as unknown[]) {
    if (!Array.isArray(call) || call[0] !== "registerHandler") continue;
    const args = call[1];
    if (!Array.isArray(args)) continue;
    const target = args.find((a) => Array.isArray(a) && a.length === 2 && typeof a[0] === "string" && a[0].startsWith("@"));
    if (Array.isArray(target)) {
      handlerServiceId = (target[0] as string).slice(1);
      handlerMethodName = target[1] as string;
    }
  }
  if (!handlerServiceId || !handlerMethodName) return {};

  const handlerDefinition = servicesById.get(handlerServiceId);
  const handlerClass = typeof handlerDefinition?.class === "string" ? handlerDefinition.class.replace(/^\\/, "") : undefined;
  const handlerClassNode = handlerClass ? analysis.classes.get(handlerClass) : undefined;
  if (!handlerClassNode) return {};
  const handlerMethodNode = handlerClassNode.methods.get(handlerMethodName);
  if (!handlerMethodNode) return {};

  const config: FosConfig = {};
  for (const call of findAll(handlerMethodNode, (n) => n.type === "scoped_call_expression")) {
    const names = call.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
    const scopeName = names[0]?.text;
    const factoryMethod = names[names.length - 1]?.text;
    if (!scopeName || !factoryMethod) continue;
    const envelopeClass = resolvePhpClass(scopeName, analysis, call);
    if (!envelopeClass) continue;
    const lowered = factoryMethod.toLowerCase();
    const binding: FosEnvelopeBinding = { envelopeFqcn: envelopeClass.fqcn, factoryMethod };
    if (/success|^ok$|created|respond/.test(lowered)) config.success = binding;
    else if (/error|fail|exception/.test(lowered)) config.error = binding;
  }
  return config;
}

/** Wrap a successful payload schema in the configured FOSRest envelope, if proven. */
function applySuccessEnvelope(payload: JsonSchema, fos: FosConfig | undefined, analysis: PhpAnalysis): JsonSchema {
  const binding = fos?.success;
  if (!binding) return payload;
  const envelopeClass = analysis.classes.get(binding.envelopeFqcn);
  if (!envelopeClass) return payload;
  const wrapped = inferEnvelopeSchema({
    analysis,
    envelopeClass,
    factoryMethod: binding.factoryMethod,
    payload,
  });
  return wrapped ?? payload;
}

// ---------------------------------------------------------------------------
// kernel.exception listener -> error response contract
//
// A service tagged kernel.event_listener/kernel.exception receives every
// uncaught throwable and builds the final response. Its method typically maps
// the exception class to a status code (a getStatusCode() branch or a
// get_class() switch) and to an error body, then wraps it in an error envelope.
// ---------------------------------------------------------------------------

interface ExceptionBody {
  schema: JsonSchema;
}

interface ExceptionContract {
  statusByClass: Map<string, string>;
  bodyByClass: Map<string, ExceptionBody>;
  defaultStatus: string;
  defaultBody: ExceptionBody;
  statusCodeFromMethod: boolean;
  errorEnvelope?: FosEnvelopeBinding;
}

/** Collapse PHP double-backslash escapes so FQCN strings compare to use resolution. */
function normalizeFqcn(value: string): string {
  return value.replace(/\\\\/g, "\\").replace(/^\\/, "");
}

/** Resolve a case condition to an exception FQCN; undefined for a default arm. */
function caseMatchFqcn(caseNode: TsNode, analysis: PhpAnalysis): string | undefined {
  const condition = caseNode.namedChildren.find(
    (c) => c.type === "string" || c.type === "class_constant_access_expression",
  );
  if (!condition) return undefined;
  if (condition.type === "string") {
    const text = phpStringText(condition);
    return text ? normalizeFqcn(text) : undefined;
  }
  const short = condition.namedChildren.find((c) => c.type === "name")?.text;
  return short ? resolvePhpClass(short, analysis, condition)?.fqcn : undefined;
}

/** Read a status code from an assignment RHS: a 3-digit literal or Response::HTTP_*. */
function statusFromRhs(rhs: TsNode | undefined): string | undefined {
  if (!rhs) return undefined;
  const text = rhs.text.trim();
  if (/^\d{3}$/.test(text)) return text;
  if (rhs.type === "class_constant_access_expression") {
    const constant = rhs.namedChildren.filter((c) => c.type === "name").slice(-1)[0]?.text;
    return constant ? phpHttpConstantByName(constant) ?? undefined : undefined;
  }
  return undefined;
}

/** Infer the schema of an error container value assigned inside a switch arm. */
function errorValueSchema(caseNode: TsNode, rhs: TsNode): JsonSchema {
  if (/getMessage\s*\(/.test(rhs.text)) return { type: "string" };
  if (rhs.type === "variable_name") {
    // A foreach that populates the variable with dynamic field => message pairs.
    for (const loop of findAll(caseNode, (n) => n.type.includes("foreach"))) {
      if (loop.text.includes(rhs.text) && /getMessage\s*\(/.test(loop.text)) {
        return { type: "object", additionalProperties: { type: "string" } };
      }
    }
    // The variable may itself be assigned from getMessage().
    const assigned = findAll(caseNode, (n) => n.type === "assignment_expression").find((assignment) => {
      const lhs = assignment.namedChildren[0];
      return lhs?.type === "variable_name" && lhs.text === rhs.text && /getMessage\s*\(/.test(assignment.namedChildren[1]?.text ?? "");
    });
    if (assigned) return { type: "string" };
  }
  if (rhs.type === "array_creation_expression") return { type: "object" };
  return {};
}

/** Extract the `$error['key'] = ...` shape built inside a switch arm. */
function caseErrorBody(caseNode: TsNode): ExceptionBody | undefined {
  const properties: Record<string, JsonSchema> = {};
  for (const assignment of findAll(caseNode, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren[0];
    const rhs = assignment.namedChildren[1];
    if (!lhs || lhs.type !== "subscript_expression" || !rhs) continue;
    const receiver = lhs.namedChildren.find((c) => c.type === "variable_name");
    const keyNode = lhs.namedChildren.find((c) => c.type === "string");
    if (!receiver || !keyNode) continue;
    if (!/(error|err|content|data)$/.test(receiver.text.replace(/^\$/, ""))) continue;
    const key = phpStringText(keyNode);
    if (!key || properties[key]) continue;
    properties[key] = errorValueSchema(caseNode, rhs);
  }
  const keys = Object.keys(properties);
  if (!keys.length) return undefined;
  return {
    schema: {
      type: "object",
      properties,
      required: keys,
      "x-audit-exact-properties": true,
    },
  };
}

/** Discover and parse the registered kernel.exception listener service. */
function resolveExceptionContract(ctx: ScanContext, analysis: PhpAnalysis): ExceptionContract | null {
  const services = new Map<string, any>();
  for (const document of configYamlDocuments(ctx)) {
    const serviceMap = document.entries.services;
    if (serviceMap && typeof serviceMap === "object") {
      for (const [id, definition] of Object.entries(serviceMap)) {
        if (id.startsWith("_") || !definition || typeof definition !== "object") continue;
        services.set(id, definition);
      }
    }
  }

  let listenerClass: PhpClass | undefined;
  let methodName = "onKernelException";
  for (const definition of services.values()) {
    const tags = definition.tags;
    if (!Array.isArray(tags)) continue;
    let matched = false;
    for (const tag of tags) {
      if (typeof tag === "string" && tag === "kernel.exception") matched = true;
      if (tag && typeof tag === "object" && tag.name === "kernel.event_listener" && tag.event === "kernel.exception") {
        matched = true;
        if (typeof tag.method === "string") methodName = tag.method;
      }
    }
    if (matched && typeof definition.class === "string") {
      const resolved = analysis.classes.get(definition.class.replace(/^\\/, ""));
      if (resolved) {
        listenerClass = resolved;
        break;
      }
    }
  }
  if (!listenerClass) return null;
  const method = listenerClass.methods.get(methodName);
  if (!method) return null;

  const statusByClass = new Map<string, string>();
  const bodyByClass = new Map<string, ExceptionBody>();
  let defaultStatus = "500";
  let defaultBody: ExceptionBody = { schema: {} };
  const statusCodeFromMethod = /method_exists\s*\([^,]+,\s*["']getStatusCode["']\s*\)/.test(method.text);

  for (const switchNode of findAll(method, (n) => n.type === "switch_statement" || n.type === "match_expression")) {
    // PHP models `default:` as its own default_statement node rather than a case_statement.
    const arms = findAll(
      switchNode,
      (n) => n.type === "case_statement" || n.type === "default_statement",
    );
    for (const arm of arms) {
      const fqcn = arm.type === "default_statement" ? undefined : caseMatchFqcn(arm, analysis);
      for (const assignment of findAll(arm, (n) => n.type === "assignment_expression")) {
        const lhs = assignment.namedChildren[0];
        const rhs = assignment.namedChildren[1];
        if (lhs?.type === "variable_name" && /statuscode|status|^code$/i.test(lhs.text.replace(/^\$/, ""))) {
          const status = statusFromRhs(rhs);
          if (status) {
            if (fqcn) statusByClass.set(fqcn, status);
            else defaultStatus = status;
            break;
          }
        }
      }
      const body = caseErrorBody(arm);
      if (body) {
        if (fqcn) bodyByClass.set(fqcn, body);
        else defaultBody = body;
      }
    }
  }

  let errorEnvelope: FosEnvelopeBinding | undefined;
  for (const call of findAll(method, (n) => n.type === "scoped_call_expression")) {
    const names = call.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
    const scopeName = names[0]?.text;
    const factoryMethod = names[names.length - 1]?.text;
    if (!scopeName || !factoryMethod) continue;
    if (/error|fail|exception/.test(factoryMethod.toLowerCase())) {
      const envelopeClass = resolvePhpClass(scopeName, analysis, call);
      if (envelopeClass) errorEnvelope = { envelopeFqcn: envelopeClass.fqcn, factoryMethod };
    }
  }

  return { statusByClass, bodyByClass, defaultStatus, defaultBody, statusCodeFromMethod, errorEnvelope };
}

/** Extract the HTTP status passed to parent::__construct() in an exception ctor. */
function exceptionConstructorStatus(exceptionClass: PhpClass): string | undefined {
  const constructor = exceptionClass.methods.get("__construct");
  if (!constructor) return undefined;
  for (const call of findAll(constructor, (n) => n.type === "scoped_call_expression")) {
    const scopeNode = call.namedChildren.find((c) => c.type === "relative_scope");
    if (scopeNode?.text !== "parent") continue;
    // The method name is the `name` child outside relative_scope (it sits under
    // the scope_resolution node); the parent name lives inside relative_scope.
    const methodName = call.namedChildren.find(
      (c) => c.type === "name" && c.parent?.type !== "relative_scope",
    )?.text;
    if (methodName !== "__construct") continue;
    const first = callArguments(call)[0];
    if (!first) continue;
    if (/^\d{3}$/.test(first.text.trim())) return first.text.trim();
    if (first.type === "variable_name") {
      for (const parameter of formalParameters(constructor)) {
        if (parameter.namedChildren.find((c) => c.type === "variable_name")?.text !== first.text) continue;
        const literal = parameter.namedChildren.find((c) => /^\d{3}$/.test(c.text.trim()));
        if (literal) return literal.text.trim();
      }
    }
  }
  return undefined;
}

/** Whether an exception exposes an HTTP status code to the listener. */
function exceptionExposesStatusCode(exceptionClass: PhpClass): boolean {
  if (exceptionClass.methods.has("getStatusCode")) return true;
  return /HttpException/.test(exceptionClass.extends ?? "");
}

// ---------------------------------------------------------------------------
// FOSRestBundle / RestRoutingBundle `type: rest` conventional routes
// ---------------------------------------------------------------------------

/**
 * FOSRest action naming convention, ordered so collection actions match
 * before item actions. `segment` is the URL shape relative to the resource
 * collection; `{id}` is substituted with the action's first scalar argument.
 */
interface FosActionRule {
  pattern: RegExp;
  verb: string;
  segment: "collection" | "item" | "new" | "edit";
}

const FOS_ACTION_RULES: FosActionRule[] = [
  { pattern: /^cget(\w+)Action$/, verb: "get", segment: "collection" },
  { pattern: /^post(\w+)Action$/, verb: "post", segment: "collection" },
  { pattern: /^new(\w+)Action$/, verb: "get", segment: "new" },
  { pattern: /^get(\w+)Action$/, verb: "get", segment: "item" },
  { pattern: /^edit(\w+)Action$/, verb: "get", segment: "edit" },
  { pattern: /^put(\w+)Action$/, verb: "put", segment: "item" },
  { pattern: /^patch(\w+)Action$/, verb: "patch", segment: "item" },
  { pattern: /^(?:delete|remove)(\w+)Action$/, verb: "delete", segment: "item" },
];

/** Container-provided action arguments that never name a path placeholder. */
const FOS_CONTAINER_ARG_TYPES = new Set([
  "Request",
  "ConstraintViolationInterface",
  "ConstraintViolationListInterface",
  "Session",
  "SessionInterface",
  "TokenStorageInterface",
  "AuthorizationCheckerInterface",
  "RouterInterface",
  "UrlGeneratorInterface",
  "FormInterface",
]);

/** Pluralize a resource name using the common English rules Doctrine/FOSRest use. */
function fosPluralize(word: string): string {
  const w = word.charAt(0).toLowerCase() + word.slice(1);
  if (/(?:ss|x|ch|sh|s)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/**
 * Find the file-relative path that declares a class (by FQCN or short name),
 * used to attribute route origins for routes synthesized from conventions.
 */
function classFileRel(analysis: PhpAnalysis, target: { fqcn: string; name: string }): string {
  for (const [rel, file] of analysis.files) {
    for (const cls of findAll(file.root, (n) => n.type === "class_declaration")) {
      const name = cls.namedChildren.find((c) => c.type === "name")?.text;
      if (name === target.name) {
        const ns = file.namespace ? `${file.namespace}\\${name}` : name;
        if (ns === target.fqcn) return rel;
      }
    }
  }
  return "";
}

/**
 * Identify an item action's identifier argument, e.g. `getBookAction($id)` -> id.
 * Container/service arguments (Request, sessions, ...) are skipped; an
 * untyped first scalar argument, as FOSRest actions conventionally use, wins.
 */
function fosIdArgument(methodNode: TsNode): string {
  for (const param of formalParameters(methodNode)) {
    const variable = param.namedChildren.find((c) => c.type === "variable_name");
    const pName = variable?.text.replace(/^\$/, "") ?? "";
    if (!pName) continue;
    const typeNode = param.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type");
    const typeShort = typeNode?.text.split("\\").pop() ?? "";
    if (typeNode && (FOS_CONTAINER_ARG_TYPES.has(typeShort) || /Request$/.test(typeShort))) continue;
    return pName;
  }
  return "id";
}

/**
 * Expand `type: rest` route imports. A FOSRest resource entry points at a
 * controller class (or namespace) and the loader derives routes from action
 * method names; the YAML `prefix` and `name_prefix` are honored. Only the JSON
 * representation is emitted (`defaults._format: json` / format listener), so
 * the optional `.{_format}` suffix is omitted from the OpenAPI paths.
 */
function fosRestRoutes(
  ctx: ScanContext,
  analysis: PhpAnalysis,
  model: PhpModelIndex,
  unresolved: DiscoveredUnresolved[],
  fos: FosConfig | undefined = undefined,
  exception: ExceptionContract | null = null,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const seen = new Set<string>();

  for (const doc of routingDocuments(ctx)) {
    for (const [entryName, entry] of Object.entries(doc.entries)) {
      if (!entry || typeof entry !== "object" || entry.type !== "rest") continue;
      const resource = typeof entry.resource === "string" ? entry.resource : null;
      if (!resource || resource.includes("::") || resource.includes("*")) continue;
      // A namespace/resource-directory import (ends with a namespace separator)
      // is not resolved to a single controller; skip rather than guess members.
      if (resource.endsWith("\\")) continue;

      const cls = analysis.classes.get(resource.replace(/^\\/, ""));
      if (!cls || !cls.node) {
        unresolved.push({
          reason: "unresolved-controller",
          message: `FOSRest type:rest import '${entryName}' references ${resource} which is not in the scanned tree`,
          origin: { file: doc.path, line: 0 },
        });
        continue;
      }

      const classBase = cls.name.replace(/Controller$/, "");
      const singular = classBase.charAt(0).toLowerCase() + classBase.slice(1);
      const plural = fosPluralize(classBase);
      const prefix = typeof entry.prefix === "string" ? entry.prefix : "";
      const rel = classFileRel(analysis, cls) || "";

      for (const [methodName, methodNode] of cls.methods) {
        const rule = FOS_ACTION_RULES.find((r) => r.pattern.test(methodName));
        if (!rule) continue;

        const idName = fosIdArgument(methodNode);
        let segment = "";
        switch (rule.segment) {
          case "collection":
            segment = plural;
            break;
          case "new":
            segment = `${plural}/new`;
            break;
          case "item":
            segment = `${plural}/{${idName}}`;
            break;
          case "edit":
            segment = `${plural}/{${idName}}/edit`;
            break;
        }
        const path = normalizeSymfonyPath(joinPath(prefix, segment));
        const dedupeKey = `${rule.verb} ${path}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const candidate = buildCandidate({
          analysis,
          model,
          rel,
          methodNode,
          className: cls.name,
          methodName,
          path,
          name: "",
          verb: rule.verb,
          originNode: methodNode,
          fos,
          exception,
        });
        if (candidate) {
          // The resource identifier is an FOSRest scalar route argument.
          if (rule.segment === "item" || rule.segment === "edit") {
            if (!candidate.parameters.some((p) => p.in === "path" && p.name === idName)) {
              candidate.parameters.push({
                name: idName,
                in: "path",
                required: true,
                schema: { type: "string" },
                confidence: "medium",
              });
            }
          }
          out.push(candidate);
        }
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
