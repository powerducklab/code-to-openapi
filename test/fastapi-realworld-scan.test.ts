import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("fastapi generic Pydantic envelopes", () => {
  it("specializes ApiResponse[Product] with bound type variables", async () => {
    const { doc } = await scan();

    const one = doc.paths["/api/products/{product_id}"].get.responses["200"].content["application/json"].schema;
    expect(one).toEqual({ $ref: "#/components/schemas/ApiResponse_Product" });

    const envelope = doc.components.schemas.ApiResponse_Product;
    expect(Object.keys(envelope.properties).sort()).toEqual(["code", "data", "message"]);
    expect(envelope.properties.data).toEqual({ $ref: "#/components/schemas/Product" });
    expect(envelope.required).toContain("data");

    const product = doc.components.schemas.Product;
    expect(product.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(product.properties.category).toEqual({
      $ref: "#/components/schemas/Category",
      nullable: true,
    });
    expect(product.required).toEqual(["id", "name", "price"]);
  });

  it("specializes nested generic pagination envelopes", async () => {
    const { doc } = await scan();

    const list = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    expect(list).toEqual({ $ref: "#/components/schemas/ApiResponse_PageResult_Product" });

    const envelope = doc.components.schemas.ApiResponse_PageResult_Product;
    expect(envelope.properties.data).toEqual({ $ref: "#/components/schemas/PageResult_Product" });

    const page = doc.components.schemas.PageResult_Product;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });
    expect(page.properties.total).toEqual({ type: "integer" });
  });

  it("keeps query parameters, path parameters and request bodies", async () => {
    const { doc } = await scan();

    const get = doc.paths["/api/products"].get;
    const params = get.parameters;
    expect(params.map((p: any) => p.name).sort()).toEqual(["keyword", "page"]);
    const keyword = params.find((p: any) => p.name === "keyword");
    expect(keyword.in).toBe("query");
    expect(keyword.schema).toEqual({ type: "string", nullable: true });

    const pathParam = doc.paths["/api/products/{product_id}"].get.parameters[0];
    expect(pathParam).toMatchObject({ name: "product_id", in: "path", required: true });

    const body = doc.paths["/api/products"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/ProductCreate" });
    const created = doc.paths["/api/products"].post.responses["201"].content["application/json"].schema;
    expect(created).toEqual({ $ref: "#/components/schemas/ApiResponse_Product" });
  });
});
