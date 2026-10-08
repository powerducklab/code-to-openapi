import type { Confidence, GapCode, JsonSchema } from "./types.js";
import type { RouteCandidate } from "./types.js";

/**
 * Normalizes a route candidate after framework extraction:
 * - verifies path-template parameters against declared parameters;
 * - de-duplicates gaps;
 * - derives a final confidence level.
 *
 * The gate never invents content: a missing shape stays a gap and is either
 * sent to the AI resolver or surfaced in the scan report.
 */
const SCHEMA_ANNOTATIONS = new Set(["title", "description", "default", "examples", "example", "readOnly", "writeOnly", "deprecated", "$comment", "$id", "$schema"]);

export function hasUnknownSchema(schema: unknown, components?: ReadonlyMap<string, JsonSchema>): boolean {
  if (schema === undefined || schema === null) return true;
  return walkUnknown(schema, components, new Set<object>());
}

// Iterative depth-first check sharing one cycle set, so self-referential
// branch schemas cannot recurse forever across nested evaluations.
function walkUnknown(
  start: unknown,
  components: ReadonlyMap<string, JsonSchema> | undefined,
  rootSeen: Set<object>,
): boolean {
  const pending: unknown[] = [start];
  const seen = rootSeen;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (Array.isArray(value["x-discovery-incomplete"]) && value["x-discovery-incomplete"].length) return true;
    if (!Object.keys(value).some(key => !SCHEMA_ANNOTATIONS.has(key) && !key.startsWith("x-"))) return true;
    if (components && typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
      const name = value.$ref.slice("#/components/schemas/".length).replace(/~1/g, "/").replace(/~0/g, "~");
      const target = components.get(name);
      if (!target) return true;
      pending.push(target);
    }
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.includes("array") && value.items === undefined && value.maxItems !== 0 &&
        !["anyOf", "oneOf", "allOf"].some(key => Array.isArray(value[key]))) {
      const prefix = Array.isArray(value.prefixItems) ? value.prefixItems.length : 0;
      if (!prefix || typeof value.maxItems !== "number" || value.maxItems > prefix) return true;
    }
    if (value.properties) for (const item of Object.values(value.properties as object)) pending.push(item);
    // An array element schema of {} means the element type is genuinely
    // unknown, so it stays a gap (unlike additionalProperties: {}, which is
    // the standard "any extra property allowed" assertion).
    if (value.items) {
      if (Array.isArray(value.items)) for (const item of value.items as unknown[]) pending.push(item);
      else pending.push(value.items);
    }
    for (const key of ["contains", "propertyNames", "not", "if", "then", "else"]) {
      if (value[key] && typeof value[key] === "object" &&
          Object.keys(value[key] as object).length > 0) {
        pending.push(value[key]);
      }
    }
    // additionalProperties / unevaluatedProperties of {} (or true) mean
    // "unconstrained extra values allowed" — a complete assertion, not an
    // unknown shape; only non-empty constraint schemas carry gated evidence.
    for (const key of ["additionalProperties", "unevaluatedProperties"]) {
      const slot = value[key];
      if (slot && typeof slot === "object" && Object.keys(slot as object).length > 0) {
        pending.push(slot);
      }
    }
    // Pattern-matched properties with an empty schema likewise mean "any
    // value for matching keys"; only non-empty value schemas are gated.
    if (value.patternProperties && typeof value.patternProperties === "object") {
      for (const item of Object.values(value.patternProperties as object)) {
        if (item && typeof item === "object" && Object.keys(item as object).length > 0) {
          pending.push(item);
        }
      }
    }
    if (value.dependentSchemas && typeof value.dependentSchemas === "object") {
      for (const item of Object.values(value.dependentSchemas as object)) {
        if (item && typeof item === "object" && Object.keys(item as object).length > 0) {
          pending.push(item);
        }
      }
    }
    // A known success branch must not hide an unresolved alternative. This
    // gate measures completeness of the entire contract, not whether at least
    // one example can be generated. Share the cycle set across every branch.
    for (const key of ["anyOf", "oneOf"]) {
      if (Array.isArray(value[key])) for (const item of value[key] as unknown[]) pending.push(item);
    }
    for (const key of ["allOf", "prefixItems"]) {
      if (Array.isArray(value[key])) for (const item of value[key] as unknown[]) pending.push(item);
    }
  }
  return false;
}

