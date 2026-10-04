# New-batch generality audit — 2026-10-05

Fresh batch of **real open-source applications**, each pinned to a commit and
scanned with an **empty ledger**. Roots point at a coherent application (or a
clean example sub-app), never a library monorepo root. This is independent of
the 2026-10-04 batch and exists to prove the scanner is generic rather than
tuned to the first sample set.

## Method

- Samples and pinned commits: [`projects.json`](./projects.json).
- Scan: `node --import tsx examples/scan-audit-project.ts <root> <out.json>`.
- Score: `python3 examples/audit-new-batch-scorecard.py --scans <dir>
  --manifest docs/audits/2026-10-05-new-batch/projects.json --out
  docs/audits/2026-10-05-new-batch/results/scorecard.json`.
- Unknown / unprovable contracts count as **incorrect** in the deterministic
  score and are reported separately. They are never silently filled.

## Results (this revision)

| Axis | Result |
| --- | --- |
| Route recall | **1.00** |
| Route precision | **1.00** |
| Request completeness (body/query/params) | **1.00** |
| Response completeness, deterministic | **0.82** |
| Routes routed to interactive AI review | 52 |

Per-project route discovery is exact (no missing or spurious routes after the
CORS-preflight fix). Every request body/query/path contract that the source
proves is recovered. The remaining ~18% of **response** contracts are opaque
ORM/service/serializer returns the deterministic pass honestly cannot prove
(Mongoose documents in the Express app, TypeORM entities in Nest, conditional
API Resources / pagination wrappers in Laravel, one FastAPI computed model).

These are **not** guessed. They are surfaced as per-route gaps to the
interactive AI gap review, where the model proposes a schema with a rationale,
the user **accepts / edits / rejects** each fragment, and every accepted
fragment is merged with `x-ai-inferred: true`. Verified end-to-end on the
Express app: 13 pending reviews; accepting the `GET /v1/users/{userId}`
proposal closes `response-schema-unknown` and merges exactly the proposed
fields (password omitted as `select:false`); rejecting `POST /v1/auth/login`
leaves its gap open.

### Per-project snapshot

| Project | Framework | Routes | Deterministic complete |
| --- | --- | --- | --- |
| fiber-todo-gorm | fiber | 8/8 | 8/8 |
| chi-todos-resource | chi | 14/14 | 14/14 |
| chi-rest | chi | 13/13 | 12/13 (panic→500 path) |
| axum-kv | axum | 3/3 | 3/3 |
| actix-json | actix | 4/4 | 4/4 |
| rocket-serialization | rocket | 6/6 | 6/6 |
| flask-restx-zoo | flask | 4/4 | 4/4 |
| fastapi-fullstack/backend | fastapi | 23/23 | 22/23 |
| nest-boilerplate | nest | 19/19 | 9/19 (10 TypeORM → AI review) |
| express-boilerplate | express | 14/14 | request 14/14; 13 Mongoose responses → AI review |
| laravel-blog | laravel | 75/75 | 39/75 (conditional resources/web → AI review) |

## Generic fixes landed and proven on this batch

- **Go cross-package handler resolution** — `services.CreateTodo` no longer
  resolves to a same-named `dal.CreateTodo`; package qualifier disambiguates
  (fiber/echo/net/http; chi/gorilla already package-aware).
- **chi mounted resource factories** — `r.Mount("/todos", res{}.Routes())`
  across files, nested `r.Route("/{id}", …)` groups, and captured receivers in
  closures (1 → 14 routes on todos-resource).
- **flask-restx code-first contracts** — `api.model`, `marshal_with`,
  `marshal_list_with`, `expect`, `response` (zoo 0 → 4/4).
- **axum** unit `()` returns → empty 200; **rocket** `json!` macro responses;
  **Laravel** namespaced/aliased resource controllers, FormRequest rule types,
  aliased API Resources + `::collection()`, Eloquent convention fields;
  **Express** data-driven mounts, CommonJS controllers, Joi/celebrate bodies,
  CORS preflight suppression; **Nest** framework false-positive gating.

## Remaining to clear the 0.96 response axis deterministically

1. Mongoose schema extraction + service-return data flow (Express), respecting
   `select:false`/projections so unreturned fields never leak.
2. TypeORM entity → service-return data flow (Nest).
3. Laravel conditional `when()`/loaded-relation resource fields, pagination
   and comment/user resources; web view/redirect responses.
4. Expand the batch to the remaining frameworks (DRF, Spring, ASP.NET,
   FastEndpoints, Next.js, Symfony, Slim, Fastify, Hono, Elysia, Koa, Flask,
   Starlette, Micronaut, …) with independent code-first/runtime baselines.
5. Bidirectional false-positive/false-negative comparator metrics and the
   unified 9.6 acceptance definition (P1-20/P1-22).

Items 1–3 are the same class of opaque-return contract the interactive AI
review is designed to close with the user in the loop; deterministic inference
is added where it can be proven without leaking fields.
