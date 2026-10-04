import type { JsonSchema } from "../../core/types.js";

/**
 * Syntactic converter for fluent-json-schema builder chains, e.g.
 *
 *   S.object()
 *     .prop("email", S.string().required())
 *     .prop("age", S.integer().minimum(0))
 *
 * Conversion is purely syntactic (no type checker, no package required at scan
 * time), so it works for plain JavaScript projects too. Only the documented
 * fluent-json-schema API surface relevant to HTTP contracts is handled;
 * anything else returns null and the caller records an honest schema gap.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

interface ChainStep {
  name: string;
  args: AnyNode[];
}

const TYPE_CONSTRUCTORS = new Set([
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
]);

const COMBINATORS = new Set(["oneOf", "anyOf", "allOf"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callChain(ts: any, node: AnyNode): { base: AnyNode; steps: ChainStep[] } | null {
  const steps: ChainStep[] = [];
  let cur = node;
  while (
    cur &&
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression)
  ) {
    steps.unshift({
      name: cur.expression.name.text,
      args: [...cur.arguments],
    });
    cur = cur.expression.expression;
  }
  if (!cur) return null;
  return { base: cur, steps };
}

function literalValue(ts: any, node: AnyNode, depth = 0): unknown {
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
    return node.elements.map((el: AnyNode) => literalValue(ts, el, depth + 1));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name?.getText?.().replace(/^['"]|['"]$/g, "");
        if (name) out[name] = literalValue(ts, prop.initializer, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

function chainHasRequired(ts: any, node: AnyNode): boolean {
  const chain = callChain(ts, node);
  if (!chain) return false;
  // On an object builder, required() after prop() targets that property,
  // not the object itself. required([names]) always targets child properties.
  let hasProperty = false;
  return chain.steps.some(step => {
    if (step.name === "prop") hasProperty = true;
    return step.name === "required" && !hasProperty &&
      !(step.args[0] && ts.isArrayLiteralExpression(step.args[0]));
  });
}

export interface FluentContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  depth?: number;
}

/**
 * Converts a fluent-json-schema node (builder call, plain JSON literal, or an
 * array of builder calls) to a JSON Schema object. Returns null when the node
 * cannot be recognized as a schema definition.
 */
export function convertFluentNode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: AnyNode,
  rc: FluentContext,
): JsonSchema | null {
  const depth = rc.depth ?? 0;
  if (depth > 10 || !node) return null;
  const { ts } = rc;

  // A plain object literal is already a JSON Schema node.
  if (ts.isObjectLiteralExpression(node)) {
    const value = literalValue(ts, node) as JsonSchema | undefined;
    if (value && typeof value === "object") return value;
    return null;
  }

  if (ts.isArrayLiteralExpression(node)) {
    const members = node.elements
      .map((el: AnyNode) => convertFluentNode(el, { ts, depth: depth + 1 }))
      .filter((s: JsonSchema | null): s is JsonSchema => Boolean(s));
    return members.length ? { oneOf: members } : null;
  }

  const chain = callChain(ts, node);
  if (!chain) return null;
  const { base, steps } = chain;

  // Static root call carried as the first chain step when written bare,
  // e.g. S.oneOf([...]), S.ref("#/..."), S.raw({...}), S.not(S.string()).
  const staticBase =
    !ts.isCallExpression(base) && steps[0]
      ? { name: steps[0].name, args: steps[0].args }
      : ts.isCallExpression(base) &&
          ts.isPropertyAccessExpression(base.expression)
        ? { name: base.expression.name.text, args: base.arguments }
        : null;
  const tailSteps = staticBase && !ts.isCallExpression(base) ? steps.slice(1) : steps;

  if (staticBase && COMBINATORS.has(staticBase.name)) {
    const name = staticBase.name as "oneOf" | "anyOf" | "allOf";
    const schemas = convertSchemaArray(ts, staticBase.args[0], depth);
    const schema: JsonSchema = schemas.length ? { [name]: schemas } : {};
    return applyTailSteps(ts, schema, tailSteps, depth);
  }

  if (staticBase && staticBase.name === "ref") {
    const target = stringLiteral(ts, staticBase.args[0]);
    if (target === undefined) return null;
    const schema: JsonSchema = { $ref: target };
    return applyTailSteps(ts, schema, tailSteps, depth);
  }

  if (staticBase && staticBase.name === "raw") {
    const raw = literalValue(ts, staticBase.args[0]) as JsonSchema | undefined;
    const schema: JsonSchema = { ...(raw ?? {}) };
    delete schema.$schema;
    return applyTailSteps(ts, schema, tailSteps, depth);
  }

  if (staticBase && staticBase.name === "not") {
    const nested = convertFluentNode(staticBase.args[0], { ts, depth: depth + 1 });
    const schema: JsonSchema = nested ? { not: nested } : {};
    return applyTailSteps(ts, schema, tailSteps, depth);
  }

  // Regular builder chain: the first step is the type constructor.
  const ctor = steps[0];
  if (!ctor || !TYPE_CONSTRUCTORS.has(ctor.name)) return null;
  const rest = steps.slice(1);

  const schema: JsonSchema =
    ctor.name === "null" ? { type: "null" } : { type: ctor.name };

  if (ctor.name === "object") {
    return buildObject(ts, schema, rest, depth);
  }
  if (ctor.name === "array") {
    return buildArray(ts, schema, rest, depth);
  }
  return applyTailSteps(ts, schema, rest, depth);
}

function convertSchemaArray(
  ts: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  node: AnyNode,
  depth: number,
): JsonSchema[] {
  if (!node || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements
    .map((el: AnyNode) => convertFluentNode(el, { ts, depth: depth + 1 }))
    .filter((s: JsonSchema | null): s is JsonSchema => Boolean(s));
}

function numericLiteral(ts: any, node: AnyNode): number | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (node && ts.isNumericLiteral(node)) return Number(node.text);
  if (
    node &&
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand)
  ) {
    return Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
  }
  return undefined;
}

