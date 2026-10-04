# Next.js real-project contract audit

Pinned shadcn/taxonomy commit: `298a8857c7128a0d121e7f699dfd729f23b3966d`.
The baseline was authored from the eight exported handlers and their imported
validation schemas, independently of scanner output. Current result:
**118 assertions, 1 mismatch** (Stripe signature header requiredness).

Implemented and checked:

- Fetch string responses use text/plain unless a literal Content-Type overrides
  it. Response(null) has no JSON content. Actual Node Fetch behavior is tested.
- Recognize request URL query schemas, imported Next headers(), ImageResponse
  (including import aliases), and raw text request bodies.
- Exclude local Response impostors and uncalled nested function response sites.
- Ignoring safeParse does not prove validation.
- Shared Zod fixes: input defaults are optional, output defaults are populated,
  exact lengths set both bounds, unions permit overlapping alternatives, merge
  and omit remove stale required keys, unknown fields/branches remain visible.
  Tests compare these cases against the installed Zod runtime.

PNG behavior is documented by the primary framework source:
https://nextjs.org/docs/13/app/api-reference/functions/image-response

Limits: no app deployment, database, Stripe integration or image-rendering runtime
was executed. JSON data embedded in text responses still needs independent
Prisma/Stripe field-level verification. This is a partial contract baseline,
not evidence of >=95% completeness for the entire framework.
