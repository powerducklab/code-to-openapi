import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type DiscoveredOperation,
  type DiscoveredProject,
  type DiscoveryResult,
  discoveryToOpenApi,
} from "@powerduck/x-to-openapi";

import { applyCompletenessGate } from "./completeness.js";
import { indexProject } from "./indexer.js";
import { probeManifest } from "./probe.js";
import { buildSidecar } from "./sidecar.js";
import type {
  ExtractionResult,
  FileIndex,
  FrameworkPack,
  JsonSchema,
  RouteCandidate,
  ScanContext,
  ScanOptions,
  ScanReport,
  ScanResult,
} from "./types.js";
import { createTsAnalysis, type TsAnalysis } from "../lang/typescript/index.js";
import { expressPack } from "../frameworks/express.js";
import type { GapResolver } from "../ai/gapResolver.js";

const REGISTRY: {
  language: (ctx: ScanContext) => TsAnalysis | null;
  frameworks: Array<FrameworkPack<TsAnalysis>>;
} = {
  language: (ctx) => createTsAnalysis(ctx),
  frameworks: [expressPack],
};

function toOperation(candidate: RouteCandidate): DiscoveredOperation {
  return {
    method: candidate.method,
    path: candidate.fullPath ?? candidate.path,
    operationId: undefined,
    summary: undefined,
    description: undefined,
    tags: candidate.tags,
    parameters: candidate.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      ...(p.description ? { description: p.description } : {}),
      required: p.required,
      ...(p.schema ? { schema: p.schema } : {}),
      confidence: p.confidence,
    })),
    ...(candidate.requestBody
      ? {
          requestBody: {
            required: candidate.requestBody.required ?? false,
            content: candidate.requestBody.content,
            confidence: candidate.requestBody.confidence,
          },
        }
      : {}),
    responses: candidate.responses,
    ...(candidate.security ? { security: candidate.security } : {}),
    ...(candidate.extensions ? { extensions: candidate.extensions } : {}),
    confidence: candidate.confidence,
    origin: candidate.origin,
    gaps: candidate.gaps,
  };
}

async function applyAiGaps(
  candidate: RouteCandidate,
  resolver: GapResolver,
  ctx: ScanContext,
): Promise<RouteCandidate> {
  if (!candidate.gaps.length || !candidate.handlerSource) return candidate;

  const resolution = await resolver.resolve({
    route: { method: candidate.method, path: candidate.fullPath ?? candidate.path },
    origin: candidate.origin,
    gaps: candidate.gaps,
    handlerSource: candidate.handlerSource,
    known: {
      pathParameters: candidate.parameters
        .filter((p) => p.in === "path")
        .map((p) => p.name),
      framework: "express",
      language: "typescript",
    },
  });
  if (!resolution) return candidate;

  const next: RouteCandidate = {
    ...candidate,
    parameters: [...candidate.parameters],
    responses: [...candidate.responses],
  };

  if (resolution.querySchema) {
    for (const [name, schema] of Object.entries(
      resolution.querySchema.properties ?? {},
    ) as Array<[string, JsonSchema]>) {
      if (!next.parameters.some((p) => p.in === "query" && p.name === name)) {
        next.parameters.push({
          name,
          in: "query",
          required:
            (resolution.querySchema.required as string[] | undefined)?.includes(
              name,
            ) ?? false,
          schema,
          confidence: resolution.confidence,
        });
      }
    }
  }
  if (resolution.bodySchema && !next.requestBody) {
    next.requestBody = {
      required: true,
      confidence: resolution.confidence,
      content: [{ mediaType: "application/json", schema: resolution.bodySchema }],
    };
  }
  for (const [status, schema] of Object.entries(
    resolution.responseSchemas ?? {},
  ) as Array<[string, JsonSchema]>) {
    const existing = next.responses.find((r) => r.statusCode === status);
    if (existing) {
      existing.content = existing.content ?? [];
      const media = existing.content.find((m) => m.mediaType === "application/json");
      if (media) media.schema = schema;
      else existing.content.push({ mediaType: "application/json", schema });
    } else {
      next.responses.push({
        statusCode: status,
        description: "",
        confidence: resolution.confidence,
        content: [{ mediaType: "application/json", schema }],
      });
    }
  }

  next.gaps = next.gaps.filter((gap) => {
    if (gap === "query-unknown" && resolution.querySchema) return false;
    if (gap === "body-schema-unknown" && resolution.bodySchema) return false;
    if (gap === "response-schema-unknown" && resolution.responseSchemas) return false;
    if (gap === "sse-events-unknown" && resolution.sseEvents?.length) return false;
    return true;
  });

  ctx.onProgress?.("ai-gap", `${candidate.method} ${candidate.fullPath}`);
  return next;
}

