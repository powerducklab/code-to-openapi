/**
 * Language-neutral engine model.
 *
 * The scanning pipeline is:
 *
 *   indexer -> project probe -> language packs -> framework packs
 *          -> completeness gate -> Discovery IR (@powerduck/x-to-openapi)
 *
 * Language packs turn source files into a language-specific analysis (ASTs,
 * type information). Framework packs consume that analysis through a small
 * surface and emit route candidates. Adding a language or a framework never
 * requires changes to the engine.
 */

import type {
  Confidence,
  DiscoveredComponent,
  DiscoveredMediaType,
  DiscoveredOperation,
  DiscoveredResponse,
  DiscoveredSecurityScheme,
  DiscoveredServer,
  DiscoveredUnresolved,
  GapCode,
  JsonSchema,
  SourceLocation,
} from "@powerduck/x-to-openapi";

export type {
  Confidence,
  DiscoveredComponent,
  DiscoveredMediaType,
  DiscoveredOperation,
  DiscoveredResponse,
  DiscoveredSecurityScheme,
  DiscoveredServer,
  DiscoveredUnresolved,
  GapCode,
  JsonSchema,
  SourceLocation,
};

export interface FileEntry {
  /** Repository-relative POSIX path. */
  path: string;
  absolutePath: string;
  content: string;
  bytes: number;
  /** SHA-256 of the content. */
  hash: string;
  language: string;
}

export interface FileIndex {
  files: FileEntry[];
  byPath: Map<string, FileEntry>;
}

export interface DependencyManifest {
  /** package.json dependencies/dev/peer merged, name -> version. */
  packages: Map<string, string>;
  packageJsonPath?: string;
}

export interface ScanContext {
  root: string;
  index: FileIndex;
  manifest: DependencyManifest;
  /** Emit progress lines for the host UI. */
  onProgress?: (phase: string, detail?: string) => void;
  /** Diagnostic sink. */
  report: (message: string, origin?: SourceLocation) => void;
}

/**
 * A language pack owns parsing and type resolution for one language family.
 * Framework packs receive the opaque `Analysis` produced here.
 */
export interface LanguagePack<TAnalysis = unknown> {
  id: string;
  extensions: readonly string[];
  /** Returns null when the pack cannot analyze this project. */
  analyze(ctx: ScanContext): TAnalysis | Promise<TAnalysis | null> | null;
}

export interface RouteParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  confidence: Confidence;
}

export interface RouteCandidate {
  method: string;
  /** Path template with `{name}` placeholders, WITHOUT mount prefixes. */
  path: string;
  /** Full path including the mount chain; filled by the framework pack. */
  fullPath?: string;
  /** Stable operation id suggested by the framework pack. */
  operationId?: string;
  /** Language that produced this candidate. */
  language?: string;
  /** Framework pack id that produced this candidate. */
  framework?: string;
  origin: SourceLocation;
  parameters: RouteParameter[];
  requestBody?: {
    required?: boolean;
    content: DiscoveredMediaType[];
    confidence: Confidence;
  };
  responses: DiscoveredResponse[];
  tags: string[];
  security?: Array<Record<string, string[]>>;
  extensions?: Record<string, unknown>;
  confidence: Confidence;
  gaps: GapCode[];
  /** Named schemas recovered while analyzing this handler. */
  components: DiscoveredComponent[];
  /** Routers/middleware this route is mounted behind. */
  mountPrefixes?: string[];
  /** Handler source slice for the optional AI gap resolver. */
  handlerSource?: string;
}

export interface ExtractionResult {
  routes: RouteCandidate[];
  unresolved: DiscoveredUnresolved[];
  components: DiscoveredComponent[];
  securitySchemes: DiscoveredSecurityScheme[];
  servers: DiscoveredServer[];
}

export interface FrameworkPack<TAnalysis = unknown> {
  id: string;
  language: string;
  /** npm package names whose presence enables this pack. */
  dependencyHints: readonly string[];
  /** Quick gate before the expensive analysis is handed over. */
  applies(ctx: ScanContext): boolean;
  extract(analysis: TAnalysis, ctx: ScanContext): ExtractionResult | Promise<ExtractionResult>;
}

export interface ScanOptions {
  /** Directory to scan. */
  root: string;
  /** Extra glob-ish ignore patterns (gitignore is always honored). */
  ignore?: readonly string[];
  /** Include files normally excluded (tests, scripts). */
  includeTests?: boolean;
  /** Explicit generated-source directories inside root, including ignored build directories. Never generates or executes code. */
  additionalSourceRoots?: readonly string[];
  /** Framework ids to restrict the scan to. */
  frameworks?: readonly string[];
  /** File size cap per source file, bytes. Default 2 MiB. */
  maxFileBytes?: number;
  /** Progress sink for host UIs (indexing, extraction, AI gap fills). */
  onProgress?: (phase: string, detail?: string) => void;
  /** AI gap resolver; absent means deterministic-only output. */
  gapResolver?: import("../ai/gapResolver.js").GapResolver;
  /**
   * How model-derived gaps are handled. "auto" (default) resolves and merges
   * immediately. "manual" leaves every gap open and returns `gapReviews` for
   * the host to propose, show to the user, and apply only after acceptance.
   */
  aiReview?: "auto" | "manual";
}

export interface ScanReport {
  languages: string[];
  frameworks: string[];
  filesScanned: number;
  routesConfirmed: number;
  routesPartial: number;
  unresolved: number;
  gaps: Array<{ route: string; gaps: GapCode[] }>;
  /** Number of handlers sent to the AI gap resolver. */
  aiAttempted: number;
  /** Number of handlers for which the model closed at least one gap. */
  aiResolved: number;
  /** Per-route AI fills, including partial fills still carrying gaps. */
  aiResolvedRoutes: Array<{
    method: string;
    path: string;
    gapsClosed: number;
  }>;
  /** Handlers with open gaps awaiting manual AI review (manual review mode). */
  aiPending?: number;
  /** Non-fatal problems encountered during analysis (pack failures, etc.). */
  diagnostics: string[];
}

export interface ScanResult {
  project: import("@powerduck/x-to-openapi").DiscoveredProject;
  report: ScanReport;
  /** Indexed source files (relative path and content hash) used by the scan. */
  files: FileEntry[];
  /** Pending AI gap reviews when `aiReview: "manual"`. */
  gapReviews?: import("../ai/review.js").GapReview[];
  /** Sidecar snapshot for incremental rescans. */
  sidecar: import("./sidecar.js").DiscoverySidecar;
  /** Re-exported conversion result; document is validated OAS 3.2. */
  convert(): Promise<import("@powerduck/x-to-openapi").DiscoveryResult>;
}
