# Axum / native Serde contract audit

Pinned source: https://github.com/launchbadge/realworld-axum-sqlx.git
Commit `f1b25654773228297e35c292f357d33b7121a101`.

`examples/audit-axum-runtime.py` compiles the original Serde DTO declarations and
original `Timestamptz` Serialize/Deserialize implementation in an isolated crate.
Only the unrelated `sqlx::Type` derive is removed. Dependencies are pinned to
serde 1.0.130, serde_json 1.0.72 and time 0.2.27. It executes actual serialization,
omitted-field deserialization probes, optional/null updates and required arrays.
`examples/audit-axum-baseline.py` independently binds that native evidence to the
19 routes and success statuses transcribed from the pinned router/handler source.
No scanner result is used to build this baseline.

Before: **766 assertions / 352 differences**.
After: **766 assertions / 0 differences**.

Corrections include Serde container rename/default handling, default generic
arguments, separate input/output requiredness, newtype scalar serialization,
fixed-length heterogeneous tuples, and proven custom string serialization.
Unresolved custom serializers remain review gaps rather than fabricated arrays.

```sh
python3 examples/audit-axum-runtime.py /tmp/realproj2-axum-app-realworld /tmp/pd-axum-oracle docs/audits/2026-10-04-axum/native.json
python3 examples/audit-axum-baseline.py
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-axum-app-realworld /tmp/pd-axum-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-axum/baseline.json /tmp/pd-axum-current.json docs/audits/2026-10-04-axum/result.json
```

Limits: no original Axum HTTP server, SQLx database, auth extractors or error
middleware execution. Representative native values establish serialized field
names/types/presence, not all possible business branches. No framework-wide 95%
certification is claimed. Cargo.lock is generated in the isolated oracle crate.
