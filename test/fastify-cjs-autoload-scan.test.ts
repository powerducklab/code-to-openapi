import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../src/core/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures", "fastify-cjs-autoload");

async function scanFixture() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

describe("fastify CJS @fastify/autoload + fluent-json-schema", () => {
  it("expands autoloaded route modules with fp prefix semantics", async () => {
    const { result, converted } = await scanFixture();
    expect(result.report.frameworks).toContain("fastify");
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document;
    const keys = Object.keys(doc.paths).sort();

    // fastify-plugin modules with dirNameRoutePrefix:false expose suffix paths
    // because the runtime options.prefix cannot be resolved statically.
    expect(keys).toContain("/users");
    expect(keys).toContain("/users/login");
    expect(keys).toContain("/profiles/{username}");
    // Default dirNameRoutePrefix adds the directory segment.
    expect(keys).toContain("/groups/gping");
    // Root-level autoloaded file keeps its path unprefixed.
    expect(keys).toContain("/health");

    // No fabricated "/api" prefix: the dynamic prefix is reported as a gap.
    expect(keys.some((k) => k.startsWith("/api"))).toBe(false);
    const dynamicGaps = result.project.unresolved.filter(
      (u: { reason?: string }) => u.reason === "dynamic-path",
    );
    expect(dynamicGaps.length).toBeGreaterThan(0);

    // fluent-json-schema body conversion: properties and required flags.
    const login = doc.paths["/users/login"].post;
    const bodySchema = login.requestBody?.content?.["application/json"]?.schema;
    expect(bodySchema?.type).toBe("object");
    expect(bodySchema?.properties).toMatchObject({
      email: { type: "string", format: "email" },
      password: { type: "string", minLength: 8 },
    });
    expect(bodySchema?.required).toEqual(
      expect.arrayContaining(["email", "password"]),
    );

    // fluent response schemas across multiple status codes.
    const login200 = login.responses?.["200"];
    const login409 = login.responses?.["409"];
    expect(
      login200?.content?.["application/json"]?.schema?.properties?.user?.properties
        ?.token,
    ).toMatchObject({ type: "string" });
    expect(
      login409?.content?.["application/json"]?.schema?.properties?.message,
    ).toMatchObject({ type: "string" });

    // Register route uses reply.code(201).send() in a hoisted sibling handler.
    expect(doc.paths["/users"].post.responses?.["201"]).toBeTruthy();

    // Params schema from a fluent object.
    const profile = doc.paths["/profiles/{username}"].get;
    const usernameParam = profile.parameters?.find(
      (p: { name: string; in: string }) =>
        p.name === "username" && p.in === "path",
    );
    expect(usernameParam?.schema?.type).toBe("string");
    expect(usernameParam?.required).toBe(true);
    expect(
      profile.responses?.["200"]?.content?.["application/json"]?.schema?.properties
        ?.profile?.properties?.following,
    ).toMatchObject({ type: "boolean" });

    // Static fluent combinators, refs, root-level raw, enum and nested array
    // items all survive conversion without leaking a draft-07 $schema key.
    const meta = doc.paths["/meta"].get;
    const metaSchema = meta.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(metaSchema.additionalProperties).toBe(false);
    expect(metaSchema.properties.items).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" } },
      },
    });
    expect(metaSchema.properties.either).toEqual({
      oneOf: [{ type: "string" }, { type: "integer" }],
    });
    // Draft-07 local definitions are hoisted to components.schemas and the
    // local $ref is rewritten to point at them.
    expect(metaSchema.properties.tag).toEqual({
      $ref: "#/components/schemas/Tag",
    });
    expect(metaSchema.definitions).toBeUndefined();
    expect(
      converted.document.components?.schemas?.Tag,
    ).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(JSON.stringify(metaSchema)).not.toContain("$schema");
    const kindParam = meta.parameters?.find(
      (p: { name: string; in: string }) => p.name === "kind" && p.in === "query",
    );
    expect(kindParam?.schema).toEqual({ type: "string", enum: ["a", "b"] });
    expect(kindParam?.required).toBe(true);
  });

  it("skips non-plugin modules such as schema tables", async () => {
    const { converted } = await scanFixture();
    // schema.js exports an object and must not be treated as a plugin.
    const allPaths = Object.keys(converted.document.paths);
    expect(allPaths.some((p) => p.includes("schema"))).toBe(false);
  });
});
