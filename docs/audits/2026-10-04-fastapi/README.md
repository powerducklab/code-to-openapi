# FastAPI independent model contract audit

Upstream: https://github.com/nsidnev/fastapi-realworld-example-app
Pinned revision: `029eb7781c60d5f563ee8990a0cbfb79b244538c`.

The independent baseline executes the original upstream model files with the
Pydantic v1 compatibility runtime (1.10.21). Route bindings were transcribed from
upstream handlers, not generated from scanner output. Runtime field metadata
supplies nullable types omitted from Pydantic v1 JSON Schema; actual serialized
Profile and Article values verify defaults and aliases. This does not execute
the backend, database, authentication or middleware.

Current baseline: 19 operations, 17 schema components, 795 assertions, zero
mismatches. This covers success contracts only, not overall framework precision.

Corrections include all router mounts, cycle bounds, settings prefix defaults
with explicit dynamic-path uncertainty, embedded and multiple body bindings,
input/output schema separation, default output requiredness, field aliases,
nullable references and URL constraints. Response exclusion and alias policies
use separate schema variants. Unknown exclusion expressions remain gaps.

Reproduce:

```sh
python3 examples/audit-fastapi-models.py /tmp/realproj-fastapi-realworld docs/audits/2026-10-04-fastapi/baseline.json /tmp/pd-fastapi-oracle-deps
node --import tsx examples/scan-audit-project.ts /tmp/realproj-fastapi-realworld /tmp/fastapi-scan.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-fastapi/baseline.json /tmp/fastapi-scan.json /tmp/fastapi-audit.json --strict
```

The isolated oracle dependency directory contains email-validator 1.3.1 and its
dependencies. Pydantic v1 compatibility is not a substitute for independently
validating Pydantic v2 semantics. Arbitrary alias generators, custom serializers,
dynamic environment values, computed response branches and security contracts
still require broader verification. The coverage snapshot has 17 partial
independent baselines and 11 frameworks without one; no 9.5/10 certification is
claimed.
