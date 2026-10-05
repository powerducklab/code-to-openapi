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
| mongoose-express | express + mongoose | bezkoder/node-express-mongodb | 30851145 | not bootable on audit host (no mongod/Docker) | 254 assertions, all axes 1.0, 0 review gaps | n/a (deterministic-only; no AI completion needed) |
| aspnet-todoapidto | asp.net core mvc controllers (csharp) | dotnet/AspNetCore.Docs (`aspnetcore/tutorials/first-web-api/samples/9.0/TodoApiDTO`) | 3d06f3ee | .NET SDK 10.302 rolling forward to net9.0, EF Core InMemory | 252 assertions, all axes 1.0, 0 review gaps | n/a (static contract matches native HTTP evidence; no AI completion needed) |

Later samples planned for this batch: a Symfony JSON API (API Platform style,
not the Twig SSR demo) and Micronaut. Each gets the same closed loop:
real third-party project at a pinned commit, native runtime where the
environment allows it, independently hand-written static and runtime baselines,
generic scanner fixes with regression tests.

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

### Express + Mongoose (P1#1 ORM projection / computed serializer, P1#2 query typing)

8. **CommonJS router factories** (`src/frameworks/express.ts`): a default
   `module.exports = app => { ... app.use(prefix, router) }` route factory is
   recognized and linked when it is invoked immediately
   (`require("./routes/x.routes")(app)`) or bound and called, including routes
   and controllers `require`d from inside the factory body. Model factories
   (`module.exports = mongoose => mongoose.model(...)`) are not mistaken for
   routers: the parameter is treated as a synthetic app only when the body
   actually calls `use/get/post/...` on it.
9. **Recursive CommonJS import resolution**
   (`src/frameworks/express-handler.ts`): `const x = require(...)` declarations
   are found at any nesting depth (previously only top-level variable
   statements), so handlers required inside a factory resolve.
10. **Mongoose model resolution** (`src/lang/typescript/mongoose.ts`): the
    index is built in ordered passes and cached before construction so
    resolution works while the index is still being built; paths are
    normalized across the macOS `/private/tmp` vs `/tmp` realpath split. It
    resolves `mongoose.Schema(...)` called without `new`, models returned from
    a default factory (`return Model` **and** `return mongoose.model(...)`),
    namespace modules (`db.tutorials = require("./model")(mongoose)`,
    consumed as `db.tutorials`), `require(spec)(...)` immediate and bound
    factory calls, and `new Model()` / `Model.create` / `save` /
    `find*AndUpdate` inside handlers.
11. **Computed serializer projection** (`src/lang/typescript/mongoose.ts`):
    `new Model(doc).save()` projects the full persisted document; the custom
    `schema.method("toJSON", ...)` / `schema.set("toJSON",{transform})` is
    parsed structurally — rest-destructuring omissions (`const {__v,_id,
    ...object}=this.toObject()`) remove fields and same-document key copies
    (`object.id=_id`) add the string `id`, so the wire document exposes
    exactly `{id,title,description,published,createdAt,updatedAt}` and never
    leaks `_id`/`__v`. Timestamps add `createdAt`/`updatedAt` as date-time.
    Dynamic transform behavior that cannot be proven stays unknown.
12. **Request body backfill and branch-sensitive null narrowing**
    (`src/frameworks/express-handler.ts`, `src/lang/typescript/mongoose.ts`):
    write calls (`new Model(payload)`, `Model.create`, `findByIdAndUpdate` /
    `findOneAndUpdate` / `updateOne` / ...) backfill request-body field types
    from the writable Mongoose paths; a whole-body forward
    (`findByIdAndUpdate(id, req.body)`) yields every path optional (PATCH /
    strict-mode semantics), while an explicit `if (!req.body.field) return
    4xx` guard proves the field required. A 2xx response whose root is proven
    non-null inside the `else` of an `if (!data) 404` guard has the pure-null
    branch stripped, so the 200 is the document and null lives only on the
    404 arm; unrelated paths are never merged.
