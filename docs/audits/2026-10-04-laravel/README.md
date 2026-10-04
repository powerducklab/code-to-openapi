# Koel / Laravel independent contract audit

Upstream: https://github.com/koel/koel/tree/46e816c20f8edf90d72f6820bd34339a75d2633e

Native oracle uses PHP 8.5.10 via PHP WASM and original `routes/api.base.php`,
controller declarations, and selected FormRequest `rules()` methods. Controllers
are loaded but their business methods are not invoked. The YouTube feature facade
is explicitly enabled using an isolated boundary double. No database/auth/external
service is contacted.

Dependencies are fixed to upstream `composer.lock`:

| Package | Commit |
| --- | --- |
| laravel/framework | 9c008e7c9a64a8ea6d6e4f1683bd569acc10bf9e |
| doctrine/inflector | 6d6c96277ea252fc1304627204c3d5e6e15faa3b |
| psr/container | c71ecc56dfe541dbd90c5360474fbc405f8d5963 |
| symfony/http-foundation | 9d0761c0da6bd5b801b401666834901a9a1ffc33 |
| brick/math | a89bc96a7cf3d7b59e725afe57ccb95eb03cf6ce |

`examples/audit-laravel-runtime.php` records 175 native resource/explicit routes.
`examples/audit-laravel-validation.php` exercises 20 inputs across four original
request classes using the native Laravel Validator. `native-validation.json`
contains accepted/rejected inputs and native failed-rule names. The independent
baseline generator is `examples/audit-laravel-baseline.py`.

The current comparison passes 571 assertions. Native registration exposed missing
resource actions: Laravel registers actions even when the controller lacks the
corresponding method. Scanning now preserves those routes with unresolved response
gaps. Request checks exposed lost nullable and maximum-length constraints and GET
FormRequest rules incorrectly emitted solely as JSON request bodies.

This is **partial coverage**, not a 95% accuracy certification. Implicit HEAD
aliases, omitted optional path segments, web/subsonic routes, feature-disabled
registrations, custom validation objects, all remaining request types, middleware,
business response bodies, and serialization branches still require independent
checks. Numeric/string coercion and PHP associative arrays require additional
wire-level validation. Baseline counts do not measure false-positive fields.

Reproduction (package source directories as listed in the loader):

```sh
php examples/audit-laravel-runtime.php /path/to/koel /path/to/packages docs/audits/2026-10-04-laravel/native-routes.json
php examples/audit-laravel-validation.php /path/to/koel /path/to/packages docs/audits/2026-10-04-laravel/native-validation.json
python3 examples/audit-laravel-baseline.py docs/audits/2026-10-04-laravel/native-routes.json docs/audits/2026-10-04-laravel/baseline.json
node --import tsx examples/scan-audit-project.ts /path/to/koel /tmp/koel-scan.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-laravel/baseline.json /tmp/koel-scan.json /tmp/koel-comparison.json --strict
```
