# Batch 8 — remaining work and evidence log

Date: 2026-10-05
Gate: 0.96 on every axis (routeRecall / routePrecision / requestCompleteness /
responseCompleteness / parameterCompleteness / constraintAccuracy;
unresolvedRatio must stay 0).

This batch extends the field-level gate to frameworks whose response contracts
flow through **schema-less data gateways** and **dynamic exception chains**,
and it formalizes a **two-layer acceptance model** so that accuracy is never
bought by fabrication.

## Samples in this batch

| key | framework | repo | commit | runtime | static gate | runtime (AI-reviewed) gate |
| --- | --- | --- | --- | --- | --- | --- |
| starlette-crud | starlette | gtfisher/starlette-example-crud | d948b7b | Python 3.13 + dataset 1.6.2 / SQLite | 172 assertions, all axes 1.0 | 172 assertions, all axes 1.0 |

Later samples planned for this batch: Express + Mongoose, a Symfony JSON API
(API Platform style, not the Twig SSR demo), ASP.NET, and Micronaut. Each gets
the same closed loop: real third-party project at a pinned commit, native
runtime where the environment allows it, independently hand-written static and
runtime baselines, generic scanner fixes with regression tests.

## Two-layer acceptance model

A schema-less table (`dataset` over SQLite) has no ORM model that carries field
types. Rows are built from an unconstrained `await request.json()` body. A
non-running analyzer can prove some facts and cannot prove others, and the
audit now keeps those two sets explicitly separate.

- **Static capability baseline** — the maximum contract provable without
  running the project and without inventing types:
  - route set, methods, path/query/header parameters and their provable types;
  - top-level shapes (array vs object vs nullable union vs scalar);
  - response **column names** that appear in an authoritative write dict
    (`data = dict(id=..., firstName=..., ...)`);
  - open objects (`additionalProperties: {}`) when the decoded body is inserted
    verbatim or mutated by key, so extra keys are not hidden;
  - required request keys proven by indexed reads of the decoded body;
  - exception media types derived from the registered handlers and the debug
    setting.
  A value whose type is not statically provable is an **explicit empty schema**
  (`{}`) — the field is present, its value is open — never a guessed primitive.
  Reaching the static gate therefore means "the analyzer reached the exact
  static boundary", not "the analyzer guessed the runtime types".

- **Runtime baseline** — the concrete types established by native HTTP
  evidence. It is reached only after the interactive, user-visible AI gap
  review is accepted; every merged fragment carries `x-ai-inferred: true`. It
  is reported separately and is never counted as deterministic scanner
  correctness. The user can accept, edit, or reject each proposal.

The comparator needed no change for this model: it walks only the leaves the
baseline declares, so an explicit empty schema matches a present open value
without rewarding a fabricated type.

## Native evidence (starlette-crud @ d948b7b)

Run with `DATABASE_URL='sqlite:///data.db' python app.py` (debug=True on :8000
as shipped) and a debug=False copy on :8001.

- `GET /` → 200 `text/html` (Jinja index).
- `GET /msg` → 200 `{message, version}` both strings.
- `GET /dt` → 200 `{hello:'world', now:<stringified datetime>}` both strings.
- `GET /api/contact` → 200 `[]` when empty, otherwise a contact array.
- `POST /api/contact` with any JSON object → 200 `{created:'ok'}`;
  `creationTime` is overwritten server-side with `int(time.time())`; the
  decoded object is inserted verbatim (arbitrary extra keys persist).
- A stored contact row is
  `{id:integer, firstName:string, lastName:string, email:string,
  company:string, phone:string, creationTime:integer(unix)}`.
- `GET /api/contact/{item_id}` → `find_one` row, or **200 `null`** when absent
  (the code never raises 404). `item_id` has no `:int` converter and is a
  string path parameter.
- `PUT /api/contact/{item_id}` reads six body keys
  (`firstName,lastName,email,company,phone,creationTime`; no `id`, which comes
  from the path), builds `data = dict(id=<path>, ...)`, calls
  `table.update(data, ['id'])`, and returns `find_one` or 200 null.
- `DELETE /api/contact/{item_id}` → 200 with the remaining contact list.
- `GET /error` raises `RuntimeError`. With **debug=True** the custom 500
  handler is bypassed by ServerErrorMiddleware and the response content
  negotiates: default `text/plain; charset=utf-8` traceback, and
  `text/html; charset=utf-8` debug page for `Accept: text/html`. With
  **debug=False** the registered custom handler returns 500 `text/html` from
  `500.html`. Unknown routes return 404 `text/html`.
- The `StaticFiles` mount at `/static` is registered but is not an operation
  and must not be emitted as one.