function projectMeta(root: string): { title: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return {
      title: typeof pkg.name === "string" ? pkg.name : "Scanned API",
      version: typeof pkg.version === "string" ? pkg.version : "1.0.0",
    };
  } catch {
    return { title: "Scanned API", version: "1.0.0" };
  }
}

/**
 * Scans a project directory and produces Discovery IR plus a validated
 * OpenAPI 3.2 document. Deterministic by default; an AI gap resolver only
 * fills explicitly identified gaps when the host provides one.
 */
export async function scanProject(options: ScanOptions): Promise<ScanResult> {
  const root = resolve(options.root);
  const index: FileIndex = { files: [], byPath: new Map() };
  const indexed = indexProject(root, {
    ignore: options.ignore,
    includeTests: options.includeTests,
    maxFileBytes: options.maxFileBytes,
  });
  index.files = indexed.files;
  index.byPath = indexed.byPath;

  const manifest = probeManifest(root, index);
  const diagnostics: string[] = [];
  const ctx: ScanContext = {
    root,
    index,
    manifest,
    report: (message) => diagnostics.push(message),
  };

  const tsFiles = index.files.filter((f) =>
    ["typescript", "javascript"].includes(f.language),
  );
  if (!tsFiles.length) {
    throw new Error(
      "No supported source files found. P1 supports TypeScript/JavaScript projects.",
    );
  }

  ctx.onProgress?.("analyze", `${tsFiles.length} source files`);
  const analysis = REGISTRY.language(ctx);
  if (!analysis) throw new Error("TypeScript analysis could not be initialized.");

  const extractions: ExtractionResult[] = [];
  for (const pack of REGISTRY.frameworks) {
    if (options.frameworks && !options.frameworks.includes(pack.id)) continue;
    if (!pack.applies(ctx)) continue;
    ctx.onProgress?.("extract", pack.id);
    extractions.push(await pack.extract(analysis, ctx));
  }

  if (!extractions.length) {
    throw new Error(
      "No supported HTTP framework detected. P1 ships the Express framework pack.",
    );
  }

  let candidates = extractions.flatMap((result) => result.routes);
  if (options.gapResolver) {
    candidates = await Promise.all(
      candidates.map((candidate) =>
        applyAiGaps(candidate, options.gapResolver!, ctx),
      ),
    );
  }
  candidates = candidates.map((candidate) =>
    applyCompletenessGate({ ...candidate, fullPath: candidate.fullPath ?? candidate.path }),
  );

  const operations = candidates.map(toOperation);

  const componentsByName = new Map<string, JsonSchema>();
  for (const extraction of extractions) {
    for (const component of extraction.components) {
      const existing = componentsByName.get(component.name);
      if (!existing) componentsByName.set(component.name, component.schema);
    }
  }
  const components = [...componentsByName.entries()].map(([name, schema]) => ({
    name,
    schema,
  }));

  const securitySchemes = extractions.flatMap((r) => r.securitySchemes);
  const servers = extractions.flatMap((r) => r.servers);
  const unresolved = extractions.flatMap((r) => r.unresolved);

  const meta = projectMeta(root);
  const project: DiscoveredProject = {
    title: meta.title,
    version: meta.version,
    operations,
    components,
    securitySchemes: dedupeBy(securitySchemes, (s) => s.name),
    servers: dedupeBy(servers, (s) => s.url),
    unresolved,
  };

  const report: ScanReport = {
    languages: ["typescript"],
    frameworks: extractions.length ? ["express"] : [],
    filesScanned: tsFiles.length,
    routesConfirmed: operations.filter((o) => o.confidence === "high").length,
    routesPartial: operations.filter((o) => o.confidence !== "high").length,
    unresolved: unresolved.length,
    gaps: operations
      .filter((o) => o.gaps?.length)
      .map((o) => ({ route: `${o.method} ${o.path}`, gaps: [...(o.gaps ?? [])] })),
  };

  return {
    project,
    report,
    files: index.files,
    sidecar: buildSidecar({
      files: index.files,
      operations,
      language: "typescript",
      framework: extractions.length ? "express" : undefined,
    }),
    convert(): Promise<DiscoveryResult> {
      return discoveryToOpenApi(project, { validate: true });
    },
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
