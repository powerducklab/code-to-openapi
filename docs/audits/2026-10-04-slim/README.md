# Slim native contract audit

Pinned upstream: `slimphp/Slim-Skeleton` at `0ef01549870b3234a3a9f602904a39c3ed73f44c`.

`examples/audit-slim-runtime.php` executes the original routes, actions, repository, DTOs and custom error handler through Slim's native routing/error middleware and PSR-7 request/response implementation. Only the container is replaced with an explicit two-service map and a PSR NullLogger. This does not validate PHP-DI, Monolog, the session middleware or the complete production bootstrap. Package versions and commits are recorded in `native-http.json`; the runtime is PHP 8.5.10 WASM.

Nine requests pass: root, wildcard OPTIONS, user list, existing user, missing user, nonnumeric user, numeric-prefix user, trailing-slash mismatch and unsupported method. The upstream repository constructor emits a PHP 8.5 implicit-nullability deprecation; it is recorded separately from request correctness.

The original `(int)` path conversion accepts `/users/1abc` and returns user 1. Therefore `baseline.json` corrects the earlier independently transcribed integer path constraint to string; it does not alter the original baseline. No baseline fields come from scanner output.

Current comparison: **56 assertions, 1 mismatch**. Inherited success handlers and their source-defined JSON wrappers are resolved. The missing 404 response requires tracing repository exceptions through the inherited action catch and the registered custom error handler; it remains an explicit unresolved contract, not a certified pass.

Additional native PHP JSON oracle: `examples/oracles/php-json-wire/main.php`, recorded in `native-dto.json`, checks defaults, omitted uninitialized properties, multiple properties in one declaration, inherited properties, static/private exclusion and nullable nested DTOs. These are language-level probes, not additional original application coverage.

Scanner regression coverage additionally includes Slim `any`/`map`, exact trailing slashes, regex placeholder quantifiers, cycles, direct class-string versus array callables, full elseif chains, loose comparison uncertainty and finally overrides. Native handler success is not proof of all middleware, all Slim versions, optional-path branches or dynamic registrations.

Commands (macOS PHP WASM requires canonical `/private/tmp` paths):

```sh
php-wasm-cli examples/audit-slim-runtime.php /private/tmp/realproj2-slim-skeleton /private/tmp/pd-slim-native-deps "$PWD/docs/audits/2026-10-04-slim/native-http.json"
php-wasm-cli examples/oracles/php-json-wire/main.php "$PWD/docs/audits/2026-10-04-slim/native-dto.json"
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-slim-skeleton /tmp/pd-slim-current.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-slim/baseline.json /tmp/pd-slim-current.json docs/audits/2026-10-04-slim/result.json
```
