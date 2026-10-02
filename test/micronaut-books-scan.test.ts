import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("Micronaut pack", () => {
  it("extracts @Controller routes, @Get/@Post, params, bodies, statuses", async () => {
    const root = join(FIXTURES, "micronaut-books");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("micronaut");
    expect(result.report.frameworks).not.toContain("spring");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(["/api/books", "/api/books/{id}"].sort());

    // GET /api/books -> List<Book> array with query params.
    const list = doc.paths["/api/books"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Book" },
    });
    const q = list.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    const page = list.parameters.find((p: any) => p.name === "page");
    expect(page.schema).toEqual({ type: "integer", format: "int32" });

    // GET /api/books/{id} -> 200 Book AND 404 non-200.
    const detail = doc.paths["/api/books/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "integer", format: "int64" });
    const trace = detail.parameters.find((p: any) => p.name === "X-Trace");
    expect(trace.in).toBe("header");
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Book",
    });
    expect(detail.responses["404"]).toBeDefined();

    // POST -> HttpResponse.created(..).body(book) -> 201 + Book, @Body request.
    const create = doc.paths["/api/books"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Book",
    });
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateBookRequest",
    });

    // PUT -> bare Book return, 200.
    const update = doc.paths["/api/books/{id}"].put;
    expect(update.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Book",
    });

    // DELETE -> noContent -> 204.
    const remove = doc.paths["/api/books/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();
  });
});
