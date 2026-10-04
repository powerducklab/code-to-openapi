import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("FastAPI (Python) golden project", () => {
  it("extracts mounted routes, typed parameters, bodies, responses, SSE and components", async () => {
    const root = join(FIXTURES, "fastapi-py");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api/v1/items",
        "/api/v1/items/{item_id}",
        "/api/v1/items/stream",
      ].sort(),
    );

    // The f-string dynamic route is never confirmed.
    expect(doc.paths["/api/v1/items/dynamic"]).toBeUndefined();
    expect(
      result.project.unresolved.some((entry) => entry.reason === "dynamic-path"),
    ).toBe(true);

    // The orphan router is reported as unreachable; the decoy client never
    // produces a route.
    expect(
      result.project.unresolved.some((entry) => entry.reason === "unreachable-router"),
    ).toBe(true);
    expect(doc.paths["/must-not-be-a-route"]).toBeUndefined();
    expect(doc.paths["/api/v1/orphan/lonely"]).toBeUndefined();

    const list = doc.paths["/api/v1/items"].get;
    const byName = (parameters: any[], name: string) =>
      parameters.find((parameter) => parameter.name === name);

    const q = byName(list.parameters, "q");
    expect(q.in).toBe("query");
    expect(q.schema.type).toBe("string");
    expect(q.required).not.toBe(true);
    expect(q.schema).toEqual({ type: "string", maxLength: 50 });

    const limit = byName(list.parameters, "limit");
    expect(limit.in).toBe("query");
    expect(limit.schema).toEqual({ type: "integer", default: 20 });

    const tenant = byName(list.parameters, "x-tenant");
    expect(tenant.in).toBe("header");
    expect(tenant.schema.type).toBe("string");

    // POST body is the named Pydantic model, status 201 response_model Item.
    const create = doc.paths["/api/v1/items"].post;
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ItemCreate",
    });
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Item",
    });

    // Typed path parameter and OAuth2 security dependency.
    const detail = doc.paths["/api/v1/items/{item_id}"].get;
    const itemId = byName(detail.parameters, "item_id");
    expect(itemId.in).toBe("path");
    expect(itemId.required).toBe(true);
    expect(itemId.schema).toEqual({ type: "integer" });
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect(detail.security).toEqual([{ oauth2_scheme: [] }]);

    // SSE canonical extension.
    const stream = doc.paths["/api/v1/items/stream"].get;
    expect(stream["x-protocol"]).toBe("sse");
    expect(stream.responses["200"].content["text/event-stream"].itemSchema).toEqual({});

    // Components: enum, inherited fields merged, required lists.
    const schemas = doc.components.schemas;
    expect(schemas.Color).toEqual({ type: "string", enum: ["red", "blue"] });
    expect(schemas.Item.properties.id).toEqual({ type: "integer" });
    expect(schemas.Item.properties.created_at).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(schemas.Item.properties.name).toEqual({ type: "string" });
    expect(schemas.Item.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schemas.Item.required).toContain("id");
    expect(schemas.Item.required).toContain("color");

    // Security scheme and uvicorn server.
    expect(doc.components.securitySchemes.oauth2_scheme.type).toBe("oauth2");
    expect(doc.servers).toContainEqual({ url: "http://127.0.0.1:8090" });

    // Tags inherited through include_router and constructor.
    expect(list.tags).toEqual(["items"]);
  });
});

describe("Flask (Python) golden project", () => {
  it("extracts blueprint mounts, converters, request evidence, tuple statuses and SSE", async () => {
    const root = join(FIXTURES, "flask-py");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert();
    // Flask is weakly typed, so unresolved gaps are expected; the document
    // itself must still be valid OAS.
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api",
        "/api/{uid}",
        "/health",
        "/stream",
        "/upload",
      ].sort(),
    );

    // A url_prefix passed at registration overrides the blueprint's own
    // url_prefix (verified against real Flask routing).
    const detail = doc.paths["/api/{uid}"].get;
    const uid = detail.parameters.find((p: any) => p.name === "uid");
    expect(uid.in).toBe("path");
    expect(uid.required).toBe(true);
    expect(uid.schema).toEqual({ type: "integer" });
    const expand = detail.parameters.find((p: any) => p.name === "expand");
    expect(expand.in).toBe("query");
    const trace = detail.parameters.find((p: any) => p.name === "X-Trace");
    expect(trace.in).toBe("header");
    // Tuple status (jsonify, 200).
    expect(detail.responses["200"].content["application/json"].schema.properties.name).toEqual({
      type: "string",
    });

    // JSON body gap plus 201 tuple and abort(400).
    const create = doc.paths["/api"].post;
    expect(create.requestBody.content["application/json"].schema).toEqual({});
    expect(create.responses["201"].content["application/json"].schema.properties.created).toEqual({
      type: "boolean",
    });
    expect(create.responses["400"]).toBeDefined();

    // Multipart upload, 202 tuple.
    const upload = doc.paths["/upload"].post;
    expect(upload.requestBody.content["multipart/form-data"]).toBeDefined();
    expect(upload.responses["202"]).toBeDefined();

    // SSE.
    const stream = doc.paths["/stream"].get;
    expect(stream["x-protocol"]).toBe("sse");
    expect(stream.responses["200"].content["text/event-stream"].itemSchema).toEqual({});

    // jsonify literal health.
    const health = doc.paths["/health"].get;
    expect(health.responses["200"].content["application/json"].schema.properties.status).toEqual({
      type: "string",
    });

    expect(doc.servers).toContainEqual({ url: "http://127.0.0.1:5050" });
  });
});
