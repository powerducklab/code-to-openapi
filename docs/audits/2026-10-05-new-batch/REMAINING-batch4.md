# Batch 4 — fresh real-project generality audit (2026-10-05)

## Purpose

A fourth independent generality batch using **frameworks and repositories not
covered by batches 1-3**. Every project is a real open-source application pinned
to a commit, scanned with an empty ledger and **no project-specific rules**, and
the expected routes were verified by reading the route registration source
directly (blueprints, `include_router`, controller decorators, Rocket fairing
mounts, Gin router groups, Hono chains, chi nested routers).

The batch spans **6 languages / 7 frameworks** over **7 coherent applications /
72 operations**: Flask, FastAPI, NestJS, Rust Rocket, Gin, Hono and go-chi.

## Result

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** (72/72) |
| Route precision | **1.0000** (0 false routes) |
| Request completeness (deterministic) | **1.0000** |
| Response completeness (deterministic) | **0.9712** |
| Deterministic 0.96 gate (recall/precision/request, per project) | **PASS** |

The only non-deterministic contracts are **three deliberate error-path routes
whose response is produced by a registered framework error handler**, not by
the handler body:

- go-chi `GET /panic` — the handler only `panic(...)`s; the 500 body is produced
  by the mounted `middleware.Recoverer`.
- Hono `GET /error` (throws) and `GET /type-error` (returns a non-`Response`
  value) — both funnel into the registered `app.onError`, which returns
  `c.text('Custom Error Message', 500)`.

These are not guessed. They are surfaced to the **interactive AI gap review**
(`response-unknown`, with handler source attached). After user acceptance of
those three reviews the batch's response completeness is **1.0000**; AI closure
is reported separately and never counted as scanner correctness. Linking a
throwing handler to its framework error handler / recovery middleware
statically is tracked as remaining work (see below; it is the same class as the
P1 Slim/Starlette exception-chain items).

Per-project rows: `results/scorecard-batch4.json`. Manifest with pinned commits
and source-verified baselines: `projects-batch4.json`.

## General scanner fixes made in this batch

Each is a framework/language rule that applies to any codebase; no sample is
referenced by name.

- **Nest — void handlers.** A controller method with no `return <expr>` (or an
  explicit `void`/`undefined`/`never` return type) deterministically yields an
  empty success body (201 for POST, else 200). It is now emitted as an empty
  response instead of a content-less JSON placeholder plus a false
  `response-unknown`.
- **FastAPI — module-level literal tables and dict subscripts.** A handler that
  returns a module-level binding initialized to a dict/list literal (a fake
  in-memory table) now resolves that literal with a fresh depth budget, and
  `table[param]` / `table[param]["field"]` subscripts infer the value domain
  (dynamic keys unify all property shapes; literal keys index directly).
  Top-level `identifier` and `subscript` returns are accepted by the response
  builder, not just bare dict/list literals.
- **Hono — native Fetch responses and redirects.** `new Response("...")`
  returned from a handler maps to `200 text/plain`, `new Response()`/`null` to
  an empty 200, and `c.redirect(location, status?)` to an empty 302 (default).
- **Gin — honest wrapper payloads.** When an adapter response-envelope wrapper
  is used for a 2xx success but the concrete `data` payload cannot be proven
  from source, the operation now carries `response-schema-unknown` instead of
  presenting an empty/`$ref`-hidden object as complete. Proven error branches
  (`data: null`) and proven ORM payloads (e.g. `data: Article | null`) remain
  concrete.

## Verification

- Full suite: all tests pass (`npx vitest run`); `npx tsc --noEmit` clean;
  `npm run build` succeeds.
- Framework regression tests for Nest, FastAPI/Python, Hono and Gin stay green.
- Each clean application is **0 deterministic gaps** with request/response
  schemas cross-checked against the source DTO/model: flaskr, fastapi-bigger,
  nest-cats, rocket-serial, gin-example.
- Correctness spot checks beyond route counts:
  - Gin `/tags/export` and `/tags/import` are correctly placed at the **root**
    (they are registered on `r`, not on the `/api/v1` group) even though they
    sit inside the group's lexical block; `StaticFS` mounts and the gin-swagger
    `/swagger/*any` UI handler are correctly **not** treated as API operations.
  - Rocket media types follow the route `format = json|msgpack` attribute and
    fairing `mount` prefixes (`/json`, `/msgpack`, `/`).
  - FastAPI 404/403 `HTTPException` branches are documented alongside 200.

## Remaining work surfaced honestly (not scored as correct)

- **Exception/error-handler chains** (chi `Recoverer`, Hono `app.onError`, and
  the analogous Slim/Starlette/ASP.NET items from the original P1 list):
  throwing handlers should be linked to the registered error handler to derive
  the error status/body. Currently routed to the visible AI review.
- **Rocket `examples/todo`** uses server-rendered `Template` responses and a
  `Mutex<HashMap>` store; scanned as a probe but not included in the clean set
  (HTML/template and shared-state payloads are not static JSON contracts).
- Classic Flask HTML-form POSTs (server-rendered views) carry no typed request
  schema; this is correct for the genre but means request completeness for
  classic server-rendered Flask is about routes/responses, not JSON bodies.

## Guardrails honored

- Expected baselines were read from source; scanner output never generated the
  baseline.
- No sample project is hard-coded; no assertion was deleted and no unresolved
  contract was hidden to pass.
- Contracts that cannot be proven statically are marked unknown or routed to
  the visible AI review; ORM entities are never wholesale expanded into
  responses.
