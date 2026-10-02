import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-method-handler");

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

describe("gin method-value handler resolution", () => {
  it("resolves r.GET(\"/items\", c.Get) to the receiver method body", async () => {
    const { result } = await scan();
    const get = op(result.project.operations, "get", "/items");
    expect(get.gaps).not.toContain("response-schema-unknown");
    expect(get.gaps).not.toContain("response-unknown");
    const media = get.responses.find((r: any) => r.statusCode === "200")
      ?.content?.find((c: any) => c.mediaType === "application/json");
    expect(media?.schema).toEqual({ $ref: "#/components/schemas/ItemResponse" });
  });

  it("resolves the POST method-value handler with its 201 status", async () => {
    const { result } = await scan();
    const post = op(result.project.operations, "post", "/items");
    expect(post.gaps).not.toContain("response-schema-unknown");
    const created = post.responses.find((r: any) => r.statusCode === "201");
    expect(created).toBeDefined();
  });
});
