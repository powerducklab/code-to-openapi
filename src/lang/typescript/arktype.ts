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
  mode?: "input" | "output";
  onUnresolved?: (message: string) => void;
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
  ulid: "ulid",
  datetime: "date-time",
  date: "date",
  time: "time",
  semver: "semver",
  jwt: "jwt",
};

// Split only grammar-level unions; a pipe in a string literal or |> morph is not a union.
function unionParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0, nesting = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(" || c === "[") nesting++;
    if (c === ")" || c === "]") nesting--;
    if (c === "|" && text[i + 1] !== ">" && nesting === 0) {
      parts.push(text.slice(start, i).trim()); start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Parses the statically representable ArkType HTTP contract subset. */
export function parseArkString(def: string, mode: "input" | "output" = "input"): JsonSchema | null {
  const text = def.trim();
  if (!text) return null;
  if (text.endsWith("?")) {
    const inner = parseArkString(text.slice(0, -1), mode);
    return inner ? { ...inner, "x-optional": true } : null;
  }
  const variants = unionParts(text);
  if (variants.length > 1) {
    const optional = variants.includes("undefined");
    const nodes = variants.filter(v => v !== "undefined").map(v => parseArkString(v, mode));
    if (nodes.some(n => n === null) || !nodes.length) return null;
    return { ...(nodes.length === 1 ? nodes[0]! : { anyOf: nodes as JsonSchema[] }),
      ...(optional ? { "x-optional": true } : {}) };
  }

  // The request contains the pre-morph value, never the handler's parsed number.
  const morph = text.match(/^string\.numeric\.parse(?:\s*\|>\s*(.+))?$/);
  if (morph) return mode === "input"
    ? parseArkString("string.numeric")
    : parseArkString(morph[1] ?? "number", "output");
  const record = text.match(/^Record<\s*string\s*,\s*(.+)>$/);
  if (record) return { type: "object", additionalProperties: parseArkString(record[1]!, mode) ?? {} };
  const genericArray = text.match(/^Array<\s*(.+)>$/);
  if (genericArray) return { type: "array", items: parseArkString(genericArray[1]!, mode) ?? {} };
  const literal = text.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/);
  if (literal) {
    try { return { type: "string", const: text[0] === '"' ? JSON.parse(text) : text.slice(1, -1).replace(/\\'/g, "'") }; }
    catch { return null; }
  }
  if (text === "true" || text === "false") return { type: "boolean", const: text === "true" };
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { type: Number.isInteger(Number(text)) ? "integer" : "number", const: Number(text) };

  const bounded = text.match(/^(?:(-?\d+(?:\.\d+)?)\s*(<=|<)\s*)?([\w.]+(?:\[\])*)(?:\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?))?$/);
  if (!bounded) return null;
  const [, low, lowOp, domain, rightOp, right] = bounded;
  let schema: JsonSchema;
  if (domain!.endsWith("[]")) {
    schema = { type: "array", items: parseArkString(domain!.slice(0, -2), mode) ?? {} };
  } else if (domain === "string.numeric") {
    // ArkType's well-formed numeric string grammar (not arbitrary JS Number coercion).
    schema = { type: "string", pattern: "^(?:(?!^-0\\.?0*$)(?:-?(?:(?:0|[1-9]\\d*)(?:\\.\\d+)?)|\\.\\d+?))$" };
  } else if (domain === "string.email") {
    schema = { type: "string", format: "email", pattern: "^[\\w%+.-]+@[\\d.A-Za-z-]+\\.[A-Za-z]{2,}$" };
  } else if (domain === "string.integer" || domain === "string.digits") {
    schema = { type: "string", pattern: domain === "string.digits" ? "^\\d*$" : "^-?\\d+$" };
  } else if (domain!.startsWith("string.") && DOMAIN_FORMATS[domain!.slice(7)]) {
    schema = { type: "string", format: DOMAIN_FORMATS[domain!.slice(7)] };
  } else if (domain === "number.integer" || domain === "integer") schema = { type: "integer" };
  else if (["string", "number", "boolean", "null", "object"].includes(domain!)) schema = { type: domain! };
  else if (domain === "unknown" || domain === "any") schema = {};
  else return null;

  const length = schema.type === "string" || schema.type === "array";
  const setBound = (value: number, minimum: boolean, exclusive: boolean) => {
    if (length) {
      const key = schema.type === "array" ? (minimum ? "minItems" : "maxItems") : (minimum ? "minLength" : "maxLength");
      schema[key] = minimum ? (exclusive ? Math.floor(value) + 1 : Math.ceil(value)) : (exclusive ? Math.ceil(value) - 1 : Math.floor(value));
    } else if (schema.type === "number" || schema.type === "integer") {
      schema[exclusive ? (minimum ? "exclusiveMinimum" : "exclusiveMaximum") : (minimum ? "minimum" : "maximum")] = value;
    }
  };
  if (low !== undefined) setBound(Number(low), true, lowOp === "<");
  if (right !== undefined) setBound(Number(right), rightOp!.startsWith(">"), rightOp!.length === 1);
  return schema;
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
    const child = convertArkNode(member.initializer, rc) ?? {};
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

  if (ts.isStringLiteralLike(node)) {
    if (node.text.includes("|>") && rc.mode !== "output") rc.onUnresolved?.("Post-morph ArkType constraints cannot be fully represented in the wire schema");
    return parseArkString(node.text, rc.mode);
  }

  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      let value = span.expression;
      let file = rc.sourceFile;
      const seen = new Set<any>();
      while (ts.isIdentifier(value) && !seen.has(value)) {
        seen.add(value);
        const binding = rc.resolveBinding(value.text, file);
        if (!binding) return null;
        value = binding.node; file = binding.file;
      }
      if (ts.isNumericLiteral(value) || ts.isStringLiteralLike(value)) text += value.text;
      else if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) text += "-" + value.operand.text;
      else return null;
      text += span.literal.text;
    }
    if (text.includes("|>") && rc.mode !== "output") rc.onUnresolved?.("Post-morph ArkType constraints cannot be fully represented in the wire schema");
    return parseArkString(text, rc.mode);
  }

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
  if (!chain || !chain.steps.length) return null;

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
    } else if ((step.name === "omit" || step.name === "pick") && schema.type === "object") {
      // ArkType accepts variadic literal keys. Dynamic keys and key schemas
      // need runtime evaluation; never silently leave the original object.
      if (!step.args.every((arg: any) => ts.isStringLiteralLike(arg))) {
        rc.onUnresolved?.(`Dynamic ArkType ${step.name} keys`);
        return null;
      }
      const keys = new Set<string>(step.args.map((arg: any) => arg.text));
      const properties = schema.properties as Record<string, JsonSchema> | undefined;
      if ([...keys].some(key => !properties || !(key in properties))) {
        rc.onUnresolved?.(`Unknown ArkType ${step.name} property`);
        return null;
      }
      const keep = (key: string) => step.name === "pick" ? keys.has(key) : !keys.has(key);
      schema.properties = Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => keep(key)));
      const required = ((schema.required ?? []) as string[]).filter(keep);
      if (required.length) schema.required = required; else delete schema.required;
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
    } else if (step.name === "merge" && schema.type === "object") {
      const other = convertArkNode(step.args[0], { ...rc, depth: depth + 1 });
      if (!other || other.type !== "object") return null;
      const replaced = new Set(Object.keys(other.properties ?? {}));
      const required = [...new Set([...((schema.required ?? []) as string[]).filter((key: string) => !replaced.has(key)), ...((other.required ?? []) as string[])])];
      schema = { ...schema, properties: { ...(schema.properties as Record<string, JsonSchema>), ...(other.properties as Record<string, JsonSchema>) } };
      if (required.length) schema.required = required; else delete schema.required;
    } else if (step.name === "and") {
      const arg = step.args[0];
      const other = ts.isStringLiteralLike(arg)
        ? parseArkString(arg.text, rc.mode)
        : convertArkNode(arg, { ...rc, depth: depth + 1 });
      if (!other) return null;
      schema = { allOf: [schema, other] };
    } else {
      rc.onUnresolved?.(`Unsupported ArkType operation: ${step.name}`);
      return null;
    }
  }

  return Object.keys(schema).length ? schema : null;
}
