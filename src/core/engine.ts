import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import {
  type DiscoveredOperation,
  type DiscoveredProject,
  type DiscoveryResult,
  discoveryToOpenApi,
} from "@powerduck/x-to-openapi";

import { applyCompletenessGate } from "./completeness.js";
import { hoistLocalSchemaDefinitions } from "./hoistDefinitions.js";
import { indexProject } from "./indexer.js";
import { probeManifest } from "./probe.js";
import { buildSidecar } from "./sidecar.js";
import type {
  Confidence,
  DependencyManifest,
  ExtractionResult,
  FileEntry,
  FileIndex,
  FrameworkPack,
  JsonSchema,
  LanguagePack,
  RouteCandidate,
  ScanContext,
  ScanOptions,
  ScanReport,
  ScanResult,
} from "./types.js";
import { createTsAnalysis, type TsAnalysis } from "../lang/typescript/index.js";
import { createPythonAnalysis, type PythonAnalysis } from "../lang/python/index.js";
import { createGoAnalysis, type GoAnalysis } from "../lang/go/index.js";
import { createJavaAnalysis, type JavaAnalysis } from "../lang/java/index.js";
import { createCSharpAnalysis, type CSharpAnalysis } from "../lang/csharp/index.js";
import { createRustAnalysis, type RustAnalysis } from "../lang/rust/index.js";
import { createPhpAnalysis, type PhpAnalysis } from "../lang/php/index.js";
import { expressPack } from "../frameworks/express.js";
import { fastifyPack } from "../frameworks/fastify.js";
import { nestPack } from "../frameworks/nest.js";
import { springPack } from "../frameworks/spring.js";
import { aspnetPack } from "../frameworks/aspnet.js";
import { axumPack } from "../frameworks/axum.js";
import { laravelPack } from "../frameworks/laravel.js";
import { fastapiPack } from "../frameworks/fastapi.js";
import { flaskPack } from "../frameworks/flask.js";
import { ginPack } from "../frameworks/gin.js";
import { chiPack } from "../frameworks/chi.js";
import { honoPack } from "../frameworks/hono.js";
import { koaPack } from "../frameworks/koa.js";
import { nextjsPack } from "../frameworks/nextjs.js";
import { elysiaPack } from "../frameworks/elysia.js";
import { drfPack } from "../frameworks/djangorestframework.js";
import { starlettePack } from "../frameworks/starlette.js";
import { nethttpPack } from "../frameworks/nethttp.js";
import { gorillamuxPack } from "../frameworks/gorillamux.js";
import { echoPack } from "../frameworks/echo.js";
import { fiberPack } from "../frameworks/fiber.js";
import { jaxrsPack } from "../frameworks/jaxrs.js";
import { micronautPack } from "../frameworks/micronaut.js";
import { actixPack } from "../frameworks/actix.js";
import { rocketPack } from "../frameworks/rocket.js";
import { fastendpointsPack } from "../frameworks/fastendpoints.js";
import { symfonyPack } from "../frameworks/symfony.js";
import { slimPack } from "../frameworks/slim.js";
import type { GapResolver } from "../ai/gapResolver.js";

interface LanguageRegistryEntry {
  pack: LanguagePack;
  frameworks: FrameworkPack[];
}

