import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("laravel real-world API resources", () => {
  it("expands JsonResource toArray tables into typed components", async () => {
    const { doc } = await scan();

    const resource = doc.components.schemas.ProductResource;
    expect(resource.properties.id).toEqual({ type: "string" });
    expect(resource.properties.name).toEqual({ type: "string" });
    expect(resource.properties.price).toEqual({ type: "number" });
    expect(resource.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(resource.properties.category).toEqual({
      $ref: "#/components/schemas/CategoryResource",
    });
    expect(doc.components.schemas.CategoryResource.properties.id).toEqual({ type: "integer" });
  });

  it("expands ResourceCollection with nested resource arrays and pagination", async () => {
    const { doc } = await scan();

    const collection = doc.components.schemas.ProductCollection;
    expect(collection.properties.data).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ProductResource" },
    });
    expect(collection.properties.page).toEqual({ type: "integer" });
    expect(collection.properties.per_page).toEqual({ type: "integer" });
    expect(collection.properties.total).toEqual({ type: "integer" });
  });

  it("wires resources to routes and keeps FormRequest bodies complete", async () => {
    const { doc } = await scan();

    const index = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    expect(index).toEqual({ $ref: "#/components/schemas/ProductCollection" });

    const show = doc.paths["/api/products/{id}"].get.responses["200"].content["application/json"].schema;
    expect(show).toEqual({ $ref: "#/components/schemas/ProductResource" });

    const body = doc.paths["/api/products"].post.requestBody.content["application/json"].schema;
    expect(body.properties.name).toEqual({ type: "string", minLength: 1, maxLength: 120 });
    expect(body.properties.price).toEqual({ type: "number", minimum: 0 });
    expect(body.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(body.properties.category_id).toEqual({ type: ["integer", "null"] });
    expect(body.required).toEqual(["name", "price"]);
  });
});
