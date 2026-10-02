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
| TypeScript / JavaScript | Express, Fastify, NestJS (CommonJS + ESM, monorepo leaves) | 0.8.x |
| Python     | FastAPI, Flask (Flask-RESTful resources), SQLModel | 0.8.x |
| Go         | Gin, Chi (go-chi/render) | 0.8.x |
| Java       | Spring Boot (service return following, SSE events) | 0.8.x |
| C#         | ASP.NET Core (controllers + minimal API) | 0.8.x |
| Rust       | Axum | 0.8.x |
| PHP        | Laravel (resources, transformers, facades, downloads) | 0.8.x |

HTTP is fully supported; SSE endpoints are emitted with the canonical
`x-protocol: "sse"` extension and a `text/event-stream` media type carrying
`itemSchema` (including named Spring `SseEmitter` events when the event name
and payload type are statically provable).

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
  maxFileBytes: 2 * 1024 * 1024, // per-file cap (default 2 MiB)
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
