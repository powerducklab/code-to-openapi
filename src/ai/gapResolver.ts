import { createHash } from "node:crypto";

import type {
  Confidence,
  GapCode,
  JsonSchema,
  SourceLocation,
} from "../core/types.js";

/**
 * A single deterministically-unresolved question about one handler.
 * Slices are small (handler body plus referenced type names already known);
 * the AI is never asked to discover routes or transcribe files.
 */
export interface GapRequest {
  route: { method: string; path: string };
  origin: SourceLocation;
  /** The specific missing pieces. */
  gaps: GapCode[];
  /** Small source slice: handler function text (2-8 KiB target). */
  handlerSource: string;
  /** Facts already established by AST; the model must not restate them. */
  known: {
    pathParameters: string[];
    framework: string;
    language: string;
  };
}

export interface GapResolution {
  /** Schema fragments keyed by gap code. */
  querySchema?: JsonSchema;
  headerSchema?: JsonSchema;
  bodySchema?: JsonSchema;
  /** status code -> response schema */
  responseSchemas?: Record<string, JsonSchema>;
  sseEvents?: Array<{ name: string; dataSchema?: JsonSchema }>;
  confidence: Confidence;
  /** Short English rationale shown in the review UI. */
  rationale?: string;
}

/**
 * Host-provided AI gap resolver. The scanning package itself never calls a
 * model vendor; the desktop app wires its configured provider here.
 */
export interface GapResolver {
  readonly id: string;
  resolve(request: GapRequest): Promise<GapResolution | null>;
}

/**
 * Stable cache key: identical handler slice + gaps + prompt version must hit
 * the cache so rescans of unchanged code consume zero tokens.
 */
export function gapCacheKey(request: GapRequest, promptVersion: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: promptVersion,
        route: request.route,
        origin: request.origin,
        gaps: request.gaps,
        source: request.handlerSource,
        known: request.known,
      }),
    )
    .digest("hex");
}
