import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("fastify schema-less body inferred from request.body aliases", () => {
  it("collects `const payload = request.body; payload.field` into the request body schema", async () => {
    const root = join(FIXTURES, "fastify-body-alias");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("fastify");

    const converted = await result.convert({ validate: true });
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const postOp = result.project.operations.find(
      (o) => o.method === "post" && (o.fullPath ?? o.path) === "/posts",
    );
    expect(postOp).toBeTruthy();
    expect(postOp?.gaps ?? []).not.toContain("body-schema-unknown");

    const bodySchema = postOp?.requestBody?.content[0]?.schema as any;
    expect(bodySchema?.type).toBe("object");
    const props = bodySchema?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["body", "heading", "subHeading"].sort());
    expect(props.heading).toEqual({ type: "string" });
  });
});