13. **Query parameters default to the atomic query-string type**
    (`src/frameworks/express-handler.ts`): an untyped, unconverted
    `req.query.x` is `string` (a proven transport fact), not an unknown gap;
    a `Number()` / `parseInt()` conversion that reaches the response still
    narrows to `number`. `parseInt` alone is never assumed to reject
    non-integers (P1#2) — only the proven conversion result is typed.

### ASP.NET Core MVC controllers (per-return-branch contracts, DTO projection, validation)

14. **Per-return-branch controller results** (`src/frameworks/aspnet.ts`):
    controller actions are classified per owned `return` statement (nested
    lambdas and local functions are excluded) instead of collapsing to the
    declared `ActionResult<T>`. Each helper (`Ok`/`Json` 200, `Created*` 201,
    `Accepted*` 202, `NoContent` 204, `BadRequest`/`Problem`/
    `ValidationProblem` 400, `Unauthorized` 401, `Forbid` 403, `NotFound` 404,
    `Conflict` 409, `UnprocessableEntity` 422, `TooManyRequests` 429) and the
    explicit `StatusCode(...)` form map to their real status, distinguishing
    the success and error arms. `await`/parenthesized returns and bare, `this.`
    and `base.` callee forms are recognized. A controller that declares (`new`)
    its own `NoContent`/`Ok`/... shadows the ControllerBase helper; such calls
    are treated as ordinary user methods and never forced to the built-in
    status.
15. **Payload concreteness and DTO projection** (`src/frameworks/aspnet.ts`):
    a returned payload schema is used only when it is concrete (a real object /
    array / scalar, recursively — no empty `{}`, property-less object or empty
    array items). When the value is produced by an unresolvable local mapper or
    a LINQ projection chain, the declared `ActionResult<T>` stays authoritative
    instead of emitting an empty shell. This recovers `Ok(items.Select(...).
    ToList())` as an array of the declared DTO. Response DTOs are built through
    the serialization index, so an entity field absent from the projection DTO
    (e.g. `TodoItem.Secret`) can never leak; response objects in the baseline
    carry `x-audit-exact-properties` to hard-fail any extra wire field.
16. **Route Name vs template** (`src/frameworks/aspnet.ts`): the class/method
    route template attributes now read only the `Template`/`Pattern` arguments.
    `[HttpGet(Name = "GetWeatherForecast")]` is a route NAME, not a path, so
    the route is `/WeatherForecast` (native `/WeatherForecast/GetWeather…`
    returns 404). Binding aliases (`[FromRoute(Name=)]`, `[FromQuery]`,
    `[FromHeader]`, `[FromForm]`) still honor `Name`.
17. **[ApiController] automatic 400, scoped to what can actually fail binding**
    (`src/frameworks/aspnet.ts`): the built-in ModelStateInvalidFilter adds a
    400 `application/problem+json` (ValidationProblemDetails) when the action
    has a request body (malformed JSON / type mismatch / data-annotation or
    NRT violations) OR a value-type route/query/header parameter
    (`integer`/`number`/`boolean`, or `string` with `date`/`date-time`/`time`/
    `uuid` format, covering `DateOnly`/`DateTime`/`Guid`). A plain string route
    parameter accepts any token and never 400s, so no spurious 400 is added.
    This built-in 400 is independent of FluentValidation: an unregistered
    validator or a missing `AddFluentValidationAutoValidation()` still leaves
    the built-in 400 but never overlays FluentValidation rules on the body.
18. **.NET 9 bodiless error results emit ProblemDetails**
    (`src/frameworks/aspnet.ts`): the target framework is read from the
    `.csproj` (including multi-targeting); on net9+ a parameterless
    `NotFound()`/`BadRequest()`/... error result returns an RFC 7807
    `application/problem+json` body, while `NoContent()` and 2xx results stay
    empty. `Forbid` (no body) is excluded. On earlier frameworks the bodiless
    results stay empty. The nullable-reference-types setting
    (`<Nullable>` enable/annotations/disable/absent) is likewise read from the
    project and drives implicit request requiredness.
19. **Value-type request optionality vs wire presence**
    (`src/lang/csharp/schema.ts`, `src/lang/csharp/index.ts`,
    `src/lang/csharp/serialization.ts`): in the REQUEST direction a value-type
    member (`int`/`long`/`bool`/`DateTime`/`Guid`/`struct`/`enum`, unwrapping
    nullables) is never implicitly required — it binds to its default when
    omitted, so `POST {}` can be valid; non-nullable reference types are
    implicitly required only when NRT annotations are enabled, and
    `[Required]`/`[JsonRequired]` always wins. In the RESPONSE/wire direction
    (the dedicated serialization index, now flagged `wireSerialization`)
    field presence follows System.Text.Json: non-conditionally-ignored keys —
    including value types — are required on the wire, STJ does not omit nulls
    by default, and `DateOnly` maps to `string` format `date`. Read-only
    computed properties (e.g. `TemperatureF => 32 + C/0.5556`) are serialized;
    `struct` declarations are modeled as a distinct type kind.

Regression tests: `test/starlette-computed-contract.test.ts` (schema-less
gateway rows, nullable reads, open inserts, no fabricated value types),
`sanitizeSchema` cases in `test/ai-gap.test.ts`,
`test/express-mongoose-projection.test.ts` (ESM + CommonJS models, factory /
namespace resolution, toJSON `id`/`_id`/`__v` projection, timestamps, request
body backfill with required guards, whole-body PATCH optionality, and null
narrowing), `test/express-scan.test.ts` (untyped query default), and
`test/aspnet-controller-branches-scan.test.ts` over the synthetic
`test/fixtures/aspnet-controller-branches` project (per-branch statuses and DTO
secret non-leakage, value-type request optionality vs wire requiredness,
`DateOnly` and a read-only computed property, route `Name` not treated as a
template, and recursive csproj target-framework detection). Existing ASP.NET
tests were tightened to the native behavior: shadowed `NoContent`, value-type
query binding 400, the built-in (FluentValidation-independent) 400, and empty
`required` arrays. Full suite: 181 files / 496 tests green.

## Result

- Static deterministic gate: **172 assertions, 0 mismatch / 0 unknown / 0
  extra, every axis 1.0**, four honest review gaps presented (list, detail,
  PUT response+body, delete response) for value types that are not statically
  provable.
- Runtime AI-reviewed gate: after accepting proposals grounded in the native
  evidence (id/creationTime integer, the other five columns string), **172
  assertions, every axis 1.0**, with five merged media schemas tagged
  `x-ai-inferred` and the row kept open.

### Express + Mongoose result (bezkoder/node-express-mongodb @ 30851145)

- All 8 routes recalled with zero false routes and **zero review gaps**.
- Static deterministic gate: **254 assertions, 0 mismatch / 0 unknown / 0
  extra, every axis 1.0** (`results/contracts-batch8-mongoose-static.json`).
  Request bodies are typed from the writable schema paths (`title` required by
  the create guard; update body fully optional); responses carry the exact
  toJSON wire document (`id`, timestamps, no `_id`/`__v`), list endpoints are
  arrays, `findById` 200 is the non-null document with null on the 404 arm, and
  update/delete return the fixed `{message}` rather than the entity. The
  optional `title` query is typed `string`.
- This sample is **deterministic-only**: the contract is fully fixed by
  Mongoose 6 schema/serialization library semantics and needs no AI completion,
  and the audit host has no `mongod`/Docker, so no runtime baseline is
  fabricated (recorded honestly in `projects-batch8.json`).

### ASP.NET Core MVC controller result (dotnet/AspNetCore.Docs TodoApiDTO @ 3d06f3ee)

- All 6 operations recalled with zero false routes and **zero review gaps**:
  five `/api/TodoItems` CRUD operations plus `GET /WeatherForecast`; the
  `[HttpGet(Name=...)]` route name does not create a false path.
- Static deterministic gate: **252 assertions, 0 mismatch / 0 unknown / 0
  extra, every axis 1.0** (`results/contracts-batch8-aspnet-static.json`).
  Responses expose exactly the projected `TodoItemDTO`
  (`{id:int64,name:string|null,isComplete:boolean}`) and never the entity
  `Secret`; `WeatherForecast` carries the `DateOnly` date string and the
  computed read-only `TemperatureF`; value-type request members are optional
  (`POST {}` → 201) while the request body itself is required; value-type
  `{id}` routes carry the automatic 400 validation problem plus 404 problem;
  PUT adds the explicit id-mismatch 400; success PUT/DELETE are 204 empty; and
  .NET 9 bodiless error results are RFC 7807 `application/problem+json`.
- The static contract was written independently from source and then checked
  against native HTTP evidence captured by running the net9.0 app on .NET 10
  (`DOTNET_ROLL_FORWARD=LatestMajor`, EF Core InMemory). Every static assertion
  matches the native behavior, so no runtime/AI layer is needed and none is
  claimed; the native findings are recorded in `projects-batch8.json`.

## Remaining for batch 8

- Symfony JSON API (API Platform or equivalent; the symfony/demo project is
  Twig server-rendered and is not a JSON gate sample). The audit host has no
  PHP runtime, so this sample needs a runnable environment or a static-only
  boundary recorded honestly.
- Micronaut real project (JDK 25 + Gradle/Maven caches available; only logs
  exist under /tmp so a fresh third-party sample at a pinned commit is
  required).
- Fold each into `projects-batch8.json`, `results/scorecard-batch8.json`, and
  this log with both static and runtime gates.

Cross-batch P1 items still tracked separately: P1#20 comparator union/ref
coverage expansion, P1#21 incremental scan end-to-end across four repositories,
and the release-blocking unified 9.5/10 acceptance definition (P1#22).
