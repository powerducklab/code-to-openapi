import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

describe("Laravel PHP scan", () => {
  it("extracts routes, FormRequest bodies, Eloquent responses, groups and SSE", async () => {
    const result = await scanProject({
      root: "test/fixtures/laravel-php",
      includeTests: true,
    });

    expect(result.report.frameworks).toContain("laravel");

    const converted = await result.convert();
    expect(converted.documentValid).toBe(true);

    const operations = result.project.operations;
    const byKey = new Map(
      operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]),
    );

    // Explicit top-level routes.
    const list = byKey.get("GET /users")!;
    expect(list).toBeTruthy();
    expect(list.parameters.map((p) => p.name).sort()).toEqual(["page", "q"]);
    const listSchema = list.responses[0]?.content?.[0]?.schema;
    expect(listSchema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    const store = byKey.get("POST /users")!;
    expect(store.responses[0]?.statusCode).toBe("201");
    const bodySchema = store.requestBody?.content[0]?.schema;
    expect(bodySchema?.required).toEqual(["name"]);
    expect(bodySchema?.properties).toMatchObject({
      name: { type: "string" },
      age: { type: ["integer", "null"] },
      tags: { type: ["array", "null"], items: { type: "string" } },
    });

    // Group prefix accumulation.
    const show = byKey.get("GET /api/users/{id}")!;
    expect(show).toBeTruthy();
    expect(show.parameters).toContainEqual(
      expect.objectContaining({ name: "id", in: "path", required: true }),
    );
    expect(show.responses[0]?.content?.[0]?.schema).toEqual({
      $ref: "#/components/schemas/User",
    });

    const destroy = byKey.get("DELETE /api/users/{id}")!;
    expect(destroy.responses[0]?.statusCode).toBe("204");
    expect(destroy.responses[0]?.content).toBeUndefined();

    // Closure routes inside the group.
    const search = byKey.get("GET /api/search")!;
    expect(search.parameters.map((p) => p.name)).toContain("q");

    const events = byKey.get("GET /api/events")!;
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.responses[0]?.content?.[0]?.mediaType).toBe(
      "text/event-stream",
    );
    expect(events.gaps).toContain("sse-events-unknown");

    // apiResource expansion for a missing controller stays low confidence.
    const resourceIndex = byKey.get("GET /posts")!;
    expect(resourceIndex.confidence).toBe("low");
    expect(resourceIndex.gaps).toContain("response-unknown");
    expect(byKey.get("POST /posts")).toBeTruthy();
    expect(byKey.get("GET /posts/{post}")).toBeTruthy();
    expect(byKey.get("PUT /posts/{post}")).toBeTruthy();
    expect(byKey.get("PATCH /posts/{post}")).toBeTruthy();
    expect(byKey.get("DELETE /posts/{post}")).toBeTruthy();

    // Constructor-promoted model properties become a component.
    const user = result.project.components.find((c) => c.name === "User");
    expect(user?.schema.properties).toMatchObject({
      id: { type: "string" },
      name: { type: "string" },
      age: { type: ["integer", "null"] },
      tags: { type: "array", items: {} },
    });
    expect(user?.schema.required).toEqual(["id", "name"]);
  });
});
