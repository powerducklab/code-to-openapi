import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-transformer");

async function ops() {
  const result = await scanProject({ root, includeTests: true });
  return result.project.operations;
}

describe("laravel transformer / static-helper method following", () => {
  it("follows (new Transformer)->method() to its literal return array", async () => {
    const all = await ops();
    const show = all.find((o) => o.method === "get" && o.path === "/accessories/{id}");
    expect(show?.gaps ?? []).not.toContain("response-unknown");
    const body = show?.responses.find((r) => r.statusCode === "200")?.content?.[0];
    expect(body?.mediaType).toBe("application/json");
    expect(body?.schema?.properties).toHaveProperty("id");
    expect(body?.schema?.properties).toHaveProperty("name");
    expect(body?.schema?.properties?.category).toMatchObject({ type: "object" });
  });

  it("follows a transformer method that delegates to another", async () => {
    const all = await ops();
    const list = all.find((o) => o.method === "get" && o.path === "/accessories");
    expect(list?.gaps ?? []).not.toContain("response-unknown");
    const props = list?.responses.find((r) => r.statusCode === "200")?.content?.[0]?.schema?.properties;
    expect(props).toHaveProperty("id");
    expect(props).toHaveProperty("category");
  });

  it("resolves the standard static helper envelope {status,messages,payload}", async () => {
    const all = await ops();
    const store = all.find((o) => o.method === "post" && o.path === "/accessories");
    expect(store?.gaps ?? []).not.toContain("response-schema-unknown");
    const props = store?.responses.find((r) => r.statusCode === "200")?.content?.[0]?.schema?.properties;
    expect(Object.keys(props ?? {}).sort()).toEqual(["messages", "payload", "status"]);
  });

  it("keeps the {id} path param typed", async () => {
    const all = await ops();
    const show = all.find((o) => o.method === "get" && o.path === "/accessories/{id}");
    const idParam = show?.parameters.find((p) => p.in === "path" && p.name === "id");
    expect(idParam?.schema).toEqual({ type: "string" });
  });
});
