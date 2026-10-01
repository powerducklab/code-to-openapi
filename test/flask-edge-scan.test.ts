import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "flask-edge");

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

describe("flask edge cases", () => {
  it("resolves blueprints registered cross-file with overriding prefixes", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    // Registration url_prefix /v1 overrides the blueprint's own /api prefix.
    op(ops, "get", "/v1/orders/{order_id}");
    expect(
      ops.find((o) => (o.fullPath ?? o.path).startsWith("/v1/api")),
      "registration prefix must override blueprint prefix",
    ).toBeUndefined();
    // The imported but unregistered blueprint stays an honest unresolved item.
    expect(result.project.unresolved.some((u: any) => u.reason === "unreachable-blueprint")).toBe(
      true,
    );
  });

  it("attributes evidence to the right HTTP method inside request.method branches", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    const getList = op(ops, "get", "/v1/orders");
    const postList = op(ops, "post", "/v1/orders");

    expect(getList.requestBody).toBeUndefined();
    expect(postList.requestBody?.content[0].mediaType).toBe("application/json");

    // The POST-only 201/422 responses never leak onto GET; the shared 200 does.
    expect(getList.responses.map((r: any) => r.statusCode).sort()).toEqual(["200"]);
    expect(postList.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "201", "422"]);
  });

  it("captures converters, headers, cookies, uploads, redirects, SSE and binary responses", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const detail = op(ops, "get", "/v1/orders/{order_id}");
    expect(detail.parameters.find((p: any) => p.name === "order_id").schema).toEqual({
      type: "integer",
    });
    expect(detail.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["header:X-Tenant", "cookie:session"]),
    );
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "400", "404"]);

    const upload = op(ops, "post", "/v1/orders/{order_id}/upload");
    expect(upload.requestBody?.content[0].mediaType).toBe("multipart/form-data");
    expect(upload.responses.map((r: any) => r.statusCode)).toContain("202");

    const redirectRoute = op(ops, "get", "/v1/legacy/orders/{order_id}");
    expect(redirectRoute.responses[0].statusCode).toBe("301");
    expect(redirectRoute.responses[0].content).toBeUndefined();

    const stream = op(ops, "get", "/v1/events/{stream_id}");
    expect(stream.extensions?.["x-protocol"]).toBe("sse");
    expect(stream.parameters.find((p: any) => p.name === "stream_id").schema.format).toBe("uuid");

    const file = op(ops, "get", "/v1/files/{subpath}");
    const media = file.responses[0].content[0];
    expect(media.mediaType).toBe("application/octet-stream");
    expect(media.schema).toEqual({ type: "string", format: "binary" });
  });
});
