import { fillSchemaGaps } from "../ai/schemaMerge.js";
import { createSourceContextBuilder } from "../ai/sourceContext.js";
import ignoreFactory from "ignore";
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { extname, join, resolve, relative, isAbsolute } from "node:path";

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
  DiscoveredComponent,
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
import type { ComponentCatalogEntry } from "../ai/gapResolver.js";
import { buildGapReview } from "../ai/review.js";
import { stripPrototypeHazards } from "./sanitizeSchemas.js";
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

/**
 * Compact catalog of deterministically extracted components, embedded in the
 * per-route AI prompt so the model can reference an existing model by $ref
 * instead of re-describing (or fabricating) a schema.
 */
function buildComponentCatalog(
  components: ReadonlyMap<string, JsonSchema>,
): ComponentCatalogEntry[] {
  const catalog: ComponentCatalogEntry[] = [];
  for (const [name, schema] of components) {
    const rawProperties =
      schema && typeof schema === "object" && !Array.isArray(schema)
        ? Object.keys(
            (schema as { properties?: Record<string, unknown> }).properties ?? {},
          )
        : [];
    // Drop prototype-pollution keys and class constructor noise.
    const properties = rawProperties
      .filter(
        (key) => key !== "constructor" && key !== "__proto__" && key !== "prototype",
      )
      .slice(0, 40);
    catalog.push({
      name,
      schema,
      ...(properties.length ? { properties } : {}),
    });
  }
  return catalog;
}


interface AiGapOutcome {
  candidate: RouteCandidate;
  /** Number of gap codes actually closed by the model response. */
  gapsClosed: number;
  /** "filled" closes every gap, "partial" some, "empty" none, "failed" errored. */
  status: "filled" | "partial" | "empty" | "failed";
}

