# Batch 5 — fresh real-project generality audit (2026-10-05)

## Purpose

A fifth independent generality batch over **frameworks not covered by batches
1-4**, again using real open-source projects pinned to commits, scanned with an
empty ledger and no project-specific rules, with expected routes verified from
the route registration source.

The batch adds **five new framework targets** over **5 applications / 13
operations**: Go `net/http` (Go 1.22 ServeMux), PHP Slim 4, Spring Boot
(in-source annotations), Next.js App Router, and Quarkus / Jakarta REST
(JAX-RS).

## Result

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** (13/13) |
| Route precision | **1.0000** (0 false routes) |
| Request completeness (deterministic) | **1.0000** |
| Response completeness (deterministic) | **1.0000** |
| AI-review routes | **0** |
| Deterministic 0.96 gate | **PASS** |

Every scored application is deterministic with zero unresolved gaps.

Per-project rows: `results/scorecard-batch5.json`. Manifest with pinned commits
and source-verified baselines: `projects-batch5.json`.

## General scanner fixes made in this batch

Each is a framework/language rule that applies to any codebase; no sample is
referenced by name.

- **net/http — JSON decode/render helpers and implicit status.** A local helper
  that wraps `json.NewDecoder(req.Body).Decode(target)` with an `application/json`
  guard (e.g. `readRequestJSON(req, &x)`) now resolves the request body to the
  call-site type, including **function-local struct declarations** and honest
  nil-slice nullability. A render helper that does
  `json.Marshal(v)` + `w.Header().Set("Content-Type","application/json")` +
  `w.Write(js)` with no `WriteHeader` resolves to an implicit-200 JSON response,
  including stdlib string renders (`strings.Join`, `fmt.Sprint*`). When only
  explicit 4xx/5xx branches write and the normal return writes nothing, an
  implicit empty 200 is emitted; a helper that receives the writer but cannot be
  resolved is flagged `response-schema-unknown` instead of being silently
  dropped.
- **Next.js — required header/query guards and redirects.** A header or query
  value bound to a variable and guarded by an early-exit
  (`if (!sig …) return 4xx` / `throw`) is marked **required** with high
  confidence — this recovers the real Stripe webhook constraint that merely
  reading `stripe-signature` did not prove. `NextResponse.redirect(url, …)` and
  native `Response.redirect(url, …)` are modeled as empty **307/302** responses
  even when the `Location` target is computed by a helper.
- **JAX-RS — `Response.ok(field).build()` entities.** The entity of a built
  `Response` can now resolve against an **instance field** of the enclosing
  class (including `this.field`), not only local variables, so
  `Response.ok(legumes).build()` resolves a `Set<Legume>` field to a `Legume[]`
  response. Unannotated POJO resource method parameters continue to be treated
  correctly as the JAX-RS entity request body (POST and DELETE in the sample).

## Verification

- Full suite: all tests pass (`npx vitest run`); `npx tsc --noEmit` clean;
  `npm run build` succeeds.
- Targeted regression suites for net/http, chi, gorilla, gin, JAX-RS, Spring and
  Next.js stay green.
- Spot checks against source:
  - `ragserver` POST /add documents the function-local `addRequest{documents:
    [{text}]` body, the 400/500 `http.Error` branches and the implicit empty
    200; POST /query documents `queryRequest{content}` and the 200 JSON string.
  - `nextsub` POST /api/webhooks marks `stripe-signature` required and
    documents 400 (missing/invalid signature) and 200; both auth routes are
    empty 307 redirects.
  - `quarkus-restjson` documents GET/POST/DELETE /fruits (POST/DELETE carry the
    `Fruit` entity body; all return `Fruit[]`) and GET /legumes returning
    `Legume[]` via `Response.ok(field).build()`.
  - `slim-skeleton` resolves the class-action responder envelope to
    `{statusCode, data: User[]}` / `{statusCode, data: User}` and excludes the
    wildcard CORS OPTIONS handler.

## Probes deliberately excluded from the scored set

These were scanned to test boundaries and are reported rather than scored, so
the 0.96 gate is never padded by genre mismatches:

- **laravelio/laravel.io** (Laravel): a large, real production application with
  64 routes detected with high route recall, but it is a **server-rendered Blade
  forum** whose handlers return views, redirects and form responses; 16
  response-unknown / 8 response-schema / 8 body-schema gaps reflect HTML-genre
  contracts (Blade views, FormRequests, redirect targets), not JSON API
  endpoints. It is retained as a route-recall stress test; a headless Laravel
  JSON API (API Resources + FormRequest) remains the correct sample for the
  response/request axes.
- **golang/example outyet / helloserver**: legacy unmethoded `http.Handle`
  page servers. The scanner intentionally expands an unmethoded ServeMux
  pattern to every verb (the mux genuinely serves all of them) and the body is
  a server-rendered HTML template, so they are not JSON API samples. The
  method-pattern JSON API in the same repository (`ragserver`) is the scored
  sample.
- **koajs/examples/blog**: detects Koa only via the monorepo root package and
  renders server-side views (`ctx.render`) from an in-memory array; an HTML
  genre app, not a JSON API.
- **spring-petclinic-rest**: route mappings live on generated OpenAPI interface
  sources (`target/generated-sources`) that are absent until the build runs, so
  the static scanner honestly reports handler-unresolved rather than inventing
  the routes. The in-source `gs-rest-service` guide is the scored Spring sample.

## Remaining work surfaced honestly

- Headless JSON samples for Laravel (FormRequest + API Resource `when()` +
  pagination) and Symfony (serializer groups, DTO forms) to score those
  frameworks on the request/response axes rather than only routing.
- Static linking of throwing handlers to framework error handlers / recovery
  middleware (chi `Recoverer`, Hono `app.onError`, Slim/Starlette exception
  chains) — carried over from batch 4 and the original P1 list.

## Guardrails honored

- Expected baselines were read from source; scanner output never generated the
  baseline.
- No sample project is hard-coded; no assertion was deleted and no unresolved
  contract was hidden to pass.
- Contracts that cannot be proven statically are marked unknown or routed to
  the visible AI review; entities are never wholesale expanded into responses.
