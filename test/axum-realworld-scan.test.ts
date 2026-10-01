import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "axum-realworld");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("axum real-world generic envelopes", () => {
  it("substitutes generic parameters through nested envelopes", async () => {
    const { doc } = await scan();

    const single = doc.paths["/api/products/{id}"].get.responses["200"].content["application/json"].schema;
    expect(single.properties.data).toEqual({ $ref: "#/components/schemas/Product" });
    expect(single.properties.code).toEqual({ type: "integer" });

    const list = doc.paths["/api/products"].get.responses["200"].content["application/json"].schema;
    const page = list.properties.data;
    expect(page.properties.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });
    expect(page.properties.total).toEqual({ type: "integer", format: "int64" });
  });

  it("keeps Query and Path extractor fields complete", async () => {
    const { doc } = await scan();

    const query = doc.paths["/api/products"].get.parameters;
    expect(query.map((p: any) => [p.name, p.in, p.required ?? false])).toEqual([
      ["page", "query", true],
      ["keyword", "query", false],
    ]);

    const path = doc.paths["/api/products/{id}"].get.parameters[0];
    expect(path).toMatchObject({ name: "id", in: "path", required: true });
  });

  it("honors tuple status codes and Json request bodies", async () => {
    const { doc } = await scan();

    const post = doc.paths["/api/products"].post;
    expect(Object.keys(post.responses)).toEqual(["201"]);
    expect(post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateProductBody",
    });
  });
});
