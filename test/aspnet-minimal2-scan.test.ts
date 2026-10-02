import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "aspnet-minimal2");

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

describe("asp.net minimal API top-level + MapGroup", () => {
  it("binds [FromRoute]/[FromQuery] on top-level lambdas", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const get = op(ops, "get", "/products/{id}");
    expect(get.parameters.find((p: any) => p.in === "path").name).toBe("id");
    expect(get.parameters.find((p: any) => p.in === "query").name).toBe("q");
    expect(get.responses[0].statusCode).toBe("200");
  });

  it("applies MapGroup prefixes (variable and chained)", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    op(ops, "get", "/api/v1/todos");
    op(ops, "post", "/api/v1/todos");
    op(ops, "get", "/api/v2/items/{id}");
  });

  it("emits TypedResults non-200 status codes honestly", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const broken = op(ops, "get", "/broken");
    expect(broken.responses.some((r: any) => r.statusCode === "400")).toBe(true);
  });
});