const REGISTRY: LanguageRegistryEntry[] = [
  {
    pack: {
      id: "typescript",
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      analyze: (ctx) => createTsAnalysis(ctx),
    },
    frameworks: [
      expressPack as FrameworkPack,
      fastifyPack as FrameworkPack,
      nestPack as FrameworkPack,
      honoPack as FrameworkPack,
      koaPack as FrameworkPack,
      nextjsPack as FrameworkPack,
      elysiaPack as FrameworkPack,
    ],
  },
  {
    pack: {
      id: "python",
      extensions: [".py", ".pyi"],
      analyze: (ctx) => createPythonAnalysis(ctx),
    },
    frameworks: [
      fastapiPack as FrameworkPack,
      flaskPack as FrameworkPack,
      drfPack as FrameworkPack,
      starlettePack as FrameworkPack,
    ],
  },
  {
    pack: {
      id: "go",
      extensions: [".go"],
      analyze: (ctx) => createGoAnalysis(ctx),
    },
    frameworks: [
      ginPack as FrameworkPack,
      chiPack as FrameworkPack,
      nethttpPack as FrameworkPack,
      gorillamuxPack as FrameworkPack,
      echoPack as FrameworkPack,
      fiberPack as FrameworkPack,
    ],
  },
  {
    pack: {
      id: "java",
      extensions: [".java"],
      analyze: (ctx) => createJavaAnalysis(ctx),
    },
    frameworks: [
      springPack as FrameworkPack,
      jaxrsPack as FrameworkPack,
      micronautPack as FrameworkPack,
    ],
  },
  {
    pack: {
      id: "csharp",
      extensions: [".cs"],
      analyze: (ctx) => createCSharpAnalysis(ctx),
    },
    frameworks: [aspnetPack as FrameworkPack, fastendpointsPack as FrameworkPack],
  },
  {
    pack: {
      id: "rust",
      extensions: [".rs"],
      analyze: (ctx) => createRustAnalysis(ctx),
    },
    frameworks: [
      axumPack as FrameworkPack,
      actixPack as FrameworkPack,
      rocketPack as FrameworkPack,
    ],
  },
  {
    pack: {
      id: "php",
      extensions: [".php"],
      analyze: (ctx) => createPhpAnalysis(ctx),
    },
    frameworks: [
      laravelPack as FrameworkPack,
      symfonyPack as FrameworkPack,
      slimPack as FrameworkPack,
    ],
  },
];

