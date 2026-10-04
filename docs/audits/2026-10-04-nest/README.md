# NestJS independent contract and service-flow audit

Repository: https://github.com/lujakob/nestjs-realworld-example-app.git
Commit: `c1c2cc4e448b279ff083272df1ac50d20c3304fa`.

The executable `examples/audit-nest-runtime.mjs` loads original TypeScript via
`transpileModule`, uses native Nest 7.0.5 decorators/metadata, class-validator
0.11.1, class-transformer 0.2.3 and the original custom ValidationPipe. It obtains
21 routes and native default statuses from runtime metadata, rejects missing
create fields through the original pipe, and executes `UserService.findByEmail`
and its original `buildUserRO` serializer against an isolated repository double.
The independent contract also transcribes the seven query accesses in the two
original article service methods. No scanner output is used to build the baseline.

Before: 163 checks, 17 differences (string media type, seven service query fields,
missing returned user id and incorrect image requiredness).
After: **177 checks, zero differences** on this limited baseline.

Repairs follow symbol-resolved local implementations with bounded recursion,
prefer explicit serialized shapes over weaker return interfaces, fill unknown
leaves from annotations without reintroducing omitted fields, and exclude nested
callback return statements. Query object propagation follows service arguments
and lexical const aliases. Unknown query handling remains a review gap because
property discovery alone does not prove complete input validation.

```sh
node examples/audit-nest-runtime.mjs /tmp/realproj-nest-realworld /tmp/pd-nest-oracle docs/audits/2026-10-04-nest/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj-nest-realworld /tmp/pd-nest-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-nest/baseline.json /tmp/pd-nest-current.json docs/audits/2026-10-04-nest/result.json
```

Limits: ORM decorators/repository, JWT signing and password hashing are isolated
stubs. No database, JWT verification, application middleware, full HTTP lifecycle,
all response branches or full article/comment serialization is runtime-validated.
TypeScript field types are documented contracts, not proof of runtime rejection
of every other JSON type. This does not certify framework-wide 95% accuracy.
