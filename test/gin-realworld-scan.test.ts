import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("gin real-world envelopes and binding", () => {
  it("discovers routes registered through a RouterGroup helper function", async () => {
    const { result, doc } = await scan();
    expect(result.project.operations).toHaveLength(3);
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/products",
      "/api/products/{id}",
    ]);
  });

  it("flattens embedded structs instead of emitting a Base property", async () => {
    const { doc } = await scan();

    const product = doc.components.schemas.Product;
    expect(product.properties.id).toEqual({ type: "string" });
    expect(product.properties.created_at).toEqual({ type: "string" });
    expect(product.properties.Base).toBeUndefined();
    expect(product.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(product.properties.category).toEqual({ $ref: "#/components/schemas/Category" });
  });

  it("uses concrete envelope structs for single and paginated responses", async () => {
    const { doc } = await scan();

    const one = doc.paths["/api/products/{id}"].get.responses["200"].content["application/json"].schema;
    expect(one).toEqual({ $ref: "#/components/schemas/ProductResponse" });
    const single = doc.components.schemas.ProductResponse;
    expect(single.properties.data).toEqual({ $ref: "#/components/schemas/Product" });

    const list = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    expect(list).toEqual({ $ref: "#/components/schemas/ProductPageResponse" });
    const pageEnvelope = doc.components.schemas.ProductPageResponse;
    expect(pageEnvelope.properties.data).toEqual({ $ref: "#/components/schemas/PageResult" });
    const page = doc.components.schemas.PageResult;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });
  });

  it("captures form query binding, URI binding and JSON bodies", async () => {
    const { doc } = await scan();

    const query = doc.paths["/api/products"].get.parameters;
    expect(query.map((p: any) => p.name).sort()).toEqual(["keyword", "page"]);
    const page = query.find((p: any) => p.name === "page");
    expect(page).toMatchObject({ in: "query", required: true });

    const uri = doc.paths["/api/products/{id}"].get.parameters[0];
    expect(uri).toMatchObject({ name: "id", in: "path", required: true });

    const body = doc.paths["/api/products"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/CreateProductBody" });
  });
});
