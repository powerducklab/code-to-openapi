import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-shop");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("fastapi-shop project fixture", () => {
  it("discovers every route across relative routers", async () => {
    const { doc } = await scan();

    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/api/v1/orders",
        "/api/v1/orders/{order_id}",
        "/api/v1/products",
        "/api/v1/products/upload",
        "/api/v1/products/{product_id}",
        "/api/v1/products/{product_id}/events",
        "/api/v1/products/{product_id}/reviews",
      ].sort(),
    );

    const operationCount = Object.values(doc.paths).reduce(
      (total: number, pathItem: any) =>
        total +
        ["get", "post", "put", "patch", "delete"].filter(
          (verb) => typeof pathItem[verb] === "object",
        ).length,
      0,
    );
    expect(operationCount).toBe(11);
  });

  it("lifts dependency-class query parameters with aliases", async () => {
    const { doc } = await scan();

    const params = doc.paths["/api/v1/products"].get.parameters;
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["keyword", "page", "pageSize"]);
    expect(byName.page.in).toBe("query");
    expect(byName.page.schema).toEqual({ type: "integer", default: 1, minimum: 1 });
    expect(byName.pageSize.in).toBe("query");
    expect(byName.pageSize.schema).toMatchObject({
      type: "integer",
      default: 20,
      minimum: 1,
      maximum: 100,
    });
    expect(byName.keyword.schema).toEqual({ type: "string", nullable: true });
  });

  it("keeps header, cookie and path parameters on their operations", async () => {
    const { doc } = await scan();

    const create = doc.paths["/api/v1/products"].post;
    const header = create.parameters.find((p: any) => p.name === "x-request-id");
    expect(header).toMatchObject({ in: "header", name: "x-request-id" });
    expect(header.schema).toEqual({ type: "string", default: "x" });

    const detail = doc.paths["/api/v1/products/{product_id}"].get;
    expect(detail.parameters).toContainEqual(
      expect.objectContaining({ name: "product_id", in: "path", required: true }),
    );
    const cookie = detail.parameters.find((p: any) => p.name === "session");
    expect(cookie).toMatchObject({ in: "cookie", name: "session" });
  });

  it("specializes nested generic envelopes two levels deep", async () => {
    const { doc } = await scan();

    const list = doc.paths["/api/v1/products"].get.responses["200"].content[
      "application/json"
    ].schema;
    expect(list).toEqual({ $ref: "#/components/schemas/ApiResponse_PageResult_Product" });

    const envelope = doc.components.schemas.ApiResponse_PageResult_Product;
    expect(envelope.properties.data).toEqual({
      $ref: "#/components/schemas/PageResult_Product",
    });
    const page = doc.components.schemas.PageResult_Product;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });

    const created = doc.paths["/api/v1/products"].post.responses["201"].content[
      "application/json"
    ].schema;
    expect(created).toEqual({ $ref: "#/components/schemas/ApiResponse_Product" });
  });

  it("models multipart uploads with binary files and form fields", async () => {
    const { doc } = await scan();

    const upload = doc.paths["/api/v1/products/upload"].post;
    const form = upload.requestBody.content["multipart/form-data"].schema;
    expect(form.required).toEqual(expect.arrayContaining(["product_id", "file"]));
    expect(form.properties.product_id).toEqual({ type: "integer" });
    expect(form.properties.file).toEqual({ type: "string", format: "binary" });
    expect(form.properties.caption).toEqual({ type: "string" });

    const response = upload.responses["200"].content["application/json"].schema;
    expect(response.properties).toMatchObject({
      product_id: { type: "integer" },
      filename: { type: "string" },
      caption: { type: "string" },
    });
  });

  it("uses 204 for empty responses and marks SSE with the canonical extension", async () => {
    const { doc } = await scan();

    const removed = doc.paths["/api/v1/products/{product_id}"].delete;
    expect(removed.responses["204"]).toBeDefined();
    expect(removed.responses["204"].content).toBeUndefined();

    const events = doc.paths["/api/v1/products/{product_id}/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    const sse = events.responses["200"].content["text/event-stream"];
    expect(sse).toBeDefined();
    expect(sse.itemSchema).toEqual({});
  });
});
