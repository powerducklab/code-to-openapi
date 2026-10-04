import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("nestjs + TypeScript golden project", () => {
  it("extracts controller routes, decorator params, DTOs, SSE and guards", async () => {
    const root = join(FIXTURES, "nest-ts");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("nest");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api/admin/profile",
        "/api/users",
        "/api/users/events",
        "/api/users/import",
        "/api/users/search",
        "/api/users/{id}",
      ].sort(),
    );

    // Global prefix + verb defaults: POST is 201.
    const list = doc.paths["/api/users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });
    const create = doc.paths["/api/users"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateUserDto",
    });

    // @HttpCode(200) overrides the POST 201 default.
    const importOp = doc.paths["/api/users/import"].post;
    expect(importOp.responses["200"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { imported: { type: "boolean", const: true } },
      required: ["imported"],
    });

    // Whole-DTO @Query() expands into individual query parameters.
    const search = doc.paths["/api/users/search"].get;
    const q = search.parameters.find((p: any) => p.name === "q");
    const page = search.parameters.find((p: any) => p.name === "page");
    expect(q.in).toBe("query");
    expect(q.required).toBe(true);
    expect(q.schema).toEqual({ type: "string" });
    expect(page.required).toBeFalsy();
    expect(page.schema).toEqual({ type: "number" });

    // @Param('id') with path parameter.
    const detail = doc.paths["/api/users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });

    // @Sse -> canonical SSE extension with itemSchema from Observable<T>.
    const events = doc.paths["/api/users/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    const stream = events.responses["200"].content["text/event-stream"];
    expect(stream.itemSchema).toEqual({ $ref: "#/components/schemas/User" });

    // @UseGuards(JwtAuthGuard) -> bearer security.
    const admin = doc.paths["/api/admin/profile"].get;
    expect(admin.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });

    // DTO classes become components.
    expect(doc.components.schemas.CreateUserDto).toBeDefined();
    expect(doc.components.schemas.SearchUsersDto).toBeDefined();

    // Global listen port.
    expect(doc.servers).toContainEqual({ url: "http://localhost:3200" });
  });
});
