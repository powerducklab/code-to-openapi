# Django REST Framework official runtime audit

Additional primary sample: https://github.com/encode/rest-framework-tutorial
Pinned commit: `c338449d616f613fdcbfa4ea368cdf163a0f183d`.
Uses its pinned Python 3.13 / Django 6.1.1 / DRF 3.18.1 /
drf-spectacular 0.30.0 dependencies. The previously pinned RealWorld sample uses
Django 1.10.5 and remains a separate, unfinished contract audit.

`examples/audit-drf-runtime.py` executes original views/models/serializers using
in-memory SQLite. It verifies creation (201), partial update (200), invalid
request (400), paginated listing (200), HTML highlighting (200), deletion (204)
and exact created/listed field sets. User authentication is injected in this
lifecycle test; authentication middleware is not certified.

The original generated contract is kept as `baseline-native.json`. The runtime
validated baseline changes ONLY the highlight schema to string: the native
generator incorrectly inherited the JSON serializer for an HTML action.
`SCHEMA_COERCE_PATH_PK=False` preserves actual router kwarg `pk`, avoiding the
native generator's cosmetic renaming to `id`; URL matching behavior is unchanged.

Current result: **654 assertions, 57 mismatches**, NOT a completed framework audit.
Remaining differences include dynamic Pygments enum values from external runtime
calls, Django's external auth.User model fields, and source-mapped read-only
fields. These must not be represented as a 9.5/10 success. The comparator also
cannot certify extra undocumented fields or all middleware behavior.

Fixes covered by regressions: ReadOnlyModelViewSet route generation, declared
model fields/constraints, explicit read/write-only flags, global page-number
pagination, PATCH partial schemas, default JSON/form/multipart request media,
integer PK fields when proven by the model, and HTML action media. Dynamic model
choices now produce explicit schema gaps instead of falsely complete contracts.

```sh
/tmp/pd-drf313/bin/python examples/audit-drf-runtime.py /tmp/pd-drf-official docs/audits/2026-10-04-drf/baseline.json
node --import tsx examples/scan-audit-project.ts /tmp/pd-drf-official /tmp/drf-scan.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-drf/baseline.json /tmp/drf-scan.json /tmp/drf-audit.json
```
