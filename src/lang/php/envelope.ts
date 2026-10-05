/**
 * Static inference for "envelope factory" response shapes commonly used by
 * JSON APIs (Jttp, ApiResponse, Responder, ...).
 *
 * The pattern is framework agnostic:
 *   class Envelope {
 *     const STATUS_SUCCESS = 'success';
 *     const FIELD_DATA = 'data';
 *     function __construct($status, $code, $message, $data) { $this->data = $data; ... }
 *     static function success($payload) { return new static(STATUS_SUCCESS, 200, 'OK', $payload); }
 *     function toArray() {
 *       $res[self::FIELD_STATUS] = $this->status;   // common keys
 *       switch ($this->status) {
 *         case self::STATUS_SUCCESS:
 *           $res[self::FIELD_DATA] = $this->data;   // branch keys
 *       }
 *       return $res;
 *     }
 *   }
 *
 * The analyzer resolves class constants, constructor parameter names, factory
 * arguments and the serializer's common/per-branch keys, then substitutes the
 * caller-provided payload schema for the property that carries the factory
 * parameter. It never assumes project-specific key names. When any link cannot
 * be proven statically it returns null so the caller can report an honest gap.
 */

import type { JsonSchema } from "../../core/types.js";
import type { PhpAnalysis, PhpClass } from "./index.js";
import { phpStringText, resolvePhpClass, findPhpMethod } from "./index.js";
import type { TsNode } from "../treesitter/runtime.js";
import { childrenOfType, findAll, findFirst } from "../treesitter/ast.js";
import { formalParameters } from "./schema.js";
import { phpHttpConstantByName } from "./response.js";

type PropertyName = string;
type OutputKey = string;