This directly covers P1#14 (Starlette exception handlers and middleware must
be associated per app, exception type and debug setting; debug can change the
media type, so both variants are recorded).

## Generic scanner changes in this batch

All changes are source-driven and framework-general; nothing is hard-coded to
the sample.

1. **Starlette gap honesty** (`src/frameworks/starlette.ts`): routes no longer
   start with unconditional `body-schema-unknown` / `response-schema-unknown`.
   After responses are finalized (including merged exception responses), gaps
   are reconciled from the final content: bodyless statuses are skipped,
   `text/html` / `text/plain` / `text/css` are exempt by **base media type**
   (parameters such as `; charset=utf-8` are stripped), and JSON content needs
   a schema with no unknown node. Confidence is recomputed after reconciliation.
2. **Charset-aware media matching** (`src/core/completeness.ts`): the
   completeness gate compares the base media type, so `text/plain;
   charset=utf-8` no longer fails an exact `text/plain` expectation.
3. **Schema-less table gateway inference** (`src/frameworks/starlette.ts`):
   a per-analysis index tracks table writes and reads through the
   `db["table"].method(...)` gateway, including local table handles
   (`table = db["name"]`), `dict(...)` / dictionary-literal write payloads
   (arguments live inside `argument_list`; `keyword_argument` nodes carry the
   columns), identifier payloads traced back to their assignment, and open
   payloads traced to `await request.json()`. `find_one` maps to
   `anyOf[row, null]`; `find` / `find_many` / `all` and `[]`+`append` list
   helpers map to `array of row`; verbatim inserts keep the row open with
   `additionalProperties: {}`. Column names come from write dicts; a value is
   typed only when every write proves the same concrete type, otherwise it
   stays an explicit hole. The whole database entity is never expanded, so
   columns that are not written/returned cannot leak.
4. **Request key provenance** (`src/frameworks/starlette.ts`): an aliased
   `await request.json()` whose keys are read proves required object keys;
   key writes or `.update()` prove an open object.
5. **Nullable-union honesty** (`src/core/completeness.ts`): in `anyOf` /
   `oneOf`, a pure `null` branch carries no data shape and can no longer make a
   nullable dynamic object count as known. Its object sibling is still
   examined and stays a reviewable gap when its fields are untyped. Fully
   typed nullable objects are unaffected.
6. **AI review visibility** (`src/frameworks/starlette.ts`,
   `examples/scan-audit-project.ts`): Starlette candidates now carry
   `handlerSource`, and the audit project export surfaces top-level
   `gapReviews`, so unresolved handlers enter the user-reviewable queue with
   their source.
7. **AI resolution safety** (`src/ai/prompt.ts`): `sanitizeSchema` now keeps
   `anyOf` / `oneOf` (surviving branches, at least one required), `allOf`
   (kept only when every branch survives so the intersection is not weakened),
   and `additionalProperties` (`true`/empty → open object; typed value
   sanitized recursively). This lets an accepted review fill nullable
   responses and open rows while still rejecting dangling references and
   fabricated structure.

Regression tests: `test/starlette-computed-contract.test.ts` (schema-less
gateway rows, nullable reads, open inserts, no fabricated value types) and
new `sanitizeSchema` cases in `test/ai-gap.test.ts` (nullable unions, open
objects, allOf survival). Full suite: 180 files / 492 tests green.

## Result

- Static deterministic gate: **172 assertions, 0 mismatch / 0 unknown / 0
  extra, every axis 1.0**, four honest review gaps presented (list, detail,
  PUT response+body, delete response) for value types that are not statically
  provable.
- Runtime AI-reviewed gate: after accepting proposals grounded in the native
  evidence (id/creationTime integer, the other five columns string), **172
  assertions, every axis 1.0**, with five merged media schemas tagged
  `x-ai-inferred` and the row kept open.

## Remaining for batch 8

- Express + Mongoose real project (evaluate mongodb-memory-server behind the
  proxy for native evidence; static-only fixtures do not count as gate samples).
- Symfony JSON API (API Platform or equivalent; the symfony/demo project is
  Twig server-rendered and is not a JSON gate sample).
- ASP.NET real project at a pinned commit (.NET 10 SDK is available; confirm
  any /tmp project is third-party and unseen by the scanner, not a self-made
  fixture).
- Micronaut real project (JDK 25 + Gradle/Maven caches available; only logs
  exist under /tmp so a fresh third-party sample is required).
- Fold each into `projects-batch8.json`, `results/scorecard-batch8.json`, and
  this log with both static and runtime gates.

Cross-batch P1 items still tracked separately: P1#20 comparator union/ref
coverage expansion, P1#21 incremental scan end-to-end across four repositories,
and the release-blocking unified 9.5/10 acceptance definition (P1#22).
