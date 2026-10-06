# Real-world backend API corpus

A fixed, reproducible corpus of **mature, real open-source backend APIs** used to
evaluate `@powerduck/code-to-openapi`. The goal is to measure the two things that
matter for a code-to-API scanner on code that was never written for the scanner:

- **API detection precision** — route method, path, parameters, and framework
  binding recovered without false positives or missed routes.
- **Request/response contract completeness** — request bodies, query/header/path
  parameters, response shapes, nullability, nested relations, media types, and
  status codes across success and error branches.

These are runnable applications and services, not libraries, hello-world demos,
or fixtures hard-coded to the scanner. Every checkpoint is pinned to an exact
commit so results are reproducible and independent of any scanner output.

## Coverage

**28 frameworks, 135 checkpoints, 134 distinct repositories** (4–5 per
framework). Framework ids match the scanner pack ids in `src/core/engine.ts`.

| Ecosystem | Framework id | Checkpoints |
| --- | --- | --- |
| Node / TypeScript | `express` | 5 |
| Node / TypeScript | `fastify` | 5 |
| Node / TypeScript | `nest` | 5 |
| Node / TypeScript | `hono` | 5 |
| Node / TypeScript | `koa` | 4 |
| Node / TypeScript | `nextjs` | 5 |
| Node / TypeScript | `elysia` | 5 |
| Go | `gin` | 5 |
| Go | `chi` | 5 |
| Go | `nethttp` | 4 |
| Go | `gorillamux` | 5 |
| Go | `echo` | 5 |
| Go | `fiber` | 5 |
| Python | `fastapi` | 5 |
| Python | `flask` | 5 |
| Python | `drf` (Django REST Framework) | 5 |
| Python | `starlette` | 4 |
| JVM | `spring` (Spring Boot) | 5 |
| JVM | `jaxrs` (Jersey / RESTEasy / Dropwizard / Quarkus REST) | 5 |
| JVM | `micronaut` | 4 |
| Rust | `axum` | 5 |
| Rust | `actix` (Actix Web) | 5 |
| Rust | `rocket` | 4 |
| PHP | `laravel` | 5 |
| PHP | `symfony` | 5 |
| PHP | `slim` | 5 |
| .NET | `aspnet` (ASP.NET Core) | 5 |
| .NET | `fastendpoints` | 5 |

`koa`, `micronaut`, and `rocket` ship four checkpoints because their pools of
standalone, mature backend applications are smaller. The two intentionally
narrower cases are documented below.

## Layout

```
test-corpus/real-apis/
├── README.md          # this file
├── manifest.json      # pinned provenance for every checkpoint (committed)
├── fetch-corpus.sh    # one-command, idempotent materialization (committed)
└── repos/             # shallow clones (git-ignored, never committed or shipped)
    └── <framework>/<owner>__<repo>/
```

`repos/` holds third-party code and is **git-ignored**. Only `manifest.json`,
this README, and the fetch script are tracked; the checkouts are reproduced on
demand from the pinned commits.

## Materialize the corpus

```bash
cd test-corpus/real-apis
./fetch-corpus.sh            # all 135 checkpoints
./fetch-corpus.sh express    # a single framework id
```

The script reads `manifest.json`, performs a shallow clone of each repository,
and checks out the exact pinned commit. It is idempotent: checkpoints already at
the pinned commit are skipped, and a re-run verifies every `subdir` still exists.
Requirements are `git` and `python3`; the script runs on the stock bash 3.2 that
ships with macOS. Proxy settings (`HTTPS_PROXY` / `https_proxy`) are honored.

## Scan a checkpoint

Each manifest entry exposes `scanRoot`, the directory that contains the runnable
backend. For monorepos this is a concrete backend leaf (see below), so pass
`scanRoot` — not the repository root — to the scanner and pin the framework id.

Programmatic use (the public API documented in the repository root README):

```ts
import { scanProject } from "@powerduck/code-to-openapi";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const entry = manifest.frameworks.express[0];
const root = `repos/${entry.dir}${entry.subdir ? "/" + entry.subdir : ""}`;

const result = await scanProject({
  root,
  frameworks: [entry.framework], // restrict to the known pack
  includeTests: false,
});

// Detection / completeness signals:
//   result.report.routesConfirmed  - high-confidence routes
//   result.report.routesPartial    - routes still carrying open gaps
//   result.report.unresolved       - unresolved count
//   result.report.gaps             // per-route open gap codes
const { document, documentValid, diagnostics } = await result.convert();
```

CLI use against one checkpoint:

