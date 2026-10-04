import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("JAX-RS shared pack (Jakarta + javax)", () => {
  it("extracts verbs, path/query/header/form/bean params, bodies, statuses and SSE", async () => {
    const root = join(FIXTURES, "jaxrs-shop");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("jaxrs");
    // A pure JAX-RS project must not also claim Spring.
    expect(result.report.frameworks).not.toContain("spring");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/legacy/items/{itemId}",
        "/products",
        "/products/events",
        "/products/filter",
        "/products/search",
        "/products/{id}",
      ].sort(),
    );

    // GET /products -> List<Product> array; query params with DefaultValue.
    const list = doc.paths["/products"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });
    const q = list.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    const page = list.parameters.find((p: any) => p.name === "page");
    expect(page.in).toBe("query");
    expect(page.schema).toEqual({ type: "integer", format: "int32" });

    // GET /products/{id} -> 200 Product AND 404 non-200; path + header params.
    const detail = doc.paths["/products/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "integer", format: "int64" });
    const trace = detail.parameters.find((p: any) => p.name === "X-Trace");
    expect(trace.in).toBe("header");
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Product",
    });
    expect(detail.responses["404"]).toBeDefined();

    // POST /products -> 201 with Product entity and CreateProductRequest body.
    const create = doc.paths["/products"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Product",
    });
    expect(create.requestBody.required ?? false).toBe(false);
    expect(create.requestBody.content["application/json"].schema.anyOf).toEqual([
      { $ref: "#/components/schemas/CreateProductRequest" }, { type: "null" },
    ]);
    const dto = doc.components.schemas.CreateProductRequest;
    expect(dto.properties.name).toMatchObject({ type: "string" });
    expect(dto.required).toContain("name");

    // PUT /products/{id} -> bare Product return, 200.
    const update = doc.paths["/products/{id}"].put;
    expect(update.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Product",
    });
    expect(update.requestBody.required ?? false).toBe(false);
    expect(update.requestBody.content["application/json"].schema.anyOf).toContainEqual({
      $ref: "#/components/schemas/CreateProductRequest",
    });

    // DELETE /products/{id} -> 204 no content.
    const remove = doc.paths["/products/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();

    // PATCH exists on /products/{id}.
    expect(doc.paths["/products/{id}"].patch).toBeDefined();
    // HEAD + OPTIONS exist on the collection path.
    expect(doc.paths["/products"].head).toBeDefined();
    expect(doc.paths["/products"].options).toBeDefined();

    // @FormParam -> application/x-www-form-urlencoded request body object.
    const form = doc.paths["/products/search"].post;
    const formSchema =
      form.requestBody.content["application/x-www-form-urlencoded"].schema;
    expect(formSchema.properties.term).toBeDefined();
    expect(formSchema.properties.limit).toBeDefined();

    // @BeanParam unfolds nested query params.
    const filter = doc.paths["/products/filter"].get;
    const category = filter.parameters.find((p: any) => p.name === "category");
    expect(category.in).toBe("query");
    const minPrice = filter.parameters.find((p: any) => p.name === "minPrice");
    expect(minPrice.in).toBe("query");
    expect(filter.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });

    // Multi<ProductEvent> + @Produces(text/event-stream) -> canonical SSE.
    const events = doc.paths["/products/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    expect(
      events.responses["200"].content["text/event-stream"].itemSchema,
    ).toEqual({ $ref: "#/components/schemas/ProductEvent" });

    // Legacy javax.ws.rs resource is recognised by the same pack.
    const legacy = doc.paths["/legacy/items/{itemId}"].get;
    expect(legacy).toBeDefined();
    expect(legacy.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/LegacyItem",
    });
    const legacyId = legacy.parameters.find((p: any) => p.name === "itemId");
    expect(legacyId.in).toBe("path");
  });
});
