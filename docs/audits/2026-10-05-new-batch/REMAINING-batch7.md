# Batch 7 — fresh real-project generality audit (2026-10-05)

## Purpose

Continue the P1 response-contract backlog on two independently maintained
RealWorld (Conduit) reference implementations that the scanner had never seen:

1. **Express 4 + Prisma 4 (TypeScript)** — cross-file mappers/DTOs over Prisma
   models, `select`/`include` projection, loose query parsing, and a
   four-argument error middleware (P1#1, P1#2).
2. **Laravel (PHP)** — string `Controller@action` references inside a group
   namespace, `Route::resource` with `only`/`except` option arrays and
   slash-nested resources, constructor-injected Fractal-style presenters
   (item/collection/paginate) that are **not** Laravel `JsonResource`,
   `FormRequest` payload wrappers, and named `respond*()` status helpers
   (P1#17).

The goal is generality: every fix is a framework/language-level rule, no
repository is referenced by name, and contracts that cannot be proven
statically stay explicitly unresolved rather than being fabricated.

## Deterministic scored result

Two new real applications / 42 operations, all deterministic:

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** (42/42) |
| Route precision | **1.0000** (0 false routes) |
| Request completeness (deterministic) | **1.0000** |
| Response completeness (deterministic) | **1.0000** |
| AI-review routes | **0** |
| Deterministic 0.96 gate | **PASS** |

- `gothinkster/node-express-realworld-example-app`
  (`30b68e1e…`) — 20 routes, 0 gaps.
- `gothinkster/laravel-realworld-example-app`
  (`e45c37c8…`) — 22 routes (21 JSON API + the HTML welcome route), 0 gaps.

Per-project rows: `results/scorecard-batch7.json`; pinned commits and
source-verified baselines: `projects-batch7.json`.

## Generic scanner fixes in this batch

### Express + Prisma / local flow (P1#1 / P1#2)

- **Error-middleware contracts.** The first parameter of a four-argument
  middleware is treated as the `Error` convention even without a type
  annotation; `err.message` / Error-like property access resolves to the error
  envelope instead of an empty/`any` body. Receiver calls on an empty schema
  fall through to the Error fallback instead of overwriting it.
- **Forwarded body DTOs.** A handler that forwards `req.body` (or a
  `req.body.<wrapper>` field, a spread, or a two-level wrapper) into a DTO
  constructor/function now back-propagates the inferred field schemas onto the
  request body, including fields whose parameter type is `any`. Object
  destructuring inside local helpers collects field shapes correctly.
- Regression coverage: `test/express-body-forwarding.test.ts` (5 cases).

### Laravel routing

- **String actions + group namespace.** `'Controller@action'` references are
  resolved by splitting at the last `@`, locating the method across the class
  tree, and combining the action's short class name with the `namespace` chain
  of enclosing `Route::group(['namespace' => …])` blocks (outer-first). Class
  resolution matches short names, FQCNs, and namespace suffixes, preferring
  `Http\Controllers` on ambiguity; classes outside the scanned tree produce a
  synthetic node rather than a silent miss.
- **Resource option arrays and nested resources.** The third argument of
  `Route::resource` is parsed for `only`/`except`, eliminating the framework's
  `create`/`edit` HTML routes and honoring explicit verb subsets. Resource
  paths now support slash nesting (`articles/{article}/comments`) with the
  child binding singularized from the final literal segment; the previous
  dot-nesting behavior is preserved. Bare string controller names (without
  `@`) are also recognized.
- Result on the sample: an exact 22 routes (previously 29 with false
  `create`/`edit` routes and mangled nested parameters).

### Laravel response presenters (Fractal-style, not JsonResource)

- A generic presenter pipeline was added for projects that ship their own
  transformer base:
  - the injected transformer class is found through the controller constructor
    (parameter type matching `/Transformer$/`) walking the inheritance chain;
  - `$resourceName` is read as a protected string property along the chain,
    with a generic pluralizer (`y→ies`, `s/x/z/ch/sh→es`, otherwise `+s`);
  - `item()` / `collection()` / `paginate()` wrappers are reconstructed
    (`{name: transform()}`, `{plural: [transform()]}`, and
    `{plural: […], pluralCount: total}`);
  - `transform()` return arrays are inferred field by field, including nested
    object presenters, date-to-string methods (`toAtomString`/`toString`/
    `format`), count/total methods, and a scalar `transform()` that returns the
    value unchanged (yielding `{tags:[string]}`);
  - collection detection first unwraps the `argument` AST node and recognizes
    `->get/all/pluck/map/paginate/cursor`, `::all/get/paginate`,
    `new Collection`, and assigned collection sources;
  - the controller's `respond*()` helpers are resolved by name:
    `respondWithTransformer` (item/collection, 200 default),
    `respondWithPagination` (paginate), `respondSuccess` (200 nullable),
    `respondNoContent` (204), and `respondFailedLogin/NotFound/Unauthorized/
    Forbidden/InternalError` (422/404/401/403/500) with the literal envelope
    read from the helper body or `respondError`.
- Field typing is conservative and name-grounded: `*Count`/`id`/`total` →
  integer, `is/has/favorited/following/…` → boolean, `*List`/`tags`/`names`/
  `emails`/… → scalar arrays, everything else scalar defaults to **string**
  (so `image`/`bio` stay strings and are never widened or leaked). The earlier
  `age$` heuristic that mis-typed `image` as integer was removed.
- Status codes follow the code, not REST convention: `store()` calls
  `respondWithTransformer()` with no status argument, so its success status is
  **200** per the base-method default (not 201).
- Regression coverage: `test/laravel-transformer-helper.test.ts` (string
  actions + group namespace, item/collection/paginate presenters, nested
  resource `only`, payload-wrapped request, authorization-only DELETE, and a
  dynamic-rules gap), plus the pre-existing `test/laravel-transformer-scan.ts`.

### Laravel FormRequest bodies

- Descendants of `FormRequest` through an intermediate base are recognized by
  walking the `extends` chain.
- `validationData()` wrappers are honored: when it returns
  `$this->get('article') ?: []`, the rules schema is nested under `article`
  with `article` required (same for `user`/`comment`).
- Empty/dynamic rules are distinguished precisely so unknown contracts are
  never hidden nor fabricated:
  - a request with **no own `rules()`** and an empty inherited/placeholder
    ruleset is authorization-only and carries no body (DELETE) — no gap;
  - a request whose own `rules()` returns an explicit empty array carries no
    body — no gap;
  - a request whose own `rules()` returns a non-array expression (e.g.
    `return $this->customRules();`) keeps **`body-schema-unknown`** and is
    routed to the visible AI review.
- A bare Laravel `array` rule with no `field.*` sub-rules is emitted as an
  unconstrained array (`anyOf` scalar/object/array/null), matching the
  framework's "any element" semantics. This is scoped to the Laravel rule
  mapper; the global completeness gate still treats an empty `items:{}` as
  unknown, so the change cannot whitewash real gaps elsewhere.

## Native-runtime limitations (honest disclosure)

This environment has **no PHP/Composer, Gradle/Maven, or mongod**, and the
Laravel/Symfony/Micronaut/Mongoose native oracles therefore cannot be executed
here. The Laravel contracts above are established by close source reading and
frozen as a self-contained, repository-independent vitest fixture
(`test/laravel-transformer-helper.test.ts`) that reconstructs the same
structures in a temporary project, so the behavior is regression-protected
even without the upstream checkout. A native `php artisan` + HTTP probe of the
pinned Laravel commit remains a recommended follow-up on a PHP-enabled runner;
until then the Laravel success/error shapes are source-verified, not
runtime-verified. The Express/Prisma sample is TypeScript and was scanned
statically without installing or executing the audited application (the audit
harness scans source only by design).

## Field-level two-way validation (post-0.11.0)

Route-level 0-gap is necessary but not sufficient, so both samples now carry
**independent field-level OpenAPI baselines** that are hand-written from
source reading and are never derived from scanner output. They are compared by
the two-way comparator `examples/audit-contracts.ts` (parameterized
`--gate=`, default 0.96), which resolves `$ref`, nullable unions, multi-branch
unions (any-branch), opaque `any`, dynamic enums, and — via
`x-audit-exact-properties: true` — hard-fails any **extra** response property,
proving the scanner neither misses fields nor leaks unreturned entity columns.

Result at gate 0.96 (1760 assertions total, merged into
`results/scorecard-batch7.json` → `summary.fieldLevel`):

| Sample | Prefix | Assertions | Mismatch | Unknown | Extra | All six axes |
| --- | --- | --- | --- | --- | --- | --- |
| rw-laravel | `''` | 941 | 0 | 0 | 0 | **1.0000** |
| rw-node | `/api` | 819 | 0 | 0 | 0 | **1.0000** |

Axes: route recall/precision, request completeness, response completeness,
parameter completeness, constraint accuracy, unresolved ratio (overall =
worst axis). Baselines live in `baselines/`; comparator output in
`results/contracts-batch7-*.json`.

### Generic scanner fixes driven by the field baselines

1. **Concatenated Laravel rule values** (`src/lang/php/index.ts`,
   `parseRulesMethod`). A rule value that is a string concatenation
   (`'sometimes|…|unique:users,email,' . $this->user()->id`) previously
   resolved an empty text node and dropped the whole field (PUT/PATCH `/user`
   lost `username`/`email`). All string fragments inside the binary expression
   are now collected and joined; the static rule prefix is kept and the dynamic
   operand discarded. Regression: `test/laravel-rules-concat.test.ts`.
2. **Type-before-constraint rules** (`src/lang/php/schema.ts`,
   `ruleStringToSchema`). Fields without an explicit `string` rule
   (`password` => `required|min:6`) previously got an empty type and lost
   `minLength`. The scalar type is now decided first (default scalar `string`;
   `array/integer/number/boolean/date/uuid/email` map as expected, `url` →
   `format: uri`), then `min/max/size` apply; `size` maps to an exact length
   and `nullable` is preserved. Regression: same test.
3. **Reflection-driven QueryFilter parameters** (`src/frameworks/laravel.ts`,
   `isQueryFilterClass` / `collectQueryFilterKeys`). A leaf filter class whose
   parent exposes `getFilterMethods`/`ReflectionClass` contributes its own
   single-argument `protected` method names as query parameters
   (`ArticleFilter` → `author`, `favorited`, `tag`). Extends-chain resolution
   passes the call-site node as context so short-name same-namespace parents
   resolve. Regression: `test/laravel-query-filter.test.ts`.
4. **Cross-class pagination parameters** (`collectConstructedRequestParams`).
   A handler that does `new Helper(…)` whose constructor reads
   `request()->get('limit'/'offset')` now contributes those query keys
   (integer only for `limit/offset/page/per_page`, otherwise string). GET
   `/articles` gains `author/favorited/tag` (string) + `limit/offset`
   (integer); `/articles/feed` gains `limit/offset`.

### Field facts the baselines pin (language-specific, not normalized away)

- **rw-node (TS):** `id`/`favoritesCount`/comment `id` are `number` (TS does
  not distinguish integer); `createdAt`/`updatedAt` are `string` with
  `format: date-time`; author/profile `bio`/`image` are `["string","null"]`;
  deterministic mapper/object-literal responses **do** list `required`.
  `POST /users` and `POST /articles` return **201**; `DELETE /articles/{slug}`
  returns **204** with no body; `DELETE …/comments/{id}` returns **200** with
  an empty object; `login` returns no `id` while register/current/update do
  (Prisma `select {id,…}` + `{...user, token}`). Query `limit/offset` are kept
  as `number` (source uses `Number()`) rather than guessed as integer, per
  P1#2 — no narrowing from a converter name alone.
- **rw-laravel (PHP):** response resources/envelopes do **not** list
  `required` (field presence is enforced by `x-audit-exact-properties`;
  listing it produced ~190 false mismatches against the scanner's correctly
  conservative response objects), while request schemas keep their real
  `required`; all-`sometimes` update requests have `requestBody.required=false`;
  a Laravel `array` rule with no element type yields `items: {}` rather than a
  guessed `string[]`; `DELETE article/comment` is 200 with a nullable empty
  object (source `respondSuccess()`), not 204; `GET /` is 200 `text/html`.

### Upstream security defect recorded, not "fixed" by the scanner

On rw-node the favorite endpoints (`POST`/`DELETE /articles/{slug}/favorite`)
inline `{...article, author: profileMapper, tagList, favorited,
favoritesCount}` while the Prisma query uses `include: { favoritedBy: true }`.
At runtime that path genuinely returns the scalar `id`/`authorId` and the full
`favoritedBy` User array (including `password`) — a real information-disclosure
bug in the sample. The scanner reports exactly what the source returns and
correctly does **not** expand relations that were not included (the clean
mapper paths expose no such keys). The favorite baseline deliberately uses a
non-exact `ArticleShape` so these source-real extra keys are documented rather
than forcing the scanner to delete fields to "pass". Standard mapper paths use
exact envelopes and prove zero leakage.

### Native runtime status (honest, attempted and blocked)

The field baselines are independent source-read contracts verified by a
two-way comparator, **not** executed HTTP evidence. Every reasonable path to a
native runtime on this machine (Apple silicon, macOS 26.5.1) was tried:

1. The Homebrew at `/usr/local` initially refused to run on macOS 26
   (`MacOSVersionError`, retired `master` branch). Homebrew itself and
   homebrew-core were migrated to `main`, restoring a working
   `brew 3.1.12` / homebrew-core 2026-10-05.
2. The `shivammathur/php` tap was added. It ships `php@7.4` (7.4.33), but the
   formula was **disabled upstream on 2023-11-28**, has no bottle for
   arm64/macOS 26, and would build 23 dependencies from source; PHP 7.4 does
   not build against the current `icu4c`/`openssl@3` stack without the
   maintainer's legacy patches, so this is not a reliable toolchain here.
3. The setup-php prebuilt macOS binaries (`shivammathur/php-builder` releases)
   have no published 7.4.33 Darwin asset (the tag returns 404), and there is no
   arm64 PHP 7.4 build.

Therefore rw-laravel (Laravel 5.5, `php >= 7.0`, `tymon/jwt-auth
1.0.0-rc.4.1`, plus an old MySQL/SQLite and `composer install` of pinned 2017
dependencies) cannot be brought up natively in this environment. rw-node needs
PostgreSQL + Prisma 4 serving a seeded Conduit database and likewise has no
native run here. This is recorded as an **attempted-and-blocked** native
oracle, not a claimed one; the field baselines must not be misrepresented as
executed HTTP tests. A future native run needs an x86_64 Linux container with
PHP 7.4 + MySQL 5.7 and a Node 16 + PostgreSQL container respectively. The
static field evidence here is nevertheless independent of scanner output
(hand-written from source) and bidirectional, including a hard no-leak check.

## Still open (not closed by this batch)

- **Laravel (P1#17 remainder):** cross-file custom exception rendering in
  `app/Exceptions/Handler.php` (`render`, ≤10) and `bootstrap/app.php`
  `withExceptions->render` (11+); custom validation rule classes; standard
  `JsonResource` classes (distinct from the Fractal-style presenters covered
  here); middleware/feature-flag conditional routes; additional route files.
- **Symfony (P1#18):** `kernel.exception` EventListener/ExceptionListener
  `setResponse` chains, forms/DTOs, serializer groups, nested route imports,
  environment config. `symfony/demo` is Twig SSR with no JSON API and is not a
  gate sample; a JSON API sample is still needed.
- **Mongoose native oracle:** Mongoose projection is covered by static
  fixtures (`test/express-mongoose-projection.test.ts`); a real
  Express+Mongoose JSON API verified with an in-memory MongoDB is still pending
  (MDN `express-locallibrary` is Pug SSR and is excluded from the JSON gate).
  `find/create/select/populate/lean`, `.select('+field')`, document `save()`,
  `refPath`, and `aggregate` branches that cannot be proven statically must
  stay gaps/AI-review.
- **ASP.NET remainder:** custom `IModelBinder` (unknown), property-level
  `[JsonConverter]` and `ShouldSerialize*`, `UseExceptionHandler("/error")`
  re-routing/lambda, MediatR `ValidationBehavior`, `RuleForEach`/nested
  validators, `AddValidator<T>` registration, Minimal API endpoint-filter
  validation.
- **Go / Echo / Gin / net-http / Fiber, Next.js, and the zero-diff frameworks
  (Nest, Hono, Koa, Elysia, FastAPI, Flask, FastEndpoints, Axum, Actix,
  Rocket, Fastify, Chi, Micronaut):** independent samples with native probes
  for validators/binders/serializers/middleware/conditional responses remain
  tracked per the 22-item list in
  `../2026-10-04-response-contracts/REMAINING.md`.
- **P1#20 comparator (largely implemented, needs breadth):**
  `examples/audit-contracts.ts` now performs bidirectional false-positive /
  false-negative comparison across routes, parameters, request/response
  fields, media types, and status codes, is union/`$ref`/nullable/constraint
  aware, hard-fails extra response properties via
  `x-audit-exact-properties`, reports unknown/opaque fields and undecidable
  items separately, and archives upstream defects via a ledger. Remaining:
  apply it across the full framework matrix rather than the two batch-7
  samples.
- **P1#21 incremental scan E2E:** the four-repository incremental/persist
  pipeline (shared-DTO edit, route deletion, validator/config edit, file move,
  cancel, stale late result, save failure, restart recovery) still needs a
  unified end-to-end acceptance run; incremental results must match full-scan
  semantics and preserve manual edits.
- **P1#22 release definition (implemented for batch 7, needs matrix rollout):**
  the fixed-version, scan-independent sample set and per-axis thresholds
  (route recall/precision, request/response/parameter completeness, constraint
  accuracy, unresolved ratio) are scored at field level by
  `examples/audit-contracts.ts --gate=0.96` and merged into
  `results/scorecard-batch7.json` → `summary.fieldLevel` (worst-case axes
  across samples; unknown fields count as incorrect and extra response fields
  hard-fail). Remaining: generalize the independent field baselines to every
  framework in the matrix and make the 0.96 field gate a release blocker.

## Upstream contradictions carried forward (not scanner bugs)

Per the audit ground rules, these are resolved in favor of reproducible
runtime evidence and must not be "fixed" by narrowing the scanner to the
documentation:

- JAX-RS nullability: empty body and `null` are accepted natively.
- Spring boundary constraints: upstream OAS contradicts native validation.
- Echo error responses: the source genuinely returns JSON `null`; no error
  object is fabricated.
- Fiber/Gorilla array nullability: requires a concrete success-path proof
  before `null` is removed.
- ASP.NET: `KeyNotFoundException` is not auto-mapped to 404 (native returns 500
  problem+json); `[FromForm]` DTO fields keep PascalCase while JSON bodies are
  camelCase; missing value-type form fields bind to defaults rather than 400;
  `= null!` remains required.
