import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-array-callables");

async function ops() {
  const result = await scanProject({ root, includeTests: true });
  return result.project.operations;
}

describe("laravel array-callable route handlers", () => {
  it('binds [Api\\OrderController::class, "index"] to its method and runs inference', async () => {
    const all = await ops();
    const orders = all.find((o) => o.method === "get" && o.path === "/orders");
    expect(orders?.operationId).toBe("OrderController.index");
    expect(orders?.gaps ?? []).not.toContain("response-unknown");
    const props = orders?.responses.find((r) => r.statusCode === "200")?.content?.[0]?.schema?.properties;
    expect(props).toHaveProperty("id");
    expect(props).toHaveProperty("reference");
  });

  it("binds Route::resource(ProductController::class) to index/show", async () => {
    const all = await ops();
    const index = all.find((o) => o.method === "get" && o.path === "/products");
    const show = all.find((o) => o.method === "get" && o.path === "/products/{product}");
    expect(index?.operationId).toBe("ProductController.index");
    expect(show?.operationId).toBe("ProductController.show");
    expect(show?.parameters.find((p) => p.in === "path")?.schema).toEqual({ type: "string" });
  });

  it("produces a valid document", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);
  });
});
