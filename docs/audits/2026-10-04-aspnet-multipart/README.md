# ASP.NET multipart binding audit

Native ASP.NET Core 10.0.10, nullable reference types enabled, standard
ApiController model binding. The source is in `examples/oracles/aspnet-multipart`.
Five actual local HTTP probes are recorded in `native-results.json`.

Confirmed defects repaired: multiple file parameters previously overwrote earlier
fields; collections used the invented field name `files`; nullable files were
required. Fields now accumulate, FromForm Name aliases are retained, and nullable
files remain optional. Native probes additionally show that a non-nullable
IFormFileCollection binds an empty collection when absent and is not a required
multipart field. Repeated files use the declared collection name.

Limits: custom binders, MVC validation configuration, additional file attributes,
mixed scalar/file form binding require further
coverage. This result does not certify all ASP.NET request contracts.

IFormCollection now retains an explicitly unknown additionalProperties form schema
instead of disappearing as an injected service. Its arbitrary field contents are
not claimed as independently verified. The final focused eight tests and build
pass; the preceding full regression passed 424 tests.
