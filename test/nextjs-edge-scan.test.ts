import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "nextjs-edge");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find(
    (o) => o.method === method && (o.fullPath ?? o.path) === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("next.js pack", () => {
  it("scans App Router route.ts handlers and Pages Router api handlers", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    op(ops, "get", "/api/health");

    const list = op(ops, "get", "/api/users");
    expect(list.parameters.find((p: any) => p.in === "query" && p.name === "q")).toBeDefined();
    expect(list.responses.find((r: any) => r.statusCode === "200").content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });
    expect(list.responses.find((r: any) => r.statusCode === "400").content[0].schema).toEqual({
      $ref: "#/components/schemas/ErrorBody",
    });

    const create = op(ops, "post", "/api/users");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/UserInput",
    });
    expect(create.responses.find((r: any) => r.statusCode === "201").content[0].schema).toEqual({
      $ref: "#/components/schemas/User",
    });

    const byId = op(ops, "get", "/api/users/{id}");
    expect(byId.parameters.map((p: any) => p.name)).toContain("id");
    expect(
      byId.parameters.find((p: any) => p.in === "header" && p.name === "x-token"),
    ).toBeDefined();
    expect(byId.responses.find((r: any) => r.statusCode === "401").content[0].schema).toEqual({
      $ref: "#/components/schemas/ErrorBody",
    });

    const del = op(ops, "delete", "/api/users/{id}");
    expect(del.responses.find((r: any) => r.statusCode === "204")).toBeDefined();

    const legacy = op(ops, "get", "/api/legacy");
    const legacyOk = legacy.responses.find((r: any) => r.statusCode === "200");
    expect(legacyOk.content[0].schema.properties).toBeDefined();
  });
});
