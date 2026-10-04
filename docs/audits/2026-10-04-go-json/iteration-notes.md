# Additional cross-framework response hardening

- Package-scoped Go components preserve distinct imported structs with the same
  simple name, including nested references. Verified with net/http, Chi, Gin,
  Echo and Fiber. Aliases reserve existing user type names to prevent collisions.
- Gin no longer strips package qualification and binds the first matching model.
  Fiber now handles qualified struct literals instead of omitting their response.
- Same-status Gin, net/http and Chi JSON responses retain all observed shapes.
  The shared response merger preserves media types, unknown alternatives and
  constraints alongside anyOf; it does not modify the input response.
- Ordinary Go assignments now read their right-hand side. Constructor following
  requires a single definite write before serialization; conditional, overwritten
  and future assignments are not treated as proven response payloads.

Focused fixtures are in `test/go-scoped-components.test.ts`,
`test/go-response-variants.test.ts`, `test/gin-response-variants.test.ts`,
`test/go-json-wire.test.ts`, and `test/response-variants.test.ts`.
These complement, rather than replace, the native encoding/json, Chi validation
and original Gin DTO evidence in this directory. Successful fixture tests do not
establish complete business-branch coverage for the pinned GitHub applications.