/** Strip surrounding quotes from a PHP string constant raw value. */
function unquote(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/** Parse `const NAME = value;` declarations from a class body (raw value text). */
function parseClassConstants(cls: PhpClass): Map<string, string> {
  const constants = new Map<string, string>();
  if (!cls.node) return constants;
  const re = /(?:public|protected|private)?\s*const\s+(\w+)\s*=\s*([^;]+?)\s*;/g;
  for (const match of cls.node.text.matchAll(re)) {
    constants.set(match[1]!, match[2]!.trim());
  }
  return constants;
}

function unwrapArgument(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  return node.type === "argument" ? node.namedChildren[0] : node;
}

function callArguments(node: TsNode): TsNode[] {
  const args = node.namedChildren.find((c) => c.type === "arguments");
  if (!args) return [];
  return childrenOfType(args, "argument").map(unwrapArgument).filter((n): n is TsNode => Boolean(n));
}

/** Resolve a `self::X` / `static::X` constant access to its declared raw value. */
function selfConstantValue(node: TsNode | undefined, cls: PhpClass, constants: Map<string, string>): string | undefined {
  if (!node || node.type !== "class_constant_access_expression") return undefined;
  // tree-sitter-php renders the scope as a `relative_scope` node (self/static/
  // parent) and the constant as a trailing `name`.
  const scope = node.namedChildren.find((c) => c.type === "relative_scope")?.text.toLowerCase();
  const constant = node.namedChildren.filter((c) => c.type === "name").slice(-1)[0]?.text;
  if (!constant) return undefined;
  if (scope === "self" || scope === "static") return constants.get(constant);
  return undefined;
}

/** Evaluate a factory argument expression down to a JSON Schema. */
function evaluateFactoryArg(
  arg: TsNode,
  cls: PhpClass,
  constants: Map<string, string>,
  analysis: PhpAnalysis,
): JsonSchema | undefined {
  // static::STATUS_SUCCESS / self::STATUS_ERROR
  const selfConst = selfConstantValue(arg, cls, constants);
  if (selfConst !== undefined) return scalarFromRaw(selfConst, analysis, arg);

  // SomeClass::someHelper()
  if (arg.type === "scoped_call_expression") {
    return evaluateStaticHelper(arg, analysis);
  }

  if (arg.type === "string" || arg.type === "string_content") return { type: "string" };
  if (arg.type === "integer") return { type: "integer" };
  if (arg.type === "float") return { type: "number" };
  if (arg.type === "boolean" || arg.type === "true" || arg.type === "false") return { type: "boolean" };
  if (arg.type === "null") return { type: "null" };
  return undefined;
}

/** Resolve a raw constant value (quoted string or an HTTP status constant). */
function scalarFromRaw(raw: string, analysis: PhpAnalysis, at: TsNode): JsonSchema | undefined {
  const quoted = /^(["'])(.*)\1$/.exec(raw.trim());
  if (quoted) return { type: "string", const: quoted[2] };
  // Response::HTTP_OK
  const classConst = /^([\w\\]+)::(\w+)$/.exec(raw.trim());
  if (classConst) {
    const scope = resolvePhpClass(classConst[1]!, analysis, at);
    if (scope) {
      const constants = parseClassConstants(scope);
      const nested = constants.get(classConst[2]!);
      if (nested !== undefined) return scalarFromRaw(nested, analysis, at);
    }
    // Symfony/PSR-7 status constants are a fixed framework contract.
    if (phpHttpConstantByName(classConst[2]!)) return { type: "integer" };
  }
  if (/^\d+$/.test(raw.trim())) return { type: "integer" };
  return undefined;
}

/** Infer the return schema of a static helper method such as HttpUtils::getHttpStatus(). */
function evaluateStaticHelper(call: TsNode, analysis: PhpAnalysis): JsonSchema | undefined {
  const names = call.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
  const scopeName = names[0]?.text;
  const methodName = names[names.length - 1]?.text;
  if (!scopeName || !methodName) return undefined;
  const scope = resolvePhpClass(scopeName, analysis, call);
  if (!scope) return undefined;
  const method = findPhpMethod(scope, methodName, analysis);
  if (!method) return undefined;

  // Declared scalar return type wins for dynamic lookups (e.g. `: string`).
  const returnType =
    method.childForFieldName?.("return_type") ??
    method.namedChildren.find((c) => ["named_type", "primitive_type", "optional_type"].includes(c.type));
  if (returnType) {
    const text = returnType.text.replace(/^\?/, "").split("\\").pop()!.toLowerCase();
    if (text === "string") return { type: "string" };
    if (text === "int" || text === "integer") return { type: "integer" };
    if (text === "float" || text === "double") return { type: "number" };
    if (text === "bool" || text === "boolean") return { type: "boolean" };
    if (text === "array") return { type: "array", items: {} };
  }
  // return Response::HTTP_OK
  for (const ret of findAll(method, (n) => n.type === "return_statement")) {
    const expr = ret.namedChildren.find((c) => c.type === "class_constant_access_expression");
    if (expr) {
      const names = expr.namedChildren.filter((c) => c.type === "name" || c.type === "qualified_name");
      const constant = names[names.length - 1]?.text;
      if (constant && phpHttpConstantByName(constant)) return { type: "integer" };
    }
  }
  return undefined;
}

interface SerializerLayout {
  common: Map<OutputKey, PropertyName>;
  branches: Map<string, Map<OutputKey, PropertyName>>;
}

/** Read toArray()/jsonSerialize() into common keys and per-status branch keys. */
function readSerializerLayout(serializer: TsNode, cls: PhpClass, constants: Map<string, string>): SerializerLayout {
  const common = new Map<OutputKey, PropertyName>();
  const branches = new Map<string, Map<OutputKey, PropertyName>>();

  for (const assignment of findAll(serializer, (n) => n.type === "assignment_expression")) {
    const lhs = assignment.namedChildren[0];
    const rhs = assignment.namedChildren[1];
    if (!lhs || lhs.type !== "subscript_expression" || !rhs) continue;

    const keyNode = lhs.namedChildren.find((c) => c.type === "class_constant_access_expression" || c.type === "string");
    const valueMember = rhs.type === "member_access_expression" ? rhs : undefined;
    if (!keyNode || !valueMember) continue;

    let key: string | undefined;
    if (keyNode.type === "string") key = phpStringText(keyNode) ?? undefined;
    else {
      const rawKey = selfConstantValue(keyNode, cls, constants);
      key = rawKey !== undefined ? unquote(rawKey) : undefined;
    }
    const property = valueMember.namedChildren.find((c) => c.type === "name")?.text;
    if (!key || !property) continue;

    // Determine whether the assignment sits inside `case self::STATUS_*:`.
    let scope: TsNode | undefined = assignment.parent ?? undefined;
    let caseNode: TsNode | undefined;
    while (scope && scope !== serializer) {
      if (scope.type === "case_statement") {
        caseNode = scope;
        break;
      }
      scope = scope.parent ?? undefined;
    }

    if (caseNode) {
      const condition = caseNode.namedChildren.find(
        (c) => c.type === "class_constant_access_expression" || c.type === "string" || c.type === "string_content",
      );
      let branch: string | undefined;
      if (condition?.type === "class_constant_access_expression") {
        const rawBranch = selfConstantValue(condition, cls, constants);
        branch = rawBranch !== undefined ? unquote(rawBranch) : undefined;
      } else if (condition) {
        branch = phpStringText(condition) ?? condition.text.replace(/^["']|["']$/g, "");
      }
      if (branch) {
        if (!branches.has(branch)) branches.set(branch, new Map());
        branches.get(branch)!.set(key, property);
        continue;
      }
    }
    common.set(key, property);
  }

  return { common, branches };
}

export interface EnvelopeOptions {
  analysis: PhpAnalysis;
  envelopeClass: PhpClass;
  factoryMethod: string;
  payload: JsonSchema;
  /** Proven values that override factory-derived properties (e.g. a dynamic code). */
  fixedProperties?: Record<string, JsonSchema>;
}

/** Coarse JSON schema for a constructor/factory parameter type hint. */
function paramTypeSchema(node: TsNode | undefined): JsonSchema | undefined {
  if (!node) return undefined;
  const inner = node.type === "optional_type" || node.type === "nullable_type"
    ? node.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type")
    : node;
  const text = (inner ?? node).text.replace(/^\?/, "").toLowerCase();
  if (text === "int" || text === "integer") return { type: "integer" };
  if (text === "float" || text === "double" || text === "number") return { type: "number" };
  if (text === "bool" || text === "boolean") return { type: "boolean" };
  if (text === "array" || text === "iterable") return { type: "object" };
  if (text === "string") return { type: "string" };
  if (/\[\]$/.test(text)) return { type: "array", items: {} };
  if (inner?.type === "named_type" || node.type === "named_type") return { type: "object" };
  return undefined;
}

/** Whether a factory parameter is declared as an array (the payload carrier). */
function paramIsArray(parameter: TsNode): boolean {
  const typeNode = parameter.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type" || c.type === "optional_type");
  const text = (typeNode?.text ?? "").replace(/^\?/, "").toLowerCase();
  return text === "array" || text === "iterable";
}

/**
 * Build the serialized envelope object emitted by a static factory method.
 * Returns null when the structure cannot be proven from source alone.
 */
export function inferEnvelopeSchema(options: EnvelopeOptions): JsonSchema | null {
  const { analysis, envelopeClass: cls, factoryMethod, payload, fixedProperties } = options;
  const constants = parseClassConstants(cls);

  const serializer = cls.methods.get("toArray") ?? cls.methods.get("jsonSerialize");
  const factory = cls.methods.get(factoryMethod);
  const ctor = cls.methods.get("__construct");
  if (!serializer || !factory || !ctor) return null;

  const creation = findFirst(factory, (n) => n.type === "object_creation_expression");
  if (!creation) return null;
  const factoryArgs = callArguments(creation);

  // The branch is selected by the status value the factory passes first, e.g.
  // new static(static::STATUS_SUCCESS, ...) -> the STATUS_SUCCESS constant value.
  const firstRaw = factoryArgs[0] ? selfConstantValue(factoryArgs[0], cls, constants) : undefined;
  if (firstRaw === undefined) return null;
  const branchValue = unquote(firstRaw);

  // Constructor parameter nodes carry a leading `$`; serializer property names
  // come from `$this->name` without it, so normalize to bare property names.
  const ctorParameterList = formalParameters(ctor);
  const ctorParams = ctorParameterList
    .map((p) => p.namedChildren.find((c) => c.type === "variable_name")?.text)
    .filter(Boolean)
    .map((name) => (name as string).replace(/^\$/, ""));
  const ctorTypeByName = new Map<string, JsonSchema | undefined>();
  ctorParameterList.forEach((p) => {
    const name = p.namedChildren.find((c) => c.type === "variable_name")?.text.replace(/^\$/, "");
    if (name) ctorTypeByName.set(name, paramTypeSchema(p.namedChildren.find((c) => c.type === "named_type" || c.type === "primitive_type" || c.type === "optional_type")));
  });
  // Factory parameter nodes keyed by variable text (the variable argument node
  // keeps its leading `$`).
  const factoryParameterByVar = new Map<string, TsNode>();
  for (const p of formalParameters(factory)) {
    const variable = p.namedChildren.find((c) => c.type === "variable_name")?.text;
    if (variable) factoryParameterByVar.set(variable, p);
  }

  const layout = readSerializerLayout(serializer, cls, constants);
  const branch = layout.branches.get(branchValue);
  if (!branch) return null;

  // Map constructor property name -> schema for each factory argument.
  const propertySchemas = new Map<PropertyName, JsonSchema>();

  factoryArgs.forEach((arg, index) => {
    const property = ctorParams[index];
    if (!property) return;
    if (arg.type === "variable_name" && factoryParameterByVar.has(arg.text)) {
      // Only an array-typed factory parameter forwarded into this branch's
      // payload property carries the caller payload; scalar parameters such as
      // a dynamic status code fall back to their declared type.
      const factoryParameter = factoryParameterByVar.get(arg.text)!;
      if (paramIsArray(factoryParameter) && branch.has(property)) {
        propertySchemas.set(property, payload);
      }
      return;
    }
    const schema = evaluateFactoryArg(arg, cls, constants, analysis);
    if (schema) propertySchemas.set(property, schema);
  });

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const entries: [OutputKey, PropertyName][] = [
    ...layout.common.entries(),
    ...branch.entries(),
  ];

  for (const [key, property] of entries) {
    const fixed = fixedProperties?.[key];
    if (fixed) {
      properties[key] = fixed;
      required.push(key);
      continue;
    }
    const derived = propertySchemas.get(property) ?? ctorTypeByName.get(property);
    if (!derived || !Object.keys(derived).length) return null; // an output key whose value we cannot prove -> honest gap
    properties[key] = derived;
    required.push(key);
  }

  return {
    type: "object",
    properties,
    required,
    "x-audit-exact-properties": true,
  };
}
