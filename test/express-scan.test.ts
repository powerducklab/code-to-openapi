import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("express + TypeScript golden project", () => {
  it("extracts routes, parameters, bodies, responses, SSE and components", async () => {
    const root = join(FIXTURES, "express-ts");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();

    // Confirmed routes, mounted with prefixes; decoy Map.get never appears.
    expect(paths).toEqual(
      [
        "/api/users",
        "/api/users/{id}",
        "/api/users/{id}/orders",
        "/events",
        "/health",
      ].sort(),
    );
    expect(doc.paths["/secret"]).toBeUndefined();
    expect(doc.paths["/items"]).toBeUndefined();

    // GET list -> typed array of named component.
    const list = doc.paths["/api/users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    // Path parameter typed from the Request generic.
    const detail = doc.paths["/api/users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });

    // Two status branches: 200 and 404.
    expect(detail.responses["200"]).toBeDefined();
    expect(detail.responses["404"].content["application/json"].schema.properties.message)
      .toEqual({ type: "string" });

    // Auth middleware on this route -> bearerAuth security.
    expect(detail.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });

    // POST body from the zod schema, including the optional field.
    const create = doc.paths["/api/users"].post;
    const bodySchema = create.requestBody.content["application/json"].schema;
    expect(bodySchema.properties.name).toEqual({ type: "string", minLength: 1 });
    expect(bodySchema.properties.email).toEqual({ type: "string", format: "email" });
    expect(bodySchema.properties.age).toEqual({ type: "integer" });
    expect(bodySchema.required).toEqual(["name", "email"]);
    expect(create.responses["201"]).toBeDefined();

    // Query parameters from the fourth generic slot.
    const orders = doc.paths["/api/users/{id}/orders"].get;
    const status = orders.parameters.find((p: any) => p.name === "status");
    const limit = orders.parameters.find((p: any) => p.name === "limit");
    expect(status.schema).toEqual({ type: "string" });
    expect(limit.schema).toEqual({ type: "number" });
    // OAS treats an omitted `required` as false for query parameters.
    expect(status.required ?? false).toBe(false);

    // SSE endpoint keeps the canonical itemSchema extension shape.
    const events = doc.paths["/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    const sseMedia = events.responses["200"].content["text/event-stream"];
    expect(sseMedia.schema).toBeUndefined();
    const eventNames = sseMedia.itemSchema.oneOf.map((v: any) => v.properties.event.const);
    expect(eventNames.sort()).toEqual(["done", "tick"]);

    // res.send(string) -> text/html.
    expect(doc.paths["/health"].get.responses["200"].content["text/html"]).toBeDefined();

    // Named DTOs hoisted to components.
    expect(doc.components.schemas.User).toBeDefined();
    expect(doc.components.schemas.UserDetail).toBeDefined();
    expect(doc.components.schemas.Order).toBeDefined();

    // Server derived from app.listen.
    expect(doc.servers).toContainEqual({ url: "http://localhost:3000" });

    // Unmounted router reported, not emitted.
    expect(
      result.project.unresolved.some((u) => u.reason === "unreachable-router"),
    ).toBe(true);

    // Metadata from package.json.
    expect(doc.info.title).toBe("fixture-api");
    expect(doc.info.version).toBe("2.3.4");
  });

  it("never mistakes non-router method calls for routes (zero false positives)", async () => {
    const result = await scanProject({
      root: join(FIXTURES, "express-ts"),
      includeTests: true,
    });
    const keys = result.project.operations.map((o) => `${o.method} ${o.path}`);
    expect(keys.some((k) => k.includes("secret"))).toBe(false);
    // All confirmed routes are high confidence.
    const high = result.report.routesConfirmed;
    expect(high).toBeGreaterThanOrEqual(4);
  });
});

describe("plain JavaScript project (weak typing)", () => {
  it("extracts routes with syntactic confidence and records gaps", async () => {
    const result = await scanProject({
      root: join(FIXTURES, "express-js"),
      includeTests: true,
    });
    const converted = await result.convert();
    expect(converted.ok).toBe(true);

    const doc = converted.document as any;
    expect(doc.paths["/v1/items/{itemId}"]).toBeDefined();
    expect(doc.paths["/v1/items"].post).toBeDefined();

    const get = doc.paths["/v1/items/{itemId}"].get;
    const itemId = get.parameters.find((p: any) => p.name === "itemId");
    expect(itemId.in).toBe("path");

    // Destructured body fields are still collected.
    const post = doc.paths["/v1/items"].post;
    const bodyProps = Object.keys(
      post.requestBody.content["application/json"].schema.properties,
    );
    expect(bodyProps).toEqual(["name", "price"]);

    // An untyped query param without a conversion defaults to the query-string
    // atomic type (string); it is a proven contract, not an unknown gap.
    const qParam = get.parameters.find((p: any) => p.name === "q");
    expect(qParam?.in).toBe("query");
    expect(qParam?.schema?.type).toBe("string");
    const routeReport = result.report.gaps.find((g) =>
      g.route.endsWith("/v1/items/{itemId}"),
    );
    expect(routeReport?.gaps ?? []).not.toContain("query-unknown");
  });
});
