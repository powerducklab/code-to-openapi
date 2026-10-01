import type { GapRequest, GapResolution } from "./gapResolver.js";
import type { JsonSchema } from "../core/types.js";

/**
 * Bump when the prompt contract changes so cached gap resolutions from older
 * prompts cannot be reused.
 */
export const GAP_PROMPT_VERSION = "2026-10-01";

export interface GapPromptMessage {
  role: "system" | "user";
  content: string;
}

const SYSTEM_PROMPT = `You are a static-analysis assistant for ONE already-discovered Node.js (Express) request handler.
The route, method and path are GIVEN. Never invent, rename or relocate routes, methods or paths.
Infer request and response shapes ONLY from the handler source code:
- Query parameters: req.query.x, req.query["x"], or destructured query objects.
- Headers: req.headers.x, req.get("x"), req.header("x").
- JSON request body: req.body.x, destructured bodies, express-validator chains, or zod schemas.
- Responses: res.status(n).json(value), res.json(value), res.send(value). Infer each status code actually used.
- SSE: res.write chunks shaped "event: NAME\\ndata: {...}\\n\\n". List each distinct event name and its data shape.
Use only fields evidenced by the code. Do not guess standard fields (id, createdAt, pagination) unless present.
Respond with ONE JSON object and nothing else (no markdown, no prose):
{
  "queryParameters": [{"name": "string", "required": false, "schema": {"type": "string"}}],
  "headerParameters": [{"name": "x-tenant", "required": false, "schema": {"type": "string"}}],
  "bodySchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
  "responseSchemas": {"200": {"type": "object", "properties": {"ok": {"type": "boolean"}}}},
  "sseEvents": [{"name": "tick", "dataSchema": {"type": "object", "properties": {"t": {"type": "number"}}}}],
  "confidence": "high",
  "rationale": "one short English sentence"
}
Rules:
- JSON Schema subset only: type (object, array, string, number, integer, boolean), properties, required, items, enum, format, const, nullable.
- No $ref, no external references, no example data copied from tests.
- Omit any key you have no code evidence for. If nothing can be inferred, return {"confidence": "low"}.
- Path parameters are already known and must never be repeated.
- confidence is high only when every returned shape is explicit in the code, medium when inferred from usage, low otherwise.`;

