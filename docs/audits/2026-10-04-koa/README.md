# Koa native route, validation and serializer audit

Pinned upstream: https://github.com/gothinkster/koa-knex-realworld-example.git
Commit: `602e234139c453825eb3939cf24bdf00fc164e0e`.

`examples/audit-koa-runtime.mjs` executes original route modules using Koa 2.6.2
and koa-router 7.4.0, original Yup 0.26.6 schemas and the original registration
controller in a native Koa context. Database insertion, password hashing and JWT
signing use explicitly isolated doubles. No scanner result builds the baseline.

19 explicit routes (implicit HEAD excluded), user registration request validation
and returned user fields: **115 assertions, zero differences**. Before correction,
all 19 route paths lost the `/api` mount. Corrections resolve CommonJS middleware
exports, `del`, nested controller exports, installed schema registries, conditional
Yup validation and computed local serializers. Regression tests check field
deletion/replacement after validation, defaults, arrays and unknown contexts.

```sh
node examples/audit-koa-runtime.mjs /tmp/realproj2-koa-rw /tmp/pd-koa-oracle docs/audits/2026-10-04-koa/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-koa-rw /tmp/pd-koa-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-koa/baseline.json /tmp/pd-koa-current.json docs/audits/2026-10-04-koa/result.json
```

Partial coverage: other response serializers, database/auth behavior, paging,
error branches and middleware contracts remain unverified. Custom Yup predicates
and transforms are review gaps, not silently certified. Assertion agreement is
not a framework-wide precision score or a 95% certification.
