import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "aspnet-edge");

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

describe("asp.net controllers edge cases", () => {
  it("resolves [controller] routes, records, explicit headers and multi-status responses", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/api/Products");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["query:q", "query:sort", "header:X-Trace"]),
    );
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/serialized_Product" },
    });

    const create = op(ops, "post", "/api/Products");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ProductInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);

    const detail = op(ops, "get", "/api/Products/{sku}");
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
  });

  it("captures multipart uploads, binary downloads and typed SSE events", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const upload = op(ops, "post", "/api/Products/{sku}/logo");
    expect(upload.requestBody.content[0].mediaType).toBe("multipart/form-data");
    expect(upload.requestBody.content[0].schema.properties.file).toEqual({
      type: "string",
      format: "binary",
    });
    expect(upload.responses[0].statusCode).toBe("202");

    const download = op(ops, "get", "/api/Products/{sku}/logo");
    expect(download.responses[0].content[0]).toEqual({
      mediaType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    });

    const events = op(ops, "get", "/api/Products/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.responses[0].content[0].itemSchema).toEqual({
      $ref: "#/components/schemas/serialized_Product",
    });
  });
});

describe("asp.net minimal api edge cases", () => {
  it("captures anonymous payloads, created bodies, redirects and binary file results", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const health = op(ops, "get", "/api/health");
    expect(health.responses[0].content[0].schema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
    });

    const create = op(ops, "post", "/api/orders");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/OrderInput",
    });
    expect(create.responses[0].statusCode).toBe("201");

    const redirect = op(ops, "get", "/api/legacy/{id}");
    expect(redirect.responses[0].statusCode).toBe("302");
    expect(redirect.responses[0].content).toBeUndefined();

    const report = op(ops, "get", "/api/reports/{name}");
    expect(report.responses[0].content[0]).toEqual({
      mediaType: "application/pdf",
      schema: { type: "string", format: "binary" },
    });
  });

  it("expands MapMethods into one route per verb and detects servers", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    expect(
      ops
        .filter((o: any) => (o.fullPath ?? o.path) === "/api/ping")
        .map((o: any) => o.method)
        .sort(),
    ).toEqual(["get", "head"]);
    expect(result.project.servers).toContainEqual({ url: "http://localhost:8094" });
  });
});
