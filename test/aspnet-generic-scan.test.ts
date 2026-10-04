import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

async function scan() {
  const root = join(FIXTURES, "aspnet-generic");
  expect(existsSync(root)).toBe(true);
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, converted, doc: converted.document as any };
}

describe("asp.net generic response wrappers", () => {
  it("specializes Result<T> with concrete payload fields", async () => {
    const { doc } = await scan();

    const single = doc.paths["/api/products/{id}"].get.responses["200"].content["application/json"].schema;
    expect(single).toEqual({ $ref: "#/components/schemas/serialized_Result_ProductDto" });

    const wrapper = doc.components.schemas.serialized_Result_ProductDto;
    expect(wrapper.type).toBe("object");
    expect(wrapper.properties.code).toEqual({ type: "integer" });
    expect(wrapper.properties.message).toEqual({ type: "string" });
    expect(wrapper.properties.data).toEqual({ anyOf: [{ $ref: "#/components/schemas/serialized_ProductDto" }, { type: "null" }] });

    const product = doc.components.schemas.serialized_ProductDto;
    expect(product.properties.id).toEqual({ type: "string", format: "uuid" });
    expect(product.properties.name).toEqual({ type: "string" });
    expect(product.properties.price).toEqual({ type: "number" });
    expect(product.properties.category).toEqual({ anyOf: [{ $ref: "#/components/schemas/serialized_ProductCategory" }, { type: "null" }] });
    expect(product.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("resolves generic base classes for PagedResult<T>", async () => {
    const { doc } = await scan();

    const list = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    expect(list).toEqual({ $ref: "#/components/schemas/serialized_PagedResult_ProductDto" });

    const paged = doc.components.schemas.serialized_PagedResult_ProductDto;
    // Inherited Result<List<T>> fields bind T to ProductDto.
    expect(paged.properties.code).toEqual({ type: "integer" });
    expect(paged.properties.message).toEqual({ type: "string" });
    expect(paged.properties.data).toEqual({
      type: ["array", "null"],
      items: { $ref: "#/components/schemas/serialized_ProductDto" },
    });
    expect(paged.properties.page).toEqual({ type: "integer" });
    expect(paged.properties.perPage).toEqual({ type: "integer" });
    expect(paged.properties.total).toEqual({ type: "integer", format: "int64" });
  });
});
