# PHP contract and robustness audit

The pinned Slim Skeleton baseline was authored independently from its route,
controller, DTO and error-handler sources. Current differences remain in
inherited action dispatch, response-wrapper data flow and exception contracts.
See `slim-result.json`; do not interpret schema validity as contract completeness.

Implemented and regression-tested:

- Preserve nullable and union PHP/PHPDoc types instead of choosing one member.
- Resolve classes by lexical namespace and imports; ambiguous short names never
  select an unrelated class. Inherited invokables are bounded and cycle-safe.
- Keep JSON output fields separate from input properties. Global JsonSerializable
  implementations with literal return maps expose exactly their serialized keys,
  including private values and nullability; private ordinary properties stay out
  of output. More complex serialization remains unknown.
- Retain known resource keys whose computed values are unknown; keep both types
  of conditional expressions. Preserve non-null narrowing for `when(field,field)`.
- The shared completeness gate now checks component references for both request
  and response schemas, including missing targets and recursive/deep graphs.

No PHP executable is available in this environment. These are AST regressions and
source-contract comparisons, not PHP backend runtime verification. Namespace-aware
resolution is not yet used by every legacy PHP inference path; full certification
and all Slim wrapper/exception handling are still outstanding.
