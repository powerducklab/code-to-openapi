# Response branches and request direction audit

This is a continuation checkpoint, **not** a 9.5/10 certification. All 28 pinned
projects produce structurally valid documents, but native branch coverage and
independent middleware/request/response validation remain partial. Baseline
assertion counts are not a precision or recall score.

## Reproduce the matrix

```sh
python3 examples/audit-framework-matrix.py --output /tmp/powerduck-contract-matrix
```

The manifest records pinned repositories, commits, original independent baselines,
comparison-only projects and explicit mount prefixes. The runner checks commit IDs,
records tracked source changes and baseline SHA-256 hashes, and fails for scan or
comparison execution errors. `--strict-contracts` also fails for recorded contract
differences. It never regenerates expected schemas from scanner output. Existing
upstream contradictions remain visible rather than adjusting expected contracts to
make the report green. Local checkout locations can be changed in a copied manifest.

## Correctness fixes

- Same-status response variants no longer depend on traversal order across Express,
  Gin, Chi, net/http, Laravel, Symfony, Slim, Actix, Micronaut, JAX-RS, ASP.NET and
  FastEndpoints. Shared merging preserves media types, unknown branches, union
  sibling constraints and SSE event schemas without mutating the source candidates.
- Explicit dynamic status values in Gin, Echo, Slim, Laravel and Symfony are not
  replaced by optional-argument defaults. Unresolved statuses retain a gap.
- Laravel download/file/streamDownload argument positions follow the original
  ResponseFactory implementation; names and headers cannot become status codes.
- Micronaut factory overloads distinguish URI Location values from entity bodies;
  builders are interpreted inside-to-outside. Independent original-runtime probes
  are recorded in the Java native audit.
- Java throwing-only handlers cannot fabricate a success response from their
  declared return type. Nested uncalled lambdas do not supply route responses.
- Gin and Echo input components are distinct from output serialization components.
  Gin uses its binding validation tags; Echo custom validation remains unresolved.
- Gin PostForm and DefaultPostForm are body fields, not URL query parameters.

Native evidence and further limitations live in the adjacent Java, Go JSON, DRF,
PHP and per-framework audit directories. Missing request/response fields, custom
serialization, dynamic middleware and conditional branch uncertainty must still be
resolved before a complete-coverage or numerical accuracy claim is justified.

## Gin native verification

`examples/oracles/gin-form` uses Gin **1.4.0**, the version pinned by the original
GitHub sample. Seven native `httptest` probes verify PostForm/query isolation,
urlencoded and multipart decoding, required/minimum-length validation, null rejection
for a required string, and the optional integer's zero value. Expected assertions
are written against framework behavior, independently of scanner output.
`gin-native-form.json` records the actual results. The oracle's go.mod/go.sum pin its
resolved dependencies. Reproduce with `go -C examples/oracles/gin-form run .`.

Fixed arrays and byte-slice literals additionally use the shared Go wire model;
five framework tests verify `[2]string` element/length constraints and Base64
serialization of `[]byte`. Native `encoding/json` evidence is in the Go JSON audit.

## Echo native verification and scope

`examples/oracles/echo-bind` pins Echo **4.1.16**, matching its original GitHub
sample. Four native tests demonstrate that `Bind` alone does not execute `validate`
tags; omitted/short/null string values decode and serialize with zero-value fields.
`echo-native-bind.json` records the results. Custom `Validate` implementations
remain unresolved until their registration and actual rules are proven.

Echo HTTP evidence is now limited to the imported Context's receiver and matched
binding helper. Uncalled nested functions and business objects' same-name methods
cannot contribute HTTP statuses or request bodies. PHP controller return collection
uses the same lexical-scope principle. The TypeScript Array.map projection rule
requires the standard library declaration and excludes async/opaque callbacks.

Fiber chain semantics were checked against the [upstream v2.52.6 implementation](https://github.com/gofiber/fiber/blob/v2.52.6/ctx.go).
SendString preserves the configured status, SendStatus sets it explicitly, and
SendFile restores an explicit non-200 status after file handling. Dynamic setters
retain an unresolved status. File-not-found/range behavior and custom error handlers
need separate branch evidence and are not certified by the chain regression.

## Worker/runtime verification

The full regression run before the latest Starlette additions passed **420 tests
in 157 files**. A Node 23.10.0 threaded test run previously crashed in native
V8 WASM background code collection (`uv_async_send` / `WasmEngine::TriggerGC`).
Vitest now uses four process-isolated workers; this is a test-runtime isolation
change, not evidence of a production Electron crash.

`examples/audit-worker-lifecycle.mjs` executes the actual Electron worker source
under Electron 28.3.3 / Node 18.18.2. The recorded
`electron-worker-lifecycle.json` contains 18 successful scans across six grammar
families and three create/reuse/terminate cycles. This checks worker lifecycle
compatibility, not complete semantic coverage of every scanned language.

Starlette route-list resolution now follows scoped imported aliases, excludes
uncalled local app declarations, and reports unresolved dynamic mount prefixes or
ambiguous route lists instead of fabricating root paths. Added regressions pass;
the complete independent matrix must be rerun before replacing its checkpoint.
