import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "express-edge-ts");

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

describe("express edge cases (TypeScript)", () => {
  it("covers route chaining, optional params, wildcards and array paths", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, converted.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // app.route(path).get(fn).patch(arrow) — verb calls carry no path arg.
    const getOne = op(ops, "get", "/api/articles/{id}");
    expect(getOne.confidence).toBe("medium");
    expect(getOne.gaps).toContain("response-schema-unknown");
    expect(getOne.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
    const patchOne = op(ops, "patch", "/api/articles/{id}");
    expect(patchOne.requestBody).toBeDefined();

    // Optional parameter normalizes to a template param.
    op(ops, "get", "/api/users/{userId}");
    // Wildcard becomes a named catch-all parameter.
    op(ops, "get", "/api/files/{wildcard}");

    // Array of paths emits both routes.
    op(ops, "get", "/ping");
    op(ops, "get", "/healthz");
  });

  it("captures typed generics, cross-cutting params and explicit content types", async () => {
    const { result, converted } = await scan();
    const ops = result.project.operations;
    const doc: any = converted.document;

    const list = op(ops, "get", "/api/articles");
    const queryNames = list.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name);
    expect(queryNames).toEqual(expect.arrayContaining(["q", "page"]));

    const exportRoute = op(ops, "get", "/api/export");
    expect(exportRoute.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["header:x-trace", "cookie:session"]),
    );
    const exportMedia = Object.keys(
      doc.paths["/api/export"].get.responses["200"].content,
    );
    expect(exportMedia).toEqual(["text/csv"]);

    // Redirects are bodyless 302 responses.
    const redirect = op(ops, "get", "/api/old-articles");
    expect(redirect.responses[0].statusCode).toBe("302");
    expect(redirect.responses[0].content?.[0]?.mediaType).toBe("text/html");

    // sendStatus(204) stays bodyless after normalization.
    const files = doc.paths["/api/files/{wildcard}"].get;
    expect(files.responses["204"].content).toBeUndefined();
  });

  it("models SSE with itemSchema and never treats service objects as routers", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    const events = op(ops, "get", "/api/events");
    expect(events.extensions?.["x-protocol"]).toBe("sse");
    const stream = events.responses.find((r: any) => r.statusCode === "200");
    expect(stream.content[0].mediaType).toBe("text/event-stream");
    expect(stream.content[0].itemSchema.oneOf).toBeDefined();

    // The CacheClient decoy exposes get/post but must not create routes such
    // as GET warmup.
    expect(ops.find((o) => (o.fullPath ?? o.path).includes("warmup"))).toBeUndefined();
    expect(result.project.unresolved).toEqual([]);
  });
});
