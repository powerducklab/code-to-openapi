/**
 * @powerduck/code-to-openapi
 *
 * Scans a local codebase and produces OpenAPI 3.2.
 *
 * Architecture:
 *   indexer -> language packs (AST + types) -> framework packs (routes)
 *          -> completeness gate -> Discovery IR (@powerduck/x-to-openapi)
 *
 * Deterministic extraction is the default; the host may supply an AI gap
 * resolver that only fills explicitly identified per-handler gaps.
 */

export { scanProject, convertProject } from "./core/engine.js";
export { indexProject } from "./core/indexer.js";
export { probeManifest } from "./core/probe.js";
export { applyCompletenessGate } from "./core/completeness.js";
export {
  diffSidecars,
  affectedFiles,
  buildSidecar,
  type DiscoverySidecar,
  type SidecarDiff,
  type SidecarRoute,
} from "./core/sidecar.js";
export {
  mergeScannedDocument,
  type MergeInput,
  type MergeResult,
  type MergeChange,
} from "./core/merge.js";
export { expressPack } from "./frameworks/express.js";
export { fastifyPack } from "./frameworks/fastify.js";
export { nestPack } from "./frameworks/nest.js";
export { fastapiPack } from "./frameworks/fastapi.js";
export { flaskPack } from "./frameworks/flask.js";
export { ginPack } from "./frameworks/gin.js";
export { chiPack } from "./frameworks/chi.js";
export { springPack } from "./frameworks/spring.js";
export { aspnetPack } from "./frameworks/aspnet.js";
export { axumPack } from "./frameworks/axum.js";
export { laravelPack } from "./frameworks/laravel.js";
export {
  type GapRequest,
  type GapResolution,
  type GapResolver,
  gapCacheKey,
} from "./ai/gapResolver.js";
export {
  GAP_PROMPT_VERSION,
  buildGapMessages,
  parseGapResolution,
  sanitizeSchema,
  type GapPromptMessage,
} from "./ai/prompt.js";
export {
  buildGapReview,
  proposeGap,
  applyGapDecision,
  type GapReview,
  type GapProposal,
  type GapDecision,
  type GapDecisionResult,
} from "./ai/review.js";
export type {
  ExtractionResult,
  FileEntry,
  FileIndex,
  FrameworkPack,
  LanguagePack,
  RouteCandidate,
  RouteParameter,
  ScanContext,
  ScanOptions,
  ScanReport,
  ScanResult,
} from "./core/types.js";

// Re-export the Discovery IR types so consumers have a single import surface.
export type {
  Confidence,
  DiscoveredComponent,
  DiscoveredMediaType,
  DiscoveredOperation,
  DiscoveredProject,
  DiscoveredResponse,
  DiscoveredUnresolved,
  DiscoveryResult,
  GapCode,
  JsonSchema,
  SourceLocation,
} from "@powerduck/x-to-openapi";
