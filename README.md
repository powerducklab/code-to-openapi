# @powerduck/code-to-openapi

[![npm version](https://img.shields.io/npm/v/@powerduck/code-to-openapi)](https://www.npmjs.com/package/@powerduck/code-to-openapi)
[![license](https://img.shields.io/npm/l/@powerduck/code-to-openapi)](https://github.com/powerducklab/code-to-openapi/blob/main/LICENSE)

Scan a local backend codebase and reverse-engineer a validated **OpenAPI 3.2**
document. Extraction is deterministic by default: routes are proven through
framework instance tracing and AST analysis, never guessed. An optional AI gap
resolver fills only the specific pieces the static engine could not prove.

Part of the [Powerduck](https://www.powerduck.com/) toolchain — one local
OpenAPI spec for design, debug, test, mock, documentation and MCP serving.

---

## How it works

```
indexer  →  language packs (AST + type checker)
         →  framework packs (route graphs, handlers)
         →  completeness gate (proven / proven-empty / gap)
         →  Discovery IR  →  validated OpenAPI 3.2
```

- **Language-neutral core.** File indexing, route signature matching, a common
  type model, handler exit tracing and the completeness gate are shared.
  Language and framework packs only add evidence.
- **Framework instance tracing.** The engine follows `import`/`export` graphs
  to prove that a call target is the real `express()` app or `express.Router()`
  instance. Lookalikes such as `cache.get(...)` are never mistaken for routes,
  and routers that are never mounted are reported as unreachable instead of
  emitted.
- **Type-first schemas.** In TypeScript projects the compiler checker resolves
  generics (`Response<User[]>`, `Request<Params, ResBody, ReqBody, Query>`),
  named interfaces, enums, utility types (`Partial`/`Pick`/`Omit`) and Zod
  schemas. Named declarations become `components.schemas` with `$ref`s;
  anonymous shapes stay inline.
- **Completeness is a hard gate.** Every parameter, request body and response
  is one of: proven with evidence, proven absent, or an explicit **gap**. A
  route is never emitted as a bare URL with empty contracts.
- **AI only fills gaps.** The host may supply a resolver. It receives small
  per-handler slices for specific gap codes; it can never invent a route,
  method or path. Source code is never sent anywhere by default.
- **Incremental by design.** A `.powerduck/discovery.json` sidecar fingerprints
  files and routes so rescans diff added/changed/removed routes; user edits to
  the generated document are preserved by the host through JSON Patch.

### Framework support

| Language   | Framework | Status |
| ---------- | --------- | ------ |
| TypeScript / JavaScript | Express | 0.1.x |
| TypeScript / JavaScript | Fastify, NestJS | Planned |
| Python     | FastAPI, Flask | Planned |
| Go         | Gin, Chi | Planned |

HTTP is fully supported; SSE endpoints are emitted with the canonical
`x-protocol: "sse"` extension and a `text/event-stream` media type carrying
`itemSchema`.

---

## Install

```bash
npm install @powerduck/code-to-openapi
# TypeScript projects benefit from an optional peer dependency:
npm install -D typescript
```

The package ships ESM and CJS builds and runs on Node.js 18+.

## Quick start

```ts
import { scanProject } from "@powerduck/code-to-openapi";

const result = await scanProject({ root: "/path/to/your/api/project" });

console.log(
  `${result.report.routesConfirmed} confirmed, ` +
    `${result.report.routesPartial} partial routes`,
);

const { document, documentValid, diagnostics } = await result.convert();
console.log("OpenAPI 3.2 valid:", documentValid);
```

`document` is a validated OpenAPI 3.2 object. `result.project` is the
intermediate Discovery IR; `result.report.gaps` lists exactly what could not be
proven statically.

Run the bundled example against any Express project:

```bash
npx tsx node_modules/@powerduck/code-to-openapi/examples/basic.ts ./my-api
```

## Scan options

```ts
await scanProject({
  root: "./api",
  ignore: ["legacy/**"], // merged with .gitignore / .powerduckignore
  includeTests: false, // include test and fixture files (default: false)
  frameworks: ["express"], // restrict framework packs
  maxFileBytes: 2 * 1024 * 1024, // per-file cap (default 2 MiB)
  gapResolver, // optional; omit for fully deterministic output
});
```

## Optional AI gap resolver

The scanning package never calls a model vendor itself. Wire your own provider
(the desktop app does this behind an explicit opt-in):

```ts
import type { GapResolver } from "@powerduck/code-to-openapi";
import { gapCacheKey } from "@powerduck/code-to-openapi";

const resolver: GapResolver = {
  id: "my-provider",
  async resolve(request) {
    // request.gaps names the missing pieces, request.handlerSource is a
    // small handler slice, request.known lists what AST already proved.
    // Return only the fragments you can justify from the slice.
    return {
      bodySchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      confidence: "medium",
      rationale: "Handler validates req.body.name before persisting.",
    };
  },
};

// Cache per handler so unchanged code consumes zero tokens:
const key = gapCacheKey(request, "prompt-v1");
```

Gap codes include `query-unknown`, `body-schema-unknown`,
`response-schema-unknown` and `sse-events-unknown`.

## Incremental rescans

```ts
import {
  diffSidecars,
  affectedFiles,
  type DiscoverySidecar,
} from "@powerduck/code-to-openapi";

const diff = diffSidecars(previousSidecar, currentSidecar);
// diff.addedFiles / changedFiles / removedFiles
// diff.routeChanges: added | changed | removed, keyed by `${METHOD} ${path}`
const reanalyze = affectedFiles(diff);
```

The sidecar is the only place scan provenance is stored. The generated OpenAPI
document stays clean and is safe for users to edit; removed routes are flagged
for review rather than deleted automatically.

## Confidence and gaps

Every operation carries a confidence level:

- `high` — framework trace plus types/literals prove the contract.
- `medium` — route and shape are proven but some schema detail is inferred.
- `low` — only syntactic evidence exists; gaps describe what is missing.

Unresolvable constructs (dynamic route expressions, orphan routers) appear in
`project.unresolved` / `diagnostics` instead of being guessed.

## License

MIT © Powerduck limited. See [LICENSE](./LICENSE).

Website: [https://www.powerduck.com/](https://www.powerduck.com/)
