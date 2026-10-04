# ASP.NET native HTTP and integration audit (open differences)

Source: https://github.com/gothinkster/aspnetcore-realworld-example-app.git
Commit `a397d1197b22edeffa4d2563fa5f4f7f11d0b254`.

The pinned .NET 10.0.302 SDK restored the original lock files and ran all **16
original integration tests successfully**, using upstream's EF InMemory fixture.
The original application was also started on loopback against temporary SQLite.
`examples/audit-aspnet-runtime.py` exercised all 19 success operations (register,
login, profile/follow, user update, articles/favorites, comments/tags and deletes)
and one invalid-password request. The latter actually returns 422. Business
handlers, mediator, validation, SQL, password hashing and JWT run without doubles.

`native-swagger.json` is preserved unchanged. Swagger is not assumed to be the
runtime truth: generic ObjectResult status, broad advertised media types and
required flags disagree with actual responses. `http-evidence.json` records only
status/media/field names; tokens and literal business data are not persisted.
The baseline combines observed payloads/statuses with native Swagger input
annotations. **737 assertions / 183 differences remain** at this snapshot.
Many reflect nullable annotations versus individual non-null sample values;
others are genuine input validation / conditional response gaps. Neither is
silently counted as a pass. A representative value does not prove a field can
never be null or omitted.

Repairs: lexical namespace/nested DTO resolution; recovered generic interfaces
on records despite older grammar limits; bounded source-proven mediator response
resolution; installed controller-prefix convention discovery (config-dependent
prefix remains a gap); JsonIgnore visibility; separate serialization components,
including generic specializations. Regression tests prevent cross-contamination
between same-named nested request DTOs and internal password fields.

Full error and middleware branches, conditional serializers, custom converters,
all FluentValidation rules, configuration variants and complete native type
domains remain unfinished. This is not a framework-wide 95% certification.
