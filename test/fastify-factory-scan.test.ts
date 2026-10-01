import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("fastify factory-call plugins and call-site generics", () => {
  it("resolves factory plugins, external middleware, handler factories and lexical helpers", async () => {
    const root = join(FIXTURES, "fastify-factory");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("fastify");
    expect(result.project.unresolved).toEqual([]);

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/health",
        "/api/convert",
        "/api/flow/google",
        "/api/orgs/{orgId}/manifest",
        "/api/orgs/{orgId}/ping",
        "/api/orgs/{orgId}/projects",
      ].sort(),
    );

    // Call-site generic: Params + Body on POST, high confidence types.
    const create = doc.paths["/api/orgs/{orgId}/projects"].post;
    const orgParam = create.parameters.find((p: any) => p.name === "orgId");
    expect(orgParam.in).toBe("path");
    expect(orgParam.required).toBe(true);
    expect(orgParam.schema).toEqual({ type: "string" });
    const bodySchema = create.requestBody.content["application/json"].schema;
    expect(bodySchema.properties.name).toEqual({ type: "string" });
    expect(bodySchema.properties.description).toEqual({ type: "string" });
    expect(bodySchema.required).toEqual(["name"]);
    expect(create.responses["200"]).toBeDefined();

    // GET list response inferred through the async return and deps call.
    const list = doc.paths["/api/orgs/{orgId}/projects"].get;
    expect(list.responses["200"].content["application/json"].schema.properties.projects)
      .toBeDefined();

    // Local handler factory returning redirect: 302 with no body, no gaps.
    const flow = doc.paths["/api/flow/google"].get;
    expect(flow.responses["302"]).toBeDefined();
    expect(flow.responses["302"].content).toBeUndefined();

    // CORS preflight: 204 with no body, no gaps.
    const preflight = doc.paths["/api/orgs/{orgId}/projects"].options;
    expect(preflight.responses["204"]).toBeDefined();
    expect(preflight.responses["204"].content).toBeUndefined();

    // Lexical helper receiving reply: content type and schema still captured.
    const manifest = doc.paths["/api/orgs/{orgId}/manifest"].get;
    expect(
      manifest.responses["200"].content["application/json"].schema.properties.orgId,
    ).toEqual({ type: "string" });

    // Concise arrow implicit return.
    const ping = doc.paths["/api/orgs/{orgId}/ping"].get;
    expect(ping.responses["200"].content["application/json"].schema.properties.ok)
      .toEqual({ type: "boolean" });

    // Identifier-form plugin (function itself is the plugin).
    const convert = doc.paths["/api/convert"].post;
    expect(
      convert.responses["200"].content["application/json"].schema.properties.received,
    ).toEqual({ type: "boolean" });

    // Root concise arrow.
    const health = doc.paths["/health"].get;
    expect(health.responses["200"].content["application/json"].schema.properties.status)
      .toEqual({ type: "string" });
  });
});