function booleanLiteral(ts: any, node: AnyNode): boolean | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function stringLiteral(ts: any, node: AnyNode): string | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRaw(schema: JsonSchema, ts: any, rawNode: AnyNode): void {
  const raw = literalValue(ts, rawNode) as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (key === "$schema") continue;
      schema[key] = value;
    }
  }
}

/**
 * Applies builder methods shared by every schema type (constraints, annotations,
 * combinators, raw extensions).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTailSteps(ts: any, schema: JsonSchema, steps: ChainStep[], depth: number): JsonSchema {
  for (const step of steps) {
    const [arg0] = step.args;
    switch (step.name) {
      case "valueOf":
      case "required":
        // `required` on a non-object child is a parent-side marker consumed
        // when the parent processes `.prop`; nothing to emit here.
        break;
      case "enum": {
        const values = literalValue(ts, arg0);
        if (Array.isArray(values)) schema.enum = values;
        break;
      }
      case "const": {
        const value = literalValue(ts, arg0);
        if (value !== undefined) schema.const = value;
        break;
      }
      case "default": {
        const value = literalValue(ts, arg0);
        if (value !== undefined) schema.default = value;
        break;
      }
      case "examples": {
        const values = literalValue(ts, arg0);
        if (Array.isArray(values)) schema.examples = values;
        break;
      }
      case "description": {
        const value = stringLiteral(ts, arg0);
        if (value !== undefined) schema.description = value;
        break;
      }
      case "title": {
        const value = stringLiteral(ts, arg0);
        if (value !== undefined) schema.title = value;
        break;
      }
      case "id":
      case "$id": {
        const value = stringLiteral(ts, arg0);
        if (value !== undefined) schema.$id = value;
        break;
      }
      case "format": {
        const value = stringLiteral(ts, arg0);
        if (value !== undefined) schema.format = value;
        break;
      }
      case "pattern": {
        const value = stringLiteral(ts, arg0);
        if (value !== undefined) schema.pattern = value;
        break;
      }
      case "minLength":
      case "maxLength":
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
      case "multipleOf":
      case "minItems":
      case "maxItems":
      case "minProperties":
      case "maxProperties": {
        const value = numericLiteral(ts, arg0);
        if (value !== undefined) schema[step.name] = value;
        break;
      }
      case "uniqueItems": {
        const value = booleanLiteral(ts, arg0);
        if (value !== undefined) schema.uniqueItems = value;
        break;
      }
      case "additionalProperties": {
        const bool = booleanLiteral(ts, arg0);
        if (bool !== undefined) {
          schema.additionalProperties = bool;
        } else {
          const nested = convertFluentNode(arg0, { ts, depth: depth + 1 });
          if (nested) schema.additionalProperties = nested;
        }
        break;
      }
      case "oneOf":
      case "anyOf":
      case "allOf": {
        const schemas = convertSchemaArray(ts, arg0, depth);
        if (schemas.length) schema[step.name] = schemas;
        break;
      }
      case "not": {
        const nested = convertFluentNode(arg0, { ts, depth: depth + 1 });
        if (nested) schema.not = nested;
        break;
      }
      case "raw":
        applyRaw(schema, ts, arg0);
        break;
      default:
        break;
    }
  }
  return schema;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildObject(ts: any, schema: JsonSchema, steps: ChainStep[], depth: number): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  let lastProp: string | null = null;

  for (const step of steps) {
    if (step.name === "prop") {
      const [nameNode, valueNode, requiredNode] = step.args;
      const name =
        nameNode && ts.isStringLiteralLike(nameNode) ? nameNode.text : null;
      if (!name) continue;
      const nested = convertFluentNode(valueNode, { ts, depth: depth + 1 });
      properties[name] = nested ?? {};
      lastProp = name;
      const explicitlyRequired =
        booleanLiteral(ts, requiredNode) === true ||
        chainHasRequired(ts, valueNode);
      if (explicitlyRequired && !required.includes(name)) required.push(name);
      continue;
    }
    if (step.name === "required") {
      // fluent-json-schema marks the most recently declared property.
      const names = literalValue(ts, step.args[0]);
      if (Array.isArray(names)) {
        for (const name of names) if (typeof name === "string" && !required.includes(name)) required.push(name);
      } else if (lastProp && !required.includes(lastProp)) required.push(lastProp);
      continue;
    }
    if (step.name === "additionalProperties") {
      const bool = booleanLiteral(ts, step.args[0]);
      if (bool !== undefined) {
        schema.additionalProperties = bool;
      } else {
        const nested = convertFluentNode(step.args[0], { ts, depth: depth + 1 });
        if (nested) schema.additionalProperties = nested;
      }
      continue;
    }
    // Other generic methods are handled by the shared tail applier.
    applyTailSteps(ts, schema, [step], depth);
  }

  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required;
  return schema;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildArray(ts: any, schema: JsonSchema, steps: ChainStep[], depth: number): JsonSchema {
  for (const step of steps) {
    if (step.name === "items") {
      const arg0 = step.args[0];
      if (arg0 && ts.isArrayLiteralExpression(arg0)) {
        // Tuple form: items is an ordered schema array.
        const schemas = convertSchemaArray(ts, arg0, depth);
        if (schemas.length) schema.items = schemas;
      } else {
        const nested = convertFluentNode(arg0, { ts, depth: depth + 1 });
        if (nested) schema.items = nested;
      }
      continue;
    }
    applyTailSteps(ts, schema, [step], depth);
  }
  return schema;
}
