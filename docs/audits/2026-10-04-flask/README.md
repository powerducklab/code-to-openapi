# Flask / APIFairy native contract audit

Upstream: https://github.com/miguelgrinberg/microblog-api
Pinned revision: `e250d7115b47010ff0e7051d5868485fff4e32fb`.

The baseline is the original application's `/apispec.json`, produced by APIFairy
1.4.0, Marshmallow 3.21.3 and the full upstream requirements lock under Python
3.12. `examples/audit-flask-runtime.py` imports the original TestConfig, which
uses in-memory SQLite, and invokes Flask's test client. No scanner output is
used to construct the expected contract.

Validation:

- 16 documented paths, 13 components; 1673 contract assertions, zero mismatches.
- 44 original upstream pytest tests passed (8.32 seconds). Database is in memory;
  email and OAuth use the upstream tests' mocks. No external service certification.
- Six upstream 204 responses incorrectly declare content; recorded separately in
  `result.json.baselineIssues`. Scanner output remains bodyless.
- Comparator now recognizes OAS 3.0 nullable type notation and preserves `$ref`
  sibling annotations. Neither change removes field assertions.

Repairs: keyword response statuses, explicit `many=False`, field aliases,
readOnly/writeOnly, lengths, SQLAlchemy Mapped column types, partial request
schemas, and verified pagination schema factories. Python scalar schemas now
return fresh objects to prevent constraints leaking between unrelated fields.

```sh
/tmp/pd-flask312/bin/python examples/audit-flask-runtime.py /tmp/realproj-microblog docs/audits/2026-10-04-flask/baseline.json
PYTHONPATH=/tmp/realproj-microblog /tmp/pd-flask312/bin/python -m pytest /tmp/realproj-microblog/tests -q
node --import tsx examples/scan-audit-project.ts /tmp/realproj-microblog /tmp/flask-scan.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-flask/baseline.json /tmp/flask-scan.json /tmp/flask-audit.json --strict
```

Limits: generated API contracts may themselves omit middleware/runtime behavior.
Extra undocumented fields and statuses are not exhaustively checked by the
comparator. Arbitrary custom serializers, validators, inheritance, same-name
classes across files and decorators outside recognized patterns remain open.
This is not a whole-framework 9.5/10 certification. Coverage now records 18
partial independent baselines and 10 frameworks without independent baselines.
