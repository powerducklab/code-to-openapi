import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "chi-render");

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

function jsonBody(op: any, status: string) {
  const response = op.responses.find((r: any) => r.statusCode === status);
  expect(response, `expected ${op.method} ${op.path} to have ${status}`).toBeDefined();
  const media = response.content?.find((c: any) => c.mediaType === "application/json");
  expect(media, `expected ${op.method} ${op.path} ${status} to have application/json`).toBeDefined();
  return media.schema;
}

describe("chi go-chi/render idiom", () => {
  it("resolves render.RenderList to an array of the concrete constructor element schema", async () => {
    const { result } = await scan();
    const list = op(result.project.operations, "get", "/articles");
    expect(list.gaps).not.toContain("response-unknown");
    expect(jsonBody(list, "200")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ArticleResponse" },
    });
  });

  it("resolves the error branch render.Render call with its proven status code", async () => {
    const { result } = await scan();
    const list = op(result.project.operations, "get", "/articles");
    const err = list.responses.find((r: any) => r.statusCode === "422");
    expect(err).toBeDefined();
    expect(err.content?.[0].schema).toEqual({ $ref: "#/components/schemas/ErrResponse" });
  });

  it("honors render.Status(r, code) applied to the following render.Render", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/articles");
    expect(create.gaps).not.toContain("response-unknown");
    expect(jsonBody(create, "201")).toEqual({ $ref: "#/components/schemas/ArticleResponse" });
    // Bind failure branch emits the 400 error renderer.
    expect(create.responses.find((r: any) => r.statusCode === "400")).toBeDefined();
  });

  it("resolves a plain render.Render of a constructor return as the struct schema", async () => {
    const { result } = await scan();
    const get = op(result.project.operations, "get", "/articles/{articleID}");
    expect(get.gaps).not.toContain("response-unknown");
    expect(jsonBody(get, "200")).toEqual({ $ref: "#/components/schemas/ArticleResponse" });
  });

  it("resolves a package-level render.Renderer variable (ErrNotFound) to its struct and 404", async () => {
    const { result } = await scan();
    const del = op(result.project.operations, "delete", "/articles/{articleID}");
    expect(del.gaps).not.toContain("response-unknown");
    const notFound = del.responses.find((r: any) => r.statusCode === "404");
    expect(notFound).toBeDefined();
    expect(notFound.content?.[0].schema).toEqual({ $ref: "#/components/schemas/ErrResponse" });
    expect(jsonBody(del, "200")).toEqual({ $ref: "#/components/schemas/ArticleResponse" });
  });
});
