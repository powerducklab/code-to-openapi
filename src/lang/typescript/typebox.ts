import type { JsonSchema } from "../../core/types.js";

/**
 * Syntactic conversion for TypeBox schemas (`@sinclair/typebox`, re-exported
 * as `t` by Elysia). Covers the HTTP-contract subset: Object, String (with
 * format/min/max), Number/Integer, Boolean, Array, Union, Intersect,
 * Optional, Nullable, Null, Undefined, Literal, Record, Any and
 * Partial/Pick/Omit. Unrecognised nodes return null for honest gap reporting.
 */

export interface TypeBoxResolveContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceFile: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveBinding: (name: string, from?: any) => { node: any; file: any } | null;
  depth?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outerName(ts: any, node: any): string | null {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    return node.expression.name.text;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optionsObject(ts: any, node: any): Record<string, unknown> {
  const arg = node.arguments?.[0];
  if (arg && ts.isObjectLiteralExpression(arg)) {
    const out: Record<string, unknown> = {};
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteralLike(prop.name)
          ? prop.name.text
          : null;
      if (!key) continue;
      const v = prop.initializer;
      if (ts.isStringLiteralLike(v)) out[key] = v.text;
      else if (ts.isNumericLiteral(v)) out[key] = Number(v.text);
      else if (v.kind === ts.SyntaxKind.TrueKeyword) out[key] = true;
      else if (v.kind === ts.SyntaxKind.FalseKeyword) out[key] = false;
    }
    return out;
  }
  return {};
}

function convertObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any,
  rc: TypeBoxResolveContext,
): JsonSchema {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return { type: "object" };
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of obj.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = ts.isIdentifier(member.name)
      ? member.name.text
      : ts.isStringLiteralLike(member.name)
        ? member.name.text
        : null;
    if (!name) continue;
    const child = convertTypeBoxNode(member.initializer, {
      ...rc,
      depth: (rc.depth ?? 0) + 1,
    });
    if (!child) continue;
    const isOptional = child["x-optional"] === true;
    delete child["x-optional"];
    properties[name] = child;
    if (!isOptional) required.push(name);
  }
  return {
    type: "object",
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertTypeBoxNode(node: any, rc: TypeBoxResolveContext): JsonSchema | null {
  const depth = rc.depth ?? 0;
  if (depth > 16 || !node) return null;
  const { ts } = rc;

  if (ts.isIdentifier(node)) {
    const target = rc.resolveBinding(node.text, rc.sourceFile);
    if (!target) return null;
    return convertTypeBoxNode(target.node, {
      ...rc,
      depth: depth + 1,
      sourceFile: target.file,
    });
  }

  if (ts.isObjectLiteralExpression(node)) {
    return convertObject(ts, node, rc);
  }

  if (!ts.isCallExpression(node)) return null;
  const name = outerName(ts, node);
  if (!name) return null;
  const args = node.arguments;

  switch (name) {
    case "Object":
      return convertObject(ts, args[0], rc);
    case "String": {
      const opts = optionsObject(ts, node);
      return {
        type: "string",
        ...(typeof opts.format === "string" ? { format: opts.format } : {}),
        ...(typeof opts.pattern === "string" ? { pattern: opts.pattern } : {}),
        ...(typeof opts.minLength === "number" ? { minLength: opts.minLength } : {}),
        ...(typeof opts.maxLength === "number" ? { maxLength: opts.maxLength } : {}),
      };
    }
    case "Number": {
      const opts = optionsObject(ts, node);
      return {
        type: "number",
        ...(typeof opts.minimum === "number" ? { minimum: opts.minimum } : {}),
        ...(typeof opts.maximum === "number" ? { maximum: opts.maximum } : {}),
      };
    }
    case "Integer": {
      const opts = optionsObject(ts, node);
      return {
        type: "integer",
        ...(typeof opts.minimum === "number" ? { minimum: opts.minimum } : {}),
        ...(typeof opts.maximum === "number" ? { maximum: opts.maximum } : {}),
      };
    }
    case "Boolean":
      return { type: "boolean" };
    case "Null":
      return { type: "null" };
    case "Undefined":
      return { not: {} };
    case "Any":
    case "Unknown":
      return {};
    case "Array": {
      const items = convertTypeBoxNode(args[0], { ...rc, depth: depth + 1 });
      return { type: "array", items: items ?? {} };
    }
    case "Union": {
      if (args[0] && ts.isArrayLiteralExpression(args[0])) {
        const variants = args[0].elements
          .map((el: any) => convertTypeBoxNode(el, { ...rc, depth: depth + 1 }))
          .filter(Boolean);
        return { anyOf: variants };
      }
      return null;
    }
    case "Intersect": {
      if (args[0] && ts.isArrayLiteralExpression(args[0])) {
        const parts = args[0].elements
          .map((el: any) => convertTypeBoxNode(el, { ...rc, depth: depth + 1 }))
          .filter(Boolean) as JsonSchema[];
        const properties = Object.assign(
          {},
          ...parts.map((p) => (p as any).properties ?? {}),
        );
        const required = [
          ...new Set(
            parts.flatMap((p) => ((p as any).required as string[]) ?? []),
          ),
        ];
        return {
          type: "object",
          ...(Object.keys(properties).length ? { properties } : {}),
          ...(required.length ? { required } : {}),
        };
      }
      return null;
    }
    case "Literal": {
      const arg = args[0];
      if (ts.isStringLiteralLike(arg)) return { type: "string", const: arg.text };
      if (ts.isNumericLiteral(arg))
        return {
          type: Number.isInteger(Number(arg.text)) ? "integer" : "number",
          const: Number(arg.text),
        };
      if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword)
        return { type: "boolean", const: arg.kind === ts.SyntaxKind.TrueKeyword };
      return null;
    }
    case "Record": {
      const value = convertTypeBoxNode(args[1], { ...rc, depth: depth + 1 });
      return { type: "object", additionalProperties: value ?? {} };
    }
    case "Optional": {
      const inner = convertTypeBoxNode(args[0], { ...rc, depth: depth + 1 });
      if (inner) inner["x-optional"] = true;
      return inner;
    }
    case "Nullable": {
      const inner = convertTypeBoxNode(args[0], { ...rc, depth: depth + 1 });
      if (inner && inner.type) {
        inner.type = Array.isArray(inner.type)
          ? [...inner.type, "null"]
          : [inner.type, "null"];
      }
      return inner;
    }
    case "Partial": {
      const inner = convertTypeBoxNode(args[0], { ...rc, depth: depth + 1 });
      if (inner && inner.type === "object") delete inner.required;
      return inner;
    }
    case "Pick":
    case "Omit": {
      const inner = convertTypeBoxNode(args[0], { ...rc, depth: depth + 1 });
      if (
        inner &&
        inner.type === "object" &&
        args[1] &&
        ts.isArrayLiteralExpression(args[1])
      ) {
        const keys = args[1].elements
          .filter((el: any) => ts.isStringLiteralLike(el))
          .map((el: any) => el.text);
        const props = (inner as any).properties ?? {};
        const next: Record<string, JsonSchema> = {};
        for (const key of Object.keys(props)) {
          const listed = keys.includes(key);
          if ((name === "Pick" && listed) || (name === "Omit" && !listed)) {
            next[key] = props[key];
          }
        }
        return { type: "object", ...(Object.keys(next).length ? { properties: next } : {}) };
      }
      return inner;
    }
    default:
      return null;
  }
}
