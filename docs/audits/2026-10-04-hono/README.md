# Hono native contract oracle

Pinned https://github.com/bedstack/hono-prisma-realworld-example revision
`4dc311ebdaeaa1cbffbb5608fae7d33f5baa9208`.

`examples/audit-hono-runtime.mjs` bundles the unmodified upstream route and Zod
modules. Mounts are transcribed from the original controllers/core app. Native
OpenAPIHono 0.19.9 with Hono 4.8.4 and Zod 3.25.76 generates the baseline: 7 API
operations on 5 paths. Business handlers are replaced with a sentinel; database
and authentication middleware are NOT executed. Native request validation
confirms that an omitted optional JSON body passes while supplied invalid JSON
fails. These checks explain the default requiredness correction.

Results: 250 contract assertions, zero mismatches. Before repair all seven
mounted operation paths were missing: unresolved createApp factories lost
prefixes, and several root paths collided. The scan now proves constructors
through factory return values, overload implementations, barrel/path-alias
imports, fluent route chains and repeated mounts. Unrelated factory names and
openapi() methods do not establish Hono identity.

```sh
npm install --prefix /tmp/pd-hono-oracle --ignore-scripts --no-audit --no-fund @hono/zod-openapi@0.19.9 hono@4.8.4 zod@3.25.76
node examples/audit-hono-runtime.mjs /tmp/realproj2-hono-rw /tmp/pd-hono-oracle docs/audits/2026-10-04-hono/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-hono-rw /tmp/hono-scan.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-hono/baseline.json /tmp/hono-scan.json /tmp/hono-audit.json --strict
```

Limits: factory-internal parameterized registrations, arbitrary middleware,
dynamic mounts, computed business responses and extra undocumented fields still
need independent verification. This is a partial audit, not whole-framework
9.5/10 certification. Coverage now contains 19 partial baselines and nine missing
independent framework baselines.
