import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-response-patterns");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

function json200(operation: any) {
  const response = operation.responses.find((r: any) => r.statusCode === "200");
  return response?.content?.find((m: any) => m.mediaType === "application/json");
}

describe("laravel response patterns", () => {
  it("resolves use-aliased invokable controllers", async () => {
    const { result } = await scan();
    const enroll = op(result.project.operations, "post", "/api/me/two-factor");
    expect(enroll.gaps).not.toContain("response-unknown");
    const media = json200(enroll);
    expect(media.schema.properties).toHaveProperty("provisioning_uri");
  });

  it("resolves self:: static factory methods to resource collections", async () => {
    const { result } = await scan();
    for (const method of ["get", "post"]) {
      const operation = op(result.project.operations, method, "/api/playlists/{playlist}/songs");
      expect(operation.gaps).not.toContain("response-unknown");
      expect(json200(operation).schema).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/SongResource" },
      });
    }
  });

  it("interprets terminal noContent calls behind decorator chains", async () => {
    const { result } = await scan();
    const destroy = op(result.project.operations, "delete", "/api/playlists/{playlist}/songs");
    expect(destroy.responses.map((r: any) => r.statusCode)).toContain("204");
  });

  it("interprets arrow function closures including null and view()", async () => {
    const { result } = await scan();
    const ping = op(result.project.operations, "get", "/api/ping");
    expect(ping.responses.map((r: any) => r.statusCode)).toContain("200");
    const page = op(result.project.operations, "get", "/api/page");
    expect(
      page.responses
        .flatMap((r: any) => r.content ?? [])
        .some((m: any) => m.mediaType === "text/html"),
    ).toBe(true);
  });

  it("handles ternary returns and static resource chains", async () => {
    const { result } = await scan();
    const toggle = op(result.project.operations, "get", "/api/favorites/toggle");
    expect(json200(toggle).schema).toEqual({ $ref: "#/components/schemas/SongResource" });
    const scoped = op(result.project.operations, "get", "/api/favorites/scoped");
    expect(json200(scoped).schema).toEqual({ $ref: "#/components/schemas/SongResource" });
  });

  it("keeps known array keys when a value is an untyped service call", async () => {
    const { result } = await scan();
    const bare = op(result.project.operations, "get", "/api/favorites/array");
    const schema = json200(bare).schema;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["count", "current"]);
  });

  it("interprets match expression arms and redirect chains", async () => {
    const { result } = await scan();
    const matched = op(result.project.operations, "get", "/api/favorites/matched");
    expect(matched.responses.map((r: any) => r.statusCode)).toContain("204");
    const redirected = op(result.project.operations, "get", "/api/favorites/redirected");
    expect(redirected.responses.map((r: any) => r.statusCode)).toContain("302");
  });

  it("respects explicit apiResource only action filters", async () => {
    const { result } = await scan();
    const paths = new Set(
      result.project.operations.map((o) => `${o.method} ${o.fullPath ?? o.path}`),
    );
    expect(paths.has("get /api/albums")).toBe(true);
    expect(paths.has("get /api/albums/{album}")).toBe(true);
    expect(paths.has("put /api/albums/{album}")).toBe(true);
    expect(paths.has("post /api/albums")).toBe(false);
    expect(paths.has("delete /api/albums/{album}")).toBe(false);
  });

  it("produces a valid OAS document", async () => {
    const { converted } = await scan();
    expect(converted.documentValid).toBe(true);
  });
});
