# Starlette scoped response and runtime audit

Source: `gtfisher/starlette-example-crud`, commit `d948b7b7b076a92438f64e8f49f32dcc108bc10c`.

`examples/audit-starlette-runtime.py` imports the original application and executes its handlers through Starlette TestClient. Only `DATABASE_URL` changes, to a disposable SQLite database. No handler, database adapter or response serializer is mocked.

17 native probes pass: HTML home; computed message/date JSON; contact creation, list, lookup, update and deletion; missing contact; each of six update fields omitted independently; RuntimeError with debug enabled and disabled. The example has unpinned dependencies, so the recorded Starlette 0.27.0 runtime is one compatibility point, not a framework version matrix. `native-http.json` records installed versions, inputs, status, media type and JSON bodies. HTML/traceback bodies are deliberately not retained.

The independent source baseline remains `../2026-10-04-python-java/starlette-baseline.json`: 65 assertions, 1 mismatch. The remaining mismatch is `/error`'s 500 response versus an explicit unknown/default response in static analysis. Resolving arbitrary application exception handlers and middleware remains necessary; the runtime observation alone is not a general static rule.

Scanner repairs covered by negative regressions:

- Resolve endpoint imports and aliases in their owning module, including relative module imports; never use the last project-wide short-name match.
- Read each HTTPEndpoint verb's own method body.
- Resolve same-named mounted apps by module and bound recursive mount traversal.
- Ignore uncalled nested functions and discarded response constructors. A single preceding response assignment returned by name is supported.
- Unknown response media types no longer become invented JSON contracts.
- Emit JSON request bodies only when the endpoint actually reads JSON, including verbs other than POST/PUT/PATCH; unconditional reads and guarded reads have different requiredness.
- Next Pages Router dynamic switch cases remain reachable instead of being incorrectly discarded.

Limits: runtime database rows are input-dependent, not a proven fixed DTO; custom middleware, inherited endpoint methods, complex alias mutation, exception contracts and dynamic mounts still need further coverage. Passing these probes is not proof of 95% accuracy across all Starlette projects.

Reproduce (paths may be changed):

```sh
/tmp/pd-starlette-venv/bin/python examples/audit-starlette-runtime.py /tmp/pd-starlette-crud docs/audits/2026-10-04-starlette/native-http.json
node --import tsx examples/scan-audit-project.ts /tmp/pd-starlette-crud /tmp/pd-starlette-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-python-java/starlette-baseline.json /tmp/pd-starlette-current.json docs/audits/2026-10-04-starlette/result.json
```