function toOperation(candidate: RouteCandidate): DiscoveredOperation {
  return {
    method: candidate.method,
    path: candidate.fullPath ?? candidate.path,
    operationId: candidate.operationId,
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

/** Fill only unknown leaves. Model output cannot replace proven schema facts. */
function fillSchemaGaps(known: JsonSchema, proposed: JsonSchema): JsonSchema {
  if (Object.keys(known).length === 0) return structuredClone(proposed);
  const result = structuredClone(known);
  const kp = known.properties as Record<string, JsonSchema> | undefined;
  const pp = proposed.properties as Record<string, JsonSchema> | undefined;
  if (kp && pp) result.properties = Object.fromEntries(Object.entries(kp).map(([name, schema]) =>
    [name, pp[name] ? fillSchemaGaps(schema, pp[name]!) : schema]));
  if (known.items && proposed.items && typeof known.items === "object" && typeof proposed.items === "object"
      && !Array.isArray(known.items) && !Array.isArray(proposed.items)) {
    result.items = fillSchemaGaps(known.items as JsonSchema, proposed.items as JsonSchema);
  }
  return result;
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
      framework: candidate.framework ?? "unknown",
      language: candidate.language ?? "unknown",
    },
  });
  if (!resolution) return candidate;

  const next: RouteCandidate = {
    ...candidate,
    parameters: structuredClone(candidate.parameters),
    responses: structuredClone(candidate.responses),
    requestBody: candidate.requestBody ? structuredClone(candidate.requestBody) : undefined,
  };

  if (candidate.gaps.includes("query-unknown") && resolution.querySchema) {
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
  if (candidate.gaps.includes("header-unknown") && resolution.headerSchema) {
    for (const [name, schema] of Object.entries(
      resolution.headerSchema.properties ?? {},
    ) as Array<[string, JsonSchema]>) {
      if (!next.parameters.some((p) => p.in === "header" && p.name === name)) {
        next.parameters.push({
          name,
          in: "header",
          required:
            (resolution.headerSchema.required as string[] | undefined)?.includes(
              name,
            ) ?? false,
          schema,
          confidence: resolution.confidence,
        });
      }
    }
  }
  if (resolution.bodySchema && next.requestBody && candidate.gaps.includes("body-schema-unknown")) {
    const media = next.requestBody.content.find(m => m.mediaType === "application/json");
    if (media) media.schema = fillSchemaGaps(media.schema ?? {}, resolution.bodySchema);
  }
  if (resolution.bodySchema && !next.requestBody && candidate.gaps.some(g => g === "body-unknown" || g === "body-schema-unknown")) {
    next.requestBody = {
      required: true,
      confidence: resolution.confidence,
      content: [{ mediaType: "application/json", schema: resolution.bodySchema }],
    };
  }
  if (resolution.sseEvents?.length) {
    const stream = next.responses.find((response) =>
      response.content?.some((media) => media.mediaType === "text/event-stream"),
    );
    const media = stream?.content?.find(
      (item) => item.mediaType === "text/event-stream",
    );
    if (stream && media) {
      media.itemSchema =
        resolution.sseEvents.length === 1
          ? (resolution.sseEvents[0]!.dataSchema ?? {
              type: "object",
              properties: {
                event: { const: resolution.sseEvents[0]!.name },
              },
            })
          : {
              oneOf: resolution.sseEvents.map((event) => ({
                type: "object",
                properties: {
                  event: { const: event.name },
                  ...(event.dataSchema ? { data: event.dataSchema } : {}),
                },
                required: ["event"],
              })),
            };
      media.confidence = resolution.confidence;
    }
  }
  for (const [status, schema] of Object.entries(
    candidate.gaps.some(g => g === "response-unknown" || g === "response-schema-unknown") ? resolution.responseSchemas ?? {} : {},
  ) as Array<[string, JsonSchema]>) {
    const existing = next.responses.find((r) => r.statusCode === status);
    if (existing) {
      existing.content = existing.content ?? [];
      const media = existing.content.find((m) => m.mediaType === "application/json");
      if (media) media.schema = fillSchemaGaps(media.schema ?? {}, schema);
      else if (!media) existing.content.push({ mediaType: "application/json", schema });
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
    if (gap === "header-unknown" && resolution.headerSchema) return false;
    if (
      (gap === "body-schema-unknown" || gap === "body-unknown") &&
      resolution.bodySchema
    )
      return false;
    if (
      (gap === "response-schema-unknown" || gap === "response-unknown") &&
      resolution.responseSchemas
    )
      return false;
    if (gap === "sse-events-unknown" && resolution.sseEvents?.length) return false;
    return true;
  });

  // The completeness gate only downgrades confidence, so re-rank here once AI
  // evidence has closed gaps. AI enrichment remains distinguishable from
  // deterministic source extraction, regardless of model self-confidence.
  if (next.gaps.length === 0) {
    // Model self-reported confidence is not deterministic source evidence.
    next.confidence = resolution.confidence === "low" ? "low" : "medium";
  }

  ctx.onProgress?.("ai-gap", `${candidate.method} ${candidate.fullPath}`);
  return next;
}

