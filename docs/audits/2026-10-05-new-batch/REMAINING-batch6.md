# Batch 6 — fresh real-project generality audit (2026-10-05)

## Purpose

Two goals:

1. Close the headline P1#1/P1#2 gap for **Express + Prisma ORM** on a real,
   official project — resolving ORM return types, `select`/`include`, mutation
   results and query destructuring without leaking unreturned fields.
2. Prove the scanner keeps working on **entirely new codebases** (different
   repositories and a new framework major version) with no project-specific
   rules.

## Deterministic scored result

Three new real applications / 8 operations, all deterministic:

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** (8/8) |
| Route precision | **1.0000** (0 false routes) |
| Request completeness (deterministic) | **1.0000** |
| Response completeness (deterministic) | **1.0000** |
| AI-review routes | **0** |
| Deterministic 0.96 gate | **PASS** |

- `tokio-rs/axum` `examples/key-value-store` (5 routes): shared-state KV store.
- `tokio-rs/axum` `examples/jwt` (2 routes): JSON login + text-protected route.
- `gofiber/recipes` `hello-world` (1 route): Fiber **v3** plain-text route.

Per-project rows: `results/scorecard-batch6.json`; pinned commits and
source-verified baselines: `projects-batch6.json`.

## Generic scanner fixes in this batch

Each rule is framework/language-level; no repository is referenced by name.

### Express + Prisma (P1#1 / P1#2)

- **Generated/relocated Prisma clients.** `PrismaClient` is now recognised not
  only from `@prisma/client` but also from generator output paths
  (`*/prisma/generated/client`, `.prisma/client`, `*/prisma/client`), matching
  the modern `prisma-client` generator that emits into a project directory.
- **Return projection correctness.** `include: { relation: true }` returns only
  the related model's **scalar** fields; relations are never cascaded unless a
  nested `include`/`select` is written (previously the bound expansion emitted
  untyped relation placeholders that read as unknown and over-reported fields).
- **Mutation results.** `delete` returns the single model object and
  `deleteMany`/`updateMany`/`createMany` return `{ count: number }`; `count`
  returns `number`.
- **Query destructuring (P1#2).** `const { a, b } = req.query` resolves each
  scalar to a **string** wire parameter (Express always parses query values as
  strings), honoring binding defaults and explicit `Number()/parseInt()`
  wrappers. Per P1#2, a later `Number(take)` conversion does **not** narrow the
  accepted wire type to integer — the parameter stays string.
- **Untyped JSON bodies stay honest.** `const { … } = req.body` with no declared
  type or validator is not fabricated; it is reported as `body-schema-unknown`
  and routed to the **visible, interactive AI review** (see below).

### axum

- An untagged `bytes::Bytes` handler parameter is a raw
  `application/octet-stream` body extractor and `String` a `text/plain` body
  extractor (both implement `FromRequest` directly); previously the body was
  silently missed.
- Explicit `Err(StatusCode::NOT_FOUND)` arms on a `Result<T, StatusCode>` handler
  now document the empty error status, so success and error branches are both
  present.
- `Result<String, E>` success is `text/plain`, not `application/json`.

### Verified AI fallback on a real project

The official `prisma-examples` **orm/express** app (9 routes) was scanned end to
end as the AI-engagement sample:

- All **9 response contracts** are now deterministic — `findMany` arrays,
  `findUnique` nullable objects, `create`/`update`/`delete` model objects, and
  `include: { author: true }` projections resolve from `schema.prisma`.
- The `/feed` query parameters (`searchString`, `skip`, `take`, `orderBy`) are
  documented as strings.
- The two handlers whose `req.body` is genuinely untyped (`POST /signup`,
  `POST /post`) emit **two visible AI gap reviews** (`aiReview: "manual"`) with
  file/line origins and suggested schemas that the user can accept, edit, or
  reject. Accepted fragments are tagged `x-ai-inferred`; rejected fragments are
  never silently merged. This is the required "AST cannot prove it → AI is
  visible and participatory" behavior on a real codebase, not a mock.

This sample is deliberately kept **out of the deterministic gate**: unknown
fields never count as correct, and the two request bodies cannot be proven
statically without a validator or declared DTO.

## Verification

- Full suite passes (`npx vitest run`); `npx tsc --noEmit` clean; `npm run build`
  succeeds; dist rebuilt and synced to the Electron app.
- New regression tests: `test/prisma-generated-client.test.ts` (generated client
  import, scalar-only include, delete, string query destructuring, honest
  untyped-body gap) and `test/axum-raw-body-errors.test.ts` (Bytes body,
  `Err(StatusCode)` arm, `Result<String>` text).
- Existing Prisma/Express/axum suites stay green (no relation over-expansion
  regressions).

## Honest limitations surfaced (not silently passed)

- **Custom `IntoResponse` error types** (axum-jwt `AuthError` → 400/401/500) and
  other cross-symbol exception/error mappers (chi `Recoverer`, Hono `onError`,
  Slim/Starlette exception handlers) are not yet statically linked; success
  contracts are deterministic while the error chain remains tracked separately
  (P1#13/#14 family).
- A Rust/axum path binding whose identifier differs from the route template
  (e.g. `Path(_key)` for `/{key}`) currently emits both names; the template name
  should win. Not hit by the scored apps; queued as a small follow-up.
- Untyped ORM JSON request bodies continue to require a validator/DTO for a
  deterministic request schema; otherwise they correctly go to AI review.

## Guardrails honored

- Expected baselines were read from source; scanner output never generated the
  baseline.
- No sample is hard-coded; no assertion was deleted and no unresolved contract
  was hidden to pass.
- ORM entities are projected to exactly the returned fields/scalars; the full
  database entity is never expanded into a response.
- Contracts that cannot be proven statically are marked unknown and surfaced to
  the visible AI review.
