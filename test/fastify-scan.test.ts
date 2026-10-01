import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("fastify + TypeScript golden project", () => {
  it("extracts routes from native schemas, plugins and handler inference", async () => {
    const root = join(FIXTURES, "fastify-ts");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("fastify");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      ["/admin/ping", "/api/users", "/api/users/{id}", "/health"].sort(),
    );

    // Decoys never become routes.
    expect(doc.paths["/decoy-map"]).toBeUndefined();
    expect(doc.paths["/decoy-object"]).toBeUndefined();

    // Inferred async return on the root instance.
    const health = doc.paths["/health"].get;
    expect(health.responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
    });

    // Inline plugin with prefix and explicit status.
    const ping = doc.paths["/admin/ping"].post;
    expect(ping.responses["201"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { pong: { type: "boolean" } },
      required: ["pong"],
    });

    // Cross-file plugin mounted with a prefix; native response schema.
    const list = doc.paths["/api/users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
        required: ["id", "name"],
      },
    });

    // POST body from native schema and 201 response.
    const create = doc.paths["/api/users"].post;
    expect(create.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(create.responses["201"]).toBeDefined();

    // Path params and the dual 200/404 responses.
    const detail = doc.paths["/api/users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });
    expect(detail.responses["200"]).toBeDefined();
    expect(detail.responses["404"].content["application/json"].schema.properties.message)
      .toEqual({ type: "string" });

    // listen({ port }) is captured as a server.
    expect(doc.servers).toContainEqual({ url: "http://localhost:3100" });
  });
});
