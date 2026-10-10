# @powerduck/code-to-openapi

[![npm version](https://img.shields.io/npm/v/@powerduck/code-to-openapi)](https://www.npmjs.com/package/@powerduck/code-to-openapi)
[![license](https://img.shields.io/npm/l/@powerduck/code-to-openapi)](https://github.com/powerducklab/code-to-openapi/blob/main/LICENSE)

Scan a local backend codebase and reverse-engineer a validated **OpenAPI 3.2**
document. Extraction is deterministic by default: routes are proven through
framework instance tracing and AST analysis, never guessed. An optional AI gap
resolver fills only the specific pieces the static engine could not prove.

Part of the [Powerduck](https://www.powerduck.com/) toolchain — one local
OpenAPI spec for design, debug, test, mock, documentation and MCP serving.

---

## How it works

```
indexer  →  language packs (AST + type checker)
         →  framework packs (route graphs, handlers)
         →  completeness gate (proven / proven-empty / gap)
         →  Discovery IR  →  validated OpenAPI 3.2
```

- **Language-neutral core.** File indexing, route signature matching, a common
  type model, handler exit tracing and the completeness gate are shared.
  Language and framework packs only add evidence.
- **Framework instance tracing.** The engine follows `import`/`export` graphs
  to prove that a call target is the real `express()` app or `express.Router()`
  instance. Lookalikes such as `cache.get(...)` are never mistaken for routes,
  and routers that are never mounted are reported as unreachable instead of
  emitted.
- **Type-first schemas.** In TypeScript projects the compiler checker resolves
  generics (`Response<User[]>`, `Request<Params, ResBody, ReqBody, Query>`),
  named interfaces, enums, utility types (`Partial`/`Pick`/`Omit`) and Zod
  schemas. Named declarations become `components.schemas` with `$ref`s;
  anonymous shapes stay inline.
- **Completeness is a hard gate.** Every parameter, request body and response
  is one of: proven with evidence, proven absent, or an explicit **gap**. A
  route is never emitted as a bare URL with empty contracts.
- **AI only fills gaps.** The host may supply a resolver. It receives small
  per-handler slices for specific gap codes; it can never invent a route,
  method or path. Source code is never sent anywhere by default.
- **Incremental by design.** A `.powerduck/discovery.json` sidecar fingerprints
  files and routes so rescans diff added/changed/removed routes; user edits to
  the generated document are preserved by the host through JSON Patch.

### Framework support

| Language   | Framework | Status |
| ---------- | --------- | ------ |
| TypeScript / JavaScript | Express, Fastify, NestJS, Hono (Workers/Bun/Deno), Koa, Next.js route handlers, Elysia (Bun) | 0.9.x |
| Python     | FastAPI, Flask (Flask-RESTful resources), Django REST Framework, Starlette, SQLModel | 0.9.x |
| Go         | Gin, Chi (go-chi/render), net/http ServeMux, gorilla/mux, Echo, Fiber | 0.9.x |
| Java       | Spring Boot, JAX-RS (Jersey/Quarkus/Dropwizard), Micronaut | 0.9.x |
| C#         | ASP.NET Core (controllers + minimal API), FastEndpoints | 0.9.x |
| Rust       | Axum, actix-web, Rocket | 0.9.x |
| PHP        | Laravel, Symfony, Slim | 0.9.x |

HTTP route extraction follows the support matrix above; recognized SSE endpoints are emitted with the canonical
`x-protocol: "sse"` extension and a `text/event-stream` media type carrying
`itemSchema` (including named Spring `SseEmitter` events when the event name
and payload type are statically provable).

#### 0.9.2 contract-first hardening

No new packs; this release hardens TypeScript/Bun and Go extraction against
real open-source backends (RealWorld family and others), always preferring
declared framework contracts over handler inference:

- **Elysia**: third-argument route options (`body`, `query`, `params`,
  `headers`, `response`) are now extracted, including chained verbs on
  `new Elysia()`, nested `.group()` prefixes (with `:param` normalization),
  bare and status-mapped responses, and `return status(201, body)`. Schema
  DTOs resolve across barrels and `tsconfig` path aliases, with converters
  for ArkType (`type()`, domains, bounds, `.get().partial().array()`,
  `Record<...>`), TypeBox (`t.Object/Optional/Nullable/Union/...`) and Zod.
- **Hono**: `@hono/zod-openapi` `createRoute` contracts resolve cross-file
  bodies/params/responses (including computed `[StatusCodes.OK]` keys),
  `OpenAPIHono` instances and advanced Zod chains (`.merge/.shape/.partial/
  .omit/.regex/.openapi`).
- **Fastify**: `@fastify/autoload` directory plugins (including CommonJS),
  `fluent-json-schema` chain schemas, and draft-07 `definitions`/`$defs`
  hoisted into OAS 3.x `components.schemas`.
- **Next.js App Router**: request bodies are inferred from the
  `schema.parse(await req.json())` Zod idiom, and
  `new Response(JSON.stringify(payload))` follows the serialized payload.
- **Go**: Echo handlers that bind through local helper methods
  (`req.bind(c, &u)`), split-statement `json.NewDecoder` / `json.Unmarshal`
  bodies in net/http, gorilla/mux and chi, and `new(T)` payload values.
- Declared response DTOs now authoritatively replace partial handler
  inference for the same status/media type.

#### 0.9.1 robustness and real-project hardening

No new packs; this release hardens extraction against real-world code found while
validating the 28 packs against public backends (see
[`docs/real-project-verification.md`](docs/real-project-verification.md)):

- **Express**: no longer crashes on `app.listen()` called with no arguments
  (seen in the Nest monorepo); the listen call is now guarded.
- **Gin**: relative route patterns accepted by Go (`router.GET("favicon.ico", ...)`)
  are normalized to a leading-slash OpenAPI path so the emitted document stays
  schema-valid.
- The previously flaky AI-gap integration test now runs with an explicit, larger
  timeout; the suite is reliably green (262 tests).

#### 0.9.0 framework expansion

Seventeen new framework packs were added and validated against real
open-source projects, all sharing the same confidence scoring, component
reuse and honest-gap machinery:

- **TypeScript/JavaScript**: Hono (including Cloudflare Workers/Bun/Deno and
  `@hono/zod-openapi` route definitions), Koa with `koa-router`/`@koa/router`
  (ESM and CommonJS), Next.js file-based routes (App Router `route.ts`
  handlers and Pages Router `pages/api`), and Elysia (Bun).
- **Python**: Django REST Framework (function and class-based views,
  ViewSets with routers and `@action`, Serializer schemas) and Starlette
  (`Route`/`WebSocketRoute` registration).
- **Go**: standard library `net/http` ServeMux (Go 1.22 method patterns),
  gorilla/mux, Echo and Fiber.
- **JVM**: one shared JAX-RS pack covering Jersey, Quarkus RESTEasy Reactive
  and Dropwizard (both `jakarta.ws.rs` and legacy `javax.ws.rs`), plus
  Micronaut.
- **Rust/.NET**: actix-web and Rocket macro routing; top-level ASP.NET
  Minimal API (`MapGroup`, `TypedResults`) and FastEndpoints.
- **PHP**: Symfony (`#[Route]` attributes, `MapRequestPayload`) and Slim.

#### 0.8.0 real-world hardening

The inference engine was validated against dozens of real, complex open-source
backends (Koel, Bagisto, Snipe-IT, apipost-server, eladmin, novel-plus,
Redash, Apache Superset, CleanArchitecture, hackathon-starter, the RealWorld
family, go-chi/gin examples, Platformatic and others). Highlights:

- **CommonJS Express** apps are traced like ESM: `require('express')`,
  mounted sub-routers, middleware arrays, `module.exports` controller objects,
  chained `Router().use()` composition and `res.render`/`res.redirect`.
- **Monorepo leaf discovery**: a root with no server framework probes one
  level of `packages/*`, `apps/*`, `services/*` and workspace globs, then
  aggregates supported leaves into one document.
- **Go**: `render.Render` / `render.RenderList` follow constructor return
  structs; Gin `c.JSON` follows constructors and service calls; receiver
  method handlers and qualified registration helpers resolve.
- **Spring**: handlers returning `service.method()` follow the bean
  implementation through generics and `ResponseEntity` / `Page` envelopes;
  named SSE events extract their payload DTOs.
- **Laravel**: array-callable and `Route::controller()->group()` handlers,
  API Resources/transformers/static helpers, `JsonResponse`, `view()` HTML,
  Facade chains and binary downloads (`application/octet-stream`).
- **Python/.NET**: SQLModel models, FastAPI `Annotated[..., Depends]`
  aliases and `Path(alias=...)`, Flask-RESTful `add_resource`, and ASP.NET
  minimal-API `MapGet/MapPost` groups.
- Path parameters default to the OpenAPI string segment type; duplicate
  operationIds are qualified and disambiguated in every pack.

The TypeScript/JavaScript layer uses the TypeScript compiler API (an optional
peer dependency; the pack degrades to syntactic analysis with explicit gaps
when it is not installed). Python, Go, Java, C#, Rust and PHP are parsed
through tree-sitter WASM, so no language toolchain is required. Framework
pack ids are `express`, `fastify`, `nest`, `fastapi`, `flask`, `gin`, `chi`,
`spring`, `aspnet`, `axum` and `laravel`.

---

## Install

```bash
npm install @powerduck/code-to-openapi
# TypeScript projects benefit from an optional peer dependency:
npm install -D typescript
```

The package ships ESM and CJS builds and runs on Node.js 18+.

## Quick start

```ts
import { scanProject } from "@powerduck/code-to-openapi";

const result = await scanProject({ root: "/path/to/your/api/project" });

console.log(
  `${result.report.routesConfirmed} confirmed, ` +
    `${result.report.routesPartial} partial routes`,
);

const { document, documentValid, diagnostics } = await result.convert();
console.log("OpenAPI 3.2 valid:", documentValid);
```

`document` is a validated OpenAPI 3.2 object. `result.project` is the
intermediate Discovery IR; `result.report.gaps` lists exactly what could not be
proven statically.

Run the bundled example against any Express project:

```bash
npx tsx node_modules/@powerduck/code-to-openapi/examples/basic.ts ./my-api
```

## Scan options

```ts
await scanProject({
  root: "./api",
  ignore: ["legacy/**"], // merged with .gitignore / .powerduckignore
  includeTests: false, // include test and fixture files (default: false)
  frameworks: ["express"], // restrict framework packs
  maxFileBytes: 2 * 1024 * 1024, // skipped files are reported as unresolved
  maxFiles: 10_000,             // exceeding this source-file budget fails the scan
  maxTotalBytes: 64 * 1024 * 1024, // total indexed source budget (64 MiB)
  onProgress: (phase, detail) => console.log(phase, detail ?? ""),
  gapResolver, // optional; omit for fully deterministic output
});
```

## Optional AI gap resolver

The scanning package never calls a model vendor itself. It ships the prompt
contract and a strict response validator; the host performs the HTTP call
(the desktop app does this behind an explicit opt-in, using the user's own
model configuration):

```ts
import {
  buildGapMessages,
  parseGapResolution,
  gapCacheKey,
  GAP_PROMPT_VERSION,
  scanProject,
  type GapResolver,
} from "@powerduck/code-to-openapi";

const cache = new Map<string, unknown>();

const resolver: GapResolver = {
  id: "openai-compatible-host",
  async resolve(request) {
    // Reuse resolutions for unchanged handler slices.
    const key = gapCacheKey(request, GAP_PROMPT_VERSION);
    const cached = cache.get(key);
    if (cached) return cached as never;

    const response = await fetch("https://your-model-host/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "your-model",
        messages: buildGapMessages(request),
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return null; // a failed fill is never fatal to the scan
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const resolution = parseGapResolution(content); // clamps to a safe subset
    if (resolution) cache.set(key, resolution);
    return resolution; // null leaves the gap visible in the report
  },
};

const result = await scanProject({ root: "./api", gapResolver: resolver });
```

The model receives only the small handler slice for routes that actually have
gaps — never whole files — and its answer is clamped to a JSON Schema subset
(no `$ref`, bounded depth and property counts). The resolver can fill query
parameters, headers, the request body, status-keyed response schemas and SSE
event payloads; it can never invent a route, method or path.

Gap codes include `path-dynamic`, `path-param-untyped`, `query-unknown`,
`header-unknown`, `body-unknown`, `body-schema-unknown`, `response-unknown`,
`response-schema-unknown`, `auth-unknown` and `sse-events-unknown`.

## Incremental rescans

```ts
import {
  diffSidecars,
  affectedFiles,
  type DiscoverySidecar,
} from "@powerduck/code-to-openapi";

const diff = diffSidecars(previousSidecar, currentSidecar);
// diff.addedFiles / changedFiles / removedFiles
// diff.routeChanges: added | changed | removed, keyed by `${METHOD} ${path}`
const reanalyze = affectedFiles(diff);
```

The sidecar is the only place scan provenance is stored. The generated OpenAPI
document stays clean and is safe for users to edit; removed routes are flagged
for review rather than deleted automatically.

### Three-way merge into an edited document

On a rescan, merge the freshly scanned document into the user's current
specification. Manual edits always win; the scan only refreshes structural
contracts.

```ts
import { mergeScannedDocument } from "@powerduck/code-to-openapi";

const merged = mergeScannedDocument({
  current: currentOpenApiDocument, // user-edited OAS object
  scanned: scannedOpenApiDocument, // result.convert() output
  previous: previousSidecar,       // .powerduck/discovery.json on disk
  next: scanResult.sidecar,        // sidecar from the new scan
});
// merged.added / changed / removed / unchanged
// merged.document is the merged OAS object (inputs are never mutated)
```

Merge rules:

- **Added** routes are inserted; **unchanged** routes are left exactly as the
  user wrote them.
- **Changed** routes refresh parameters, request bodies, responses and security
  while preserving `summary`, `description`, `tags`, `externalDocs`,
  `deprecated`, `operationId`, parameter/response descriptions and examples,
  and every `x-` extension. User-only parameters and response statuses are
  kept.
- **Removed** routes are never deleted; they stay in the document and are
  returned in `removed` for explicit review.
- `components.schemas` and `securitySchemes` are add-only. A scanned component
  whose name collides with a different user schema is renamed (`User2`,
  `User3`, …) and its refs are rewritten automatically.
- `info`, `servers` and all other top-level user content are untouched.

## Confidence and gaps

Every operation carries a confidence level:

- `high` — framework trace plus types/literals prove the contract.
- `medium` — route and shape are proven but some schema detail is inferred.
- `low` — only syntactic evidence exists; gaps describe what is missing.

Unresolvable constructs (dynamic route expressions, orphan routers) appear in
`project.unresolved` / `diagnostics` instead of being guessed.

## License

MIT © Powerduck limited. See [LICENSE](./LICENSE).

Website: [https://www.powerduck.com/](https://www.powerduck.com/)

### Explicit generated Java sources

Generated Spring API interfaces and DTOs may be excluded by `.gitignore` (for example under `target/`). Generate them with your project's pinned toolchain first, then opt in to those source directories:

```ts
const result = await scanProject({
  root: '/workspace/backend',
  additionalSourceRoots: ['target/generated-sources/openapi/src/main/java'],
});
```

The scanner never runs code generators or project build scripts. Additional roots must resolve to subdirectories inside the project; outside symlinks are rejected. Explicit `ignore` patterns and `.powerduckignore` still apply. Missing interface sources remain unresolved rather than fabricated. Spring controller implementations inherit interface mappings, parameter annotations and generated response annotations when the corresponding sources are present. This does not imply support for every generic interface or dynamic mapping.

### Extended HTTP methods

HTTP operation discovery includes all nine fixed OpenAPI 3.2 methods (including `trace` and `query`) and custom verbs in `additionalOperations`, such as `PROPFIND`, `REPORT`, and `CUSTOM-VERB`. Shared method helpers come from `@powerduck/openapi-parser/methods`; path metadata is not interpreted as an operation. Custom verbs must be valid HTTP tokens. Use OpenAPI 3.2 when declaring QUERY or `additionalOperations`.

Express route detection includes the Node HTTP method set (plus QUERY). Explicit method lists in Python route declarations and Go ServeMux method patterns accept custom tokens. Framework-specific convenience methods remain limited to the framework APIs; adding an arbitrary convenience function does not make it an HTTP route.

### Scan reliability (0.14.3)

- FastAPI static router factories resolve local and imported function returns, with
  lexical isolation for same-named local routers. Recursive and conditional
  returns remain unresolved; scanning never executes application source.
- Nested `.gitignore` and `.powerduckignore` files are evaluated relative to
  their own directories, including negation; caller `ignore` exclusions remain
  authoritative. Ignored parent directories are not traversed, as with Git.
- A framework detection failure is isolated like an extraction failure: other
  packs can finish, and the report retains an explicit coverage warning.
- Rescan merging reads and writes extension verbs through OpenAPI 3.2
  `additionalOperations`. Added, changed and removed PROPFIND/REPORT-style
  operations are no longer silently skipped. Removed operations remain for review.
- Component-name deduplication uses a set rather than repeated linear searches.

The 28 framework adapters cover eight displayed languages (JavaScript and
TypeScript share one analysis pack). This is a support matrix, not a measured
100% recall claim. Runtime-generated routes, unavailable generated source,
reflection, dynamic dispatch and unresolved external types can still leave
coverage or contract gaps. A valid OpenAPI document means it passes document
validation; it does not prove that every server route or response was discovered.
AI proposals remain evidence to review, not deterministic completeness proof.

Gin now follows inline `register(api.Group("/users"))` and chained group route
calls. Recursive helper expansion is stopped with a coverage warning, and a
nonliteral group prefix is not silently replaced by an empty prefix.

#### Local corpus spot check, 2026-10-11

These are extraction results from the pinned repositories in
`test-corpus/real-apis/manifest.json`, not recall/accuracy percentages. No AI was
used. Contract-gap counts are routes with unresolved contract details.

| Repository | Routes | Routes with gaps | Coverage warnings |
| --- | ---: | ---: | ---: |
| danielfsousa/express-rest-boilerplate | 15 | 12 | 0 |
| ivan-borovets/fastapi-clean-example | 4 | 3 | 22 |
| gothinkster/golang-gin-realworld-example-app | 27 | 24 | 0 |
| lihengming/spring-boot-api-project-seed | 0 | 0 | 1 |
| iammukeshm/CleanArchitecture.WebApi | 11 | 0 | 0 |
| robatipoor/rustfulapi | 2 | 2 | 1 |
| relaticle/relaticle | 99 | 53 | 0 |

The Gin sample previously emitted only one route: inline group registration
was silently missed. The FastAPI sample improved from zero to four routes after static factory
resolution. Custom router subclasses and argument-dependent factories still
leave coverage warnings; these four routes are **not** complete API coverage. The Spring seed contains controller
generator templates rather than generated controller source, so generation is
needed before those routes can be scanned. All seven outputs passed document
validation, demonstrating why validation must not be equated with completeness.
