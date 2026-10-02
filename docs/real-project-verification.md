# Real-project verification

Evidence that `scanProject` discovers routes (paths **and** methods) and emits
request/response schemas on real, public backends — not just synthetic fixtures.

Method: shallow-cloned repositories into an out-of-repo scratch dir and ran
`scanProject({ root, includeTests: false })` (except where noted, where the
framework's own example/tutorial apps live under `examples/`/`docs_src/`).
Every row below was converted with `discoveryToOpenApi(project, { validate: true })`.

Legend: **files** = indexed source files; **ops** = discovered operations;
**paths** = distinct path templates; **methods** = distinct HTTP verbs;
**body** = ops with a non-empty request-body schema where the source defines one;
**resp** = ops with at least one non-empty response schema.

| Framework | Repository | files | ops | paths | methods | body | resp | honest gaps | valid |
|-----------|-----------|------:|----:|------:|--------:|-----:|-----:|-------------|:-----:|
| Express | [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app) | 28 | 20 | 13 | get,post,put,delete | 6 | 19 | `query-unknown`×1, `body-schema-unknown`×6 | ✅ |
| Fastify | [fastify/demo](https://github.com/fastify/demo) | 31 | 0 | 0 | – | – | – | **autoload/plugin-encapsulated routes not detected** (see notes) | ✅ |
| NestJS | [nestjs/nest](https://github.com/nestjs/nest) | 1486 | 2 | 1 | get | 0 | 2 | framework monorepo; real controllers live in generated sample packages | ✅ |
| FastAPI | [fastapi/fastapi](https://github.com/fastapi/fastapi) (`docs_src/`, includeTests) | 514 | 434 | 80 | get,post,put,patch,delete | 111 | 252 | `response-unknown`×188, `response-schema-unknown`×44, `query-unknown`×4, `header-unknown`×2, `path-param-untyped`×1; duplicate paths across tutorial apps de-duped | ⚠️ doc valid; error-severity = duplicate de-dup only |
| Flask | [pallets/flask](https://github.com/pallets/flask) (includeTests) | 83 | 102 | 93 | get,post,put,options | 4 | 4 | `response-unknown`×63, `body-schema-unknown`×6, `response-schema-unknown`×2 | ✅ |
| Gin | [gin-gonic/examples](https://github.com/gin-gonic/examples) | 56 | 49 | 40 | get,post,put,patch,delete,head,options | 4 | 13 | `response-unknown`×19, `response-schema-unknown`×21, `sse-events-unknown`×2 | ✅ |
| Chi | [go-chi/chi](https://github.com/go-chi/chi) (includeTests) | 54 | 29 | 17 | get,post,put,delete | 0 | 25 | `response-unknown`×3, `response-schema-unknown`×1; duplicate paths across example apps de-duped | ⚠️ doc valid; error-severity = duplicate de-dup only |
| Spring Boot | local Maven app `apipost-server` (real, private) | 1593 | 432 | 431 | get,post | 247 | 420 | `sse-events-unknown`×12 (WebSocket/SSE endpoints) | ✅ |
| ASP.NET Core (MVC) | [gothinkster/aspnetcore-realworld-example-app](https://github.com/gothinkster/aspnetcore-realworld-example-app) | 65 | 19 | 12 | get,post,put,delete | 0 | 14 | `response-unknown`×5, `response-schema-unknown`×5 | ✅ |
| Axum | [tokio-rs/axum](https://github.com/tokio-rs/axum) | 113 | 9 | 7 | get,post,put | 0 | 4 | `response-unknown`×2, `response-schema-unknown`×2 | ✅ |
| Laravel | [laravel/laravel](https://github.com/laravel/laravel) skeleton | 26 | 1 | 1 | get | 0 | 1 | none — starter app defines a single welcome route | ✅ |

Secondary ASP.NET evidence: [dotnet/eShop](https://github.com/dotnet/eShop)
(Minimal APIs) → 513 files, 29 ops, 23 paths, 5 request-body schemas, **0** traced
response schemas (`response-unknown`×27): Minimal-API `Results<T>` / typed-result
wrappers are not followed, whereas controller-based MVC (the row above) traces
14/19 response schemas.

## Honest gaps (where a real scan still yields incomplete contracts)

These are **deliberate gap markers, not fabricated schemas**:

- **Fastify autoload / plugin encapsulation.** The official `fastify/demo`
  registers routes through `fastify-autoload` and defines `fastify.get(...)` on
  the *plugin parameter* inside `src/routes/**/index.ts`, not on the root
  `Fastify()` instance. The pack only traces the root instance and router
  objects it can prove; it therefore emits 0 operations for that architecture.
  Direct root-instance routing (`const app = Fastify(); app.get(...)`) and
  `fastify-plugin` factory registration are proven by the hermetic fixtures
  (`fastify-scan`, `fastify-factory`, `fastify-rootpath`, `fastify-class-root`,
  `fastify-body-alias`).
- **NestJS framework monorepo.** `nestjs/nest` is the framework source; the 2 ops
  come from benchmark/SDK code, not a generated application. The Nest pack's
  controller/`@Module`/params/body tracing is covered by `nest-*` fixtures.
- **Untyped Python handlers.** FastAPI tutorial endpoints that return plain
  `dict` / `JSONResponse(...)` without a `response_model`, and Flask views that
  return strings, honestly surface `response-unknown` rather than inventing a
  shape. Pydantic/`response_model`-declared endpoints resolve to components.
- **Rust/Axum raw-string and `impl Trait` bodies.** Handlers returning plain
  text or un-nameable response types keep an honest `response-schema-unknown`.
- **ASP.NET Core Minimal API results.** `Results<T>` / typed Results wrappers are
  not unwrapped; controller MVC return types (records/DTOs) are traced.
- **Laravel skeleton.** The upstream starter defines one route; richer Laravel
  routing, route groups, `FormRequest` bodies and Eloquent resources are covered
  by the bagisto-style `laravel-realworld` and related fixtures.

## Production bugs found and fixed during verification

- **Express pack crashed** (`Cannot read properties of undefined (reading 'kind')`)
  on `app.listen()` with no arguments while scanning the Nest monorepo. Guarded
  `arguments[0]` before the numeric-literal test. Locked by
  `test/express-listen-noarg.test.ts`.
- **Gin pack emitted invalid OpenAPI paths.** Relative route patterns accepted by
  Go (`router.GET("favicon.ico", ...)`) produced a path key with no leading slash,
  which the schema validator rejected (`Property favicon.ico is not expected ...
  at /paths`). `joinPath` now always guarantees a leading slash. Locked by
  `test/gin-relative-path-scan.test.ts`.
