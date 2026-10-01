import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "aspnet-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("asp.net real-world controllers", () => {
  it("specializes generic envelopes once and reuses components", async () => {
    const { doc } = await scan();
    const schemas = new Set(Object.keys(doc.components.schemas));

    // The same ApiResponse<ProductDto> appears on get-by-id, create and update;
    // deterministic specialization must not emit suffixed duplicates.
    expect(schemas.has("ApiResponse_ProductDto")).toBe(true);
    expect(schemas.has("ApiResponse_ProductDto_2")).toBe(false);
    expect(schemas.has("ApiResponse_ProductDto_3")).toBe(false);
    expect(schemas.has("PagedResult_ProductDto")).toBe(true);
    expect(schemas.has("PagedResult_ProductDto_2")).toBe(false);

    const envelope = doc.components.schemas.ApiResponse_PagedResult_ProductDto;
    expect(envelope.properties.data).toEqual({
      $ref: "#/components/schemas/PagedResult_ProductDto",
    });
    const page = doc.components.schemas.PagedResult_ProductDto;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ProductDto" },
    });
  });

  it("expands complex [FromQuery] objects into individual parameters", async () => {
    const { doc } = await scan();
    const params = doc.paths["/api/products"].get.parameters;
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p]));

    expect(Object.keys(byName).sort()).toEqual(["page", "pageSize", "search", "status"]);
    expect(byName.page.schema).toEqual({ type: "integer" });
    expect(byName.page.required).toBeUndefined();
    expect(byName.status.schema).toEqual({ $ref: "#/components/schemas/ProductStatus" });
    expect(byName.search.schema).toEqual({ type: "string" });
  });

  it("captures DTO nullability, initializers, Guid format and status codes", async () => {
    const { doc } = await scan();
    const body = doc.paths["/api/products"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/CreateProductRequest" });
    const request = doc.components.schemas.CreateProductRequest;
    expect(request.required).toEqual(["name", "price"]);
    expect(request.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(request.properties.categoryId).toEqual({ type: "string", format: "uuid" });

    const product = doc.components.schemas.ProductDto;
    expect(product.properties.id).toEqual({ type: "string", format: "uuid" });
    expect(product.properties.category).toEqual({ $ref: "#/components/schemas/CategoryDto" });
    expect(product.required).not.toContain("description");
    expect(product.required).not.toContain("category");

    expect(doc.paths["/api/products"].post.responses["201"]).toBeTruthy();
    expect(doc.paths["/api/products"].post.responses["400"]).toBeTruthy();
    expect(doc.paths["/api/products/{id}"].get.responses["404"]).toBeTruthy();
    expect(doc.paths["/api/products/{id}"].delete.responses["204"]).toBeTruthy();
  });
});
