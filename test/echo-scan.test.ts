import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "echo-edge");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("Echo pack", () => {
  it("detects verbs, :id params and Group prefixes", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o: any) => `${o.method} ${o.fullPath ?? o.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "get /items",
        "post /items",
        "get /api/items/{id}",
      ]),
    );
  });

  it("captures c.Param/c.QueryParam/header, c.Bind body and c.JSON responses", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/items");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["query:tag", "header:X-Trace"]),
    );
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Item" },
    });

    const create = op(ops, "post", "/items");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/input_ItemInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);

    const detail = op(ops, "get", "/api/items/{id}");
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
  });

  it("records e.Start address as a server", async () => {
    const { result } = await scan();
    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8095" });
  });
});
