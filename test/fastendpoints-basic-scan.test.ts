import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastendpoints-basic");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("FastEndpoints", () => {
  it("extracts Verbs/Routes endpoints with request and response DTOs", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const create = op(ops, "post", "/api/creates");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/CreateRequest",
    });
    expect(create.responses[0].statusCode).toBe("201");
    expect(create.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/serialized_CreateResponse",
    });
  });

  it("handles Get(x)/Delete(x) config style and EndpointWithoutRequest", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const list = op(ops, "get", "/api/items/{id}");
    expect(list.parameters.find((p: any) => p.in === "path").name).toBe("id");
    expect(list.requestBody).toBeUndefined();
    expect(list.responses[0].statusCode).toBe("200");
    expect(list.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/serialized_ItemResponse",
    });

    const del = op(ops, "delete", "/api/items/{id}");
    expect(del.responses[0].statusCode).toBe("204");
    expect(del.responses[0].content).toBeUndefined();
  });
});
