import { fillSchemaGaps } from "./schemaMerge.js";
import { selectComponentContext } from "./componentContext.js";
import { applyCompletenessGate } from "../core/completeness.js";
import { createHash } from "node:crypto";

import type {
  Confidence,
  DiscoveredOperation,
  GapCode,
  JsonSchema,
  RouteCandidate,
} from "../core/types.js";
import type {
  GapRequest,
  GapResolution,
  GapResolver,
} from "./gapResolver.js";
import { parseGapResolution } from "./prompt.js";

/**
 * Interactive AI gap review.
 *
 * The deterministic scan proves most of a contract, but some handlers (opaque
 * ORM results, dynamic serializers) cannot be resolved from source alone.
 * Instead of silently merging model output, the manual review flow is:
 *
 *   1. `buildGapReview`  - packages one unresolved handler for the model.
 *   2. `proposeGap`      - the host resolver returns a sanitized proposal.
 *   3. `applyGapDecision`- the user accepts, edits or rejects it; only accepted
 *      fragments are merged and every AI-derived schema carries
 *      `x-ai-inferred: true` so model evidence stays visible in the document.
 */

export interface GapReview {
  /** Stable id derived from route + source origin (cache/decision key). */
  id: string;
  method: string;
  path: string;
  routeKey: string;
  /** Gap codes still open at review time. */
  gaps: GapCode[];
  request: GapRequest;
  /** Component names the proposal is allowed to reference by $ref. */
  allowedComponents: string[];
}

export interface GapProposal {
  reviewId: string;
  resolution: GapResolution;
}

export interface GapDecision {
  action: "accept" | "reject";
  /**
   * User-edited resolution. When present it replaces the model proposal, so
   * the document reflects exactly what the reviewer approved.
   */
  resolution?: GapResolution;
}

export interface GapDecisionResult {
  operation: DiscoveredOperation;
  /** Gap codes closed by applying an accepted proposal. */
  gapsClosed: GapCode[];
  /** False when the operation was not found or the proposal was rejected. */
  applied: boolean;
}

const AI_TAG = "x-ai-inferred";

function reviewIdFor(method: string, path: string, file?: string, line?: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ method, path, file: file ?? "", line: line ?? 0 }))
    .digest("hex")
    .slice(0, 16);
}

/** Packages one unresolved candidate as a reviewable AI gap request. */
export function buildGapReview(
  candidate: RouteCandidate,
  componentCatalog: NonNullable<GapRequest["componentCatalog"]>,
  reviewAll = false,
  sourceContext?: GapRequest["sourceContext"],
): GapReview | null {
  if ((!candidate.gaps.length && !reviewAll) || !candidate.handlerSource) return null;
  const method = candidate.method;
  const path = candidate.fullPath ?? candidate.path;
  const request: GapRequest = {
    route: { method, path },
    origin: candidate.origin,
    gaps: [...candidate.gaps],
    handlerSource: candidate.handlerSource,
    sourceContext,
    contract: { parameters: candidate.parameters, requestBody: candidate.requestBody, responses: candidate.responses },
    ...(reviewAll ? { audit: true } : {}),
    known: {
      pathParameters: candidate.parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name),
      framework: candidate.framework ?? "unknown",
      language: candidate.language ?? "unknown",
    },
    componentCatalog,
  };
  const relevant = new Set(selectComponentContext(request).components.map(entry => entry.name));
  request.componentCatalog = componentCatalog.map(entry => relevant.has(entry.name) ? entry : {name:entry.name});
  return {
    id: reviewIdFor(method, path, candidate.origin.file, candidate.origin.line),
    method,
    path,
    routeKey: `${method} ${path}`,
    gaps: [...candidate.gaps],
    request,
    allowedComponents: componentCatalog.map((entry) => entry.name),
  };
}

/**
 * Calls the host resolver for one review and clamps the model output to the
 * safe schema subset. Returns null when the model produced nothing usable.
 */
export async function proposeGap(
  resolver: GapResolver,
  review: GapReview,
): Promise<GapProposal | null> {
  const raw = await resolver.resolve(review.request);
  if (!raw) return null;
  const allowed = new Set(review.allowedComponents);
  const resolution = parseGapResolution(
    raw as unknown as Record<string, unknown>,
    allowed,
    review.request,
  );
  if (!resolution) return null;
  return { reviewId: review.id, resolution };
}

function tagAi(schema: JsonSchema): JsonSchema {
  return { ...schema, [AI_TAG]: true };
}

function findOperation(
  operations: DiscoveredOperation[],
  method: string,
  path: string,
): DiscoveredOperation | undefined {
  return operations.find(
    (operation) =>
      operation.method.toLowerCase() === method.toLowerCase() &&
      operation.path === path,
  );
}

function mergeReviewedParameters(
  operation: DiscoveredOperation,
  location: "query" | "header",
  schema: JsonSchema | undefined,
  confidence: Confidence,
  closed: GapCode[],
  gapCode: GapCode,
  replaceKnown = false,
): void {
  if (!schema?.properties) return;
  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  for (const [name, propertySchema] of Object.entries(
    schema.properties as Record<string, JsonSchema>,
  )) {
    const existing = operation.parameters?.find(
      (parameter) => parameter.in === location && parameter.name === name,
    );
    const tagged = tagAi(propertySchema);
    if (existing) {
      if (replaceKnown || !existing.schema || !Object.keys(existing.schema).length) {
        existing.schema = tagged;
        if (replaceKnown) existing.required = required.has(name);
      }
    } else {
      operation.parameters ??= [];
      operation.parameters.push({
        name,
        in: location,
        required: required.has(name),
        schema: tagged,
        confidence,
      });
    }
  }
  if (!closed.includes(gapCode)) closed.push(gapCode);
}

