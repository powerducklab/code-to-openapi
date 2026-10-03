import type { JsonSchema } from "../../core/types.js";

/**
 * Syntactic ArkType schema conversion. ArkType models are built with the
 * `type(...)` function and accept plain object literals plus string shorthand
 * domains such as "string.email", "string | null" or "8 <= string <= 100".
 * Only the HTTP-contract subset is converted; anything unrecognised returns
 * null so the caller records an honest gap.
 */

export interface ArkResolveContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceFile: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveBinding: (name: string, from?: any) => { node: any; file: any } | null;
  depth?: number;
}

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
    steps.unshift({ name: cur.expression.name.text, args: [...cur.arguments] });
    cur = cur.expression.expression;
  }
  if (!cur) return null;
  return { base: cur, steps };
}

const DOMAIN_FORMATS: Record<string, string> = {
  email: "email",
  url: "uri",
  uri: "uri",
  uuid: "uuid",
  ulid: "uuid",
  datetime: "date-time",
  date: "date",
  time: "time",
  semver: "semver",
  jwt: "jwt",
};

/** Parses an ArkType string definition into a JSON Schema node. */
export function parseArkString(def: string): JsonSchema | null {
  const text = def.trim();
  if (!text) return null;

  // Unions: "string | null", "string | undefined", "A | B".
  const variants = text.split("|").map((s) => s.trim()).filter(Boolean);
  if (variants.length > 1) {
    const nodes = variants
      .map((v) => parseArkString(v))
      .filter((n): n is JsonSchema => n !== null);
    if (nodes.length !== variants.length) return null;
    const meaningful = nodes.filter(
      (n) => n.type !== "null" && !(n.type === "string" && !("const" in n)),
    );
    const nullable = nodes.some((n) => n.type === "null");
    const optional = variants.includes("undefined");
    if (meaningful.length === 1) {
      const node: JsonSchema = { ...meaningful[0]! };
      if (nullable) node.type = [String(node.type), "null"];
      if (optional) node["x-optional"] = true;
      return node;
    }
    return { anyOf: nodes };
  }

  let rest = text;
  let minLen: number | undefined;
  let maxLen: number | undefined;
  let isArray = false;

  // Generic containers: "Record<string, string[]>", "Array<string>".
  const record = rest.match(/^Record<\s*([^,]+)\s*,\s*(.+)>$/);
  if (record) {
    const value = parseArkString(record[2]!.trim());
    return value ? { type: "object", additionalProperties: value } : null;
  }
  const arrayOf = rest.match(/^Array<\s*(.+)>$/);
  if (arrayOf) {
    const items = parseArkString(arrayOf[1]!.trim());
    return items ? { type: "array", items } : null;
  }

  // Bounds: "8 <= string <= 100", "string <= 1000", "3 <= string",
  // "string > 0", "string < 100".
  const lower = rest.match(/^(-?\d+(?:\.\d+)?)\s*<=\s*/);
  if (lower) {
    minLen = Number(lower[1]);
    rest = rest.slice(lower[0].length).trim();
  }
  const upperArr = rest.match(/^([\w.]+(?:\[\])?)\s*<=\s*(-?\d+(?:\.\d+)?)$/);
  let upper: number | undefined;
  if (upperArr) {
    rest = upperArr[1]!;
    upper = Number(upperArr[2]);
  }
  const upperGe = rest.match(/^([\w.]+(?:\[\])?)\s*>=\s*(-?\d+(?:\.\d+)?)$/);
  if (upperGe) {
    rest = upperGe[1]!;
    minLen = minLen ?? Number(upperGe[2]);
  }
  const strictGt = rest.match(/^([\w.]+(?:\[\])?)\s*>\s*(-?\d+(?:\.\d+)?)$/);
  if (strictGt) {
    rest = strictGt[1]!;
    // Strictly greater than N means the inclusive bound starts at N + 1.
    minLen = minLen ?? Number(strictGt[2]) + 1;
  }
  const strictLt = rest.match(/^([\w.]+(?:\[\])?)\s*<\s*(-?\d+(?:\.\d+)?)$/);
  if (strictLt) {
    rest = strictLt[1]!;
    upper = upper ?? Number(strictLt[2]) - 1;
  }
  if (rest.endsWith("[]")) {
    isArray = true;
    rest = rest.slice(0, -2).trim();
  }
  if (upper !== undefined) maxLen = upper;

  // Literal: "'enabled'" / "true" / "42".
  const quoted = rest.match(/^["'](.+)["']$/);
  if (quoted) return { type: "string", const: quoted[1] };
  if (rest === "true" || rest === "false") return { type: "boolean", const: rest === "true" };
  if (/^-?\d+$/.test(rest)) return { type: "integer", const: Number(rest) };

  const [domain, narrow] = rest.split(".");
  let schema: JsonSchema;
  switch (domain) {
    case "string":
      schema = { type: "string" };
      if (narrow) {
        if (narrow === "integer" || narrow === "digits") {
          schema = { type: "string", pattern: "^-?\\d+$" };
        } else if (DOMAIN_FORMATS[narrow]) {
          schema = { type: "string", format: DOMAIN_FORMATS[narrow] };
        } else {
          return null;
        }
      }
      if (minLen !== undefined) schema.minLength = minLen;
      if (maxLen !== undefined) schema.maxLength = maxLen;
      break;
    case "number":
      schema = { type: "number" };
      if (narrow === "integer") schema.type = "integer";
      else if (narrow) return null;
      if (minLen !== undefined) schema.minimum = minLen;
      if (maxLen !== undefined) schema.maximum = maxLen;
      break;
    case "integer":
      schema = { type: "integer" };
      if (minLen !== undefined) schema.minimum = minLen;
      if (maxLen !== undefined) schema.maximum = maxLen;
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "null":
      schema = { type: "null" };
      break;
    case "object":
      schema = { type: "object" };
      break;
    case "unknown":
    case "any":
      schema = {};
      break;
    default:
      return null;
  }

  if (isArray) {
    schema = {
      type: "array",
      items: schema,
      ...(minLen !== undefined ? { minItems: minLen } : {}),
      ...(maxLen !== undefined ? { maxItems: maxLen } : {}),
    };
  }
  return Object.keys(schema).length ? schema : {};
}

function convertObjectLiteral(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ts: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any,
  rc: ArkResolveContext,
): JsonSchema | null {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of obj.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    let name: string | null = null;
    let optional = false;
    if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) {
      name = member.name.text;
    }
    if (!name) continue;
    if (name.endsWith("?")) {
      optional = true;
      name = name.slice(0, -1);
    }
    const child = convertArkNode(member.initializer, rc);
    if (!child) continue;
    if (child["x-optional"] === true) optional = true;
    delete child["x-optional"];
    properties[name] = child;
    if (!optional) required.push(name);
  }
  return {
    type: "object",
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertArkNode(node: any, rc: ArkResolveContext): JsonSchema | null {
  const depth = rc.depth ?? 0;
  if (depth > 16 || !node) return null;
  const { ts } = rc;

  if (ts.isStringLiteralLike(node)) return parseArkString(node.text);

  if (ts.isObjectLiteralExpression(node)) {
    return convertObjectLiteral(ts, node, { ...rc, depth: depth + 1 });
  }

  if (ts.isIdentifier(node)) {
    const target = rc.resolveBinding(node.text, rc.sourceFile);
    if (!target) return null;
    return convertArkNode(target.node, {
      ...rc,
      depth: depth + 1,
      sourceFile: target.file,
    });
  }

  // type({...}) / type("string") — the ArkType factory, possibly aliased.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "type"
  ) {
    const arg = node.arguments[0];
    if (!arg) return { type: "object" };
    return convertArkNode(arg, { ...rc, depth: depth + 1 });
  }

  // regex("^...$") from arkregex -> string with pattern.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "regex" &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return { type: "string", pattern: node.arguments[0].text };
  }

  // Member access: Dto.get("user") / Dto.shape.user.
  if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node)) {
    if (node.name.text === "shape") {
      return convertArkNode(node.expression, { ...rc, depth: depth + 1 });
    }
    const parent = convertArkNode(node.expression, { ...rc, depth: depth + 1 });
    const prop = (parent as any)?.properties?.[node.name.text];
    return prop ? JSON.parse(JSON.stringify(prop)) : null;
  }

  const chain = callChain(ts, node);
  if (!chain) return null;

  // Seed from an identifier base (e.g. CreateUserDto.get("user")).
  let schema: JsonSchema = {};
  if (ts.isIdentifier(chain.base)) {
    const target = rc.resolveBinding(chain.base.text, rc.sourceFile);
    if (target) {
      const seeded = convertArkNode(target.node, {
        ...rc,
        depth: depth + 1,
        sourceFile: target.file,
      });
      if (seeded) schema = JSON.parse(JSON.stringify(seeded));
    }
  } else {
    const seeded = convertArkNode(chain.base, { ...rc, depth: depth + 1 });
    if (seeded) schema = seeded;
  }

  for (const step of chain.steps) {
    if (step.name === "partial" && schema.type === "object") {
      delete schema.required;
    } else if (step.name === "array") {
      // Dto.get("comment").array() / SomeType.array() -> array of the schema.
      schema = { type: "array", items: schema };
    } else if (step.name === "get" && ts.isStringLiteralLike(step.args[0])) {      const key = step.args[0].text;
      const prop = (schema as any).properties?.[key];
      schema = prop ? JSON.parse(JSON.stringify(prop)) : {};
    } else if (step.name === "optional") {
      schema["x-optional"] = true;
    } else if (step.name === "describe" || step.name === "annotate") {
      // Metadata only.
    } else if (step.name === "and") {
      const arg = step.args[0];
      const other = ts.isStringLiteralLike(arg)
        ? parseArkString(arg.text)
        : convertArkNode(arg, { ...rc, depth: depth + 1 });
      if (!other) continue;
      if (schema.type === "object" && other.type === "object") {
        const properties = { ...((schema as any).properties ?? {}), ...(other.properties ?? {}) };
        const required = [
          ...new Set<string>([
            ...(((schema as any).required as string[]) ?? []),
            ...(((other as any).required as string[]) ?? []),
          ]),
        ];
        schema = {
          ...schema,
          ...(Object.keys(properties).length ? { properties } : {}),
          ...(required.length ? { required } : {}),
        };
      } else {
        // Primitive intersection: string domain plus bounds/format win.
        schema = { ...schema, ...other };
      }
    }
  }

  return Object.keys(schema).length ? schema : null;
}
