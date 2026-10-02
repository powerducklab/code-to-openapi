import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "axum-modular");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("axum modular module routers", () => {
  it("collects routes from every same-named module router() merged together", async () => {
    const { doc } = await scan();
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/articles/{slug}",
      "/api/articles/{slug}/comments",
      "/api/user",
    ]);
  });

  it("normalizes axum :path params to OpenAPI {path} params", async () => {
    const { doc } = await scan();
    const op = doc.paths["/api/articles/{slug}"].get;
    const slug = op.parameters.find((p: any) => p.name === "slug");
    expect(slug).toMatchObject({ in: "path", required: true });
  });

  it("unwraps scoped Result<Json<T>> return types to a component $ref", async () => {
    const { doc } = await scan();
    const schema = doc.paths["/api/user"].get.responses["200"].content["application/json"].schema;
    expect(schema).toEqual({ $ref: "#/components/schemas/User" });
    expect(doc.components.schemas.User.properties.username).toEqual({ type: "string" });
  });
});
