# Batch 3 — fresh real-project generality audit (2026-10-05)

## Purpose

A third independent generality batch. Every project is a **new real open-source
application** pinned to a commit, scanned with an empty ledger and **no
project-specific rules**. Expected routes were verified by reading each
project's route registrations directly from source, never from scanner output.

The batch spans **6 languages and 8 frameworks** (Go: Fiber, Echo; Rust:
Actix-Web, Axum; Node/TS: Fastify; Bun/TS: Elysia; C#: FastEndpoints; Python:
Django REST Framework) over **12 coherent applications / 57 operations**.

## Result

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** (57/57) |
| Route precision | **1.0000** (0 false routes) |
| Request completeness (deterministic) | **1.0000** |
| Response completeness (deterministic) | **0.9722** |
| Deterministic 0.96 gate (recall/precision/request, per project) | **PASS** |

The single non-deterministic contract is **Elysia `POST /name`**, whose handler
returns a value read from runtime store state (`.state('name', 'salt')`). It is
not guessed. It is surfaced to the **interactive AI gap review**: a manual scan
emits one pending review with the handler source and makes no model call; the
user accepts/edits/rejects. Verified end to end on this real app:

- reject → proposal is never merged, the gap stays open;
- accept → the fragment is merged, the gap closes, and the schema carries
  `x-ai-inferred: true`.

After user acceptance of that one review the response completeness for the
batch is 1.0000; it is reported separately so AI closure is never counted as
scanner correctness.

Per-project rows: `results/scorecard-batch3.json`. Manifest with pinned commits
and source-verified baselines: `projects-batch3.json`.

## General scanner fixes made in this batch

None of these reference a sample project by name; each is a framework/language
data-flow rule that applies to any codebase.

- **Fiber — scoped group prefixes.** Group variables declared inside different
  functions (`AuthRoutes` vs `TodoRoutes`, each with its own `r := app.Group(...)`)
  no longer leak across functions. Prefixes are resolved per enclosing function
  scope, so `/auth/*` and `/todo/*` stay separate.
- **Axum — `*_service` method routers and layered services.** Recognizes
  `get_service`/`post_service`/…, unwraps handlers decorated with
  `.layer(...)`/`.route_layer(...)`/`.with_state(...)`/`.boxed()` to the base
  handler, and maps `bytes::Bytes` / `Result<Bytes, _>` success bodies to
  `application/octet-stream`.
- **Go shared data flow (helps Echo/Gin/Fiber/Chi/net-http/Axum-style Go).**
  Expression type inference now covers `make([]T, …)` / `make(map[K]V, …)`,
  map/slice index expressions (`u, ok := users[id]`), multi-return function
  calls (`u, err := bindUser(c)`), and package-level variable initializers
  (including `var users = map[int]user{}`).
- **Echo — pointer contexts and v5.** Accepts handlers taking `*echo.Context`
  (not only `echo.Context`) and the `github.com/labstack/echo/v5` import alias.
- **Fastify — autoload resolution.** Accepts bare `join(...)`/`resolve(...)` and
  `fileURLToPath(new URL(..., import.meta.url))` autoload dirs; forwarded
  `options` with no prefix default to empty instead of erroring; production
  route folders named `example/` nested under `routes/` are indexed (only the
  repository-root `example(s)/` directory is treated as sample code).
- **FastEndpoints — generic DTO resolution and response inference.** Resolves
  the per-endpoint `Request` DTO through the endpoint namespace (fixing dangling
  `$ref`s from disambiguated duplicate class names) and infers `Send.OkAsync(
  msg ?? "literal")`, string concatenation and local-variable responses.
- **Elysia — `.guard(options, callback)` routes.** Routes declared inside a
  `.guard(...)` scoped instance callback are now discovered (mirroring
  `.group(...)`); handlers populate `handlerSource` so unresolved routes reach
  the visible AI review.
- **DRF — granular dynamic choices.** A serializer field whose **enum values**
  are computed at runtime (e.g. pygments lexers/styles) keeps its deterministic
  base type with an `x-dynamic-enum` marker instead of invalidating the entire
  request/response schema. Only a field whose very **type** cannot be proven
  (e.g. unparameterized `DecimalField`) marks the operation unknown. External
  `auth.User` viewset contracts resolve; viewset/action/class/function views
  populate `handlerSource`.
- **Actix — `web::Form<T>`** binds an `application/x-www-form-urlencoded` body
  to the inner struct (previously only `web::Json<T>` produced a request body).

## Verification

- Full suite: **443 tests / 164 files pass**; `npm run build` succeeds.
- Framework-specific regression tests added/kept green for Fiber, Actix, Axum,
  Echo, Fastify, FastEndpoints, Elysia and DRF.
- Each clean application below is **0 deterministic gaps** with request and
  response schemas cross-checked against the source DTO/model:
  fiber-todo, fiber-hello, actix-todo, actix-json, actix-form, axum-kv,
  echo-crud, echo-hello, fastify-starter, febench, drf-tutorial.

## Adversarial probes (not counted as clean scorecard apps)

These real projects/code paths were scanned deliberately to find edges. They
are reported honestly as remaining work or interactive-AI candidates, not
silently treated as correct:

- **FastEndpoints `TestHarness/Web`** (196 endpoints): adversarial feature
  harness. Remaining deterministic gaps are intentionally exotic bindings —
  complex `[FromForm]` with files, `FormFileCollection`, JSON array to
  `List<Model>`, nested forms, query objects, root collection bodies, typed
  headers, JSON Patch — and service-driven dynamic responses. These route to
  AI review.
- **gofiber/recipes `form-data`** (4 POST multipart handlers): multipart
  request media is currently mislabeled as JSON and success responses are
  dynamic; multipart schema inference is a remaining task.
- **actix-examples `json/json-validation`**: response is an external HTTP
  round-trip (httpbin echo) through a helper; the pack emits a content-less 200
  without flagging it — a comparator false-negative to close (the contract is
  genuinely external and should be marked unknown/AI, not left blank).
- **actix-examples `json/json-error`**: custom error responder contract is
  intentionally non-deterministic and is correctly left unknown.
- **axum `examples/testing`**: routes live in an `app() -> Router` helper with
  inline closures and no `main` (a test harness). Standalone router-builder
  functions not referenced by `.nest/.merge` are not yet expanded.
- **Elysia `POST /name`**: runtime store-derived response; the designated AI
  exemplar above.

## Guardrails honored

- Expected baselines were read from source; scanner output never generated the
  baseline.
- No sample project is hard-coded; no assertion was deleted and no unresolved
  contract was hidden to pass.
- Contracts that cannot be proven statically are marked unknown or routed to
  the visible AI review; whole ORM entities are never expanded into responses
  (only fields the handler actually returns are emitted).
- Upstream documentation/runtime contradictions continue to be resolved in
  favor of reproducible runtime evidence (the standing JAX-RS / Spring / Echo /
  Fiber-Gorilla exceptions remain unchanged).
