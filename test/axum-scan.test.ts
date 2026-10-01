import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("axum golden project", () => {
  it("extracts router chains, nested routers, extractors and status tuples", async () => {
    const root = join(FIXTURES, "axum-rs");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("axum");

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      [
        "/users",
        "/users/search",
        "/users/{id}",
        "/events",
        "/api/health",
        "/api/users/{user_id}/archive",
      ].sort(),
    );

    // Json<Vec<User>> -> array of component refs.
    const list = doc.paths["/users"].get;
    expect(list.responses["200"].content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });

    // (StatusCode::CREATED, Json<User>) with Json<CreateUser> body.
    const create = doc.paths["/users"].post;
    expect(create.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });
    expect(create.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/CreateUser",
    });
    const dto = doc.components.schemas.CreateUser;
    expect(dto.properties.name).toEqual({ type: "string" });
    expect(dto.properties.age).toEqual({ type: "integer" });
    expect(dto.required).toContain("name");
    expect(dto.required).not.toContain("age");

    // Query<SearchParams> with required/optional fields.
    const search = doc.paths["/users/search"].get;
    const q = search.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    expect(q.required).toBe(true);
    const page = search.parameters.find((p: any) => p.name === "page");
    expect(page.required).toBeFalsy();
    expect(page.schema).toEqual({ type: "integer", format: "int64" });

    // Path<String> scalar extractor.
    const detail = doc.paths["/users/{id}"].get;
    const idParam = detail.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });

    // StatusCode::NO_CONTENT.
    const remove = doc.paths["/users/{id}"].delete;
    expect(remove.responses["204"]).toBeDefined();
    expect(remove.responses["204"].content).toBeUndefined();

    // Struct Path extractor expands fields.
    const archive = doc.paths["/api/users/{user_id}/archive"].post;
    const userIdParam = archive.parameters.find((p: any) => p.name === "user_id");
    expect(userIdParam.in).toBe("path");
    expect(userIdParam.required).toBe(true);
    expect(archive.responses["204"]).toBeDefined();

    // &'static str -> text/plain.
    const health = doc.paths["/api/health"].get;
    expect(health.responses["200"].content["text/plain"].schema).toEqual({
      type: "string",
    });

    // Sse<impl Stream<Item = Result<Event, _>>> with an external Event type
    // surfaces the canonical SSE shape and an AI gap for the event schema.
    const events = doc.paths["/events"].get;
    expect(events["x-protocol"]).toBe("sse");
    expect(events.responses["200"].content["text/event-stream"]).toBeDefined();
    const gap = converted.diagnostics.find((d) => d.code === "DISCOVERY_GAP");
    expect(gap?.path).toBe("/events");

    // String-parsed SocketAddr server.
    expect(doc.servers).toContainEqual({ url: "http://127.0.0.1:8080" });
  });
});
