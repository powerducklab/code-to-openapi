import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "axum-edge");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("axum edge cases", () => {
  it("binds Query structs, Json bodies, tuple statuses and plain text", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/api/orders");
    expect(list.parameters.map((p: any) => p.name).sort()).toEqual(["limit", "q"]);
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/serialized_Order" },
    });

    const health = op(ops, "get", "/healthz");
    expect(health.responses[0].content[0]).toEqual({
      mediaType: "text/plain",
      schema: { type: "string" },
    });

    const create = op(ops, "post", "/api/orders");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/OrderInput",
    });
    expect(create.responses[0].statusCode).toBe("201");
  });

  it("expands positional tuple Path extractors and nested router prefixes", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const cancel = op(ops, "post", "/api/tenants/{tenant}/orders/{id}/cancel");
    expect(cancel.parameters.map((p: any) => p.name)).toEqual(["tenant", "id"]);
    expect(cancel.responses[0].statusCode).toBe("204");
    expect(cancel.responses[0].content).toBeUndefined();

    const replay = op(ops, "post", "/admin/orders/{id}/replay");
    expect(replay.responses[0].statusCode).toBe("202");
  });

  it("detects SSE payloads from json_data calls and Redirect responses", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const events = op(ops, "get", "/api/orders/{id}/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.responses[0].content[0].itemSchema).toEqual({
      $ref: "#/components/schemas/serialized_OrderEvent",
    });

    const legacy = op(ops, "get", "/api/legacy/orders/{id}");
    expect(legacy.responses[0].statusCode).toBe("307");
    expect(legacy.responses[0].content).toBeUndefined();

    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8095" });
  });
});
