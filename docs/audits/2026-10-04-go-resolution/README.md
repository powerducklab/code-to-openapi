# Go contract resolution follow-up

This is an incremental audit, not a claim of 95% overall accuracy or completion.
The pinned upstream sources and baseline provenance are recorded in the preceding
`2026-10-04-hardening` audit. Baselines were not relaxed to improve these results.

| Baseline | Assertions | Previous mismatches | Current mismatches |
| --- | ---: | ---: | ---: |
| Echo RealWorld | 1096 | 492 | 289 |
| net/http template | 435 | 240 | 107 |

Changes: resolve declared multi-value Go return types through AST result fields;
resolve service interface methods through receiver field types; restrict function
lookup to its package and receiver instead of the first matching global name;
honor anonymous struct JSON tags, exported fields and skip tags; resolve nested
imported DTOs; use shared result inference for direct net/http JSON encoders.
Opaque Chi renderer slice results still fall back to concrete constructor bodies.

Regression coverage includes an interface service returning `(User, error)`, a
nested anonymous JSON struct, private/skipped fields and existing Chi render lists.

Remaining: helper-derived query parameters, identifiers inside map response
literals, middleware-generated responses, and independent adjudication of source
versus upstream Swagger required/nullability differences. These mismatch counts
are contract assertions, not route recall or an overall accuracy score. All-language
and all-framework production readiness remains unproven.
