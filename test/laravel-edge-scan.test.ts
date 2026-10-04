import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-edge");

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

describe("laravel edge cases", () => {
  it("keeps route group prefixes for closures and apiResource", async () => {
    const { result } = await scan();
    const paths = new Set(result.project.operations.map((o) => o.fullPath ?? o.path));
    expect(paths.has("/api/v1/orders")).toBe(true);
    expect(paths.has("/api/v1/invoices")).toBe(true);
    expect(paths.has("/api/v1/invoices/{invoice}")).toBe(true);
    expect(paths.has("/invoices")).toBe(false);
  });

  it("extracts query, boolean, header and cookie inputs from closures", async () => {
    const { result } = await scan();
    const list = op(result.project.operations, "get", "/api/v1/orders");
    const byName = Object.fromEntries(list.parameters.map((p: any) => [p.name, p.in]));
    expect(byName).toMatchObject({
      q: "query",
      active: "query",
      "X-Trace": "header",
      session: "cookie",
    });
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Order" },
    });
  });

  it("maps closure input() calls to JSON bodies on writes", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/api/v1/orders");
    const media = create.requestBody.content[0];
    expect(media.mediaType).toBe("application/json");
    expect(Object.keys(media.schema.properties).sort()).toEqual(["amount", "note"]);
    expect(create.responses[0].statusCode).toBe("201");
    expect(create.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/Order",
    });
  });

  it("parses array-form FormRequest rules and local model variables", async () => {
    const { result } = await scan();
    const update = op(result.project.operations, "put", "/api/v1/orders/{id}");
    const schema = update.requestBody.content[0].schema;
    expect(schema.properties.amount).toEqual({ type: "number", minimum: 0 });
    expect(schema.properties.note).toEqual({type:["string", "null"], maxLength:200});
    expect(schema.properties.tags.type).toBe("array");
    expect(update.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/Order",
    });
  });

  it("parses inline validate() rules and response()->json with rebound variables", async () => {
    const { result } = await scan();
    const store = op(result.project.operations, "post", "/api/v1/invoices");
    expect(store.requestBody.content[0].schema.properties).toHaveProperty("order_id");
    expect(store.responses[0].statusCode).toBe("201");

    const update = op(result.project.operations, "put", "/api/v1/invoices/{invoice}");
    expect(update.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/Invoice",
    });
  });

  it("detects no-content, binary download and redirect responses", async () => {
    const { result } = await scan();
    const destroy = op(result.project.operations, "delete", "/api/v1/orders/{id}");
    expect(destroy.responses[0].statusCode).toBe("204");
    expect(destroy.responses[0].content).toBeUndefined();

    const receipt = op(result.project.operations, "get", "/api/v1/orders/{id}/receipt");
    expect(receipt.responses[0].content[0]).toEqual({
      mediaType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    });

    const legacy = op(result.project.operations, "get", "/api/v1/legacy/orders/{id}");
    expect(legacy.responses[0].statusCode).toBe("301");
    expect(legacy.responses[0].content).toBeUndefined();
  });

  it("marks echo-based SSE as an honest gap and ignores service-class decoys", async () => {
    const { result, converted } = await scan();
    const events = op(result.project.operations, "get", "/api/v1/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.gaps).toContain("sse-events-unknown");
    expect(converted.documentValid).toBe(true);

    const paths = result.project.operations.map((o) => o.fullPath ?? o.path);
    expect(paths.some((p) => p.includes("orderservice"))).toBe(false);
    expect(result.project.servers).toContainEqual({ url: "http://localhost:8096" });
  });
});
