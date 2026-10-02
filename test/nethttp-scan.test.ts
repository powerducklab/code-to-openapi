import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "nethttp-edge");

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

describe("net/http (stdlib ServeMux) pack", () => {
  it("detects Go 1.22 method-pattern routes and mounted sub-mux routes", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o: any) => `${o.method} ${o.fullPath ?? o.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "get /items",
        "post /items",
        "get /items/{id}",
        "get /items/{id}/download",
        "get /admin/ping",
      ]),
    );
  });

  it("expands a legacy unmethoded HandleFunc to all verbs", async () => {
    const { result } = await scan();
    const health = result.project.operations.filter(
      (o: any) => (o.fullPath ?? o.path) === "/health",
    );
    const methods = new Set(health.map((o: any) => o.method));
    expect(methods).toEqual(
      new Set(["get", "post", "put", "patch", "delete", "head", "options"]),
    );
  });

  it("captures path/query/header/cookie params, decoded body and multi-status JSON", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/items");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["query:tag", "header:X-Trace", "cookie:session"]),
    );
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Item" },
    });

    const create = op(ops, "post", "/items");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ItemInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);

    const detail = op(ops, "get", "/items/{id}");
    expect(detail.parameters.find((p: any) => p.name === "id" && p.in === "path")).toBeDefined();
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
  });

  it("emits an octet-stream binary response for http.ServeFile", async () => {
    const { result } = await scan();
    const down = op(result.project.operations, "get", "/items/{id}/download");
    const r200 = down.responses.find((r: any) => r.statusCode === "200");
    expect(r200.content[0].mediaType).toBe("application/octet-stream");
    expect(r200.content[0].schema).toEqual({ type: "string", format: "binary" });
  });

  it("records the listen address as a server", async () => {
    const { result } = await scan();
    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8093" });
  });
});
