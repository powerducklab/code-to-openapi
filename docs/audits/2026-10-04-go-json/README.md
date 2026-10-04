# Go JSON wire contract audit

The shared Go schema layer is consumed by Gin, Echo, Fiber, net/http, Chi and Gorilla/Mux. This audit checks native `encoding/json` semantics rather than assuming Go declarations and JSON have identical shapes.

## Native evidence

- `native-wire.json`: Go 1.25.8, zero and populated instances of the oracle in `examples/oracles/go-json-wire/main.go`.
- `gin-native-dto.json`: type declarations extracted by Go's parser from the original Gin GitHub sample, pinned at `4f5174ca325b37f23edadad7c88d49586816a69c`. Original file SHA-256 hashes are recorded. The isolated harness executes the native serializer on Model, Tag, Article, Response, a nil article slice and an empty article slice. Custom JSON/text serializers in the selected packages cause the oracle to fail rather than silently omit them. This is a DTO oracle, not a database/controller runtime test.

The results establish these differences from the previous scanner:

- A nil pointer without an omission tag is a present null field, not an optional non-null property.
- Nil slices and maps serialize as null; initialized empty slices/maps differ.
- Byte slices serialize as Base64 strings. JSON decoding also accepts byte arrays, so input and output schemas differ.
- Fixed arrays have a fixed output length; their first AST child is the length, not the element type.
- `json:",string"` quotes scalar values.
- A struct value tagged `omitempty` still serializes when zero.
- Explicitly named embedded structs are nested; ignored embedded structs do not leak fields.
- Embedded name collisions follow depth, then explicit JSON tag priority; an unresolved tie is omitted. Indexing order must not choose the winning field.
- A constructor that only returns `&DTO{...}` proves a non-null result despite its pointer return type.

The embedding traversal is bounded and records unresolved external/deep embeddings. Remaining work includes custom marshalers, named scalar aliases, full input validation, all handler branches and runtime-version-sensitive behavior. This audit does not certify all six Go frameworks or replace their existing independent baselines.

## Reproduce

```sh
GO111MODULE=off GOCACHE=/tmp/pd-go-json-cache go run examples/oracles/go-json-wire/main.go
GO111MODULE=off GOCACHE=/tmp/pd-go-json-cache go run examples/oracles/go-original-dto/main.go /tmp/realproj-gin
npm test -- test/go-json-wire.test.ts
```

## Chi input validator and non-nil local slices

`examples/audit-chi-validation.py` compiles the unchanged original `internal/models/dto.go` declarations (package name only adjusted) against the upstream pinned `go-playground/validator/v10@v10.30.1`. Seven validation probes pass; `chi-native-validation.json` includes the source hash. Authentication, HTTP middleware and database execution are outside this isolated validator test.

`required,min=1` on a string pointer rejects null and empty strings. `omitempty,min=1` accepts null/absence but rejects an explicitly empty string. The previous source baseline incorrectly rejected null for the optional content pointer. `chi-baseline.json` retains its original assertions except that independently verified correction; the original baseline is unchanged. The corrected comparison has 120 assertions and zero mismatches.

Local `[]T{}` followed only by append is now distinguished from a possibly nil slice. Nil assignments, address escapes, shadowed append and ambiguous declarations keep nullability. Pointer-returning constructors are also narrowed only when every return is backed by a proven non-nil construction, including a directly initialized local. These refinements do not make all arbitrary service return paths non-null.
