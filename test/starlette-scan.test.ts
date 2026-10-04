import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "starlette-py");

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

describe("Starlette pack", () => {
  it("extracts function and HTTPEndpoint routes, Mount prefixes, and path params", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    op(ops, "get", "/articles");

    const one = op(ops, "get", "/articles/{article_id}");
    expect(one.parameters.map((p: any) => p.name)).toEqual(["article_id"]);

    const create = op(ops, "post", "/articles");
    expect(create.responses[0].statusCode).toBe("201");

    // Mount("/users", app=users_app) folds the prefix onto nested routes.
    op(ops, "get", "/users/");
    expect(op(ops, "post", "/users/").responses.map((r: any) => r.statusCode)).toEqual(['201']);

    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8011" });
  });

  it("emits a non-200 response for handlers returning error statuses", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    const missing = op(ops, "get", "/missing");
    expect(missing.responses.map((r: any) => r.statusCode)).toContain("404");
  });

  it("registers WebSocketRoute with the websocket protocol extension", async () => {
    const { result } = await scan();
    const ops = result.project.operations;
    const ws = ops.find((o) => (o.fullPath ?? o.path) === "/ws/chat");
    expect(ws, "websocket route").toBeDefined();
    expect(ws.extensions?.["x-websocket"]).toBe(true);
  });
});
