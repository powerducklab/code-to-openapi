# Batch 2 — fresh generality audit (2026-10-05)

A second, independent set of real open-source applications, each pinned to a
commit and scanned with an empty ledger. Expected route counts were verified by
reading each project's route registrations directly from source — never from
the scanner output. The MinimalApiPlayground repository contains three
independent applications and is scanned three times with separate roots.

- Manifest: `projects-batch2.json`
- Scorecard: `results/scorecard-batch2.json`
- Scoring gate: **0.96**, unknown/AI-reviewable contracts count as incomplete
  on the deterministic axis and are reported separately.

## Result

| Axis | Score |
| --- | --- |
| Route recall | **1.0000** |
| Route precision | **0.9980** |
| Request completeness | **0.9961** |
| Response completeness (deterministic) | **0.9774** |
| Deterministic gate (recall/precision/request per project) | **pass** |

154 expected operations across 10 application scans; 155 detected (the single
extra route is the non-compiled `Properties/Scratch/Program2.cs` dead-code host,
honestly flagged unknown rather than fabricated).

| Project | Framework | Detected / expected | Deterministic response |
| --- | --- | --- | --- |
| gin-example | Gin | 14 / 14 | 1.00 |
| hono-blog | Hono | 7 / 7 | 1.00 |
| slim-skeleton | Slim | 3 / 3 | 1.00 |
| symfony-demo | Symfony | 19 / 19 | 1.00 |
| spring-petclinic | Spring MVC | 17 / 17 | 1.00 |
| flask-tutorial | Flask | 12 / 12 | 1.00 |
| chi-myapp | go-chi | 6 / 6 | 0.83 (1 dynamic GORM list → AI review) |
| minimal-playground | ASP.NET Minimal API | 51 / 50 (+1 dead code) | 0.94 (dynamic/scratch → AI review) |
| minimal-efcore | ASP.NET Minimal API + EF Core | 13 / 13 | 1.00 |
| minimal-dapper | ASP.NET Minimal API + Dapper | 13 / 13 | 1.00 |

## Generic scanner fixes made during this batch

No sample-specific hard-coding; every fix is a general AST/data-flow rule.

- **C# / ASP.NET Minimal API**
  - Pre-process explicit lambda return types (a vendored tree-sitter grammar
    blind spot), distinguishing them from expression-bodied methods.
  - Resolve EF Core (`ToListAsync`/`FindAsync`/`ExecuteSqlRawAsync`, …) and
    Dapper (`QueryAsync<T>`/`ExecuteAsync`, …) return shapes via data-flow
    inference, including generic collection element types and `DbSet<T>`
    properties.
  - Recognise `Body<T>`/`Bind<T>`/`Validated<T>` wrappers, injected data
    services (`DbContext`, `IDbConnection` and provider connections),
    `Results<T1,T2,…>` union return types, method-group handlers (including
    cross-file selectors and local functions), and RFC 7807
    `application/problem+json` responses.
- **go-chi**: a router factory reached only through `Mount(...)` is no longer
  re-emitted as prefix-less standalone routes (removes unreachable duplicates).
- **Flask**: `render_template` / `render_template_string` resolve to
  `200 text/html`, `send_file` / `send_from_directory` to binary responses, and
  proven `request.form["x"]` / `.get("x")` accesses populate an
  `application/x-www-form-urlencoded` object schema with required flags.
- **Symfony**: a method-less `#[Route]` (which matches any verb at the router)
  is emitted once as GET instead of fabricating one operation per HTTP verb;
  this matches the YAML loader and removes false routes.

## Contracts deliberately left to the interactive AI review

These cannot be proven statically without risking fabricated fields or leaking
unreturned entity columns, so they stay unresolved, surface in the UI with the
real handler source, and are only merged after the user accepts/edits/rejects
the proposal (every merged fragment is tagged `x-ai-inferred`):

- `GET /v1/books` (chi-myapp): GORM-backed list shape built through a
  repository/helper.
- `GET /throw/{statusCode}` (playground): response status is supplied at
  runtime and produced by the exception middleware.
- `GET|POST /todos/fromfile` (playground): custom `JsonFormFile<List<Todo>>`
  multipart binder plus antiforgery token object.
- `POST /` (playground): emitted from the non-compiled `Program2.Main2`
  scratch host whose routes reference anonymous-object variables.

The accept/edit/reject loop was verified end-to-end on the real chi-myapp
project: manual mode captured 528 characters of handler source, an accepted
proposal closed the gap and tagged the merged schema, and a rejected proposal
merged nothing and left the gap open.
