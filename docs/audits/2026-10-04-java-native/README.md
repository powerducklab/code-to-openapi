# Original Java runtime verification

This evidence supplements source contracts. It does not establish complete coverage
of every framework version, middleware configuration, or business branch.

## Spring Petclinic

Pinned upstream commit: `4cd8e1b0cd42578e882247d8801f6be5d402f118`.
Original Maven tests: **237 tests across 19 suites, zero failures/errors/skips**.
JUnit report hashes are in `spring-tests.json`.

`examples/audit-petclinic-runtime.py` exercises the unmodified original application
using its default isolated H2 database: **25 HTTP probes**, including declared GET
routes, invalid identifiers, validation, and creation/read/update/deletion of a new
owner. `spring-http.json` records actual bodies and media types. No existing seeded
record is changed.

Notable upstream behavior:

- `/api/oops` is declared by OAS but has no controller handler. The generic exception
  advice returns 500 for `NoResourceFoundException`; it is not a discoverable endpoint.
- An invalid integer owner identifier also returns 500 via the generic advice.
- The OAS status bound is exclusive (`< 600`), but OpenAPI Generator 7.25.0 emits
  `@Max(600)`. `ProblemDetailBounds.java` invokes the original compiled DTO's Bean
  Validation metadata; **five boundary probes** prove that 600 is accepted. The 93
  repeated exclusiveMaximum differences therefore remain in the unmodified baseline
  comparison rather than being hidden by changing scanner output.

Reproduce using the original Maven wrapper and Java 25.0.4. Obtain the dependency
classpath with `dependency:build-classpath`; run the Java oracle with that classpath
plus the original `target/classes`.

## JAX-RS / Quarkus

Pinned upstream commit: `87ba422a85a7f732f567f955f3406cf992b44f83`.
The original Quarkus 2.11.2 test passes (**one test**); see `jaxrs-tests.json`.
`examples/audit-quarkus-runtime.py` adds **nine independent HTTP probes** against the
original packaged application, bound to localhost and using only its in-memory set.

- Registered exception mapper returns 400 and error DTO fields.
- GET/POST/DELETE preserve the original DTO fields.
- Empty DTO input is accepted and serializes both fields as null.
- Malformed JSON returns 500 in this pinned application. The original server log
  identifies `JsonParseException` propagating from its message body reader.

The scanner now preserves multiple same-status response shapes/media types and
registered exception mapper candidates. Conditional mapper selection remains marked
as uncertain. Native HTTP probes do not imply complete static middleware inference.

## Scanner regression checkpoint

143 test files / 374 tests pass; TypeScript check, ESM/CJS build, distribution smoke
and worker-thread smoke pass. Generic argument imports are resolved using their
original AST scope; unresolved imports cannot silently bind unrelated classes.

## Micronaut

Pinned upstream commit: `fef2c31e27c8e82355bceb0125b4af1366d43150`.
Original Gradle tests pass: **11 tests, zero failures/errors/skips**, including
`@MicronautTest` HTTP integration tests backed by the original H2 test profile.
These exercise persisted fields, empty lists, lookup, deletion and missing records.
`micronaut-tests.json` records suite counts and report hashes.

Used the original Java 14 target, Gradle wrapper and unchanged source. Azul Zulu
14.0.2 package SHA256: `8f15f435c3e8d8a4bb1de441b1d7601fe64e1bafdcf0862e2962ae429ea9e6b2`, verified against the official metadata API before extraction.
The isolated old runtime uses the verified Java 25 CA trust store and TLS 1.2;
certificate verification remains enabled. Java 11 was unsuitable for the target.
Original tests provide independent runtime evidence, but do not exhaustively cover
all optional/malformed input combinations or Micronaut middleware configurations.

### Micronaut response builder oracle

`MicronautResponseChains.java` runs against the original project's resolved
Micronaut 2.1.1 runtime classpath. Three native probes (`micronaut-chains.json`)
confirm inside-to-outside builder order and distinct `created(String)` versus
`created(URI)` overloads. The former carries a body; the latter is a Location-only
response. The scanner now preserves this distinction, excludes uncalled nested
functions, merges same-status alternatives and marks dynamic statuses unknown.
The original Java source and Gradle build remain unchanged.
