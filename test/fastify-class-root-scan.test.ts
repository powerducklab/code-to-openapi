import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("fastify class-held root instance with barrel plugins", () => {
  it("resolves this.server = fastify(), wildcard barrels, fp() wrappers and shorthand schemas", async () => {
    const root = join(FIXTURES, "fastify-class-root");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: false });
    expect(result.report.frameworks).toContain("fastify");
    expect(result.project.unresolved).toEqual([]);

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(["/api/v1/posts"].sort());

    const list = doc.paths["/api/v1/posts"].get;
    expect(list).toBeDefined();
    expect(
      list.responses["200"].content["application/json"].schema.type,
    ).toBe("array");

    const create = doc.paths["/api/v1/posts"].post;
    expect(create).toBeDefined();
    // No body schema was declared and the handler never reads request.body,
    // so the converter must not invent a request body.
    expect(create.requestBody).toBeUndefined();
    // The handler's declared return type still drives the response schema.
    expect(create.responses["200"]).toBeDefined();
    expect(
      create.responses["200"].content["application/json"].schema.properties.id,
    ).toEqual({ type: "string" });
  });
});