async function applyAiGaps(
  candidate: RouteCandidate,
  resolver: GapResolver,
  components: ReadonlyMap<string, JsonSchema>,
  componentCatalog: ComponentCatalogEntry[],
  sourceContext?: import("../ai/gapResolver.js").GapRequest["sourceContext"],
): Promise<AiGapOutcome> {
  if (!candidate.gaps.length || !candidate.handlerSource) {
    return { candidate, gapsClosed: 0, status: "empty" };
  }

  const gapsBefore = candidate.gaps.length;
  const resolution = await resolver.resolve({
    route: { method: candidate.method, path: candidate.fullPath ?? candidate.path },
    origin: candidate.origin,
    gaps: candidate.gaps,
    handlerSource: candidate.handlerSource,
    contract: { parameters: candidate.parameters, requestBody: candidate.requestBody, responses: candidate.responses },
    sourceContext,
    known: {
      pathParameters: candidate.parameters
        .filter((p) => p.in === "path")
        .map((p) => p.name),
      framework: candidate.framework ?? "unknown",
      language: candidate.language ?? "unknown",
    },
    componentCatalog,
  });
  if (!resolution) return { candidate, gapsClosed: 0, status: "empty" };

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
    if (media) media.schema = fillSchemaGaps(media.schema ?? {}, resolution.bodySchema, components);
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
  let responseUpdated = false;
  for (const [status, schema] of Object.entries(
    candidate.gaps.some(g => g === "response-unknown" || g === "response-schema-unknown") ? resolution.responseSchemas ?? {} : {},
  ) as Array<[string, JsonSchema]>) {
    if (/^(1\d\d|204|205|304)$/.test(status)) continue;
    const existing = next.responses.find((r) => r.statusCode === status);
    if (existing) {
      if (!existing.content?.length || /^(1\d\d|204|205|304)$/.test(status)) continue;
      const media = existing.content.find((m) => m.mediaType === "application/json");
      if (media) {
        const updated = fillSchemaGaps(media.schema ?? {}, schema, components);
        responseUpdated ||= JSON.stringify(updated) !== JSON.stringify(media.schema);
        media.schema = updated;
      }
      // A JSON-only proposal cannot alter a proven non-JSON representation.
    } else {
      responseUpdated = true;
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
      responseUpdated
    )
      return false;
    if (gap === "sse-events-unknown" && resolution.sseEvents?.length) return false;
    return true;
  });

  // Re-run the same honesty gate the deterministic pipeline uses. A model
  // response carrying an empty object schema must not count as a closed gap:
  // the reported status and statistics reflect what survives the gate, not
  // what the model merely claimed.
  const gated = applyCompletenessGate(
    { ...next, fullPath: next.fullPath ?? candidate.fullPath ?? candidate.path },
    components,
  );

  // The completeness gate only downgrades confidence, so re-rank here once AI
  // evidence has closed gaps. AI enrichment remains distinguishable from
  // deterministic source extraction, regardless of model self-confidence.
  if (gated.gaps.length === 0) {
    // Model self-reported confidence is not deterministic source evidence.
    gated.confidence = resolution.confidence === "low" ? "low" : "medium";
  }

  const gapsClosed = Math.max(0, gapsBefore - gated.gaps.length);
  return {
    candidate: gated,
    gapsClosed,
    status:
      gapsClosed === 0 ? "empty" : gapsClosed === gapsBefore ? "filled" : "partial",
  };
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
  const root = realpathSync(resolve(options.root));
  const index: FileIndex = { files: [], byPath: new Map() };
  const indexed = indexProject(root, {
    ignore: options.ignore,
    includeTests: options.includeTests,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
  });
  let indexedBytes = indexed.files.reduce((sum,file)=>sum+file.bytes,0);
  const explicitIgnore = (ignoreFactory as unknown as () => { add(value: string | string[]): unknown; ignores(path: string): boolean })();
  if (options.ignore) explicitIgnore.add([...options.ignore]);
  const powerduckIgnore = join(root, ".powerduckignore");
  if (existsSync(powerduckIgnore)) explicitIgnore.add(readFileSync(powerduckIgnore, "utf8"));
  for (const sourceRoot of options.additionalSourceRoots ?? []) {
    const absolute = realpathSync(resolve(root, sourceRoot));
    const local = relative(root, absolute).split("\\").join("/");
    if (!local || local === ".." || local.startsWith("../") || isAbsolute(local)) {
      throw new Error(`Additional source root must be a subdirectory of the project: ${sourceRoot}`);
    }
    if (!statSync(absolute).isDirectory()) throw new Error(`Additional source root is not a directory: ${sourceRoot}`);
    const extra = indexProject(absolute, { includeTests: options.includeTests, maxFileBytes: options.maxFileBytes, maxFiles: options.maxFiles, maxTotalBytes: options.maxTotalBytes });
    for (const issue of extra.unresolved ?? []) {
      const path = relative(root, resolve(absolute, issue.origin?.file ?? ".")).split("\\").join("/");
      if (!explicitIgnore.ignores(path)) (indexed.unresolved ??= []).push({...issue, origin:{...issue.origin, file:path}});
    }
    for (const file of extra.files) {
      const path = relative(root, file.absolutePath).split("\\").join("/");
      if (!explicitIgnore.ignores(path) && !indexed.byPath.has(path)) {
        if (indexed.files.length >= (options.maxFiles ?? 10_000)) throw new Error("Source file limit exceeded across additional source roots");
        if (indexedBytes + file.bytes > (options.maxTotalBytes ?? 64 * 1024 * 1024)) throw new Error("Source byte limit exceeded across additional source roots");
        indexedBytes += file.bytes;
        const entry = { ...file, path };
        indexed.files.push(entry);
        indexed.byPath.set(path, entry);
      }
    }
  }
  indexed.files.sort((a, b) => a.path.localeCompare(b.path));
  index.files = indexed.files;
  index.byPath = indexed.byPath;
  index.unresolved = indexed.unresolved;

  const manifest = probeManifest(root, index);
  const diagnostics: string[] = (index.unresolved ?? []).map(issue => `${issue.origin?.file}: ${issue.message}`);
  const ctx: ScanContext = {
    root,
    index,
    manifest,
    onProgress: options.onProgress,
    report: (message) => diagnostics.push(message),
  };

  const scanFailures: NonNullable<FileIndex["unresolved"]> = [];
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
      scanFailures.push({reason:"analysis-failed",message:`${entry.pack.id} source analysis failed; scan coverage is incomplete`,origin:{file:"."}});
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
        // Real extraction batches, without source text or schema payloads.
        for (let i = 0; i < result.routes.length; i += 40) ctx.onProgress?.("routes-discovered", JSON.stringify({ framework: pack.id, routes: result.routes.slice(i, i + 40).map(route => ({ method: route.method, path: route.fullPath ?? route.path })) }));
        extractions.push({ result, language: pack.language, framework: pack.id });
      } catch (error) {
        // One broken framework pack must never erase results from the others.
        const message = error instanceof Error ? error.message : String(error);
        ctx.report?.(`framework pack "${pack.id}" failed: ${message}`);
        scanFailures.push({reason:"extraction-failed",message:`${pack.id} route extraction failed; scan coverage is incomplete`,origin:{file:"."}});
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
    if (index.unresolved?.length) {
      throw new Error(`No scannable source files remain: ${diagnostics.join("; ")}`);
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
      scanFailures,
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

  const baseComponents: DiscoveredComponent[] = [];
  for (const extraction of extractions) {
    for (const component of extraction.result.components) {
      if (!baseComponents.some((item) => item.name === component.name)) {
        baseComponents.push(component);
      }
    }
  }

  let candidates: RouteCandidate[] = extractions.flatMap(
    (entry) => entry.result.routes,
  ).map(
    (candidate) => ({ ...candidate, fullPath: candidate.fullPath ?? candidate.path }),
  );

  // Hoist Fastify-style local definition tables BEFORE the completeness gate:
  // operation schemas reference the hoisted names from the start, so the gate
  // never reports a schema as unknown just because its component is still
  // living inside a local definitions/$defs table.
  const hoistedBeforeGate = hoistLocalSchemaDefinitions(
    candidates as unknown as DiscoveredOperation[],
    baseComponents,
  );
  const componentsByName = new Map<string, JsonSchema>(
    hoistedBeforeGate.map((component) => [component.name, component.schema]),
  );

  candidates = candidates.map((candidate) =>
    applyCompletenessGate(
      { ...candidate, fullPath: candidate.fullPath ?? candidate.path },
      componentsByName,
    ));

  // AI enrichment statistics surfaced in the scan report. Model evidence is
  // never treated as deterministic source truth, so the host UI can show
  // exactly which routes were completed by the model.
  let aiAttempted = 0;
  let aiResolved = 0;
  const aiResolvedRoutes: ScanReport["aiResolvedRoutes"] = [];
  const componentCatalog = buildComponentCatalog(componentsByName);
  const sourceContext = createSourceContextBuilder(index,
    languageAnalyses.find(item => item.entry.pack.id === "php")?.analysis as import("../lang/php/index.js").PhpAnalysis | undefined,
    languageAnalyses.find(item => item.entry.pack.id === "typescript")?.analysis as import("../lang/typescript/index.js").TsAnalysis | undefined,
    {
      python: languageAnalyses.find(item => item.entry.pack.id === "python")?.analysis as import("../lang/python/index.js").PythonAnalysis | undefined,
      go: languageAnalyses.find(item => item.entry.pack.id === "go")?.analysis as import("../lang/go/index.js").GoAnalysis | undefined,
      java: languageAnalyses.find(item => item.entry.pack.id === "java")?.analysis as import("../lang/java/index.js").JavaAnalysis | undefined,
      csharp: languageAnalyses.find(item => item.entry.pack.id === "csharp")?.analysis as import("../lang/csharp/index.js").CSharpAnalysis | undefined,
      rust: languageAnalyses.find(item => item.entry.pack.id === "rust")?.analysis as import("../lang/rust/index.js").RustAnalysis | undefined,
    });
  let gapReviews: import("../ai/review.js").GapReview[] | undefined;
  const reviewMode = options.aiReview ?? (options.gapResolver ? "auto" : "manual");
  if (reviewMode === "manual") {
    // Surface unresolved handlers for interactive review without calling a
    // model; the host proposes and the user accepts/edits/rejects each one.
    gapReviews = candidates
      .map((candidate) => buildGapReview(candidate, componentCatalog, options.reviewAll, candidate.handlerSource && (candidate.gaps.length || options.reviewAll) ? sourceContext(candidate) : undefined))
      .filter((review): review is import("../ai/review.js").GapReview => review !== null);
    ctx.onProgress?.("ai-review-pending", JSON.stringify({ total: gapReviews.length }));
  } else if (options.gapResolver) {
    const targets = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.gaps.length > 0 && Boolean(candidate.handlerSource));
    ctx.onProgress?.("ai-start", JSON.stringify({ total: targets.length }));
    // Bound model traffic with small batches; hosts typically serialize the
    // resolver calls themselves to respect provider rate limits.
    for (let batchStart = 0; batchStart < targets.length; batchStart += 4) {
      const batch = targets.slice(batchStart, batchStart + 4);
      const outcomes = await Promise.all(
        batch.map(async ({ candidate, index }) => {
          aiAttempted += 1;
          const routeLabel = `${candidate.method} ${candidate.fullPath ?? candidate.path}`;
          let outcome: AiGapOutcome;
          try {
            outcome = await applyAiGaps(candidate, options.gapResolver!, componentsByName, componentCatalog, sourceContext(candidate));
          } catch (error) {
            diagnostics.push(
              `AI gap resolution failed for ${routeLabel}: ${error instanceof Error ? error.message : String(error)}`,
            );
            outcome = { candidate, gapsClosed: 0, status: "failed" };
          }
          if (outcome.gapsClosed > 0) {
            aiResolved += 1;
            aiResolvedRoutes.push({
              method: candidate.method,
              path: candidate.fullPath ?? candidate.path,
              gapsClosed: outcome.gapsClosed,
            });
          }
          ctx.onProgress?.(
            "ai-gap",
            JSON.stringify({
              index: index + 1,
              total: targets.length,
              method: candidate.method,
              path: candidate.fullPath ?? candidate.path,
              status: outcome.status,
              gapsClosed: outcome.gapsClosed,
            }),
          );
          return { index, candidate: outcome.candidate };
        }),
      );
      for (const { index, candidate } of outcomes) {
        candidates[index] = {
          ...candidate,
          fullPath: candidate.fullPath ?? candidate.path,
        };
      }
    }
  }
  candidates = candidates.map((candidate) =>
    applyCompletenessGate({ ...candidate, fullPath: candidate.fullPath ?? candidate.path }, componentsByName),
  );

  const operations = candidates.map(toOperation).map(stripPrototypeHazards);

  // Fastify-style native JSON schemas carry draft-07 `definitions`/`$defs`;
  // hoist them into components.schemas so every local $ref resolves in OAS 3.x.
  const hoistedComponents = hoistLocalSchemaDefinitions(
    operations as DiscoveredOperation[],
    [...componentsByName.entries()].map(([name, schema]) => ({
      name,
      schema: stripPrototypeHazards(schema) as JsonSchema,
    })),
  );
  const components = hoistedComponents;

  const securitySchemes = extractions.flatMap((entry) => entry.result.securitySchemes);
  const servers = extractions.flatMap((entry) => entry.result.servers);
  const unresolved = [...(index.unresolved ?? []), ...scanFailures, ...extractions.flatMap((entry) => entry.result.unresolved)];

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
    aiAttempted,
    aiResolved,
    aiResolvedRoutes,
    ...(gapReviews?.length ? { aiPending: gapReviews.length } : {}),
    diagnostics,
  };

  return {
    project,
    report,
    files: index.files,
    ...(gapReviews?.length ? { gapReviews } : {}),
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

/**
 * Converts a (possibly user-reviewed, AI-decorated) discovered project back
 * into a validated OpenAPI 3.2 document. Hosts use this after applying manual
 * AI gap decisions to the operations returned by a manual-review scan.
 */
export async function convertProject(
  project: DiscoveredProject,
): Promise<DiscoveryResult> {
  return discoveryToOpenApi(project, { validate: true });
}

const PROTOTYPE_HAZARD_KEYS = new Set(["constructor", "__proto__", "prototype"]);

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
  scanFailures: NonNullable<FileIndex["unresolved"]>;
}): Promise<LeafScanResult> {
  const { root, ctx, languageAnalyses, options, diagnostics, scanFailures } = args;
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
          // Real extraction batches, without source text or schema payloads.
        for (let i = 0; i < result.routes.length; i += 40) ctx.onProgress?.("routes-discovered", JSON.stringify({ framework: pack.id, routes: result.routes.slice(i, i + 40).map(route => ({ method: route.method, path: route.fullPath ?? route.path })) }));
        extractions.push({ result, language: pack.language, framework: pack.id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.push(`monorepo leaf pack "${pack.id}" failed: ${message}`);
          scanFailures.push({reason:"extraction-failed",message:`${pack.id} workspace route extraction failed; scan coverage is incomplete`,origin:{file:relative(root,leafAbs).split("\\").join("/")}});
        }
      }
    }
  }
  return { found: true, leafCount: leaves.length, extractions };
}
