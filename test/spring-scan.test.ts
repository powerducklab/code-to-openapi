import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("spring boot + Java golden project", () => {
  it("extracts controller routes, DTO records, params, statuses and SSE", async () => {
    const root = join(FIXTURES, "spring-java");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("spring");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/api/users",
        "/api/users/events",
        "/api/users/search",
        "/api/users/{id}",
      ].sort(),
    );

    // Generic List<User> -> array of component refs.
    const list = doc.paths["/api/users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    // @PathVariable with explicit name.
    const detail = doc.paths["/api/users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });
    expect(detail.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });

    // @ResponseStatus(CREATED) on POST with record DTO body.
    const create = doc.paths["/api/users"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateUserRequest",
    });
    const dto = doc.components.schemas.CreateUserRequest;
    expect(dto.properties.name).toEqual({ type: "string" });
    expect(dto.properties.age).toEqual({ type: "integer", format: "int32" });
    expect(dto.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(dto.required).toContain("name");
    expect(dto.required).not.toContain("age");

    // Query and header parameters with required/default semantics.
    const search = doc.paths["/api/users/search"].get;
    const q = search.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    expect(q.required).toBe(true);
    const page = search.parameters.find((p: any) => p.name === "page");
    expect(page.required).toBeFalsy();
    expect(page.schema).toEqual({ type: "integer", format: "int32" });
    const trace = search.parameters.find((p: any) => p.name === "x-trace");
    expect(trace.in).toBe("header");
    expect(trace.required).toBeFalsy();

    // void + NO_CONTENT -> no response body.
    const remove = doc.paths["/api/users/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();

    // Flux<T> + produces text/event-stream -> canonical SSE.
    const events = doc.paths["/api/users/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    expect(
      events.responses["200"].content["text/event-stream"].itemSchema,
    ).toEqual({ $ref: "#/components/schemas/UserEvent" });

    // application.properties server.port.
    expect(doc.servers).toContainEqual({ url: "http://localhost:8080" });
  });
});
