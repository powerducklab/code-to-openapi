# DRF wire and import resolution checks

`examples/audit-drf-decimal.py` uses native DRF JSONRenderer and DecimalField,
independently of scanner schemas. Six probes cover both global
`COERCE_DECIMAL_TO_STRING` values and default/explicit field overrides; see
`decimal.json` for the installed DRF version and actual JSON values.

The scanner now emits the observed string/number type, honors field overrides,
and retains a schema gap for dynamic or conflicting settings. It does not assume
that a decimal model property always serializes as a JSON number.

`test/drf-scoped-model.test.ts` additionally verifies `Meta.model` with an aliased
import and competing same-name model definitions. Missing external imports remain
unknown; an unrelated project's model cannot supply fabricated fields. Request
required fields use the same resolved model as the response field schemas.

This does not close dynamic Pygments enum generation or external Django User model
contracts in the official tutorial. Those remain separately reported in the full
framework comparison. No original contract baselines were rewritten here.
