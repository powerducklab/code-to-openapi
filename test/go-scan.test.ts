import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("Gin (Go) golden project", () => {
  it("extracts groups, path params, bound bodies, JSON responses, SSE and components", async () => {
    const root = join(FIXTURES, "gin-go");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert();
    // SSE event payloads stay an explicit gap; the document must be valid.
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api/v1/items",
        "/api/v1/items/{id}",
        "/api/v1/stream",
        "/health",
      ].sort(),
    );

    // The decoy receiver never produces a route.
    expect(doc.paths["/must-not-be-a-route"]).toBeUndefined();

    const byName = (parameters: any[], name: string) =>
      parameters.find((parameter) => parameter.name === name);

    // GET list: form-bound query struct and typed slice response.
    const list = doc.paths["/api/v1/items"].get;
    expect(byName(list.parameters, "limit").schema.type).toBe("integer");
    expect(byName(list.parameters, "q").schema).toEqual({ type: "string" });
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Item" },
    });
    expect(list.responses["400"]).toBeDefined();

    // POST create: bound JSON body and 201 named response.
    const create = doc.paths["/api/v1/items"].post;
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Item",
    });

    // Detail: path param, 200 struct pointer and 404 branch.
    const detail = doc.paths["/api/v1/items/{id}"].get;
    const id = byName(detail.parameters, "id");
    expect(id.in).toBe("path");
    expect(id.required).toBe(true);
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect(detail.responses["404"]).toBeDefined();

    // 204 has no content.
    const remove = doc.paths["/api/v1/items/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();

    // Health map literal.
    const health = doc.paths["/health"].get;
    expect(health.responses["200"].content["application/json"].schema.properties.status).toEqual({
      type: "string",
    });

    // SSE canonical extension.
    const stream = doc.paths["/api/v1/stream"].get;
    expect(stream["x-protocol"]).toBe("sse");
    expect(stream.responses["200"].content["text/event-stream"].itemSchema).toEqual({});

    // Components carry tags, nested refs, time.Time and pointer optionality;
    // binding structs and decoy receivers never leak.
    const schemas = doc.components.schemas;
    expect(schemas.Item.properties.created_at).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(schemas.Item.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schemas.Item.properties.category).toEqual({
      $ref: "#/components/schemas/Category",
    });
    expect(schemas.Item.required).not.toContain("category");
    expect(schemas.ListItemsQuery).toBeUndefined();
    expect(schemas.DecoyClient).toBeUndefined();

    expect(doc.servers).toContainEqual({ url: "http://127.0.0.1:8080" });
  });
});

describe("Chi (Go) golden project", () => {
  it("extracts Route scopes, Mount prefixes, URL params, decoder bodies and scoped statuses", async () => {
    const root = join(FIXTURES, "chi-go");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/health",
        "/api/v1/users",
        "/api/v1/users/{userID}",
        "/api/v1/admin/users/{id}",
      ].sort(),
    );

    // Top-level health map.
    const health = doc.paths["/health"].get;
    expect(health.responses["200"].content["application/json"].schema.properties.status).toEqual({
      type: "string",
    });

    // Query and slice response.
    const list = doc.paths["/api/v1/users"].get;
    const q = list.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    // Decoder body and 201 from scoped WriteHeader.
    const create = doc.paths["/api/v1/users"].post;
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });

    // 200 main flow and the 404 branch coexist; the branch status must not
    // leak onto the success Encode.
    const detail = doc.paths["/api/v1/users/{userID}"].get;
    expect(detail.parameters[0].name).toBe("userID");
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });
    expect(detail.responses["404"]).toBeDefined();
    expect(detail.responses["404"].content).toBeUndefined();

    // Mounted factory router inherits the prefix; 204 no content.
    const adminDelete = doc.paths["/api/v1/admin/users/{id}"].delete;
    expect(adminDelete.responses["204"]).toBeDefined();

    expect(doc.servers).toContainEqual({ url: "http://127.0.0.1:8090" });
  });
});
