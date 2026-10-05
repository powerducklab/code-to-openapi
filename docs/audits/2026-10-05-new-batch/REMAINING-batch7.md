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
- **P1#20 comparator:** bidirectional false-positive/false-negative comparison
  across routes, parameters, response fields, media types, and status codes
  (union/`$ref`/constraint aware), with undecidable items reported separately.
- **P1#21 incremental scan E2E:** the four-repository incremental/persist
  pipeline (shared-DTO edit, route deletion, validator/config edit, file move,
  cancel, stale late result, save failure, restart recovery) still needs a
  unified end-to-end acceptance run; incremental results must match full-scan
  semantics and preserve manual edits.
- **P1#22 release definition:** the fixed-version, scan-independent sample set
  and per-axis thresholds (route recall/precision, request/response field
  completeness, constraint accuracy, unresolved ratio) are partially
  implemented by `examples/audit-new-batch-scorecard.py`; response-field-level
  precision (extra/missing properties) and constraint accuracy are not yet
  scored automatically and unknown fields continue to count as incorrect.

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
