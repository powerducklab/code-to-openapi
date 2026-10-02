import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "hono-edge");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find(
    (o) => o.method === method && (o.fullPath ?? o.path) === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("hono pack", () => {
  it("scans Hono routes, groups, params, bodies, responses and SSE", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const health = op(ops, "get", "/health");
    expect(health.responses[0].content[0].mediaType).toBe("text/plain");

    const list = op(ops, "get", "/api/users");
    const q = list.parameters.find((p: any) => p.in === "query" && p.name === "q");
    expect(q).toBeDefined();
    const ok = list.responses.find((r) => r.statusCode === "200");
    expect(ok.content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });
    const bad = list.responses.find((r) => r.statusCode === "400");
    expect(bad.content[0].schema).toEqual({ $ref: "#/components/schemas/ErrorBody" });

    const byId = op(ops, "get", "/api/users/{id}");
    expect(byId.parameters.map((p: any) => p.name)).toContain("id");
    const hdr = byId.parameters.find(
      (p: any) => p.in === "header" && p.name === "x-token",
    );
    expect(hdr).toBeDefined();
    const unauthorized = byId.responses.find((r) => r.statusCode === "401");
    expect(unauthorized.content[0].schema).toEqual({
      $ref: "#/components/schemas/ErrorBody",
    });

    const create = op(ops, "post", "/api/users");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/UserInput",
    });
    const created = create.responses.find((r) => r.statusCode === "201");
    expect(created.content[0].schema).toEqual({ $ref: "#/components/schemas/User" });

    const events = op(ops, "get", "/api/users/{id}/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.responses[0].content[0].mediaType).toBe("text/event-stream");
    expect(events.responses[0].content[0].itemSchema).toEqual({
      $ref: "#/components/schemas/OrderEvent",
    });
  });
});