export function applyCompletenessGate(candidate: RouteCandidate, components?: ReadonlyMap<string, JsonSchema>): RouteCandidate {
  const gaps = new Set<GapCode>(candidate.gaps);
  const templateParams = new Set(
    [...candidate.fullPath!.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
  );
  const declaredPath = new Set(
    candidate.parameters.filter((p) => p.in === "path").map((p) => p.name),
  );

  for (const name of templateParams) {
    const parameter = candidate.parameters.find(
      (p) => p.in === "path" && p.name === name,
    );
    // Every URL path segment is a string by OpenAPI rules; synthesizing
    // {type:"string"} for a template param is the correct default and is
    // NOT a gap. A gap is reserved for params that cannot be bound to the
    // route template at all (handled elsewhere).
    if (!parameter) {
      candidate.parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "low",
      });
    } else if (!parameter.schema) {
      parameter.schema = { type: "string" };
      parameter.confidence = downgrade(parameter.confidence);
    }
    declaredPath.add(name);
  }

  if (candidate.requestBody && (candidate.requestBody.content.length === 0 || candidate.requestBody.content.some(media => hasUnknownSchema(media.schema, components)))) {
    gaps.add("body-schema-unknown");
  }

  const typedResponses = candidate.responses.filter((r) => {
    // Only statuses that prohibit content may discard inferred payloads.
    if (/^(1\d\d|204|205|304)$/.test(r.statusCode)) return true;
    if (!r.content) return true;
    return r.content.every((m) => {
      // Media type parameters (e.g. "; charset=utf-8") never carry schema
      // semantics, so compare on the base media type only.
      const baseMediaType = m.mediaType.split(";")[0]!.trim();
      if (m.schema || m.itemSchema) {
        if (hasUnknownSchema(m.itemSchema ?? m.schema, components)) gaps.add(baseMediaType === "text/event-stream" ? "sse-events-unknown" : "response-schema-unknown");
        return true;
      }
      // SSE event payloads have their own dedicated gap code.
      if (baseMediaType === "text/event-stream") {
        gaps.add("sse-events-unknown");
        return true;
      }
      // Rendered views (text/html) and other plain-text bodies are fully
      // described by their media type; no JSON schema is applicable.
      if (
        baseMediaType === "text/html" ||
        baseMediaType === "text/plain" ||
        baseMediaType === "text/css"
      ) {
        return true;
      }
      return false;
    });
  });
  if (candidate.responses.length === 0) {
    gaps.add("response-unknown");
  } else if (typedResponses.length !== candidate.responses.length) {
    gaps.add("response-schema-unknown");
  } else if (
    candidate.responses.every((r) => /^(1\d\d|204|205|304)$/.test(r.statusCode))
  ) {
    // Bodyless statuses never need a schema.
    gaps.delete("response-schema-unknown");
  }

  // Statuses prohibiting a body: normalize away any
  // placeholder media so the converted document stays valid. Other media
  // without schema is kept on purpose (weakly typed packs surface the gap as
  // an empty schema for the AI resolver or the user to fill).
  for (const response of candidate.responses) {
    if (/^(1\d\d|204|205|304)$/.test(response.statusCode)) {
      response.content = undefined;
    }
  }

  let confidence: Confidence = candidate.confidence;
  if (
    gaps.has("body-unknown") ||
    gaps.has("response-unknown") ||
    gaps.has("path-dynamic")
  ) {
    confidence = "low";
  } else if (
    gaps.has("body-schema-unknown") ||
    gaps.has("response-schema-unknown") ||
    gaps.has("query-unknown") ||
    gaps.has("sse-events-unknown") ||
    gaps.has("path-param-untyped")
  ) {
    confidence = confidence === "high" ? "medium" : confidence;
  }

  return {
    ...candidate,
    gaps: [...gaps],
    confidence,
  };
}

function downgrade(level: Confidence): Confidence {
  return level === "high" ? "medium" : "low";
}
