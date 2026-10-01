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
    if (!parameter) {
      gaps.add("path-param-untyped");
      candidate.parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        confidence: "low",
      });
    } else if (!parameter.schema) {
      gaps.add("path-param-untyped");
      parameter.schema = { type: "string" };
      parameter.confidence = downgrade(parameter.confidence);
    }
    declaredPath.add(name);
  }

  if (candidate.requestBody && candidate.requestBody.content.length === 0) {
    gaps.add("body-schema-unknown");
  }

  const typedResponses = candidate.responses.filter((r) => {
    if (!r.content) return true;
    return r.content.every((m) => {
      if (m.schema || m.itemSchema) return true;
      // SSE event payloads have their own dedicated gap code.
      if (m.mediaType === "text/event-stream") {
        gaps.add("sse-events-unknown");
        return true;
      }
      return false;
    });
  });
  if (candidate.responses.length === 0) {
    gaps.add("response-unknown");
  } else if (typedResponses.length !== candidate.responses.length) {
    gaps.add("response-schema-unknown");
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
