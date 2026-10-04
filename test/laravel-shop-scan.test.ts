import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-shop");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("laravel-shop project fixture", () => {
  it("collects nested prefix groups and every resource action", async () => {
    const { doc } = await scan();

    expect(doc.paths["/v1/health"].get).toBeDefined();
    expect(doc.paths["/v1/admin/stats"].get).toBeDefined();

    const productItem = doc.paths["/v1/products/{product}"];
    expect(productItem.get).toBeDefined();
    expect(productItem.put).toBeDefined();
    expect(productItem.patch).toBeDefined();
    expect(productItem.delete).toBeDefined();
    expect(doc.paths["/v1/products"].get).toBeDefined();
    expect(doc.paths["/v1/products"].post).toBeDefined();

    const operationCount = Object.values(doc.paths).reduce(
      (total: number, pathItem: any) =>
        total +
        ["get", "post", "put", "patch", "delete"].filter(
          (verb) => typeof pathItem[verb] === "object",
        ).length,
      0,
    );
    expect(operationCount).toBe(12);
  });

  it("keeps PUT and PATCH operation ids collision-free", async () => {
    const { doc } = await scan();

    const ids = Object.values(doc.paths).flatMap((pathItem: any) =>
      ["get", "post", "put", "patch", "delete"]
        .filter((verb) => pathItem[verb])
        .map((verb) => pathItem[verb].operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds API resources with mixin model properties and enum relations", async () => {
    const { doc } = await scan();

    const productResource = doc.components.schemas.ProductResource;
    expect(productResource.properties).toMatchObject({
      id: { type: "integer" },
      sku: { type: "string" },
      name: { type: "string" },
      price: { type: "number" },
      active: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      created_at: { type: "string", format: "date-time" },
    });
    expect(productResource.properties.category).toEqual({
      $ref: "#/components/schemas/Category",
    });
    expect(productResource.properties.reviews).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ReviewResource" },
    });
    expect(doc.components.schemas.Category).toMatchObject({
      type: "string",
      enum: ["electronics", "books", "home"],
    });

    const reviewResource = doc.components.schemas.ReviewResource.properties;
    expect(reviewResource).toMatchObject({
      id: { type: "integer" },
      author: { type: "string" },
      rating: { type: "integer" },
      comment: { type: ["string", "null"] },
    });

    const orderResource = doc.components.schemas.OrderResource.properties;
    expect(orderResource.quantity).toEqual({ type: "integer" });
    expect(orderResource.total).toEqual({ type: "number" });
    expect(orderResource.status).toEqual({
      $ref: "#/components/schemas/OrderStatus",
    });
  });

  it("wraps resource collections with data and pagination meta", async () => {
    const { doc } = await scan();

    const collection = doc.components.schemas.ProductCollection;
    expect(collection.properties.data).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ProductResource" },
    });
    expect(collection.properties.meta.properties).toMatchObject({
      total: { type: "integer" },
      per_page: { type: "integer" },
      current_page: { type: "integer" },
      last_page: { type: "integer" },
    });
  });

  it("derives JSON request bodies from form requests, including enums and arrays", async () => {
    const { doc } = await scan();

    const store = doc.paths["/v1/products"].post;
    expect(store.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ProductResource",
    });
    const body = store.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(
      expect.arrayContaining(["sku", "name", "price", "category"]),
    );
    expect(body.properties.category).toEqual({
      type: "string",
      enum: ["electronics", "books", "home"],
      minLength: 1,
    });
    expect(body.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });

    const update = doc.paths["/v1/products/{product}"].put.requestBody.content[
      "application/json"
    ].schema;
    expect(update.properties.tags).toEqual({
      type: "array",
      items: { type: "string", maxLength:32 },
    });
  });

  it("switches file-validated requests to multipart with binary fields", async () => {
    const { doc } = await scan();

    const upload = doc.paths["/v1/products/{product}/image"].post;
    const form = upload.requestBody.content["multipart/form-data"].schema;
    expect(form.required).toContain("image");
    expect(form.properties.image).toEqual({ type: "string", format: "binary" });
    expect(form.properties.caption).toEqual({ type: ["string", "null"], maxLength:255 });
    const response = upload.responses["201"].content["application/json"].schema;
    expect(response.properties.path).toEqual({ type: "string" });
    expect(response.properties.caption).toEqual({ type: "string" });
  });

  it("marks SSE streams with the canonical extension and item schema", async () => {
    const { doc } = await scan();

    const events = doc.paths["/v1/products/{product}/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    expect(events.responses["200"].content["text/event-stream"].itemSchema).toEqual(
      {},
    );
  });

  it("infers closure and aggregate response payloads honestly", async () => {
    const { doc } = await scan();

    const health = doc.paths["/v1/health"].get.responses["200"].content[
      "application/json"
    ].schema;
    expect(health.properties.status).toEqual({ type: "string" });

    const stats = doc.paths["/v1/admin/stats"].get;
    expect(stats.parameters).toContainEqual(
      expect.objectContaining({ name: "status", in: "query" }),
    );
    const statsBody = stats.responses["200"].content["application/json"].schema;
    expect(statsBody.properties.count).toEqual({ type: "integer" });
    expect(statsBody.properties.status).toEqual({ type: "string" });
  });
});
