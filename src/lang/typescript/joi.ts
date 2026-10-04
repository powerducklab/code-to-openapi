import type { JsonSchema } from "../../core/types.js";

/**
 * Syntactic Joi schema conversion. Works without type checking, so it also
 * covers plain JavaScript and the very common `celebrate({ body: Joi... })` /
 * custom `validate(schema)` middleware layout. Only the subset relevant to HTTP
 * contracts is supported; a schema that cannot be read returns null and the
 * caller records a gap instead of guessing.
 */

interface ChainStep {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callChain(ts: any, node: any): { base: any; steps: ChainStep[] } | null {
  const steps: ChainStep[] = [];
  let cur = node;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    steps.unshift({ name: cur.expression.name.text, args: [...cur.arguments] });
    cur = cur.expression.expression;
  }
  if (!cur) return null;
  return { base: cur, steps };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function literalValue(ts: any, node: any): unknown {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function propertyName(ts: any, name: any): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

/** True when a call chain is rooted at the Joi default import (`Joi.string()`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isJoiSchema(ts: any, node: any): boolean {
  const chain = callChain(ts, node);
  if (!chain) return false;
  const root = chain.base;
  if (ts.isIdentifier(root) && root.text === "Joi") return true;
  // `Joi.object({...})` without trailing modifiers.
  if (
    ts.isPropertyAccessExpression(root) &&
    ts.isIdentifier(root.expression) &&
    root.expression.text === "Joi"
  ) {
    return true;
  }
  return false;
}

interface Conversion {
  required: boolean;
  schema: JsonSchema;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convert(ts: any, node: any, depth: number): Conversion | null {
  if (depth > 10 || !node) return null;

  // Joi.object({ ... }) with the shape passed directly to the constructor.
  const directObject =
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Joi" &&
    node.expression.name.text === "object" &&
    node.arguments[0] &&
    ts.isObjectLiteralExpression(node.arguments[0]);

  const chain = callChain(ts, node);
  if (!chain && !directObject) return null;

  const steps = chain?.steps ?? [];
  const typeName = directObject ? "object" : (steps[0]?.name ?? "any");
  const rest = directObject ? [] : steps.slice(1);

  let required = false;
  let allowsNull = false;
  const schema: JsonSchema = {};

  const applyModifiers = (target: JsonSchema) => {
    for (const step of rest) {
      switch (step.name) {
        case "required":
        case "exist":
          required = true;
          break;
        case "optional":
        case "forbidden":
          required = false;
          break;
        case "allow":
          if (step.args.some((arg) => arg.kind === ts.SyntaxKind.NullKeyword)) {
            allowsNull = true;
          }
          break;
        case "valid":
        case "equal": {
          const values = step.args.map((arg) => literalValue(ts, arg)).filter((v) => v !== undefined);
          if (values.length) target.enum = values;
          break;
        }
        case "email":
          target.format = "email";
          break;
        case "guid":
        case "uuid":
          target.format = "uuid";
          break;
        case "uri":
        case "url":
          target.format = "uri";
          break;
        case "hostname":
        case "fqdn":
          target.format = "hostname";
          break;
        case "pattern": {
          const regex = step.args[0];
          if (regex?.text) target.pattern = String(regex.text).slice(1, -1);
          break;
        }
        case "min":
          if (target.type === "string") target.minLength = Number(step.args[0]?.text);
          else if (target.type === "number" || target.type === "integer")
            target.minimum = Number(step.args[0]?.text);
          else if (target.type === "array") target.minItems = Number(step.args[0]?.text);
          break;
        case "max":
          if (target.type === "string") target.maxLength = Number(step.args[0]?.text);
          else if (target.type === "number" || target.type === "integer")
            target.maximum = Number(step.args[0]?.text);
          else if (target.type === "array") target.maxItems = Number(step.args[0]?.text);
          break;
        case "length":
          if (target.type === "array") target.minItems = target.maxItems = Number(step.args[0]?.text);
          else if (target.type === "string")
            target.minLength = target.maxLength = Number(step.args[0]?.text);
          break;
        case "description":
        case "label": {
          const text = literalValue(ts, step.args[0]);
          if (typeof text === "string" && step.name === "description") target.description = text;
          break;
        }
        default:
          break;
      }
    }
  };

  if (typeName === "object") {
    schema.type = "object";
    const keysArg =
      (directObject ? node.arguments[0] : undefined) ??
      rest.find((step) => step.name === "keys" && step.args[0])?.args[0];
    if (keysArg && ts.isObjectLiteralExpression(keysArg)) {
      const properties: Record<string, JsonSchema> = {};
      const requiredNames: string[] = [];
      for (const prop of keysArg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propertyName(ts, prop.name);
        if (!name) continue;
        const child = convert(ts, prop.initializer, depth + 1);
        if (!child) {
          properties[name] = {};
          continue;
        }
        properties[name] = child.schema;
        if (child.required) requiredNames.push(name);
      }
      schema.properties = properties;
      if (requiredNames.length) schema.required = requiredNames;
    }
    applyModifiers(schema);
  } else if (typeName === "array") {
    schema.type = "array";
    const itemsStep = rest.find((step) => step.name === "items" && step.args[0]);
    if (itemsStep) {
      const children = itemsStep.args
        .map((arg) => convert(ts, arg, depth + 1))
        .filter(Boolean) as Conversion[];
      if (children.length === 1) schema.items = children[0]!.schema;
      else if (children.length > 1) schema.items = { anyOf: children.map((c) => c.schema) };
      else schema.items = {};
    } else {
      schema.items = {};
    }
    applyModifiers(schema);
  } else if (typeName === "alternatives" || typeName === "alt") {
    const tryStep = rest.find((step) => step.name === "try" && step.args.length);
    if (tryStep) {
      const children = tryStep.args
        .map((arg) => convert(ts, arg, depth + 1))
        .filter(Boolean) as Conversion[];
      if (children.length === 1) Object.assign(schema, children[0]!.schema);
      else if (children.length > 1) schema.anyOf = children.map((c) => c.schema);
    }
    applyModifiers(schema);
  } else if (typeName === "number") {
    schema.type = rest.some((step) => step.name === "integer") ? "integer" : "number";
    applyModifiers(schema);
  } else if (typeName === "boolean" || typeName === "bool") {
    schema.type = "boolean";
    applyModifiers(schema);
  } else if (typeName === "date") {
    schema.type = "string";
    schema.format = "date-time";
    applyModifiers(schema);
  } else if (typeName === "binary") {
    schema.type = "string";
    schema.format = "binary";
    applyModifiers(schema);
  } else if (typeName === "string") {
    schema.type = "string";
    applyModifiers(schema);
  } else {
    // any / unknown / alternatives.conditional / custom types: leave untyped.
    applyModifiers(schema);
  }

  if (allowsNull) {
    const base = { ...schema };
    return { required, schema: { anyOf: [base, { type: "null" }] } };
  }
  return { required, schema };
}

/** Converts a Joi schema node to a JSON Schema, or null when it is unreadable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertJoiNode(ts: any, node: any): JsonSchema | null {
  if (!isJoiSchema(ts, node)) return null;
  return convert(ts, node, 0)?.schema ?? null;
}
