import type { Confidence, GapCode } from "./types.js";
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
export function applyCompletenessGate(candidate: RouteCandidate): RouteCandidate {
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

  if (candidate.requestBody && candidate.requestBody.content.length === 0) {
    gaps.add("body-schema-unknown");
  }

  const typedResponses = candidate.responses.filter((r) => {
    // 204 and 3xx responses carry no JSON body by definition.
    if (/^(204|3\d\d)$/.test(r.statusCode)) return true;
    if (!r.content) return true;
    return r.content.every((m) => {
      if (m.schema || m.itemSchema) return true;
      // SSE event payloads have their own dedicated gap code.
      if (m.mediaType === "text/event-stream") {
        gaps.add("sse-events-unknown");
        return true;
      }
      // Rendered views (text/html) and other plain-text bodies are fully
      // described by their media type; no JSON schema is applicable.
      if (
        m.mediaType === "text/html" ||
        m.mediaType === "text/plain" ||
        m.mediaType === "text/css"
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
    candidate.responses.every((r) => /^(204|3\d\d)$/.test(r.statusCode))
  ) {
    // Bodyless 204/3xx responses never need a schema.
    gaps.delete("response-schema-unknown");
  }

  // 204/3xx responses carry no body by definition: normalize away any
  // placeholder media so the converted document stays valid. Other media
  // without schema is kept on purpose (weakly typed packs surface the gap as
  // an empty schema for the AI resolver or the user to fill).
  for (const response of candidate.responses) {
    if (/^(204|3\d\d)$/.test(response.statusCode)) {
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
