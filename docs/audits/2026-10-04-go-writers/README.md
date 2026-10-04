# Go writer and middleware independent contracts

Overall certification remains incomplete. Coverage now includes 14 partial
independent project contracts; 14 other project oracles remain missing.

## Evidence

- Gorilla/Mux tutorial: 159 assertions, zero differences, strict audit passed.
- Chi notes API: 120 assertions, zero differences, strict audit passed.

Both baselines were manually authored from the pinned GitHub source files named
in their x-audit-source metadata. They were not derived from scanner output.
Limitations, including unenumerated DB-helper exception branches, remain explicit.

The original Gorilla model.go was also compiled with gorilla-dto-runtime.go using
Go, module mode and network disabled. JSON decoding `{}` succeeds and encoding
outputs exactly `{"id":0,"name":"","age":0}`. This validates field presence for
this actual DTO; it is not a full backend/database runtime test.

## Fixes

- Go JSON writer recognition handles Marshal followed by Write and bounded
  forwarding wrappers; status and payload provenance are checked.
- Gorilla/Mux and Chi resolve receiver methods by package/type instead of picking
  an unrelated same-name function.
- net/http, Gorilla/Mux and Chi keep input components separate from output.
- Chi recognizes registered group middleware HTTP errors and scopes them to the
  registration; uncalled nested closures are excluded from error evidence.
- Chi applies basic input validation tags only with a proven validator receiver
  and a checked error that prevents continuation; ignored validation is excluded.
- Single-assignment parameter aliases followed by standard strconv conversions
  preserve integer wire parameter types.

Unresolved: general middleware factories/mount propagation, arbitrary helper
control flow, complete validator rules, custom serialization and all other
framework/runtime acceptance work. Zero differences for these limited baselines
does not certify 9.5/10 all-framework quality.
