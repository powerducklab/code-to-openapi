import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-edge");

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

describe("spring edge cases", () => {
  it("combines class-level and method-level request mappings with typed params", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/api/shops");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining([
        "query:q",
        "query:limit",
        "query:sort",
        "header:X-Trace",
        "cookie:session",
      ]),
    );
    expect(list.parameters.find((p: any) => p.name === "sort").schema).toEqual({
      $ref: "#/components/schemas/ShopSort",
    });
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Shop" },
    });

    const detail = op(ops, "get", "/api/shops/{id}");
    expect(detail.parameters[0].schema).toEqual({ type: "integer", format: "int64" });
  });

  it("captures record bodies, explicit statuses, void 204 and multipart uploads", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const create = op(ops, "post", "/api/shops");
    expect(create.requestBody.content[0].schema).toEqual({ $ref: "#/components/schemas/ShopInput" });
    expect(create.responses.map((r: any) => r.statusCode)).toEqual(["201"]);

    const remove = op(ops, "delete", "/api/shops/{id}");
    expect(remove.responses[0].statusCode).toBe("204");
    expect(remove.responses[0].content).toBeUndefined();

    const upload = op(ops, "post", "/api/shops/{id}/logo");
    const media = upload.requestBody.content[0];
    expect(media.mediaType).toBe("multipart/form-data");
    expect(media.schema.properties.file).toEqual({ type: "string", format: "binary" });
    expect(upload.responses[0].statusCode).toBe("202");
  });

  it("detects SSE with typed events and binary resource downloads", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const events = op(ops, "get", "/api/shops/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    expect(events.responses[0].content[0].itemSchema).toEqual({
      $ref: "#/components/schemas/Shop",
    });

    const logo = op(ops, "get", "/api/shops/{id}/logo");
    expect(logo.responses[0].content[0]).toEqual({
      mediaType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    });

    expect(result.project.servers).toContainEqual({ url: "http://localhost:8093" });
  });
});