/** Build the OpenAI-compatible chat messages for one handler gap request. */
export function buildGapMessages(request: GapRequest): GapPromptMessage[] {
  const userPayload = {
    route: request.route,
    origin: request.origin,
    missing: request.gaps,
    known: request.known,
    handlerSource: request.handlerSource,
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Analyze this handler and return the JSON object described by the system message.\n${JSON.stringify(
        userPayload,
        null,
        2,
      )}`,
    },
  ];
}

const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 100;
const MAX_ENUM = 50;

/**
 * Clamp an untrusted model-produced schema to a safe JSON Schema subset.
 * Returns null when the fragment is not a usable schema.
 */
export function sanitizeSchema(
  raw: unknown,
  depth = 0,
): JsonSchema | null {
  if (depth > MAX_DEPTH) return null;
  // Schema fragments must be objects; bare primitives are not valid schemas.
  if (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return null;
  }
  if (typeof raw !== "object") return null;
  if (Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const schema: JsonSchema = {};

  if (typeof source.type === "string" && ALLOWED_TYPES.has(source.type)) {
    schema.type = source.type as JsonSchema["type"];
  }
  if (typeof source.const !== "undefined") {
    schema.const = source.const;
  }
  if (typeof source.format === "string" && /^[a-z0-9-]{1,40}$/.test(source.format)) {
    schema.format = source.format;
  }
  if (typeof source.description === "string" && source.description.length <= 300) {
    schema.description = source.description;
  }
  if (source.nullable === true) schema.nullable = true;
  if (Array.isArray(source.enum) && source.enum.length <= MAX_ENUM) {
    const values = source.enum.filter(
      (value) =>
        value === null ||
        ["string", "number", "boolean"].includes(typeof value),
    );
    if (values.length) schema.enum = values as (string | number | boolean)[];
  }

  if (source.type === "object" || (!schema.type && source.properties)) {
    schema.type = "object";
    if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
      const properties: Record<string, JsonSchema> = {};
      let count = 0;
      for (const [key, value] of Object.entries(
        source.properties as Record<string, unknown>,
      )) {
        if (count >= MAX_PROPERTIES) break;
        if (!/^[A-Za-z0-9._$-]{1,80}$/.test(key)) continue;
        const child = sanitizeSchema(value, depth + 1);
        if (child) {
          properties[key] = child;
          count += 1;
        }
      }
      if (Object.keys(properties).length) schema.properties = properties;
    }
    if (Array.isArray(source.required)) {
      const required = source.required.filter(
        (name): name is string =>
          typeof name === "string" &&
          /^[A-Za-z0-9._$-]{1,80}$/.test(name),
      );
      if (required.length) schema.required = required;
    }
  }

  if (source.type === "array") {
    const items = sanitizeSchema(source.items, depth + 1);
    if (items) schema.items = items;
  }

  // A schema with no structural signal is noise.
  if (
    !schema.type &&
    schema.const === undefined &&
    !schema.enum &&
    !schema.nullable
  ) {
    return null;
  }
  return schema;
}

interface ParameterEntry {
  name?: unknown;
  required?: unknown;
  schema?: unknown;
}

function toParameterSchema(entries: unknown): JsonSchema | null {
  if (!Array.isArray(entries)) return null;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const entry of entries.slice(0, MAX_PROPERTIES)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as ParameterEntry;
    if (typeof item.name !== "string" || !/^[A-Za-z0-9._$-]{1,80}$/.test(item.name)) {
      continue;
    }
    const schema = sanitizeSchema(item.schema);
    if (!schema) continue;
    properties[item.name] = schema;
    if (item.required === true) required.push(item.name);
  }
  if (!Object.keys(properties).length) return null;
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]!.trim() : trimmed;
}

/**
 * Parse and validate a raw model response into a GapResolution, or null when
 * it carries no usable, safe content.
 */
export function parseGapResolution(raw: unknown): GapResolution | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;

  const querySchema = toParameterSchema(source.queryParameters);
  const headerSchema = toParameterSchema(source.headerParameters);
  const bodySchema = sanitizeSchema(source.bodySchema);

  const responseSchemas: Record<string, JsonSchema> = {};
  if (source.responseSchemas && typeof source.responseSchemas === "object" && !Array.isArray(source.responseSchemas)) {
    for (const [status, value] of Object.entries(
      source.responseSchemas as Record<string, unknown>,
    )) {
      if (!/^([1-5][0-9Xx]{2}|default)$/.test(status)) continue;
      const schema = sanitizeSchema(value);
      if (schema) responseSchemas[status] = schema;
    }
  }

  let sseEvents: GapResolution["sseEvents"];
  if (Array.isArray(source.sseEvents)) {
    for (const event of source.sseEvents.slice(0, 20)) {
      if (!event || typeof event !== "object") continue;
      const name = (event as Record<string, unknown>).name;
      if (typeof name !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(name)) {
        continue;
      }
      const dataSchema = sanitizeSchema(
        (event as Record<string, unknown>).dataSchema,
      );
      sseEvents ??= [];
      sseEvents.push({
        name,
        ...(dataSchema ? { dataSchema } : {}),
      });
    }
  }

  if (!querySchema && !headerSchema && !bodySchema && !Object.keys(responseSchemas).length && !sseEvents?.length) {
    return null;
  }

  const confidence: GapResolution["confidence"] =
    source.confidence === "high" || source.confidence === "low"
      ? source.confidence
      : "medium";
  const rationale =
    typeof source.rationale === "string" && source.rationale.length <= 300
      ? source.rationale
      : undefined;

  return {
    ...(querySchema ? { querySchema } : {}),
    ...(headerSchema ? { headerSchema } : {}),
    ...(bodySchema ? { bodySchema } : {}),
    ...(Object.keys(responseSchemas).length ? { responseSchemas } : {}),
    ...(sseEvents?.length ? { sseEvents } : {}),
    confidence,
    ...(rationale ? { rationale } : {}),
  };
}