function projectMeta(root: string): { title: string; version: string } {
  try {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string") {
        return {
          title: pkg.name,
          version: typeof pkg.version === "string" ? pkg.version : "1.0.0",
        };
      }
    }
  } catch {
    // Fall through to other ecosystems.
  }

  try {
    const pyproject = join(root, "pyproject.toml");
    if (existsSync(pyproject)) {
      const text = readFileSync(pyproject, "utf8");
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      if (name) return { title: name, version: version ?? "1.0.0" };
    }
  } catch {
    // Fall through to go.mod.
  }

  try {
    const goMod = join(root, "go.mod");
    if (existsSync(goMod)) {
      const text = readFileSync(goMod, "utf8");
      const moduleName = /^module\s+(\S+)/m.exec(text)?.[1];
      if (moduleName) return { title: moduleName.split("/").pop() ?? moduleName, version: "1.0.0" };
    }
  } catch {
    // Fall through to defaults.
  }

  return { title: "Scanned API", version: "1.0.0" };
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
    onProgress: options.onProgress,
    report: (message) => diagnostics.push(message),
  };

  const extractions: Array<{ result: ExtractionResult; language: string; framework: string }> = [];
  const activeLanguages: string[] = [];
  const candidateLanguages: string[] = [];
  let analyzedFiles: FileEntry[] = [];
  // Keep each language analysis so a monorepo-leaf fallback can re-run framework
  // packs with a leaf-scoped manifest when the root itself detects nothing.
  const languageAnalyses: Array<{ entry: (typeof REGISTRY)[number]; analysis: unknown }> = [];

  for (const entry of REGISTRY) {
    const extensionSet = new Set(entry.pack.extensions);
    const languageFiles = index.files.filter((file) =>
      extensionSet.has(extname(file.path)),
    );
    if (!languageFiles.length) continue;
    candidateLanguages.push(entry.pack.id);

    ctx.onProgress?.("analyze", `${entry.pack.id} (${languageFiles.length} files)`);
    let analysis;
    try {
      analysis = await entry.pack.analyze(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`language "${entry.pack.id}" analysis failed: ${message}`);
      continue;
    }
    if (!analysis) continue;
    activeLanguages.push(entry.pack.id);
    analyzedFiles = analyzedFiles.concat(languageFiles);
    languageAnalyses.push({ entry, analysis });

    for (const pack of entry.frameworks) {
      if (options.frameworks && !options.frameworks.includes(pack.id)) continue;
      if (!pack.applies(ctx)) continue;
      ctx.onProgress?.("extract", pack.id);
      try {
        const result = await pack.extract(analysis, ctx);
        for (const route of result.routes) {
          route.language = pack.language;
          route.framework = pack.id;
        }
        if (!result.routes.length) {
          result.unresolved.push({
            reason: "handler-unresolved",
            message: `Detected ${pack.id} but extracted no routes. Dynamic registration, autoloading or generated sources may require additional analysis.`,
            origin: { file: "" },
          });
        }
        extractions.push({ result, language: pack.language, framework: pack.id });
      } catch (error) {
        // One broken framework pack must never erase results from the others.
        const message = error instanceof Error ? error.message : String(error);
        ctx.report?.(`framework pack "${pack.id}" failed: ${message}`);
      }
    }
  }

  if (!activeLanguages.length) {
    // Source files existed but every language analyzer failed: surface the
    // underlying failures instead of a misleading "no files" message.
    if (candidateLanguages.length && diagnostics.length) {
      throw new Error(
        `Source files were found for ${candidateLanguages.join(", ")} but analysis failed: ${diagnostics.join("; ")}`,
      );
    }
    throw new Error(
      "No supported source files found. Supported languages: TypeScript/JavaScript, Python, Go, Java, C#, Rust, PHP.",
    );
  }
  if (!extractions.length) {
    // Root scan detected no supported framework. For monorepos the real server
    // package often lives one level down (packages/*, apps/*, ...); try those
    // leaves before giving up. This branch only runs on root-miss, so any
    // project whose root already resolves a framework is byte-identical.
    const leafExtractions = await scanMonorepoLeaves({
      root,
      ctx,
      languageAnalyses,
      options,
      diagnostics,
    });
    if (leafExtractions.found) {
      extractions.push(...leafExtractions.extractions);
      if (leafExtractions.extractions.length) {
        diagnostics.push(
          `No framework detected at the root; aggregated routes from workspace package(s).`,
        );
      } else {
        diagnostics.push(
          `Monorepo detected (${leafExtractions.leafCount} workspace package(s)) but none use a supported HTTP framework; producing an empty document.`,
        );
      }
    } else {
      throw new Error(
        "No supported HTTP framework detected. Supported packs: Express, Fastify, NestJS, Hono, Koa, Next.js, Elysia, FastAPI, Flask, Django REST Framework, Starlette, Gin, Chi, net/http, gorilla/mux, Echo, Fiber, Spring Boot, JAX-RS (Jersey/Quarkus/Dropwizard), Micronaut, ASP.NET Core, FastEndpoints, Axum, actix-web, Rocket, Laravel, Symfony, Slim.",
      );
    }
  }

  let candidates = extractions.flatMap((entry) => entry.result.routes).map(candidate =>
    applyCompletenessGate({ ...candidate, fullPath: candidate.fullPath ?? candidate.path }));
  if (options.gapResolver) {
    // Bound model traffic and preserve static results when a single request fails.
    const enriched: RouteCandidate[] = [];
    for (let i = 0; i < candidates.length; i += 4) {
      enriched.push(...await Promise.all(candidates.slice(i, i + 4).map(async candidate => {
        try { return await applyAiGaps(candidate, options.gapResolver!, ctx); }
        catch (error) {
          diagnostics.push(`AI gap resolution failed for ${candidate.method} ${candidate.fullPath ?? candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
          return candidate;
        }
      })));
    }
    candidates = enriched;
  }
  candidates = candidates.map((candidate) =>
    applyCompletenessGate({ ...candidate, fullPath: candidate.fullPath ?? candidate.path }),
  );

  const operations = candidates.map(toOperation);

  const componentsByName = new Map<string, JsonSchema>();
  for (const extraction of extractions) {
    for (const component of extraction.result.components) {
      const existing = componentsByName.get(component.name);
      if (!existing) componentsByName.set(component.name, component.schema);
    }
  }
  // Fastify-style native JSON schemas carry draft-07 `definitions`/`$defs`;
  // hoist them into components.schemas so every local $ref resolves in OAS 3.x.
  const hoistedComponents = hoistLocalSchemaDefinitions(
    operations as DiscoveredOperation[],
    [...componentsByName.entries()].map(([name, schema]) => ({ name, schema })),
  );
  const components = hoistedComponents;

  const securitySchemes = extractions.flatMap((entry) => entry.result.securitySchemes);
  const servers = extractions.flatMap((entry) => entry.result.servers);
  const unresolved = extractions.flatMap((entry) => entry.result.unresolved);

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

  const frameworks = [...new Set(extractions.map((entry) => entry.framework))];
  const report: ScanReport = {
    languages: activeLanguages,
    frameworks,
    filesScanned: analyzedFiles.length,
    routesConfirmed: operations.filter((o) => o.confidence === "high").length,
    routesPartial: operations.filter((o) => o.confidence !== "high").length,
    unresolved: unresolved.length,
    gaps: operations
      .filter((o) => o.gaps?.length)
      .map((o) => ({ route: `${o.method} ${o.path}`, gaps: [...(o.gaps ?? [])] })),
    diagnostics,
  };

  return {
    project,
    report,
    files: index.files,
    sidecar: buildSidecar({
      files: index.files,
      operations,
      components: project.components,
      language: activeLanguages.join("+"),
      framework: frameworks.join("+") || undefined,
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

// Top-level directories that conventionally hold workspace packages, plus the
// single-package server roots. Only one level is ever walked.
const LEAF_PARENT_DIRS = ["packages", "apps", "services", "packages"];
const LEAF_SINGLE_DIRS = ["server", "api", "app", "src"];
const LEAF_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  "coverage",
  ".turbo",
]);
const MAX_MONOREPO_LEAVES = 40;

/**
 * Cheaply reads workspace globs from package.json `workspaces` and
 * pnpm-workspace.yaml `packages:`. Returns directory globs (e.g. "packages/*").
 */
function readWorkspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    const list = Array.isArray(ws) ? ws : ws?.packages;
    if (Array.isArray(list)) globs.push(...list);
  } catch {
    // No root package.json or no workspaces field.
  }
  try {
    const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const inPackages = /^packages\s*:/m.test(yaml);
    if (inPackages) {
      for (const line of yaml.split(/\r?\n/)) {
        const m = /^\s*-\s*['"]?([\w.-/]+)['"]?\s*$/.exec(line);
        if (m) globs.push(m[1]!);
      }
    }
  } catch {
    // No pnpm-workspace.yaml.
  }
  return globs;
}

/**
 * Discovers candidate server package directories exactly one level below the
 * root. Honors workspace globs and the common layout names; never recurses.
 */
function discoverMonorepoLeaves(root: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const addIfPackage = (absDir: string): void => {
    if (seen.has(absDir)) return;
    seen.add(absDir);
    if (existsSync(join(absDir, "package.json"))) found.push(absDir);
  };

  // Workspace globs: "packages/*", "packages/*/server", etc. Expand a single
  // trailing segment; deeper globs are flattened to their parent's children.
  for (const glob of readWorkspaceGlobs(root)) {
    const cleaned = glob.replace(/\/+$/, "");
    if (!cleaned || cleaned.startsWith("!")) continue;
    const parent = cleaned.includes("*") ? cleaned.slice(0, cleaned.lastIndexOf("/") + 1).replace(/\*$/, "") : cleaned;
    const absParent = join(root, parent);
    let entries;
    try {
      entries = readdirSync(absParent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || LEAF_SKIP_DIRS.has(e.name)) continue;
      addIfPackage(join(absParent, e.name));
    }
  }

  for (const parent of LEAF_PARENT_DIRS) {
    const absParent = join(root, parent);
    let entries;
    try {
      entries = readdirSync(absParent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || LEAF_SKIP_DIRS.has(e.name)) continue;
      addIfPackage(join(absParent, e.name));
    }
  }

  for (const single of LEAF_SINGLE_DIRS) {
    addIfPackage(join(root, single));
  }

  return found.slice(0, MAX_MONOREPO_LEAVES);
}

/** Reads one leaf package.json and merges its dependencies into a manifest. */
function leafManifest(root: string, leafAbs: string): DependencyManifest {
  const packages = new Map<string, string>();
  try {
    const json = JSON.parse(readFileSync(join(leafAbs, "package.json"), "utf8")) as Record<string, unknown>;
    for (const bucket of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const table = json[bucket];
      if (table && typeof table === "object") {
        for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
          if (typeof version === "string" && !packages.has(name)) packages.set(name, version);
        }
      }
    }
  } catch {
    // Unreadable leaf manifest: treated as empty.
  }
  return { packages, packageJsonPath: join(leafAbs, "package.json").slice(root.length + 1) };
}

interface LeafScanResult {
  found: boolean;
  leafCount: number;
  extractions: Array<{ result: ExtractionResult; language: string; framework: string }>;
}

/**
 * Root-miss fallback: scan one level of workspace packages and aggregate any
 * routes they expose. Activates only when the root produced no extraction.
 */
async function scanMonorepoLeaves(args: {
  root: string;
  ctx: ScanContext;
  languageAnalyses: Array<{ entry: (typeof REGISTRY)[number]; analysis: unknown }>;
  options: ScanOptions;
  diagnostics: string[];
}): Promise<LeafScanResult> {
  const { root, ctx, languageAnalyses, options, diagnostics } = args;
  const leaves = discoverMonorepoLeaves(root);
  if (!leaves.length) return { found: false, leafCount: 0, extractions: [] };

  const extractions: LeafScanResult["extractions"] = [];
  const seenOps = new Set<string>();
  for (const leafAbs of leaves) {
    const manifest = leafManifest(root, leafAbs);
    const leafCtx: ScanContext = { ...ctx, manifest };
    for (const { entry, analysis } of languageAnalyses) {
      for (const pack of entry.frameworks) {
        if (options.frameworks && !options.frameworks.includes(pack.id)) continue;
        if (!pack.applies(leafCtx)) continue;
        ctx.onProgress?.("extract", `leaf ${pack.id}`);
        try {
          const result = await pack.extract(analysis, leafCtx);
          // Dedupe identical operations across leaves; keep the first richer one.
          result.routes = result.routes.filter((route) => {
            const key = `${route.method} ${route.fullPath ?? route.path}`;
            if (seenOps.has(key)) return false;
            seenOps.add(key);
            return true;
          });
          for (const route of result.routes) {
            route.language = pack.language;
            route.framework = pack.id;
          }
          extractions.push({ result, language: pack.language, framework: pack.id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push(`monorepo leaf pack "${pack.id}" failed: ${message}`);
        }
      }
    }
  }
  return { found: true, leafCount: leaves.length, extractions };
}
