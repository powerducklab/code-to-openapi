# Go response branches and query helpers

Independent upstream baselines from `2026-10-04-hardening` were retained unchanged.

| Project | Before mismatches | After mismatches | Current assertions |
| --- | ---: | ---: | ---: |
| net/http template | 107 | 79 | 442 |
| Echo RealWorld | 289 | 281 | 1096 |

The assertion count increases when previously absent parameters become available
for field-level checking. These counts are not an overall accuracy percentage.

Implemented:
- Inline and nested response maps resolve service-returned variables using the shared Go type resolver.
- net/http follows package-resolved helper calls receiving the original request to extract direct query reads. Cycles, depth and total visited helpers are bounded. Request reassignment cancels inference; unrelated uncalled helpers are excluded.
- Direct strconv.Atoi use in those helpers yields integer query types when its import is verified. Defaults and numeric bounds are not inferred from fallback assignment.
- Echo uses the same payload resolver; JSON null is preserved. Same-status JSON branches retain alternative schemas, and unproven status codes use `default` with an explicit gap rather than fabricating 200.

Regression fixtures cover nested map DTO lists, recursive query helpers, unrelated
helpers, Echo null alternatives and dynamic statuses.

Outstanding limitations include query aliases inside helper functions, generic and
embedded interface methods, middleware response contracts, response map computed
scalar expressions, nil slice semantics and adjudication of upstream Swagger
required/format differences. This remains an incremental audit; it does not certify
all languages/frameworks as complete or at a 9.5/10 quality level.
