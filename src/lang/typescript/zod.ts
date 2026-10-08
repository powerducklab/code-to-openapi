import { partialSchema } from "../../core/partial-schema.js";
import type { JsonSchema } from "../../core/types.js";

/**
 * Syntactic Zod schema conversion. Works without type checking, so it also
 * covers plain JavaScript. Only the subset relevant to HTTP contracts is
 * supported; unknown chains return null and the caller records a gap.
 */

interface ChainStep {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callChain(ts: any, node: any): { base: any; steps: ChainStep[] } | null {
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

export interface ZodResolveContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceFile: any;
  /** Resolves an imported/local schema identifier to its initializer node. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveSchemaBinding: (name: string, from?: any) => any | null;
  depth?: number;
  mode?: "input" | "output";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function propertyNameText(ts: any, name: any): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return String(name.text).replace(/['"]/g, "");
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertZodNode(node: any, rc: ZodResolveContext): JsonSchema | null {
  const depth = rc.depth ?? 0;
  if (depth > 16 || !node) return null;
  const { ts } = rc;

  if (ts.isIdentifier(node)) {
    const target = rc.resolveSchemaBinding(node.text, rc.sourceFile);
    if (!target) return null;
    return convertZodNode(target, {
      ...rc,
      depth: depth + 1,
      sourceFile: target.getSourceFile?.() ?? rc.sourceFile,
    });
  }

  // Member access on an object schema: UserBase.shape.email, Schema.inner.
  // `.shape` is Zod's TypeScript-level accessor for the object's property
  // schemas, so `X.shape.foo` resolves to property `foo` of object schema X.
  if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node)) {
    const parent = convertZodNode(node.expression, { ...rc, depth: depth + 1 }) as
      | JsonSchema
      | null;
    if (node.name.text === "shape") return parent;
    const prop = (parent as any)?.properties?.[node.name.text];
    if (prop) return JSON.parse(JSON.stringify(prop));
    return null;
  }

  const chain = callChain(ts, node);
  if (!chain) return null;

  let schema: JsonSchema = {};
  let nullable = false;

  // Seed from a non-call base: an identifier (schema binding) or a member
  // access such as `CreateUser.shape.user`.
  if (chain.base && chain.base.kind !== ts.SyntaxKind.Identifier) {
    if (ts.isPropertyAccessExpression(chain.base)) {
      const seeded = convertZodNode(chain.base, { ...rc, depth: depth + 1 });
      if (seeded) schema = JSON.parse(JSON.stringify(seeded));
    }
  } else if (chain.base && ts.isIdentifier(chain.base)) {
    const target = rc.resolveSchemaBinding(chain.base.text, rc.sourceFile);
    if (target) {
      const seeded = convertZodNode(target, { ...rc, depth: depth + 1 });
      if (seeded) schema = JSON.parse(JSON.stringify(seeded));
    }
  }

  for (let i = 0; i < chain.steps.length; i += 1) {
    const step = chain.steps[i]!;
    const arg0 = step.args[0];

    switch (step.name) {
      case "object": {
        const properties: Record<string, JsonSchema> = {};
        const required = new Set<string>();
        let incomplete = false;
        const readShape = (value: any, from: any, seen = new Set<any>(), level = 0): void => {
          if (!value || level > 16 || seen.has(value)) { incomplete = true; return; }
          const next = new Set(seen).add(value);
          if (ts.isIdentifier(value)) {
            const target = rc.resolveSchemaBinding(value.text, from);
            readShape(target, target?.getSourceFile?.() ?? from, next, level + 1);
            return;
          }
          if (!ts.isObjectLiteralExpression(value)) { incomplete = true; return; }
          for (const member of value.properties) {
            if (ts.isSpreadAssignment(member)) {
              readShape(member.expression, from, next, level + 1);
              continue;
            }
            if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) { incomplete = true; continue; }
            const name = propertyNameText(ts, member.name);
            if (name === null) { incomplete = true; continue; }
            const child = convertZodNode(ts.isShorthandPropertyAssignment(member) ? member.name : member.initializer,
              { ...rc, sourceFile: from, depth: depth + 1 });
            const clean = child ? { ...child } : {};
            const optional = clean['x-optional'] === true;
            delete clean['x-optional'];
            properties[name] = clean;
            // Later fields overwrite earlier spreads, including optionality.
            if (optional) required.delete(name); else required.add(name);
          }
        };
        readShape(arg0, rc.sourceFile);
        schema = { type: 'object',
          ...(Object.keys(properties).length ? { properties } : {}),
          ...(required.size ? { required: [...required] } : {}),
        };
        if (incomplete) schema = partialSchema(schema, 'unresolved-zod-object-shape', true);
        break;
      }
      case "array": {
        const items = arg0 ? convertZodNode(arg0, { ...rc, depth: depth + 1 }) : {};
        schema = { type: "array", items: items ?? {} };
        break;
      }
      case "string":
        schema = { ...schema, type: "string" };
        break;
      case "number":
      case "bigint":
        schema = { ...schema, type: "number" };
        break;
      case "boolean":
        schema = { ...schema, type: "boolean" };
        break;
      case "date":
        schema = { ...schema, type: "string", format: "date-time" };
        break;
      case "null":
        schema = { ...schema, type: "null" };
        break;
      case "any":
      case "unknown":
      case "never":
        break;
      case "enum": {
        if (arg0 && ts.isArrayLiteralExpression(arg0)) {
          const values = arg0.elements
            .map((el: any) => literalValue(ts, el))
            .filter((v: unknown) => v !== undefined);
          const type = typeof values[0] === "number" ? "number" : "string";
          schema = { ...schema, type, ...(values.length ? { enum: values } : {}) };
        }
        break;
      }
      case "literal": {
        const value = literalValue(ts, arg0);
        if (value !== undefined) schema = literalSchema(value);
        break;
      }
      case "union":
      case "discriminatedUnion": {
        const arr = step.name === "union" ? arg0 : step.args[1];
        if (arr && ts.isArrayLiteralExpression(arr)) {
          const variants = arr.elements
            .map((el: any) => convertZodNode(el, { ...rc, depth: depth + 1 }) ?? {});
          schema = { anyOf: variants };
        }
        break;
      }
      case "record": {
        const value = step.args[1]
          ? convertZodNode(step.args[1], { ...rc, depth: depth + 1 })
          : {};
        schema = { type: "object", additionalProperties: value ?? {} };
        break;
      }
      case "email":
        schema = { ...schema, format: "email" };
        break;
      case "url":
        schema = { ...schema, format: "uri" };
        break;
      case "regex": {
        if (arg0 && ts.isRegularExpressionLiteral(arg0)) {
          const body = arg0.text.replace(/^\/|\/[a-z]*$/g, "");
          if (body) schema = { ...schema, pattern: body };
        }
        break;
      }
      case "merge": {
        const other = (arg0 ? convertZodNode(arg0, { ...rc, depth: depth + 1 }) : null) as
          | JsonSchema
          | null;
        if (other && schema.type === "object") {
          const properties = {
            ...((schema as any).properties ?? {}),
            ...((other as any).properties ?? {}),
          };
          const required = [
            ...(((schema as any).required as string[] | undefined) ?? []).filter(name => !(name in ((other as any).properties ?? {}))),
            ...(((other as any).required as string[] | undefined) ?? []),
          ];
          delete schema.required;
          schema = {
            ...schema,
            ...(Object.keys(properties).length ? { properties } : {}),
            ...(required.length ? { required } : {}),
          };
        }
        break;
      }
      case "partial":
        if (schema.type === "object") delete schema.required;
        break;
      case "pick":
      case "omit": {
        if (schema.type === "object" && arg0 && ts.isObjectLiteralExpression(arg0) && schema.properties) {
          const selected = new Set<string>();
          for (const member of arg0.properties) {
            if (!ts.isPropertyAssignment(member)) continue;
            const key = propertyNameText(ts, member.name);
            if (key) selected.add(key);
          }
          const properties: Record<string, JsonSchema> = {};
          for (const [key, value] of Object.entries(schema.properties)) {
            const present = selected.has(key);
            if ((step.name === "pick" && present) || (step.name === "omit" && !present)) {
              properties[key] = value;
            }
          }
          const required = ((schema.required as string[] | undefined) ?? []).filter(
            (key) => key in properties,
          );
          delete schema.required;
          schema = {
            ...schema,
            properties,
            ...(required.length ? { required } : {}),
          };
        }
        break;
      }
      case "uuid":
      case "ulid":
        schema = { ...schema, format: "uuid" };
        break;
      case "datetime":
      case "isodatetime":
        schema = { ...schema, format: "date-time" };
        break;
      case "int":
      case "integer":
        schema = { ...schema, type: "integer" };
        break;
      case "min":
      case "max":
      case "length": {
        const num = literalValue(ts, arg0);
        if (typeof num === "number") {
          if (step.name === "length") {
            if (schema.type === "string") { schema.minLength = num; schema.maxLength = num; }
            else if (schema.type === "array") { schema.minItems = num; schema.maxItems = num; }
          } else if (schema.type === "string")
            schema[step.name === "min" ? "minLength" : "maxLength"] = num;
          else if (schema.type === "array")
            schema[step.name === "min" ? "minItems" : "maxItems"] = num;
          else schema[step.name === "min" ? "minimum" : "maximum"] = num;
        }
        break;
      }
      case "default": {
        if (rc.mode !== "output") schema["x-optional"] = true;
        else delete schema["x-optional"];
        const value = literalValue(ts, arg0);
        if (value !== undefined) schema = { ...schema, default: value };
        break;
      }
      case "optional":
        schema["x-optional"] = true;
        break;
      case "nullable":
      case "nullish":
        nullable = true;
        if (step.name === "nullish") schema["x-optional"] = true;
        break;
      case "coerce":
      case "preprocess":
      case "transform":
      case "refine":
      case "brand":
      case "catch":
      case "describe":
      case "openapi":
      case "passthrough":
      case "strict":
      case "strip":
      case "readonly":
        // No structural impact.
        break;
      default:
        // Unknown refinement: keep what we have rather than failing.
        break;
    }
  }

  if (nullable && schema.type && schema.type !== "null") {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type, "null"];
    if (!types.includes("null")) types.push("null");
    schema = { ...schema, type: types };
  }

  return Object.keys(schema).length ? schema : null;
}

function literalSchema(value: unknown): JsonSchema {
  if (typeof value === "string") return { type: "string", const: value };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  if (value === null) return { type: "null" };
  return {};
}
