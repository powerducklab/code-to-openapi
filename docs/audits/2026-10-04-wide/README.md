# Cross-framework hardening and explicit coverage inventory

This iteration is **not complete and does not certify 9.5/10 accuracy**.
`coverage.json` records each of the 28 pinned real GitHub samples separately:
10 have partial independent contract comparisons, 18 still lack such an oracle.
No full backend runtime certification was performed. Structural scan success must
not be counted as independent field verification.

## Fixes

- Go: proven builtin len of slices/arrays/maps/channels/strings produces a
  nonnegative integer response schema, including constructor-assigned local
  values. Same-name declarations conservatively block builtin inference.
- Express: inspect resolvable ordinary three-argument middleware for explicit
  responses, preserving same-status alternatives. Four-argument error handlers
  are excluded from ordinary argument interpretation.
- Express: middleware ownership is Router-specific rather than file-wide.
  A private Router's middleware no longer leaks into public routes declared in
  the same file. Locally registered middleware after a route is excluded.
- JAX-RS: preserve text/plain, text/xml and literal @Produces media types.
  A method that only throws no longer claims a successful 200 entity response;
  unresolved exception mapping remains an explicit response gap.

## Independent evidence

28 pinned projects scanned: 544 operations, no scan execution failures. The scan
snapshot was taken before final Router scoping/JAX-RS corrections; net/http and
JAX-RS were re-scanned separately for their stored contract results.

| Contract | Assertions | Differences |
| --- | ---: | ---: |
| Fastify | 626 | 0 |
| Actix | 84 | 0 |
| FastEndpoints | 336 | 0 |
| Rocket | 112 | 0 |
| Spring/Petclinic | 5523 | 1 |
| Gin | 264 | 93 |
| Echo | 1096 | 281 |
| Fiber upstream | 171 | 56 |
| net/http | 442 | 72 |
| JAX-RS source-known (new) | 57 | 3 |

The JAX-RS oracle was independently authored from GreetingResource, ExampleModel,
ExceptionHandler and BadRequestException at the pinned commit. It checks five
operations and declared DTO fields, not full nullability/serialization semantics.
Its failures remain: two request-body presence disagreements and the missing
explicit mapped 400 response. No baseline was relaxed to hide these failures.

## Remaining acceptance work

- Independent all-field oracles for the 18 samples marked missing.
- Full middleware/exception mapping semantics across frameworks, including
  registration order across mounts and framework global filters.
- Go general arithmetic, len shadow resolution precision, nullable containers.
- Java exception mapper execution paths and input presence rules.
- Adjudication of source/Swagger required differences and runtime verification
  for serializers, dependency injection, generated code and database responses.

No aggregate accuracy score is reported: the samples and assertions are not an
unbiased all-framework ground truth and coverage remains incomplete.
