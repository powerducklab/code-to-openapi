import type { JsonSchema } from "../../core/types.js";

/**
 * express-validator chains (body('email').isEmail().notEmpty(), ...).
 * Returns one field descriptor per chain. Chains are middleware arguments on
 * the route call, not statements inside the handler.
 */

export interface ValidatedField {
  location: "body" | "query" | "header" | "params" | "cookies";
  name: string;
  required: boolean;
  schema: JsonSchema;
}

const STARTERS = new Set(["body", "query", "header", "headers", "param", "params", "cookie"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chainMethods(ts: any, node: any): Array<{ name: string; args: any[] }> {
  const steps: Array<{ name: string; args: any[] }> = [];
  let cur = node;
  while (
    cur &&
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression)
  ) {
    steps.unshift({ name: cur.expression.name.text, args: [...cur.arguments] });
    cur = cur.expression.expression;
  }
  return steps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertValidatorChain(ts: any, node: any): ValidatedField | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const steps = chainMethods(ts, node);
  const start = steps[0];
  if (!start || !STARTERS.has(start.name)) return null;

  const fieldNode = start.args[0];
  if (!fieldNode || !ts.isStringLiteralLike(fieldNode)) return null;

  let type: JsonSchema["type"] = "string";
  let format: string | undefined;
  let required = false;
  let optional = false;

  for (const step of steps.slice(1)) {
    switch (step.name) {
      case "notEmpty":
      case "exists":
      case "isString":
      case "isEmail":
      case "isUUID":
      case "isURL":
      case "isInt":
      case "isFloat":
      case "isBoolean":
      case "isArray":
      case "isObject":
        required = true;
        break;
      case "optional":
        optional = true;
        break;
      default:
        break;
    }
    if (step.name === "isEmail") format = "email";
    if (step.name === "isUUID") format = "uuid";
    if (step.name === "isURL") format = "uri";
    if (step.name === "isInt") type = "integer";
    if (step.name === "isFloat") type = "number";
    if (step.name === "isBoolean") type = "boolean";
    if (step.name === "isArray") type = "array";
    if (step.name === "isObject") type = "object";
  }

  const locationMap = {
    body: "body",
    query: "query",
    header: "header",
    headers: "header",
    param: "params",
    params: "params",
    cookie: "cookies",
  } as const;

  return {
    location: locationMap[start.name as keyof typeof locationMap],
    name: fieldNode.text,
    required: required && !optional,
    schema: { type, ...(format ? { format } : {}) },
  };
}
