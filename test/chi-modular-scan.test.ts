import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "chi-modular");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("chi modular route registration", () => {
  it("composes group paths without trailing slashes", async () => {
    const { doc } = await scan();
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/articles",
      "/articles/{slug}",
      "/healthz",
    ]);
  });

  it("registers routes behind r.With(...) middleware chains", async () => {
    const { doc } = await scan();
    expect(doc.paths["/articles"].get).toBeDefined();
  });

  it("strips regex constraints from path parameters", async () => {
    const { doc } = await scan();
    const op = doc.paths["/articles/{slug}"].get;
    expect(op).toBeDefined();
    const param = op.parameters.find((p: any) => p.name === "slug");
    expect(param).toMatchObject({ in: "path", required: true });
  });

  it("follows setup functions called with the router", async () => {
    const { doc } = await scan();
    expect(doc.paths["/healthz"].get).toBeDefined();
  });
});
