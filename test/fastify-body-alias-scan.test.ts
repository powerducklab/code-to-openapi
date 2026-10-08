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

    const login = result.project.operations.find(o => o.method === "post" && (o.fullPath ?? o.path) === "/api/admin/login");
    expect(login?.requestBody?.content[0]?.schema).toEqual({
      type: "object", properties: { password: { type: "string" } },
    });
    expect(login?.gaps ?? []).not.toContain("body-schema-unknown");
    const opaque = result.project.operations.find(o => o.path === "/opaque");
    expect(opaque?.requestBody?.content[0]?.schema).toEqual({type: "object", properties: {value: {}}});
    expect(opaque?.gaps).toContain("body-schema-unknown");
    const fallback = result.project.operations.find(o => o.path === "/fallback");
    expect(fallback?.requestBody?.content[0]?.schema).toBeUndefined();
    expect(fallback?.gaps).toContain("body-schema-unknown");
    const relay = result.project.operations.find(o => o.path === "/api/ai/chat/completions");
    const relaySchema = relay?.requestBody?.content[0]?.schema as any;
    expect(Object.keys(relaySchema.properties).sort()).toEqual(["messages", "organizationId", "tools"]);
    expect(relaySchema.properties.messages.type).toBe("array");
    expect(relaySchema.properties.tools.type).toBe("array");
    expect(relaySchema.properties.organizationId.type).toBe("string");
    expect(relay?.gaps).toContain("body-schema-unknown");
    expect(relay?.gaps).toContain("response-schema-unknown");
    expect(relay?.responses.find(r => r.statusCode === "200")?.content?.[0]?.schema).toBeUndefined();
  });
});