```bash
npx tsx node_modules/@powerduck/code-to-openapi/examples/basic.ts \
  repos/express/danielfsousa__express-rest-boilerplate
```

When deterministic analysis cannot prove a contract (dynamic choices, computed
serializers, runtime-selected media types), the scanner must keep the gap open
as **unresolved** rather than guessing. An optional `gapResolver` plus
`aiReview: "manual"` makes those model-derived fills visible and user-acceptance
gated; see the root README.

## Monorepos and pinned subdirectories

Some checkpoints are backend leaves inside larger repositories; `subdir` pins
the exact application so unrelated frontend code is not scanned:

| Repository | `subdir` | Backend |
| --- | --- | --- |
| `mongodb-developer/mern-stack-example` | `mern/server` | Express API |
| `quarkusio/quarkus-quickstarts` | `rest-json-quickstart` | Quarkus REST (JAX-RS) |
| `jordaneremieff/starlette-svelte-example` | `backend` | Bare Starlette API |
| `eliben/code-for-blog` | `2021/go-rest-servers/stdlib-newmux` | stdlib REST server |
| `eliben/code-for-blog` | `2023/http-newmux-samples` | Go 1.22 ServeMux samples |

The two `eliben/code-for-blog` entries are independent Go modules (separate
`go.mod`) that happen to live in one repository, so they are distinct
checkpoints sharing one clone. Multi-module repositories whose backend modules
are discovered recursively (for example `aspnetrun/run-aspnetcore-microservices`
and `micronaut-projects/micronaut-starter`) intentionally keep an empty
`subdir`.

## Ecosystem notes (deliberate, honest coverage)

- **`nethttp` (Go standard library).** Before Go 1.22 (February 2024), the
  standard-library `ServeMux` could not match HTTP methods or path parameters,
  so very few full pure-`net/http` REST applications existed; the ecosystem
  relied on Gin, Chi, Echo, Fiber, and gorilla/mux. The four checkpoints
  therefore favor authoritative references rather than padding with low-value
  toys: the Go team's `jba/muxpatterns` patterns, the production-grade
  `gilcrest/diygoapi` template (zero third-party router in `go.mod`), and two
  independent standard-library modules from `eliben/code-for-blog`. Projects
  that actually import gorilla/mux, Chi, Gin, or Fiber are classified under
  those frameworks, never under `nethttp`.
- **`starlette` (bare Starlette).** Standalone applications built directly on
  Starlette have largely been displaced by FastAPI (which itself uses Starlette
  internally). The four checkpoints are the reference applications maintained by
  a Starlette maintainer (`jordaneremieff`). Repositories that instantiate
  `FastAPI()` are classified as `fastapi` even when Starlette appears in their
  dependency tree; this was verified from source, and two such candidates were
  moved out during curation.

## Selection and evaluation discipline

- Real, runnable backend APIs only — no framework/library repositories, no
  scaffolding tools, no single-endpoint tutorials.
- Prefer actively maintained projects; canonical but archived references (for
  example `r-spacex/SpaceX-API`) are kept when they remain high-quality and are
  marked `"archived": true` in the manifest.
- Framework ownership is verified from **dependency manifests**
  (`package.json`, `go.mod`, `requirements*` / `pyproject.toml`, `Cargo.toml`,
  `composer.json`, `pom.xml` / `build.gradle`, `*.csproj`), not from README
  mentions or lock files, so transitive and tooling dependencies cannot cause
  misclassification. All 135 checkpoints pass this check.
- Pinned commits are fixed independently of scanner output. Expected baselines
  must never be generated from the scanner's own results, and gaps must never be
  hidden by deleting assertions or collapsing unresolved items.
- Where a contract cannot be proven statically, record it as unresolved and use
  native/runtime evidence to settle it separately. Upstream documentation that
  contradicts runnable behavior is archived as an upstream issue, not "fixed" in
  the scanner.

## Manifest fields

Each entry records: `framework`, `repo`, `url`, pinned `commit` and `branch`,
`dir`, optional `subdir`, resolved `scanRoot`, a short `why`, plus `stars`,
`pushedAt`, `archived`, `language`, and `sizeKB` captured at collection time as
maturity context. Star counts and push dates are point-in-time snapshots and are
not used by the scanner; the pinned commit is the source of truth.

## License and attribution

All projects under `repos/` are third-party open source and remain under their
own licenses and copyrights. They are cloned locally for evaluation only and
are neither vendored into nor redistributed by this package. Please visit each
repository (linked in `manifest.json`) for its license and terms.
