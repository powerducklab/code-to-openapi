# Go parameter inference hardening

The unchanged upstream net/http contract baseline now has 75 differences over
442 assertions (previous: 79). Four path parameter type mismatches were removed.
Differences remaining: 68 required flags, four types, two minima and one maximum.
This classification does not automatically waive any mismatch.

Changes:
- Path, query, header and cookie values passed directly to verified strconv
  Atoi/ParseBool/ParseFloat calls receive the corresponding schema type.
- Import aliases are supported. Local declarations shadowing the package alias
  prevent this inference. Non-decimal ParseInt is deliberately not treated as a
  decimal integer wire format.
- Request helper analysis supports single-assignment query aliases within their
  lexical scope. Reassignments cancel inference; uncalled function literals are
  excluded; existing depth/node/cycle bounds remain in place.

Regression tests cover integer path IDs, boolean/number queries, package alias
shadowing, helper query aliases, an uncalled closure and recursive helpers.

Outstanding: computed response scalar types, source-versus-Swagger required
flags, pagination fallback versus validation semantics, middleware responses and
broader multi-language independent verification. This report does not certify
9.5/10 accuracy or completion of the full requested review.
