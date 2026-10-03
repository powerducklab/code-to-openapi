import { jsonSchema } from "@powerduck/x-to-openapi";

import type {
  Confidence,
  DiscoveredMediaType,
  DiscoveredResponse,
  JsonSchema,
  RouteParameter,
  SourceLocation,
} from "../../core/types.js";
import type { TsAnalysis } from "./index.js";
import { typeToSchema } from "./typeSchema.js";

/**
 * Framework-agnostic helpers shared by the TypeScript/JavaScript framework
 * packs (Hono, Koa, Next.js, Elysia). Each pack owns its route-registration
 * detection and context-object idioms; this module only provides the boring,
 * reusable pieces: path normalization, operation ids, tags, source locations
 * and TypeScript-type -> JSON-Schema inference.
 */

/** Joins path segments into a single leading-slash path, collapsing slashes. */
export function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .map((p) => (p ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
}

/**
 * Normalizes a `:param` style route (Hono / Koa / Elysia / Express-style
 * routers) into an OpenAPI `{param}` template. `*` catch-alls become
 * `{wildcard}`. Returns the path plus the set of path parameter names.
 */
export function normalizeColonPath(raw: string): {
  path: string;
  params: string[];
} {
  const params: string[] = [];
  const converted = raw
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
      params.push(name);
      return `{${name}}`;
    })
    .replace(/\*\s*([A-Za-z0-9_]*)/g, (_m, name: string) => {
      const n = name || "wildcard";
      if (!params.includes(n)) params.push(n);
      return `{${n}}`;
    });
  return { path: converted, params };
}

/**
 * Converts a Next.js dynamic-segment file path into an OpenAPI template.
 * `[id]` -> `{id}`, `[...slug]` -> `{slug}`, `[[...opt]]` -> `{opt}`.
 */
export function normalizeNextSegment(segment: string): string {
  return segment
    .replace(/^\[\[\.\.\.([^\]]+)\]\]$/, "{$1}")
    .replace(/^\[\.\.\.([^\]]+)\]$/, "{$1}")
    .replace(/^\[([^\]]+)\]$/, "{$1}");
}

/** Stable camelCase operation id from a method and full path. */
export function makeOperationId(method: string, fullPath: string): string {
  const segments = fullPath
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, ""))
    .map((s) => s.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()));
  const head = method.toLowerCase();
  const tail = segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${head}${tail}` || `${head}Root`;
}

/** Tag derived from the first static path segment, else the file name. */
export function tagForPath(fullPath: string, file: string): string[] {
  const segment = fullPath.split("/").filter(Boolean)[0];
  if (segment && !segment.startsWith("{")) return [segment];
  const base = file.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? "default";
  return [base === "index" ? "default" : base];
}

/** Builds a SourceLocation at a node's start position. */
export function locationAt(ts: any, source: any, node: any, file: string): SourceLocation {
  try {
    const line = ts.getLineAndCharacterOfPosition(
      source,
      node.getStart(source),
    ).line;
    return { file, line: line + 1 };
  } catch {
    return { file };
  }
}

/** Resolves a string/number/boolean/null literal node to a JS value. */
export function literalValue(ts: any, node: any, depth = 0): unknown {
  if (depth > 12 || !node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand)
  ) {
    return Number(
      `${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`,
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el: any) => literalValue(ts, el, depth + 1));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name
          ?.getText?.()
          ?.replace(/['"]/g, "");
        if (name) out[name] = literalValue(ts, prop.initializer, depth + 1);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        out[prop.name.text] = literalValue(ts, prop.name, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

/**
 * Best-effort schema inference for an arbitrary value expression. The
 * TypeScript type wins (named declarations are hoisted to components and
 * referenced by `$ref`); a literal fallback covers plain JavaScript. Truly
 * dynamic values (calls, awaited repos) yield an empty/absent schema honestly.
 */
export function schemaFromNode(
  analysis: TsAnalysis,
  node: any,
): { schema?: JsonSchema; typed: boolean } {
  const { ts, checker } = analysis;
  try {
    const type = checker.getTypeAtLocation(node);
    if (
      type &&
      !(type.flags & ts.TypeFlags.Any) &&
      !(type.flags & ts.TypeFlags.Unknown)
    ) {
      const schema = typeToSchema(type, analysis.schemaContext);
      if (schema && Object.keys(schema).length) return { schema, typed: true };
    }
  } catch {
    // Fall through to literal inference.
  }
  const value = literalValue(ts, node);
  if (value !== undefined) return { schema: jsonSchema(value), typed: false };
  return { typed: false };
}

/** Response accumulation helper keyed by `${status}:${mediaType}`. */
export class ResponseCollector {
  private map = new Map<string, DiscoveredResponse>();

  record(
    status: string,
    mediaType: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    opts: { description?: string; itemSchema?: JsonSchema } = {},
  ): void {
    const key = `${status}:${mediaType}`;
    const media: DiscoveredMediaType = { mediaType };
    if (schema && Object.keys(schema).length) media.schema = schema;
    if (opts.itemSchema && Object.keys(opts.itemSchema).length) {
      media.itemSchema = opts.itemSchema;
    }
    const existing = this.map.get(key);
    if (existing) {
      const existingMedia = existing.content?.find((m) => m.mediaType === mediaType);
      if (existingMedia && !existingMedia.schema && media.schema) {
        existingMedia.schema = media.schema;
      }
      if (confidence === "high") existing.confidence = "high";
    } else {
      this.map.set(key, {
        statusCode: status,
        description: opts.description ?? "",
        confidence,
        content: [media],
      });
    }
  }

  /**
   * Records an authoritative schema (for example a framework-level response
   * contract): unlike `record`, an existing inferred schema for the same
   * status/media type is replaced rather than preserved.
   */
  replace(
    status: string,
    mediaType: string,
    schema: JsonSchema | undefined,
    confidence: Confidence,
    opts: { description?: string; itemSchema?: JsonSchema } = {},
  ): void {
    const key = `${status}:${mediaType}`;
    const existing = this.map.get(key);
    if (existing) {
      const existingMedia = existing.content?.find((m) => m.mediaType === mediaType);
      if (existingMedia) {
        if (schema && Object.keys(schema).length) existingMedia.schema = schema;
        if (opts.itemSchema && Object.keys(opts.itemSchema).length) {
          existingMedia.itemSchema = opts.itemSchema;
        }
      }
      if (confidence === "high") existing.confidence = "high";
      return;
    }
    this.record(status, mediaType, schema, confidence, opts);
  }

  all(): DiscoveredResponse[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }
}

/** Builds a path/query/header/cookie parameter, de-duplicating by location:name. */
export function addParam(
  into: RouteParameter[],
  seen: Set<string>,
  location: RouteParameter["in"],
  name: string,
  schema: JsonSchema | undefined,
  confidence: Confidence = "medium",
  required = location === "path",
): void {
  const key = `${location}:${name}`;
  if (seen.has(key)) {
    const existing = into.find((p) => `${p.in}:${p.name}` === key);
    if (existing && schema && (!existing.schema || !Object.keys(existing.schema).length)) {
      existing.schema = schema;
      existing.confidence = confidence;
    }
    return;
  }
  seen.add(key);
  into.push({
    name,
    in: location,
    required,
    ...(schema && Object.keys(schema).length ? { schema } : {}),
    confidence,
  });
}

/** Collects project-wide registered components into DiscoveredComponent form. */
export function collectComponents(analysis: TsAnalysis): Array<{ name: string; schema: JsonSchema }> {
  return [...analysis.schemaContext.components.entries()].map(([name, schema]) => ({
    name,
    schema,
  }));
}
