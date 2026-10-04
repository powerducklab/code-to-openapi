import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "chi-edge");

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

describe("chi edge cases", () => {
  it("resolves Route blocks, prefix-less Group blocks and Mount factories", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o: any) => `${o.method} ${o.fullPath ?? o.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "get /v1/products",
        "post /v1/products",
        "get /v1/products/{id}",
        "get /v1/products/events",
        "delete /v1/admin/products/{id}",
      ]),
    );
  });

  it("captures aliased query values, headers, cookies, decoded bodies and statuses", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/v1/products");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["query:tag", "header:X-Trace", "cookie:session"]),
    );
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    });

    const create = op(ops, "post", "/v1/products");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/input_ProductInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);

    const detail = op(ops, "get", "/v1/products/{id}");
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
  });

  it("detects SSE streams, bodyless 204 and server addresses", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const stream = op(ops, "get", "/v1/products/events");
    expect(stream.extensions?.["x-protocol"]).toBe("sse");
    expect(stream.gaps).toContain("sse-events-unknown");

    const remove = op(ops, "delete", "/v1/admin/products/{id}");
    expect(remove.responses[0].statusCode).toBe("204");
    expect(remove.responses[0].content).toBeUndefined();

    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8092" });
  });

  it("infers text/plain responses from w.Write([]byte(...))", async () => {
    const { result } = await scan();
    const health = op(result.project.operations, "get", "/v1/health");
    const response = health.responses.find((r: any) => r.statusCode === "200");
    expect(response).toBeDefined();
    expect(response.content[0].mediaType).toBe("text/plain");
    expect(response.content[0].schema).toEqual({ type: "string" });
  });
});
