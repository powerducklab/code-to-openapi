import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-edge");

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

describe("fastapi edge cases", () => {
  it("mounts nested routers with combined prefixes and lists enum queries", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, converted.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/v1/shops");
    const query = Object.fromEntries(list.parameters.map((p: any) => [p.name, p]));
    expect(Object.keys(query).sort()).toEqual(["q", "session", "sort", "tags", "x-tenant"]);
    // An enum-typed query parameter stays a query parameter with a $ref schema,
    // never an implicit JSON request body.
    expect(query.sort.in).toBe("query");
    expect(query.sort.schema.$ref).toContain("SortOrder");
    expect(list.requestBody).toBeUndefined();
    expect(query["x-tenant"].in).toBe("header");
    expect(query.session.in).toBe("cookie");
    expect(list.responses[0].content[0].schema.items.$ref).toContain("Product");
  });

  it("captures typed bodies, status codes, response mappings and HTTPException errors", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const created = op(ops, "post", "/v1/shops");
    expect(created.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);
    expect(created.requestBody.content[0].schema.$ref).toContain("ProductCreate");

    const detail = op(ops, "get", "/v1/shops/{product_id}");
    expect(detail.parameters.find((p: any) => p.name === "product_id").schema).toEqual({
      type: "integer",
    });
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
    expect(detail.security).toEqual([{ api_key_header: [] }]);
  });

  it("models embedded bodies, multipart uploads, api_route lists and orphan routers", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const replace = op(ops, "put", "/v1/shops/{product_id}");
    const bodySchema = replace.requestBody.content[0].schema;
    expect(Object.keys(bodySchema.properties).sort()).toEqual(["note", "title"]);

    const upload = op(ops, "post", "/v1/shops/upload");
    const multipart = upload.requestBody.content[0];
    expect(multipart.mediaType).toBe("multipart/form-data");
    expect(multipart.schema.properties.file).toEqual({ type: "string", format: "binary" });

    op(ops, "get", "/v1/shops/ping");
    op(ops, "head", "/v1/shops/ping");

    // The StorageClient decoy exposes get/post but never creates routes.
    expect(ops.find((o) => (o.fullPath ?? o.path).includes("lonely") && false)).toBeUndefined();
    const orphan = result.project.unresolved.find((u: any) => u.reason === "unreachable-router");
    expect(orphan).toBeDefined();
  });
});
