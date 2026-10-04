# Elysia / ArkType independent contract audit

Upstream: https://github.com/bedstack/elysia-drizzle-realworld-example at
`f642e24f8703cf61c66890dda4979fc55f442a4e`.

`examples/audit-elysia-runtime.mjs` executes the upstream DTO modules with native
ArkType 2.2.3 and arkregex 0.0.5. The 19 controller method/path bindings are
independently transcribed from upstream controllers. The baseline is generated
from native `toJsonSchema({fallback: ctx => ctx.base})`, matching upstream's
OpenAPI converter. It is not derived from scanner output. Native validation
also verifies partial update acceptance and rejection of invalid create input.

The original scan lost `/api` for all 19 operations. Lexical application/plugin
identity now resolves cross-file factory returns, group mounts, constructor
prefixes and repeated mounts. The current baseline has **781 assertions, zero
mismatches**, compared with all 19 paths missing before repair. Regression tests
also cover cycle termination, numeric bounds, union preservation and unknown
field retention.

Reproduce (dependencies isolated from the audited repository):

```sh
node examples/audit-elysia-runtime.mjs /tmp/realproj2-elysia-rw /tmp/pd-elysia-oracle docs/audits/2026-10-04-elysia/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-elysia-rw /tmp/pd-elysia-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-elysia/baseline.json /tmp/pd-elysia-current.json docs/audits/2026-10-04-elysia/result.json
```

## Limits

The native OpenAPI fallback drops constraints on transformed values. In particular,
numeric query strings can have post-parse integer/range checks which JSON Schema's
string domain cannot directly express. The scanner now emits an explicit unresolved
warning for these constraints instead of claiming full accuracy. Business handlers,
authentication middleware, database behavior and arbitrary plugin factories are
not runtime-validated here. This is a partial independent audit, not a 95% overall
framework accuracy certification. Unsupported ArkType operations retain an unknown
contract rather than silently returning the unmodified input schema.

Follow-up: explicit literal `omit`/`pick` projection is now modeled before array construction. The native original DTO baseline was rerun unchanged. Unsupported dynamic keys continue to produce an unresolved schema rather than leaking removed fields.
