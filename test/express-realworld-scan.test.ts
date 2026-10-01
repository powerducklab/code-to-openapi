import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "express-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("express TypeScript generic envelopes", () => {
  it("specializes ApiResponse<T> per concrete payload", async () => {
    const { doc } = await scan();

    const one = doc.paths["/api/products/{id}"].get.responses["200"].content["application/json"].schema;
    expect(one).toEqual({ $ref: "#/components/schemas/ApiResponse_Product" });
    const created = doc.paths["/api/products"].post.responses["201"].content["application/json"].schema;
    expect(created).toEqual({ $ref: "#/components/schemas/ApiResponse_Product" });

    const envelope = doc.components.schemas.ApiResponse_Product;
    expect(Object.keys(envelope.properties).sort()).toEqual(["code", "data", "message"]);
    expect(envelope.properties.data).toEqual({ $ref: "#/components/schemas/Product" });

    const product = doc.components.schemas.Product;
    expect(product.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(product.properties.category.type).toBe("object");
    expect(product.properties.category.properties.name).toEqual({ type: "string" });
  });

  it("specializes nested generics for paginated envelopes", async () => {
    const { doc } = await scan();

    const list = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    expect(list).toEqual({ $ref: "#/components/schemas/ApiResponse_PageResult_Product" });

    const page = doc.components.schemas.PageResult_Product;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });
    expect(page.properties.total).toEqual({ type: "number" });

    const envelope = doc.components.schemas.ApiResponse_PageResult_Product;
    expect(envelope.properties.data).toEqual({ $ref: "#/components/schemas/PageResult_Product" });
  });

  it("keeps typed query parameters and request bodies", async () => {
    const { doc } = await scan();

    const query = doc.paths["/api/products"].get.parameters;
    expect(query.map((p: any) => p.name).sort()).toEqual(["keyword", "page"]);
    const pageParam = query.find((p: any) => p.name === "page");
    expect(pageParam.in).toBe("query");
    expect(pageParam.schema).toEqual({ type: "number" });

    const body = doc.paths["/api/products"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/CreateProductBody" });
  });
});
