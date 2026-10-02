import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-extended");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("gin extended handlers and inputs", () => {
  it("resolves handlers registered through a package selector expression", async () => {
    const { doc } = await scan();
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/v1/search",
      "/api/v1/tags",
      "/api/v1/upload",
    ]);
    const resp = doc.paths["/api/v1/tags"].get.responses["200"].content["application/json"].schema;
    expect(resp).toEqual({ type: "array", items: { $ref: "#/components/schemas/Tag" } });
    expect(doc.components.schemas.Tag.properties.name).toEqual({ type: "string" });
  });

  it("maps c.PostForm / c.DefaultPostForm to query parameters", async () => {
    const { doc } = await scan();
    const params = doc.paths["/api/v1/search"].get.parameters.map((p: any) => p.name).sort();
    expect(params).toEqual(["page", "q"]);
  });

  it("emits multipart/form-data bodies for c.FormFile uploads", async () => {
    const { doc } = await scan();
    const body = doc.paths["/api/v1/upload"].post.requestBody.content["multipart/form-data"];
    expect(body.schema.properties.file).toEqual({ type: "string", format: "binary" });
    expect(body.schema.required).toContain("file");
  });
});
