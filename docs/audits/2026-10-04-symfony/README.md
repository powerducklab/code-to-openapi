# Symfony native attribute-route audit

Source: https://github.com/symfony/demo.git
Commit `8d2e2ef75c3e18df173d8bf2379a14abb58c4c31`.

Original controller classes were loaded by PHP 8.5.10 (WordPress PHP WASM CLI
3.1.56) and native Symfony AttributeClassLoader, RouteCollection and RouteCompiler.
The Routing, Config and Security TargetPathTrait source commits match the
original composer.lock. AbstractController is an empty loading stub; controller
business methods, Doctrine, forms, security middleware and templates are not run.
The config/routes.yaml import prefix/default and separate homepage are explicitly
transcribed. Native evidence retains all 15 named attribute routes, including
same-path aliases; the baseline deduplicates operations and includes the separate
homepage. Unrestricted routes include all OpenAPI-supported HTTP methods.

Before: **33 route assertions / 33 failures** (missing locale prefix).
After: **113 route/parameter assertions / zero differences**.
This baseline does **not** yet validate request/response fields.

Repairs: repeatable Route attributes, class-level method inheritance, unrestricted
methods, trailing slash preservation, bounded native YAML parsing and indexed
route configuration, static resource import prefixes, multiline methods.

Composer full restoration was attempted twice but GitHub downloads through the
WASM network layer returned connection errors. This is not a successful full
Symfony application test. Only the independently loaded components above are
claimed. Nested imports, locale variants, environment-specific routes, forms and
response serialization remain to be completed.