/**
 * Applies a reviewer decision to the matching operation in a scanned project.
 * Pure with respect to the input array (it returns a cloned operation, so the
 * caller decides when to replace the project operation). Rejected proposals
 * close nothing; accepted ones merge and tag every AI-derived fragment.
 */
export function applyGapDecision(
  operations: DiscoveredOperation[],
  review: GapReview,
  decision: GapDecision,
): GapDecisionResult {
  const target = findOperation(operations, review.method, review.path);
  if (!target) {
    return {
      operation: {
        method: review.method,
        path: review.path,
        parameters: [],
        responses: [],
        confidence: "low",
        origin: review.request.origin,
        gaps: review.gaps,
      },
      gapsClosed: [],
      applied: false,
    };
  }
  const operation: DiscoveredOperation = structuredClone(target);
  operation.parameters = structuredClone(operation.parameters ?? []);
  operation.responses = structuredClone(operation.responses ?? []);

  if (decision.action === "reject") {
    return { operation, gapsClosed: [], applied: false };
  }

  const resolution = decision.resolution
    ? parseGapResolution(
        decision.resolution as unknown as Record<string, unknown>,
        new Set(review.allowedComponents),
      )
    : null;
  if (!resolution) {
    return { operation, gapsClosed: [], applied: false };
  }

  if (resolution.outcome) return { operation, gapsClosed: [], applied: false };
  const closed: GapCode[] = [];
  const confidence: Confidence = resolution.confidence === "high" ? "medium" : resolution.confidence;

  if ((review.request.audit || review.gaps.includes("query-unknown")) && resolution.querySchema) {
    mergeReviewedParameters(
      operation,
      "query",
      resolution.querySchema,
      confidence,
      closed,
      "query-unknown",
      review.request.audit === true && review.gaps.length === 0,
    );
  }
  if ((review.request.audit || review.gaps.includes("header-unknown")) && resolution.headerSchema) {
    mergeReviewedParameters(
      operation,
      "header",
      resolution.headerSchema,
      confidence,
      closed,
      "header-unknown",
      review.request.audit === true && review.gaps.length === 0,
    );
  }

  if (
    resolution.bodySchema &&
    ((review.request.audit && review.gaps.length === 0) || review.gaps.some((gap) => gap === "body-unknown" || gap === "body-schema-unknown"))
  ) {
    const jsonMedia = operation.requestBody?.content?.find(
      (media) => media.mediaType === "application/json",
    );
    if (jsonMedia) {
      const merged = review.gaps.length ? fillSchemaGaps(jsonMedia.schema ?? {}, resolution.bodySchema, new Map()) : resolution.bodySchema;
      if (JSON.stringify(merged) !== JSON.stringify(jsonMedia.schema)) {
        jsonMedia.schema = tagAi(merged);
        jsonMedia.confidence = confidence;
      }
    } else if (!operation.requestBody) {
      operation.requestBody = {
        required: true,
        confidence,
        content: [{ mediaType: "application/json", schema: tagAi(resolution.bodySchema) }],
      };
    }
    const bodyGap = review.gaps.find(
      (gap) => gap === "body-schema-unknown" || gap === "body-unknown",
    );
    if (bodyGap && !closed.includes(bodyGap)) closed.push(bodyGap);
  }

  if (
    resolution.responseSchemas &&
    (review.request.audit || review.gaps.some((gap) => gap === "response-unknown" || gap === "response-schema-unknown"))
  ) {
    let responseUpdated = false;
    for (const [status, schema] of Object.entries(resolution.responseSchemas)) {
      if (/^(1\d\d|204|205|304)$/.test(status)) continue;
      const existing = operation.responses.find(
        (response) => response.statusCode === status,
      );
      const tagged = tagAi(schema);
      if (existing) {
        if (!existing.content?.length || /^(1\d\d|204|205|304)$/.test(status)) continue;
        const media = existing.content.find((item) => item.mediaType === "application/json");
        if (media) {
          const merged = review.gaps.length ? fillSchemaGaps(media.schema ?? {}, schema, new Map()) : schema;
          if (JSON.stringify(merged) !== JSON.stringify(media.schema)) {
            media.schema = tagAi(merged);
            media.confidence = confidence;
            responseUpdated = true;
          }
        }
      } else {
        responseUpdated = true;
        operation.responses.push({
          statusCode: status,
          description: "",
          confidence,
          content: [{ mediaType: "application/json", schema: tagged, confidence }],
        });
      }
    }
    const responseGap = review.gaps.find(
      (gap) => gap === "response-schema-unknown" || gap === "response-unknown",
    );
    if (responseUpdated && responseGap && !closed.includes(responseGap)) closed.push(responseGap);
  }

  if (JSON.stringify(operation) === JSON.stringify(target)) {
    return { operation, gapsClosed: [], applied: false };
  }

  operation.gaps = (operation.gaps ?? []).filter((gap) => !closed.includes(gap));
  if (operation.gaps.length === 0) {
    operation.confidence = confidence === "low" ? "low" : "medium";
  }

  const checked = applyCompletenessGate({ ...operation, fullPath: operation.path } as RouteCandidate);
  operation.gaps = checked.gaps;
  return { operation, gapsClosed: closed.filter(gap => !checked.gaps.includes(gap)), applied: true };
}
