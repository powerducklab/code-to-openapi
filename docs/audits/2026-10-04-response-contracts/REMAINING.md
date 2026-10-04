# Remaining independent contract verification

Status: **incomplete**. No 9.5/10 accuracy certification is justified.

Latest verification: 423 regression tests / 157 files pass; TypeScript/bundle build passes; distribution and worker-thread smoke tests pass. All 28 pinned project scans emit structurally valid documents. Samples and expected baselines were not modified.

| Framework | Assertions | Differences |
|---|---:|---:|
| express | 579 | 217 |
| nest | 177 | 0 |
| hono | 250 | 0 |
| koa | 115 | 0 |
| elysia | 781 | 0 |
| fastapi | 795 | 0 |
| flask | 1673 | 0 |
| djangorestframework | 654 | 57 |
| gin | 264 | 93 |
| nethttp | 442 | 98 |
| gorillamux | 159 | 1 |
| echo | 1096 | 400 |
| fiber | 170 | 1 |
| spring | 5616 | 94 |
| jaxrs | 57 | 2 |
| aspnet | 739 | 27 |
| fastendpoints | 334 | 0 |
| axum | 766 | 0 |
| actix | 84 | 0 |
| rocket | 112 | 0 |
| laravel | 571 | 0 |
| symfony | 113 | 0 |
| slim | 56 | 1 |
| fastify | 626 | 0 |
| chi | 120 | 0 |
| micronaut | 79 | 0 |
| starlette | 65 | 1 |
| nextjs | 118 | 1 |

## Interpreting differences

- JAX-RS: two remaining nullability differences are contradicted by six native request probes in `../2026-10-04-java-native/jaxrs-empty-body.json`; absent/null bodies are accepted. Requiredness defects were corrected. Preserve the upstream baseline for traceability.
- Spring: independently observed validation boundaries contradict parts of the upstream OAS. See the Java native audit; do not make the scanner reproduce documented constraints that native code does not enforce.
- Echo: several documented error objects are literal JSON null in original handlers; request validation is custom, and output presence/nullability differs from the upstream OAS. Differences still require field-level classification, not bulk dismissal.
- Fiber/Gorilla: remaining array/null differences require proving successful repository return paths; Go slice types alone cannot prove non-null.
- Next.js: Stripe SDK signature requirements still need a registered SDK/validator contract; a header read alone does not prove requiredness.
- Slim/Starlette: registered exception/middleware behavior remains unresolved; debug mode can change response media.
- Express/DRF/Gin/net-http/ASP.NET: computed values, external/generated models, custom validation and serialization still need independent contract checks. Detailed field differences are retained in `results/`.

## Completion gate

Every difference must be fixed or supported by independent native evidence. Zero differences against a partial baseline does not establish complete route/field recall. Native middleware, conditional branches and computed responses remain partial across the framework set. No baseline was rewritten to make a scanner result pass.
