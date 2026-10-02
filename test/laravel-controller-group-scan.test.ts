import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-controller-group");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

describe("laravel Route::controller()->group() string handlers", () => {
  it("resolves bare string handlers against the enclosing ->controller() chain", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    const index = ops.find((o) => o.method === "get" && (o.fullPath ?? o.path) === "/catalog/");
    const show = ops.find((o) => o.method === "get" && (o.fullPath ?? o.path) === "/catalog/{id}");
    expect(index?.operationId).toBe("CatalogController.index");
    expect(show?.operationId).toBe("CatalogController.show");
    expect(index?.gaps).not.toContain("response-unknown");
  });

  it("produces a valid OAS document", async () => {
    const { converted } = await scan();
    expect(converted.documentValid).toBe(true);
  });
});
