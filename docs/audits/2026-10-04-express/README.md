# Express native router and computed serializer audit

Pinned upstream: https://github.com/gothinkster/node-express-realworld-example-app.git
Commit: `30b68e1e881462b2f4164ea09ab4c4f5699c7b0b`.

`examples/audit-express-runtime.mjs` executes original routers with native Express
4.22.3 (within upstream's 4.x range), original article/author/profile mappers, and
original `getCurrentUser` with an isolated Prisma selection double. Controller
statuses/envelopes and Prisma nullable columns are independently transcribed.
Database, auth, bcrypt and JWT boundaries are doubles. No scanner output builds
the baseline. Comment and error branches are not fully covered.

Latest recorded baseline: **579 assertions, 217 differences**. This is an open
accuracy gap, not a passing certification. Query numeric conversion versus wire
string types needs independent validation; several mapper leaves remain unknown
because source uses `any` and generated Prisma declarations are absent.

Corrections follow symbol-resolved local serializers, preserve selected Prisma
keys rather than leaking full cast entities, retain null/undefined information,
and mark escaping/mutated values as unknown. Missing ORM field types are not
invented. Input and output validation are not interchangeable.

```sh
node examples/audit-express-runtime.mjs /tmp/realproj2-express-rw docs/audits/2026-10-04-express/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-express-rw /tmp/pd-express-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-express/baseline.json /tmp/pd-express-current.json docs/audits/2026-10-04-express/result.json
```
