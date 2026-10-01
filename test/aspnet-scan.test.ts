import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("asp.net core golden project", () => {
  it("extracts controllers, minimal APIs, bindings, statuses and SSE", async () => {
    const root = join(FIXTURES, "aspnet-csharp");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("aspnet");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api/Users",
        "/api/Users/events",
        "/api/Users/search",
        "/api/Users/{id}",
        "/health",
        "/products",
        "/products/{id}",
      ].sort(),
    );

    // ActionResult<List<User>> -> array of component refs.
    const list = doc.paths["/api/Users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    // Route constraint {id:guid} normalizes to {id}.
    const detail = doc.paths["/api/Users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });

    // ProducesResponseType(typeof(User), 201).
    const create = doc.paths["/api/Users"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateUserRequest",
    });
    const dto = doc.components.schemas.CreateUserRequest;
    expect(dto.properties.name).toEqual({ type: "string" });
    expect(dto.properties.age).toEqual({ type: "integer" });
    expect(dto.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(dto.required).toContain("name");
    expect(dto.required).not.toContain("age");

    // Query/header bindings with optionality.
    const search = doc.paths["/api/Users/search"].get;
    const q = search.parameters.find((p: any) => p.name === "q");
    expect(q.required).toBe(true);
    const page = search.parameters.find((p: any) => p.name === "page");
    expect(page.required).toBeFalsy();
    expect(page.schema).toEqual({ type: "integer" });
    const trace = search.parameters.find((p: any) => p.name === "x-trace");
    expect(trace.in).toBe("header");
    expect(trace.required).toBeFalsy();

    // Unannotated id under [ApiController] infers path binding; 204 no body.
    const remove = doc.paths["/api/Users/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();
    expect(remove.parameters.find((p: any) => p.name === "id").in).toBe("path");

    // Produces text/event-stream with Type = typeof(UserEvent).
    const events = doc.paths["/api/Users/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    expect(
      events.responses["200"].content["text/event-stream"].itemSchema,
    ).toEqual({ $ref: "#/components/schemas/UserEvent" });

    // Minimal APIs.
    const health = doc.paths["/health"].get;
    expect(health.operationId).toBe("GetHealth");
    expect(health.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/HealthStatus",
    });

    const createProduct = doc.paths["/products"].post;
    expect(createProduct.responses["201"]).toBeDefined();
    expect(createProduct.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateProduct",
    });
    const price = doc.components.schemas.CreateProduct.properties.price;
    expect(price).toEqual({ type: "number" });

    const deleteProduct = doc.paths["/products/{id}"].delete;
    expect(deleteProduct.responses["204"]).toBeDefined();

    // launchSettings.json applicationUrl.
    expect(doc.servers).toContainEqual({ url: "http://localhost:5000" });
  });
});
