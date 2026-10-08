import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "fixtures", "express-localvalue");

function op(ops: any[], method: string, path: string) {
  const found = ops.find(
    (o) => o.method === method && (o.fullPath ?? o.path) === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("express pure-JS local-value tracking", () => {
  it("grounds res.json(localVar) to literals, merges req.body, ternaries, and cross-file custom response methods", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // 1. Local object literal.
    const hello = op(ops, "get", "/hello");
    expect(hello.gaps).not.toContain("response-unknown");
    const helloSchema = hello.responses[0]?.content?.[0]?.schema as any;
    expect(helloSchema.properties.message.type).toBe("string");
    expect(helloSchema.properties.count.type).toBe("number");

    // 2. Merge of a req.body local + a literal boolean.
    const echo = op(ops, "post", "/echo");
    const echoSchema = echo.responses[0]?.content?.[0]?.schema as any;
    expect(echoSchema.properties.echoed.type).toBe("boolean");

    // 3. Ternary resolves to the observed literal shape.
    const flag = op(ops, "get", "/flag");
    expect(flag.gaps).not.toContain("response-unknown");
    const flagBranches = flag.responses[0]?.content?.[0]?.schema?.anyOf as any[];
    expect(flagBranches).toHaveLength(2);
    expect(flagBranches.map(branch => branch.properties.state)).toEqual([
      {type: "string", const: "on"}, {type: "string", const: "off"},
    ]);

    // 4. Cross-file monkey-patched `res.ok(...)` expands to {message, data}.
    const custom = op(ops, "get", "/custom");
    expect(custom.gaps).not.toContain("response-unknown");
    const customSchema = custom.responses[0]?.content?.[0]?.schema as any;
    expect(customSchema.properties.data.properties.id.type).toBe("integer");
  });
});
