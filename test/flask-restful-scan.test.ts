import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "flask-restful");

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

describe("flask-restful Api.add_resource", () => {
  it("maps Resource class methods to operations and converts <int:x> path converters", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // Api(app): each Resource method becomes an operation.
    op(ops, "get", "/hello");
    op(ops, "post", "/hello");

    const getItem = op(ops, "get", "/items/{item_id}");
    op(ops, "delete", "/items/{item_id}");
    const idParam = (getItem.parameters ?? []).find((p: any) => p.in === "path");
    expect(idParam.name).toBe("item_id");
    expect(idParam.schema).toEqual({ type: "integer" });

    // Api(blueprint): blueprint url_prefix is prepended.
    op(ops, "get", "/api/profiles/{user_id}");
  });
});
