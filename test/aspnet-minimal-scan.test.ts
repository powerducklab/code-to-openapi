import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "aspnet-minimal");

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

describe("asp.net minimal APIs", () => {
  it("resolves IEndpointGroup-style Map calls with method-group handlers and /api/{ClassName} prefix", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations.map((o: any) => `${o.method} ${o.fullPath}`);

    // Existing lambda minimal API still works.
    op(result.project.operations, "get", "/health");

    // Method-group handlers with swapped (handler, route) argument order.
    op(result.project.operations, "post", "/api/TodoItems");
    const put = op(result.project.operations, "put", "/api/TodoItems/{id}");
    op(result.project.operations, "delete", "/api/TodoItems/{id}");

    // {id} becomes a typed path parameter.
    const idParam = (put.parameters ?? []).find((p: any) => p.in === "path");
    expect(idParam.name).toBe("id");
  });
});
