Run `examples/audit-drf-decimal.py <output.json>` in the isolated environment with
Django and DRF installed. The recorded native probes use the exact version in
`decimal.json`. No scanner function is imported by the runtime oracle.

Regression tests cover six native field/global coercion combinations, dynamic
settings, source model imports, aliases, unresolved external dependencies and
same-name classes in separate modules. Unsupported constraints remain explicit
gaps, including dynamic enum generation and unavailable external model code.
